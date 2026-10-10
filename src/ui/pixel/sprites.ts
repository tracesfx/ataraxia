import { ALPHA, CUTS, RAMPS, type Cut, type Ramp, type Tone } from '../theme';
import { Bitmap, Mask, corners, rrect } from './bitmap';
import {
  paintGlass,
  paintGlow,
  paintRing,
  paintSteel,
  put,
  steelFrom,
  type GlassSpec,
  type SteelSpec,
} from './materials';

/**
 * Every generated UI sprite. Each is drawn at art-pixel resolution from the palette ramps and
 * applied in CSS as a 9-slice `border-image` (see skinCss.ts), scaled by `--px`.
 *
 * `slice` is [top, right, bottom, left] in art pixels from the sprite's edges; the middle row and
 * column stretch. `outset` is how far the art reaches outside the element's box (glow and focus
 * ring), which is also the transparent margin around the body in the sprite. A null slice means a
 * fixed-size image (toggles, slider thumbs, sheen).
 */
export interface UiSprite {
  readonly name: string;
  readonly bitmap: Bitmap;
  readonly slice: readonly [number, number, number, number] | null;
  readonly outset: number;
}

const S = RAMPS.steel;
const A = RAMPS.accent;

/** Button body: 16 rows tall; 6-pixel side slices hold the corner cut and the glint. */
export const BUTTON = { w: 14, h: 16, side: 6, cap: 7, margin: 3 } as const;
export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;
export const BUTTON_STATES = ['idle', 'hover', 'pressed', 'focus', 'disabled'] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonState = (typeof BUTTON_STATES)[number];

export const CHIP_TONES: readonly Tone[] = ['steel', 'accent', 'success', 'warning', 'danger'];
export const TOAST_TONES = ['accent', 'success', 'danger'] as const;

function bodyMask(w: number, h: number, margin: number, cut: Cut): Mask {
  const mask = new Mask(w + margin * 2, h + margin * 2);
  return rrect(mask, margin, margin, w, h, corners(CUTS[cut]));
}

function sprite(name: string, bitmap: Bitmap, slice: UiSprite['slice'], outset: number): UiSprite {
  return { name, bitmap, slice, outset };
}

// --- Material presets --------------------------------------------------------------------------

const STEEL_FACE = {
  idle: steelFrom(S, { outline: 1, highlight: 7, bottom: 2, bands: [6, 5, 5, 4, 4, 3] }),
  hover: steelFrom(S, { outline: 1, highlight: 8, bottom: 2, bands: [6, 6, 5, 5, 4, 4] }),
  pressed: steelFrom(S, {
    outline: 1,
    highlight: 5,
    bottom: 2,
    bands: [4, 4, 4, 3, 3, 3],
    glint: null,
  }),
  disabled: steelFrom(S, {
    outline: 1,
    highlight: 3,
    bottom: 2,
    bands: [3, 3, 3, 2, 2, 2],
    glint: null,
    bevel: false,
  }),
};

const ACCENT_FACE = {
  idle: steelFrom(A, { outline: 0, highlight: 6, bottom: 1, bands: [4, 3, 3, 3, 2, 2] }),
  hover: steelFrom(A, { outline: 0, highlight: S[8], bottom: 1, bands: [5, 3, 3, 3, 2, 2] }),
  pressed: steelFrom(A, {
    outline: 0,
    highlight: 4,
    bottom: 1,
    bands: [3, 2, 2, 2, 1, 1],
    glint: null,
  }),
};

const ACCENT_GLOW = {
  idle: [
    [A[4], 0.4],
    [A[3], 0.22],
    [A[3], 0.1],
  ],
  hover: [
    [A[5], 0.45],
    [A[4], 0.26],
    [A[3], 0.12],
  ],
  pressed: [
    [A[4], 0.3],
    [A[3], 0.14],
  ],
} as const;

const D = RAMPS.danger;
const DANGER_FACE = {
  idle: steelFrom(D, { outline: 0, highlight: 3, bottom: 0, bands: [2, 1, 1, 1, 1, 0] }),
  hover: steelFrom(D, { outline: 0, highlight: S[8], bottom: 0, bands: [3, 1, 1, 1, 1, 0] }),
  pressed: steelFrom(D, {
    outline: 0,
    highlight: 2,
    bottom: 0,
    bands: [1, 1, 1, 0, 0, 0],
    glint: null,
  }),
};

