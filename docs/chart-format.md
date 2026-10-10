# Chart format

The canonical rules are in `CLAUDE.md`. This page records the parser's behaviour where the
spec left room for choice. Source: `src/core/parseChart.ts`.

## Field details (version 2)

| Field            | Type    | Rule enforced by `parseChart`                                   |
| ---------------- | ------- | --------------------------------------------------------------- |
| `version`        | integer | Required, 1 or 2. Newer than supported -> error. 1 -> migrated. |
| `title`          | string  | Required, must not be blank                                     |
| `artist`         | string  | Required, may be empty                                          |
| `audio`          | string  | Required, may be empty (informational filename)                 |
| `bpm`            | number  | Required, > 0 and <= 1000, fractional allowed (e.g. 128.5)      |
| `offsetMs`       | integer | Required, may be negative (beat 0 before the audio starts)      |
| `previewStartMs` | integer | Required, >= 0                                                  |
| `startMs`        | integer | Optional (v2), -30000..0. Absent = automatic start (below)      |
| `difficulty`     | string  | Required, must not be blank; free text (e.g. "Normal")          |
| `level`          | integer | Required, 1–20                                                  |
| `charter`        | string  | Required, may be empty                                          |
| `notes`          | array   | Required, may be empty                                          |

Notes:

- `t`: integer >= -30000 (negative = before the audio begins; song time 0 is the first sample of
  the audio). `lane`: integer 0–3. `type`: `"tap"` or `"hold"`.
- `hold` requires integer `dur` >= 50. A `tap` with a `dur` field is an error.
- Overlap: a note in the same lane may start at `t + dur + 1` at the earliest after a hold, and
  two notes in the same lane may not share a `t`.
- Unknown fields are ignored and dropped from the parsed chart (so newer optional fields don't
  break older readers within the same version).
- All problems are reported at once, each as a complete sentence naming the note
  (`Note #3 (notes[2])`, 1-based number plus array index).

## Song time, game start and lead-in (version 2)

- Song time 0 is when the audio begins. Notes may sit up to 30 s before it (`MIN_NOTE_TIME_MS`).
- `startMs` is the song time at which a play from the beginning starts. A negative value is a
  silent lead-in: the notes scroll in and the audio begins at 0. There is never a countdown.
- **Effective start** (`effectiveStartMs` in `src/core/chart.ts`): `startMs` when present,
  otherwise `min(0, firstNoteTimeMs - 1500)` (`AUTO_START_LEAD_MS`), and 0 for a chart with no
  notes. Early notes stay fair without a countdown; songs with a quiet intro start at 0 at once.
- A custom start may be later than the first note (the player then sees it already scrolling).

## Version 1 and the migration

Version 1 had no `startMs` and no negative note times. `MIGRATIONS[1]` upgrades a v1 chart in
memory with no change in meaning: a negative `t` in a v1 file is still an error (the message says
to set `version` to 2), and a stray `startMs` in a v1 file is dropped, so v1 charts always start
automatically. Saved and exported charts are always written as version 2.

## Serialising

`serializeChart(chart)` writes pretty-printed JSON with notes sorted by `t`, then `lane`, a stable
key order, `startMs` only when the chart has a custom start, and always the current `version`.

## Changing the format

1. Bump `CHART_VERSION` in `src/core/chart.ts` and update the `Chart` type.
2. Add `MIGRATIONS[oldVersion] = (raw) => upgradedRaw` (or an error sentence) in
   `src/core/parseChart.ts`.
3. Add tests that load an old-format fixture and check the migrated result.
4. Update `CLAUDE.md` and this page.

## Song library

Imported songs live in IndexedDB (`pixel-beat-library`, see `src/library/db.ts`; the name predates
the rename to ataraxia and is kept so existing libraries keep loading):

- `songs`: id (UUID), title, artist, audio (the original file as a Blob), audioFileName,
  durationMs, bpm, offsetMs, previewStartMs, cover and coverThumb (version 3, see below),
  createdAt, updatedAt (epoch ms).
- `charts`: id (UUID), songId (indexed as `bySong`), difficulty, level, charter, notes,
  startMs (number, or null / missing for automatic; charts saved before format 2 have none),
  createdAt, updatedAt. No schema upgrade was needed for it.
- `scores` (version 2): one personal best per chart, keyed by `chartId` (songId indexed as
  `bySong`): score, accuracy, rank, maxCombo, fullCombo, allPerfect, achievedAt. A play replaces
  it only with a strictly higher score. Deleting a chart or song deletes its best. The demo chart
  (`builtin:demo:normal`) has a best too. Editing a chart keeps its best. Upgrading from version
  1 only adds this store; songs and charts are untouched.
- Covers (version 3): `cover` is a 512x512 picture and `coverThumb` its 128x128 thumbnail, both
  Blobs (WebP, or PNG where the browser can't encode WebP), both set or both null. Null means the
  generated placeholder is shown. The upgrade from version 2 gives every existing song
  `cover: null, coverThumb: null` and changes nothing else (charts and scores untouched).
- `analyses` (version 4): the cached audio analysis per song.
- Backgrounds (version 5): songs get `background` (a background config, or null for the default)
  and `backgroundImage` (the song's one background picture: WebP, at most 1920x1080 and 3 MB, or
  null). Phase 20 changed the config to version 2 (base, effects, overlays) without a database
  upgrade: version 1 configs are migrated when read and written as version 2 on the next save.
  The upgrade sets both to null on every existing song and changes nothing else. A new
  `playerAssets` store keeps the player's own pictures by fixed id (`background`: the custom
  background of Settings -> Display). See `docs/backgrounds.md`.
