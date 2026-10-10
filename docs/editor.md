# Chart editor

Studio only (see `docs/architecture.md`): the player build contains no editor. Opened from
Studio home (Enter, E or "Edit chart") for a stored chart, or with E on the results screen of the
Studio build. The built-in demo can't be opened in the editor (it is read-only; import your own
audio to make charts). Main menu "Studio" leads to Studio home.

## Studio home (`src/studio/studioHomeScene.ts`)

The creator's library, built on the same song browser as the player's song select
(`src/ui/songBrowser.ts`) but with every creation action: import audio (I, or drop audio files),
import a song package (O) or chart JSON (C, into the selected song), edit chart (E / Enter),
playtest the stored chart (T; the game comes back here), new chart (N), duplicate chart (U),
edit song and chart info (R), export chart (X) and song package (K), settings (S), delete chart
or song (Del). These operations live in `StudioLibrary` (`src/studio/studioLibrary.ts`), which
works on the same IndexedDB data as the player's `SongLibrary`.

## Screen layout (Phase 12)

The editor wears the Phase 9 design system (`docs/design.md`): flat steel bars, glass menus and
cards, steel buttons, key caps and pixel icons; the pixel font for headings and button labels,
Inter for values, descriptions and small text. Advanced controls sit behind "More" so the
everyday ones stay in view. Every control has a tooltip with its shortcut (one floating tooltip,
`installTooltips` in `editorUi.ts`, so panels that scroll never clip it).

- **Top bar**: back (Esc), cover and song title with difficulty / level / charter, save status
  (dot + Saved / Unsaved changes / Saving... / Not saved; the tooltip has the details), undo and
  redo, the **Playtest** button (P; Shift+P from the game start), the **Export** menu (chart
  .json, song package .zip, replace from a chart file, save now) and the help button (?).
- **Tool rail** (left): Place (N), Select (S), Record (R), each with its key under the icon.
- **Timeline** (centre): lanes over the waveform, grid, measure numbers and timestamps, the
  "before song" region and the game-start flag (below).
- **Side panel** (right), collapsible sections whose open/closed state is remembered
  (`ataraxia.editor-sections`):
  - **Timing** (open by default): BPM, offset, tap tempo (T) with Apply, metronome toggle (M),
    "Set beat 0 here"; under **More**: /2 and x2, BPM +-0.1 / +-0.01, offset +-1 / +-10 ms and
    **Detect BPM**.
  - **Selection** (only while notes are selected): count, nudge one snap earlier / later, one
    lane left / right, mirror, copy, delete.
  - **Chart info**: title, artist, difficulty, level, charter, and the start offset (game
    start: time, auto or custom, "Set at playhead", "Auto").
  - **Stats**: notes, holds, average and peak notes per second, length, and what is on screen.
  - **Suggest**: seeded, rhythm-first note suggestions shown as ghost notes with Accept and
    Discard: difficulty, my presets, seed, range, fill mode, live preview, the last five
    generations, measured stats, and grouped settings (density, section roles, rhythm sources,
    activity, repetition, holds, lane behaviour); see [charting.md](charting.md).
- **Transport bar**: jump to start (Home), play/pause (Space), jump to end (End), time and
  measure/beat, speed (50 / 75 / 100 %), snap as a segmented control (1/4, 1/8, 1/16, each with
  its grid colour) plus a "more" dropdown (1/3, 1/6, 1/12, 1/2, 1/1), the **Snap on scroll stop**
  toggle (magnet, default off), music and click volume, and a "more options" menu (hit sounds,
  invert scroll, snap on scroll stop, lane size 1x-4x, reset zoom).
- **Minimap** (bottom, full width): the whole editor span left to right with the waveform, the
  pre-song region, the visible window, the playhead, the game start and a **note density strip**
  (notes per second around each point, `core/noteDensity.ts`, in five flat colour bands: none,
  under 2.5, under 5, under 8, 8 and more). Click or drag to jump.
