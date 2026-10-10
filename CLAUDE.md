# ataraxia — project guide

## Overview

An original 4-lane vertical-scrolling rhythm game that runs entirely in the browser. Notes
scroll down to a hit line; the player hits them with **S D J K** (default). Pixel-art visuals,
tap and hold notes, judgements **Perfect / Great / Good / Miss**, animated backgrounds that react
to the music. No backend, no accounts, no
story mode: everything is stored locally (IndexedDB + localStorage).

Two builds from one codebase (see `docs/architecture.md`): the **Player** (released to others:
play, practice, settings, song package import) and the **Studio** (everything in the Player plus
audio import, chart creation, the chart editor, exports and playtesting).

The name is **ataraxia**, always lowercase wherever it is shown. It lives in **one constant**:
`GAME_TITLE` in `src/core/constants.ts` (`STUDIO_TITLE` is "ataraxia studio"; the `<title>`
in `index.html` is injected at build time). The logo (pixel wordmark + "gem on still water"
mark) is drawn in code by `src/ui/pixel/logo.ts`; the favicons in `public/` are generated from it
with `npm run icons`. The menus' design system is described in `docs/design.md`.

This is an original game. Never copy sprites, names, music or other assets from existing games,
and never name other games in code, comments or docs.

Storage names predate the rename and must never change (that would orphan saved data): the
IndexedDB database `pixel-beat-library` and the localStorage keys `pixel-beat.settings` and
`pixel-beat:editor-prefs`. New keys use the `ataraxia.` prefix.

## Stack (decided — do not deviate)

- TypeScript (strict), Vite, Vitest
- Canvas 2D for gameplay and editor rendering; plain DOM/CSS for menus and settings (wearing
  generated pixel-art sprites, see `docs/design.md`)
- Web Audio API for all audio and timing
- IndexedDB via `idb` for songs and charts; localStorage for small settings
- `fflate` for song packages (.zip); `fake-indexeddb` (dev) for repository tests
- `music-metadata` (Studio only, lazy-loaded) for tags and artwork of imported audio
- `mpg123-decoder` (dev only) to decode the local calibration reference for
  `scripts/calibrate-charting.mjs` and the calibration tests (never shipped)
- `audio-decode` (dev only) to decode any audio file for `npm run analyze` and `npm run calibrate`
  (never shipped)
- ESLint (typescript-eslint strict) + Prettier
- Minimal dependencies: no UI framework, no game engine

## Commands

