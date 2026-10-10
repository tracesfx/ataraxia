/**
 * Small colour helpers for the UI palette: hex parsing, packed RGBA pixels, and WCAG luminance
 * and contrast. Pure (no DOM), so the palette rules can be unit tested.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** "#rrggbb" -> 0-255 channels. Throws on anything else (palette entries are always 6-digit). */
export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`"${hex}" is not a #rrggbb colour.`);
  const n = parseInt(m[1] as string, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** A pixel as one unsigned 32-bit number, 0xRRGGBBAA (alpha 0-255). 0 is fully transparent. */
export type PackedRgba = number;

export function pack(hex: string, alpha = 1): PackedRgba {
  const { r, g, b } = parseHex(hex);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

export function unpack(c: PackedRgba): { hex: string; alpha: number } {
  return {
    hex: toHex({ r: (c >>> 24) & 255, g: (c >>> 16) & 255, b: (c >>> 8) & 255 }),
    alpha: (c & 255) / 255,
  };
}

/** WCAG 2.x relative luminance of a colour. */
export function relativeLuminance(hex: string): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const { r, g, b } = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours (1-21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `top` at `alpha` composited over an opaque `bottom`, as a hex colour. */
export function over(top: string, alpha: number, bottom: string): string {
  const t = parseHex(top);
  const b = parseHex(bottom);
  const mix = (x: number, y: number): number => Math.round(x * alpha + y * (1 - alpha));
  return toHex({ r: mix(t.r, b.r), g: mix(t.g, b.g), b: mix(t.b, b.b) });
}