function ghostFace(alpha: number, light: boolean): SteelSpec {
  return {
    outline: S[light ? 4 : 3],
    highlight: S[light ? 5 : 4],
    bottom: S[2],
    bands: [S[3], S[3], S[2]],
    bevelLight: null,
    bevelDark: null,
    glint: null,
    alpha,
  };
}

const GLASS: GlassSpec = {
  fill: S[1],
  fillAlpha: ALPHA.glass,
  outline: S[3],
  outlineAlpha: 0.95,
  topEdge: S[6],
  inner: S[4],
  innerAlpha: 0.32,
};

// --- Buttons -----------------------------------------------------------------------------------

function buttonSprite(variant: ButtonVariant, state: ButtonState): UiSprite {
  const { w, h, side, cap, margin } = BUTTON;
  const mask = bodyMask(w, h, margin, 'md');
  const bmp = new Bitmap(mask.w, mask.h);
  const face = state === 'focus' ? 'idle' : state;
  if (face === 'disabled') {
    if (variant !== 'ghost') paintSteel(bmp, mask, STEEL_FACE.disabled);
  } else if (variant === 'primary') {
    paintGlow(bmp, mask, ACCENT_GLOW[face]);
    paintSteel(bmp, mask, ACCENT_FACE[face]);
  } else if (variant === 'danger') {
    paintSteel(bmp, mask, DANGER_FACE[face]);
  } else if (variant === 'secondary') {
    paintSteel(bmp, mask, STEEL_FACE[face]);
  } else if (face !== 'idle') {
    paintSteel(bmp, mask, ghostFace(face === 'hover' ? 0.7 : 0.85, face === 'hover'));
  }
  if (state === 'focus') paintRing(bmp, mask, A[5]);
  return sprite(
    `button.${variant}.${state}`,
    bmp,
    [margin + cap, margin + side, margin + cap, margin + side],
    margin,
  );
}

/** Diagonal sheen streak swept across steel on hover (CSS moves it in whole art pixels). */
function sheenSprite(): UiSprite {
  const w = 10;
  const h = BUTTON.h;
  const bmp = new Bitmap(w, h);
  for (let y = 0; y < h; y++) {
    const x = Math.floor((h - 1 - y) / 2);
    put(bmp, x, y, S[8], 0.1);
    put(bmp, x + 1, y, S[8], 0.28);
    put(bmp, x + 2, y, S[8], 0.28);
    put(bmp, x + 3, y, S[8], 0.1);
  }
  return sprite('sheen', bmp, null, 0);
}

// --- Panels ------------------------------------------------------------------------------------

function glassSprite(name: string, cut: Cut, spec: GlassSpec, size = 16): UiSprite {
  const mask = bodyMask(size, size, 0, cut);
  const bmp = new Bitmap(mask.w, mask.h);
  paintGlass(bmp, mask, spec);
  const s = size / 2 - 1;
  return sprite(name, bmp, [s, s, s, s], 0);
}

function cardSprite(state: 'idle' | 'hover' | 'selected'): UiSprite {
  const spec: GlassSpec =
    state === 'selected'
      ? {
          fill: A[0],
          fillAlpha: 0.9,
          outline: A[3],
          outlineAlpha: 1,
          topEdge: A[5],
          inner: A[2],
          innerAlpha: 0.5,
        }
      : {
          fill: S[2],
          fillAlpha: state === 'hover' ? 0.86 : 0.7,
          outline: S[state === 'hover' ? 4 : 3],
          outlineAlpha: 1,
          topEdge: S[state === 'hover' ? 6 : 5],
          inner: S[4],
          innerAlpha: 0.25,
        };
  return glassSprite(`card.${state}`, 'md', spec, 12);
}

function toastSprite(tone: (typeof TOAST_TONES)[number]): UiSprite {
  const ramp = RAMPS[tone];
  const mask = bodyMask(16, 16, 0, 'md');
  const bmp = new Bitmap(16, 16);
  paintGlass(bmp, mask, {
    fill: S[2],
    fillAlpha: 0.96,
    outline: S[4],
    outlineAlpha: 1,
    topEdge: S[6],
    inner: S[3],
    innerAlpha: 0.6,
  });
  // A two-pixel tone bar inside the left edge.
  for (let y = 2; y < 14; y++) {
    put(bmp, 2, y, ramp[ramp.length - 1] as string);
    put(bmp, 3, y, ramp[ramp.length - 2] as string);
  }
  return sprite(`toast.${tone}`, bmp, [7, 7, 7, 7], 0);
}

