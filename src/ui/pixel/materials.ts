import { RAMPS, type Ramp } from '../theme';
import { distanceField, type Bitmap, type Mask } from './bitmap';
import { pack } from './color';

/**
 * The three UI materials, each defined once and reused by every sprite:
 *
 * - steel: a vertical gradient of 5-6 flat bands, a bright 1-pixel top highlight, a darker
 *   1-pixel bottom edge, a subtle inner bevel (lighter left column, darker right column), a small
 *   diagonal specular glint near the top-left corner, and an outline one tone darker than the
 *   face in the same ramp.
 * - glass: a translucent dark fill, a 1-pixel light top edge and a faint inner border.
 * - accent: steel built from the accent ramp, plus a soft glow of stepped translucent rings.
 */

export interface SteelSpec {
  outline: string;
  /** Top interior row. */
  highlight: string;
  /** Bottom interior row. */
  bottom: string;
  /** Face bands, top to bottom (5-6 entries). */
  bands: readonly string[];
  /** Left interior column (inner bevel), or null for none. */
  bevelLight: string | null;
  /** Right interior column (inner bevel), or null for none. */
  bevelDark: string | null;
  /** Colour of the diagonal glint near the top-left corner, or null for none. */
  glint: string | null;
  /** Opacity of the whole material (1 for buttons). */
  alpha?: number;
}

/**
 * A steel spec from ramp indices: `face` lists the band indices top to bottom, and the bevel
 * uses the band just above/below in the ramp.
 */
export function steelFrom(
  ramp: Ramp,
  o: {
    outline: number;
    highlight: number | string;
    bottom: number;
    bands: readonly number[];
    glint?: string | null;
    bevel?: boolean;
    alpha?: number;
  },
): SteelSpec {
  const at = (i: number): string => ramp[Math.max(0, Math.min(ramp.length - 1, i))] as string;
  const mid = o.bands[Math.floor(o.bands.length / 2)] ?? 0;
  const bevel = o.bevel ?? true;
  return {
    outline: at(o.outline),
    highlight: typeof o.highlight === 'string' ? o.highlight : at(o.highlight),
    bottom: at(o.bottom),
    bands: o.bands.map(at),
    bevelLight: bevel ? at(mid + 1) : null,
    bevelDark: bevel ? at(mid - 1) : null,
    glint: o.glint === undefined ? RAMPS.steel[8] : o.glint,
    ...(o.alpha === undefined ? {} : { alpha: o.alpha }),
  };
}

/** Paint the steel material on `mask` (bands follow the mask's bounding box). */
export function paintSteel(bmp: Bitmap, mask: Mask, spec: SteelSpec): void {
  const b = mask.bounds();
  if (!b) return;
  const alpha = spec.alpha ?? 1;
  const top = b.y0 + 1;
  const bottom = b.y1 - 1;
  const bandRows = Math.max(1, bottom - top - 1);
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (!mask.has(x, y)) continue;
      let hex: string;
      if (mask.isEdge(x, y)) hex = spec.outline;
      else if (y === top) hex = spec.highlight;
      else if (y === bottom) hex = spec.bottom;
      else if (spec.bevelLight && mask.isEdge(x - 1, y)) hex = spec.bevelLight;
      else if (spec.bevelDark && mask.isEdge(x + 1, y)) hex = spec.bevelDark;
      else {
        const i = Math.floor(((y - top - 1) * spec.bands.length) / bandRows);
        hex = spec.bands[Math.min(spec.bands.length - 1, Math.max(0, i))] as string;
      }
      put(bmp, x, y, hex, alpha);
    }
  }
  if (spec.glint) {
    // Three pixels on a diagonal, inside the top-left corner (within a 6-pixel slice).
    for (const [gx, gy] of [
      [b.x0 + 2, b.y0 + 4],
      [b.x0 + 3, b.y0 + 3],
      [b.x0 + 4, b.y0 + 2],
    ] as const) {
      if (mask.has(gx, gy) && !mask.isEdge(gx, gy)) put(bmp, gx, gy, spec.glint, alpha);
    }
  }
}

export interface GlassSpec {
  fill: string;
  fillAlpha: number;
  outline: string;
  outlineAlpha: number;
  /** The light top edge (replaces the outline on the top row). */
  topEdge: string;
  /** Faint ring just inside the outline. */
  inner: string;
  innerAlpha: number;
}

export function paintGlass(bmp: Bitmap, mask: Mask, spec: GlassSpec): void {
  const b = mask.bounds();
  if (!b) return;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (!mask.has(x, y)) continue;
      if (mask.isEdge(x, y)) {
        const topRow = !mask.has(x, y - 1);
        if (topRow) put(bmp, x, y, spec.topEdge);
        else put(bmp, x, y, spec.outline, spec.outlineAlpha);
      } else if (isInnerRing(mask, x, y)) {
        put(bmp, x, y, spec.inner, spec.innerAlpha);
      } else {
        put(bmp, x, y, spec.fill, spec.fillAlpha);
      }
    }
  }
}

/** Next to an edge pixel (8-neighbourhood) but not an edge itself. */
function isInnerRing(mask: Mask, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && mask.isEdge(x + dx, y + dy)) return true;
    }
  }
  return false;
}

/**
 * Stepped glow: ring k (k = 1..rings.length) covers the pixels outside the mask whose distance
 * is at most k. No blur: each ring is one flat translucent colour.
 */
export function paintGlow(
  bmp: Bitmap,
  mask: Mask,
  rings: readonly (readonly [hex: string, alpha: number])[],
): void {
  const dist = distanceField(mask);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const d = dist[y * mask.w + x] ?? Infinity;
      if (d === 0) continue;
      const k = Math.ceil(d - 0.001);
      const ring = rings[k - 1];
      if (ring) put(bmp, x, y, ring[0], ring[1]);
    }
  }
}

/**
 * The keyboard focus ring: a 1-pixel accent line `gap + 1` pixels outside the mask. Using the
 * Euclidean distance leaves the corner pixels out, which gives the ring its corner notches.
 */
export function paintRing(bmp: Bitmap, mask: Mask, hex: string, gap = 1): void {
  const dist = distanceField(mask);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const d = dist[y * mask.w + x] ?? Infinity;
      if (d > gap + 0.001 && d <= gap + 1.001) put(bmp, x, y, hex);
    }
  }
}

/** Write one palette colour (with alpha) at (x, y). */
export function put(bmp: Bitmap, x: number, y: number, hex: string, alpha = 1): void {
  bmp.set(x, y, pack(hex, alpha));
}
