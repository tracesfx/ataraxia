# Note suggestions (Phase 18) and song analysis (Phase 17)

The Studio editor's **Suggest** section drafts a chart from the song: rhythm first (the most
salient part of the music, the lead melody before anything else), as **one continuous chart**
rather than a chain of patterns, with repeated phrases (choruses) sharing one rhythm, notes on
screen wherever there is sound, and intense parts made harder instead of calm parts made easier.
Generation is seeded: the same analysis, chart timing, existing notes, settings, range and seed
always give the same chart.

Be honest about what it is:

- **A draft that needs manual cleanup.** It follows what the analysis hears, not musical intent
  or how a chart should "read". Expect to move, delete and re-lane notes.
- **Single BPM only.** The chart format has one tempo; the generator quantises to it. Songs with
  tempo changes, rubato or drifting live recordings come out off-grid in places.
- **Quality depends on the analysis.** Missed lead notes, merged onsets, a wrong phrase length
  or wrong section labels (see "Song analysis" below) go straight into the chart. Check the
  analysis viewer (V) when a passage looks wrong.

Code (Studio only): `src/studio/charting/` — `presets.ts` (every setting, the difficulty
defaults, the panel's control definitions), `plan.ts` (A), `rhythm.ts` (B, C, F), `holds.ts`
(D), `lanes.ts` (E), `generate.ts` (pipeline and G), `stats.ts`, `hits.ts` (shared types and the
decision log), `metrics.ts`, `calibration.ts`. Panel: `src/studio/editor/suggestPanel.ts`. The
generator reads the Phase 17 ChartAnalysis (`src/studio/charting/analysis`), computed once per
song in a worker and cached, so regenerating is fast (about 0.3-0.4 s for a 3.5-minute song).
There is no pattern library: chords, jacks, trills, stairs and anchors are never templates; they
emerge from the lane optimiser and the melody.

## Using it

1. Set the BPM and offset first (Timing > More > **Detect BPM**, or by ear). A wrong grid gives
   a wrong chart.
2. Open **Suggest**, pick a difficulty (it sets every setting below), adjust anything, press
   **Generate**. The first time, the song analysis runs (progress bar).
3. The result appears as outlined **ghost notes**. Hover one to see its decision entry (source
   layer, reason, score, repeat group and occurrence, phrase grid, chord size, hold source). The
   minimap shows notes per second before (grey) and after (green) as two lines.
4. **Accept** (Enter, also in the bar over the lanes) adds the shown generation as one undo
   step and selects it; **Discard** (Esc) drops it; **G** tries a new seed. Editing the chart or
   its timing discards shown suggestions.
5. **Recent generations** keeps the last five (numbered chips, hover for seed and summary):
   click one to show it again and compare before accepting. Accept applies the one shown.
6. **Live preview** regenerates about 250 ms after any change to a setting.
7. With the analysis viewer on (V), candidates the generator left out show as short red marks
   at the lanes' right edge; the inspector lists them with the reason (below threshold, off
   grid, repeat consensus, thinning, over cap, min gap, existing note, no free lane).
8. **Show the density plan** draws the planned notes per second (after a generation) in the
   timeline's left margin and on the minimap, with build-ups shaded.

**Fill mode**: _Empty space_ (default) keeps existing notes: new notes keep the minimum gap to
them and never enter their lanes while they sound. _Replace_ removes the existing notes whose
heads are in the range (same undo step).

