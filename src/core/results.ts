import { JUDGEMENT_WINDOWS_MS, type Judgement } from './judgement';
import type { NoteRuntime } from './playSession';
import type { JudgementCounts, ScoreSummary } from './scoring';

/** Letter ranks by accuracy, best first. */
export type Rank = 'S' | 'A' | 'B' | 'C' | 'D';

export const RANKS: readonly Rank[] = ['S', 'A', 'B', 'C', 'D'];

/** Lowest accuracy (%, inclusive) for each rank; anything below C is D. */
export const RANK_THRESHOLDS: readonly (readonly [Rank, number])[] = [
  ['S', 95],
  ['A', 90],
  ['B', 80],
  ['C', 70],
];

export function rankFor(accuracyPercent: number): Rank {
  for (const [rank, min] of RANK_THRESHOLDS) if (accuracyPercent >= min) return rank;
  return 'D';
}

/** Rank order for comparisons: 0 = S (best). */
export function rankIndex(rank: Rank): number {
  return RANKS.indexOf(rank);
}

export interface Badges {
  /** No Miss and no dropped hold. */
  fullCombo: boolean;
  /** Every note Perfect (implies a full combo). */
  allPerfect: boolean;
}

/** Badges for a finished play. A chart with no notes earns none. */
export function badgesFor(counts: JudgementCounts, drops: number, totalNotes: number): Badges {
  if (totalNotes <= 0) return { fullCombo: false, allPerfect: false };
  const fullCombo = counts.miss === 0 && drops === 0;
  return { fullCombo, allPerfect: fullCombo && counts.perfect === totalNotes };
}

export const HISTOGRAM_MIN_MS = -120;
export const HISTOGRAM_MAX_MS = 120;
export const HISTOGRAM_BIN_MS = 10;

export interface TimingHistogram {
  minMs: number;
  maxMs: number;
  binMs: number;
  /** Count per bin; bin i covers [minMs + i*binMs, minMs + (i+1)*binMs), the last bin includes maxMs. */
  bins: number[];
  /** Errors outside [minMs, maxMs] (not in any bin, but in the average). */
  outside: number;
  /** Mean error of all samples, or null with none. Negative = early on average. */
  averageMs: number | null;
  count: number;
}

/** Bin timing errors (press time - note time, ms) into a histogram. */
export function timingHistogram(
  errorsMs: readonly number[],
  minMs = HISTOGRAM_MIN_MS,
  maxMs = HISTOGRAM_MAX_MS,
  binMs = HISTOGRAM_BIN_MS,
): TimingHistogram {
  const binCount = Math.ceil((maxMs - minMs) / binMs);
  const bins = new Array<number>(binCount).fill(0);
  let outside = 0;
  let sum = 0;
  for (const e of errorsMs) {
    sum += e;
    if (e < minMs || e > maxMs) {
      outside += 1;
      continue;
    }
    const i = Math.min(binCount - 1, Math.floor((e - minMs) / binMs));
    bins[i] = (bins[i] ?? 0) + 1;
  }
  return {
    minMs,
    maxMs,
    binMs,
    bins,
    outside,
    averageMs: errorsMs.length === 0 ? null : sum / errorsMs.length,
    count: errorsMs.length,
  };
}

/** Everything the results screen shows for one finished play. */
export interface PlayResult {
  score: number;
  accuracy: number;
  rank: Rank;
  maxCombo: number;
  totalNotes: number;
  counts: JudgementCounts;
  /** Holds released too early (also counted under their capped judgement). */
  drops: number;
  /** Non-Perfect hits before / after the note (what the EARLY / LATE indicator shows). */
  early: number;
  late: number;
  histogram: TimingHistogram;
  badges: Badges;
}

/** Early/late classification of one press, matching the in-game indicator. */
export function timingSide(errorMs: number): 'early' | 'late' | null {
  if (Math.abs(errorMs) <= JUDGEMENT_WINDOWS_MS.perfect) return null;
  return errorMs < 0 ? 'early' : 'late';
}

/** Build the results from a session's notes and its final score. */
export function buildPlayResult(notes: readonly NoteRuntime[], score: ScoreSummary): PlayResult {
  const errors: number[] = [];
  let drops = 0;
  let early = 0;
  let late = 0;
  for (const rt of notes) {
    if (rt.status === 'dropped') drops += 1;
    if (rt.errorMs === null) continue;
    errors.push(rt.errorMs);
    const side = timingSide(rt.errorMs);
    if (side === 'early') early += 1;
    else if (side === 'late') late += 1;
  }
  const counts: Record<Judgement, number> = { ...score.counts };
  return {
    score: score.score,
    accuracy: score.accuracy,
    rank: rankFor(score.accuracy),
    maxCombo: score.maxCombo,
    totalNotes: score.totalNotes,
    counts,
    drops,
    early,
    late,
    histogram: timingHistogram(errors),
    badges: badgesFor(counts, drops, score.totalNotes),
  };
}