// --- Controls ----------------------------------------------------------------------------------

type FieldState = 'idle' | 'hover' | 'focus' | 'disabled';

function fieldSprite(state: FieldState): UiSprite {
  const mask = bodyMask(12, 16, 0, 'md');
  const bmp = new Bitmap(mask.w, mask.h);
  const outline =
    state === 'focus' ? A[5] : state === 'hover' ? S[5] : state === 'disabled' ? S[2] : S[4];
  paintSteel(bmp, mask, {
    outline,
    highlight: S[0],
    bottom: S[3],
    bands: state === 'disabled' ? [S[1]] : [S[1], S[1], S[1], S[1], S[2]],
    bevelLight: null,
    bevelDark: null,
    glint: null,
  });
  return sprite(`field.${state}`, bmp, [7, 5, 7, 5], 0);
}

/** A sunken track (toggle off, slider, progress). */
function wellSpec(dim = false): SteelSpec {
  return {
    outline: S[dim ? 2 : 3],
    highlight: S[0],
    bottom: S[2],
    bands: [S[1]],
    bevelLight: null,
    bevelDark: null,
    glint: null,
  };
}

export const TOGGLE = { w: 22, h: 12, knob: 10, margin: 2 } as const;
type ToggleState = 'idle' | 'hover' | 'focus' | 'disabled';

function toggleSprite(on: boolean, state: ToggleState): UiSprite {
  const { w, h, knob, margin } = TOGGLE;
  const track = bodyMask(w, h, margin, 'md');
  const bmp = new Bitmap(track.w, track.h);
  const disabled = state === 'disabled';
  if (on && !disabled) {
    paintSteel(bmp, track, {
      outline: A[1],
      highlight: A[1],
      bottom: A[3],
      bands: [A[2], A[2], A[3]],
      bevelLight: null,
      bevelDark: null,
      glint: null,
    });
  } else {
    paintSteel(bmp, track, wellSpec(disabled));
  }
  const kx = margin + (on ? w - knob - 1 : 1);
  const kmask = rrect(new Mask(track.w, track.h), kx, margin + 1, knob, knob, corners(CUTS.sm));
  const hover = state === 'hover';
  paintSteel(
    bmp,
    kmask,
    disabled
      ? STEEL_FACE.disabled
      : steelFrom(S, {
          outline: on ? 1 : 2,
          highlight: 8,
          bottom: 4,
          bands: hover ? [8, 7, 7, 6, 6] : [7, 7, 6, 6, 5],
          glint: null,
          bevel: false,
        }),
  );
  if (state === 'focus') paintRing(bmp, track, A[5], 0);
  return sprite(`toggle.${on ? 'on' : 'off'}.${state}`, bmp, null, margin);
}

export const SLIDER = { track: 6, thumbW: 8, thumbH: 14, margin: 2 } as const;

function sliderTrackSprite(): UiSprite {
  const mask = bodyMask(8, SLIDER.track, 0, 'sm');
  const bmp = new Bitmap(mask.w, mask.h);
  paintSteel(bmp, mask, wellSpec());
  return sprite('slider.track', bmp, [3, 3, 3, 3], 0);
}

function sliderFillSprite(): UiSprite {
  const mask = bodyMask(8, SLIDER.track, 0, 'sm');
  const bmp = new Bitmap(mask.w, mask.h);
  paintSteel(bmp, mask, {
    outline: A[1],
    highlight: A[6],
    bottom: A[2],
    bands: [A[4], A[3]],
    bevelLight: null,
    bevelDark: null,
    glint: null,
  });
  return sprite('slider.fill', bmp, [3, 3, 3, 3], 0);
}

function sliderThumbSprite(state: 'idle' | 'hover' | 'active' | 'focus' | 'disabled'): UiSprite {
  const { thumbW, thumbH, margin } = SLIDER;
  const mask = bodyMask(thumbW, thumbH, margin, 'sm');
  const bmp = new Bitmap(mask.w, mask.h);
  const face =
    state === 'disabled'
      ? STEEL_FACE.disabled
      : state === 'active'
        ? STEEL_FACE.pressed
        : steelFrom(S, {
            outline: 1,
            highlight: 8,
            bottom: 3,
            bands: state === 'hover' ? [8, 7, 7, 6, 6] : [7, 7, 6, 6, 5],
            glint: null,
          });
  paintSteel(bmp, mask, face);
  if (state === 'focus') paintRing(bmp, mask, A[5], 0);
  return sprite(`slider.thumb.${state}`, bmp, null, margin);
}

