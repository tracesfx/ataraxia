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
  type Note,
} from './chart';
import { LANE_COUNT } from './constants';

export type ParseResult =
  { ok: true; chart: Chart; errors: [] } | { ok: false; chart: null; errors: string[] };

/** Upper bound for a sane BPM; anything above is almost certainly a typo. */
export const MAX_BPM = 1000;

type RawObject = Record<string, unknown>;

/**
 * Version 1 -> 2. Version 2 allows negative note times and adds the optional `startMs`. A v1
 * chart keeps exactly what it meant before: its notes were never negative (still an error, so a
 * broken v1 file isn't silently accepted) and it had no custom start (a stray `startMs` is
 * dropped, so it starts automatically).
 */
function migrateV1(raw: RawObject): RawObject | string {
  const notes = raw['notes'];
  if (Array.isArray(notes)) {
    const i = notes.findIndex(
      (n: unknown) => isObject(n) && typeof n['t'] === 'number' && n['t'] < 0,
    );
    if (i >= 0) {
      const t = (notes[i] as RawObject)['t'] as number;
      return `Note #${i + 1} (notes[${i}]): "t" must not be negative in a version 1 chart, got ${t}. Change "version" to 2 to allow notes before the audio starts.`;
    }
  }
  const out = { ...raw };
  delete out['startMs'];
  return out;
}

/**
 * Migrations from version N to N + 1, keyed by N. A step returns the upgraded object or an error
 * sentence. When the format changes: bump CHART_VERSION, add `MIGRATIONS[oldVersion]`, and add
 * tests that load an old-format fixture.
 */
const MIGRATIONS: Record<number, (raw: RawObject) => RawObject | string> = { 1: migrateV1 };

function isObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') return 'an object';
  return String(value);
}

/** Bring an older chart up to CHART_VERSION. Returns an error message on failure. */
function migrate(raw: RawObject): RawObject | string {
  const version = raw['version'];
  if (version === undefined) {
    return `"version" is missing; expected a whole number like ${CHART_VERSION}.`;
  }
  if (!Number.isInteger(version) || (version as number) < 1) {
    return `"version" must be a whole number of at least 1, got ${describe(version)}.`;
  }
  let v = version as number;
  if (v > CHART_VERSION) {
    return `Chart version ${v} is newer than this game supports (up to ${CHART_VERSION}). Update the game to load it.`;
  }
  let current = raw;
  while (v < CHART_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) return `No migration available from chart version ${v} to ${v + 1}.`;
    const next = step(current);
    if (typeof next === 'string') return next;
    current = { ...next, version: v + 1 };
    v += 1;
  }
  return current;
}

/**
 * Parse and validate a chart. Accepts a JSON string or an already-parsed value.
 * Collects every problem found rather than stopping at the first one.
 */
export function parseChart(json: unknown): ParseResult {
  let data: unknown = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch (e) {
      return fail([`The file is not valid JSON: ${(e as Error).message}`]);
    }
  }
  if (!isObject(data)) {
    return fail([`A chart must be a JSON object, got ${describe(data)}.`]);
  }

  const migrated = migrate(data);
  if (typeof migrated === 'string') return fail([migrated]);
  const raw = migrated;

  const errors: string[] = [];

  const str = (key: string, { nonEmpty = false } = {}): string => {
    const value = raw[key];
    if (typeof value !== 'string') {
      errors.push(`"${key}" must be text, got ${describe(value)}.`);
      return '';
    }
    if (nonEmpty && value.trim() === '') errors.push(`"${key}" must not be empty.`);
    return value;
  };

  const int = (key: string, min?: number, max?: number): number => {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`"${key}" must be a whole number, got ${describe(value)}.`);
      return 0;
    }
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      const range =
        min !== undefined && max !== undefined
          ? `between ${min} and ${max}`
          : min !== undefined
            ? `at least ${min}`
            : `at most ${String(max)}`;
      errors.push(`"${key}" must be ${range}, got ${value}.`);
    }
    return value;
  };

  const title = str('title', { nonEmpty: true });
  const artist = str('artist');
  const audio = str('audio');
  const difficulty = str('difficulty', { nonEmpty: true });
  const charter = str('charter');

  const bpmRaw = raw['bpm'];
  let bpm = 0;
  if (typeof bpmRaw !== 'number' || !Number.isFinite(bpmRaw)) {
    errors.push(`"bpm" must be a number, got ${describe(bpmRaw)}.`);
  } else if (bpmRaw <= 0 || bpmRaw > MAX_BPM) {
    errors.push(`"bpm" must be greater than 0 and at most ${MAX_BPM}, got ${bpmRaw}.`);
  } else {
    bpm = bpmRaw;
  }

  const offsetMs = int('offsetMs');
  const previewStartMs = int('previewStartMs', 0);
  const level = int('level', MIN_LEVEL, MAX_LEVEL);
  const startMs = parseStartMs(raw['startMs'], errors);

  const notes = parseNotes(raw['notes'], errors);

  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    errors: [],
    chart: {
      version: CHART_VERSION,
      title,
      artist,
      audio,
      bpm,
      offsetMs,
      previewStartMs,
      ...(startMs === undefined ? {} : { startMs }),
      difficulty,
      level,
      charter,
      notes,
    },
  };
}

