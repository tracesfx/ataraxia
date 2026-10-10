import type { Rank } from '../../core/results';
import { RANK_RAMPS, RAMPS, type Ramp } from '../theme';
import { Bitmap, Mask, roundProfile, rrect, type Corners } from './bitmap';
import { put } from './materials';

/**
 * Large metallic rank letters (S A B C D) for the results screen, built from rounded-rectangle
 * shapes on the pixel grid and shaded like polished metal: vertical bands of the rank's own ramp,
 * a bright edge where light hits (top and left), a darker edge on the bottom and right, an outline
 * in the ramp's darkest tone, a diagonal glint and a 1-pixel drop shadow.
 */

export const RANK_W = 34;
export const RANK_H = 44;
const STROKE = 8;
const R = 11;
const r = R - STROKE + 2;

const round = (n: number): number[] => roundProfile(n);
const cs = (tl: number, tr: number, br: number, bl: number): Corners => ({
  tl: round(tl),
  tr: round(tr),
  br: round(br),
  bl: round(bl),
});

function letterMask(rank: Rank): Mask {
  const W = RANK_W;
  const H = RANK_H;
  const s = STROKE;
  const m = new Mask(W, H);
  switch (rank) {
    case 'D':
      rrect(m, 0, 0, W, H, cs(0, R + 4, R + 4, 0));
      rrect(m, s, s, W - 2 * s, H - 2 * s, cs(0, r + 2, r + 2, 0), false);
      break;
    case 'C': {
      rrect(m, 0, 0, W, H, cs(R + 2, R + 2, R + 2, R + 2));
      rrect(m, s, s, W - 2 * s, H - 2 * s, cs(r, r, r, r), false);
      const gap = Math.round(H * 0.2);
      rrect(m, W - s, s + gap, s, H - 2 * (s + gap), cs(0, 0, 0, 0), false);
      rrect(m, Math.floor(W / 2), s, W, H - 2 * s, cs(0, 0, 0, 0), false);
      rrect(m, Math.floor(W / 2), s - 1, W, 1, cs(0, 0, 0, 0), false);
      // Keep the terminals: re-add the top and bottom bars up to the right edge.
      rrect(m, s, 0, W - s, s, cs(0, R + 2, 0, 0));
      rrect(m, s, H - s, W - s, s, cs(0, 0, R + 2, 0));
      rrect(m, W - s, s, s, gap, cs(0, 0, 0, 0));
      rrect(m, W - s, H - s - gap, s, gap, cs(0, 0, 0, 0));
      break;
    }
    case 'B': {
      const mid = Math.floor(H / 2);
      const topW = W - 3;
      rrect(m, 0, 0, topW, mid + s / 2, cs(0, R, R - 2, 0));
      rrect(m, 0, mid - s / 2, W, H - mid + s / 2, cs(0, R - 2, R, 0));
      rrect(m, s, s, topW - 2 * s, mid - s / 2 - s, cs(0, r, r, 0), false);
      rrect(m, s, mid + s / 2, W - 2 * s, H - mid - s / 2 - s, cs(0, r, r, 0), false);
      break;
    }
    case 'A': {
      const bar = Math.round(H * 0.56);
      rrect(m, 0, 0, W, H, cs(R + 6, R + 6, 0, 0));
      rrect(m, s, s, W - 2 * s, bar - s, cs(r + 4, r + 4, 0, 0), false);
      rrect(m, s, bar + s - 1, W - 2 * s, H, cs(0, 0, 0, 0), false);
      break;
    }
    case 'S': {
      const mid = Math.floor(H / 2);
      const half = s / 2;
      // Top half: top bar, left stem and middle bar.
      rrect(m, 0, 0, W, mid + half, cs(R, R, 0, R - 3));
      rrect(m, s, s, W - s, mid + half - 2 * s, cs(r, 0, 0, r), false);
      // A short terminal under the top bar's right end.
      rrect(m, W - s, s, s, 3, cs(0, 0, 0, 0));
      // Bottom half: middle bar, right stem and bottom bar.
      rrect(m, 0, mid - half, W, H - mid + half, cs(0, R - 3, R, R));
      rrect(m, 0, mid + half, W - s, H - mid - half - s, cs(0, r, r, 0), false);
      rrect(m, 0, H - s - 3, s, 3, cs(0, 0, 0, 0));
      // Fill the joints the cut-outs opened.
      rrect(m, 0, mid - half, s, s, cs(0, 0, 0, 0));
      rrect(m, W - s, mid - half, s, s, cs(0, 0, 0, 0));
      break;
    }
  }
  return m;
}

/** Shade a letter mask with a ramp (darkest first) into a bitmap with outline and shadow. */
function shade(mask: Mask, ramp: Ramp): Bitmap {
  // One pixel of outline around the letter, one more for the shadow.
  const pad = 1;
  const bmp = new Bitmap(mask.w + pad * 2 + 1, mask.h + pad * 2 + 1);
  const at = (i: number): string => ramp[Math.max(0, Math.min(ramp.length - 1, i))] as string;
  const top = ramp.length - 1;
  const has = (x: number, y: number): boolean => mask.has(x, y);
  const outline = (x: number, y: number): boolean => {
    if (has(x, y)) return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (has(x + dx, y + dy)) return true;
    }
    return false;
  };
  // Shadow: the outlined shape, one pixel down and right.
  for (let y = -1; y <= mask.h; y++) {
    for (let x = -1; x <= mask.w; x++) {
      if (has(x, y) || outline(x, y)) put(bmp, x + pad + 1, y + pad + 1, RAMPS.steel[0]);
    }
  }
  for (let y = -1; y <= mask.h; y++) {
    for (let x = -1; x <= mask.w; x++) {
      const bx = x + pad;
      const by = y + pad;
      if (outline(x, y)) {
        put(bmp, bx, by, at(0));
        continue;
      }
      if (!has(x, y)) continue;
      // Face: bands from light (top) to dark (bottom), between the brightest and the third tone.
      const t = y / (mask.h - 1);
      let i = Math.round(top - 1 - t * (top - 2));
      if (!has(x, y - 1) || !has(x - 1, y))
        i = top; // lit edge
      else if (!has(x, y + 1) || !has(x + 1, y))
        i = 1; // shaded edge
      else if (!has(x, y - 2) || !has(x - 2, y)) i = Math.min(top, i + 1); // soft bevel
      put(bmp, bx, by, at(i));
    }
  }
  // Glint: a short diagonal near the top-left lit edge.
  const glint = RAMPS.steel[8];
  let placed = 0;
  for (let d = 3; d < 14 && placed === 0; d++) {
    for (let k = 0; k < 3; k++) {
      const x = d + k;
      const y = d + 2 - k;
      if (has(x, y) && has(x - 1, y) && has(x, y - 1)) {
        put(bmp, x + pad, y + pad, glint);
        placed++;
      }
    }
  }
  return bmp;
}

export function rankBitmap(rank: Rank): Bitmap {
  return shade(letterMask(rank), RANK_RAMPS[rank]);
}

export { letterMask as rankMask };
