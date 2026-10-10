/**
 * The particle sprite library (Phase 21): original pixel sprites made in code from palette
 * bitmaps. Every sprite is white-based with three luminance levels (1 dim, 2 mid, 3 white) and
 * transparency, so multiplying by a colour tints it cleanly. Hand-drawn shapes are text grids;
 * round ones (circle, ring, bubble, glow dot) are drawn from distance functions so they stay
 * symmetric. Sizes run from 5x5 to 16x16. Pure: the renderer turns them into canvases.
 *
 * Convention: a sprite with a direction (arrow, streak, raindrop, spark) points up (-y), so
 * "along the motion" rotates it by the velocity angle + 90 degrees.
 */

export const LIBRARY_SPRITE_IDS = [
  'square',
  'diamond',
  'cross',
  'plus',
  'circle',
  'ring',
  'triangle',
  'star4',
  'star5',
  'sparkle',
  'heart',
  'note',
  'snowflake',
  'petal',
  'leaf',
  'bubble',
  'ember',
  'dust',
  'raindrop',
  'streak',
  'arrow',
  'bolt',
  'hexagon',
  'spark',
] as const;
export type LibrarySpriteId = (typeof LIBRARY_SPRITE_IDS)[number];

export const SPRITE_LABELS: Readonly<Record<LibrarySpriteId, string>> = {
  square: 'Square',
  diamond: 'Diamond',
  cross: 'Cross',
  plus: 'Plus',
  circle: 'Circle',
  ring: 'Ring',
  triangle: 'Triangle',
  star4: '4-point star',
  star5: '5-point star',
  sparkle: 'Sparkle',
  heart: 'Heart',
  note: 'Music note',
  snowflake: 'Snowflake',
  petal: 'Petal',
  leaf: 'Leaf',
  bubble: 'Bubble',
  ember: 'Ember',
  dust: 'Dust',
  raindrop: 'Raindrop',
  streak: 'Streak',
  arrow: 'Arrow',
  bolt: 'Bolt',
  hexagon: 'Hexagon',
  spark: 'Spark',
};

/** A palette bitmap: `levels[y * w + x]` is 0 (transparent) or 1-3 (luminance level). */
export interface SpriteBitmap {
  w: number;
  h: number;
  levels: Uint8Array;
}

/** Grey value of each level (0 is transparent). */
export const LEVEL_GREY: readonly number[] = [0, 128, 200, 255];

function fromRows(rows: readonly string[]): SpriteBitmap {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const levels = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row.charCodeAt(x) - 48;
      levels[y * w + x] = c >= 1 && c <= 3 ? c : 0;
    }
  });
  return { w, h, levels };
}

/** A round sprite from a distance function: `level(d)` for each pixel centre's distance. */
function round(size: number, level: (d: number, dx: number, dy: number) => number): SpriteBitmap {
  const levels = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      levels[y * size + x] = level(Math.hypot(dx, dy), dx, dy);
    }
  }
  return { w: size, h: size, levels };
}

