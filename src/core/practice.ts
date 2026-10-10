import { MIN_NOTE_TIME_MS, noteEnd, type Note } from './chart';
import { HIT_WINDOW_MS } from './judgement';

/**
 * Practice mode rules: slowed playback and an A-B section loop. Only the notes inside the loop
 * take part in a run, so notes outside it are never shown, missed or counted.
 */
export const PRACTICE_RATE_MIN = 0.5;
export const PRACTICE_RATE_MAX = 1;
export const PRACTICE_RATE_STEP = 0.05;

/** Round to the 5 % grid and clamp to 50-100 %. */
export function clampPracticeRate(rate: number): number {
  if (!Number.isFinite(rate)) return PRACTICE_RATE_MAX;
  const stepped = Math.round(rate * 20) / 20;
  return Math.min(PRACTICE_RATE_MAX, Math.max(PRACTICE_RATE_MIN, stepped));
}

export function stepPracticeRate(rate: number, direction: 1 | -1): number {
  return clampPracticeRate(rate + direction * PRACTICE_RATE_STEP);
}

/** The A and B marks as the player set them (either may be missing). */
export interface LoopMarks {
  aMs: number | null;
  bMs: number | null;
}

export interface LoopRange {
  startMs: number;
  endMs: number;
}

export const NO_LOOP: LoopMarks = { aMs: null, bMs: null };

/** Set A or B at a song time (whole ms, never before MIN_NOTE_TIME_MS). */
export function setLoopMark(marks: LoopMarks, which: 'a' | 'b', songMs: number): LoopMarks {
  const ms = Math.max(MIN_NOTE_TIME_MS, Math.round(songMs)) + 0;
  return which === 'a' ? { ...marks, aMs: ms } : { ...marks, bMs: ms };
}

/**
 * The active loop: both marks set and at least `minLengthMs` apart. Marks set in the "wrong"
 * order are swapped, so B before A still loops the section between them.
 */
export function loopRange(marks: LoopMarks, minLengthMs = 100): LoopRange | null {
  const { aMs, bMs } = marks;
  if (aMs === null || bMs === null) return null;
  const startMs = Math.min(aMs, bMs);
  const endMs = Math.max(aMs, bMs);
  return endMs - startMs >= minLengthMs ? { startMs, endMs } : null;
}

/** Notes whose head lies inside the loop (inclusive). A hold may run past the end. */
export function notesInLoop(notes: readonly Note[], loop: LoopRange): Note[] {
  return notes.filter((n) => n.t >= loop.startMs && n.t <= loop.endMs);
}

/**
 * Song time at which a loop run is over and restarts: the loop end, or later if a hold in the
 * loop is still sounding, plus the hit window so the last notes can still be judged.
 */
export function loopRestartMs(loopNotes: readonly Note[], loop: LoopRange): number {
  let end = loop.endMs;
  for (const n of loopNotes) end = Math.max(end, noteEnd(n));
  return end + HIT_WINDOW_MS;
}
