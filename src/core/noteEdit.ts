import {
  CHART_VERSION,
  MAX_LEVEL,
  MAX_START_MS,
  MIN_HOLD_MS,
  MIN_LEVEL,
  MIN_NOTE_TIME_MS,
  MIN_START_MS,
  compareNotes,
  isLane,
  noteEnd,
  type Chart,
  type Lane,
  type Note,
} from './chart';
import { LANE_COUNT } from './constants';
import { parseChart, type ParseResult } from './parseChart';
import { beatLengthMs, beatToMs, msToBeat, type SnapDivision } from './time';

/**
 * Pure note-editing operations for the chart editor. Every operation takes the current (sorted,
 * valid) note list and returns either the notes to remove and add, or an error sentence. Nothing
 * here mutates its input, so the editor can apply results as undoable commands and an operation
 * that would break the chart (overlap, bad hold, outside the song) is rejected before it lands.
 */

/** The snap grid: single BPM, beat 0 at offsetMs, `snap` divisions per beat. */
export interface SnapGrid {
  bpm: number;
  offsetMs: number;
  snap: SnapDivision;
}

/**
 * Where notes may go: from `minMs` (default MIN_NOTE_TIME_MS, 30 s before the audio begins) up
 * to the end of the audio.
 */
export interface EditBounds {
  durationMs: number;
  minMs?: number;
}

export type EditResult =
  { ok: true; removed: Note[]; added: Note[] } | { ok: false; error: string };

/** Notes copied for pasting: times relative to the earliest copied note (which is at 0). */
export interface Clipboard {
  notes: readonly Note[];
}

/** A recorded key press becomes a hold when held longer than this many beats. */
export const RECORD_HOLD_THRESHOLD_BEATS = 0.25;

// --- Grid -----------------------------------------------------------------------------------

/** Length of one snap division in ms (not rounded). */
export function snapStepMs(grid: SnapGrid): number {
  return beatLengthMs(grid.bpm) / grid.snap;
}

/** Index of the grid line nearest `ms` (line 0 is beat 0). */
export function stepIndexOf(ms: number, grid: SnapGrid): number {
  return Math.round(msToBeat(ms, grid.bpm, grid.offsetMs) * grid.snap);
}

/** Song time of grid line `index`, as integer ms (same rounding as snapToGrid). */
export function stepTimeOf(index: number, grid: SnapGrid): number {
  return Math.round(beatToMs(index / grid.snap, grid.bpm, grid.offsetMs)) + 0;
}

/** The first grid line at or after song time `minMs`. */
function firstStepIndex(grid: SnapGrid, minMs: number): number {
  let i = Math.ceil(msToBeat(minMs, grid.bpm, grid.offsetMs) * grid.snap - 1e-9);
  while (stepTimeOf(i, grid) < minMs) i += 1;
  while (stepTimeOf(i - 1, grid) >= minMs) i -= 1;
  return i;
}

/** Grid line nearest `ms`, never before `minMs` (default MIN_NOTE_TIME_MS). Negative is fine. */
export function placementStep(ms: number, grid: SnapGrid, minMs = MIN_NOTE_TIME_MS): number {
  return Math.max(firstStepIndex(grid, minMs), stepIndexOf(ms, grid));
}

/** Snapped placement time for `ms` (integer ms, >= `minMs`). */
export function placementTime(ms: number, grid: SnapGrid, minMs = MIN_NOTE_TIME_MS): number {
  return stepTimeOf(placementStep(ms, grid, minMs), grid);
}

/**
 * Fewest grid steps a hold starting at line `from` must span: at least one division, and long
 * enough to reach MIN_HOLD_MS (fine snaps at high BPM have divisions shorter than that).
 */
export function minHoldSteps(from: number, grid: SnapGrid): number {
  const start = stepTimeOf(from, grid);
  let k = 1;
  while (stepTimeOf(from + k, grid) - start < MIN_HOLD_MS) k += 1;
  return k;
}

