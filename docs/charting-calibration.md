# Charting calibration

How the note generator's defaults ([charting.md](charting.md)) were fitted (Phase 19) against a
hand-made chart. Re-run with:

```sh
npm run calibrate -- --audio "<song>" --chart "<chart.json>" --difficulty hard
npm run calibrate -- ... --all          # also Easy, Normal and Expert
npm run calibrate -- ... --tune         # parameter search (fit one half, validate the other)
npm run calibrate -- ... --from <setup.json>   # evaluate or search from a saved setup
npm run calibrate -- ... --sanity "<song>" "<chart>"   # a second song, reported, never fitted
```

`scripts/calibrate.mjs` is dev only: it decodes the audio with the `audio-decode` dev dependency,
loads the TypeScript sources through Vite's module runner, runs the Studio's ChartAnalysis and the
generator with seeds 1-5, and compares every result with the reference
(`src/studio/charting/calibrationMetrics.ts`). It prints the tables below, rewrites the part of
this file between the `calibration:begin` / `calibration:end` markers and writes the metrics as
JSON (`docs/charting-calibration.json`; numbers only). The reference song and chart live in
`reference/`, which is gitignored and never committed or bundled. The chart must be in the
project's format (it is read with `parseChart`); the Phase 19 reference already was (v2).

The earlier reference (Phase 13: a slowed montagem, a chart recorded from a player's key
presses) is no longer in `reference/`, so there is no second-genre sanity check in this run.

## Method

The reference is charted by hand, so its note positions are ground truth for rhythm. Notes closer
than 20 ms are merged into one **hit** (chords, and rolled chords whose notes are about 1/64
apart); all rhythm metrics use hits.

1. **Rhythm match**: precision, recall and F1 of generated hits against reference hits, one to one,
   within +/-35 ms, lanes ignored (`compare.ts`, shared with the editor's compare overlay).
2. **Layer attribution**: for each reference hit, the nearest _clear_ candidate (strength 0.5 or
   more) within 25 ms and its strongest layer. Candidates are dense (about 20 per second), so any
   candidate within 35 ms explains 99 % of the hits and 91 % of the same hits shifted off the
   grid: the plain share means nothing. Reported instead: the share with a clear candidate
   against the chance level (the reference shifted 3/8 of a beat both ways), and per layer the
   **lift**: the share of reference hits with a clear onset of that layer divided by the share of
   all eighth-note grid positions with one (above 1: the charter follows that layer more than the
   grid does). Also recall inside the detected lead runs (analyzer and generator), the share of
   lead-run onsets each chart charts, the reference's own fast passages (4+ hits at most a third
   of a beat apart), and unexplained reference hits grouped (gaps under 2 beats) with their
   section, context and loudest band.
3. **Density**: hits per second in 2-beat windows on the beat grid over the reference's span:
   Pearson correlation, mean, densest 4 beats and densest beat, the 90th percentile of 4-beat
   windows, the density of the most active third of windows (analysis activity) over the calmest
   third, the lowest generated density in calm windows where the reference has notes, the share of
   windows with reference notes and no generated note, and the longest gap inside intense windows.
