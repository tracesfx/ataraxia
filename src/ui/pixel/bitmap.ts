import { pack, type PackedRgba } from './color';

/**
 * Art-pixel rasters for the UI art. Everything here is pure: sprites are built as `Mask`s
 * (shapes) and painted into `Bitmap`s (packed RGBA) from palette colours, then turned into PNGs by
 * `render.ts` in the browser. Tests read the bitmaps directly.
 */

/** A 1-bit shape. Reads outside the bounds are "outside". */
export class Mask {
  readonly data: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h);
  }

  has(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.data[y * this.w + x] === 1;
  }

  set(x: number, y: number, on = true): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data[y * this.w + x] = on ? 1 : 0;
  }

  /** Inside and touching the outside on one of its four sides. */
  isEdge(x: number, y: number): boolean {
    return (
      this.has(x, y) &&
      (!this.has(x - 1, y) || !this.has(x + 1, y) || !this.has(x, y - 1) || !this.has(x, y + 1))
    );
  }

  /** Bounding box of the set pixels, or null when empty. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = this.w;
    let y0 = this.h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!this.has(x, y)) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }

  count(): number {
    let n = 0;
    for (const v of this.data) n += v;
    return n;
  }
}

/** Pixels left out per row, from the corner inwards (e.g. [2, 1]). */
export type CornerProfile = readonly number[];

export interface Corners {
  tl: CornerProfile;
  tr: CornerProfile;
  br: CornerProfile;
  bl: CornerProfile;
}

export function corners(all: CornerProfile): Corners {
  return { tl: all, tr: all, br: all, bl: all };
}

export const SQUARE: Corners = corners([]);

/**
 * Profile of a pixel-rounded corner of radius `r` (for large shapes such as the rank letters):
 * row i leaves out the pixels whose centres lie outside the circle.
 */
export function roundProfile(r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < r; i++) {
    const dy = r - i - 0.5;
    const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
    out.push(Math.max(0, Math.round(r - dx)));
  }
  return out;
}

/** Is (px, py) inside the rectangle (x, y, w, h) with the given corner profiles? */
function inRRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  c: Corners,
): boolean {
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  const top = py - y;
  const bottom = y + h - 1 - py;
  const left = px - x;
  const right = x + w - 1 - px;
  const skip = (profile: CornerProfile, row: number): number => profile[row] ?? 0;
  if (left < skip(c.tl, top) || right < skip(c.tr, top)) return false;
  if (left < skip(c.bl, bottom) || right < skip(c.br, bottom)) return false;
  return true;
}

/** Add (or with `on` false, cut away) a rounded rectangle. */
export function rrect(
  mask: Mask,
  x: number,
  y: number,
  w: number,
  h: number,
  c: Corners = SQUARE,
  on = true,
): Mask {
  for (let py = Math.max(0, y); py < Math.min(mask.h, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(mask.w, x + w); px++) {
      if (inRRect(px, py, x, y, w, h, c)) mask.set(px, py, on);
    }
  }
  return mask;
}

/** A mask from text rows: '#' (or any non-space, non-'.') is inside. */
export function maskFromRows(rows: readonly string[]): Mask {
  const w = Math.max(...rows.map((r) => r.length));
  const mask = new Mask(w, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch !== '.' && ch !== ' ') mask.set(x, y);
    }
  });
  return mask;
}

/** Copy `src` into `dst` at (dx, dy) (union). */
export function stamp(dst: Mask, src: Mask, dx: number, dy: number): void {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) if (src.has(x, y)) dst.set(x + dx, y + dy);
  }
}

/**
 * Euclidean distance (in pixels, between centres) from each pixel to the nearest pixel of the
 * mask; 0 inside. Brute force: the UI masks are tiny.
 */
export function distanceField(mask: Mask): Float32Array {
  const inside: [number, number][] = [];
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) if (mask.has(x, y)) inside.push([x, y]);
  }
  const out = new Float32Array(mask.w * mask.h).fill(Infinity);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (mask.has(x, y)) {
        out[y * mask.w + x] = 0;
        continue;
      }
      let best = Infinity;
      for (const [ix, iy] of inside) {
        const d = (ix - x) ** 2 + (iy - y) ** 2;
        if (d < best) best = d;
      }
      out[y * mask.w + x] = Math.sqrt(best);
    }
  }
  return out;
}

/** Packed-RGBA raster (0xRRGGBBAA per pixel, straight alpha). */
export class Bitmap {
  readonly data: Uint32Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint32Array(w * h);
  }

  get(x: number, y: number): PackedRgba {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[y * this.w + x] ?? 0;
  }

  set(x: number, y: number, c: PackedRgba): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data[y * this.w + x] = c;
  }

  /** Set a palette colour (with alpha) on every pixel of `mask` offset by (dx, dy). */
  paint(mask: Mask, hex: string, alpha = 1, dx = 0, dy = 0): void {
    const c = pack(hex, alpha);
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) if (mask.has(x, y)) this.set(x + dx, y + dy, c);
    }
  }

  /** Every distinct non-transparent pixel value. */
  colours(): Set<PackedRgba> {
    const out = new Set<PackedRgba>();
    for (const c of this.data) if ((c & 255) !== 0) out.add(c);
    return out;
  }
}

/** Nearest-neighbour integer upscale (favicons). */
export function upscale(src: Bitmap, factor: number): Bitmap {
  const out = new Bitmap(src.w * factor, src.h * factor);
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      out.set(x, y, src.get(Math.floor(x / factor), Math.floor(y / factor)));
    }
  }
  return out;
}
