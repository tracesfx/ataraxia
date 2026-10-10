import { RAMPS } from '../theme';
import { Bitmap, Mask, maskFromRows, stamp } from './bitmap';
import { put } from './materials';

/**
 * The ataraxia logo, drawn in code as palette-indexed pixel art.
 *
 * Wordmark: custom lowercase letterforms ("a t r x i"), geometric with pixel-rounded corners,
 * hand-placed on the pixel grid in two sizes (large: 3-pixel strokes and a 20-pixel x-height;
 * small: 1-pixel strokes and an 8-pixel x-height). Letters are spaced evenly by their stroke
 * width. Shading: a vertical steel-to-accent ramp, a 1-pixel bright top highlight on every top
 * edge, and a 1-pixel shadow offset down and to the right.
 *
 * Mark: a gem resting on still water: a faceted diamond above a calm surface line and its dim
 * reflection below. It works alone as the favicon.
 */

const S = RAMPS.steel;
const A = RAMPS.accent;

type Glyph = readonly string[];

/** Large letterforms: x-height rows 6-25, ascender rows 0-5 (26 rows). */
const LARGE: Record<string, Glyph> = {
  a: [
    '.....###########',
    '...#############',
    '..##############',
    '.####........###',
    '.###.........###',
    ...Array<string>(10).fill('###..........###'),
    '.###.........###',
    '.####........###',
    '..##############',
    '...#############',
    '.....###########',
  ],
  t: [
    ...Array<string>(6).fill('..###.....'),
    ...Array<string>(3).fill('##########'),
    ...Array<string>(14).fill('..###.....'),
    '..########',
    '...#######',
    '.....#####',
  ],
  r: [
    '.....#######',
    '...#########',
    '..##########',
    '.####.......',
    '.###........',
    ...Array<string>(15).fill('###.........'),
  ],
  x: Array.from({ length: 20 }, (_, y) => {
    const s = Math.floor(y / 2);
    const row = Array<string>(13).fill('.');
    for (let i = 0; i < 4; i++) {
      row[s + i] = '#';
      row[12 - s - i] = '#';
    }
    return row.join('');
  }),
  i: ['###', '###', '###', '...', '...', '...', ...Array<string>(20).fill('###')],
};

/** Small letterforms: x-height rows 3-10, ascender rows 0-2 (11 rows). */
const SMALL: Record<string, Glyph> = {
  a: ['..#####', '.#....#', '#.....#', '#.....#', '#.....#', '#.....#', '.#....#', '..#####'],
  t: ['.#..', '.#..', '.#..', '####', '.#..', '.#..', '.#..', '.#..', '.#..', '.#..', '..##'],
  r: ['..###', '.#...', '#....', '#....', '#....', '#....', '#....', '#....'],
  x: ['#....#', '#....#', '.#..#.', '..##..', '..##..', '.#..#.', '#....#', '#....#'],
  i: ['#', '.', '.', '#', '#', '#', '#', '#', '#', '#', '#'],
};

const WORD = 'ataraxia';

export type LogoSize = 'large' | 'small';

interface Face {
  glyphs: Record<string, Glyph>;
  height: number;
  /** Rows above the x-height (x-height letters start here). */
  ascender: number;
  spacing: number;
}

const FACES: Record<LogoSize, Face> = {
  large: { glyphs: LARGE, height: 26, ascender: 6, spacing: 3 },
  small: { glyphs: SMALL, height: 11, ascender: 3, spacing: 2 },
};

/** The wordmark's shape (no shading). */
export function wordmarkMask(size: LogoSize): Mask {
  const face = FACES[size];
  const glyphs = [...WORD].map((ch) => maskFromRows(face.glyphs[ch] as Glyph));
  const width = glyphs.reduce((w, g) => w + g.w, 0) + face.spacing * (glyphs.length - 1);
  const mask = new Mask(width, face.height);
  let x = 0;
  for (const g of glyphs) {
    stamp(mask, g, x, face.height - g.h);
    x += g.w + face.spacing;
  }
  return mask;
}

