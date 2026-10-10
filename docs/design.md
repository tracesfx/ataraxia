# Design system

ataraxia's menus are sleek, modern pixel art: polished steel and glass drawn in fine pixels. Not
an 8-bit arcade, not a terminal. Everything here applies to the menu shells of both builds (main
menu, song select, settings, calibration, results, pause overlay, toasts, modals, Studio home),
since Phase 11 to the gameplay canvas (see "Gameplay canvas" below) and since Phase 12 to the chart
editor (see "Chart editor").

| Piece                      | Where                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| Tokens (colours, spacing…) | `src/ui/theme.ts` (typed `TOKENS` + CSS custom props)             |
| Pixel grid (`--px`, text)  | `src/ui/pixel/scale.ts`, installed by `pixel/install.ts`          |
| Sprites, materials         | `src/ui/pixel/sprites.ts`, `materials.ts`, `bitmap.ts`            |
| Generated sprite CSS       | `src/ui/pixel/skinCss.ts` (selector → sprite table)               |
| Icons                      | `src/ui/pixel/icons.ts`; Studio icons `src/studio/studioIcons.ts` |
| Logo, rank letters, covers | `src/ui/pixel/logo.ts`, `rank.ts`, `cover.ts`                     |
| Components                 | `src/ui/components.ts`, `src/ui/modal.ts`                         |
| Layout, type, motion       | `src/style.css`                                                   |
| Ambient backgrounds        | `src/ui/backdrop.ts`                                              |

## The pixel grid

One **art pixel** is a whole number `n` of device pixels. CSS sees it as `--px` (`n /
devicePixelRatio` CSS pixels) and every size is written as `calc(var(--px) * k)`.

- **Auto** (default): `n` comes from the window height in device pixels: 1 below 600, 2 up to
  1300 (1080p is 2), 3 up to 1800, 4 above; then it is lowered while the window would be less
  than 320 art pixels wide. In fullscreen the height used is the windowed one (the screen's
  available height minus the browser bars measured in a window, `windowedViewportHeight()`), so
  going fullscreen never changes the size. `chooseArtPixel()` is pure and tested.
- **Settings → Display → UI scale**: Auto, 1x, 2x or 3x device pixels per art pixel.
- `:root[data-px]` holds `n` and `:root[data-layout]` is `narrow` (< 560 art pixels wide),
  `medium` (< 820) or `wide`; CSS uses these instead of media queries, so layouts follow the
  art-pixel width.
