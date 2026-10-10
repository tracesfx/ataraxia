# Architecture: Player and Studio

ataraxia is built from one codebase in two flavours:

| Build      | Command                                     | Output         | Contents                                                                         |
| ---------- | ------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| **Player** | `npm run build` (dev: `npm run dev:player`) | `dist/`        | Play, practice, settings, calibration, results, song package import, delete song |
| **Studio** | `npm run build:studio` (dev: `npm run dev`) | `dist-studio/` | Everything in the player, plus Studio home and the chart editor                  |

The player build is what gets released to other people. It has no chart creation or editing UI,
and the code for those tools is not in its bundle.

**This is not copy protection.** The player build simply leaves the editing UI and code out.
Charts and audio are still ordinary data in the browser (IndexedDB), song packages are plain
.zip files, and anyone can build the Studio from source. Nothing is encrypted or locked.

## The build flag

`vite.config.ts` defines the compile-time constant `__STUDIO__` (declared in `src/env.d.ts`):

- `true` for `vite` (the default dev server) and `vite build --mode studio`;
- `false` for `vite --mode player` and `vite build` (the default build).

Vite replaces `__STUDIO__` with a literal before bundling, so `if (__STUDIO__) { ... }` becomes
`if (false) { ... }` in the player build and the minifier removes it together with anything only
it references. The browser title follows the flag too: `ataraxia` or `ataraxia studio`.

## How the Studio is loaded

```
src/main.ts
  if (__STUDIO__) {
    const { installStudio } = await import('./app/studio-entry');   // only door into src/studio
    installStudio(app);
  }

src/app/studio-entry.ts   ->  export { installStudio } from '../studio'
src/studio/index.ts       ->  registers the 'studio' (Studio home) and 'editor' scenes
```

In the player build the dynamic import is dead code, so no Studio chunk is emitted at all (the
editor's Web Workers and stylesheet included). In the Studio build the Studio is a separate
lazily loaded chunk.

### Rules

1. **Nothing outside `src/studio` imports from `src/studio`**, except `src/app/studio-entry.ts`.
   ESLint enforces this (`no-restricted-imports` in `eslint.config.js`).
2. `src/app/studio-entry.ts` is only ever imported dynamically, inside `if (__STUDIO__)`.
3. Shared code that has a Studio-only extra (the results screen's Edit chart button, the F3 debug
   overlay, the Studio main menu entry) guards it with `if (__STUDIO__)` / `__STUDIO__ ? ... : ...`
   right where it is used, so the player build drops it.
4. Studio-only scene ids (`studio`, `editor`) are declared in `src/ui/scenes.ts` with plain-data
   params, so shared code can name them (a playtest returns to them) without importing Studio
   types. They are only registered in the Studio build.
5. `npm run verify:player-build` builds the player and fails if `dist/` contains a Studio marker
   (`STUDIO_MARKER` in `src/studio/index.ts`, `EDITOR_HELP_MARKER` in the editor's help text),
   editor fingerprints (editor and background editor class names and UI text), or worker files
   other than the shared audio analysis and background bake workers.

## What lives where

| Path                      | Shared or Studio | Contents                                                                                        |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `src/core`                | shared           | Pure logic (chart format, timing, judgement, scoring, settings, charting assistance maths)      |
| `src/audio`               | shared           | `AudioEngine`, `PreviewPlayer`, `AudioAnalyzer` and its worker (backgrounds and the editor)     |
| `src/game`                | shared           | Game scene, lane input, demo song                                                               |
| `src/render`, `src/skins` | shared           | Pixel canvas, the internal skin, renderers, animated backgrounds (`src/render/background`)      |
| `src/library`             | shared           | IndexedDB data layer; `SongLibrary` (catalog, loading, scores, package import, delete song)     |
| `src/ui`                  | shared           | Scene manager, design system (`theme.ts`, `pixel/`, `components.ts`), menus, song browser       |
| `src/app/studio-entry.ts` | door             | The one import of `src/studio`                                                                  |
| `src/studio`              | Studio           | `installStudio`, Studio home, `StudioLibrary`, note generator (`charting/`), editor (`editor/`) |

`src/core` modules used only by the editor (onsets, tempo, the audio analysis, note editing, undo)
stay in `src/core` because they are pure and tested there; the bundler leaves them out of the
player build because nothing in it imports them. The audio analysis (`src/core/analysis`) is
there also because the background particles use it in the player: `AudioAnalyzer` (`src/audio`)
runs it in a worker on a song's first play and caches it. Backgrounds are shown in both builds
(their base picture is baked by a shared worker, `src/render/background/bakeWorker.ts`); only the
Studio edits them (`src/studio/backgroundDialog.ts`, the sprite editor
`src/studio/spriteEditor.ts`). The note generator
(`src/studio/charting`) is pure too but only ever needed for authoring, so it lives in the
Studio.

`StudioLibrary` adds the authoring operations (import audio and chart JSON; new, duplicate and
delete charts; edit song and chart metadata; export chart and song package) on top of
`SongLibrary`'s public building blocks (`requireRepo`, `requireSong`, `requireChart`, `decode`,
`remember`). Both work on the same IndexedDB database, so songs made in the Studio show up in the
player on the same browser and origin.

## Screens

```
Main menu ── Play ──────> Song select ──> Game (play | practice) ──> Results (Retry / Back)
          ├─ Settings ──> Settings ──> Calibration
          └─ Studio ────> Studio home ──> Editor ──> Game (playtest) ──> back to Editor
             (Studio            └──────> Game (playtest) ──> back to Studio home
              build only)
```

- Song select (both builds): song list, chart selection, play, practice toggle, best scores,
  import song package (.zip, picker or drop), delete song (with confirmation), settings.
- Studio home (Studio only): see `docs/editor.md`.

## Game modes

`GameParams.mode` (`src/ui/scenes.ts`) is explicit:

| Mode       | Started from              | Saves a best score    | Ends with                                     |
| ---------- | ------------------------- | --------------------- | --------------------------------------------- |
| `play`     | Song select               | Yes (full plays only) | Results screen                                |
| `practice` | Song select (practice on) | No                    | Loops until the player quits                  |
| `playtest` | Editor or Studio home     | No                    | Short in-game summary, then back (`returnTo`) |

In the player build the results screen has only Retry and Back, and the F3 debug overlay (and its
settings toggle) does not exist.

## Storage names

The IndexedDB database (`pixel-beat-library`) and the localStorage keys (`pixel-beat.settings`,
`pixel-beat:editor-prefs`) keep their pre-rename names so existing songs, scores and settings are
not orphaned. New keys use the `ataraxia.` prefix.
