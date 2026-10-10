import type { Bitmap, Mask } from './bitmap';
import { coverBitmap } from './cover';
import { iconMask } from './icons';
import { logoBitmap, type LogoVariant } from './logo';
import { rankBitmap } from './rank';
import type { Rank } from '../../core/results';

/**
 * Browser half of the pixel art: bitmaps become PNG data URLs (cached), at art-pixel resolution.
 * CSS scales them by `--px` with `image-rendering: pixelated`.
 */

export function bitmapToCanvas(bmp: Bitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bmp.w;
  canvas.height = bmp.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
  const img = ctx.createImageData(bmp.w, bmp.h);
  for (let i = 0; i < bmp.data.length; i++) {
    const c = bmp.data[i] ?? 0;
    img.data[i * 4] = c >>> 24;
    img.data[i * 4 + 1] = (c >>> 16) & 255;
    img.data[i * 4 + 2] = (c >>> 8) & 255;
    img.data[i * 4 + 3] = c & 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function bitmapToDataUrl(bmp: Bitmap): string {
  return bitmapToCanvas(bmp).toDataURL('image/png');
}

/** A 1-bit mask as an opaque-white-on-transparent PNG (for CSS `mask-image`). */
export function maskToDataUrl(mask: Mask): string {
  const canvas = document.createElement('canvas');
  canvas.width = mask.w;
  canvas.height = mask.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
  ctx.fillStyle = '#dce3ee';
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) if (mask.has(x, y)) ctx.fillRect(x, y, 1, 1);
  }
  return canvas.toDataURL('image/png');
}

const cache = new Map<string, string>();

function cached(key: string, make: () => string): string {
  let url = cache.get(key);
  if (url === undefined) {
    url = make();
    cache.set(key, url);
  }
  return url;
}

/** Icon mask URL, or '' for an unknown icon. */
export function iconUrl(name: string): string {
  return cached(`icon:${name}`, () => {
    const mask = iconMask(name);
    return mask ? maskToDataUrl(mask) : '';
  });
}

export function logoUrl(variant: LogoVariant): string {
  return cached(`logo:${variant}`, () => bitmapToDataUrl(logoBitmap(variant)));
}

export function rankUrl(rank: Rank): string {
  return cached(`rank:${rank}`, () => bitmapToDataUrl(rankBitmap(rank)));
}

/** Placeholder cover (cached per title and size; covers are small). */
export function coverUrl(title: string, size: number): string {
  return cached(`cover:${size}:${title}`, () => bitmapToDataUrl(coverBitmap(title, size)));
}
