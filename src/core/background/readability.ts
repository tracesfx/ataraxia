import { blend, hexToRgb, luminance, type Rgb } from './color';

/**
 * The readability guarantee: whatever a background draws, notes stay readable. Two layers go over
 * the background, both in the darkest steel:
 * 1. the dim layer over the whole background (player setting, 0-90 %, default 55 %);
 * 2. a luminance clamp over the columns behind the lanes: an extra dark layer just strong enough
 *    that the brightest colour the background can show there ends up no brighter than
 *    LANE_MAX_LUMINANCE (before the field's own glass, which darkens it further).
 */

export const DIM_MIN = 0;
export const DIM_MAX = 0.9;
export const DEFAULT_DIM = 0.55;

/** Brightest the background may be behind the lanes (relative luminance, ~steel[4]). */
export const LANE_MAX_LUMINANCE = 0.045;

export function clampDim(v: unknown, fallback = DEFAULT_DIM): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(DIM_MAX, Math.max(DIM_MIN, v))
    : fallback;
}

/**
 * Smallest alpha of `overlay` over `colour` that brings its luminance down to `target` (0 when it
 * already is). Exact for canvas sRGB blending, found by bisection (luminance falls as alpha rises
 * when the overlay is darker than the target).
 */
export function clampAlpha(colour: Rgb, overlay: Rgb, target: number): number {
  if (luminance(colour) <= target) return 0;
  if (luminance(overlay) > target) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(blend(overlay, mid, colour)) > target) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface ReadabilityLayers {
  /** Alpha of the dim layer over everything. */
  dimAlpha: number;
  /** Alpha of the extra layer behind the lanes, over the dimmed background. */
  laneAlpha: number;
}

/**
 * Both layers for a background whose brightest possible colour is `brightest` (hex), with the
 * overlay colour `overlayHex` (the darkest steel) and the player's dim.
 */
export function readabilityLayers(
  brightest: string,
  overlayHex: string,
  dim: number,
  target = LANE_MAX_LUMINANCE,
): ReadabilityLayers {
  const dimAlpha = clampDim(dim);
  const overlay = hexToRgb(overlayHex);
  const dimmed = blend(overlay, dimAlpha, hexToRgb(brightest));
  return { dimAlpha, laneAlpha: clampAlpha(dimmed, overlay, target) };
}

/** The colour `hex` ends up as behind the lanes after both layers. */
export function afterLayers(hex: string, overlayHex: string, layers: ReadabilityLayers): Rgb {
  const overlay = hexToRgb(overlayHex);
  return blend(overlay, layers.laneAlpha, blend(overlay, layers.dimAlpha, hexToRgb(hex)));
}
