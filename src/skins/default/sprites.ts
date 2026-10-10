import {
  FIELD_W,
  HOLD_CAP_H,
  HOLD_W,
  JUDGE_LINE_H,
  LANE_W,
  NOTE_H,
  NOTE_W,
  PROGRESS_H,
  RAIL_W,
} from '../../render/fieldLayout';
import { NOTE_HUES, type NoteHue } from '../../render/skin';
import { Bitmap, Mask, corners, rrect } from '../../ui/pixel/bitmap';
import { paintSteel, put, steelFrom } from '../../ui/pixel/materials';
import { JUDGEMENT_COLORS, RAMPS, type Ramp } from '../../ui/theme';

/**
 * The default skin's art, generated at logical resolution from the theme ramps (original work).
 * Pure: everything is a `Bitmap` of palette colours (with alpha), so tests can check sizes and
 * colours; `index.ts` turns them into canvases at startup. Materials follow docs/design.md:
 * steel (rails, the judgement line), glass (the field) and the accent family (notes), with flat
 * colour bands, cut corners and no dithering, noise or blur.
 */
const STEEL = RAMPS.steel;

/** Note ramps: outer lanes in the accent, inner lanes in its iris sibling. */
export const HUE_RAMPS: Readonly<Record<NoteHue, Ramp>> = {
  outer: RAMPS.accent,
  inner: RAMPS.iris,
};

const at = (ramp: Ramp, i: number): string =>
  ramp[Math.max(0, Math.min(ramp.length - 1, i))] as string;

// --- Notes ---------------------------------------------------------------------------------

function noteMask(): Mask {
  return rrect(new Mask(NOTE_W, NOTE_H), 0, 0, NOTE_W, NOTE_H, corners([2, 1]));
}

/**
 * A 60x16 note: cut corners, a darker same-hue outline, a bright top highlight row, a 5-band
 * vertical gradient, a darker bottom row and a small specular glint near the top-left.
 */
export function noteBitmap(hue: NoteHue): Bitmap {
  const ramp = HUE_RAMPS[hue];
  const bmp = new Bitmap(NOTE_W, NOTE_H);
  paintSteel(
    bmp,
    noteMask(),
    steelFrom(ramp, {
      outline: 1,
      highlight: STEEL[8],
      bottom: 2,
      bands: [6, 5, 5, 4, 3],
      bevel: false,
      glint: STEEL[8],
    }),
  );
  return bmp;
}

/** One row of the hold body: bright edges, a lighter centre band, translucent. */
export function holdBodyBitmap(hue: NoteHue, held: boolean): Bitmap {
  const ramp = HUE_RAMPS[hue];
  const lift = held ? 1 : 0;
  const bmp = new Bitmap(HOLD_W, 1);
  for (let x = 0; x < HOLD_W; x++) {
    const fromEdge = Math.min(x, HOLD_W - 1 - x);
    let hex: string;
    let alpha: number;
    if (fromEdge === 0) {
      hex = at(ramp, 5 + lift);
      alpha = 0.9;
    } else if (fromEdge === 1) {
      hex = at(ramp, 3 + lift);
      alpha = 0.7;
    } else if (fromEdge < HOLD_W / 4) {
      hex = at(ramp, 2 + lift);
      alpha = 0.5;
    } else {
      hex = at(ramp, 3 + lift);
      alpha = 0.5;
    }
    put(bmp, x, 0, hex, alpha);
  }
  return bmp;
}

/** The rounded end cap at the top of a hold body. */
export function holdCapBitmap(hue: NoteHue): Bitmap {
  const ramp = HUE_RAMPS[hue];
  const bmp = new Bitmap(HOLD_W, HOLD_CAP_H);
  const mask = rrect(new Mask(HOLD_W, HOLD_CAP_H), 0, 0, HOLD_W, HOLD_CAP_H + 3, corners([3, 1]));
  paintSteel(
    bmp,
    mask,
    steelFrom(ramp, {
      outline: 2,
      highlight: 6,
      bottom: 3,
      bands: [5, 4],
      bevel: false,
      glint: null,
    }),
  );
  // Open bottom: the body continues below, so the last row matches its edges.
  for (let x = 0; x < HOLD_W; x++) {
    if (mask.has(x, HOLD_CAP_H - 1)) {
      const edge = x === 0 || x === HOLD_W - 1;
      put(bmp, x, HOLD_CAP_H - 1, at(ramp, edge ? 5 : 3), edge ? 0.95 : 0.8);
    }
  }
  return bmp;
}

// --- Progress bar --------------------------------------------------------------------------

export function progressTrackBitmap(): Bitmap {
  const bmp = new Bitmap(1, PROGRESS_H);
  const rows = [STEEL[4], STEEL[2], STEEL[2], STEEL[1]];
  rows.forEach((hex, y) => put(bmp, 0, y, hex as string, 0.92));
  return bmp;
}

export function progressFillBitmap(): Bitmap {
  const a = RAMPS.accent;
  const bmp = new Bitmap(1, PROGRESS_H);
  [a[6], a[4], a[4], a[3]].forEach((hex, y) => put(bmp, 0, y, hex as string));
  return bmp;
}

// --- Field ---------------------------------------------------------------------------------

/** Glass opacity above the hit line, and below it (translucent: the background shows through). */
export const FIELD_GLASS_ALPHA = 0.86;
export const BELOW_LINE_GLASS_ALPHA = 0.6;