- Spacing is on a 4/8 art-pixel scale (`--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16, `--s6` 24,
  `--s8` 32). Corner cuts: `sm` [1], `md` [2, 1], `lg` [3, 1, 1] (pixels left out per row).

## Colour

All colours are ramps (`RAMPS` in `theme.ts`), dark to light, each rising monotonically in
luminance (tested):

- **steel** (9): a cool neutral, near-black `#0b0e14` to near-white `#dce3ee`, slight blue tint.
- **accent** (7): one quiet azure, `#0c2238` to `#a6cdef`. The only accent hue of the menus.
- **iris** (7): the accent's quieter sibling, `#16173a` to `#bcc0f0`, for gameplay notes only
  (inner lanes iris, outer lanes azure).
- **success**, **warning**, **danger** (4 each).

No pure black, pure white or saturated primaries (tested). Semantic colours (`COLORS`) name
what a colour is for; text colours pass WCAG AA (4.5:1) against the background, glass panels,
control faces and the primary button face (tested). Level tiers use success / accent / warning /
danger; judgements use accent / success / warning / danger; the rank letters use ramps built from
the same palette (`RANK_RAMPS`).

## Materials

Each material is defined once in `materials.ts` and reused by every sprite:

- **steel** (buttons, keycaps, slider thumbs, toggle knobs): a vertical gradient of 5–6 flat
  bands, a bright 1-pixel top highlight, a darker 1-pixel bottom edge, a subtle inner bevel
  (lighter left column, darker right column), a 3-pixel diagonal specular glint near the
  top-left corner (always inside the corner slice, so it never stretches) and an outline one
  tone darker than the face in the same ramp. Never black, never a saturated outline.
- **glass** (panels, cards, modals, tooltips, toasts, rows): a translucent dark fill, a 1-pixel
  light top edge and a faint inner border, with cut corners.
- **accent** (primary button, selected states, focus): steel built from the accent ramp plus a
  soft glow of 2–3 stepped translucent rings (flat colours, no blur filter).

## Sprites

`buildUiSprites()` draws every sprite at art-pixel resolution from the palette (a few ms at
startup); `install.ts` turns them into PNG data URLs and injects a stylesheet generated from
`SKIN_RULES`. Elements wear the art as CSS `border-image` 9-slices (or a fixed background image)
with `image-rendering: pixelated`, so real `button`, `input`, `select` and `dialog` elements keep
native focus, keyboard use and accessibility. The UI never draws on a canvas except backgrounds.

Sets: button (primary / secondary / ghost / danger × idle / hover / pressed / focus / disabled),
sheen, glass, modal, tooltip, card (idle / hover / selected), toast (accent / success / danger),
field (idle / hover / focus / disabled), toggle (off / on × idle / hover / focus / disabled),
slider (track / fill / thumb × 5), progress (track / fill), tab (horizontal / vertical × idle /
hover / selected), chip (5 tones × plain / selected), row (hover / selected), keycap, scrollbar,
divider, focus ring, cover frame. Tests check sizes, slice values and that every pixel is a
palette colour.

Icons are 16×16 masks with 1–2 pixel strokes, applied with CSS `mask-image` and painted in
`currentColor`. Their pixels follow the text's glyph pixel (`--gp`) so they sit with the labels.
Studio-only icons (edit, import, export, undo, redo, duplicate, new chart, tools) are registered
from `src/studio` so they stay out of the player bundle.

## Typography

- **Jersey 10** (pixel font) for display text and UI labels: titles, buttons, tabs, chips, key
  caps, numbers.
- **Inter** (variable) for descriptions, long text, dense panels and form input.
- Lowercase or sentence case everywhere; no all-caps labels. Key caps show words in lowercase
  (`enter`, `esc`) and letter keys as printed on the keyboard.
- Scores, times and counts use equal-width digits (`font-variant-numeric: tabular-nums`; Jersey
  10 has a `tnum` feature).

### Font decision

Pixelify Sans, Tiny5 and Jersey 10 were rendered side by side at the sizes the UI uses and their
outlines were measured:

| Font          | Pixel grid                                  | Result                                                                                                 |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pixelify Sans | not on a fixed grid (~20 % of points align) | soft, slightly blurred edges at every size; never fully crisp                                          |
| Tiny5         | exact, 8 px per em                          | crisp, but heavy 2-pixel stems and a 4-pixel x-height read chunky and arcade-like                      |
| Jersey 10     | exact, 75/1400 em per pixel                 | crisp, even spacing, clean modern shapes, a 10-pixel cap height that stays legible, real `tnum` digits |

**Jersey 10 won**: the crispest and most legible, and the least retro. One glyph pixel is
18.667 px of font size and its line box is 20 glyph pixels, so sizes are whole multiples:
`textLadder(n)` maps the art pixel to glyph pixels for label / title / display (for example 1 / 2
/ 4 device pixels at n = 2), keeping every glyph pixel on whole device pixels. Body text in Inter
is 7n device pixels (at least 13 CSS px).

The gameplay canvas uses Jersey 10 too, rasterised into glyph atlases (below). Press Start 2P
was removed in Phase 11.

## Components

`components.ts`: `button` (variants, icon, key-hint cap, sizes md / lg, block), `iconButton`
(with tooltip), `toggle`, `slider` (value label; a transparent native range input on top),
`select` (native, styled), `textField`, `tabs` (roving tab index, arrows / Home / End), `chip`,
`card`, `divider`, `progressBar`, `toaster` (stacking toasts in a live region), `keyHint` /
`hintBar` (key caps from `src/ui/keyHints.ts`; lane keys always come from the bindings),
`coverArt` (a song's custom cover, scaled smoothly and never pixelated, inside the pixel cover
frame with cut corners and a steel border; without one, the generated placeholder: banded
gradient from the title's hash plus the first letter), `songCard` (cover thumbnail, title and
artist: pause menu and gameplay HUD), `logo`, `screenFrame`, `moveFocus`. `modal.ts`: `openModal`,
`showErrors`, `modalField`.

## Logo

A hand-placed pixel wordmark: custom lowercase letterforms (single-storey **a**, **t** with a
curved foot, **r**, a 2:1-stepped **x**, **i**), spaced by their stroke width, in two cuts
(large: 3-pixel strokes, 20-pixel x-height; small: 1-pixel strokes, 8-pixel x-height). Shaded
with a vertical steel-to-accent ramp, a 1-pixel bright top highlight on every top edge and a
1-pixel shadow down-right. The mark is a faceted gem resting on still water, with its dim
reflection below; it sits on the x-height next to the wordmark and works alone as the favicon.
`logo()` renders it in the DOM, `drawLogo()` into a canvas. The main menu plays one stepped
shine across it on load. Favicons (`public/favicon.svg` built from rects with `crispEdges`, PNG
16/32/48 and a 180 apple-touch icon) are generated from the same bitmap: `npm run icons`.

## Motion

- Hover on steel: a diagonal sheen sweeps across in whole art-pixel steps (an integer custom
  property animated over 220 ms).
- Pressed: one art pixel down, one ramp step darker.
- Focus: a 1-pixel accent outline with notched corners, always visible for keyboard use (baked
  into buttons; the `focus` sprite on `.ring` elements elsewhere).
- Screens, modals and toasts arrive in 160–180 ms with stepped easing.
- `prefers-reduced-motion: reduce` turns off every animation, the sweep and the logo shine; the
  ambient backdrop is drawn once and stays still.

## Backgrounds

`backdrop.ts` draws on one canvas at the art-pixel grid. The main menu, settings, calibration,
Studio home and song select (until a song is selected) show a slow moving gradient in the dark
steel, accent and iris tones (its angle turns over about 36 s, its stops drift, and a soft light
lifts and wanders over it), drawn smoothly at 96x54 and stretched, so it shows no bands or
blocks; it holds still under reduced motion. Song select and results show the selected cover
(custom or placeholder) blurred smoothly once into a faint glow, then drawn at the pixel-grid
resolution (no mosaic blocks). The gradient redraws about 12 times a second and not at all while
the tab is hidden.

## Gameplay canvas

The playfield is drawn on a canvas at a logical resolution near **540 rows**
(`PIXEL_TARGET_HEIGHT` in `src/render/pixelScale.ts`; 270 gives the old chunky grid), scaled up
by a whole number of device pixels and filling the whole window (no letterbox). The scale `s` is
the one whose height `floor(deviceHeight / s)` is closest to the target in log terms, within
360-770 rows: 1080p and 4K both give 960x540 (at 2x and 4x), 1366x768 gives 683x384. The
scale is picked for the windowed viewport height (`windowedViewportHeight()`), so fullscreen keeps
the windowed scale (the same lane width and HUD size) and only shows more rows. Layout is in
logical pixels (`src/render/fieldLayout.ts`): four 64-pixel lanes centred, the hit line at 0.85 H.

- **Field**: translucent dark glass (86 % above the hit line, 60 % below it, so the background
  shows through under the line), lane dividers (one dark pixel and one faint light pixel, softer
  below the line), brushed steel rails with the highlight on the inner edge, and five flat bands
  lightening toward the hit line. Behind it, an animated background
  (Phase 15, `docs/backgrounds.md`) on the same pixel grid in flat palette bands, under a dim
  layer and a luminance clamp behind the lanes; the static gradient (a soft glow from the top and
  a vignette) is the fallback.
- **Notes** (60x16): cut corners, darker same-hue outline, bright top highlight row, five-band
  gradient, darker bottom row, a three-pixel glint. Holds: a translucent two-tone body with
  bright edges and a cap; while held the head is gone and the brighter body ends at the
  judgement line; dimmed when dropped.
- **Judgement line**: one line across the field, 2 logical pixels: a bright light-steel top row
  and a dimmer accent-tinted bottom row. No receptors, deck, end caps or boxes.
- **Lane glow**: pressing a lane key fills that lane column, from the top of the field down to
  the judgement line (never below it), with a flat tint of the lane's note hue. It rises to 17 %
  in about 30 ms, stays at that peak while the key is held (notes or not) and decays
  exponentially to nothing in about 200 ms after release. Minimal effects: 9 % and a shorter
  decay. The Lane glow setting scales it from Off to 200 %. There is no hit effect and no screen
  shake; per-hit feedback is the judgement text, the combo, the timing particles and the lane
  glow.
- **Text**: Jersey 10, rasterised once at 1x and drawn at whole multiples of its font pixel
  (`GlyphFont.drawStyled`), each glyph thresholded to a 1-bit mask and tinted per colour, always
  on whole pixels; digits are tabular. Large text (score, combo, judgements) has a 1-pixel dark
  outline, a 1-pixel drop shadow and a metallic vertical ramp of five close tones
  (`METAL_RAMPS` in `theme.ts`), one flat band per font-pixel row group, never a smooth gradient.
  Small timing particles use a 5x7 digit set (`src/skins/default/microFont.ts`).
- **Judgements**: lowercase ("perfect", "great", "good", "miss"), at the label size above the hit
  line in the middle of the field, each replacing the last. Perfect gold with a faint 2-pixel
  glow, Great teal fading to green, Good blue steel, Miss muted red; their drop shadows are soft
  (40 %). Perfect and Great rise into place by whole pixels, Good fades in, Miss
  jitters 2 pixels sideways for 100 ms; all hold 300 ms and fade out in four alpha steps over
  200 ms. The early / late hint above them is small and dim. Judgement style Simple (and Minimal
  effects, and reduced motion) only fades.
- **Combo**: 3x digits behind the notes, always the same size and with no label, coloured by
  count (Combo colors setting): 0-24 white steel, 25 cyan, 50 green, 100 gold, 200 orange, 300
  magenta, 500 a rainbow (twelve hues swept across the digits in discrete steps at a constant
  pace), 1000 adds twinkling sparkle pixels. Tier changes cross-fade in about 150 ms. A
  shine band leaning at 45 degrees (a crisp 1-pixel staircase) sweeps slowly across the digits
  (0.9 s) after pauses of random length (1.5-4.5 s) on frame time, never following the hits,
  from a 50 combo; its opacity and width step up at 100, 200, 300, 500 and 1000. No pop on milestones. A break turns the number
  steel and shakes it for about 150 ms. Minimal effects and reduced motion keep the tier colours
  but drop the shine, the bump and the rainbow animation (the rainbow becomes static gold).
- **HUD**: song card (DOM, so the cover stays smooth, 30 % larger than in the menus) top left;
  top right a glass panel with the 7-digit zero-padded score (leading zeros dim, rolling up over
  150 ms) and under it the notes judged / total (dim) and the accuracy, their outer ink edges
  lined up exactly with the score's: the count starts where the score's first digit starts and
  the "%" ends where its last digit ends (edges measured on "0", so nothing shifts as the
  numbers change). The score's scale comes from the HUD size setting
  (Large 4x, Medium 3x, Small 2x; stepped down when it would not fit beside the field); the second
  row takes the largest scale (2x, or 1x for Small) whose widest form ("total/total" and
  "100.00%") still fits under the score, so it never changes size during a song; a
  4-pixel progress bar along the bottom edge with elapsed and remaining time, practice A-B
  markers, dimmed while paused. Practice panel, messages, toasts and the pause menu are DOM
  components. The pointer hides after 2 s without movement during play.
- Effects never cover upcoming notes: the lane glow, combo and judgement are drawn under the
  notes.

## Chart editor

The editor (Studio only, `src/studio/editor`, layout in `docs/editor.md`) is a dense tool screen
built from the same parts: flat steel bars (`steel-1` with a 1-art-pixel `steel-2` edge) around
the timeline, steel buttons and icon buttons, chip segmented controls, toggles, sliders, glass
menus and cards (with an opaque backing where they float over the busy timeline), key caps in
every tooltip. Headings and button labels use Jersey 10; values, descriptions and small text use
Inter. Advanced controls sit behind "More" menus and collapsed sections.

The timeline and minimap are native-resolution canvases (not the pixel grid) for precision, drawn
in the same language: flat colour bands from the ramps, 1-device-pixel lines, a two-tone flat
waveform, stepped pixel arrows on the playhead, a small metallic flag for the game start, and the
skin's note sprites scaled by a whole number of device pixels (nearest neighbour). Grid line
colours keep their meaning (beat red, 1/2 blue, 1/4 yellow...) but are muted; they are the only
colours outside the ramps, with the same values on the snap segments. Labels on the canvas use
Inter.

## Banned

Anything that reads retro, terminal or ASCII: dithering, noise, halftone, checkerboards,
scanlines, CRT or glitch effects, tiled dot / grid / character patterns, monospace fonts in the
menus, box-drawing borders, blinking cursors, chunky 1-pixel saturated outlines, all-caps labels.
Gradients are 4–8 flat bands with smooth shapes.

This list is for the game's own art. Gameplay backgrounds (`docs/backgrounds.md`) are song
content a creator makes in the Studio: a static picture with a few baked adjustments and
particles.

## Reviewing

`npm run screenshots` (Playwright) captures every screen, including Studio home, at 1280×720,
1920×1080 and a narrow 480×860 window, plus button state close-ups, then gameplay with the dev
`?autoplay` mode at 1920×1080, 3840×2160 and 1366×768 (holds, a stream, pause, timing particles
at each threshold, minimal effects, practice, results) and the frame rate on the dense `?stress`
chart, into `docs/screenshots/` (gitignored). `npm run screenshots -- --gameplay` runs only the
gameplay part.
