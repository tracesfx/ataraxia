# ataraxia

An original 4-key rhythm game for the browser. Notes scroll down to a hit line; play them with
**S D J K** (rebindable in Settings). Everything runs locally; no server or account.

It comes in two builds from one codebase:

- **Player** (`npm run build`, output in `dist/`): play, practice, settings and calibration, best
  scores, and importing song packages (.zip). No chart creation or editing.
- **Studio** (`npm run dev`, or `npm run build:studio` with output in `dist-studio/`): everything
  in the Player, plus audio import, the chart editor, chart and package export, and playtesting.

```sh
npm install
npm run dev                  # Studio, with hot reload
npm run dev:player           # the player build, with hot reload
npm run build                # player build (dist/)
npm run verify:player-build  # build the player and check it contains no Studio code
```

The split leaves the editing UI and code out of the player build. It is not copy protection.

See [CLAUDE.md](CLAUDE.md) for the rules and roadmap and
[docs/architecture.md](docs/architecture.md) for how the two builds work.

Showcase video: https://www.youtube.com/watch?v=-Fn40HK3BT0
