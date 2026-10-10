import { describe, expect, it } from 'vitest';
import { CHART_VERSION, type Chart } from './chart';
import { parseChart, serializeChart } from './parseChart';

function validRaw(): Record<string, unknown> {
  return {
    version: 1,
    title: 'My Song',
    artist: 'Someone',
    audio: 'song.ogg',
    bpm: 150,
    offsetMs: 320,
    previewStartMs: 30000,
    difficulty: 'Normal',
    level: 7,
    charter: 'Me',
    notes: [
      { t: 1200, lane: 0, type: 'tap' },
      { t: 1600, lane: 2, type: 'hold', dur: 400 },
    ],
  };
}

function errorsFor(raw: unknown): string[] {
  const result = parseChart(raw);
  expect(result.ok).toBe(false);
  return result.errors;
}

function withNotes(notes: unknown): Record<string, unknown> {
  return { ...validRaw(), notes };
}

describe('parseChart: valid input', () => {
  it('accepts the example chart from the spec', () => {
    const result = parseChart(validRaw());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.chart?.notes).toHaveLength(2);
    expect(result.chart?.notes[1]).toEqual({ t: 1600, lane: 2, type: 'hold', dur: 400 });
  });

  it('accepts a JSON string', () => {
    expect(parseChart(JSON.stringify(validRaw())).ok).toBe(true);
  });

  it('accepts fractional BPM, negative offset, empty notes and empty optional text', () => {
    const result = parseChart({
      ...validRaw(),
      bpm: 128.5,
      offsetMs: -40,
      artist: '',
      charter: '',
      audio: '',
      notes: [],
    });
    expect(result.ok).toBe(true);
  });

  it('allows a note in the same lane right after a hold ends', () => {
    const result = parseChart(
      withNotes([
        { t: 0, lane: 1, type: 'hold', dur: 50 },
        { t: 51, lane: 1, type: 'tap' },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('allows chords (same time, different lanes)', () => {
    const result = parseChart(
      withNotes([
        { t: 500, lane: 0, type: 'tap' },
        { t: 500, lane: 1, type: 'tap' },
        { t: 500, lane: 3, type: 'hold', dur: 100 },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('drops unknown fields', () => {
    const result = parseChart({
      ...validRaw(),
      extra: 1,
      notes: [{ t: 0, lane: 0, type: 'tap', color: 'red' }],
    });
    expect(result.ok).toBe(true);
    expect(result.chart).not.toHaveProperty('extra');
    expect(result.chart?.notes[0]).toEqual({ t: 0, lane: 0, type: 'tap' });
  });

  it('round-trips through serializeChart', () => {
    const chart = parseChart(validRaw()).chart as Chart;
    const again = parseChart(serializeChart(chart));
    expect(again.ok).toBe(true);
    expect(again.chart).toEqual(chart);
  });

  it('serializeChart sorts notes', () => {
    const chart = parseChart(validRaw()).chart as Chart;
    const shuffled: Chart = { ...chart, notes: [...chart.notes].reverse() };
    expect(parseChart(serializeChart(shuffled)).ok).toBe(true);
  });
});

describe('parseChart: top-level errors', () => {
  it('reports invalid JSON', () => {
    expect(errorsFor('{ not json')[0]).toMatch(/not valid JSON/);
  });

  it('reports non-object roots', () => {
    expect(errorsFor([])[0]).toMatch(/must be a JSON object, got an array/);
    expect(errorsFor(null)[0]).toMatch(/must be a JSON object, got null/);
    expect(errorsFor(42)[0]).toMatch(/must be a JSON object/);
  });

  it('reports missing, invalid and future versions', () => {
    const { version: _v, ...noVersion } = validRaw();
    expect(errorsFor(noVersion)[0]).toMatch(/"version" is missing/);
    expect(errorsFor({ ...validRaw(), version: '1' })[0]).toMatch(
      /"version" must be a whole number/,
    );
    expect(errorsFor({ ...validRaw(), version: 0 })[0]).toMatch(/"version" must be a whole number/);
    expect(errorsFor({ ...validRaw(), version: CHART_VERSION + 1 })[0]).toMatch(
      /newer than this game supports/,
    );
  });

  it.each(['title', 'difficulty'])('requires non-empty %s', (key) => {
    expect(errorsFor({ ...validRaw(), [key]: '  ' })).toEqual([`"${key}" must not be empty.`]);
  });

  it.each(['title', 'artist', 'audio', 'difficulty', 'charter'])(
    'requires %s to be text',
    (key) => {
      expect(errorsFor({ ...validRaw(), [key]: 5 })).toEqual([`"${key}" must be text, got 5.`]);
      const rest = Object.fromEntries(Object.entries(validRaw()).filter(([k]) => k !== key));
      expect(errorsFor(rest)).toEqual([`"${key}" must be text, got missing.`]);
    },
  );

  it('validates bpm', () => {
    expect(errorsFor({ ...validRaw(), bpm: '150' })[0]).toMatch(/"bpm" must be a number/);
    expect(errorsFor({ ...validRaw(), bpm: 0 })[0]).toMatch(/"bpm" must be greater than 0/);
    expect(errorsFor({ ...validRaw(), bpm: -10 })[0]).toMatch(/"bpm" must be greater than 0/);
    expect(errorsFor({ ...validRaw(), bpm: 5000 })[0]).toMatch(/at most 1000/);
  });

  it('validates offsetMs and previewStartMs', () => {
    expect(errorsFor({ ...validRaw(), offsetMs: 1.5 })[0]).toMatch(
      /"offsetMs" must be a whole number/,
    );
    expect(errorsFor({ ...validRaw(), previewStartMs: -1 })[0]).toMatch(
      /"previewStartMs" must be at least 0/,
    );
  });

  it('validates level range and integrality', () => {
    expect(errorsFor({ ...validRaw(), level: 0 })).toEqual([
      '"level" must be between 1 and 20, got 0.',
    ]);
    expect(errorsFor({ ...validRaw(), level: 21 })).toEqual([
      '"level" must be between 1 and 20, got 21.',
    ]);
    expect(errorsFor({ ...validRaw(), level: 7.5 })[0]).toMatch(/"level" must be a whole number/);
    expect(parseChart({ ...validRaw(), level: 1 }).ok).toBe(true);
    expect(parseChart({ ...validRaw(), level: 20 }).ok).toBe(true);
  });

  it('requires notes to be a list', () => {
    expect(errorsFor(withNotes({}))).toEqual(['"notes" must be a list, got an object.']);
    const { notes: _n, ...rest } = validRaw();
    expect(errorsFor(rest)).toEqual(['"notes" must be a list, got missing.']);
  });

  it('collects several errors at once', () => {
    expect(errorsFor({ ...validRaw(), title: 1, bpm: 0, level: 99 })).toHaveLength(3);
  });
});

describe('parseChart: note errors', () => {
  it('rejects non-object notes', () => {
    expect(errorsFor(withNotes([5]))).toEqual(['Note #1 (notes[0]) must be an object, got 5.']);
  });

  it('requires integer, non-negative t', () => {
    expect(errorsFor(withNotes([{ t: 1.5, lane: 0, type: 'tap' }]))[0]).toMatch(
      /Note #1 \(notes\[0\]\): "t" must be a whole number/,
    );
    expect(errorsFor(withNotes([{ lane: 0, type: 'tap' }]))[0]).toMatch(
      /"t" must be a whole number of milliseconds, got missing/,
    );
    expect(errorsFor(withNotes([{ t: -10, lane: 0, type: 'tap' }]))[0]).toMatch(
      /"t" must not be negative/,
    );
  });

  it.each([-1, 4, 1.5, '0', null])('rejects lane %s', (lane) => {
    expect(errorsFor(withNotes([{ t: 0, lane, type: 'tap' }]))[0]).toMatch(
      /"lane" must be a whole number from 0 to 3/,
    );
  });

  it('rejects unknown note types', () => {
    expect(errorsFor(withNotes([{ t: 0, lane: 0, type: 'slide' }]))[0]).toMatch(
      /"type" must be "tap" or "hold", got "slide"/,
    );
  });

  it('requires dur on holds, integer and >= 50', () => {
    expect(errorsFor(withNotes([{ t: 0, lane: 0, type: 'hold' }]))[0]).toMatch(
      /hold notes need "dur"/,
    );
    expect(errorsFor(withNotes([{ t: 0, lane: 0, type: 'hold', dur: 100.5 }]))[0]).toMatch(
      /hold notes need "dur"/,
    );
    expect(errorsFor(withNotes([{ t: 0, lane: 0, type: 'hold', dur: 49 }]))[0]).toMatch(
      /hold "dur" must be at least 50 ms, got 49/,
    );
    expect(parseChart(withNotes([{ t: 0, lane: 0, type: 'hold', dur: 50 }])).ok).toBe(true);
  });

  it('rejects dur on taps', () => {
    expect(errorsFor(withNotes([{ t: 0, lane: 0, type: 'tap', dur: 100 }]))[0]).toMatch(
      /tap notes must not have "dur"/,
    );
  });

  it('requires sorting by t', () => {
    const errors = errorsFor(
      withNotes([
        { t: 500, lane: 0, type: 'tap' },
        { t: 100, lane: 1, type: 'tap' },
      ]),
    );
    expect(errors).toEqual([
      'Notes are out of order: note #2 (lane 1 at 100 ms) comes after note #1 (lane 0 at 500 ms). Sort notes by "t", then by "lane".',
    ]);
  });

  it('requires sorting by lane when t is equal', () => {
    const errors = errorsFor(
      withNotes([
        { t: 100, lane: 2, type: 'tap' },
        { t: 100, lane: 1, type: 'tap' },
      ]),
    );
    expect(errors[0]).toMatch(/out of order/);
  });

  it('rejects duplicate taps in one lane', () => {
    const errors = errorsFor(
      withNotes([
        { t: 100, lane: 1, type: 'tap' },
        { t: 100, lane: 1, type: 'tap' },
      ]),
    );
    expect(errors).toEqual([
      'Overlapping notes in lane 1: note #2 (lane 1 at 100 ms) is at the same time as note #1 (lane 1 at 100 ms).',
    ]);
  });

  it('rejects notes inside a hold, including at its exact end', () => {
    const errors = errorsFor(
      withNotes([
        { t: 100, lane: 0, type: 'hold', dur: 400 },
        { t: 300, lane: 0, type: 'tap' },
      ]),
    );
    expect(errors).toEqual([
      'Overlapping notes in lane 0: note #2 (lane 0 at 300 ms) starts during the hold note #1 (lane 0 at 100 ms), which lasts until 500 ms.',
    ]);
    const atEnd = errorsFor(
      withNotes([
        { t: 100, lane: 0, type: 'hold', dur: 400 },
        { t: 500, lane: 0, type: 'tap' },
      ]),
    );
    expect(atEnd[0]).toMatch(/Overlapping notes in lane 0/);
  });

  it('detects overlap with a long hold even after an intervening note', () => {
    const errors = errorsFor(
      withNotes([
        { t: 0, lane: 0, type: 'hold', dur: 1000 },
        { t: 200, lane: 0, type: 'tap' },
        { t: 600, lane: 0, type: 'tap' },
      ]),
    );
    expect(errors).toHaveLength(2);
    expect(errors[1]).toMatch(/note #3 .* starts during the hold note #1/);
  });

  it('detects overlap even when notes are unsorted', () => {
    const errors = errorsFor(
      withNotes([
        { t: 300, lane: 0, type: 'tap' },
        { t: 100, lane: 0, type: 'hold', dur: 400 },
      ]),
    );
    expect(errors.some((e) => e.startsWith('Notes are out of order'))).toBe(true);
    expect(errors.some((e) => e.startsWith('Overlapping notes in lane 0'))).toBe(true);
  });

  it('reports original indices after skipping invalid notes', () => {
    const errors = errorsFor(
      withNotes([
        { t: 0, lane: 9, type: 'tap' },
        { t: 100, lane: 0, type: 'tap' },
        { t: 100, lane: 0, type: 'tap' },
      ]),
    );
    expect(errors).toHaveLength(2);
    expect(errors[1]).toMatch(/note #3 .* same time as note #2/);
  });
});

describe('chart format v2', () => {
  /** The spec example as a version 2 chart. */
  function v2(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...validRaw(), version: 2, ...extra };
  }

  it('is the current version', () => {
    expect(CHART_VERSION).toBe(2);
  });

  it('migrates a v1 chart in memory with no change in meaning', () => {
    const fromV1 = parseChart(validRaw());
    const fromV2 = parseChart(v2());
    expect(fromV1.ok).toBe(true);
    expect(fromV1.chart).toEqual(fromV2.chart);
    expect(fromV1.chart?.version).toBe(2);
    // No custom start: it starts automatically.
    expect(fromV1.chart).not.toHaveProperty('startMs');
  });

  it('keeps v1 rules for v1 charts: no negative note times, no startMs', () => {
    expect(errorsFor(withNotes([{ t: -10, lane: 0, type: 'tap' }]))[0]).toMatch(
      /must not be negative in a version 1 chart.*Change "version" to 2/,
    );
    const stray = parseChart({ ...validRaw(), startMs: -2000 });
    expect(stray.ok).toBe(true);
    expect(stray.chart).not.toHaveProperty('startMs');
  });

  it('accepts negative note times down to -30000', () => {
    const result = parseChart(
      v2({
        notes: [
          { t: -30000, lane: 0, type: 'tap' },
          { t: -1500, lane: 1, type: 'hold', dur: 1000 },
          { t: 0, lane: 2, type: 'tap' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.chart?.notes.map((n) => n.t)).toEqual([-30000, -1500, 0]);
  });

  it('rejects notes earlier than -30000 with a clear message', () => {
    const errors = errorsFor(v2({ notes: [{ t: -30001, lane: 0, type: 'tap' }] }));
    expect(errors[0]).toMatch(/"t" must be at least -30000 \(30 seconds before the audio starts\)/);
  });

  it('keeps the other note rules in negative time', () => {
    const errors = errorsFor(
      v2({
        notes: [
          { t: -1000, lane: 0, type: 'hold', dur: 600 },
          { t: -500, lane: 0, type: 'tap' },
          { t: -2000, lane: 1, type: 'tap' },
          { t: -100, lane: 2, type: 'hold', dur: 49 },
        ],
      }),
    );
    expect(errors.some((e) => e.startsWith('Notes are out of order'))).toBe(true);
    expect(errors.some((e) => /Overlapping notes in lane 0/.test(e))).toBe(true);
    expect(errors.some((e) => /at least 50 ms/.test(e))).toBe(true);
  });

  it('accepts startMs from -30000 to 0', () => {
    for (const startMs of [-30000, -3000, 0]) {
      const result = parseChart(v2({ startMs }));
      expect(result.ok).toBe(true);
      expect(result.chart?.startMs).toBe(startMs);
    }
  });

  it.each([
    [1, /"startMs" must be between -30000 and 0/],
    [-30001, /"startMs" must be between -30000 and 0/],
    [-1.5, /"startMs" must be a whole number of milliseconds.*Leave it out/],
    ['-100', /"startMs" must be a whole number/],
    [null, /"startMs" must be a whole number/],
  ])('rejects startMs %s', (startMs, message) => {
    expect(errorsFor(v2({ startMs }))[0]).toMatch(message);
  });

  it('always serializes as v2 and keeps startMs only when set', () => {
    const auto = parseChart(validRaw()).chart as Chart;
    const autoJson = JSON.parse(serializeChart(auto)) as Record<string, unknown>;
    expect(autoJson['version']).toBe(2);
    expect(autoJson).not.toHaveProperty('startMs');

    const custom = parseChart(v2({ startMs: -3000, notes: [{ t: -2000, lane: 3, type: 'tap' }] }))
      .chart as Chart;
    const json = serializeChart(custom);
    expect(JSON.parse(json)).toMatchObject({ version: 2, startMs: -3000 });
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'version',
      'title',
      'artist',
      'audio',
      'bpm',
      'offsetMs',
      'previewStartMs',
      'startMs',
      'difficulty',
      'level',
      'charter',
      'notes',
    ]);
    expect(parseChart(json).chart).toEqual(custom);
  });
});
