import { describe, expect, it } from 'vitest';
import { parseChart, serializeChart } from '../core/parseChart';
import {
  dedupeFileNames,
  extensionOf,
  safeFileName,
  stripExtension,
  titleFromFileName,
} from './fileNames';
import {
  chartFields,
  compareCharts,
  songMetaOf,
  toChartFile,
  uniqueDifficulty,
  validateChartMeta,
  validateSongMeta,
} from './records';

describe('titleFromFileName', () => {
  it('strips the extension and turns underscores into spaces', () => {
    expect(titleFromFileName('my_cool__song.mp3')).toBe('my cool song');
    expect(titleFromFileName('Artist - Track.final.flac')).toBe('Artist - Track.final');
    expect(titleFromFileName('C:\\music\\a_b.ogg')).toBe('a b');
  });

  it('falls back to Untitled for empty names', () => {
    expect(titleFromFileName('___.wav')).toBe('Untitled');
  });

  it('keeps dotfile names and extension-less names', () => {
    expect(stripExtension('.hidden')).toBe('.hidden');
    expect(stripExtension('noext')).toBe('noext');
    expect(extensionOf('a.M4A')).toBe('m4a');
    expect(extensionOf('noext')).toBe('');
  });
});

describe('safeFileName / dedupeFileNames', () => {
  it('removes reserved characters and trailing dots', () => {
    expect(safeFileName('a/b:c*?"<>|d.')).toBe('a b c d');
    expect(safeFileName('   ')).toBe('untitled');
  });

  it('dedupes case-insensitively before the extension', () => {
    expect(dedupeFileNames(['a.json', 'A.json', 'a.json', 'b'])).toEqual([
      'a.json',
      'A (2).json',
      'a (3).json',
      'b',
    ]);
  });
});

describe('validation', () => {
  const meta = { title: 'T', artist: '', bpm: 120, offsetMs: -15, previewStartMs: 0 };

  it('accepts valid song metadata', () => {
    expect(validateSongMeta(meta)).toEqual([]);
  });

  it('reports each problem as a sentence', () => {
    const errors = validateSongMeta({ ...meta, title: '', bpm: 2000, offsetMs: 1.5 });
    expect(errors).toHaveLength(3);
    for (const e of errors) expect(e).toMatch(/^[A-Z].*\.$/);
  });

  it('validates chart metadata', () => {
    expect(validateChartMeta({ difficulty: 'Hard', level: 20 })).toEqual([]);
    expect(validateChartMeta({ difficulty: ' ', level: 1.5 })).toHaveLength(2);
  });
});

describe('chart file conversion', () => {
  it('round-trips through the chart file format', () => {
    const song = {
      title: 'T',
      artist: 'A',
      audioFileName: 't.mp3',
      bpm: 140,
      offsetMs: 10,
      previewStartMs: 500,
    };
    const chart = {
      difficulty: 'Hard',
      level: 9,
      charter: 'C',
      notes: [
        { t: 200, lane: 1 as const, type: 'tap' as const },
        { t: 100, lane: 0 as const, type: 'tap' as const },
      ],
    };
    const parsed = parseChart(serializeChart(toChartFile(song, chart)));
    expect(parsed.ok).toBe(true);
    const file = parsed.chart!;
    expect(file.audio).toBe('t.mp3');
    expect(file.notes.map((n) => n.t)).toEqual([100, 200]);
    expect(file.version).toBe(2);
    expect(file).not.toHaveProperty('startMs');
    // An automatic start is stored as null.
    expect(chartFields(file)).toEqual({ ...chart, notes: file.notes, startMs: null });
    expect(songMetaOf(file)).toEqual({
      title: 'T',
      artist: 'A',
      bpm: 140,
      offsetMs: 10,
      previewStartMs: 500,
    });
  });
});

describe('game start in the library', () => {
  const song = {
    title: 'T',
    artist: '',
    audioFileName: 't.mp3',
    bpm: 120,
    offsetMs: 0,
    previewStartMs: 0,
  };
  const notes = [{ t: -2000, lane: 1 as const, type: 'tap' as const }];

  it('carries a custom start through the chart file and back', () => {
    const file = toChartFile(song, {
      difficulty: 'N',
      level: 1,
      charter: '',
      notes,
      startMs: -3000,
    });
    expect(file.startMs).toBe(-3000);
    const parsed = parseChart(serializeChart(file));
    expect(parsed.ok).toBe(true);
    expect(chartFields(parsed.chart!).startMs).toBe(-3000);
  });

  it('treats a missing or null start (older records) as automatic', () => {
    const old = { difficulty: 'N', level: 1, charter: '', notes };
    expect(toChartFile(song, old)).not.toHaveProperty('startMs');
    expect(toChartFile(song, { ...old, startMs: null })).not.toHaveProperty('startMs');
  });
});

describe('chart order and naming', () => {
  it('sorts known difficulties first, then level, then name', () => {
    const list = [
      { difficulty: 'Zany', level: 1 },
      { difficulty: 'Hard', level: 9 },
      { difficulty: 'Normal 2', level: 6 },
      { difficulty: 'Easy', level: 3 },
      { difficulty: 'Normal', level: 5 },
      { difficulty: 'Alpha', level: 1 },
    ];
    expect(list.sort(compareCharts).map((c) => c.difficulty)).toEqual([
      'Easy',
      'Normal',
      'Normal 2',
      'Hard',
      'Alpha',
      'Zany',
    ]);
  });

  it('picks an unused difficulty name', () => {
    expect(uniqueDifficulty('Normal', [])).toBe('Normal');
    expect(uniqueDifficulty('Normal', ['normal', 'Normal 2'])).toBe('Normal 3');
  });
});