function progressSprite(part: 'track' | 'fill'): UiSprite {
  const mask = bodyMask(8, 4, 0, 'none');
  const bmp = new Bitmap(mask.w, mask.h);
  if (part === 'track') {
    paintSteel(bmp, mask, wellSpec());
  } else {
    paintSteel(bmp, mask, {
      outline: A[2],
      highlight: A[6],
      bottom: A[3],
      bands: [A[4]],
      bevelLight: null,
      bevelDark: null,
      glint: null,
    });
  }
  return sprite(`progress.${part}`, bmp, [2, 2, 2, 2], 0);
}

function tabSprite(orientation: 'h' | 'v', state: 'idle' | 'hover' | 'selected'): UiSprite {
  const size = 12;
  const bmp = new Bitmap(size, size);
  if (state !== 'idle') {
    const mask = bodyMask(size, size, 0, 'sm');
    paintGlass(bmp, mask, {
      fill: S[2],
      fillAlpha: state === 'selected' ? 0.9 : 0.55,
      outline: S[3],
      outlineAlpha: state === 'selected' ? 1 : 0.6,
      topEdge: S[state === 'selected' ? 5 : 4],
      inner: S[3],
      innerAlpha: 0.3,
    });
  }
  if (state === 'selected') {
    for (let i = 2; i < size - 2; i++) {
      if (orientation === 'h') {
        put(bmp, i, size - 2, A[5]);
        put(bmp, i, size - 3, A[4]);
      } else {
        put(bmp, 1, i, A[5]);
        put(bmp, 2, i, A[4]);
      }
    }
  }
  return sprite(`tab.${orientation}.${state}`, bmp, [5, 5, 5, 5], 0);
}

function chipSprite(tone: Tone, selected: boolean): UiSprite {
  const ramp: Ramp = tone === 'steel' ? [S[2], S[3], S[5], S[7]] : RAMPS[tone];
  const top = ramp.length - 1;
  const margin = 2;
  const mask = bodyMask(10, 12, margin, 'sm');
  const bmp = new Bitmap(mask.w, mask.h);
  if (selected) paintGlow(bmp, mask, [[ramp[top - 1] as string, 0.35]]);
  paintGlass(bmp, mask, {
    fill: ramp[0] as string,
    fillAlpha: selected ? 1 : 0.92,
    outline: ramp[selected ? top : 1] as string,
    outlineAlpha: 1,
    topEdge: ramp[selected ? top : 2] as string,
    inner: ramp[1] as string,
    innerAlpha: 0.6,
  });
  return sprite(
    `chip.${tone}${selected ? '.selected' : ''}`,
    bmp,
    [margin + 5, margin + 4, margin + 5, margin + 4],
    margin,
  );
}

function rowSprite(state: 'hover' | 'selected'): UiSprite {
  const size = 16;
  const mask = bodyMask(size, size, 0, 'md');
  const bmp = new Bitmap(size, size);
  if (state === 'hover') {
    paintGlass(bmp, mask, {
      fill: S[2],
      fillAlpha: 0.6,
      outline: S[3],
      outlineAlpha: 0.9,
      topEdge: S[4],
      inner: S[3],
      innerAlpha: 0.2,
    });
  } else {
    paintGlass(bmp, mask, {
      fill: A[0],
      fillAlpha: 0.88,
      outline: A[2],
      outlineAlpha: 1,
      topEdge: A[4],
      inner: A[1],
      innerAlpha: 0.8,
    });
    for (let y = 3; y < size - 3; y++) {
      put(bmp, 2, y, A[5]);
      put(bmp, 3, y, A[4]);
    }
  }
  return sprite(`row.${state}`, bmp, [6, 6, 6, 6], 0);
}

function keycapSprite(): UiSprite {
  const mask = bodyMask(10, 12, 0, 'sm');
  const bmp = new Bitmap(mask.w, mask.h);
  paintSteel(bmp, mask, {
    outline: S[1],
    highlight: S[5],
    bottom: S[2],
    bands: [S[4], S[4], S[4], S[4], S[3], S[2]],
    bevelLight: null,
    bevelDark: null,
    glint: null,
  });
  return sprite('keycap', bmp, [5, 4, 6, 4], 0);
}

