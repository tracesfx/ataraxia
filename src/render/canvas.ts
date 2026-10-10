import type { Bitmap } from '../ui/pixel/bitmap';

/** Small DOM helpers for offscreen canvases (sprites, atlases, cached layers). */

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Copy a packed-RGBA bitmap into `canvas` (resized to fit) or a new canvas. */
export function bitmapCanvas(bmp: Bitmap, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const out = canvas ?? createCanvas(bmp.w, bmp.h);
  if (out.width !== bmp.w) out.width = bmp.w;
  if (out.height !== bmp.h) out.height = bmp.h;
  const ctx = context2d(out);
  const img = ctx.createImageData(bmp.w, bmp.h);
  const data = img.data;
  for (let i = 0; i < bmp.data.length; i++) {
    const c = bmp.data[i] ?? 0;
    data[i * 4] = c >>> 24;
    data[i * 4 + 1] = (c >>> 16) & 255;
    data[i * 4 + 2] = (c >>> 8) & 255;
    data[i * 4 + 3] = c & 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}