4. **Holds**: per minute, share under a beat, mean length, layered (another note's head inside).
5. **Lanes**, measured from the lane sequence: chords (share of hits), jacks (consecutive hits at
   most a beat apart sharing a lane), trills (a-b-a single notes), stairs (three single notes one
   lane apart in one direction), left-hand share, lane shares and the entropy of single-note lane
   transitions.
6. **Repetition**: per repeat group of the analysis, the mean Jaccard similarity of the instances'
   hit positions on a sixteenth grid (reference and generated).

**Composite score** (0-1), the weighted mean of: rhythm F1 0.30, density correlation 0.12, mean
density 0.08, intense / calm ratio 0.08, calm floor (no empty windows where the reference has
notes) 0.08, longest intense gap (only longer than the reference is penalised) 0.04, recall in
lead runs and fast passages 0.08, holds 0.08, lanes 0.08, repetition 0.06. Ratios score 1 when
equal and 0 at a factor of two (log scale); shares score by their difference.

## Parameter search

Coordinate ascent over 60 settings, each with a few round values: density (base, peak, burst,
ceiling, curve, contrast, intense threshold, floor, max gap), the six layer weights, lead
sensitivity and run priority, secondary amount, grid strictness, finest grid, triplets, the
analyzer's lead sensitivity, minimum lead interval and layer sensitivity, six activity weights,
six section roles, holds (amount, short share, shortest, longest), chords, jacks, trills,
stairs, repeat lock and variation. Each evaluation is the mean composite over seeds 1-2 on one
half of the song (split on a bar line). Two passes; a change must gain at least 0.002.

**Overfitting guard**: fit on the first half and validate on the second, then the reverse. The
merged value per setting is the grid value nearest the mean of the two fits (unchanged when
neither fit moved it).

Round 1 (from the Phase 18 Hard preset):

| Fit on      | Score on fit half | Validation half: before | Validation half: after |
| ----------- | ----------------- | ----------------------- | ---------------------- |
| First half  | 0.747             | 0.671                   | 0.751                  |
| Second half | 0.829             | 0.658                   | 0.729                  |

Whole song, seeds 1-5: 0.658 before, 0.743 merged. Both halves agreed on a lower peak, the lead
weight at the bottom of its range, fewer and longer holds, a shortest hold of half a beat and
fewer trills.

Round 2 (from the round 1 values, wider ranges, the ceiling added):

| Fit on      | Score on fit half | Validation half: before | Validation half: after |
| ----------- | ----------------- | ----------------------- | ---------------------- |
| First half  | 0.795             | 0.784                   | 0.768                  |
| Second half | 0.824             | 0.717                   | 0.728                  |

The first-half fit got worse on the second half: round 2 starts to fit the song, not the style.
Only the change both halves made was kept (jacks 0.3 -> 0.75), plus the density both halves
moved toward (peak 5, burst 9, ceiling 16). A lead weight of 0.2, 0.35 and 0.5 score the same
(0.751); 0.7 and 1 lose about 4 points of F1, so the lead keeps 0.5.

| Setting                           | Phase 18 Hard                               | Phase 19 Hard                                |
| --------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Base / peak / burst / ceiling nps | 3 / 9 / 13 / 18                             | 2 / 5 / 9 / 16                               |
| Contrast                          | 0.5                                         | 0.4                                          |
| Finest grid                       | 1/32                                        | 1/16                                         |
| Lead runs / secondary / strict    | 0.7 / 0.45 / 0.5                            | 0.6 / 0.55 / 0.4                             |
| Holds: amount / short / shortest  | 0.6 / 0.4 / 0.25 beat                       | 0.5 / 0.2 / 0.5 beat                         |
| Jacks / trills / chord rate       | 0.3 / 0.5 / 0.45                            | 0.75 / 0.3 / 0.6                             |
| Layer weights (all difficulties)  | lead 1, snare 0.8                           | lead 0.5, snare 1                            |
| Section roles (all)               | intro 0.85, verse 0.95, drop 1.15           | intro 0.8, verse 0.8, drop 0.9               |
| Activity (all, also the analyzer) | lead 0.3, drums 0.18, leaps 0.1, punch 0.17 | lead 0.18, drums 0.3, leaps 0.18, punch 0.18 |
| Analyzer layer sensitivity        | 0.5                                         | 0.4                                          |

## Deriving the other difficulties

The rhythm priorities (layer weights, section roles, activity) are shared. The rest is scaled
from Hard, not fitted (comments next to the values in `src/studio/charting/presets.ts`):

- **Expert**: peak x1.5 and burst x1.55 (14: the burst cap is whole notes per beat, and 13.5
  rounds down to 3 at 220 BPM), base 3, ceiling 24 and a 1/32 grid, max gap half a beat, lead
  sensitivity 0.7, secondary 0.75, chords 0.7 at strength 0.55, shortest hold a quarter beat.
  **Lead runs at full resolution**: at lead-run priority 1 (new in Phase 19, `rhythm.ts`) run
  notes are exempt from the burst and bar caps (the ceiling still applies), get the finest grid
  instead of the phrase's, and each repeat keeps its own run onsets. Measured on the reference song:
  mean density 1.39x Hard, the 90th percentile of 4-beat windows 1.33x (one note more per
  window; 1.5x would be two), outside lead runs at most 4 notes per beat (Hard 3, 1.33x); the
  densest 4 beats 1.63x and the densest beat 1.67x come from lead runs charted note for note:
  85 % of the lead-run onsets (Hard 49 %, the reference 35 %), 95 % of the reference hits inside
  runs. Peak and burst inside runs are therefore above the 1.35-1.5x target by design.
- **Normal**: Hard's density x0.7 (calm parts x0.75), ceiling 10 (sixteenths only below about
  150 BPM), half the chord and jack tendency, one hold at a time.
