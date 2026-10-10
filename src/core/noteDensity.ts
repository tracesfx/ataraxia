import type { Note } from './chart';

/**
 * Note density over a song for the editor minimap's heat strip: notes per second around each
 * point, and the flat colour band (level) each value falls in.
 */

/** Density is averaged over at least this long, so short bins don't spike. */
export const DENSITY_WINDOW_MS = 1000;

/** Lower bounds (notes per second) of levels 2, 3 and 4; anything above 0 is at least level 1. */
export const DENSITY_THRESHOLDS_NPS = [2.5, 5, 8] as const;
export const DENSITY_LEVELS = 5;

/**
 * Notes per second at `binCount` evenly spaced points from `startMs` to `endMs`: note heads in a
 * window of max(bin width, DENSITY_WINDOW_MS) centred on each bin. `notes` must be sorted by time.
 * O(notes + bins).
 */
export function densityBins(
  notes: readonly Note[],
  startMs: number,
  endMs: number,
  binCount: number,
): Float32Array {
  const bins = Math.max(0, Math.floor(binCount));
  const out = new Float32Array(bins);
  if (bins === 0 || !(endMs > startMs)) return out;
  const binMs = (endMs - startMs) / bins;
  const windowMs = Math.max(binMs, DENSITY_WINDOW_MS);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < bins; i++) {
    const centre = startMs + (i + 0.5) * binMs;
    const from = centre - windowMs / 2;
    const to = centre + windowMs / 2;
    while (lo < notes.length && (notes[lo] as Note).t < from) lo++;
    if (hi < lo) hi = lo;
    while (hi < notes.length && (notes[hi] as Note).t < to) hi++;
    out[i] = ((hi - lo) * 1000) / windowMs;
  }
  return out;
}

/** The colour band for a density: 0 = no notes, 1-4 rising. */
export function densityLevel(nps: number): number {
  if (!(nps > 0)) return 0;
  let level = 1;
  for (const threshold of DENSITY_THRESHOLDS_NPS) if (nps >= threshold) level += 1;
  return level;
}
