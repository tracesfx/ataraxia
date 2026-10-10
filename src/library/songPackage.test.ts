import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { defaultBackgroundConfig } from '../core/background/config';
import type { Note } from '../core/chart';
import { parseChart } from '../core/parseChart';
import {
  MAX_PACKAGE_COVER_BYTES,
  PACKAGE_VERSION,
  buildSongPackage,
  readSongPackage,
  sniffImageType,
  type SongPackageInput,
} from './songPackage';

const notes: Note[] = [
  { t: 1000, lane: 0, type: 'tap' },
  { t: 1500, lane: 2, type: 'hold', dur: 400 },
];
const audio = new Uint8Array(Array.from({ length: 2048 }, (_, i) => (i * 37) % 256));

const input: SongPackageInput = {
  song: {
    title: 'Night Drive',
    artist: 'Someone',
    audioFileName: 'night_drive.ogg',
    bpm: 128.5,
    offsetMs: -20,
    previewStartMs: 30000,
  },
  audio,
  charts: [
    { difficulty: 'Normal', level: 5, charter: 'Me', notes },
    { difficulty: 'Hard', level: 11, charter: 'Me', notes: [] },
  ],
};

function entries(zip: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zip);
}

/** Rebuild a package after changing its files. */
function rezip(zip: Uint8Array, change: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = entries(zip);
  change(files);
  return zipSync(files as Zippable);
}

function expectErrors(bytes: Uint8Array, pattern: RegExp): string[] {
  const result = readSongPackage(bytes);
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => pattern.test(e))).toBe(true);
  return result.errors;
}

describe('buildSongPackage', () => {
  it('writes song.json, the audio file and one chart file per difficulty', () => {
    const files = entries(buildSongPackage(input));
    expect(Object.keys(files).sort()).toEqual([
      'charts/Hard.json',
      'charts/Normal.json',
      'night_drive.ogg',
      'song.json',
    ]);
    expect(JSON.parse(strFromU8(files['song.json']!))).toMatchObject({
      title: 'Night Drive',
      artist: 'Someone',
      audio: 'night_drive.ogg',
      bpm: 128.5,
      offsetMs: -20,
      previewStartMs: 30000,
    });
    expect(files['night_drive.ogg']).toEqual(audio);
  });

  it('writes standard v2 chart files that parseChart accepts', () => {
    const files = entries(buildSongPackage(input));
    const parsed = parseChart(strFromU8(files['charts/Normal.json']!));
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(strFromU8(files['charts/Normal.json']!))).toMatchObject({ version: 2 });
    expect(parsed.chart).toMatchObject({
      version: 2,
      title: 'Night Drive',
      audio: 'night_drive.ogg',
      bpm: 128.5,
      difficulty: 'Normal',
      level: 5,
      notes,
    });
  });

  it('gives charts with the same difficulty distinct file names', () => {
    const files = entries(
      buildSongPackage({
        ...input,
        charts: [
          { difficulty: 'Hard', level: 1, charter: '', notes: [] },
          { difficulty: 'hard', level: 2, charter: '', notes: [] },
          { difficulty: 'a/b', level: 2, charter: '', notes: [] },
        ],
      }),
    );
    expect(
      Object.keys(files)
        .filter((n) => n.startsWith('charts/'))
        .sort(),
    ).toEqual(['charts/Hard.json', 'charts/a b.json', 'charts/hard (2).json']);
  });
});

