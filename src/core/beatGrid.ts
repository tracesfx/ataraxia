import { beatLengthMs, beatToMs, msToBeat, type SnapDivision } from './time';

/**
 * Beat-grid math for the chart editor: which grid lines fall in a time range, how to step the
 * cursor along the grid, and how to label positions. Version 1 charts are single-BPM in 4/4.
 */

export const BEATS_PER_MEASURE = 4;

/** Treat positions this close (in ms) to a grid line as on it, so rounding never skips a line. */
const ON_GRID_EPSILON_MS = 0.5;

export type GridLineKind = 'measure' | 'beat' | 'sub';

export interface GridLine {
  /** Song time of the line (not rounded). */
  ms: number;
  /** Whole beats from beat 0 plus the fraction, e.g. 12.25. */
  beat: number;
  kind: GridLineKind;
  /**
   * The finest division this line needs: 1 on beats, 2 on half beats, 3 or 6 on triplets, 4
   * on quarter beats, and so on. Used to colour subdivision lines.
   */
  tier: number;
  /** 1-based measure number on measure lines (0, -1, ... before beat 0), otherwise null. */
  measure: number | null;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** Index of the measure containing `beat`, 1-based: beats 0-3 are measure 1. */
export function measureOfBeat(beat: number, beatsPerMeasure = BEATS_PER_MEASURE): number {
  return Math.floor(beat / beatsPerMeasure) + 1;
}

/**
 * Grid lines from `startMs` to `endMs` (both inclusive), every 1/`division` beat. Pass
 * division 0 to get measure lines only (used when the view is zoomed far out).
 * At most `maxLines` lines are returned, as a guard against absurd zoom levels.
 */
export function gridLines(
  startMs: number,
  endMs: number,
  bpm: number,
  offsetMs: number,
  division: SnapDivision | 0,
  maxLines = 5000,
): GridLine[] {
  const lines: GridLine[] = [];
  if (endMs < startMs) return lines;
  // Steps of 1/stepDiv beat; measures only = steps of 4 beats.
  const stepBeats = division === 0 ? BEATS_PER_MEASURE : 1 / division;
  const first = Math.ceil(msToBeat(startMs, bpm, offsetMs) / stepBeats - 1e-9);
  const last = Math.floor(msToBeat(endMs, bpm, offsetMs) / stepBeats + 1e-9);
  for (let k = first; k <= last && lines.length < maxLines; k++) {
    const beat = k * stepBeats;
    let kind: GridLineKind;
    let tier: number;
    if (division === 0) {
      kind = 'measure';
      tier = 1;
    } else {
      const within = ((k % division) + division) % division;
      tier = within === 0 ? 1 : division / gcd(within, division);
      const wholeBeat = Math.round(beat);
      const isBeat = within === 0;
      kind =
        isBeat && ((wholeBeat % BEATS_PER_MEASURE) + BEATS_PER_MEASURE) % BEATS_PER_MEASURE === 0
          ? 'measure'
          : isBeat
            ? 'beat'
            : 'sub';
    }
    lines.push({
      ms: beatToMs(beat, bpm, offsetMs),
      beat,
      kind,
      tier,
      measure: kind === 'measure' ? measureOfBeat(Math.round(beat)) : null,
    });
  }
  return lines;
}

/**
 * The division to actually draw at this zoom: the snap division, or a coarser level when its
 * lines would be closer than `minSpacingPx`. Returns 1 (beats only) or 0 (measures only) when
 * even that is too dense.
 */
export function displayDivision(
  pxPerMs: number,
  bpm: number,
  division: SnapDivision,
  minSpacingPx: number,
): SnapDivision | 0 {
  const beatPx = beatLengthMs(bpm) * pxPerMs;
  if (beatPx / division >= minSpacingPx) return division;
  if (beatPx >= minSpacingPx) return 1;
  return 0;
}

/**
 * Next grid position after `ms` in `direction` on a grid of `stepMs` anchored at `originMs`.
 * From a position on the grid this moves one whole step; from between lines it moves to the
 * nearest line in that direction. Returns unrounded ms.
 */
export function stepOnGrid(
  ms: number,
  stepMs: number,
  originMs: number,
  direction: 1 | -1,
): number {
  if (!(stepMs > 0)) throw new RangeError(`Grid step must be positive, got ${stepMs}`);
  const index = (ms - originMs) / stepMs;
  const nearest = Math.round(index);
  const onGrid = Math.abs((index - nearest) * stepMs) < ON_GRID_EPSILON_MS;
  const next = onGrid ? nearest + direction : direction > 0 ? Math.ceil(index) : Math.floor(index);
  return originMs + next * stepMs;
}

/** Move one snap division (1/division beat) from `ms`, landing on the grid. Integer ms. */
export function stepSnap(
  ms: number,
  bpm: number,
  offsetMs: number,
  division: SnapDivision,
  direction: 1 | -1,
): number {
  return Math.round(stepOnGrid(ms, beatLengthMs(bpm) / division, offsetMs, direction)) + 0;
}

/** Move one measure from `ms`, landing on a measure line. Integer ms. */
export function stepMeasure(ms: number, bpm: number, offsetMs: number, direction: 1 | -1): number {
  const measureMs = beatLengthMs(bpm) * BEATS_PER_MEASURE;
  return Math.round(stepOnGrid(ms, measureMs, offsetMs, direction)) + 0;
}

/**
 * Beats whose time lies in (`afterMs`, `untilMs`]: the clicks a metronome must schedule next.
 * `beat` is the whole beat number (0 at offsetMs; downbeats are multiples of 4).
 */
export function beatsInRange(
  afterMs: number,
  untilMs: number,
  bpm: number,
  offsetMs: number,
): { ms: number; beat: number }[] {
  const out: { ms: number; beat: number }[] = [];
  if (untilMs <= afterMs) return out;
  // Start one beat early so floating-point error can't skip a beat; the ms test filters it.
  for (let beat = Math.floor(msToBeat(afterMs, bpm, offsetMs)) - 1; ; beat++) {
    const ms = beatToMs(beat, bpm, offsetMs);
    if (ms > untilMs) break;
    if (ms > afterMs) out.push({ ms, beat });
  }
  return out;
}

export function isDownbeat(beat: number): boolean {
  return ((beat % BEATS_PER_MEASURE) + BEATS_PER_MEASURE) % BEATS_PER_MEASURE === 0;
}

/** "mm:ss.mmm" (minutes not capped at 59), with a leading "-" before the song start. */
export function formatTimestamp(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const total = Math.round(Math.abs(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * "measure:beat" for a song time, both 1-based ("1:1" is beat 0). Positions between beats show
 * the beat they fall in. Before beat 0, measures count 0, -1, ...
 */
export function formatMeasureBeat(ms: number, bpm: number, offsetMs: number): string {
  // A hair of tolerance so a position rounded to whole ms still counts as on its beat.
  const beat = Math.floor(msToBeat(ms + ON_GRID_EPSILON_MS, bpm, offsetMs));
  const measure = measureOfBeat(beat);
  const inMeasure = ((beat % BEATS_PER_MEASURE) + BEATS_PER_MEASURE) % BEATS_PER_MEASURE;
  return `${measure}:${inMeasure + 1}`;
}