- **Easy**: Hard's density x0.5 (calm x0.6), eighths at most (ceiling 5), a note at least every
  1.5 beats where there is sound, no jacks, few chords, holds of a beat or more.

## Results

<!-- calibration:begin (generated by npm run calibrate; edit outside these markers) -->

Reference: **Hard** chart of a 207 s song at 220 BPM, 1274 notes. Seeds 1-5, tolerance 35 ms.

### Results

| Metric                           | Reference (Hard) | Easy (mean of 5 seeds) | Normal (mean of 5 seeds) | Hard (mean of 5 seeds) | Expert (mean of 5 seeds) |
| -------------------------------- | ---------------- | ---------------------- | ------------------------ | ---------------------- | ------------------------ |
| Composite score                  | -                | 0.524                  | 0.696                    | 0.751                  | 0.677                    |
| Rhythm F1 (+/-35 ms)             | 100 %            | 59 %                   | 67 %                     | 69 %                   | 66 %                     |
| Precision                        | 100 %            | 85 %                   | 75 %                     | 67 %                   | 55 %                     |
| Recall                           | 100 %            | 45 %                   | 61 %                     | 71 %                   | 82 %                     |
| Mean nps (2-beat windows)        | 4.15             | 2.18                   | 3.39                     | 4.38                   | 6.10                     |
| Peak nps (densest 4 beats)       | 11.00            | 3.67                   | 5.50                     | 7.33                   | 11.92                    |
| 90th pct of 4-beat windows, nps  | 7.33             | 2.75                   | 4.58                     | 5.50                   | 7.33                     |
| Burst nps (densest beat)         | 25.67            | 7.33                   | 11.00                    | 11.00                  | 18.33                    |
| Density correlation              | 1.00             | 0.47                   | 0.49                     | 0.49                   | 0.51                     |
| Intense / calm density           | 1.50             | 1.11                   | 1.25                     | 1.25                   | 1.41                     |
| Calm minimum nps                 | 1.83             | 0.00                   | 0.00                     | 1.83                   | 1.83                     |
| Calm 10th pct nps                | -                | 0.00                   | 1.83                     | 1.83                   | 3.67                     |
| Empty where reference has notes  | 0 %              | 23 %                   | 4 %                      | 0 %                    | 0 %                      |
| Longest gap in intense parts, ms | 647              | 818                    | 546                      | 545                    | 409                      |
| Recall in lead runs              | 82 %             | 50 %                   | 68 %                     | 73 %                   | 95 %                     |
| Recall in fast passages          | 38 %             | 25 %                   | 25 %                     | 38 %                   | 38 %                     |
| Holds per minute                 | 85.5             | 54.8                   | 77.9                     | 80.0                   | 106.8                    |
| Short holds (< 1 beat)           | 43 %             | 0 %                    | 39 %                     | 46 %                   | 68 %                     |
| Average hold, ms                 | 411              | 435                    | 290                      | 270                    | 210                      |
| Layered holds                    | 26 %             | 1 %                    | 10 %                     | 25 %                   | 32 %                     |
| Chord rate                       | 39 %             | 2 %                    | 13 %                     | 37 %                   | 60 %                     |
| Jack rate                        | 20 %             | 0 %                    | 5 %                      | 17 %                   | 23 %                     |
| Trill rate                       | 30 %             | 45 %                   | 40 %                     | 43 %                   | 48 %                     |
| Stair rate                       | 19 %             | 18 %                   | 26 %                     | 23 %                   | 24 %                     |
| Left hand                        | 48 %             | 47 %                   | 50 %                     | 50 %                   | 50 %                     |
| Transition entropy, bits         | 3.79             | 2.41                   | 3.45                     | 3.53                   | 3.47                     |
| Repeat consistency               | 62 %             | 71 %                   | 59 %                     | 61 %                   | 78 %                     |