describe('readSongPackage round trip', () => {
  it('reads back exactly what was exported', () => {
    const result = readSongPackage(buildSongPackage(input));
    expect(result.errors).toEqual([]);
    const contents = result.contents!;
    expect(contents.song).toEqual({
      title: 'Night Drive',
      artist: 'Someone',
      bpm: 128.5,
      offsetMs: -20,
      previewStartMs: 30000,
    });
    expect(contents.audioFileName).toBe('night_drive.ogg');
    expect(contents.audio).toEqual(audio);
    expect(contents.charts.map((c) => [c.difficulty, c.level, c.notes])).toEqual([
      ['Hard', 11, []],
      ['Normal', 5, notes],
    ]);
  });

  it('carries the game start and negative note times through a package', () => {
    const early: Note[] = [
      { t: -2500, lane: 1, type: 'tap' },
      { t: 0, lane: 0, type: 'tap' },
    ];
    const result = readSongPackage(
      buildSongPackage({
        ...input,
        charts: [
          { difficulty: 'Early', level: 3, charter: '', notes: early, startMs: -4000 },
          { difficulty: 'Auto', level: 2, charter: '', notes: early, startMs: null },
        ],
      }),
    );
    expect(result.errors).toEqual([]);
    const byName = Object.fromEntries(result.contents!.charts.map((c) => [c.difficulty, c]));
    expect(byName['Early']?.startMs).toBe(-4000);
    expect(byName['Early']?.notes).toEqual(early);
    expect(byName['Auto']).not.toHaveProperty('startMs');
  });

  it('still loads an older package with version 1 chart files', () => {
    const v1Chart = {
      version: 1,
      title: 'x',
      artist: '',
      audio: 'night_drive.ogg',
      bpm: 120,
      offsetMs: 0,
      previewStartMs: 0,
      difficulty: 'Old',
      level: 4,
      charter: '',
      notes,
    };
    const zip = rezip(buildSongPackage({ ...input, charts: [] }), (files) => {
      files['charts/Old.json'] = strToU8(JSON.stringify(v1Chart));
    });
    const result = readSongPackage(zip);
    expect(result.errors).toEqual([]);
    expect(result.contents!.charts[0]).toMatchObject({ version: 2, difficulty: 'Old', notes });
    expect(result.contents!.charts[0]).not.toHaveProperty('startMs');
  });

  it('accepts a package with no charts', () => {
    const result = readSongPackage(buildSongPackage({ ...input, charts: [] }));
    expect(result.ok).toBe(true);
    expect(result.contents?.charts).toEqual([]);
  });

  it('accepts a package re-zipped inside one folder', () => {
    const files = entries(buildSongPackage(input));
    const nested: Zippable = {};
    for (const [name, data] of Object.entries(files)) nested[`Night Drive/${name}`] = data;
    const result = readSongPackage(zipSync(nested));
    expect(result.ok).toBe(true);
    expect(result.contents?.charts).toHaveLength(2);
  });

  it('finds the audio without an "audio" field when it is the only other top-level file', () => {
    const zip = rezip(buildSongPackage(input), (files) => {
      const song = JSON.parse(strFromU8(files['song.json']!)) as Record<string, unknown>;
      delete song['audio'];
      files['song.json'] = strToU8(JSON.stringify(song));
    });
    expect(readSongPackage(zip).contents?.audioFileName).toBe('night_drive.ogg');
  });

  it('uses song.json for song-level chart fields', () => {
    const zip = rezip(buildSongPackage(input), (files) => {
      const chart = JSON.parse(strFromU8(files['charts/Normal.json']!)) as Record<string, unknown>;
      chart['bpm'] = 90;
      chart['title'] = 'Other';
      files['charts/Normal.json'] = strToU8(JSON.stringify(chart));
    });
    const normal = readSongPackage(zip).contents?.charts.find((c) => c.difficulty === 'Normal');
    expect(normal).toMatchObject({ bpm: 128.5, title: 'Night Drive' });
  });
});