**Presets**: the difficulty presets fill every setting; **My presets** saves the current
settings under a name (in this browser, `ataraxia.suggest-presets`), loads, deletes, and
exports / imports them as JSON (`format: "ataraxia-suggest-presets"`; unknown or out-of-range
values fall back to the difficulty's defaults). The current settings, seed, range, fill mode
and toggles are remembered in `ataraxia.suggest-settings`. Every setting group has a reset
button (to the current difficulty's defaults).

## Pipeline

All steps are pure functions; everything random comes from the seed (per-position hashes of
the seed, `hits.ts`), never `Math.random` (ESLint and a test enforce it).

### A. Density plan (`plan.ts`)

Per beat: the analysis's **musical activity** (lead density, drum density, syncopation, harmony
changes, pitch leaps, low punch; loudness near zero by default) averaged over the beat, smoothed
over +/-1 beat and placed relative to the song (10th to 95th percentile of beats with sound = 0
to 1). Then `x^gamma`, pushed away from its median by `2^((contrast - 0.5) * 3)` (contrast 50 %
= unchanged). Target = `(base + (peak - base) * shaped * roleMultiplier) * multiplier`, never
under `base * multiplier`, never over the ceiling. Build-ups ramp up toward the drop
(`max(shaped, 0.2 + 0.8 * progress^1.5)`). Inside lead runs the target rises toward the run's
own rate (up to burst) by "Lead runs". Beats whose mean RMS is under -52 dBFS are silent: target
0 unless **Fill silence**. Loudness is never used directly.

### B. Rhythm selection (`rhythm.ts`)

Phrases come from the analysis's bars and repeat groups (phrase length from the analysis). Each
repeat group (or a lone phrase) is a **template**: the onsets of all its occurrences are pooled
on phrase-relative ticks (48 per beat).

- **Primary layer** per template: for each layer, its onsets above the layer threshold (lead:
  from 0.5 down to 0.05 with "Lead sensitivity"; others 0.25) score
  `weight * priority * density * (0.4 + 0.6 * regularity) * (0.5 + 0.5 * strength)`, with
  priority lead 1.35 > snare 1.15 > kick 1.05 > other/vocal 1.0 > bass 0.9 > hats 0.75 and a
  bonus for the lead when it has runs. The winner's onsets are the **spine**.
- **Lead runs** (dense regular lead chains from the analysis) join the spine one to one, even
  under the threshold (by "Lead runs"), whatever the primary layer is.
- **One grid per phrase**: the division (1/4 up to the finest allowed, triplets if allowed) with
  the lowest strength-weighted timing error plus a complexity cost per division; grids finer
  than the hard ceiling allows are never used. Onsets further than a tolerance (set by "Strict
  grid") from the grid are dropped as _off grid_, the rest snap to it.
- **Caps**: hard ceiling (minimum gap `1000 / ceiling` ms), burst (notes in any one-beat
  window: `floor(burst * beatSec + 0.25)`), and the bar budget (the plan over the bar, +8 %).
  Over a cap the spine is **thinned musically**: the finest metric level first (off-16ths before
  16ths before 8ths before beats), evenly spaced across the window, accents (strength >= 0.85)
  last. Never random holes.
- **Secondary layers** add notes where they fit (up to 55-100 % of the bar budget by
  "Secondary") and chords where they coincide (below).
- **Top-up**: bars still under their plan take the remaining candidates (in calm bars only
  those >= 0.3 strength), then grid positions where some layer's onset envelope is active
  (calm bars: eighths at most).
- **Chords**: positions where two or more non-hat layers coincide at >= 0.3, with score
  `0.6 * max strength + 0.4 * coincidence` >= "Chord strength" and enough room on both sides,
  become two-note chords at a seeded rate ("Chord rate", scaled by "Secondary"); triples only
  with **Allow triples** on the strongest three-layer hits. Chords are decided per template
  position, so repeats get the same chords.

### C. Repetition lock (`rhythm.ts`)

Positions present in at least half of a group's occurrences (or averaging >= 0.45 strength)
form the **consensus**; every occurrence gets exactly that rhythm (and the same secondary
notes, top-up and gap fill, all decided on the template). What an occurrence has on its own is
rejected as _repeat consensus_, except **variation** extras: its own onsets above a threshold
(lower with more "Variation"), a limited number, only where its own caps allow (dropped first).
An intense occurrence whose own plan wants more notes than the shared rhythm (sized for the
calmest occurrence) gets its own top-up, lowest rank. "Lock" under 5 % turns the lock off (each
phrase on its own). Lanes: the optimiser's second pass asks every later occurrence to reuse the
first occurrence's lanes ("Repeat lanes" weight), with whole bars mirrored at a seeded rate
("Lane variation").

### F. Gaps and floor (`rhythm.ts`)

In bars whose activity is above **Intense above**, any gap longer than **Max gap** is filled
with the best candidate near the middle, else the phrase grid line, walking the gap until none
is too long. Everywhere with sound, every **Floor every** window gets at least one note: the
strongest lead onset in it, else drums, else bass, else anything, else the beat. Silent windows
stay empty unless **Fill silence**.

### D. Holds (`holds.ts`)

Sources: the lead note starting at the hit (its analysed duration), a sustained bass (low band)
or pad / vocal (low-mid band) note whose energy stays above 70 % until the layer's next onset,
and **legato** (a gap of a beat or more to the next note while the sound carries on). Lengths
between **Shortest** (never under 120 ms) and **Longest**; ends snap to the phrase grid with
**Align releases**. A hold is taken at a seeded rate from "Amount", the sustain's confidence and
the short/long preference ("Short holds"); a long sustain not taken whole may still become a
short hold. A sustained bass under a lead tap may become a second, held note (**layering**: a
long hold in one lane while the lead drives taps in the others). Every phrase with sustained
content gets at least one hold (Amount >= 15 %). **At once** caps simultaneous holds (lanes.ts).

### E. Lanes (`lanes.ts`)

One beam search (width 48) over the whole range. For each event (1-3 notes, some held) every
kept state is expanded with every valid lane choice; the cheapest 48 distinct states survive.

Hard rules: a lane is busy until its last note (or hold) ends plus **Min lane gap**; existing
notes block their lanes; at most **At once** holds; at most **Max same lane** notes in a row in
a lane; with **Jacks** at 0, nothing in one lane faster than an eighth.

Costs (each with its weight): same lane within a beat (`1 - jacks`, eased when the melody
repeats a pitch), same-hand notes at speed and taps under a hold on the same hand
(**Ergonomics**; lanes 1-2 left hand, 3-4 right), trill bonus (back to the lane two notes ago;
long trill runs cost more), stair bonus (one lane on, same direction), **Melody contour** (rising
pitch to a higher lane, falling to a lower one; a repeated pitch repeats or alternates),
**Repeat lanes**, **Hand balance** (runs over four on one hand), chords on one hand, keeping
holds (dropping a hold to a tap costs), and seeded noise (**Randomness**) to break ties. Jacks,
trills, stairs and chords are therefore emergent. If nothing fits, chord notes are dropped, then
the event (_no free lane_).

### G. Validation (`generate.ts`)

Notes are integer milliseconds inside the range, holds >= 120 ms (the format's minimum is 50),
and a final overlap check against the kept notes and each other removes anything left. Existing
notes are never touched unless the fill mode is Replace. Every note keeps a decision entry
(source layer, reason, score, repeat group, grid); candidates without a note keep a rejection
reason.

## Settings and defaults

| Setting               | Easy | Normal | Hard | Expert | Notes                                   |
| --------------------- | ---- | ------ | ---- | ------ | --------------------------------------- |
| Base nps              | 1.2  | 1.5    | 2    | 3      | Calm floor where there is sound         |
| Peak nps              | 2.5  | 3.5    | 5    | 7.5    | Sustained (bar budget)                  |
| Burst nps             | 4    | 6.5    | 9    | 14     | One-beat windows (whole notes per beat) |
| Ceiling nps           | 5    | 10     | 16   | 24     | Minimum gap between any two hits        |
| Curve (gamma)         | 1    | 1      | 1    | 1      |                                         |
| Contrast              | 40 % | 40 %   | 40 % | 40 %   |                                         |
| Multiplier            | 1    | 1      | 1    | 1      |                                         |
| Floor every (beats)   | 1.5  | 1      | 1    | 1      |                                         |
| Max gap (beats)       | 2    | 1.5    | 1    | 0.5    | In intense parts                        |
| Intense above         | 55 % | 55 %   | 55 % | 55 %   |                                         |
| Fill silence          | off  | off    | off  | off    |                                         |
| Lead sensitivity      | 60 % | 60 %   | 60 % | 70 %   |                                         |
| Lead runs             | 30 % | 45 %   | 60 % | 100 %  | 100 %: runs at full resolution          |
| Secondary             | 25 % | 40 %   | 55 % | 75 %   |                                         |
| Strict grid           | 70 % | 50 %   | 40 % | 40 %   |                                         |
| Triplets              | 0 %  | 20 %   | 40 % | 50 %   |                                         |
| Finest grid           | 1/8  | 1/16   | 1/16 | 1/32   | Also limited by the ceiling             |
| Hold amount           | 50 % | 50 %   | 50 % | 50 %   |                                         |
| Short holds           | 10 % | 15 %   | 20 % | 30 %   |                                         |
| Shortest hold (beats) | 1    | 0.5    | 0.5  | 0.25   | Never under 120 ms                      |
| Longest hold (beats)  | 8    | 8      | 8    | 8      |                                         |
| Holds at once         | 1    | 1      | 2    | 2      |                                         |
| Align releases        | on   | on     | on   | on     |                                         |
| Ergonomics            | 80 % | 70 %   | 60 % | 60 %   |                                         |
| Jacks                 | 0 %  | 30 %   | 75 % | 75 %   |                                         |
| Trills                | 20 % | 30 %   | 30 % | 30 %   |                                         |
| Stairs                | 60 % | 55 %   | 50 % | 50 %   |                                         |
| Melody contour        | 60 % | 60 %   | 60 % | 60 %   |                                         |
| Repeat lanes          | 80 % | 80 %   | 80 % | 80 %   |                                         |
| Chord rate            | 10 % | 30 %   | 60 % | 70 %   |                                         |
| Chord strength        | 80 % | 70 %   | 60 % | 55 %   |                                         |
| Allow triples         | off  | off    | off  | off    |                                         |
| Hand balance          | 50 % | 50 %   | 50 % | 50 %   |                                         |
| Max same lane         | 2    | 2      | 3    | 4      |                                         |
| Min lane gap (ms)     | 300  | 180    | 110  | 80     |                                         |
| Randomness            | 15 % | 15 %   | 15 % | 15 %   |                                         |
| Repeat lock           | 85 % | 85 %   | 85 % | 85 %   |                                         |
| Variation             | 25 % | 25 %   | 25 % | 25 %   |                                         |
| Lane variation        | 20 % | 20 %   | 20 % | 20 %   |                                         |

The same on every difficulty: **section roles** intro 0.8, verse 0.8, build-up 1.05, drop 0.9,
breakdown 0.85, outro 0.8 (they scale the part of the plan above base); **layer weights** snare
1, kick 0.7, other 0.6, lead 0.5, bass 0.5, hats 0.35; **activity weights** the analysis
defaults (lead 0.18, drums 0.3, syncopation 0.1, harmony 0.1, pitch leaps 0.18, low punch 0.18)
with loudness 0.02. The Suggest panel's activity weights are its own (saved with presets); the
analysis viewer's sliders only change what the viewer shows.

**Calibrated in Phase 19** against a hand-made Hard chart ([charting-calibration.md](charting-calibration.md)):
Hard is fitted (cross-validated on the two halves of the song), Expert, Normal and Easy are
scaled from it. With these defaults Hard matches the reference's rhythm with F1 69 % (+/-35 ms,
lanes ignored), at 4.4 nps on average against the reference's 4.2. Expert is about 1.4x Hard's
density outside lead runs and charts lead runs note for note.

**Full-resolution lead runs** (Lead runs at 100 %): run notes are exempt from the burst and bar
caps (the ceiling still applies), are placed on the finest grid allowed instead of the phrase's
grid, and every repeat keeps its own run onsets, not just the ones most repeats share.

## Stats after generating

Measured on the notes in the range (kept plus new), not taken from any template: note count and
seed; notes per second on average, in the densest 4-beat window and in the densest one-beat
window; holds (share, short under a beat / long); chords (share of hits); jacks, trills and
stairs (share of note-to-note moves within a beat, single notes only); the longest gap (and the
longest in intense parts); repeat consistency (Jaccard similarity of each later occurrence to the
first, for the shared rhythm alone and for all notes); which layers the notes follow; and a table
per analysis section of measured against planned notes per second.

## Limitations

- **One BPM**, and the BPM and offset must be right (see above).
- **Analysis quality**: lead notes come from a dominant-pitch track, so busy mixes, chords or
  two simultaneous melodies confuse it; vocals and pads land in "other"; section roles and
  repeat groups are heuristics and can be wrong. Everything downstream inherits these errors.
- **Top-up and gap fill** may place notes on grid positions where no onset was detected:
  plausible, not necessarily musical.
- **Lanes** follow relative pitch movement, not absolute pitch, and the optimiser has no
  look-ahead beyond its beam.
- **Calibration**: the defaults were fitted to one hand-made chart of one song (Phase 19); other
  genres and charters may want other densities and layer weights.
- **Performance**: a whole-song generation takes a few hundred milliseconds; live preview on very
  long songs may feel slow.

## Song analysis: ChartAnalysis (Phase 17)

A second, much finer analysis built for charting: it hears fast, high leads and melodies (the
most important thing to chart), separates drums from tonal parts, measures "how much is
happening" instead of "how loud it is", and knows which bars repeat. It lives in
`src/studio/charting/analysis/` (Studio only). The lighter `src/core/analysis` stays exactly as
it was: the player's animated backgrounds and the current generator use it, and ChartAnalysis
keeps its intensity, impacts and build-ups alongside its own results.

Two halves:

- **Features** (`features.ts`, the heavy part): computed once per song in a Web Worker
  (`chartAnalysisWorker.ts`, run by `ChartAnalyzer` in `chartAnalyzer.ts` with progress) and
  cached in IndexedDB (store `chartAnalyses`, database version 6) under
  `CHART_ANALYSIS_VERSION`; a cache of another version, or of different audio, is recomputed.
  About 4-5 s for a 3.5-minute song.
- **Evaluation** (`evaluate.ts`, cheap, about 0.1 s): peak picking, lead notes and runs,
  candidates, activity and structure from the cached features, the chart's BPM and offset and
  the parameters. The viewer re-runs it when the timing or a slider changes, at most once per
  frame; changing only the activity weights recomputes just the activity and the structure.

Everything is typed data (`types.ts`: `ChartFeatures`, `ChartAnalysis`, `Candidate`,
`LeadNote`, `LeadRun`, `Bar`, `Section`, ...); `chartAnalysisToJson` serialises it all and
`describeChartAnalysis` prints a summary. From the terminal (dev only, decodes with the
`audio-decode` dev dependency):

```
npm run analyze -- "<audio file>"                        # detected BPM and offset
npm run analyze -- "<audio file>" --bpm 174 --offset 120 # the chart's timing
npm run analyze -- "<audio file>" --json analysis.json   # also the whole analysis
```

### Pipeline

1. **Time-frequency features.** The mono mix is downsampled by a whole factor to about 22 kHz.
   The onset STFT is a 46 ms Hann window every 5.8 ms (1024 points at 22.05 kHz, the same
   resolution as 2048 at 44.1 kHz), folded into semitone bands; the pitch STFT is twice as long
   with twice the hop (93 ms every 11.6 ms; 4096 / 512 at 44.1 kHz). Only the derived envelopes
   and curves are cached (the full spectrograms would be hundreds of MB), which is all that
   peak picking and the sliders need: they never recompute an STFT.
2. **Harmonic/percussive separation.** Median filtering on the semitone-band spectrogram: a
   time median (about 100 ms) keeps steady partials, a frequency median (13 bands) keeps
   broadband hits; soft Wiener masks split the mixture. Drums then don't mask melodies, and
   melodies don't make fake drum onsets.
3. **Layers.** Each has an onset envelope: the layer's bands of the harmonic or percussive part,
   adaptively whitened per band (divided by a peak follower that halves in 2 s, so quiet parts
   count as much as loud ones), log-compressed, and the half-wave rectified difference with the
   frame 11.6 ms earlier (against the maximum of the neighbouring bands, which ignores vibrato
   and slides). Layers: **kick** (30-120 Hz percussive), **snare / clap** (200 Hz-3 kHz
   percussive), **hats / air** (6 kHz and up, percussive), **bass** (40-250 Hz harmonic),
   **lead** (500 Hz-8 kHz harmonic, with the pitch track) and **other / vocal** (200 Hz-2 kHz
   harmonic).
   **Peak picking** (`onsets.ts`) uses adaptive local thresholds: a peak must beat the
   envelope's mean over +-200 ms by a factor set by the sensitivity, plus a small floor tied to
   the layer's own level, and be the highest within half the minimum interval. Strengths (0-1)
   are relative to the layer's own maximum over +-1.5 s, so a quiet fast arpeggio under loud
   drums still scores. Onsets of different layers within 20 ms merge into one **candidate** that
   keeps every contributing layer's strength (and the lead pitch).
4. **Lead and melody** (`lead.ts`). Per pitch frame: a 3-frame median (drops single-frame
   clicks), spectral whitening (what stands above the local spectral mean), a lead weighting
   (partials under about 300 Hz, kick and bass, count little), then **harmonic summation** over
   MIDI 52-100 in thirds of a semitone (up to 10 harmonics below 6 kHz, each weighted 0.8 of
   the previous), refined between candidates. **Salience** is the winning sum; **confidence** is
   the share of the whitened spectrum its harmonics explain (high for one clear voice, low for
   noise, drums and dense chords). A frame is voiced when the confidence is high enough and the
   salience beats its own mean over +-200 ms (and a low song-wide floor); both thresholds follow
   the lead sensitivity. **Notes** start at voiced frames and split at pitch changes of 0.7
   semitone or more (confirmed by three steady frames or an onset), at same-pitch re-attacks
   (a clear lead-flux onset) and at salience re-attacks; a note ends when its salience drops
   under a quarter of its peak or the pitch goes away. Nothing smooths across notes: splits only
   need the **minimum lead interval** (default 40 ms, so 1/16 at 200+ BPM survives). Onset
   times are snapped to the nearest lead-flux peak (the pitch window is long). Each note has
   `tMs`, `durMs`, `midi` (float), `strength` (local) and `confidence`.
   **Lead runs** are chains of 5 or more lead onsets with short (at most about a third of a
   beat) and consistent (within 30 %) gaps: start, end, count, rate, onsets per beat and the
   pitch contour.
5. **Structure** (`structure.ts`). Bars of 4 beats from the chart's BPM and offset. Per bar a
   rhythm fingerprint (each layer's envelope maximum in each 1/16) and a timbre vector (band
   energies, brightness, loudness, chroma), both centred on the song mean. A bar
   **self-similarity matrix** combines them (0-1). Repeated phrases: for 2-, 4- and 8-bar
   phrases at every phase, phrases are clustered greedily by their mean diagonal similarity
   (threshold from the song's own similarity distribution, so small differences are tolerated);
   the length and phase whose groups cover the most bars win (longer phrases slightly
   preferred). Every bar gets a **repeat group** and **repeat index**. **Sections** come from
   novelty (a checkerboard kernel over 4 bars on the matrix, plus activity changes and repeat
   group changes), at least 4 bars, snapped to phrase starts, and are labelled by rules:
   **drop / chorus** = among the most active with low punch (and sections repeating a drop's
   material); **build-up** = rising activity (or a detected build-up, or thin low end) right
   before a drop; **intro** / **outro** = calmer first / last sections; **breakdown / bridge** =
   calm sections without punch in between; otherwise **verse**. Loudness alone never decides.
6. **Musical activity** (`activity.ts`, 0-1 at 50 Hz): a weighted blend of lead onset density,
   snare/hat density, syncopation (onset strength off the beat, fading out where little
   happens), harmony change rate (chroma change), pitch leaps (3+ semitones), low-band punch
   (kick density) and loudness, each relative to the song, smoothed over half a beat. Default
   weights 0.30 / 0.18 / 0.10 / 0.10 / 0.10 / 0.17 / **0.05 loudness**; all are parameters.

### The analysis viewer (editor)

**Analysis** in the editor's top bar (or **V**) shows everything the analyzer sees. The first
time it runs the analysis (progress in the panel); later visits read the cache.

Tracks appear right of the waveform band, as vertical strips that scroll and zoom with the
timeline (same time axis: later is higher). Each can be switched off (panel > Tracks) and
resized by dragging the right edge of its header; clicking a track seeks. They draw only the
visible range from max pyramids, one lookup per device-pixel row.

| Track                  | What it shows                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bar                    | Bar numbers and beat ticks from the chart's BPM and offset.                                                                                                                                             |
| Wave                   | The waveform.                                                                                                                                                                                           |
| Loud                   | Loudness: RMS in dB, 0 at the song's quiet level, 1 at its loud level.                                                                                                                                  |
| Bands                  | Energy of sub (< 60 Hz), low (60-250), low-mid (250-2k), high-mid (2-6k) and high (> 6k), left to right, each 0-1 between its own quiet and loud levels.                                                |
| Kick, Snr, Hat ... Oth | One onset envelope per layer (kick, snare / clap, hats / air, bass, lead, other / vocal), scaled to the layer's 99th percentile, with the picked onsets as ticks on the right edge (longer = stronger). |
| Lead roll              | Piano roll: pitch across (low left, C lines labelled), time up. Bars are lead notes (brighter = stronger, a cap at each onset), dots the tracked pitch where it is confident, shading the lead runs.    |
| Act                    | Musical activity (the weights in the panel).                                                                                                                                                            |
| Int                    | Intensity of the older analysis (loudness-led), for comparison.                                                                                                                                         |
| Imp                    | Impacts (ticks; thick = drop) and build-ups (shaded) of the older analysis.                                                                                                                             |
| Section                | Sections coloured by role, with labels.                                                                                                                                                                 |
| Rep                    | Repeat groups: one colour per group, labelled with the group letter and occurrence at each phrase start (B3 = the third B phrase).                                                                      |

Over the lanes, **onset ticks** (panel > Display) show every candidate: one tick per
contributing layer in that layer's column (kick on the left ... other on the right), longer for
stronger; lead runs are shaded. **Inspect on hover** shows a tooltip with every value at the
pointer's time: section, repeat group, activity and its ingredients, intensity, loudness, bands,
brightness, harmony change, the pitch track, the lead note, the lead run, every layer's envelope
and the candidates within 60 ms with their layer strengths and pitch.

The floating **Analysis** panel (docked top right, the timeline lays itself out beside it; drag
its header to move it, double-click the header to dock it again; its close button hides only the
panel, the Analysis button brings it back) has a summary (timing, candidates per layer, lead
notes and range, runs, sections, repeat groups), the **similarity matrix** (bar against bar,
bright = alike, the playhead's bar marked; click a cell to jump to that bar), the **activity
weights** (live), **lead sensitivity**, **minimum lead interval** and the other layers'
sensitivity (live, re-running peak picking from the cached features), display options, the
track list, and **Export analysis JSON**. The minimap shows the section roles and repeat groups
as two coloured bands along its top. Viewer settings are remembered in localStorage
(`ataraxia.editor-analysis`).

### Limitations

- One dominant pitch per frame: chords and two simultaneous melodies give the louder or clearer
  voice, and very dense supersaw chords can read as unvoiced (raise the lead sensitivity).
- Pitch can still fall an octave off on some timbres; onset times are unaffected.
- Structure assumes 4/4 and a correct BPM and offset; with a wrong grid, bars, repeats and
  syncopation are wrong too. Set the timing first.
- Section labels are rules, not understanding: expect the occasional verse labelled as a
  breakdown, or a long drop split in two.
- Tuned by ear and on one reference song only; the defaults are a starting point.
- The note generator does not use ChartAnalysis yet (planned for Phase 18).