/** The optional game start: absent (automatic) or whole ms from MIN_START_MS to MAX_START_MS. */
function parseStartMs(value: unknown, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push(
      `"startMs" must be a whole number of milliseconds, got ${describe(value)}. Leave it out to start automatically.`,
    );
    return undefined;
  }
  if (value < MIN_START_MS || value > MAX_START_MS) {
    errors.push(
      `"startMs" must be between ${MIN_START_MS} and ${MAX_START_MS} (at most ${-MIN_START_MS / 1000} seconds before the audio starts), got ${value}.`,
    );
    return undefined;
  }
  return value;
}

function parseNotes(value: unknown, errors: string[]): Note[] {
  if (!Array.isArray(value)) {
    errors.push(`"notes" must be a list, got ${describe(value)}.`);
    return [];
  }

  const notes: Note[] = [];
  // Index into the original array for each valid note, so later messages point at the right entry.
  const sourceIndex: number[] = [];

  value.forEach((item: unknown, i) => {
    const where = `Note #${i + 1} (notes[${i}])`;
    if (!isObject(item)) {
      errors.push(`${where} must be an object, got ${describe(item)}.`);
      return;
    }
    const before = errors.length;
    const { t, lane, type, dur } = item;

    if (typeof t !== 'number' || !Number.isInteger(t)) {
      errors.push(`${where}: "t" must be a whole number of milliseconds, got ${describe(t)}.`);
    } else if (t < MIN_NOTE_TIME_MS) {
      errors.push(
        `${where}: "t" must be at least ${MIN_NOTE_TIME_MS} (${-MIN_NOTE_TIME_MS / 1000} seconds before the audio starts), got ${t}.`,
      );
    }
    if (!isLane(lane)) {
      errors.push(
        `${where}: "lane" must be a whole number from 0 to ${LANE_COUNT - 1}, got ${describe(lane)}.`,
      );
    }
    if (type === 'hold') {
      if (typeof dur !== 'number' || !Number.isInteger(dur)) {
        errors.push(
          `${where}: hold notes need "dur" as a whole number of milliseconds, got ${describe(dur)}.`,
        );
      } else if (dur < MIN_HOLD_MS) {
        errors.push(`${where}: hold "dur" must be at least ${MIN_HOLD_MS} ms, got ${dur}.`);
      }
    } else if (type === 'tap') {
      if (dur !== undefined) {
        errors.push(`${where}: tap notes must not have "dur" (use type "hold" for long notes).`);
      }
    } else {
      errors.push(`${where}: "type" must be "tap" or "hold", got ${describe(type)}.`);
    }

    if (errors.length > before) return;
    const base = { t: t as number, lane: lane as Note['lane'] };
    notes.push(type === 'hold' ? { ...base, type, dur: dur as number } : { ...base, type: 'tap' });
    sourceIndex.push(i);
  });

  const label = (k: number): string => {
    const n = notes[k] as Note;
    const i = sourceIndex[k] as number;
    return `note #${i + 1} (lane ${n.lane} at ${n.t} ms)`;
  };

  for (let k = 1; k < notes.length; k++) {
    if (compareNotes(notes[k - 1] as Note, notes[k] as Note) > 0) {
      errors.push(
        `Notes are out of order: ${label(k)} comes after ${label(k - 1)}. Sort notes by "t", then by "lane".`,
      );
    }
  }

  // Overlap check is done on a sorted copy so it reports correctly even when the order is wrong.
  const order = notes
    .map((_, k) => k)
    .sort((a, b) => compareNotes(notes[a] as Note, notes[b] as Note));
  const lastInLane = new Map<number, number>();
  for (const k of order) {
    const note = notes[k] as Note;
    const prevK = lastInLane.get(note.lane);
    if (prevK !== undefined) {
      const prev = notes[prevK] as Note;
      if (note.t <= noteEnd(prev)) {
        const what =
          prev.type === 'hold'
            ? `starts during the hold ${label(prevK)}, which lasts until ${noteEnd(prev)} ms`
            : `is at the same time as ${label(prevK)}`;
        errors.push(`Overlapping notes in lane ${note.lane}: ${label(k)} ${what}.`);
      }
    }
    if (prevK === undefined || noteEnd(note) >= noteEnd(notes[prevK] as Note)) {
      lastInLane.set(note.lane, k);
    }
  }

  return notes;
}

function fail(errors: string[]): ParseResult {
  return { ok: false, chart: null, errors };
}

/**
 * Serialise a chart in canonical form: always the current version, a stable key order, notes
 * sorted, and `startMs` only when the chart has a custom start.
 */
export function serializeChart(chart: Chart): string {
  const notes = [...chart.notes]
    .sort(compareNotes)
    .map((n) =>
      n.type === 'hold'
        ? { t: n.t, lane: n.lane, type: n.type, dur: n.dur }
        : { t: n.t, lane: n.lane, type: n.type },
    );
  const out = {
    version: CHART_VERSION,
    title: chart.title,
    artist: chart.artist,
    audio: chart.audio,
    bpm: chart.bpm,
    offsetMs: chart.offsetMs,
    previewStartMs: chart.previewStartMs,
    ...(chart.startMs === undefined ? {} : { startMs: chart.startMs }),
    difficulty: chart.difficulty,
    level: chart.level,
    charter: chart.charter,
    notes,
  };
  return JSON.stringify(out, null, 2);
}
