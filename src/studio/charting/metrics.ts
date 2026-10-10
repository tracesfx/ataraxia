import type { Note } from '../../core/chart';

/**
 * Density measures shared by the generator (caps, contrast), its tests, the calibration script
 * and the before/after preview. Density counts distinct note times: a chord is one hit.
 */

/** Distinct note head times, sorted. */
export function hitTimes(notes: readonly Note[]): number[] {
  return [...new Set(notes.map((n) => n.t))].sort((a, b) => a - b);
}

/** Index of the first time >= ms in sorted `times`. */
export function lowerBound(times: readonly number[], ms: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Number of sorted times in [fromMs, toMs). */
export function countIn(times: readonly number[], fromMs: number, toMs: number): number {
  return lowerBound(times, toMs) - lowerBound(times, fromMs);
}

/** Most hits in any window [s, s + windowMs) (the worst case over every start). */
export function maxInWindow(times: readonly number[], windowMs: number): number {
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (j < times.length && (times[j] as number) < (times[i] as number) + windowMs) j += 1;
    best = Math.max(best, j - i);
  }
  return best;
}

/** Notes per second in consecutive windows of `windowMs` from startMs (the last one may be cut). */
export function windowNps(
  times: readonly number[],
  startMs: number,
  endMs: number,
  windowMs: number,
): number[] {
  const out: number[] = [];
  for (let s = startMs; s < endMs - 1e-6; s += windowMs) {
    const e = Math.min(endMs, s + windowMs);
    out.push((countIn(times, s, e) * 1000) / Math.max(1, e - s));
  }
  return out;
}

export interface Contrast {
  /** Mean notes per second of the densest 10% of windows. */
  dense: number;
  /** Mean notes per second of the quietest 30% of windows. */
  quiet: number;
  /** dense / quiet (Infinity when the quiet windows are empty and the dense ones are not). */
  ratio: number;
}

export const DENSE_SHARE = 0.1;
export const QUIET_SHARE = 0.3;

/** Dynamic contrast of window densities. */
export function contrastOf(nps: readonly number[]): Contrast {
  if (nps.length === 0) return { dense: 0, quiet: 0, ratio: 1 };
  const sorted = [...nps].sort((a, b) => a - b);
  const quietCount = Math.max(1, Math.round(sorted.length * QUIET_SHARE));
  const denseCount = Math.max(1, Math.round(sorted.length * DENSE_SHARE));
  const avg = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  const quiet = avg(sorted.slice(0, quietCount));
  const dense = avg(sorted.slice(sorted.length - denseCount));
  const ratio = quiet > 0 ? dense / quiet : dense > 0 ? Infinity : 1;
  return { dense, quiet, ratio };
}

/** Centred moving average (half = windows each side). */
export function smoothSeries(values: readonly number[], half: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      sum += values[k] as number;
      count += 1;
    }
    return sum / count;
  });
}
