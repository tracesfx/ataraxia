/**
 * The gameplay pixel grid. The canvas fills the whole window: each logical pixel is an exact
 * `scale` x `scale` block of device pixels, and the logical size follows the window, so there are
 * no letterbox bars. The scale is chosen so the logical height lands near PIXEL_TARGET_HEIGHT.
 */

/** Logical height the scale aims for. 270 gives the old chunky look; 540 is the default. */
export const PIXEL_TARGET_HEIGHT = 540;
/** Never fewer logical rows than this (smaller windows scale below 1x instead). */
export const MIN_LOGICAL_HEIGHT = 360;
/** Prefer scales that keep the height at or under this. */
export const MAX_LOGICAL_HEIGHT = 770;

/** The height bounds for a target: [360, 770] at 540, and proportionally for other targets. */
export function heightBounds(targetHeight: number): { min: number; max: number } {
  return {
    min: Math.round((targetHeight * MIN_LOGICAL_HEIGHT) / PIXEL_TARGET_HEIGHT),
    max: Math.round((targetHeight * MAX_LOGICAL_HEIGHT) / PIXEL_TARGET_HEIGHT),
  };
}

/** The field (256) plus a little room on each side. */
export const MIN_LOGICAL_WIDTH = 300;

export interface PixelLayout {
  /** Device pixels per logical pixel: an integer, or a fraction below 1 for tiny windows. */
  scale: number;
  /** Logical (drawing) resolution. */
  width: number;
  height: number;
  /** Canvas backing-store size in device pixels (the whole window). */
  deviceWidth: number;
  deviceHeight: number;
  /** Canvas size in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Where the scaled logical image starts inside the canvas, in device pixels. */
  offsetX: number;
  offsetY: number;
}

/**
 * The integer scale s whose logical height floor(devH / s) is closest to `targetHeight` in log
 * terms, among the scales that keep the height within `bounds` and the width at least
 * MIN_LOGICAL_WIDTH (heights above the upper bound only win when nothing else fits); 0 if none.
 */
function pickScale(
  devW: number,
  devH: number,
  bounds: { min: number; max: number },
  targetHeight: number,
): number {
  let best = 0;
  let bestScore = Infinity;
  const maxScale = Math.floor(devH / bounds.min);
  for (let s = 1; s <= maxScale; s++) {
    const h = Math.floor(devH / s);
    const w = Math.floor(devW / s);
    if (h < bounds.min || w < MIN_LOGICAL_WIDTH) continue;
    const score = Math.abs(Math.log(h / targetHeight)) + (h > bounds.max ? 100 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/**
 * Choose the integer scale (see `pickScale`) and the logical size that fills the viewport. With
 * `scaleCssHeight` given (the height the viewport would have outside fullscreen, see
 * `windowedViewportHeight`), the scale is picked for that height, so going fullscreen keeps the
 * sizes of the windowed view; the scale is only re-picked for the real viewport if it doesn't
 * fit it. When even s = 1 is too small, the image is scaled below 1x. Pure, so it can be unit
 * tested.
 */
export function computePixelLayout(
  viewportCssWidth: number,
  viewportCssHeight: number,
  devicePixelRatio: number,
  targetHeight = PIXEL_TARGET_HEIGHT,
  scaleCssHeight: number | null = null,
): PixelLayout {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const devW = Math.max(1, Math.floor(viewportCssWidth * dpr));
  const devH = Math.max(1, Math.floor(viewportCssHeight * dpr));

  const bounds = heightBounds(targetHeight);
  let best = 0;
  if (scaleCssHeight !== null && scaleCssHeight > 0 && scaleCssHeight < viewportCssHeight) {
    const s = pickScale(devW, Math.floor(scaleCssHeight * dpr), bounds, targetHeight);
    if (s > 0 && Math.floor(devW / s) >= MIN_LOGICAL_WIDTH) best = s;
  }
  if (best === 0) best = pickScale(devW, devH, bounds, targetHeight);

  let scale: number;
  let width: number;
  let height: number;
  if (best > 0) {
    scale = best;
    width = Math.floor(devW / scale);
    height = Math.floor(devH / scale);
  } else {
    // Too small for 1x: shrink fractionally so the whole field stays visible.
    scale = Math.min(1, devH / bounds.min, devW / MIN_LOGICAL_WIDTH);
    width = Math.max(1, Math.floor(devW / scale));
    height = Math.max(1, Math.floor(devH / scale));
  }
  const usedW = Math.round(width * scale);
  const usedH = Math.round(height * scale);
  return {
    scale,
    width,
    height,
    deviceWidth: devW,
    deviceHeight: devH,
    cssWidth: devW / dpr,
    cssHeight: devH / dpr,
    offsetX: Math.floor((devW - usedW) / 2),
    offsetY: Math.floor((devH - usedH) / 2),
  };
}
