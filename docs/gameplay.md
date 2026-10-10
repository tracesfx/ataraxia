# Gameplay rules and timing

Source of truth for the rules: `src/core/playSession.ts`, `src/core/judgement.ts`,
`src/core/scoring.ts` (all unit tested). This page records the decisions behind them.

## Clocks

- **Song time** (ms) is derived only from the audio clock. `AudioEngine` maps audio time to song
  time with a `SongClock` (`src/core/songClock.ts`, pure and unit tested: start, seek, pause,
  resume, playback rate; song time may be negative), and reads the time of the sample
  currently being **heard** (`getOutputTimestamp()`, falling back to
  `currentTime - baseLatency - outputLatency`). Visuals and input therefore line up with what the
  player hears, not with what the audio thread renders ahead.
- **Input**: key events are handled on arrival. `event.timeStamp` (performance-time ms) is mapped
  to audio time through a smoothed `(performance.now(), heard audio time)` reference pair
  (`ClockSync`, sampled every frame), then to song time. Frame rate does not affect judgement.
- **Pause** suspends the `AudioContext`, freezing the audio and the song clock together; the
  SongClock is paused and resumed at the frozen audio time, so the mapping does not move.
- **Negative song time**: the clock may start before 0. The audio source is then started _in the
  future_ on the audio clock (`source.start(when, 0)`, `when` being the audio time of song time
  0, from `SongClock.audioStart`), so the music begins sample-accurately with no timers.
  Scheduled clicks (editor metronome and hit sounds) use the same mapping and work before 0.
- **No countdown.** A play from the beginning starts at the chart's effective start
  (`effectiveStartMs`, see `docs/chart-format.md`): if it is negative the notes scroll in
  silently and the audio begins at 0. Every note is judged.
- **Start point** (`GameParams.startTimeMs`, for "playtest from here"; may be negative): the
  clock starts the **Run-in time** setting earlier (default 1.5 s, `runPlan` in
  `src/core/playRange.ts`) and the music plays during the run-in wherever song time is past 0.
  Notes whose head is before the start point are left out of play and scoring entirely, including
  holds that would still be sounding (`notesFromStart`).

## Player offset and calibration

- `audioOffsetMs` (settings, -300..+300) is **subtracted from every input time** before judging:
  a player who consistently hits 30 ms late sets +30. Game, editor live recording and the
  calibration fine-tune all apply it the same way (`inputLatencyOffsetMs`). Visuals are not shifted.
- Calibration (`src/core/calibration.ts`): 4 lead-in clicks then 20 counted clicks at 120 BPM,
  scheduled on the audio clock. Result = median of (tap - nearest counted click), ignoring taps
  more than 150 ms from every click; fewer than 12 valid taps gives "not enough consistent taps".
  The spread shown is the standard deviation. Raw tap times are used (no offset applied), so the
  result _is_ the offset to save.
- Fine-tune: a looping 32-beat run with a click per note, judged with the current offset;
  Left/Right (or -/+) nudge the offset by 1 ms and save it immediately.

## Settings

Stored in localStorage (`pixel-beat.settings`; the key predates the rename to ataraxia and is kept
so saved settings survive) as a versioned object (`version: 4`), sanitised on load by
`sanitizeSettings` in `src/core/settings.ts`: each missing/invalid field falls back to its
default; old versions are migrated step by step; a newer version gives the defaults.

Default lane keys are **S D J K** (`DEFAULT_LANE_KEYS`). Version 2 changed them from D F J K: the
v1 -> v2 migration switches saved bindings that exactly equal D F J K to the new defaults and
keeps customised bindings. Every help text that names keys reads the bindings (`laneKeysLabel`).
Scroll speed is stored in the friendly unit 1.0-10.0. The default 3.5 takes about 660 ms from the
top of the screen to the hit line at any window size, and other values scale proportionally
(`scrollPxPerMs` in `src/render/fieldLayout.ts`: px/ms = hitLineY / 660 x speed / 3.5). (Before
Phase 11 the field was 270 rows and 3.5 meant 0.35 px/ms, about 617 ms to the hit line.) In a song, **F2 / F4** step it by 0.1. F3 toggles the timing debug overlay in the Studio build
only; the player build has no debug overlay. Lane keys can't be Esc, Enter,
Tab, F-keys, modifiers or Caps Lock, and no key can be bound to two lanes.

