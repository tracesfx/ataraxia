/**
 * Colour helpers for backgrounds (pure): hex <-> RGB, WCAG luminance, alpha compositing and hue.
 * Kept in src/core so palette extraction and the readability clamp can be unit tested.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`"${hex}" is not a #rrggbb colour.`);
  const n = parseInt(m[1] as string, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));
  return `#${((1 << 24) | (c(r) << 16) | (c(g) << 8) | c(b)).toString(16).slice(1)}`;
}

const lin = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance (0-1) of 0-255 channels. */
export function luminance(c: Rgb): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function hexLuminance(hex: string): number {
  return luminance(hexToRgb(hex));
}

/** `top` at `alpha` over an opaque `bottom` (plain sRGB blending, as canvas 2D does). */
export function blend(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: bottom.r + (top.r - bottom.r) * a,
    g: bottom.g + (top.g - bottom.g) * a,
    b: bottom.b + (top.b - bottom.b) * a,
  };
}

/** Hue in degrees (0-360), saturation and lightness (0-1). */
export function rgbToHsl(c: Rgb): { h: number; s: number; l: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: Math.min(1, s), l };
}

/** Shortest distance between two hues in degrees (0-180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