// --- Notes ----------------------------------------------------------------------------------

export function tapNote(lane: Lane, t: number): Note {
  return { t, lane, type: 'tap' };
}

export function holdNote(lane: Lane, t: number, dur: number): Note {
  return { t, lane, type: 'hold', dur };
}

/** True when two notes share a lane and their [t, end] ranges touch (inclusive, per the spec). */
export function notesOverlap(a: Note, b: Note): boolean {
  return a.lane === b.lane && a.t <= noteEnd(b) && b.t <= noteEnd(a);
}

/** Same note by value (lane + time identify a note in a valid chart; type and dur must match too). */
export function sameNote(a: Note, b: Note): boolean {
  return (
    a.t === b.t &&
    a.lane === b.lane &&
    a.type === b.type &&
    (a.type === 'hold' ? a.dur : 0) === (b.type === 'hold' ? b.dur : 0)
  );
}

/** A sentence describing why `note` can't exist on its own, or null when it is fine. */
export function noteProblem(note: Note, bounds: EditBounds): string | null {
  if (!isLane(note.lane)) return `Notes must stay in the ${LANE_COUNT} lanes.`;
  if (!Number.isInteger(note.t) || (note.type === 'hold' && !Number.isInteger(note.dur))) {
    return 'Note times must be whole milliseconds.';
  }
  if (note.t < (bounds.minMs ?? MIN_NOTE_TIME_MS)) {
    return `Notes cannot go more than ${-MIN_NOTE_TIME_MS / 1000} seconds before the audio starts.`;
  }
  if (note.type === 'hold' && note.dur < MIN_HOLD_MS) {
    return `Hold notes must last at least ${MIN_HOLD_MS} ms.`;
  }
  if (noteEnd(note) > Math.ceil(bounds.durationMs)) {
    return 'Notes cannot go past the end of the song.';
  }
  return null;
}

/**
 * The first overlap between a candidate note and another candidate or a kept existing note, or
 * null. Notes in `ignore` (being moved or replaced) don't count. Overlaps among existing notes
 * alone are not reported: the chart they came from is assumed valid.
 */
export function findOverlap(
  existing: readonly Note[],
  candidates: readonly Note[],
  ignore: ReadonlySet<Note> = new Set(),
): { candidate: Note; other: Note } | null {
  const isCandidate = new Set<Note>(candidates);
  const all = existing.filter((n) => !ignore.has(n)).concat(candidates);
  all.sort((a, b) => a.lane - b.lane || a.t - b.t || (isCandidate.has(a) ? 1 : -1));
  let reach: Note | null = null;
  for (const note of all) {
    if (reach && reach.lane === note.lane && note.t <= noteEnd(reach)) {
      if (isCandidate.has(note) || isCandidate.has(reach)) {
        return isCandidate.has(note)
          ? { candidate: note, other: reach }
          : { candidate: reach, other: note };
      }
    }
    if (!reach || reach.lane !== note.lane || noteEnd(note) >= noteEnd(reach)) reach = note;
  }
  return null;
}

function overlapMessage(what: string, hit: { candidate: Note; other: Note }): string {
  return `${what} would overlap the ${hit.other.type === 'hold' ? 'hold' : 'note'} in lane ${hit.other.lane + 1} at ${hit.other.t} ms.`;
}

/** Check `added` against `notes` (minus `removed`) and the bounds. */
function checked(
  notes: readonly Note[],
  removed: Note[],
  added: Note[],
  bounds: EditBounds,
  what: string,
): EditResult {
  for (const n of added) {
    const problem = noteProblem(n, bounds);
    if (problem) return { ok: false, error: problem };
  }
  const hit = findOverlap(notes, added, new Set(removed));
  if (hit) return { ok: false, error: overlapMessage(what, hit) };
  return { ok: true, removed, added };
}

