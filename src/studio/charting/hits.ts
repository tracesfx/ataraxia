import type { LayerId } from './analysis/types';

/**
 * Shared vocabulary of the Phase 18 generator: the beat grid in ticks, hits (moments that get
 * notes, before lanes), and the decision log (why each note exists, why candidates were left
 * out). Pure: no DOM.
 */

/** Ticks per beat: a common multiple of every grid division (1, 2, 3, 4, 6, 8, 12, 16). */
export const TICKS_PER_BEAT = 48;

/** Where a hit's timing came from: an onset layer, or the grid when no onset was there. */
export type HitSource = LayerId | 'grid';

export type NoteReason =
  | 'spine'
  | 'lead run'
  | 'secondary'
  | 'variation'
  | 'top-up'
  | 'gap fill'
  | 'floor'
  | 'silence fill';

export type RejectReason =
  | 'below threshold'
  | 'off grid'
  | 'repeat consensus'
  | 'thinning'
  | 'over cap'
  | 'min gap'
  | 'existing note'
  | 'no free lane';

export const REJECT_REASONS: readonly RejectReason[] = [
  'below threshold',
  'off grid',
  'repeat consensus',
  'thinning',
  'over cap',
  'min gap',
  'existing note',
  'no free lane',
];

/** Drop order when a window is over its cap: lowest first; the shared rhythm (3) never. */
export type HitRank = 0 | 1 | 2 | 3;
export const RANK_OF: Readonly<Record<NoteReason, HitRank>> = {
  variation: 0,
  'top-up': 1,
  'gap fill': 1,
  floor: 2,
  'silence fill': 2,
  secondary: 2,
  spine: 3,
  'lead run': 3,
};

/** A moment that gets one or more notes (a chord), before lanes are chosen. */
export interface Hit {
  tick: number;
  tMs: number;
  /** 0-1. */
  strength: number;
  source: HitSource;
  reason: NoteReason;
  /** Lead pitch here (float MIDI), for the melody contour. */
  pitch: number | null;
  /** Strength of every layer with an onset here. */
  layers: Partial<Record<LayerId, number>>;
  /** Repeat group (-1 = none), occurrence, and position in the phrase (ticks). */
  group: number;
  instance: number;
  relTick: number;
  /** Template (phrase or repeat group) index. */
  template: number;
  /** Phrase grid (divisions per beat). */
  division: number;
  /** Notes at this moment (1-3). */
  count: number;
  /** Hold length of the main note (0 = tap) and where it came from. */
  holdMs: number;
  holdSource: string;
  /** A second note held under the main one (sustained bass or pad), 0 = none. */
  layerHoldMs: number;
}

/** Why a generated note exists (shown when hovering a ghost note). */
export interface NoteDecision {
  source: HitSource;
  reason: NoteReason;
  /** 0-1 strength of the onset it follows. */
  score: number;
  /** Repeat group and occurrence, or -1. */
  group: number;
  instance: number;
  /** Template and phrase-relative tick (repeat consistency). */
  template: number;
  relTick: number;
  /** Phrase grid (divisions per beat). */
  division: number;
  chord: number;
  /** Where the hold came from ("" for taps). */
  hold: string;
}

/** A candidate onset the generator did not use. */
export interface Rejection {
  tMs: number;
  layer: LayerId | null;
  strength: number;
  reason: RejectReason;
}

/** Song time <-> ticks on the chart's single-BPM grid. */
export class TickGrid {
  readonly beatMs: number;
  constructor(
    readonly bpm: number,
    readonly offsetMs: number,
  ) {
    this.beatMs = 60000 / bpm;
  }
  /** Fractional tick at `ms`. */
  at(ms: number): number {
    return ((ms - this.offsetMs) / this.beatMs) * TICKS_PER_BEAT;
  }
  /** Whole milliseconds at a tick. */
  ms(tick: number): number {
    return Math.round(this.offsetMs + (tick / TICKS_PER_BEAT) * this.beatMs);
  }
  /** Nearest line of `division` (per beat) to `ms`, as a tick. */
  snap(ms: number, division: number): number {
    const step = TICKS_PER_BEAT / division;
    return Math.round(this.at(ms) / step) * step;
  }
}

/** Weight of a grid position: downbeat 1, beat 0.8, 8th 0.55, triplet 0.4, 16th 0.3, finer. */
export function metricWeight(tick: number): number {
  const inBeat = ((tick % TICKS_PER_BEAT) + TICKS_PER_BEAT) % TICKS_PER_BEAT;
  if (inBeat === 0) {
    return ((tick % (TICKS_PER_BEAT * 4)) + TICKS_PER_BEAT * 4) % (TICKS_PER_BEAT * 4) === 0
      ? 1
      : 0.8;
  }
  if (inBeat === 24) return 0.55;
  if (inBeat === 16 || inBeat === 32) return 0.4;
  if (inBeat % 12 === 0) return 0.3;
  if (inBeat % 8 === 0) return 0.2;
  return 0.15;
}

/** Deterministic 0-1 value from a seed and integers (per-position seeded choices). */
export function hash01(seed: number, a: number, b = 0, c = 0): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const v of [a, b, c]) {
    h = Math.imul(h ^ (v | 0), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h / 4294967296;
}

/** Index of the first item with time >= ms in a time-sorted list. */
export function firstAtOrAfter<T>(items: readonly T[], ms: number, time: (x: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time(items[mid] as T) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * Math.min(1, Math.max(0, t));
