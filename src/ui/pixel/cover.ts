import { RAMPS, type Tone } from '../theme';
import { Bitmap } from './bitmap';
import { put } from './materials';

/**
 * Generated placeholder cover art (real covers arrive in Phase 10): a deterministic gradient of
 * flat ramp bands chosen from the title's hash, with a soft round light pool. The first letter of
 * the title is laid over it in the pixel font by the CoverArt component.
 */

/** FNV-1a hash of a string (32-bit). */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const COVER_TONES: readonly Tone[] = ['accent', 'success', 'warning', 'danger', 'steel'];

export interface CoverStyle {
  tone: Tone;
  /** Gradient direction, one of 4 diagonals/axes. */
  direction: 0 | 1 | 2 | 3;
  /** Light pool centre in 0-1 cover coordinates. */
  poolX: number;
  poolY: number;
}

export function coverStyle(title: string): CoverStyle {
  const h = hashString(title.trim().toLowerCase() || '?');
  return {
    tone: COVER_TONES[h % COVER_TONES.length] as Tone,
    direction: ((h >>> 8) % 4) as CoverStyle['direction'],
    poolX: 0.2 + (((h >>> 12) & 255) / 255) * 0.6,
    poolY: 0.2 + (((h >>> 20) & 255) / 255) * 0.5,
  };
}

/** The ramp a cover tone paints with (dark to light, at least 6 steps). */
function coverRamp(tone: Tone): readonly string[] {
  const S = RAMPS.steel;
  switch (tone) {
    case 'steel':
      return [S[1], S[2], S[3], S[4], S[5], S[6]];
    case 'accent':
      return RAMPS.accent.slice(0, 6);
    default: {
      const t = RAMPS[tone];
      return [S[1], t[0], t[1], S[4], t[2], t[3]] as const;
    }
  }
}

/** A `size`x`size` placeholder cover for a title. */
export function coverBitmap(title: string, size: number): Bitmap {
  const style = coverStyle(title);
  const ramp = coverRamp(style.tone);
  const bmp = new Bitmap(size, size);
  const n = size - 1 || 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / n;
      const v = y / n;
      const g = [(u + v) / 2, (1 - u + v) / 2, v, 1 - (u + 1 - v) / 2][style.direction] as number;
      // Base: four bands from dark to mid along the gradient.
      let level = Math.min(3, Math.floor(g * 4));
      // Light pool: up to two brighter bands in a circle.
      const d = Math.hypot(u - style.poolX, v - style.poolY);
      if (d < 0.22) level = Math.max(level, 5);
      else if (d < 0.36) level = Math.max(level, 4);
      put(bmp, x, y, ramp[level] as string);
    }
  }
  return bmp;
}