- **First-use help**: a dismissible quick-start card while the chart has no notes (1 tune BPM and
  offset with the metronome, 2 place notes, 3 playtest; dismissal remembered in
  `ataraxia.editor-quickstart-dismissed`), and the `?` cheat sheet of every shortcut.
- Notices (rejected edits, undo, saves) are design-system toasts over the timeline.

## Smooth scrolling and zoom (`core/editorScroll.ts`)

The editor state holds the **target** playhead time and zoom; the timeline draws a **displayed**
time and zoom (`SmoothView`) that follow it every frame with exponential smoothing,
`display = target + (display - target) * exp(-dt / tau)`, using the real frame time, so the
motion is the same at 30, 60 or 144 Hz (tested). Smoothing is continuous in time; drawing rounds
lines and sprites to whole device pixels, so edges stay crisp. Editing always uses the target
(paste, recording, playtest from the playhead); pointer positions map through what is on screen.

- **Wheel**: deltas are normalised to screen pixels (`normalizeWheel`): mouse notches (line or
  page mode, or pixel deltas of 50 and more) count as 80 px each whatever the browser reports,
  trackpad pixel deltas pass through 1:1. Pixels become time at the current zoom
  (`wheelScrollMs`), so a notch moves the same distance on screen at any zoom. Time constant
  70 ms. Wheel up moves later in the song; **Invert scroll** flips it. **Shift**: fine scroll, a
  quarter as far. While playing the wheel only zooms (pause to scroll). The range includes the
  30 s before the audio.
- **Ctrl+wheel** zooms in log scale (one notch about 11 %), animated with the same smoothing.
  Paused, the song time under the pointer stays where it is (the playhead moves accordingly);
  while playing the zoom is around the playhead.
- **Up / Down, PgUp / PgDn, Home / End** glide to their target with a 30 ms time constant (about
  95 % there after 90 ms). Minimap clicks jump without animation.
- **Snap on scroll stop**: 140 ms after the last wheel scroll the playhead eases (70 ms) onto the
  nearest line of the current snap.

## Timeline drawing

Native-resolution canvas in the pixel style: flat colour bands (no antialiased gradients),
1-device-pixel grid lines, the waveform as flat rows with a two-tone fill (the peak envelope and a
brighter inner half), the region before the audio tinted and labelled, after the end dimmed. The
playhead is a 2-device-pixel line with stepped pixel arrows. Grid colours keep their meaning but
are muted: measures light steel, beats red, 1/2 blue, 1/4 yellow, 1/3 and 1/6 purple, 1/8
orange, 1/12 pink, 1/16 teal (the snap segments show the same colours). Labels use Inter.

