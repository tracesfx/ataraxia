/** Judgement grades, best to worst. */
export type Judgement = 'perfect' | 'great' | 'good' | 'miss';

export const JUDGEMENTS: readonly Judgement[] = ['perfect', 'great', 'good', 'miss'];

/** Largest absolute timing error (ms, inclusive) that still earns each grade. */
export const JUDGEMENT_WINDOWS_MS = { perfect: 40, great: 80, good: 120 } as const;

/** A press further than this from a note (in either direction) does not touch it. */
export const HIT_WINDOW_MS = JUDGEMENT_WINDOWS_MS.good;

/**
 * Grade a timing error. `errorMs` is press time minus note time: negative = early.
 * Boundaries are inclusive: exactly 40 ms is still Perfect, 40.5 ms is Great.
 */
export function judgeError(errorMs: number): Judgement {
  const abs = Math.abs(errorMs);
  if (abs <= JUDGEMENT_WINDOWS_MS.perfect) return 'perfect';
  if (abs <= JUDGEMENT_WINDOWS_MS.great) return 'great';
  if (abs <= JUDGEMENT_WINDOWS_MS.good) return 'good';
  return 'miss';
}

/** The worse of two judgements (e.g. to cap a dropped hold at Good). */
export function worseJudgement(a: Judgement, b: Judgement): Judgement {
  return JUDGEMENTS.indexOf(a) >= JUDGEMENTS.indexOf(b) ? a : b;
}