- Background pictures and sprites (version 7, Phase 21): songs get `backgroundImages` (up to
  eight `{ id, blob }` pictures; the config's `base.imageId` names the one shown, the first when
  unset) and `particleSprites` (up to eight `{ id, name, blob }` PNGs of at most 64x64 and 256 KB).
  The upgrade moves `backgroundImage` into the list as `image-1`, removes the old field and adds
  an empty sprite list; nothing else changes. Configs are version 3 (base, baked adjustments,
  emitters); older ones are migrated when read.

### Cover images

`src/library/cover.ts` turns a picture into a cover: PNG, JPEG, WebP, GIF (first frame) or AVIF
(where the browser decodes it), at most 25 MB. It is decoded with `createImageBitmap`, cropped
to a square (the crop dialog's square, else the centred one; maths in `src/core/coverCrop.ts`),
shrunk to 512 through halving steps with high-quality smoothing (no aliasing), encoded as WebP
(quality 0.9; PNG fallback), and the 128 px thumbnail is made from the 512 image. Files that are
too large, of another type or that fail to decode are refused with a message. Menus show covers
through object URLs cached by cover key (song id + updatedAt) in small LRU caches
(`src/ui/coverImages.ts`); evicted or forgotten URLs are revoked after a grace period.

Song-level fields of the chart format (`title`, `artist`, `audio`, `bpm`, `offsetMs`,
`previewStartMs`) belong to the song and are shared by all its charts; exporting a chart fills
them in from the song (`toChartFile` in `src/library/records.ts`). Schema changes bump
`LIBRARY_DB_VERSION` and add an `if (oldVersion < N)` step to `upgrade`.

- Importing a chart `.json` into a song: the song's **first** chart also sets the song's title,
  artist, BPM, offset and preview start. Later charts keep the song's values (the player is told
  if the BPM/offset differ).
- Difficulty names are kept unique per song: a second "Normal" becomes "Normal 2".
- The built-in demo song is not stored; it is listed first and is read-only.

## Song packages (.zip)

Written and read by `src/library/songPackage.ts`:

```
song.json          {"format": "ataraxia-song", "version": 5, "title", "artist",
                    "audio": "<audio file name>", "cover": "cover.webp",
                    "bpm", "offsetMs", "previewStartMs",
                    "background": {background config},
                    "backgroundImages": [{"id", "file": "backgrounds/<id>.webp"}],
                    "particleSprites": [{"id", "name", "file": "sprites/<id>.png"}]}
<audio file>       the original audio file, stored uncompressed
cover.webp         the song's 512x512 cover, stored uncompressed (cover.png when the
                   cover is PNG); only when the song has a cover
backgrounds/<id>.webp  the song's background pictures (or .png), stored uncompressed
sprites/<id>.png   the song's custom particle sprites, stored uncompressed
charts/<Difficulty>.json   one standard chart file per chart
```

- Version 5 writes the background config as version 3 (base, baked adjustments, emitters; see
  `docs/backgrounds.md`) with up to eight pictures and eight custom sprites. Version 3-4
  packages import with their config migrated and their one `backgroundImage` as the first
  picture. A sprite that is missing, over 256 KB or not a PNG only produces a warning.
- Version 4 wrote the background config as version 2 (base, effects, overlays).
- Version 3 adds the optional background: `background` is the config (version 1: style, params,
  blur, pixel match, beat pulse) and `backgroundImage` names its picture. Older packages import with the
  default background. An unknown config, or a picture that is missing, empty, over 8 MB, damaged
  or not a picture, only produces a warning; a fitting WebP/PNG is stored as it is, anything else
  is processed like an upload. Audio analyses are not packaged: they are computed on first play.

- Version 2 adds the optional cover; `cover` is absent without one. Version 1 packages (no
  cover) import unchanged.
- The cover never blocks an import: if song.json names a cover that is missing, empty, larger
  than 5 MB, damaged, not a PNG/JPEG/WebP/GIF/AVIF picture (checked by signature) or not
  decodable, the song is imported without a cover and a warning is shown. A 512x512 WebP/PNG
  cover is stored as it is; any other picture is processed like an upload.

- Import is all-or-nothing: `song.json`, every chart (via `parseChart`) and the audio (decoded
  once) are validated before anything is written, then the song and charts are written in one
  transaction with new ids.
- `song.json` is the authority for song-level fields; those fields in chart files are ignored.
  `startMs` is per chart and travels in the chart files. Older packages (version 1 chart files)
  import unchanged and start automatically.
- `format` is informational and not checked: packages written before the rename say
  `"pixel-beat-song"` and import the same way.
- Importing packages is available in the player and Studio; exporting them is Studio only.
- Accepted leniently: a package zipped inside one top-level folder, a missing `format`/`version`
  (treated as version 1), a missing `audio` field when exactly one other top-level file exists,
  and `__MACOSX/` or `.DS_Store` entries (ignored).
- Limits checked before decompressing: audio 300 MB, each chart 10 MB, 100 charts.
