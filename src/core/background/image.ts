/**
 * Picture background geometry (pure): the size a stored background picture is shrunk to and the
 * cover-fit and contain-fit rectangles for a screen (the ken burns motion is in effects.ts).
 */

/** Stored background pictures fit inside this box (aspect kept, never enlarged). */
export const BACKGROUND_IMAGE_MAX_W = 1920;
export const BACKGROUND_IMAGE_MAX_H = 1080;
/** Largest picture file accepted for a background. */
export const MAX_BACKGROUND_FILE_BYTES = 25 * 1024 * 1024;
/** Largest stored (encoded) background picture; bigger encodes are retried smaller. */
export const MAX_BACKGROUND_STORED_BYTES = 3 * 1024 * 1024;

/** Whole-pixel size of `w`x`h` shrunk to fit inside `maxW`x`maxH` (aspect kept, never enlarged). */
export function fitWithin(
  w: number,
  h: number,
  maxW = BACKGROUND_IMAGE_MAX_W,
  maxH = BACKGROUND_IMAGE_MAX_H,
): { width: number; height: number } {
  if (!(w > 0 && h > 0)) return { width: 0, height: 0 };
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Each step of a smooth downscale halves at most (no aliasing); ends at `to`. */
export function halvingSteps(from: number, to: number): number[] {
  const steps: number[] = [];
  let v = from;
  while (v / 2 > to) {
    v = Math.round(v / 2);
    steps.push(v);
  }
  steps.push(to);
  return steps;
}

export interface SourceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of a `srcW`x`srcH` picture shown on a `dstW`x`dstH` screen: cover fit (fills the
 * screen, cropping the overflow), zoomed in by `zoom` (>= 1) around the centre moved by `panX`,
 * `panY` (-1..1 of the free room). Always inside the picture.
 */
export function coverFitRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  zoom = 1,
  panX = 0,
  panY = 0,
  out: SourceRect = { x: 0, y: 0, w: 0, h: 0 },
): SourceRect {
  const dstAspect = dstW / Math.max(1, dstH);
  let w = srcW;
  let h = srcW / dstAspect;
  if (h > srcH) {
    h = srcH;
    w = srcH * dstAspect;
  }
  const z = Math.max(1, zoom);
  w /= z;
  h /= z;
  const roomX = (srcW - w) / 2;
  const roomY = (srcH - h) / 2;
  const px = Math.min(1, Math.max(-1, panX));
  const py = Math.min(1, Math.max(-1, panY));
  out.x = roomX + px * roomX;
  out.y = roomY + py * roomY;
  out.w = w;
  out.h = h;
  return out;
}

/**
 * Contain fit: where a `srcW`x`srcH` picture lands on a `dstW`x`dstH` screen when it is shown
 * whole (letterboxed), zoomed by `zoom` around the centre.
 */
export function containFitRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  zoom = 1,
  out: SourceRect = { x: 0, y: 0, w: 0, h: 0 },
): SourceRect {
  const s = Math.min(dstW / Math.max(1, srcW), dstH / Math.max(1, srcH)) * Math.max(0.1, zoom);
  out.w = srcW * s;
  out.h = srcH * s;
  out.x = (dstW - out.w) / 2;
  out.y = (dstH - out.h) / 2;
  return out;
}