Expert over Hard (measured): mean 1.39x, 4-beat peak 1.63x, 4-beat 90th percentile 1.33x, one-beat burst 1.67x, chords 37 % -> 60 %, longest intense gap 545 -> 409 ms, lead-run recall 73 % -> 95 %.

Reference column: the lead-run and fast-passage rows show the share that lead onsets explain (the analyzer recall), not a generated recall.

### Composite score parts

| Score part         | Weight | Easy (mean of 5 seeds) | Normal (mean of 5 seeds) | Hard (mean of 5 seeds) | Expert (mean of 5 seeds) |
| ------------------ | ------ | ---------------------- | ------------------------ | ---------------------- | ------------------------ |
| rhythmF1           | 0.3    | 0.587                  | 0.673                    | 0.686                  | 0.658                    |
| densityCorrelation | 0.12   | 0.469                  | 0.487                    | 0.486                  | 0.513                    |
| meanDensity        | 0.08   | 0.070                  | 0.709                    | 0.920                  | 0.443                    |
| intenseCalm        | 0.08   | 0.557                  | 0.732                    | 0.736                  | 0.910                    |
| calmFloor          | 0.08   | 0.770                  | 0.962                    | 1.000                  | 1.000                    |
| intenseGap         | 0.04   | 0.662                  | 1.000                    | 1.000                  | 1.000                    |
| leadRuns           | 0.08   | 0.375                  | 0.466                    | 0.551                  | 0.665                    |
| holds              | 0.08   | 0.479                  | 0.741                    | 0.805                  | 0.521                    |
| lanes              | 0.08   | 0.444                  | 0.627                    | 0.837                  | 0.691                    |
| repetition         | 0.06   | 0.823                  | 0.939                    | 0.988                  | 0.668                    |

### Layer attribution

Reference hits (notes within 20 ms merged): 841. A clear candidate (strength 0.5+) within 25 ms explains 92 %; chance level (the reference shifted 3/8 of a beat) is 56 %. Any candidate within 35 ms: 99 %. Unexplained: 71 hits.

| Layer | Explains (strongest layer) | Clear onset at reference hits | Clear onset on the 1/8 grid | Lift |
| ----- | -------------------------- | ----------------------------- | --------------------------- | ---- |
| lead  | 20 %                       | 63 %                          | 46 %                        | 1.37 |
| snare | 17 %                       | 59 %                          | 41 %                        | 1.46 |
| kick  | 13 %                       | 41 %                          | 37 %                        | 1.11 |
| bass  | 14 %                       | 44 %                          | 34 %                        | 1.31 |
| hats  | 12 %                       | 45 %                          | 31 %                        | 1.46 |
| other | 15 %                       | 55 %                          | 39 %                        | 1.42 |

Detected lead runs: 12 runs with 68 lead onsets; the reference charts 35 % of those onsets, the generated chart 49 %. Reference hits inside runs: 22; lead onsets explain 82 %, any clear onset 95 %, generated notes 73 %.
Reference fast passages (4+ hits at most a third of a beat apart): 1 passages, 8 hits; lead onsets explain 38 %, any clear onset 50 %, generated notes 38 %.

### What the analyzer misses

| Context                       | Missed hits |
| ----------------------------- | ----------- |
| held lead note (no new onset) | 29          |
| bass / low end                | 22          |
| drums or percussion only      | 12          |
| lead note, onset not picked   | 5           |
| quiet passage                 | 2           |
| inside a lead run             | 1           |