/**
 * The static field art for a height `h` and hit line row: a translucent dark glass panel (lighter
 * glass below the hit line, so the background shows through), lane dividers (1 dark + 1 faint
 * light pixel), brushed steel rails with a highlight on the inner edge, flat bands lightening
 * toward the hit line, and the judgement line: two rows across the field, a bright steel top row
 * and a dimmer accent-tinted bottom row, no caps.
 */
export function fieldBitmap(h: number, hitLineY: number): Bitmap {
  const w = FIELD_W + 2 * RAIL_W;
  const bmp = new Bitmap(w, h);
  const lineTop = hitLineY - (JUDGE_LINE_H - 1);
  const below = hitLineY + 1;
  // Glass (the lightening toward the hit line is a separate overlay, `fieldGlowBitmap`).
  for (let y = 0; y < h; y++) {
    const alpha = y >= below ? BELOW_LINE_GLASS_ALPHA : FIELD_GLASS_ALPHA;
    for (let x = RAIL_W; x < RAIL_W + FIELD_W; x++) put(bmp, x, y, STEEL[1], alpha);
  }
  // Lane dividers between lanes: one dark pixel and one faint light pixel, softer below the line.
  for (let lane = 1; lane < 4; lane++) {
    const x = RAIL_W + lane * LANE_W;
    for (let y = 0; y < h; y++) {
      if (y >= lineTop && y < below) continue;
      const under = y >= below;
      put(bmp, x - 1, y, STEEL[0], under ? 0.7 : 0.9);
      put(bmp, x, y, STEEL[5], under ? 0.2 : 0.28);
    }
  }
  // Rails: brushed steel, 3 px, the highlight on the inner edge.
  const railCols = [STEEL[2], STEEL[4], STEEL[6]];
  for (let y = 0; y < h; y++) {
    // Brushed look: a long, smooth sheen band, not noise.
    const sheen = y > h * 0.3 && y < h * 0.55 ? 1 : 0;
    for (let i = 0; i < RAIL_W; i++) {
      const hex = i === 2 && sheen ? STEEL[7] : (railCols[i] as string);
      put(bmp, i, y, hex);
      put(bmp, w - 1 - i, y, hex);
    }
  }
  // The judgement line: one colour family, a bright top row and a dimmer bottom row.
  for (let x = RAIL_W; x < RAIL_W + FIELD_W; x++) {
    put(bmp, x, lineTop, STEEL[8]);
    put(bmp, x, hitLineY, RAMPS.accent[6] as string, 0.9);
  }
  return bmp;
}

/**
 * Drawn over the field glass: 5 flat bands of translucent steel that lighten the lower half of
 * the field toward the judgement line (same size as `fieldBitmap`).
 */
export function fieldGlowBitmap(h: number, hitLineY: number): Bitmap {
  const bmp = new Bitmap(FIELD_W + 2 * RAIL_W, h);
  const lineTop = hitLineY - (JUDGE_LINE_H - 1);
  const glowTop = Math.round(hitLineY * 0.45);
  const alphas = [0.04, 0.08, 0.12, 0.16, 0.2];
  for (let y = glowTop; y < lineTop; y++) {
    const band = Math.min(4, Math.floor(((y - glowTop) * 5) / (lineTop - glowTop)));
    for (let x = RAIL_W; x < RAIL_W + FIELD_W; x++)
      put(bmp, x, y, STEEL[3], alphas[band] as number);
  }
  return bmp;
}

/**
 * The static background: a soft elliptical glow above the field and a vignette, quantized to
 * flat palette bands with smooth edges (no dithering). Opaque.
 */
export function backgroundBitmap(w: number, h: number): Bitmap {
  // A near-black neutral with a subtle vignette: the middle one steel step lighter than the
  // corners (Phase 20 dropped the blue glow).
  const bmp = new Bitmap(w, h);
  const cx = w / 2;
  const cy = h * 0.45;
  const rx = Math.max(1, w * 0.62);
  const ry = Math.max(1, h * 0.72);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      put(bmp, x, y, (dx * dx + dy * dy < 1 ? STEEL[1] : STEEL[0]) as string);
    }
  }
  return bmp;
}

export interface DefaultSpriteBitmaps {
  note: Record<NoteHue, Bitmap>;
  holdBody: Record<NoteHue, Bitmap>;
  holdBodyHeld: Record<NoteHue, Bitmap>;
  holdCap: Record<NoteHue, Bitmap>;
  progressTrack: Bitmap;
  progressFill: Bitmap;
}

function perHue(make: (hue: NoteHue) => Bitmap): Record<NoteHue, Bitmap> {
  const out = {} as Record<NoteHue, Bitmap>;
  for (const hue of NOTE_HUES) out[hue] = make(hue);
  return out;
}

/** Every fixed-size sprite of the default skin. */
export function buildDefaultSprites(): DefaultSpriteBitmaps {
  return {
    note: perHue(noteBitmap),
    holdBody: perHue((h) => holdBodyBitmap(h, false)),
    holdBodyHeld: perHue((h) => holdBodyBitmap(h, true)),
    holdCap: perHue(holdCapBitmap),
    progressTrack: progressTrackBitmap(),
    progressFill: progressFillBitmap(),
  };
}

/** Judgement colours as used by the skin (re-exported for the colour table). */
export { JUDGEMENT_COLORS };