Version 3 -> 4 added **Effects** (Full / Minimal; since Phase 22 Minimal softens the lane glow,
drops the combo bump, shine and rainbow animation, and shows judgements in the
simple style) and the **timing particles**: on a judged press (tap or hold head) with
an absolute error at or above the threshold, a number rises from the lane at the hit line ("+60" late,
"-34" early, the debug overlay's sign convention), falls with gravity, drifts left when early and
right when late, and fades out in 4 steps over 700 ms. Early is orange and late purple (a pair that
stays distinct for common colour-vision deficiencies). Threshold presets: All hits (0 ms), Beyond
Perfect (over 40 ms, default), Beyond Great (over 80 ms), or a custom 0-120 ms; sizes small /
medium / large. Notes never pressed (misses) show none. The pool holds at most 24 particles and
reuses the oldest (`src/render/timingParticles.ts`).

## Pause, results, practice

- **Pause** (Esc): Resume, Restart, Settings (an in-game overlay; calibration needs the full
  settings screen), Quit. Resume waits the **Resume delay** setting (Off, 0.5, 1 (default), 2 or
  3 s) with the audio clock still suspended, shown as a shrinking bar (no numbers), then resumes
  the context, so song time continues exactly where it stopped. Esc during the delay goes back to
  the menu.
- **Results** (`src/core/results.ts`): rank by accuracy S >= 95, A >= 90, B >= 80, C >= 70, else D.
  FULL COMBO = no Miss and no dropped hold; ALL PERFECT = every note Perfect. Early/late counts
  include non-Perfect hits only (what the in-game indicator shows). Histogram: 24 bins of 10 ms
  over [-120, +120] (bin i is `[min + 10i, min + 10i + 10)`, +120 in the last bin), from every
  press error (taps and hold heads); the marker is the mean error. Only full plays of stored
  charts in `play` mode are saved as bests (not practice, not playtests, not mid-song starts).
  The game scene's `mode` (`play` | `practice` | `playtest`) decides this; see
  `docs/architecture.md`. The player build's results screen offers Retry and Back only.
- **Practice** (`src/core/practice.ts`): speed 50-100 % in 5 % steps (the song clock runs at the
  same rate, so song time stays in song ms). `[` / `]` set A / B at the current song time, `\`
  clears. A run with a loop contains only the notes whose head is in [A, B]; it restarts at
  max(B, end of the last loop hold) + 120 ms, with a run-in of the **Run-in time** setting in real
  time (run-in x rate of song time) during which the music plays in. Marks may be set before 0.
  Without a loop, the whole song repeats from the effective start. Practice never shows results
  and never saves.

## Judgement

| Grade   | Absolute error (inclusive) | Score weight |
| ------- | -------------------------- | ------------ |
| Perfect | <= 40 ms                   | 100%         |
| Great   | <= 80 ms                   | 70%          |
| Good    | <= 120 ms                  | 40%          |
| Miss    | otherwise / never hit      | 0%           |

- Error = press time - note time; negative is early. Fractional errors are not rounded
  (40.5 ms is Great).
- A press targets the **earliest pending note in that lane within 120 ms**. Presses with no
  note in range do nothing (no penalty, no combo break).
- A note is auto-missed once song time is **strictly greater** than `t + 120`.

## Holds

- The head is judged like a tap and adds +1 combo immediately.
- Holding until `t + dur` completes it automatically. Releasing at `>= t + dur - 120` also
  completes it. Final judgement = head judgement.
- Releasing earlier **drops** it: combo resets, final judgement = the worse of the head and Good.
  Dropped holds count under Good in the judgement counts and show "DROPPED".
- A missed head misses the whole hold; the body cannot be picked up later.
- If the key is released while paused or the window loses focus, the hold is released at the
  song time where play stopped.

## Score

- `score = floor(points * 1,000,000 / (notes * 100))` where `points` sums integer weights
  (100/70/40/0). All Perfect is exactly 1,000,000; anything less can never round up to it.
- A hold counts as one note. Its final judgement (and score) is recorded when it completes,
  drops or is missed.
- Accuracy = points / (judged notes * 100), shown as a percentage of the notes judged so far.
- Combo: +1 for each tap hit and each hold head hit; reset by a Miss or a dropped hold.

## Demo song

`src/game/demo/`: `demoChart.ts` builds the chart (120 BPM, 30 bars, sections: intro, single
taps, alternating 8ths, jumps, holds, stream, mix, finale). `demoSong.ts` renders the audio with
an `OfflineAudioContext` (kick on every beat, off-beat hats, snare on 2 and 4, 8th-note bass, and a
lead line with one note per chart note, sustained over holds). Two things learned the hard way:

- Do not use `DynamicsCompressorNode` in the render: Chrome's compressor delays output by a 6 ms
  look-ahead, shifting every sound late against the chart.
- Create voices just in time (`OfflineAudioContext.suspend()` per 2 s chunk) and share one
  filter per instrument; building ~1000 nodes up front made the render more than 10x slower.