const ROWS: Partial<Record<LibrarySpriteId, readonly string[]>> = {
  square: ['22222', '23332', '23332', '23332', '22222'],
  diamond: ['...2...', '..232..', '.23332.', '2333332', '.23332.', '..232..', '...2...'],
  cross: ['2.....2', '.3...3.', '..3.3..', '...3...', '..3.3..', '.3...3.', '2.....2'],
  plus: ['...2...', '...3...', '...3...', '2333332', '...3...', '...3...', '...2...'],
  triangle: [
    '....3....',
    '...333...',
    '...332...',
    '..33332..',
    '..33332..',
    '.3333322.',
    '.3333322.',
    '222222222',
  ],
  star4: [
    '....3....',
    '....3....',
    '...232...',
    '..23332..',
    '333333333',
    '..23332..',
    '...232...',
    '....3....',
    '....3....',
  ],
  star5: [
    '.....3.....',
    '....333....',
    '....333....',
    '...33333...',
    '33333333333',
    '.333333332.',
    '..3333332..',
    '..3333322..',
    '.3333.3322.',
    '.333...322.',
    '.3.......2.',
  ],
  sparkle: [
    '....2....',
    '....3....',
    '..1.3.1..',
    '...232...',
    '233333332',
    '...232...',
    '..1.3.1..',
    '....3....',
    '....2....',
  ],
  heart: [
    '.33..33..',
    '333333333',
    '333333332',
    '333333332',
    '.3333332.',
    '..33332..',
    '...332...',
    '....2....',
  ],
  note: [
    '...333.',
    '...3233',
    '...3..3',
    '...3..2',
    '...3...',
    '...3...',
    '.333...',
    '33333..',
    '33332..',
    '.322...',
  ],
  snowflake: [
    '....3....',
    '.2..3..2.',
    '..3.3.3..',
    '...333...',
    '333323333',
    '...333...',
    '..3.3.3..',
    '.2..3..2.',
    '....3....',
  ],
  petal: [
    '.....233',
    '...23333',
    '..233332',
    '.233332.',
    '.33332..',
    '23332...',
    '3332....',
    '32......',
  ],
  leaf: [
    '......233',
    '....23333',
    '...233313',
    '..2331333',
    '.2313332.',
    '.313332..',
    '.13332...',
    '.1332....',
    '1........',
  ],
  ember: ['..2..', '.232.', '23332', '.232.', '..2..'],
  dust: ['.121.', '12321', '23332', '12321', '.121.'],
  raindrop: ['..2..', '..3..', '.232.', '.333.', '23332', '33332', '33332', '.332.', '..2..'],
  streak: ['.3.', '333', '.3.', '.3.', '.3.', '.2.', '.2.', '.2.', '.1.', '.1.', '.1.'],
  arrow: ['...3...', '..333..', '.33332.', '3333322', '..332..', '..332..', '..332..', '..222..'],
  bolt: [
    '....333',
    '...333.',
    '..333..',
    '.333...',
    '3333333',
    '3333333',
    '...333.',
    '..333..',
    '..33...',
    '.33....',
    '.3.....',
  ],
  hexagon: [
    '..33333..',
    '.3222223.',
    '322222223',
    '322232223',
    '322333223',
    '322232223',
    '.3222223.',
    '..33333..',
  ],
  spark: ['...3...', '.2.3.2.', '..333..', '3333333', '..333..', '.2.3.2.', '...3...'],
};

const cache = new Map<LibrarySpriteId, SpriteBitmap>();

/** A library sprite's palette bitmap (built once). */
export function librarySprite(id: LibrarySpriteId): SpriteBitmap {
  const have = cache.get(id);
  if (have) return have;
  let s: SpriteBitmap;
  switch (id) {
    case 'circle':
      s = round(7, (d) => (d <= 2.2 ? 3 : d <= 3.4 ? 2 : 0));
      break;
    case 'ring':
      s = round(11, (d) => (d >= 3.6 && d <= 4.6 ? 3 : d > 4.6 && d <= 5.3 ? 1 : 0));
      break;
    case 'bubble':
      // A thin rim, a faint inside and a highlight at the top left.
      s = round(16, (d, dx, dy) => {
        if (d > 7.6) return 0;
        if (d > 6.5) return 2;
        if (Math.hypot(dx + 2.6, dy + 2.6) < 1.5) return 3;
        return d > 5.6 ? 1 : 0;
      });
      break;
    default: {
      const rows = ROWS[id];
      s = rows ? fromRows(rows) : fromRows(['3']);
    }
  }
  cache.set(id, s);
  return s;
}

/** RGBA pixels of a palette bitmap (white-based grey levels, opaque where set). */
export function spriteRgba(s: SpriteBitmap): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(s.w * s.h * 4);
  for (let i = 0; i < s.levels.length; i++) {
    const level = s.levels[i] as number;
    if (level === 0) continue;
    const g = LEVEL_GREY[level] as number;
    out[i * 4] = g;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = g;
    out[i * 4 + 3] = 255;
  }
  return out;
}
