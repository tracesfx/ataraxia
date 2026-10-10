# Gameplay backgrounds

Phase 21 cut backgrounds down to a small, cheap model: **a static base with a few adjustments
baked into it once, and up to four particle emitters**, the only animated part. Everything is drawn
with Canvas 2D on one canvas behind the playfield. The player build shows backgrounds; only the
Studio edits them.

```
BackgroundConfig = { version: 3, base, effects, emitters }     src/core/background/config.ts
```

There are no looks, no suggestions, no music-bound shader effects, no spectrum and no timed
changes: a background never flashes, zooms or switches during a song.

## Base

| Field        | Values                            | Notes                                                       |
| ------------ | --------------------------------- | ----------------------------------------------------------- |
| `kind`       | `image`, `cover`, `solid`, `none` | One of the song's pictures, its cover, a colour, or nothing |
| `imageId`    | a picture id, or null             | Which picture `image` shows (null or unknown: the first)    |
| `color`      | `#rrggbb`                         | For `solid`                                                 |
| `fit`        | `cover`, `contain`                | Fill the screen, or show the whole picture on near-black    |
| `dim`        | 0-0.9 (default 0.55)              | Dark layer over everything                                  |
| `pixelMatch` | on (default) / off                | Render at the pixel grid (scaled up crisply) or the screen  |