/** Diamond over still water: `half` rows of gem, a gap row, then the reflection. */
export function markMask(half: number): Mask {
  const w = half * 2 - 1;
  const mask = new Mask(w, half * 2);
  const c = half - 1;
  for (let y = 0; y < half; y++) {
    for (let x = c - y; x <= c + y; x++) mask.set(x, y);
  }
  for (let k = 1; k < half; k++) {
    const y = half + k;
    const r = half - 1 - k;
    for (let x = c - r; x <= c + r; x++) mask.set(x, y);
  }
  return mask;
}

/** Shade a shape with the logo ramp: top highlight, vertical bands, shadow. */
function shadeWordmark(mask: Mask, bands: readonly string[], shadow: boolean): Bitmap {
  const bmp = new Bitmap(mask.w + (shadow ? 1 : 0), mask.h + (shadow ? 1 : 0));
  if (shadow) {
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (mask.has(x, y) && !mask.has(x + 1, y + 1)) put(bmp, x + 1, y + 1, A[0]);
      }
    }
  }
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (!mask.has(x, y)) continue;
      const band = bands[Math.min(bands.length - 1, Math.floor((y * bands.length) / mask.h))];
      put(bmp, x, y, mask.has(x, y - 1) ? (band as string) : S[8]);
    }
  }
  return bmp;
}

/** Paint the mark (gem + reflection) into `bmp` at (dx, dy). */
function paintMark(bmp: Bitmap, half: number, dx: number, dy: number): void {
  const mask = markMask(half);
  const c = half - 1;
  const gemLeft = [S[8], A[6], A[5], A[4]];
  const gemRight = [A[6], A[5], A[4], A[3]];
  const reflLeft = [A[3], A[2], A[2], A[1]];
  const reflRight = [A[2], A[1], A[1], A[0]];
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (!mask.has(x, y)) continue;
      const gem = y < half;
      const rows = gem ? half : half - 1;
      const t = gem ? y : y - half - 1;
      const i = Math.min(3, Math.floor((t * 4) / rows));
      const left = x <= c;
      const ramp = gem ? (left ? gemLeft : gemRight) : left ? reflLeft : reflRight;
      put(bmp, x + dx, y + dy, ramp[i] as string);
    }
  }
}

export type LogoVariant = 'large' | 'small' | 'mark';

/** Mark size (half height) per logo variant. */
const MARK_HALF: Record<LogoVariant, number> = { large: 10, small: 4, mark: 8 };

/**
 * The full logo as a bitmap. `large` and `small`: the mark followed by the wordmark, the mark
 * sitting on the wordmark's x-height. `mark`: the mark alone, 16x16 (favicon size).
 */
export function logoBitmap(variant: LogoVariant): Bitmap {
  if (variant === 'mark') {
    const bmp = new Bitmap(16, 16);
    paintMark(bmp, MARK_HALF.mark, 0, 0);
    return bmp;
  }
  const face = FACES[variant];
  const word = shadeWordmark(
    wordmarkMask(variant),
    variant === 'large' ? [S[8], S[7], A[6], A[5], A[4]] : [S[8], A[6], A[5], A[5]],
    true,
  );
  const half = MARK_HALF[variant];
  const markW = half * 2 - 1;
  const gap = face.spacing * 3;
  const bmp = new Bitmap(markW + gap + word.w, word.h);
  // The mark's water line sits just above the baseline row's middle: gem rows on the x-height.
  paintMark(bmp, half, 0, face.ascender);
  for (let y = 0; y < word.h; y++) {
    for (let x = 0; x < word.w; x++) {
      const c = word.get(x, y);
      if (c) bmp.set(x + markW + gap, y, c);
    }
  }
  return bmp;
}

/** Draw the logo into a canvas at (x, y), `scale` canvas pixels per art pixel. */
export function drawLogo(
  ctx: CanvasRenderingContext2D,
  variant: LogoVariant,
  x: number,
  y: number,
  scale = 1,
): void {
  const bmp = logoBitmap(variant);
  for (let py = 0; py < bmp.h; py++) {
    for (let px = 0; px < bmp.w; px++) {
      const c = bmp.get(px, py);
      if ((c & 255) === 0) continue;
      ctx.fillStyle = `rgba(${c >>> 24},${(c >>> 16) & 255},${(c >>> 8) & 255},${(c & 255) / 255})`;
      ctx.fillRect(x + px * scale, y + py * scale, scale, scale);
    }
  }
}