describe('readSongPackage rejects bad packages', () => {
  it('rejects bytes that are not a zip', () => {
    expectErrors(strToU8('definitely not a zip file'), /not a valid song package/);
  });

  it('rejects a truncated zip', () => {
    const zip = buildSongPackage(input);
    const errors = readSongPackage(zip.slice(0, zip.length - 100)).errors;
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a zip with corrupted compressed data', () => {
    const zip = buildSongPackage(input);
    const corrupted = zip.slice();
    // Scramble the middle of the archive (compressed chart data and audio).
    for (let i = 60; i < 400; i++) corrupted[i] = (corrupted[i]! * 7 + 13) % 256;
    expect(readSongPackage(corrupted).ok).toBe(false);
  });

  it('rejects a package without song.json', () => {
    const zip = rezip(buildSongPackage(input), (files) => delete files['song.json']);
    expectErrors(zip, /has no song\.json/);
  });

  it('rejects song.json that is not valid JSON', () => {
    const zip = rezip(buildSongPackage(input), (f) => (f['song.json'] = strToU8('{ nope')));
    expectErrors(zip, /song\.json is not valid JSON/);
  });

  it('rejects invalid song metadata', () => {
    const zip = rezip(buildSongPackage(input), (files) => {
      files['song.json'] = strToU8(
        JSON.stringify({ title: '', bpm: 'fast', audio: 'night_drive.ogg' }),
      );
    });
    const errors = expectErrors(zip, /title must not be empty/);
    expect(errors.some((e) => /BPM/.test(e))).toBe(true);
  });

  it('rejects a newer package version', () => {
    const zip = rezip(buildSongPackage(input), (files) => {
      const song = JSON.parse(strFromU8(files['song.json']!)) as Record<string, unknown>;
      files['song.json'] = strToU8(JSON.stringify({ ...song, version: 99 }));
    });
    expectErrors(zip, /package version 99/);
  });

  it('rejects a package whose audio file is missing', () => {
    const zip = rezip(buildSongPackage(input), (files) => delete files['night_drive.ogg']);
    expectErrors(zip, /does not contain it/);
  });

  it('rejects an empty audio file', () => {
    const zip = rezip(buildSongPackage(input), (f) => (f['night_drive.ogg'] = new Uint8Array()));
    expectErrors(zip, /is empty/);
  });

  it('rejects the whole package when any chart is invalid, naming the file', () => {
    const zip = rezip(buildSongPackage(input), (files) => {
      files['charts/Hard.json'] = strToU8(
        JSON.stringify({
          ...JSON.parse(strFromU8(files['charts/Hard.json']!)),
          level: 0,
          notes: [{ t: 5, lane: 9, type: 'tap' }],
        }),
      );
    });
    const result = readSongPackage(zip);
    expect(result.ok).toBe(false);
    expect(result.contents).toBeNull();
    expect(result.errors.every((e) => e.startsWith('charts/Hard.json: '))).toBe(true);
    expect(result.errors).toHaveLength(2);
  });

  it('rejects a chart file that is not JSON', () => {
    const zip = rezip(
      buildSongPackage(input),
      (f) => (f['charts/Normal.json'] = strToU8('<xml/>')),
    );
    expectErrors(zip, /^charts\/Normal\.json: The file is not valid JSON/);
  });
});

