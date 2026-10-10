import { halvingSteps } from '../../core/background/image';

/**
 * Picture helpers for backgrounds (browser only): decoding, canvases and the smooth downscale
 * (halving steps, so nothing aliases) used before a picture is fitted to the render size.
 */

export type AnySource = HTMLCanvasElement | ImageBitmap;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

export function decodePicture(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/**
 * A copy of `src` shrunk smoothly (halving steps) so it just covers `w`x`h`; the source itself
 * when it is already about that small.
 */
export function coverScaled(src: AnySource, w: number, h: number, margin = 1): AnySource {
  const scale = Math.max(w / src.width, h / src.height) * margin;
  if (scale >= 0.75) return src;
  const tw = Math.max(1, Math.round(src.width * scale));
  let stage: AnySource = src;
  for (const step of halvingSteps(src.width, tw)) {
    const c = makeCanvas(step, Math.max(1, Math.round((step * src.height) / src.width)));
    ctx2d(c).drawImage(stage, 0, 0, c.width, c.height);
    stage = c;
  }
  return stage;
}