| Command                                | What it does                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`                          | Vite dev server with HMR, **Studio enabled**                                 |
| `npm run dev:player`                   | Dev server as the player build (no Studio)                                   |
| `npm run build`                        | Typecheck, then the **player** build to `dist/` (no Studio code)             |
| `npm run build:studio`                 | Typecheck, then the Studio build to `dist-studio/`                           |
| `npm run verify:player-build`          | Build the player and fail if any Studio marker or editor code is in it       |
| `npm run preview`                      | Serve the player build (`preview:studio` for the Studio build)               |
| `npm test`                             | Run unit tests once (`npm run test:watch`)                                   |
| `npm run typecheck`                    | `tsc --noEmit`                                                               |
| `npm run lint`                         | ESLint                                                                       |
| `npm run format`                       | Prettier write                                                               |
| `npm run icons`                        | Regenerate the favicons in `public/` from the logo mark                      |
| `npm run screenshots`                  | Playwright: every screen, the editor and backgrounds (`--backgrounds`)       |
| `npm run calibrate -- --audio --chart` | Dev only: Phase 19 calibration against a hand chart (`--tune`, `--all`)      |
| `node scripts/calibrate-charting.mjs`  | Dev only: older Phase 18 density report against `reference/` (`--sweep`)     |
| `npm run analyze -- "<audio file>"`    | Dev only: print the Studio's ChartAnalysis summary (`--bpm --offset --json`) |

Before finishing any task: `npm run typecheck && npm run lint && npm test && npm run build &&
npm run build:studio && npm run verify:player-build`.

## Architecture rules (non-negotiable)

1. **All gameplay timing derives from the audio clock** (`AudioContext.currentTime`). Never use
   frame counts, `setTimeout`, or `Date.now()` for gameplay time. Note positions are recomputed
   from song time every frame. Song time 0 is the first audio sample and song time may be
   negative (`SongClock` in `src/core/songClock.ts`); the audio is started in the future on the
   audio clock, never by a timer. There is no countdown.
2. **Pure logic lives in `src/core`** with no DOM or Web Audio imports, and is unit tested: chart
   types, validation, time/beat/snap math, judgement, scoring, background maths. (ESLint forbids
   common browser globals in `src/core`.)
3. **Rendering is separate from logic.** Visuals come from a swappable skin.
4. **The game and the editor share one chart format** (below). Version 2 is single-BPM. Any
   format change must bump `version` and include a migration so old charts keep loading.
5. **Scenes** (menu, song select, game, settings, calibration, results; Studio home and editor in
   the Studio build) are managed by a small scene
   manager with enter/exit hooks. Exiting a scene must clean up its listeners, audio nodes, and
   animation frames.
6. **Keyboard input is handled when the event arrives**, using `event.timeStamp`, not by
   polling each frame.
7. **Studio isolation.** Everything for creating or editing content (editor, audio import, chart
   create/duplicate/delete, chart JSON import/export, song package export, note suggestions,
   playtest launcher, metadata editing, the background editor and sprite editor) lives in `src/studio`. **Never import `src/studio` from
   player code**: the only door is `src/app/studio-entry.ts`, imported dynamically by
   `src/main.ts` inside `if (__STUDIO__)`. ESLint (`no-restricted-imports`) enforces it.
8. **Build flag.** `__STUDIO__` (Vite `define`, typed in `src/env.d.ts`) is true in `npm run dev`
   and `build:studio`, false in `dev:player` and `build`. Studio-only extras in shared code
   (results "Edit chart", F3 debug overlay, the "Studio" menu entry) sit behind `__STUDIO__` so
   the player build drops them. The Play flow (song select, game, results) never shows editing
   actions. `npm run verify:player-build` must pass.
9. **Game modes** are explicit: `GameParams.mode` is `play` | `practice` | `playtest`. Only `play`
   saves scores; `playtest` returns to the editor or Studio home.
10. **Key labels come from the bindings.** Never hardcode lane key letters in UI or help text;
    use `laneKeysLabel(app.settings.value.laneKeys)` / `keyLabel`.

The Player/Studio split removes the editing UI and code from the player build. It is **not** copy
protection: charts and audio stay ordinary local data, and anyone can build the Studio.

## Chart format v2

```json
{
  "version": 2,
  "title": "My Song",
  "artist": "Someone",
  "audio": "song.ogg",
  "bpm": 150,
  "offsetMs": 320,
  "previewStartMs": 30000,
  "startMs": -2000,
  "difficulty": "Normal",
  "level": 7,
  "charter": "Me",
  "notes": [
    { "t": 1200, "lane": 0, "type": "tap" },
    { "t": 1600, "lane": 2, "type": "hold", "dur": 400 }
  ]
}
```

Rules:

- `t` and `dur` are integer milliseconds of song time. Song time 0 is when the audio begins;
  `t` may be negative, down to -30000.
- `offsetMs` is the time of beat 0 (used for the editor's beat grid and snapping).
- `lane` is an integer 0–3.
- Hold notes require `dur` >= 50.
- Notes must be sorted by `t` then `lane`.
- No two notes in the same lane may overlap in time (a hold occupies `[t, t+dur]`, inclusive).
- `audio` is informational (the original filename).
- `level` is 1–20.
- `startMs` (optional) is an integer in [-30000, 0]: the song time at which play from the
  beginning starts (negative = silent lead-in). Absent: the effective start is
  `min(0, firstNoteTimeMs - 1500)` (0 with no notes), see `effectiveStartMs()`.
- `parseChart` accepts v1 (migrated in memory, no change in meaning) and v2; everything is
  written as v2.

Implementation choices beyond the spec are documented in `docs/chart-format.md`. Validation:
`parseChart()` in `src/core/parseChart.ts`. Migrations: the `MIGRATIONS` table in the same file.

## Folder map

| Path                | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core`          | Pure logic + tests: chart types, `parseChart`, time/beat/snap math, beat grid, timeline pixel/time mapping and editor span, smooth scrolling and zoom (`editorScroll`), minimap note density (`noteDensity`), editor lane size (`laneScale`), tap tempo, waveform peaks, judgement, scoring, play session, clocks (`SongClock`), play range and run plan, note editing (`noteEdit`), undo history, settings sanitising (`settings`), calibration maths, results (rank/badges/histogram), practice loop, FFT, onset detection (`onsets`), tempo estimation (`tempo`), audio analysis for charting and backgrounds (`analysis/`: 50 Hz features, intensity, build-ups, impacts, silences), background maths (`background/`: config v3 and migration, particle emitters and templates, closed-form particles, sprite library, base picture bake, beat, analysis sampling and travel, palette, readability clamp, quality, precedence), seeded random (`random`), frame pacing (`framePacing`), cover crop maths (`coverCrop`), synthetic test signals |
| `src/audio`         | `AudioEngine`: context, clock, decoding, playback, scheduled clicks; `PreviewPlayer` (song-select preview); `AudioAnalyzer` + `analysisWorker` (shared: backgrounds and the editor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/game`          | Gameplay scene, lane input, play settings, background loader (`gameBackground.ts`), DOM HUD parts (`gameHud.ts`: message panel, practice panel), built-in demo song/chart (`demo/`), dev-only autoplay and stress chart (`dev/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/render`        | Pixel canvas and scale selection (`pixelScale`), field layout and scroll mapping (`fieldLayout`), the `Skin` interface, the gameplay renderer, glyph atlases (`glyphAtlas`, `glyphMask`), timing particles, animation curves, debug overlay, gameplay backgrounds (`background/`: Canvas 2D `BackgroundManager` with one cached base bitmap and particles, bake worker, sprite atlas, picture helpers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/studio`        | Studio only (see `docs/architecture.md`): `index.ts` (`installStudio`, `STUDIO_MARKER`), Studio home scene, `StudioLibrary` (authoring operations), background editor (`backgroundDialog.ts`) and sprite editor (`spriteEditor.ts`), `charting/` (Phase 18 seeded note generator: settings and presets, density plan, rhythm selection and repetition lock, holds, beam-search lanes, stats and decision log, calibration, Phase 19 chart diff `compare.ts` and calibration metrics `calibrationMetrics.ts`; see `docs/charting.md`), `charting/analysis/` (ChartAnalysis, Phase 17: STFT features, HPSS, per-layer onsets, lead notes and runs, activity, bar structure; worker + IndexedDB cache; see `docs/charting.md`), `editor/` (below)                                                                                                                                                                                                                                                                                                     |
| `src/studio/editor` | Chart editor: `EditorState` (all editor state, no DOM), scene, widgets (`editorUi`), keymap, pointer tools, note renderer, side panel, timeline/minimap renderers, metronome/hit sounds, chart I/O, shortcuts, autosave, waveform worker, audio analysis worker + charting assistance (`assistPanel`: Detect BPM; `suggestPanel`: Suggest with ghost notes, grouped settings, presets, history, stats and the density-plan overlay), the analysis viewer (`analysisView`, `analysisTracks`: tracks beside the lanes, inspector, Analysis panel), the compare overlay (`comparePanel`); see `docs/editor.md`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/library`       | IndexedDB schema (`db.ts`, v4 adds the per-song `analyses` cache, v5 backgrounds and `playerAssets`, v6 the Studio's `chartAnalyses` cache, v7 several background pictures and custom sprites per song), `LibraryRepository`, records + validation, `.zip` packages, `SongLibrary` (player operations, analysis cache), cover, background picture and custom sprite processing (`cover.ts`, `backgroundImage.ts`, `particleSprite.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/ui`            | Scene manager, DOM screens (main menu, song select, settings, calibration, results), shared song browser, settings store + panel, modal dialogs, file picking/downloads; design system: `theme.ts` (tokens), `components.ts`, `backdrop.ts`, `keyHints.ts`, `songSearch.ts`, `pixel/` (pixel grid, materials, sprites, generated CSS, icons, logo, rank letters, covers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/skins/default` | Built-in skin: colours from the theme tokens, procedurally generated palette-only sprites (`sprites.ts`), the 5x7 particle digits, static gradient background                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/app`           | `studio-entry.ts`: the only module allowed to import `src/studio`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/`             | `architecture.md` (Player/Studio), `design.md` (design system: menus and gameplay canvas), `gameplay.md` (timing, judgement, score), `skinning.md` (the internal Skin interface; skins deferred), `backgrounds.md` (base, baked adjustments, particles and sprites, rendering, readability, storage), `editor.md`, `charting.md` (note suggestions), `charting-calibration.md`, `chart-format.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Key files: `src/main.ts` (boot), `src/ui/sceneManager.ts`, `src/ui/scenes.ts` (scene ids and
params), `src/render/pixelCanvas.ts`, `src/render/pixelScale.ts`, `src/audio/audioEngine.ts`
(song clock), `src/core/playSession.ts` (gameplay rules), `src/game/gameScene.ts`,
`src/core/songClock.ts` (audio time -> song time), `src/render/gameFrame.ts` (renderer interface), `src/render/gameRenderer.ts` (draws gameplay
from the skin), `src/render/fieldLayout.ts` (layout, scroll mapping), `src/render/skin.ts` (Skin
interface), `src/skins/default/index.ts` (builds the default skin), `src/render/glyphAtlas.ts`
(text), `src/render/timingParticles.ts`, `src/render/animation.ts` (effect curves),
`src/library/songLibrary.ts` (`app.library`: catalog incl. the read-only demo, decode cache,
package import, delete song, best scores), `src/studio/studioLibrary.ts` (Studio authoring ops),
`src/ui/songBrowser.ts` (song list shared by song select and Studio home), `src/ui/settingsStore.ts` (`app.settings`: the one settings object
the game, editor and calibration read), `src/core/settings.ts`, `src/ui/settingsPanel.ts`,
`src/ui/calibrationScene.ts`, `src/ui/resultsScene.ts`, `src/core/results.ts`, `src/core/practice.ts`, `src/library/repository.ts` (typed IndexedDB access), `src/library/songPackage.ts`,
`src/ui/songSelectScene.ts`, `src/ui/modal.ts`, `src/ui/theme.ts`, `src/ui/components.ts`,
`src/ui/pixel/sprites.ts`, `src/ui/pixel/skinCss.ts`, `src/ui/pixel/scale.ts`, `src/ui/backdrop.ts`,
`src/game/pauseOverlay.ts`, `src/studio/studioHomeScene.ts`,
`src/studio/editor/editorScene.ts`, `src/studio/editor/editorState.ts`, `src/core/noteEdit.ts`, `src/core/undoHistory.ts`, `src/core/onsets.ts`,
`src/core/tempo.ts`, `src/core/analysis/` (`analyze.ts`, `describe.ts`), `src/studio/charting/generate.ts`,
`src/studio/charting/rhythm.ts`, `src/studio/charting/lanes.ts`, `src/studio/charting/presets.ts`, `src/audio/audioAnalysis.ts`,
`src/core/background/` (`config.ts`, `emitter.ts`, `particles.ts`, `sprites.ts`, `bake.ts`, `precedence.ts`), `src/render/background/manager.ts`, `src/render/background/bakeJob.ts`,
`src/game/gameBackground.ts`, `src/studio/backgroundDialog.ts`,
`src/studio/editor/assistPanel.ts`, `src/studio/editor/suggestPanel.ts`. Song library and package format: `docs/chart-format.md`.
Player/Studio split: `docs/architecture.md`.

## Code conventions

- Strict TypeScript; no `any`, no non-null assertions outside tests. Prefer narrow union types.
- Use `import type` for type-only imports (`verbatimModuleSyntax`).
- Times are milliseconds (`ms`) unless the name says otherwise (`timeSec`, `beat`). Name units in
  identifiers: `offsetMs`, `durMs`, `songTimeMs`.
- Pure functions in `src/core`; anything touching DOM, canvas, audio, or storage lives outside it.
- Tests sit next to the code as `*.test.ts`. Every `src/core` change ships with tests.
- User-facing error messages are complete sentences that say what is wrong and how to fix it.
- Scenes register **all** listeners, frame loops and cleanup through their `SceneScope`
  (`scope.listen`, `scope.everyFrame`, `scope.onDispose`) — never bare `addEventListener` or
  `requestAnimationFrame` in a scene.
- The chart editor's timeline and minimap draw at native resolution (`NativeCanvas`), not on the
  pixel grid, with flat colours from the ramps, 1-device-pixel lines, Inter labels and muted grid
  colours from `src/studio/editor/editorTheme.ts`; notes come from the skin at a whole number of
  device pixels per sprite pixel (`core/laneScale.ts`). Its DOM uses the design system
  (`docs/design.md`, "Chart editor"); styles in `src/studio/editor/editor.css` (Studio bundle
  only). The view is a smoothed copy of the state's playhead and zoom (`core/editorScroll.ts`).
- Gameplay canvas: draw at the logical resolution (`PixelCanvas.width`/`height`, about 540 rows,
  `PIXEL_TARGET_HEIGHT`; it changes with the window) into `PixelCanvas.ctx` with integer
  coordinates, then call `present()` once per frame. Layout comes from `computeFieldLayout`;
  colours, sprites and fonts from the skin (theme tokens), never literals. No allocations,
  `shadowBlur` or filters in the frame loop.
- Menus: build them from `src/ui/components.ts`; sizes in art pixels (`calc(var(--px) * n)`),
  colours from the theme tokens (CSS custom properties), new art as sprites in
  `src/ui/pixel/sprites.ts` + `SKIN_RULES`. Pixel font (Jersey 10) for labels, Inter for prose,
  sentence case, nothing from the banned list in `docs/design.md`. Studio-only icons go in
  `src/studio/studioIcons.ts`.
- Gameplay canvas text goes through the skin's glyph fonts (`skin.fonts`, Jersey 10 atlases), on
  whole pixels with a 1px shadow; numbers through code buffers (`glyphMask.ts`), not strings.
- New gameplay sprites: add the field to `SkinSprites`, generate it in
  `src/skins/default/sprites.ts` from theme ramps (palette-only, tested), and list it in
  `docs/skinning.md`.
- Dev-only tools in shared code sit behind `import.meta.env.DEV` (`?autoplay`, `?stress`), so
  production builds drop them.
- Chart generation is seeded: everything random on the generation path (`src/core/analysis`,
  `src/studio/charting`) comes from one `Rng` (`src/core/random.ts`); `Math.random` is banned
  there by ESLint and a test.
- Formatting is Prettier's job (single quotes, trailing commas, width 100).
- Keep dependencies minimal; justify any new one.

## Roadmap

### Phase 0 — Foundation

- [x] Tooling: Vite, TypeScript strict, Vitest, ESLint, Prettier
- [x] Chart types + `parseChart` with validation and migration hook
- [x] Time helpers: `msToBeat`, `beatToMs`, `snapToGrid` (divisions 1,2,3,4,6,8,12,16)
- [x] Pixel canvas: 480x270, integer scaling, letterboxing, high-DPI, test pattern
- [x] Scene manager with automatic cleanup + placeholder Main Menu

### Phase 1 — Core gameplay

- [x] `AudioEngine`: AudioContext lifecycle, decode, play/pause/seek, song clock
- [x] Map `event.timeStamp` to audio time (via `getOutputTimestamp`/`performance.now()`)
- [x] Judgement windows (Perfect/Great/Good/Miss) in `src/core` + tests
- [x] Scoring and combo in `src/core` + tests
- [x] Hold note logic (head judgement, release, tail) + tests
- [x] Input: configurable keys (default D F J K; S D J K since phase 7), handled on keydown/keyup
- [x] Gameplay scene: scrolling notes from song time, hit line, judgement display
- [x] Scroll speed setting (`PlaySettings.scrollSpeed`; UI in phase 5)
- [x] Built-in original demo chart + audio for testing

### Phase 2 — Pixel art skin

- [x] Skin format (`skin.json` + optional PNGs, per-sprite fallback) and loader
- [x] Default skin: lanes, notes, hold bodies, receptors, hit effects, judgement text
- [x] Bitmap font for HUD (rasterised to a 1-bit atlas; Jersey 10 since Phase 11)
- [x] Background and menu art (original); menu + song select restyle

### Phase 3 — Song library + import

- [x] IndexedDB schema (songs, charts, audio blobs) via `idb`, with versioned upgrades
- [x] Import audio files (drag-and-drop + file picker)
- [x] Import/export charts (`.json`) and song packages (audio + charts)
- [x] Song select screen with audio preview from `previewStartMs`
- [x] Delete/rename songs and charts
- [x] Game scene loads any library chart; `startTimeMs` param for "playtest from here"

### Phase 4 — Chart editor

Part 1 — editor shell (done):

- [x] Waveform/timeline view with beat grid from `bpm`/`offsetMs`, overview strip, zoom
- [x] Playback (50/75/100 % speed) with metronome clicks scheduled on the audio clock
- [x] Metadata panel (title, artist, BPM, offset, difficulty, level, charter) with autosave
- [x] BPM/offset helpers (nudge buttons, "set beat 0 here", tap tempo)

Part 2 — note editing (done):

- [x] Place/delete tap and hold notes with snapping (note tool, select tool, mirror, nudge)
- [x] Undo/redo (command pattern, grouped steps), selection, copy/paste
- [x] Live recording, hit sounds, stats strip, `?` shortcut overlay
- [x] Validation with `parseChart` before every save/export; playtest from the playhead
- [x] Autosave of notes, chart import/export, song package export

### Phase 5 — Settings, calibration, practice, results

- [x] Settings screen (keys, scroll speed, volume, offsets) saved to localStorage
- [x] Audio/visual offset calibration
- [x] Practice mode: playback rate, loop section, start from position
- [x] Results screen: score, accuracy, judgement counts, max combo, local best scores

### Phase 6 — Charting assistance (editor)

- [x] Audio analysis in a Web Worker with progress: spectral-flux onsets (`core/onsets.ts`)
- [x] Detect BPM: autocorrelation + grid fit, offset from grid phase, confidence, x2 and /2
      alternatives; Apply/Dismiss, one undo step (`core/tempo.ts`)
- [x] Suggest notes: difficulty presets, density, A-B/selection range, lane pattern rules,
      jumps, holds on sustained sounds; one undo step, selected (replaced by Phase 13)
- [x] Unit tests with synthetic click tracks, silence and noise; limitations in `docs/editor.md`

### Phase 7 — Studio/Player split

- [x] Rename to "ataraxia" (lowercase everywhere; storage names kept), SVG wordmark and favicon
- [x] Default keys S D J K; settings v2 migration (old defaults D F J K move, custom kept); all
      key hints read the bindings
- [x] `src/studio` (editor, Studio home, `StudioLibrary`) behind `__STUDIO__`, loaded only via
      `src/app/studio-entry.ts`; ESLint import ban; `verify:player-build`
- [x] Player song select (play, practice, scores, package import, delete song); Studio home
      (import, metadata, charts, editor, exports, playtest); explicit game modes
- [x] `docs/architecture.md`; housekeeping before public release

### Phase 8 — Time model

- [x] Chart v2, start offset, no countdown

### Phase 9 — Design system and menus

- [x] Tokens (`theme.ts`: steel/accent/semantic ramps, AA-checked text), pixel grid with UI scale
      setting (settings v3), generated steel/glass/accent sprites as CSS 9-slices, icons
- [x] Components, pixel logo + generated favicons, Jersey 10 + Inter (`docs/design.md`)
- [x] Redesigned main menu, song select (search, covers, ambient backdrop), settings (two-pane,
      Display category), calibration, results, pause overlay and toasts, modals, Studio home table
- [x] `npm run screenshots` (Playwright), `THIRD_PARTY_NOTICES.md`

### Phase 10 — Covers

- [x] Custom covers (512 px WebP + 128 px thumbnail per song, DB v3), `src/library/cover.ts`
      processing, Studio cover tools and crop dialog, audio tags via lazy `music-metadata`,
      covers in every screen, package format 2 with `cover.webp`

### Phase 11 — Gameplay visuals

- [x] Window-filling pixel grid near 540 rows (`PIXEL_TARGET_HEIGHT`), layout in logical pixels,
      scroll speed 3.5 = 660 ms to the hit line at any size
- [x] `Skin` interface with a procedural default skin from the theme tokens (glass field, steel
      rails and deck, two-hue notes, holds, receptors, beams, hit effects), static
      `BackgroundLayer`; Jersey 10 glyph atlases (Press Start 2P removed)
- [x] HUD: song card, score and accuracy, bottom progress bar with practice markers; DOM message
      and practice panels; cursor hiding; Effects setting (Full / Minimal)
- [x] Timing particles (settings v4: toggle, threshold presets or custom, size); dev `?autoplay`
      and `?stress`; gameplay screenshots at 1080p, 4K and 1366x768

### Phase 12 — Editor revamp

- [x] Smooth, continuous scrolling: target vs displayed time, frame-rate independent smoothing,
      wheel normalisation (constant pixels per notch), fine scroll, animated zoom around the
      pointer, gliding key steps, "Snap on scroll stop", invert scroll (`core/editorScroll.ts`)
- [x] Pixel design system layout: top bar, tool rail, collapsible side panel (Timing, Selection,
      Chart info, Stats, Suggest), transport bar with snap segments, minimap with a note density
      strip (`core/noteDensity.ts`), tooltips with shortcuts, quick-start card, `?` cheat sheet
- [x] Timeline canvas in the pixel style; notes from the skin at an integer lane size
      (`core/laneScale.ts`); start flag; keymap extracted and tested; editor screenshots

### Phase 13 — Note suggestions v2

- [x] Audio analysis (`src/core/analysis`, worker, IndexedDB cache per song, DB v4): 50 Hz RMS,
      bands, per-band flux, brightness, song-relative intensity, build-ups, impacts, silences
- [x] Seeded, intensity-aware generator (`src/studio/charting`): S-curve density, impact /
      rhythmic / minor onsets, streams, breathing gaps, caps, guaranteed contrast, difficulty
      presets, data-driven pattern library with ergonomics and repeated phrases
- [x] Suggest panel: seed (dice, same seed), contrast, streams, variety, pattern types, range,
      replace, ghost notes with Accept (one undo step) / Discard, before/after nps preview,
      intensity and impact overlay on the minimap and timeline
- [x] Calibration against a recorded reference (`scripts/calibrate-charting.mjs`,
      `docs/charting-calibration.md`); `docs/charting.md`
- [x] Gameplay frame rate setting (settings v5: match display, caps 30-480, unlimited)

### Phase 14 — Skins (skipped, deferred)

- Skipped (deferred): no skin loading, import or settings. Only the internal `Skin` interface and
  the default skin remain (`docs/skinning.md`).

### Phase 15 — Animated backgrounds

- [x] `src/core/background` (pure, tested): config, beat phase and pulse envelope (negative time,
      playback speed), analysis sampling and travel integral, intensity curves, palette from the
      cover (median cut snapped to the theme ramps), readability (dim + exact lane luminance
      clamp), adaptive quality, `suggestBackground` rules, precedence
- [x] `src/render/background`: pulse, particles, ripples, aurora, spectrum, image / cover
      (blur once, ken burns, pixel match or full-resolution underlay), none; `BackgroundManager`
      as the renderer's `BackgroundLayer`, the static gradient as fallback; analysis computed in a
      worker on first play (player too) and cached
- [x] DB v5 (song background + picture, `playerAssets`), package v3, settings v6 (Display:
      background mode, dim, reactivity, reduce motion, quality, custom image); Studio background
      dialog with suggestions and live previews; `docs/backgrounds.md`; `--backgrounds`
      screenshots

### Phases 16-25

Phases 16-25: 16 accept bar, 17 analyzer v2 + viewer, 18 generator v3, 19 calibration + compare
overlay, 20 backgrounds v2, 21 backgrounds simplified, 22 gameplay feel, 23 rank emblems + note
styles, 24 editor tour, 25 release prep. The old plan's Phase 21 "background cues" (timestamped
background changes) is **cancelled**; it was never built.

- [x] 16 Accept bar: floating Accept (Enter) / Discard (Esc) / New seed (G) bar with a preview
      summary over the editor's lanes, "Preview ready" toast, generated range on the minimap
- [x] 17 Analyzer v2 + viewer: ChartAnalysis in `src/studio/charting/analysis` (worker, DB v6
      cache, HPSS, six onset layers with local thresholds, lead pitch track, notes and runs,
      activity, repeat groups and sections), editor Analysis view (V): tracks, onset ticks,
      inspector, panel with similarity matrix, live sliders and JSON export; `npm run analyze`
- [x] 18 Generator v3: rhythm-first, continuous, section-aware generator on the ChartAnalysis
      (density plan, lead-first spine per phrase with one grid, repetition lock, holds incl.
      short and layered, one beam-search lane optimisation, gap and floor rules); pattern
      library removed; Suggest panel with grouped settings, my presets, live preview, last five
      generations, measured stats, decision log on hover, rejected candidates in the viewer
- [x] 19 Calibration + compare overlay: `npm run calibrate` (rhythm F1, layer attribution with
      chance level and lift, density, holds, lanes, repetition, composite score; parameter search
      fitted on one half and validated on the other), Hard fitted and Expert / Normal / Easy
      scaled from it, full-resolution lead runs at Expert; editor "Compare chart" overlay in the
      Suggest panel (matched / missing / extra markers, P/R/F1 whole and on screen, rhythm only, C)
- [x] 20 Backgrounds v2: Phase 15 styles removed; `BackgroundConfig` v2 = base (one picture per
      song, cover or none; fit, dim, ken burns, pixel match) + 12 effects with music bindings
      (beat, downbeat, kick, snare, lead, low, activity) + spectrum and particle overlays (closed
      form), migrated from v1; five ready-made looks with suggestions; one WebGL2 pass behind the
      pixel canvas (mips only for blur and bloom, lane clamp after effects) with a 2D fallback;
      flash limit (3/s), Reduce flashing, Reduce motion; settings v7 (Cover only, Background
      effects / overlays, Reduce flashing), package v4; Studio background editor with live preview
- ~~21 (old plan) Background cues: timestamped background changes~~ (cancelled, never built)
- [x] 21 Backgrounds simplified: looks, suggestions, the WebGL2 pass and every music-bound effect
      removed (pulse, spectrum, ripples, flashes, ken burns, CRT, glitch, ...); `BackgroundConfig`
      v3 = static base (up to 8 pictures per song, cover blurred, solid colour, none; fit, pixel
      match, dim, lane clamp) + blur / exposure / saturation / chromatic aberration / bloom baked
      once in a worker into one cached bitmap + up to 4 particle emitters (closed form, 600-cap
      pool, 24 library sprites, custom PNG sprites, glow, trails, parallax, beat / downbeat /
      impact bursts, activity reactivity, 4 templates); Studio editor with emitter groups and a
      pixel sprite editor; DB v7, package v5, settings v8; Canvas 2D renderer
- [x] 22 Gameplay feel: one 2-pixel judgement line (receptors, deck, key beams and hit effects
      removed), translucent glass below the line, lane glow on press (held at its peak while the
      key is down, strength setting), metallic outlined text (`GlyphFont.drawStyled`, `METAL_RAMPS`), combo colour tiers
      with rainbow, a 45-degree shine at random intervals from 50 and sparkles, larger 7-digit score in a glass panel with a
      roll-up and judged / total notes, a larger song card,
      lowercase judgements at the label size; settings v9 (Lane glow, Combo colors, HUD size,
      Judgement style); dev `?combo=N`; `npm run screenshots -- --feel`
- [ ] 23 Rank emblems + note styles; defined by its own prompt
- [ ] 24 Editor tour; defined by its own prompt
- [ ] 25 Release prep; defined by its own prompt

### Later

- [ ] Autoplay mode (for chart previews and testing)
- [ ] Optional gameplay assists (e.g. auto-hold) clearly marked on results
