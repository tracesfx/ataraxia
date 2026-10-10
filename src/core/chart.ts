import { LANE_COUNT } from './constants';

/** Current chart format version. Bump together with a migration in parseChart.ts. */
export const CHART_VERSION = 2;

/** Earliest song time a note (or the game start) may have: 30 s before the audio begins. */
export const MIN_NOTE_TIME_MS = -30000;
/** Earliest custom start (`startMs`); the latest is 0, when the audio begins. */
export const MIN_START_MS = MIN_NOTE_TIME_MS;
export const MAX_START_MS = 0;
/** With no custom start, play begins this long before the first note (never after 0). */
export const AUTO_START_LEAD_MS = 1500;

export const MIN_HOLD_MS = 50;
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 20;

export type Lane = 0 | 1 | 2 | 3;

export interface TapNote {
  /** Song time in integer milliseconds (negative: before the audio begins). */
  t: number;
  lane: Lane;
  type: 'tap';
}

export interface HoldNote {
  /** Song time of the head in integer milliseconds. */
  t: number;
  lane: Lane;
  type: 'hold';
  /** Hold length in integer milliseconds, >= MIN_HOLD_MS. The hold occupies [t, t + dur]. */
  dur: number;
}

export type Note = TapNote | HoldNote;
export type NoteType = Note['type'];

export interface Chart {
  version: typeof CHART_VERSION;
  title: string;
  artist: string;
  /** Original audio filename. Informational only. */
  audio: string;
  bpm: number;
  /** Song time (ms) of beat 0. */
  offsetMs: number;
  previewStartMs: number;
  /**
   * Song time (integer ms, MIN_START_MS..0) at which a play from the beginning starts. Song time
   * 0 is when the audio begins, so a negative value is a silent lead-in. Absent: automatic (see
   * effectiveStartMs).
   */
  startMs?: number;
  difficulty: string;
  /** Integer 1-20. */
  level: number;
  charter: string;
  notes: Note[];
}

/** End time of a note: t for taps, t + dur for holds. */
export function noteEnd(note: Note): number {
  return note.type === 'hold' ? note.t + note.dur : note.t;
}

export function isLane(value: unknown): value is Lane {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < LANE_COUNT;
}

/** Sort order required by the format: by t, then lane. */
export function compareNotes(a: Note, b: Note): number {
  return a.t - b.t || a.lane - b.lane;
}

/** The automatic start: AUTO_START_LEAD_MS before the first note, but never after 0. */
export function autoStartMs(notes: readonly Note[]): number {
  let first = Infinity;
  for (const n of notes) first = Math.min(first, n.t);
  if (first === Infinity) return 0;
  return Math.max(MIN_START_MS, Math.min(MAX_START_MS, first - AUTO_START_LEAD_MS));
}

/** Song time at which a play from the beginning starts: the chart's `startMs`, else automatic. */
export function effectiveStartMs(chart: Pick<Chart, 'notes' | 'startMs'>): number {
  return chart.startMs ?? autoStartMs(chart.notes);
}
