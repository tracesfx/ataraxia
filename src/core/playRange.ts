import { effectiveStartMs, type Chart, type Note } from './chart';

/**
 * Notes that take part in a play-through starting at `startTimeMs` ("playtest from here", which
 * may be negative). A note counts only if its head is at or after the start: a hold whose head is
 * earlier can't be hit, so it is dropped entirely rather than scored as a Miss. Without a start
 * (a play from the beginning) every note counts.
 */
export function notesFromStart(notes: readonly Note[], startTimeMs?: number): Note[] {
  if (startTimeMs === undefined) return [...notes];
  return notes.filter((n) => n.t >= startTimeMs);
}

/** Where the song clock starts and which notes are judged in one run of the game. */
export interface RunPlan {
  /** Song time the clock starts at (negative: silence until the audio begins at 0). */
  clockFromMs: number;
  /** Notes with a head before this are left out; null = every note. */
  judgeFromMs: number | null;
}

/**
 * The run for a chart: from the beginning it starts at the chart's effective start (no run-in,
 * every note judged); from a start point ("playtest from here") it starts `runInMs` earlier and
 * only notes from the start point on are judged.
 */
export function runPlan(
  chart: Pick<Chart, 'notes' | 'startMs'>,
  startTimeMs: number | undefined,
  runInMs: number,
): RunPlan {
  if (startTimeMs === undefined) return { clockFromMs: effectiveStartMs(chart), judgeFromMs: null };
  return { clockFromMs: startTimeMs - Math.max(0, runInMs), judgeFromMs: startTimeMs };
}

export interface PreviewWindow {
  startMs: number;
  lengthMs: number;
}

/**
 * The part of a song the song-select preview loops: `lengthMs` from `previewStartMs`, moved
 * earlier if it would run past the end. Songs shorter than `lengthMs` preview whole.
 */
export function previewWindow(
  previewStartMs: number,
  durationMs: number,
  lengthMs: number,
): PreviewWindow {
  const duration = Math.max(0, durationMs);
  if (duration <= lengthMs) return { startMs: 0, lengthMs: duration };
  const startMs = Math.min(Math.max(0, previewStartMs), duration - lengthMs);
  return { startMs, lengthMs };
}