| Where               | Hits | Section  | Context                       | Loudest band |
| ------------------- | ---- | -------- | ----------------------------- | ------------ |
| 00:00.996-00:01.439 | 5    | build-up | held lead note (no new onset) | lowMid       |
| 00:02.019-00:02.530 | 4    | build-up | held lead note (no new onset) | lowMid       |
| 00:03.706           | 1    | build-up | drums or percussion only      | high         |
| 00:05.309           | 1    | build-up | quiet passage                 | high         |
| 00:08.581           | 1    | build-up | held lead note (no new onset) | lowMid       |
| 00:13.473-00:14.019 | 3    | build-up | drums or percussion only      | lowMid       |
| 00:15.297           | 1    | build-up | held lead note (no new onset) | lowMid       |
| 00:17.905           | 1    | build-up | held lead note (no new onset) | lowMid       |
| 00:18.945           | 1    | build-up | held lead note (no new onset) | lowMid       |
| 00:28.201           | 1    | build-up | lead note, onset not picked   | lowMid       |
| 00:32.019           | 1    | build-up | held lead note (no new onset) | high         |
| 00:34.064           | 1    | build-up | held lead note (no new onset) | lowMid       |
| 00:34.985-00:35.701 | 4    | verse    | lead note, onset not picked   | sub          |
| 00:36.962-00:37.167 | 2    | verse    | drums or percussion only      | high         |
| 00:37.763           | 1    | verse    | bass / low end                | low          |
| 00:38.598           | 1    | verse    | bass / low end                | sub          |
| 00:42.229           | 1    | verse    | bass / low end                | low          |
| 00:46.508-00:46.780 | 2    | verse    | bass / low end                | sub          |
| 00:48.689           | 1    | verse    | bass / low end                | low          |
| 00:50.462-00:50.888 | 3    | verse    | bass / low end                | sub          |
| 00:51.689           | 1    | verse    | bass / low end                | sub          |
| 00:53.309           | 1    | verse    | drums or percussion only      | highMid      |
| 01:00.417           | 1    | verse    | bass / low end                | sub          |
| 01:03.519-01:03.655 | 2    | verse    | held lead note (no new onset) | sub          |
| 01:06.144-01:06.417 | 2    | verse    | bass / low end                | sub          |
| 01:07.883           | 1    | verse    | held lead note (no new onset) | sub          |
| 01:09.144           | 1    | verse    | bass / low end                | sub          |
| 01:11.973-01:12.383 | 3    | verse    | bass / low end                | sub          |
| 01:16.354           | 1    | drop     | quiet passage                 | low          |
| 01:17.598           | 1    | drop     | held lead note (no new onset) | low          |
| 01:28.780           | 1    | drop     | bass / low end                | low          |
| 01:29.735           | 1    | drop     | bass / low end                | sub          |
| 01:30.962           | 1    | drop     | bass / low end                | low          |
| 01:31.951-01:32.479 | 2    | drop     | held lead note (no new onset) | sub          |
| 01:34.644           | 1    | drop     | bass / low end                | low          |
| 02:01.201           | 1    | drop     | held lead note (no new onset) | high         |
| 02:08.292           | 1    | build-up | bass / low end                | sub          |
| 02:12.655           | 1    | drop     | drums or percussion only      | high         |
| 02:17.019           | 1    | drop     | held lead note (no new onset) | high         |
| 02:19.013           | 1    | drop     | drums or percussion only      | high         |

(10 smaller groups not listed.)

<!-- calibration:end -->

## What the analyzer still misses, and why

- **Stylised rolls**: the opening of the reference is a 32nd-note roll (34 ms apart) where the
  audio has lead onsets at other times; no analyzer setting recovers it (minimum lead interval
  25-40 ms and lead sensitivity 0.6-0.7 were tried). Charter's choice, not an analyzer fault.
- **Sustained lead and sub-bass**: most remaining misses sit inside a held lead note or on
  sub-bass with no new attack (808-style slides in the verse); clear onsets of any layer lie
  30-50 ms away. The analyzer settings in the search (layer and lead sensitivity, minimum lead
  interval) did not fix them; lead band edges and HPSS settings change the cached features and
  were not searched. No clear single cause, so the analyzer was left as it is.
- **The lead onset track is noisy**: many lead onsets come 34 ms apart (double triggers around
  one attack), so the lead is a weak spine on this song (lift 1.37 against snare 1.46). The lead
  runs themselves are reliable: lead onsets explain 82 % of the reference hits inside them.
- **Density correlation stays near 0.5**: 2-beat windows hold about two hits each at this
  density, and the hand chart's density follows choices (call and response, emphasis) that
  activity does not see.

## Caveats

- One song, one charter, one difficulty: the fit says what this charter does on this song. The
  defaults stay round and conservative, and changes only one half supported were not kept.
- The composite weights are a judgement; F1 dominates, so a sparser chart that hits the right
  moments scores better than a denser one with more recall.
- Phase 13 numbers (recorded reference, pattern generator) are in the git history of this file.
