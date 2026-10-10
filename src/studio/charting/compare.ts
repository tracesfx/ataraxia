import type { Note } from '../../core/chart';

/**
 * Chart diff (Phase 19): which notes of one chart have a counterpart in another, within a
 * timing tolerance. Used by the editor's compare overlay and by the calibration metrics. Pure:
 * no DOM.
 *
 * Matching is one to one and maximal: both lists are walked in time order and a note pairs with
 * the earliest unmatched note of the other list within the tolerance (for points on a line with
 * a symmetric window this greedy pass finds the largest possible set of pairs).
 *
 * - Lane mode: a note only matches a note in the same lane.
 * - Rhythm mode (lanes ignored): notes are first merged into hits (distinct moments; notes
 *   closer than HIT_MERGE_MS are one hit, so a chord counts once), and hits are matched. Every
 *   note then takes its hit's status.
 */

/** Default tolerance of the compare overlay and the calibration's rhythm match. */
export const DEFAULT_COMPARE_TOLERANCE_MS = 35;
/**
 * Notes closer than this are one hit: hand-placed chords are sometimes a few ms apart, and rolled
 * chords (notes about 1/64 apart) read as one moment. Matches the analysis's COINCIDENCE_MS.
 */
export const HIT_MERGE_MS = 20;

export type DiffStatus = 'matched' | 'missing' | 'extra';

export interface MatchCounts {
  matched: number;
  /** In the reference (compare) only. */
  missing: number;
  /** In the chart being judged only. */
  extra: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Greedy maximal one-to-one matching of two sorted time lists. */
export function matchSorted(
  ref: readonly number[],
  gen: readonly number[],
  toleranceMs: number,
): { refMatched: Uint8Array; genMatched: Uint8Array; pairs: [number, number][] } {
  const refMatched = new Uint8Array(ref.length);
  const genMatched = new Uint8Array(gen.length);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < ref.length && j < gen.length) {
    const r = ref[i] as number;
    const g = gen[j] as number;
    if (g < r - toleranceMs) j++;
    else if (g > r + toleranceMs) i++;
    else {
      refMatched[i] = 1;
      genMatched[j] = 1;
      pairs.push([i, j]);
      i++;
      j++;
    }
  }
  return { refMatched, genMatched, pairs };
}

export function countsOf(matched: number, refTotal: number, genTotal: number): MatchCounts {
  const precision = genTotal > 0 ? matched / genTotal : refTotal === 0 ? 1 : 0;
  const recall = refTotal > 0 ? matched / refTotal : genTotal === 0 ? 1 : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    matched,
    missing: refTotal - matched,
    extra: genTotal - matched,
    precision,
    recall,
    f1,
  };
}

/** Distinct hit times (notes within HIT_MERGE_MS of a hit's first note join it), sorted. */
export function mergeHits(times: readonly number[], mergeMs = HIT_MERGE_MS): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  let first = -Infinity;
  for (const t of sorted) {
    if (t - first < mergeMs) continue;
    out.push(t);
    first = t;
  }
  return out;
}

/** Index of the hit (from mergeHits) a time belongs to: the last hit at or before it. */
function hitIndexOf(hits: readonly number[], t: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((hits[mid] as number) <= t) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

export interface ChartDiff {
  /** Status of each note of the judged chart ('matched' or 'extra'), same order as given. */
  mine: DiffStatus[];
  /** Status of each note of the compare chart ('matched' or 'missing'), same order as given. */
  theirs: DiffStatus[];
  /** Counts over the whole charts (hits in rhythm mode, notes in lane mode). */
  total: MatchCounts;
}

export interface DiffOptions {
  toleranceMs: number;
  /** Match moments only (a chord is one hit, any lane). */
  rhythmOnly: boolean;
}

/**
 * Diff the judged chart (`mine`: the chart or the generator preview) against `theirs` (the
 * compare chart, treated as the reference): precision is the share of mine that `theirs` has,
 * recall the share of theirs that mine has.
 */
export function diffCharts(
  mine: readonly Note[],
  theirs: readonly Note[],
  o: DiffOptions,
): ChartDiff {
  const tol = Math.max(0, o.toleranceMs);
  if (o.rhythmOnly) {
    const mineHits = mergeHits(mine.map((n) => n.t));
    const theirHits = mergeHits(theirs.map((n) => n.t));
    const m = matchSorted(theirHits, mineHits, tol);
    return {
      mine: mine.map((n) => (m.genMatched[hitIndexOf(mineHits, n.t)] ? 'matched' : 'extra')),
      theirs: theirs.map((n) => (m.refMatched[hitIndexOf(theirHits, n.t)] ? 'matched' : 'missing')),
      total: countsOf(m.pairs.length, theirHits.length, mineHits.length),
    };
  }
  const mineStatus: DiffStatus[] = mine.map(() => 'extra');
  const theirStatus: DiffStatus[] = theirs.map(() => 'missing');
  let matched = 0;
  for (let lane = 0; lane < 4; lane++) {
    const a = mine
      .map((n, i) => ({ t: n.t, i }))
      .filter((x) => (mine[x.i] as Note).lane === lane)
      .sort((x, y) => x.t - y.t);
    const b = theirs
      .map((n, i) => ({ t: n.t, i }))
      .filter((x) => (theirs[x.i] as Note).lane === lane)
      .sort((x, y) => x.t - y.t);
    const m = matchSorted(
      b.map((x) => x.t),
      a.map((x) => x.t),
      tol,
    );
    for (const [bi, ai] of m.pairs) {
      mineStatus[(a[ai] as { i: number }).i] = 'matched';
      theirStatus[(b[bi] as { i: number }).i] = 'matched';
    }
    matched += m.pairs.length;
  }
  return {
    mine: mineStatus,
    theirs: theirStatus,
    total: countsOf(matched, theirs.length, mine.length),
  };
}

/**
 * Counts for the notes whose heads lie in [fromMs, toMs] (the visible range). In rhythm mode,
 * hits are counted (a chord once).
 */
export function diffCountsIn(
  mine: readonly Note[],
  theirs: readonly Note[],
  diff: ChartDiff,
  rhythmOnly: boolean,
  fromMs: number,
  toMs: number,
): MatchCounts {
  const count = (
    notes: readonly Note[],
    status: readonly DiffStatus[],
  ): { total: number; matched: number } => {
    let total = 0;
    let matched = 0;
    let lastHit = -Infinity;
    const order = notes
      .map((_, i) => i)
      .sort((x, y) => (notes[x] as Note).t - (notes[y] as Note).t);
    for (const i of order) {
      const n = notes[i] as Note;
      if (n.t < fromMs || n.t > toMs) continue;
      if (rhythmOnly) {
        if (n.t - lastHit < HIT_MERGE_MS) continue;
        lastHit = n.t;
      }
      total += 1;
      if (status[i] === 'matched') matched += 1;
    }
    return { total, matched };
  };
  const m = count(mine, diff.mine);
  const t = count(theirs, diff.theirs);
  // Matched pairs: the same number on both sides in full; inside a window a pair may straddle
  // the edge, so precision and recall each use their own side's matched count.
  const precision = m.total > 0 ? m.matched / m.total : t.total === 0 ? 1 : 0;
  const recall = t.total > 0 ? t.matched / t.total : m.total === 0 ? 1 : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    matched: Math.min(m.matched, t.matched),
    missing: t.total - t.matched,
    extra: m.total - m.matched,
    precision,
    recall,
    f1,
  };
}