/** Apply an edit: drop `removed` (by identity), add `added`, keep the result sorted. */
export function applyEdit(
  notes: readonly Note[],
  removed: readonly Note[],
  added: readonly Note[],
): Note[] {
  const gone = new Set(removed);
  const next = gone.size === 0 ? [...notes] : notes.filter((n) => !gone.has(n));
  next.push(...added);
  return next.sort(compareNotes);
}

// --- Placement ------------------------------------------------------------------------------

/** Add notes as they are (already snapped), rejecting overlaps and out-of-bounds notes. */
export function addNotes(
  notes: readonly Note[],
  added: readonly Note[],
  bounds: EditBounds,
  what = 'That note',
): EditResult {
  return checked(notes, [], [...added], bounds, what);
}

/**
 * Remove `removed` and add `added` as one edit (generated notes replacing a range), rejecting
 * overlaps (with the notes that stay) and out-of-bounds notes.
 */
export function swapNotes(
  notes: readonly Note[],
  removed: readonly Note[],
  added: readonly Note[],
  bounds: EditBounds,
  what = 'That note',
): EditResult {
  const present = new Set(notes);
  return checked(
    notes,
    removed.filter((n) => present.has(n)),
    [...added],
    bounds,
    what,
  );
}

/** Swap one existing note for another (e.g. a recorded tap growing into a hold). */
export function replaceNote(
  notes: readonly Note[],
  old: Note,
  next: Note,
  bounds: EditBounds,
): EditResult {
  if (!notes.includes(old)) return { ok: false, error: 'That note no longer exists.' };
  return checked(notes, [old], [next], bounds, 'That note');
}

/** A tap at the grid line nearest `ms`. */
export function placeTap(
  notes: readonly Note[],
  lane: Lane,
  ms: number,
  grid: SnapGrid,
  bounds: EditBounds,
): EditResult {
  return checked(notes, [], [tapNote(lane, placementTime(ms, grid))], bounds, 'That note');
}

/**
 * The hold a drag from `fromMs` to `toMs` describes: both ends snapped, in either direction,
 * at least one division long (and at least MIN_HOLD_MS).
 */
export function holdFromDrag(lane: Lane, fromMs: number, toMs: number, grid: SnapGrid): Note {
  const a = placementStep(fromMs, grid);
  const b = placementStep(toMs, grid);
  const lo = Math.min(a, b);
  const hi = Math.max(Math.max(a, b), lo + minHoldSteps(lo, grid));
  const t = stepTimeOf(lo, grid);
  return holdNote(lane, t, stepTimeOf(hi, grid) - t);
}

export function placeHold(
  notes: readonly Note[],
  lane: Lane,
  fromMs: number,
  toMs: number,
  grid: SnapGrid,
  bounds: EditBounds,
): EditResult {
  return checked(notes, [], [holdFromDrag(lane, fromMs, toMs, grid)], bounds, 'That hold');
}

/**
 * The note a live-recorded key press becomes: a tap at the press time quantized to the grid, or,
 * if the key was held longer than a quarter beat, a hold to the quantized release time (at least
 * one division). `releaseMs` null means the key is still down (tap for now).
 */
export function quantizeRecorded(
  lane: Lane,
  pressMs: number,
  releaseMs: number | null,
  grid: SnapGrid,
): Note {
  const from = placementStep(pressMs, grid);
  const t = stepTimeOf(from, grid);
  const threshold = beatLengthMs(grid.bpm) * RECORD_HOLD_THRESHOLD_BEATS;
  if (releaseMs === null || releaseMs - pressMs <= threshold) return tapNote(lane, t);
  const to = Math.max(stepIndexOf(releaseMs, grid), from + minHoldSteps(from, grid));
  return holdNote(lane, t, stepTimeOf(to, grid) - t);
}

// --- Selection edits ------------------------------------------------------------------------