Notes come from the active skin, scaled by **nearest neighbour at a whole number of device
pixels per sprite pixel**: editor lane width = the skin's lane width (64) x the **lane size**
(1-4, default 2, in the transport's more menu) x devicePixelRatio, rounded to whole device pixels
(`core/laneScale.ts`); when the lanes would not fit, the next smaller size is used. Holds stretch
their one-row body between head and tail. The game start is a small metallic **flag** (steel pole,
banded cloth) right of the waveform band with a line across it, dashed while automatic.

## Structure (`src/studio/editor`)

| File                           | Role                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `editorState.ts`               | All editor state and mutations: meta, playhead, zoom, snap, options, notes, selection, tool, clipboard, undo history, live recording. No DOM. |
| `editorScene.ts`               | Layout, keyboard dispatch, smooth view, audio, autosave, playtest, frame loop. Redraws only when something changed or the view still moves.   |
| `editorUi.ts`                  | Screen widgets: floating tooltips with key caps, dropdown menus, segmented controls, collapsible sections, "More" disclosures, icon buttons.  |
| `keymap.ts`                    | Key press -> command (pure; the documented shortcuts are tested against it).                                                                  |
| `snapControl.ts`               | Snap segments (1/4, 1/8, 1/16) and the "more" list.                                                                                           |
| `timelineTools.ts`             | Mouse interaction for the place and select tools (place, hold drag, select, box select, move drag, start flag drag) and their overlay.        |
| `noteRenderer.ts`              | Notes from the skin's gameplay sprites at an integer scale, selection outlines, ghosts, previews, record badge; hit testing.                  |
| `editorPanel.ts`               | Side panel sections: Timing, Selection, Chart info, Stats, Suggest.                                                                           |
| `timelineRenderer.ts`          | Lanes, waveform, beat grid, labels, start flag, playhead (native resolution); calls the note layer between grid and playhead.                 |
| `overviewRenderer.ts`          | The horizontal minimap with the density strip; waveform and density are cached offscreen.                                                     |
| `timelineLayout.ts`            | Horizontal layout from the lane size, `laneAt` hit testing.                                                                                   |
| `editorTheme.ts`               | Canvas colours from the theme ramps, muted grid colours.                                                                                      |
| `metronome.ts`                 | `ClickScheduler` lookahead scheduler (25 ms timer, 100 ms window) against the audio clock; `Metronome` and `HitSounds` use it.                |
| `chartIO.ts`                   | Export chart (.json), export song package (.zip), import chart JSON into this chart.                                                          |
| `shortcuts.ts`                 | The shortcut list (source of truth for the `?` cheat sheet) and the sheet itself.                                                             |
| `waveform.ts`, `peakWorker.ts` | Peak pyramid per decoded song, built in a Web Worker, cached per AudioBuffer.                                                                 |
| `autosave.ts`                  | 500 ms debounced, non-overlapping saves with retry.                                                                                           |
| `assistPanel.ts`               | Detect BPM (Timing > More) and the Suggest section (generate, ghost notes, Accept / Discard, preview, analysis overlay).                      |
| `comparePanel.ts`              | Compare chart (Phase 19): another chart of the song as read-only matched / missing / extra markers, counts and F1.                            |
| `acceptBar.ts`                 | The floating Accept / Discard / New seed bar over the lanes while a suggestion is previewed, with its summary.                                |
| `analysisView.ts`              | The analysis viewer (Phase 17): runs ChartAnalysis, the floating Analysis panel, the hover inspector, track layout and resizing.              |
| `analysisTracks.ts`            | The analysis tracks beside the lanes and the onset ticks over them, drawn from max pyramids (visible range only).                             |
| `../../audio/audioAnalysis.ts` | `AudioAnalyzer` (shared with the backgrounds): runs `core/analysis` once per song in `analysisWorker.ts`, caches per AudioBuffer and in IDB.  |
| `devSampleChart.ts`            | Dev only (`?editorChart=sample`, or `empty`): a generated chart for `npm run screenshots`.                                                    |

Pure logic lives in `src/core`: `editorScroll.ts` (wheel normalisation, smoothing, zoom),
`noteDensity.ts` (minimap density strip), `laneScale.ts` (lane size), `noteEdit.ts` (placement, snapping, overlap checks, holds, move,
paste, mirror, recording quantisation, stats, normalisation, `validatedChart`), `undoHistory.ts`
(command pattern, grouping, 200-step limit), `beatGrid.ts`, `timeline.ts`, `tapTempo.ts`,
`peaks.ts`, and for charting assistance `fft.ts`, `onsets.ts`, `tempo.ts` and `analysis/`
(tested with the synthetic signals in `syntheticSignals.ts`). The note generator is pure too but
Studio only: `src/studio/charting/` ([charting.md](charting.md)).

## Editing model

- Every note edit is computed by a pure function in `core/noteEdit.ts` that returns the notes to
  remove and add, or a sentence explaining why it is refused (overlap in a lane, hold shorter than
  50 ms, more than 30 s before the audio or past its end, outside the lanes). Refusals show as a short
  notice over the timeline and change nothing, so the chart in memory is always valid.
- Accepted edits run as commands on `UndoHistory` (200 steps). A drag, paste, mirror, nudge or
  import is one command; a whole live-recording session (from the first recorded note until
  playback stops or record mode is turned off) is one grouped step. Undo re-selects notes that
  come back. Metadata fields are not part of undo (their text boxes have native undo).
- Notes are identified by object identity (they are immutable), so selection survives undo/redo.
- Snapping: placements go to the grid line nearest the pointer at the current snap (never more
  than 30 s before the audio; negative times are fine). Holds snap both ends, in either drag direction, and are at least one snap division and
  at least 50 ms long. Moves snap the grabbed note to the grid and keep relative spacing. Alt+Up/
  Down move the earliest selected note to the next/previous grid line and shift the rest equally.
- Paste puts the earliest copied note on the grid line nearest the playhead.
- Box selection picks notes whose lane is inside the box and whose time span (head to hold end)
  touches it.

## Charting assistance

Two tools in the side panel help start a chart (Detect BPM under Timing > More, note suggestions in
the Suggest section). Both read one analysis of the song (`core/analysis`), computed the first
time either is used, in a Web Worker (`analysisWorker.ts`), with a progress bar; the editor stays
responsive meanwhile. The result is kept for the decoded song and cached in IndexedDB per song,
so later uses, returning from a playtest and later visits are instant. If workers are
unavailable the same code runs on the main thread in small slices.

**Onsets** (`core/onsets.ts`, part of the analysis): mono mix, downsampled to about 11 kHz; 512-sample Hann frames
every 64 samples (~6 ms); spectral flux of log-compressed magnitudes. Onsets are flux peaks at
least 1.5x the local median (+-400 ms) plus a small floor, at least 35 ms apart, with sub-frame
interpolation. Strength is the height above the median relative to the 98th percentile of all
onsets (0-1). An RMS envelope per frame is kept for sustain detection.

**Detect BPM** (`core/tempo.ts`): autocorrelation of the onset envelope gives a coarse tempo
(peaks weighted to prefer 80-200 BPM); a fine search within +-3 % picks the BPM whose beat grid
best fits all onset times (steps of 0.01 BPM, refined); whole or half BPMs are preferred when
they fit at least 98.5 % as well. The offset is the grid phase that best fits the onsets,
refined by the mean deviation of nearby onsets, moved to the beat of the measure with the most
onset strength and placed at the last such downbeat not after the first onset. Confidence
(0-100 %) is the grid fit, scaled down when there are fewer than 32 onsets; under 40 % is shown
as low, 70 % and up as high. The double and half tempo are offered as alternatives with their
own offsets. Nothing changes until **Apply**, which sets BPM and offset as one undo step
(Ctrl+Z restores both). Notes are not moved: they keep their times; only the grid changes.

**Suggest** (`src/studio/charting/`, `suggestPanel.ts`): seeded, rhythm-first note generation
on the ChartAnalysis: a density plan from musical activity and section roles, the most salient
rhythm (the lead first) per phrase, one rhythm per repeat group, holds, and one continuous lane
optimisation. How it works, every setting and its limitations: [charting.md](charting.md).

**Analysis viewer** (`analysisView.ts`, `analysisTracks.ts`, Phase 17): **Analysis** in the top
bar (or V) shows everything the Studio's finer song analysis (ChartAnalysis,
`src/studio/charting/analysis`) sees: data tracks beside the lanes, onset ticks over them, a
hover inspector, a floating panel with the similarity matrix and live sliders, and section and
repeat bands on the minimap. Details: [charting.md](charting.md#song-analysis-chartanalysis-phase-17).

**Accept bar** (`acceptBar.ts`, Phase 16): while generated notes are previewed (ghost notes), a
floating bar sits at the top of the timeline, centred over the lanes. It belongs to the timeline
view, so it never scrolls away and stays visible when the side panel is collapsed or scrolled.
It holds **Accept** (primary, Enter), **Discard** (Esc) and **New seed** (G: generate again with
a new random seed and the same settings) and a one-line summary of the preview: note count,
average and peak notes per second (4-beat windows over the generated range) and holds. It slides
in from the top (no motion with reduced motion) and a toast says "Preview ready: Enter to
accept, Esc to discard". Enter and Esc act on the preview only when focus is not in a text field
(Enter also leaves a focused button alone); Esc discards before it clears the selection or
leaves. The minimap tints the generated range while the preview exists. Accept is still one undo
step. The Suggest section keeps a compact Accept / Discard next to the density preview.

**Compare chart** (`comparePanel.ts`, diff in `src/studio/charting/compare.ts`, Phase 19): the
last group of the Suggest section. Pick another chart of the same song (the saved version) or
**Import JSON** (any valid chart file; it is only read, never imported into this chart). Its notes
appear on the timeline as read-only markers, diffed against the chart being edited, or against
the chart with the generator preview applied while a preview is shown (so a fresh generation can
be judged against a hand chart before accepting it):

- **matched**: a thin grey outline (a note of the compare chart that this chart also has, within
  the tolerance);
- **missing**: amber tint and outline (only in the compare chart);
- **extra**: a violet outline around my note (only in this chart or the preview).

Matching is one to one and maximal, within the **Tolerance** (default 35 ms, 10-100). By default a
note only matches a note in the same lane; **Rhythm only** merges notes closer than 20 ms into one
hit (a chord counts once) and matches hits regardless of lane. The result card shows matched /
missing / extra counts and precision (share of mine the compare chart has), recall (share of the
compare chart I have) and F1, for the whole chart and for the range on screen (updated while
scrolling). **Show markers** (or C) hides the markers without forgetting the compare chart;
**Clear** forgets it. Nothing here edits the chart or enters the undo history.

### Limitations

Detection is a starting point, not a replacement for tuning by ear. Always check the grid with
the metronome and the first notes with hit sounds before charting further.

- **One tempo per song.** The chart format has a single BPM; songs with tempo changes, rubato,
  drifting live recordings or long free-time intros get a compromise tempo that is right in some
  sections only. Detection uses the whole song.
- **Octave errors.** Half or double tempo is a matter of taste for many songs; the 80-200 BPM
  preference decides by default. Use the x2 and /2 alternatives.
- **Downbeats are guessed** from where the strongest onsets fall; the offset can be a beat or
  more off from the "real" bar start (still on the beat grid). Fix it with "Set beat 0 here".
- **Swing, triplet feels and syncopation** fit the grid less well, lowering the confidence even
  when the BPM is right; heavily syncopated songs can lock onto the off-beats.
- **Onsets are not instruments.** Detection follows what is loud and percussive (drums mostly),
  not the melody or vocals; soft attacks, dense mixes and heavy compression produce fewer or
  noisier onsets. Suggestion limitations: [charting.md](charting.md#limitations).
- Silence or steady noise gives no onsets: no BPM suggestion and no notes.
- Accuracy is only measured on synthetic signals (the unit tests: click tracks at 128, 140 and
  93.5 BPM come out exact with the offset within a few ms). It has not been benchmarked on a
  set of real songs, so treat every result as a suggestion to verify.

## Live recording

R arms record mode (the rail's record button turns red and the timeline shows "recording"). While the song plays, the gameplay lane keys (S D J K by
default, from the shared `laneKeys` setting; the rail tooltip, the cheat sheet and messages show the current
bindings) and 1-4 place taps at the key's song time
(`event.timeStamp` converted on the audio clock), quantised to the current snap. A key held longer
than a quarter beat becomes a hold to the snapped release time (min one division). Recorded notes
that would overlap existing notes are skipped silently. While Rec is on, lane keys record instead
of running their editor shortcuts (with the defaults, S records instead of picking the select
tool); a hold that would run into the next note
stays a tap. Latency: the player's `audioOffsetMs` setting (`inputLatencyOffsetMs()` in
`src/game/settings.ts`) is subtracted from every recorded time, exactly as in gameplay; song time
already follows the heard audio.

## Hit sounds

Y toggles a short click on every note head (one per chord), scheduled on the audio clock by the
same lookahead scheduler as the metronome, so it stays sample-accurate at 50/75/100 % speed.
Metronome and hit-sound clicks can be cancelled independently and share the click volume.

## Playtest

P (or the button) validates the in-memory chart and opens the real game scene with it in
`playtest` mode (never saved as a score): play starts at the playhead minus the player's
**Run-in time** setting (default 1.5 s) and only notes from the playhead on are judged
(`startTimeMs`). Shift+P plays from the effective game start, every note judged. No countdown
either way. The game starts
automatically when audio is already unlocked. Esc returns at once; at the end the results show for
3 s, then the editor comes back (Enter retries). The editor resumes with the same `EditorState`
object (`returnTo.params.resume`), so playhead, zoom, selection, tool and undo history are intact.

## Before the song and the game start

- Song time 0 is where the audio begins. The playhead, view, scrolling, overview scrubbing and
  Home go down to -30 s (`editorSpan` in `core/timeline.ts`), and up to 10 s past the end of the
  audio. Below 0 the timeline is tinted and labelled "before song" and has no waveform; the beat
  grid and measure numbers continue (measure 0, -1, ...). The minimap covers the same span, with
  the pre-song region tinted.
- Notes can be placed, moved, pasted and live-recorded down to -30 s. Playback can start before
  0: silence, then the audio at 0; the metronome and hit sounds work in the negative region too.
- The **start flag** shows where a play from the beginning starts (the effective start: a dashed
  line and "start (auto)" while automatic, solid when custom). Drag it anywhere outside the lanes
  to move it (snapped to the grid, between -30 s and 0). **Chart info > Start offset** shows the
  time and whether it is auto or custom, with **Set at playhead** and **Auto**. Every change is
  one undo step and autosaves with the chart (`startMs`).
- Home jumps to the earliest of the game start, the first note and 0.

## Saving, import, export

- Notes and metadata autosave to IndexedDB (500 ms debounce); the top bar shows Saved / Unsaved
  changes / Saving... / Not saved. Ctrl+S (or Export > Save now) saves immediately.
- Each save normalises the whole chart (sort by time then lane, whole-number fields clamped) and
  runs `parseChart` on it (`validatedChart`). If that fails, nothing is written (the last good save
  stays), the error is shown and the changes stay pending.
- Leaving with an unsaved or failed save asks before discarding; closing the tab warns.
- Export > Export chart (.json) downloads the chart as it is in memory (validated). Export
  package (.zip) saves first, then uses the Phase 3 package export. Replace from chart file
  validates with `parseChart` (errors are listed and
  the chart is left untouched), then asks to replace; if the file's BPM/offset differ from the
  song's, a third button also applies them (they are song-level, shared by every chart).

## Behaviour (timeline)

- Timeline: future time upward, playhead at 72 % of the height. Zoom 20 px/s to 3000 px/s.
- Grid lines closer than 7 px fall back to beats, then measures only.
- Clicking the waveform margin beside the lanes seeks (place tool) or starts a box (select tool).
- Notes already passed dim during playback. Stats: notes, holds, average and peak notes per
  second (peak = most heads in any 1 s window) for the whole chart, chart length (first note to
  last note end), and notes and peak on screen.
- Playback speed uses `AudioBufferSourceNode.playbackRate` (pitch changes). The song clock's
  anchor carries the rate, so the playhead, metronome and hit sounds follow it.
- Song fields (title, artist, BPM, offset) are saved on the song and shared by all its charts;
  difficulty, level, charter and notes on the chart.
- Preferences (zoom, snap, speed, metronome, hit sounds, volumes, lane size, invert scroll, snap
  on scroll stop) are kept in localStorage (`pixel-beat:editor-prefs`; the key predates the
  rename and is kept so preferences survive).

## Keyboard shortcuts

Also shown in the editor with `?` (source: `src/studio/editor/shortcuts.ts`; keys map to commands
in `keymap.ts`, whose test checks every row below; the lane keys row shows the player's current
bindings). Phase 12 kept every key; only how the view moves changed.

| Keys                     | Action                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| **Tools**                |                                                                         |
| N                        | Place tool                                                              |
| S                        | Select tool                                                             |
| R                        | Record mode on/off                                                      |
| Y                        | Hit sounds on/off                                                       |
| M                        | Metronome on/off                                                        |
| V                        | Analysis view on/off (tracks, panel, inspector)                         |
| C                        | Compare markers on/off (Suggest > Compare chart)                        |
| ?                        | Show / hide shortcut help                                               |
| **Place tool**           |                                                                         |
| Click                    | Place a tap note                                                        |
| Drag along a lane        | Place a hold note (length shown while dragging)                         |
| Click a note             | Select it (never deletes)                                               |
| Right click              | Delete the note under the pointer                                       |
| Delete / Backspace       | Delete the note under the pointer (or the selection)                    |
| **Select tool**          |                                                                         |
| Click                    | Select a note                                                           |
| Shift+Click              | Add / remove a note                                                     |
| Drag on empty space      | Box select (Shift: add to the selection)                                |
| Drag selected notes      | Move in time (snapped) and between lanes                                |
| Alt+Up / Alt+Down        | Move selection one snap later / earlier                                 |
| Alt+Left / Alt+Right     | Move selection one lane left / right                                    |
| H                        | Mirror selection (lane -> 3 - lane)                                     |
| Delete / Backspace       | Delete selection                                                        |
| Ctrl+A                   | Select all                                                              |
| Esc                      | Cancel a drag, else discard a preview, else clear selection, else leave |
| **Edit**                 |                                                                         |
| Ctrl+Z                   | Undo                                                                    |
| Ctrl+Shift+Z / Ctrl+Y    | Redo                                                                    |
| Ctrl+C / Ctrl+X          | Copy / cut selection                                                    |
| Ctrl+V                   | Paste at the playhead                                                   |
| Ctrl+S                   | Save now                                                                |
| **Suggested notes**      | (while a preview exists; not in text fields)                            |
| Enter                    | Accept the generated notes (one undo step)                              |
| Esc                      | Discard them                                                            |
| G                        | Generate again with a new random seed                                   |
| **Record mode**          |                                                                         |
| Lane keys (S D J K)      | Place notes at the song time while playing                              |
| 1 2 3 4                  | Also lanes 1-4 while recording                                          |
| Hold a key > 1/4 beat    | Records a hold                                                          |
| **Playback, navigation** |                                                                         |
| Space                    | Play / pause                                                            |
| P                        | Playtest from the playhead (after the run-in time)                      |
| Shift+P                  | Playtest from the beginning                                             |
| Up / Down                | Glide by one snap                                                       |
| PgUp / PgDn              | Glide by one measure                                                    |
| Home / End               | Game start or first note (if before 0) / end of audio                   |
| Wheel / Shift+Wheel      | Smooth scroll / fine scroll (a quarter as far)                          |
| Ctrl+Wheel               | Zoom around the pointer (playhead while playing)                        |
| [ / ] or 1-8             | Snap division (1-8 not while recording)                                 |
| T                        | Tap tempo                                                               |
| A / B                    | Set range start / end at the playhead (Suggest, A-B range)              |
| Esc                      | Back to Studio home (asks if a save failed)                             |