function scrollbarSprite(state: 'idle' | 'hover'): UiSprite {
  const mask = bodyMask(6, 8, 0, 'sm');
  const bmp = new Bitmap(mask.w, mask.h);
  paintGlass(bmp, mask, {
    fill: S[state === 'hover' ? 5 : 4],
    fillAlpha: 1,
    outline: S[3],
    outlineAlpha: 1,
    topEdge: S[state === 'hover' ? 6 : 5],
    inner: S[state === 'hover' ? 6 : 5],
    innerAlpha: 0.4,
  });
  return sprite(`scrollbar.${state}`, bmp, [3, 2, 3, 2], 0);
}

function dividerSprite(): UiSprite {
  const bmp = new Bitmap(12, 1);
  const cols = [S[2], S[2], S[3], S[3]];
  for (let x = 0; x < 12; x++) {
    const edge = Math.min(x, 11 - x);
    put(bmp, x, 0, cols[edge] ?? (S[4] as string));
  }
  return sprite('divider', bmp, [0, 5, 0, 5], 0);
}

/** The generic keyboard focus ring for controls that have no baked focus state. */
function focusRingSprite(): UiSprite {
  const margin = 2;
  const mask = bodyMask(12, 12, margin, 'md');
  const bmp = new Bitmap(mask.w, mask.h);
  paintRing(bmp, mask, A[5]);
  return sprite('focus', bmp, [margin + 5, margin + 5, margin + 5, margin + 5], margin);
}

/** Thin frame drawn over cover art. */
function coverFrameSprite(): UiSprite {
  const mask = bodyMask(10, 10, 0, 'sm');
  const bmp = new Bitmap(10, 10);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      if (!mask.has(x, y)) continue;
      if (mask.isEdge(x, y)) put(bmp, x, y, S[3]);
      else if (mask.isEdge(x, y - 1) || mask.isEdge(x - 1, y)) put(bmp, x, y, S[8], 0.22);
      else if (mask.isEdge(x, y + 1) || mask.isEdge(x + 1, y)) put(bmp, x, y, S[0], 0.35);
    }
  }
  return sprite('cover.frame', bmp, [3, 3, 3, 3], 0);
}

/** Build every UI sprite. Cheap (a few ms): called once at startup. */
export function buildUiSprites(): Map<string, UiSprite> {
  const list: UiSprite[] = [];
  for (const variant of BUTTON_VARIANTS) {
    for (const state of BUTTON_STATES) list.push(buttonSprite(variant, state));
  }
  list.push(sheenSprite());
  list.push(glassSprite('glass', 'lg', GLASS));
  list.push(
    glassSprite('modal', 'lg', {
      ...GLASS,
      fillAlpha: ALPHA.glassStrong,
      outline: S[4],
      topEdge: S[7],
      innerAlpha: 0.4,
    }),
  );
  list.push(
    glassSprite(
      'tooltip',
      'sm',
      {
        fill: S[3],
        fillAlpha: 1,
        outline: S[1],
        outlineAlpha: 1,
        topEdge: S[5],
        inner: S[4],
        innerAlpha: 0.5,
      },
      8,
    ),
  );
  for (const state of ['idle', 'hover', 'selected'] as const) list.push(cardSprite(state));
  for (const tone of TOAST_TONES) list.push(toastSprite(tone));
  for (const state of ['idle', 'hover', 'focus', 'disabled'] as const) {
    list.push(fieldSprite(state));
  }
  for (const on of [false, true]) {
    for (const state of ['idle', 'hover', 'focus', 'disabled'] as const) {
      list.push(toggleSprite(on, state));
    }
  }
  list.push(sliderTrackSprite(), sliderFillSprite());
  for (const state of ['idle', 'hover', 'active', 'focus', 'disabled'] as const) {
    list.push(sliderThumbSprite(state));
  }
  list.push(progressSprite('track'), progressSprite('fill'));
  for (const o of ['h', 'v'] as const) {
    for (const state of ['idle', 'hover', 'selected'] as const) list.push(tabSprite(o, state));
  }
  for (const tone of CHIP_TONES) list.push(chipSprite(tone, false), chipSprite(tone, true));
  list.push(rowSprite('hover'), rowSprite('selected'));
  list.push(keycapSprite());
  list.push(scrollbarSprite('idle'), scrollbarSprite('hover'));
  list.push(dividerSprite(), focusRingSprite(), coverFrameSprite());
  return new Map(list.map((s) => [s.name, s]));
}