export function deleteNotes(notes: readonly Note[], targets: Iterable<Note>): EditResult {
  const present = new Set(notes);
  return { ok: true, removed: [...targets].filter((n) => present.has(n)), added: [] };
}

function shifted(note: Note, deltaMs: number, deltaLane: number): Note {
  const lane = (note.lane + deltaLane) as Lane;
  const t = note.t + deltaMs;
  return note.type === 'hold' ? holdNote(lane, t, note.dur) : tapNote(lane, t);
}

/** Move notes by a time and lane offset, as one block. */
export function moveNotes(
  notes: readonly Note[],
  targets: readonly Note[],
  deltaMs: number,
  deltaLane: number,
  bounds: EditBounds,
): EditResult {
  if (targets.length === 0 || (deltaMs === 0 && deltaLane === 0)) {
    return { ok: true, removed: [], added: [] };
  }
  const moved = targets.map((n) => shifted(n, Math.round(deltaMs), deltaLane));
  if (moved.some((n) => !isLane(n.lane))) {
    return { ok: false, error: `Notes cannot move outside the ${LANE_COUNT} lanes.` };
  }
  return checked(notes, [...targets], moved, bounds, 'Moving there');
}

/**
 * The time offset that moves `anchor` (normally the earliest selected note) `steps` grid lines
 * from the line nearest it. Shifting every note by this keeps their spacing exact.
 */
export function gridStepDelta(anchorMs: number, steps: number, grid: SnapGrid): number {
  return stepTimeOf(stepIndexOf(anchorMs, grid) + steps, grid) - anchorMs;
}

/** Clamp a lane offset so every target stays inside the lanes (for dragging). */
export function clampLaneDelta(targets: readonly Note[], deltaLane: number): number {
  if (targets.length === 0) return 0;
  let lo = LANE_COUNT;
  let hi = -1;
  for (const n of targets) {
    lo = Math.min(lo, n.lane);
    hi = Math.max(hi, n.lane);
  }
  return Math.min(LANE_COUNT - 1 - hi, Math.max(-lo, deltaLane));
}

/** Mirror lanes left-right (lane -> 3 - lane). */
export function mirrorNotes(
  notes: readonly Note[],
  targets: readonly Note[],
  bounds: EditBounds,
): EditResult {
  if (targets.length === 0) return { ok: true, removed: [], added: [] };
  const mirrored = targets.map((n) => {
    const lane = (LANE_COUNT - 1 - n.lane) as Lane;
    return n.type === 'hold' ? holdNote(lane, n.t, n.dur) : tapNote(lane, n.t);
  });
  return checked(notes, [...targets], mirrored, bounds, 'Mirroring');
}

/** Copy notes; times become relative to the earliest one. */
export function copyNotes(targets: Iterable<Note>): Clipboard {
  const list = [...targets].sort(compareNotes);
  const first = list[0];
  if (!first) return { notes: [] };
  return { notes: list.map((n) => shifted(n, -first.t, 0)) };
}

/** Paste a clipboard with its earliest note at `atMs`. */
export function pasteNotes(
  notes: readonly Note[],
  clipboard: Clipboard,
  atMs: number,
  bounds: EditBounds,
): EditResult {
  if (clipboard.notes.length === 0) return { ok: false, error: 'There is nothing to paste.' };
  const added = clipboard.notes.map((n) => shifted(n, Math.round(atMs), 0));
  return checked(notes, [], added, bounds, 'Pasting here');
}

/** Replace every note (chart import). The new notes must already form a valid chart. */
export function replaceAllNotes(notes: readonly Note[], next: readonly Note[]): EditResult {
  return { ok: true, removed: [...notes], added: [...next] };
}

// --- Queries --------------------------------------------------------------------------------