describe('package covers', () => {
  /** A tiny fake WebP (only the signature matters to the package reader). */
  const webp = new Uint8Array([...strToU8('RIFF'), 1, 0, 0, 0, ...strToU8('WEBPVP8 '), 9, 8, 7]);
  const withCover: SongPackageInput = { ...input, cover: { fileName: 'cover.webp', bytes: webp } };

  it('writes cover.webp and names it in song.json', () => {
    const files = entries(buildSongPackage(withCover));
    expect(files['cover.webp']).toEqual(webp);
    const song = JSON.parse(strFromU8(files['song.json']!)) as Record<string, unknown>;
    expect(song['cover']).toBe('cover.webp');
    expect(song['version']).toBe(PACKAGE_VERSION);
  });

  it('writes no cover entry or field without a cover', () => {
    const files = entries(buildSongPackage(input));
    expect(Object.keys(files).some((n) => n.startsWith('cover'))).toBe(false);
    expect(JSON.parse(strFromU8(files['song.json']!))).not.toHaveProperty('cover');
  });

  it('round-trips the cover bytes', () => {
    const result = readSongPackage(buildSongPackage(withCover));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.contents?.cover).toEqual({
      fileName: 'cover.webp',
      type: 'image/webp',
      bytes: webp,
    });
  });

  it('round-trips a song without a cover', () => {
    const result = readSongPackage(buildSongPackage(input));
    expect(result.ok).toBe(true);
    expect(result.contents?.cover).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('names a PNG cover cover.png', () => {
    const png = new Uint8Array([0x89, ...strToU8('PNG\r\n\x1a\n'), 0, 0]);
    const zip = buildSongPackage({ ...input, cover: { fileName: 'cover.png', bytes: png } });
    const result = readSongPackage(zip);
    expect(result.contents?.cover).toMatchObject({ fileName: 'cover.png', type: 'image/png' });
  });

  it('still imports a version 1 package (no cover field, no cover file)', () => {
    const zip = rezip(buildSongPackage(input), (files) => {
      const song = JSON.parse(strFromU8(files['song.json']!)) as Record<string, unknown>;
      files['song.json'] = strToU8(JSON.stringify({ ...song, version: 1 }));
    });
    const result = readSongPackage(zip);
    expect(result.ok).toBe(true);
    expect(result.contents?.cover).toBeNull();
  });

  it('imports without the cover, with a warning, when the named cover is missing', () => {
    const zip = rezip(buildSongPackage(withCover), (files) => delete files['cover.webp']);
    const result = readSongPackage(zip);
    expect(result.ok).toBe(true);
    expect(result.contents?.cover).toBeNull();
    expect(result.warnings[0]).toMatch(/names the cover "cover\.webp", but the package/);
  });

  it('imports without the cover, with a warning, when the cover is not a picture', () => {
    const zip = rezip(buildSongPackage(withCover), (files) => {
      files['cover.webp'] = strToU8('definitely not a picture');
    });
    const result = readSongPackage(zip);
    expect(result.ok).toBe(true);
    expect(result.contents?.cover).toBeNull();
    expect(result.warnings[0]).toMatch(/not a PNG, JPEG, WebP, GIF or AVIF picture/);
  });

  it('imports without the cover, with a warning, when the cover is too large', () => {
    const zip = rezip(buildSongPackage(withCover), (files) => {
      const big = new Uint8Array(MAX_PACKAGE_COVER_BYTES + 1);
      big.set(webp);
      files['cover.webp'] = big;
    });
    const result = readSongPackage(zip);
    expect(result.ok).toBe(true);
    expect(result.contents?.cover).toBeNull();
    expect(result.warnings[0]).toMatch(/larger than 5 MB/);
  });

  it('does not mistake the cover for the audio when song.json names no audio', () => {
    const zip = rezip(buildSongPackage(withCover), (files) => {
      const song = JSON.parse(strFromU8(files['song.json']!)) as Record<string, unknown>;
      delete song['audio'];
      files['song.json'] = strToU8(JSON.stringify(song));
    });
    const result = readSongPackage(zip);
    expect(result.errors).toEqual([]);
    expect(result.contents?.audioFileName).toBe('night_drive.ogg');
    expect(result.contents?.cover?.fileName).toBe('cover.webp');
  });
});

describe('sniffImageType', () => {
  it('recognises cover picture signatures', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(strToU8('GIF89a...'))).toBe('image/gif');
    expect(sniffImageType(new Uint8Array([0, 0, 0, 28, ...strToU8('ftypavif')]))).toBe(
      'image/avif',
    );
    expect(sniffImageType(strToU8('<svg></svg>'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('package backgrounds', () => {
  const webp = new Uint8Array([...strToU8('RIFF'), 1, 0, 0, 0, ...strToU8('WEBPVP8 '), 4, 5, 6]);
  const background = defaultBackgroundConfig('image');

  it('round-trips a background config and picture', () => {
    const zip = buildSongPackage({
      ...input,
      background,
      backgroundImages: [{ id: 'a', type: 'image/webp', bytes: webp }],
    });
    const files = entries(zip);
    expect(files['backgrounds/a.webp']).toEqual(webp);
    const song = JSON.parse(strFromU8(files['song.json']!)) as Record<string, unknown>;
    expect(song['version']).toBe(PACKAGE_VERSION);
    const read = readSongPackage(zip);
    expect(read.ok).toBe(true);
    expect(read.warnings).toEqual([]);
    expect(read.contents?.background).toEqual(background);
    expect(read.contents?.backgroundImages[0]).toMatchObject({
      id: 'a',
      fileName: 'backgrounds/a.webp',
      type: 'image/webp',
    });
    expect(read.contents?.backgroundImages[0]?.bytes).toEqual(webp);
    // The picture is never mistaken for the audio.
    expect(read.contents?.audioFileName).toBe('night_drive.ogg');
  });

  it('a config without a picture (base none) round-trips too', () => {
    const ripples = defaultBackgroundConfig('none');
    const read = readSongPackage(buildSongPackage({ ...input, background: ripples }));
    expect(read.contents?.background).toEqual(ripples);
    expect(read.contents?.backgroundImages).toEqual([]);
  });

  it('old packages without a background still import, with the default background', () => {
    const old = rezip(buildSongPackage(input), (files) => {
      const song = JSON.parse(strFromU8(files['song.json']!)) as Record<string, unknown>;
      song['version'] = 2;
      files['song.json'] = strToU8(JSON.stringify(song));
    });
    const read = readSongPackage(old);
    expect(read.ok).toBe(true);
    expect(read.contents?.background).toBeNull();
    expect(read.contents?.backgroundImages).toEqual([]);
  });

  it('a broken background only warns', () => {
    const zip = rezip(buildSongPackage(input), (files) => {
      const song = JSON.parse(strFromU8(files['song.json']!)) as Record<string, unknown>;
      song['background'] = { style: 'lasers' };
      song['backgroundImage'] = 'missing.webp';
      files['song.json'] = strToU8(JSON.stringify(song));
    });
    const read = readSongPackage(zip);
    expect(read.ok).toBe(true);
    expect(read.contents?.background).toBeNull();
    expect(read.warnings.join(' ')).toMatch(/default background/);
    expect(read.warnings.join(' ')).toMatch(/does not contain it/);
  });
});