A song keeps up to **eight** background pictures (separate from its cover), processed as before:
at most 25 MB in, fitted to 1920x1080, WebP (PNG where the browser can't), at most 3 MB stored.
`none` (and every missing picture) is a near-black neutral with a subtle vignette.

## Baked adjustments

`effects` holds five adjustments, applied **once** to the base at the background's render size in
a worker (`core/background/bake.ts`, run by `render/background/bakeJob.ts`), in this order:

| Adjustment           | Range                                  | How                                                   |
| -------------------- | -------------------------------------- | ----------------------------------------------------- |
| Blur                 | 0-40 px at 1080p                       | Three box passes each way (a Gaussian), linear light  |
| Exposure             | -1 to +1 stops                         | Linear-light gain                                     |
| Saturation           | 0-200 %                                | Around the pixel's luminance                          |
| Chromatic aberration | 0-12 px at 1080p; radial or horizontal | Red and blue sampled apart (bilinear), green stays    |
| Bloom                | intensity 0-2, threshold, radius       | Soft-knee bright pass, chain of smooth halvings (each |
|                      |                                        | softened), upsampled and added back                   |

The cover base is always blurred at least 16 px (`COVER_MIN_BLUR`). A bake is debounced (140 ms
after the last change once a baked picture exists) and the latest request wins; meanwhile the
unbaked picture shows with the strictest lane clamp. A solid colour goes through the same pipeline
(exposure and saturation change it). Nothing in the bake runs per frame: no CSS filters, no
`shadowBlur`, no per-frame `ImageData`.

## Particles

Each emitter (`EmitterConfig`, `core/background/emitter.ts`) has its own sprite, colours, motion
and emission:

| Group            | Parameters                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Sprite           | library sprite or `custom:<id>`; scaling (whole pixels or any size); smallest / largest size    |
| Emission         | continuous, burst on every beat, on downbeats, or on impacts and drops; count; life min / max;  |
|                  | reacts to music (0-1: activity scales count, speed and size); seed (Randomize)                  |
| Spawn and motion | full screen, edges, centre, horizontal band, ring; up, down, left, right, outward, inward,      |
|                  | random drift; speed min / max; gravity; sway amplitude and frequency                            |
| Colour and fade  | one colour, gradient over lifetime, random from a palette (1-5), from the base picture, theme   |
|                  | accent; opacity; opacity curve (fade, constant, pulse on the beat); size curve (constant, grow, |
|                  | shrink, pulse); flicker                                                                         |
| Rotation         | none, fixed angle, random, along the motion; spin                                               |
| Depth            | 1-3 parallax layers; each deeper layer multiplies size, speed and opacity                       |
| Glow and trail   | glow (a pre-rendered additive halo); trail (0-6 stepped afterimages, spacing); snap to pixels   |

Sizes and speeds are in pixels of the ~540-row gameplay grid. "Edges" means the particles enter
from the side they move away from (rising embers start below the screen); with outward, inward or
drift they enter from any side.

**Closed form.** `particleState` (`core/background/particles.ts`) computes every particle from the
emitter's seed, the song's seed and song time: a continuous particle runs through fixed life cycles
(each cycle gets new seeded randoms; its clock blends song seconds with the analysis' travel
integral by `reactivity`), and burst emitters evaluate the events of the last `lifeMax` seconds
(beat grid from the chart's BPM and offset, or the analysis' impacts). Nothing is integrated frame
to frame, so seeking, pausing, loops and practice speed changes always show the same particles for
the same song time. Bursts are automatic; nobody places them.

**Pools.** One `Float32Array` holds every particle of the frame (8 floats each, trails included);
the cap is 600 at High (400 Medium, 200 Low). No allocation per frame.

**Readability.** Particles fade out over 28 grid pixels before the columns behind the lanes, so
nothing bright crosses the notes; the base's lane clamp stays exact.

### Sprites

The library (`core/background/sprites.ts`) has 24 original pixel sprites made from palette
bitmaps, 5x5 to 16x16, white-based with three luminance levels so they tint cleanly: square,
diamond, cross, plus, circle, ring, triangle, 4-point star, 5-point star, sparkle, heart, music
note, snowflake, petal, leaf, bubble, ember, dust, raindrop, streak, arrow, bolt, hexagon, spark.
Round ones are drawn from distance functions. Directional sprites point up.

**Custom sprites** are PNGs of at most 64x64 and 256 KB, up to eight per song, stored with the song
(`particleSprites`) and in packages. The Studio adds them by importing a PNG or drawing one in the
**sprite editor** (16x16 or 32x32 grid; draw, erase, flood fill, eyedropper; mirror; a palette of
white levels and theme colours plus any colour; undo / redo; previews at 1x, 2x and 4x on dark and
light; import and export PNG; Save to this song).

**Rendering.** `render/background/spriteAtlas.ts` tints each emitter's sprite once per colour
(multiply, then the sprite's alpha) and, for glowing emitters, builds a glow variant by blurring
the sprite's alpha on the CPU once. Each frame draws glows first with additive compositing, then
the sprites; whole-pixel scaling turns smoothing off.

### Templates

**Add emitter** starts from an inline template (there is no preset management): Drifting dust,
Rising embers, Falling petals, Beat sparks, or a blank emitter. A fresh song has no particles.

## Rendering

`BackgroundManager` (`render/background/manager.ts`) implements the renderer's `BackgroundLayer`:

1. The base is fitted to the render size (cover / contain, smooth halving downscale), baked in the
   worker, then the dim and the lane clamp are drawn over it into **one cached bitmap**.
2. Each frame copies that bitmap and draws the particles. Without particles nothing is redrawn at
   all (the canvas only changes when something changes), so a static background costs about one
   `drawImage` when it changes and nothing otherwise.

Render size: the pixel grid with pixel match (scaled up crisply), else the screen, times the
quality's render scale. In the game the canvas sits behind the pixel canvas
(`PixelCanvas.attachBackdrop`); in Studio previews it is copied into the preview's context.

## Readability

1. **Dim**: the song's dim, shifted by the player's Dim setting (55 % leaves it as it is).
2. **Lane clamp**: over the columns behind the lanes (field, rails and 2 px), an extra dark layer
   just strong enough that the brightest colour of the baked base there ends up at most relative
   luminance 0.045 (about `steel[4]`, `readabilityLayers`). The bake reports that brightest colour,
   so exposure and bloom are accounted for.
3. Particles fade out before those columns.

## Quality

| Preset | Render scale | Particles at once |
| ------ | ------------ | ----------------- |
| High   | 1            | 600               |
| Medium | 0.75         | 400               |
| Low    | 0.5          | 200               |

`AdaptiveQuality` steps down one preset when, over 90 frames, drawing the particles costs more than
3 ms or frames are slow while particles are drawn. It never steps back up during a song.

## Precedence

`resolveBackground` (`precedence.ts`), from Settings → Display → Background:

1. **Off**: base none, no particles.
2. **Custom image**: the player's own picture as the base (the song's adjustments and particles
   kept).
3. **Cover only**: the song's cover as the base (adjustments and particles kept).
4. **Use the song's background** (default): the config made in the Studio; without one, the cover
   with no adjustments and no particles.

A missing picture falls back image → cover → none. The player also has **Dim**, **Reduce motion**
(hides the particles; also on with the system's `prefers-reduced-motion`) and **Background
quality**.

## Studio

Song details → **Background** (`B`) opens the editor: a live 16:9 preview that loops 8 seconds of
the song from a position slider (silent; the analysis drives impact bursts and activity), the base
(kind, a gallery of up to eight pictures with add and remove, colour, fit, dim, pixel match), the
picture adjustments (collapsible, with reset), the emitters (on/off, name, duplicate, remove,
collapsible groups with tooltips and a reset each, Randomize seed) and the custom sprites (import
PNG, draw a sprite, edit, remove). Save stores the config, pictures and sprites; Reset goes back to
the default.

## Storage, migration and packages

- **IndexedDB version 7**: songs carry `backgroundImages` (`{ id, blob }[]`) and `particleSprites`
  (`{ id, name, blob }[]`). The upgrade moves the one `backgroundImage` into the list as
  `image-1` (configs with no `imageId` show the first picture, so it keeps showing) and adds an
  empty sprite list; nothing else changes.
- **Config version 2 → 3** (`sanitizeBackgroundConfig`, when read): kept are the base (image /
  cover / none, fit, pixel match, dim), Blur (its amount x 24 px), Exposure (its amount in stops),
  Saturation (1 + amount x (target − 1)) and the particles overlay as emitter 1 with equivalent
  settings (shape → square / circle / streak, count, size, speed, direction, gravity, colour,
  opacity, reactivity). Everything else (slow zoom, the other effects and their bindings, the
  spectrum) is dropped. Version 1 configs go straight to version 3 the same way (the particles
  style becomes emitter 1).
- **Song packages version 5**: `song.json` lists `backgroundImages` (`{ id, file }`, files in
  `backgrounds/`) and `particleSprites` (`{ id, name, file }`, PNGs in `sprites/`). Version 3-4
  packages (one `backgroundImage`) still import: their picture becomes `image-1` and their config
  is migrated. Problems with pictures or sprites only warn.
- **Settings version 8**: the reactivity, reduce flashing, effects and overlays settings are gone.

## Reviewing

`npm run screenshots -- --backgrounds` captures, at 1920x1080 on the demo song over a bright
picture: the plain picture, each adjustment alone and all together, each particle template, a
custom drawn sprite, three emitters together, the cover blurred and its fallback, a solid colour,
the song default, Off, the picture undimmed, the Display settings, the Studio background editor
with an emitter and the sprite editor, then prints frame timings at 4K (base, all adjustments,
three emitters at the cap; pixel match on and off). The dev-only
`window.__ataraxiaBackgroundOverride` (a full config) and `__ataraxiaBackgroundSprites` drive the
shots.