/** Index of the first note with t >= ms in a sorted list (binary search). */
export function lowerBoundByTime(notes: readonly Note[], ms: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((notes[mid] as Note).t < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Notes in lanes `laneLo..laneHi` whose [t, end] touches the time range [fromMs, toMs]. */
export function notesInBox(
  notes: readonly Note[],
  laneLo: number,
  laneHi: number,
  fromMs: number,
  toMs: number,
): Note[] {
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  const lanes = [Math.min(laneLo, laneHi), Math.max(laneLo, laneHi)] as const;
  return notes.filter(
    (n) => n.lane >= lanes[0] && n.lane <= lanes[1] && n.t <= hi && noteEnd(n) >= lo,
  );
}

export interface ChartStats {
  notes: number;
  holds: number;
  /** Notes per second over the span (whole chart: first note to last note end). */
  avgNps: number;
  /** Most note heads in any one-second window. */
  peakNps: number;
  /** Whole chart: first note to the end of the last note. Range: the range length. */
  lengthMs: number;
}

/** Most heads of a sorted note list inside any window of `windowMs` (half-open). */
function peakCount(notes: readonly Note[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < notes.length; end++) {
    const t = (notes[end] as Note).t;
    while ((notes[start] as Note).t <= t - windowMs) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** Note statistics for the whole chart, or for the notes whose head lies inside `range`. */
export function chartStats(
  notes: readonly Note[],
  range?: { startMs: number; endMs: number },
): ChartStats {
  let list = notes;
  let lengthMs: number;
  if (range) {
    list = notes.slice(
      lowerBoundByTime(notes, range.startMs),
      lowerBoundByTime(notes, range.endMs + 1),
    );
    lengthMs = Math.max(0, range.endMs - range.startMs);
  } else {
    const first = notes[0];
    let end = 0;
    for (const n of notes) end = Math.max(end, noteEnd(n));
    lengthMs = first ? end - first.t : 0;
  }
  return {
    notes: list.length,
    holds: list.filter((n) => n.type === 'hold').length,
    avgNps: lengthMs > 0 ? (list.length * 1000) / lengthMs : 0,
    peakNps: peakCount(list, 1000),
    lengthMs,
  };
}

// --- Normalisation --------------------------------------------------------------------------

function clampInt(value: number, min: number, max: number): number {
  const v = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, v)) + 0;
}

/**
 * Tidy notes before saving: whole-millisecond times, lanes and hold lengths clamped to the legal
 * range, sorted by time then lane. Overlaps are left for parseChart to report: guessing which of
 * two clashing notes to drop would silently lose work.
 */
export function normalizeNotes(notes: readonly Note[]): Note[] {
  return notes
    .map((n) => {
      const t = clampInt(n.t, MIN_NOTE_TIME_MS, Number.MAX_SAFE_INTEGER);
      const lane = clampInt(n.lane, 0, LANE_COUNT - 1) as Lane;
      return n.type === 'hold'
        ? holdNote(lane, t, clampInt(n.dur, MIN_HOLD_MS, Number.MAX_SAFE_INTEGER))
        : tapNote(lane, t);
    })
    .sort(compareNotes);
}

/**
 * The chart exactly as it should be saved or exported: normalised, then checked by parseChart.
 * Callers must not write anything when this fails, so the last good save survives.
 */
export function validatedChart(chart: Chart): ParseResult {
  return parseChart(normalizeChart(chart));
}

/** A chart with normalised notes and whole-number fields clamped to their legal ranges. */
export function normalizeChart(chart: Chart): Chart {
  return {
    ...chart,
    version: CHART_VERSION,
    offsetMs: clampInt(chart.offsetMs, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    previewStartMs: clampInt(chart.previewStartMs, 0, Number.MAX_SAFE_INTEGER),
    level: clampInt(chart.level, MIN_LEVEL, MAX_LEVEL),
    ...(chart.startMs === undefined
      ? {}
      : { startMs: clampInt(chart.startMs, MIN_START_MS, MAX_START_MS) }),
    notes: normalizeNotes(chart.notes),
  };
}
