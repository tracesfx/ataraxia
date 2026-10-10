import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '../core/chart';
import { LIBRARY_DB_VERSION, openLibraryDb } from './db';
import { ANALYSIS_VERSION, analyzeAudio } from '../core/analysis';
import { clickTrack } from '../core/syntheticSignals';
import { defaultBackgroundConfig } from '../core/background/config';
import { analysisCacheValid, type NewScore, type NewSong } from './records';
import { LibraryError, LibraryRepository } from './repository';

let dbCounter = 0;
let repo: LibraryRepository;
let clock = 1000;
let ids = 0;

function newSong(overrides: Partial<NewSong> = {}): NewSong {
  return {
    title: 'Song',
    artist: 'Artist',
    audio: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/ogg' }),
    audioFileName: 'song.ogg',
    durationMs: 90000,
    bpm: 120,
    offsetMs: 0,
    previewStartMs: 27000,
    ...overrides,
  };
}

const notes: Note[] = [
  { t: 1000, lane: 0, type: 'tap' },
  { t: 1500, lane: 1, type: 'hold', dur: 300 },
];

beforeEach(async () => {
  clock = 1000;
  ids = 0;
  const db = await openLibraryDb(`test-library-${++dbCounter}`);
  repo = new LibraryRepository(db, { now: () => clock++, newId: () => `id-${++ids}` });
});

afterEach(() => repo.close());

async function rejection(p: Promise<unknown>): Promise<LibraryError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LibraryError) return err;
    throw err;
  }
  throw new Error('Expected the operation to be refused.');
}

describe('schema', () => {
  it('opens at the current version with every store', async () => {
    const db = await openLibraryDb(`test-library-schema-${dbCounter}`);
    expect(db.version).toBe(LIBRARY_DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
      'analyses',
      'chartAnalyses',
      'charts',
      'playerAssets',
      'scores',
      'songs',
    ]);
    db.close();
  });
});

describe('songs', () => {
  it('creates, gets and lists songs (sorted by title, case-insensitive)', async () => {
    const b = await repo.createSong(newSong({ title: 'beta' }));
    const a = await repo.createSong(newSong({ title: 'Alpha' }));
    expect(b).toMatchObject({ id: 'id-1', title: 'beta', createdAt: 1000, updatedAt: 1000 });
    expect((await repo.listSongs()).map((s) => s.title)).toEqual(['Alpha', 'beta']);
    const got = await repo.getSong(a.id);
    expect(got?.title).toBe('Alpha');
    expect(got?.audioFileName).toBe('song.ogg');
  });

  it('stores the audio blob intact', async () => {
    const song = await repo.createSong(newSong());
    const got = await repo.getSong(song.id);
    expect(got?.audio).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (got as { audio: Blob }).audio.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it('returns undefined for a missing song', async () => {
    expect(await repo.getSong('nope')).toBeUndefined();
  });

  it('refuses invalid songs and writes nothing', async () => {
    const err = await rejection(
      repo.createSong(newSong({ title: '  ', bpm: 0, durationMs: 0, previewStartMs: -1 })),
    );
    expect(err.errors).toHaveLength(4);
    expect(err.errors[0]).toMatch(/title must not be empty/);
    expect(await repo.listSongs()).toEqual([]);
  });

  it('updates editable fields, bumping updatedAt only', async () => {
    const song = await repo.createSong(newSong());
    const updated = await repo.updateSong(song.id, { title: 'Renamed', bpm: 150.5 });
    expect(updated).toMatchObject({
      title: 'Renamed',
      bpm: 150.5,
      createdAt: 1000,
      updatedAt: 1001,
    });
    expect((await repo.getSong(song.id))?.title).toBe('Renamed');
  });

  it('ignores undefined patch values', async () => {
    const song = await repo.createSong(newSong());
    const updated = await repo.updateSong(song.id, { title: undefined, artist: 'New' } as never);
    expect(updated.title).toBe('Song');
  });

  it('refuses invalid updates and keeps the old record', async () => {
    const song = await repo.createSong(newSong());
    const err = await rejection(repo.updateSong(song.id, { bpm: -5 }));
    expect(err.errors[0]).toMatch(/BPM/);
    expect((await repo.getSong(song.id))?.bpm).toBe(120);
  });

  it('refuses to update a missing song', async () => {
    const err = await rejection(repo.updateSong('missing', { title: 'x' }));
    expect(err.message).toMatch(/no longer exists/);
  });

  it("deleting a song deletes its charts but not other songs' charts", async () => {
    const a = await repo.createSong(newSong({ title: 'A' }));
    const b = await repo.createSong(newSong({ title: 'B' }));
    await repo.createChart({ songId: a.id, difficulty: 'Easy', level: 1, charter: '', notes });
    await repo.createChart({ songId: a.id, difficulty: 'Hard', level: 9, charter: '', notes: [] });
    const keep = await repo.createChart({
      songId: b.id,
      difficulty: 'Normal',
      level: 3,
      charter: '',
      notes: [],
    });
    await repo.deleteSong(a.id);
    expect(await repo.getSong(a.id)).toBeUndefined();
    expect(await repo.listCharts(a.id)).toEqual([]);
    expect((await repo.listCharts()).map((c) => c.id)).toEqual([keep.id]);
  });

  it('deleting a missing song does nothing', async () => {
    await expect(repo.deleteSong('missing')).resolves.toBeUndefined();
  });
});

describe('charts', () => {
  it('creates, gets, lists by song and sorts by difficulty then level', async () => {
    const song = await repo.createSong(newSong());
    await repo.createChart({ songId: song.id, difficulty: 'Hard', level: 8, charter: 'Me', notes });
    await repo.createChart({ songId: song.id, difficulty: 'Easy', level: 2, charter: 'Me', notes });
    await repo.createChart({ songId: song.id, difficulty: 'Wild', level: 1, charter: '', notes });
    const normal = await repo.createChart({
      songId: song.id,
      difficulty: 'Normal',
      level: 5,
      charter: 'Me',
      notes,
    });
    expect((await repo.listCharts(song.id)).map((c) => c.difficulty)).toEqual([
      'Easy',
      'Normal',
      'Hard',
      'Wild',
    ]);
    const got = await repo.getChart(normal.id);
    expect(got?.notes).toEqual(notes);
    expect(got?.songId).toBe(song.id);
  });

  it('refuses a chart for a missing song', async () => {
    const err = await rejection(
      repo.createChart({ songId: 'nope', difficulty: 'Normal', level: 1, charter: '', notes: [] }),
    );
    expect(err.message).toMatch(/song for this chart does not exist/);
    expect(await repo.listCharts()).toEqual([]);
  });

  it('refuses invalid chart metadata and overlapping notes', async () => {
    const song = await repo.createSong(newSong());
    const meta = await rejection(
      repo.createChart({ songId: song.id, difficulty: '', level: 21, charter: '', notes: [] }),
    );
    expect(meta.errors).toHaveLength(2);
    const overlap = await rejection(
      repo.createChart({
        songId: song.id,
        difficulty: 'Normal',
        level: 1,
        charter: '',
        notes: [
          { t: 1000, lane: 0, type: 'hold', dur: 500 },
          { t: 1200, lane: 0, type: 'tap' },
        ],
      }),
    );
    expect(overlap.errors[0]).toMatch(/Overlapping notes in lane 0/);
    expect(await repo.listCharts()).toEqual([]);
  });

  it('updates and deletes charts', async () => {
    const song = await repo.createSong(newSong());
    const chart = await repo.createChart({
      songId: song.id,
      difficulty: 'Normal',
      level: 1,
      charter: '',
      notes: [],
    });
    const updated = await repo.updateChart(chart.id, { level: 7, notes });
    expect(updated).toMatchObject({ level: 7, notes, songId: song.id });
    await rejection(repo.updateChart(chart.id, { level: 0 }));
    expect((await repo.getChart(chart.id))?.level).toBe(7);
    await repo.deleteChart(chart.id);
    expect(await repo.getChart(chart.id)).toBeUndefined();
    expect(await repo.getSong(song.id)).toBeDefined();
  });
});

describe('createSongWithCharts', () => {
  it('creates the song and all charts together', async () => {
    const { song, charts } = await repo.createSongWithCharts(newSong(), [
      { difficulty: 'Easy', level: 1, charter: '', notes },
      { difficulty: 'Hard', level: 9, charter: '', notes: [] },
    ]);
    expect(charts.every((c) => c.songId === song.id)).toBe(true);
    expect(await repo.listCharts(song.id)).toHaveLength(2);
  });

  it('writes nothing when any chart is invalid', async () => {
    const err = await rejection(
      repo.createSongWithCharts(newSong(), [
        { difficulty: 'Easy', level: 1, charter: '', notes },
        { difficulty: 'Hard', level: 99, charter: '', notes: [] },
      ]),
    );
    expect(err.errors[0]).toMatch(/^Chart 2 \(Hard\): The level/);
    expect(await repo.listSongs()).toEqual([]);
    expect(await repo.listCharts()).toEqual([]);
  });
});

describe('persistence', () => {
  it('data survives closing and reopening the database', async () => {
    const name = `test-library-reopen-${dbCounter}`;
    const first = new LibraryRepository(await openLibraryDb(name));
    const song = await first.createSong(newSong({ title: 'Kept' }));
    await first.createChart({
      songId: song.id,
      difficulty: 'Normal',
      level: 1,
      charter: '',
      notes,
    });
    first.close();
    const second = new LibraryRepository(await openLibraryDb(name));
    expect((await second.listSongs()).map((s) => s.title)).toEqual(['Kept']);
    expect(await second.listCharts(song.id)).toHaveLength(1);
    second.close();
  });
});

function newScore(overrides: Partial<NewScore> = {}): NewScore {
  return {
    chartId: 'chart-1',
    songId: 'song-1',
    score: 900_000,
    accuracy: 92.5,
    rank: 'A',
    maxCombo: 120,
    fullCombo: false,
    allPerfect: false,
    ...overrides,
  };
}

describe('scores', () => {
  it('the first play of a chart is a new best', async () => {
    const r = await repo.recordScore(newScore());
    expect(r.isNewBest).toBe(true);
    expect(r.previous).toBeNull();
    expect(r.best).toMatchObject({ chartId: 'chart-1', score: 900_000, achievedAt: 1000 });
    expect(await repo.getBestScore('chart-1')).toEqual(r.best);
  });

  it('keeps the best: a lower or equal score does not replace it', async () => {
    await repo.recordScore(newScore({ score: 900_000 }));
    const lower = await repo.recordScore(newScore({ score: 850_000, rank: 'B' }));
    expect(lower.isNewBest).toBe(false);
    expect(lower.best.score).toBe(900_000);
    const equal = await repo.recordScore(newScore({ score: 900_000 }));
    expect(equal.isNewBest).toBe(false);
    const higher = await repo.recordScore(newScore({ score: 990_000, rank: 'S' }));
    expect(higher.isNewBest).toBe(true);
    expect(higher.previous?.score).toBe(900_000);
    expect((await repo.getBestScore('chart-1'))?.rank).toBe('S');
  });

  it('keeps one best per chart and lists them', async () => {
    await repo.recordScore(newScore({ chartId: 'a' }));
    await repo.recordScore(newScore({ chartId: 'b', score: 10 }));
    const all = await repo.listBestScores();
    expect(all.map((s) => s.chartId).sort()).toEqual(['a', 'b']);
  });

  it('refuses invalid scores', async () => {
    const err = await rejection(repo.recordScore(newScore({ score: 1_000_001, rank: 'Z' as 'S' })));
    expect(err.errors).toHaveLength(2);
    expect(await repo.listBestScores()).toEqual([]);
  });

  it('deleting a chart or a song deletes its best scores', async () => {
    const song = await repo.createSong(newSong());
    const c1 = await repo.createChart({
      songId: song.id,
      difficulty: 'Easy',
      level: 1,
      charter: '',
      notes,
    });
    const c2 = await repo.createChart({
      songId: song.id,
      difficulty: 'Hard',
      level: 9,
      charter: '',
      notes,
    });
    await repo.recordScore(newScore({ chartId: c1.id, songId: song.id }));
    await repo.recordScore(newScore({ chartId: c2.id, songId: song.id }));
    await repo.recordScore(newScore({ chartId: 'other', songId: 'other-song' }));
    await repo.deleteChart(c1.id);
    expect(await repo.getBestScore(c1.id)).toBeUndefined();
    expect(await repo.getBestScore(c2.id)).toBeDefined();
    await repo.deleteSong(song.id);
    expect((await repo.listBestScores()).map((s) => s.chartId)).toEqual(['other']);
  });
});

describe('upgrade from version 1', () => {
  it('adds the scores store and keeps existing songs and charts', async () => {
    const name = `test-library-upgrade-${dbCounter}`;
    // A database exactly as version 1 created it.
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('songs', { keyPath: 'id' });
        db.createObjectStore('charts', { keyPath: 'id' }).createIndex('bySong', 'songId');
      },
    });
    const now = 5;
    await v1.put('songs', {
      ...newSong({ title: 'Old song' }),
      id: 's1',
      createdAt: now,
      updatedAt: now,
    });
    await v1.put('charts', {
      id: 'c1',
      songId: 's1',
      difficulty: 'Normal',
      level: 3,
      charter: '',
      notes,
      createdAt: now,
      updatedAt: now,
    });
    v1.close();

    const db = await openLibraryDb(name);
    expect(db.version).toBe(LIBRARY_DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
      'analyses',
      'chartAnalyses',
      'charts',
      'playerAssets',
      'scores',
      'songs',
    ]);
    const upgraded = new LibraryRepository(db);
    expect((await upgraded.listSongs()).map((s) => s.title)).toEqual(['Old song']);
    expect((await upgraded.listCharts('s1')).map((c) => c.id)).toEqual(['c1']);
    expect(await upgraded.listBestScores()).toEqual([]);
    await upgraded.recordScore(newScore({ chartId: 'c1', songId: 's1' }));
    expect((await upgraded.getBestScore('c1'))?.score).toBe(900_000);
    upgraded.close();
  });
});

describe('upgrade from version 2', () => {
  it('keeps songs, charts and scores, and gives songs empty covers', async () => {
    const name = `test-library-upgrade-v2-${dbCounter}`;
    // A database exactly as version 2 created it, with data in every store.
    const v2 = await openDB(name, 2, {
      upgrade(db) {
        db.createObjectStore('songs', { keyPath: 'id' });
        db.createObjectStore('charts', { keyPath: 'id' }).createIndex('bySong', 'songId');
        db.createObjectStore('scores', { keyPath: 'chartId' }).createIndex('bySong', 'songId');
      },
    });
    for (const [id, title] of [
      ['s1', 'First'],
      ['s2', 'Second'],
    ] as const) {
      await v2.put('songs', { ...newSong({ title }), id, createdAt: 7, updatedAt: 7 });
    }
    await v2.put('charts', {
      id: 'c1',
      songId: 's1',
      difficulty: 'Hard',
      level: 9,
      charter: 'Me',
      notes,
      startMs: -2000,
      createdAt: 7,
      updatedAt: 7,
    });
    await v2.put('scores', { ...newScore({ chartId: 'c1', songId: 's1' }), achievedAt: 8 });
    v2.close();

    const db = await openLibraryDb(name);
    expect(db.version).toBe(LIBRARY_DB_VERSION);
    const upgraded = new LibraryRepository(db);
    const songs = await upgraded.listSongs();
    expect(songs.map((s) => s.title)).toEqual(['First', 'Second']);
    for (const song of songs) {
      expect(song.cover).toBeNull();
      expect(song.coverThumb).toBeNull();
      expect(song.updatedAt).toBe(7);
      expect(song.audio).toBeInstanceOf(Blob);
      expect(new Uint8Array(await song.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    }
    const chart = await upgraded.getChart('c1');
    expect(chart).toMatchObject({ difficulty: 'Hard', level: 9, startMs: -2000, notes });
    expect((await upgraded.getBestScore('c1'))?.score).toBe(900_000);

    // Covers can be set on a migrated song.
    const withCover = await upgraded.setCover('s1', {
      cover: new Blob([new Uint8Array([1])], { type: 'image/webp' }),
      coverThumb: new Blob([new Uint8Array([2])], { type: 'image/webp' }),
    });
    expect(withCover.cover?.size).toBe(1);
    upgraded.close();
  });
});

describe('covers', () => {
  const images = (): { cover: Blob; coverThumb: Blob } => ({
    cover: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }),
    coverThumb: new Blob([new Uint8Array([4])], { type: 'image/webp' }),
  });

  it('new songs have no cover unless given one', async () => {
    const plain = await repo.createSong(newSong());
    expect(plain.cover).toBeNull();
    expect(plain.coverThumb).toBeNull();
    const covered = await repo.createSong(newSong(images()));
    const got = await repo.getSong(covered.id);
    expect(new Uint8Array(await (got?.cover as Blob).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('sets and removes a cover, bumping updatedAt', async () => {
    const song = await repo.createSong(newSong());
    const set = await repo.setCover(song.id, images());
    expect(set.updatedAt).toBeGreaterThan(song.updatedAt);
    expect((await repo.getSong(song.id))?.coverThumb?.size).toBe(1);
    await repo.setCover(song.id, null);
    expect((await repo.getSong(song.id))?.cover).toBeNull();
  });

  it('refuses half a cover and missing songs', async () => {
    const half = await rejection(
      repo.createSong(newSong({ cover: images().cover, coverThumb: null })),
    );
    expect(half.errors[0]).toMatch(/both its image and its thumbnail/);
    const missing = await rejection(repo.setCover('nope', images()));
    expect(missing.errors[0]).toMatch(/no longer exists/);
  });
});

describe('analysis cache', () => {
  const analysis = analyzeAudio(
    clickTrack({ bpm: 120, offsetMs: 100, durationMs: 4000, sampleRate: 22050 }),
    22050,
  );

  it('stores and reads back a song analysis with its typed arrays', async () => {
    const song = await repo.createSong(newSong());
    expect(await repo.getAnalysis(song.id)).toBeUndefined();
    await repo.putAnalysis({
      songId: song.id,
      analysisVersion: ANALYSIS_VERSION,
      audioSize: song.audio.size,
      durationMs: song.durationMs,
      analysis,
    });
    const got = await repo.getAnalysis(song.id);
    expect(got?.analysis.intensity).toBeInstanceOf(Float32Array);
    expect(got?.analysis.intensity).toEqual(analysis.intensity);
    expect(got?.analysis.onsets).toEqual(analysis.onsets);
    expect(got?.analysis.tempo).toEqual(analysis.tempo);
    expect(got && analysisCacheValid(got, song)).toBe(true);
  });

  it('ignores analyses for unknown songs and deletes them with the song', async () => {
    await repo.putAnalysis({
      songId: 'missing',
      analysisVersion: ANALYSIS_VERSION,
      audioSize: 1,
      durationMs: 1,
      analysis,
    });
    expect(await repo.getAnalysis('missing')).toBeUndefined();
    const song = await repo.createSong(newSong());
    await repo.putAnalysis({
      songId: song.id,
      analysisVersion: ANALYSIS_VERSION,
      audioSize: song.audio.size,
      durationMs: song.durationMs,
      analysis,
    });
    await repo.deleteSong(song.id);
    expect(await repo.getAnalysis(song.id)).toBeUndefined();
  });

  it('treats a cache from another analysis version or other audio as stale', () => {
    const song = { audio: new Blob([new Uint8Array(4)]), durationMs: 90000 };
    const record = { analysisVersion: ANALYSIS_VERSION, audioSize: 4, durationMs: 90000 };
    expect(analysisCacheValid(record, song)).toBe(true);
    expect(analysisCacheValid({ ...record, analysisVersion: ANALYSIS_VERSION + 1 }, song)).toBe(
      false,
    );
    expect(analysisCacheValid({ ...record, audioSize: 5 }, song)).toBe(false);
    expect(analysisCacheValid({ ...record, durationMs: 1 }, song)).toBe(false);
  });
});

describe('upgrade from version 4', () => {
  it('keeps everything and gives songs empty backgrounds', async () => {
    const name = `test-library-upgrade-v4-${dbCounter}`;
    const v4 = await openDB(name, 4, {
      upgrade(db) {
        db.createObjectStore('songs', { keyPath: 'id' });
        db.createObjectStore('charts', { keyPath: 'id' }).createIndex('bySong', 'songId');
        db.createObjectStore('scores', { keyPath: 'chartId' }).createIndex('bySong', 'songId');
        db.createObjectStore('analyses', { keyPath: 'songId' });
      },
    });
    const cover = new Blob([new Uint8Array([9])], { type: 'image/webp' });
    await v4.put('songs', {
      ...newSong({ title: 'Kept', cover, coverThumb: cover }),
      id: 's1',
      createdAt: 7,
      updatedAt: 7,
    });
    await v4.put('analyses', {
      songId: 's1',
      analysisVersion: 1,
      audioSize: 4,
      durationMs: 1,
      createdAt: 1,
      analysis: { x: 1 },
    });
    v4.close();

    const db = await openLibraryDb(name);
    expect(db.version).toBe(LIBRARY_DB_VERSION);
    expect([...db.objectStoreNames]).toContain('playerAssets');
    const upgraded = new LibraryRepository(db);
    const song = await upgraded.getSong('s1');
    expect(song?.background).toBeNull();
    expect(song?.backgroundImages).toEqual([]);
    expect(song?.cover?.size).toBe(1);
    expect(song?.updatedAt).toBe(7);
    expect(await upgraded.getAnalysis('s1')).toBeDefined();
    upgraded.close();
  });
});

describe('backgrounds', () => {
  const picture = (): Blob => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });

  it('new songs have the default background unless given one', async () => {
    const plain = await repo.createSong(newSong());
    expect(plain.background).toBeNull();
    expect(plain.backgroundImages).toEqual([]);
    const own = await repo.createSong(
      newSong({
        background: defaultBackgroundConfig('none'),
        backgroundImages: [{ id: 'a', blob: picture() }],
      }),
    );
    expect((await repo.getSong(own.id))?.background?.base.kind).toBe('none');
  });

  it('sets, keeps and removes a background and its picture', async () => {
    const song = await repo.createSong(newSong());
    const set = await repo.setBackground(song.id, defaultBackgroundConfig('image'), {
      images: [{ id: 'a', blob: picture() }],
    });
    expect(set.backgroundImages?.[0]?.blob.size).toBe(3);
    expect(set.updatedAt).toBeGreaterThan(song.updatedAt);
    // Undefined keeps the picture.
    const tuned = defaultBackgroundConfig('image');
    tuned.base.dim = 0.2;
    await repo.setBackground(song.id, tuned);
    const got = await repo.getSong(song.id);
    expect(got?.backgroundImages?.[0]?.blob.size).toBe(3);
    expect(got?.background?.base.dim).toBe(0.2);
    await repo.setBackground(song.id, null, { images: [] });
    const cleared = await repo.getSong(song.id);
    expect(cleared?.background).toBeNull();
    expect(cleared?.backgroundImages).toEqual([]);
  });

  it('refuses invalid backgrounds and missing songs', async () => {
    const song = await repo.createSong(newSong());
    const bad = await rejection(
      repo.setBackground(song.id, { version: 2, base: 'lasers' } as never),
    );
    expect(bad.errors[0]).toMatch(/background settings are not valid/);
    const empty = await rejection(
      repo.setBackground(song.id, null, { images: [{ id: 'a', blob: new Blob([]) }] }),
    );
    expect(empty.errors[0]).toMatch(/empty/);
    const missing = await rejection(repo.setBackground('nope', null));
    expect(missing.errors[0]).toMatch(/no longer exists/);
  });

  it("stores and removes the player's own picture", async () => {
    expect(await repo.getPlayerAsset('background')).toBeUndefined();
    await repo.setPlayerAsset('background', picture());
    expect((await repo.getPlayerAsset('background'))?.blob.size).toBe(3);
    await repo.setPlayerAsset('background', null);
    expect(await repo.getPlayerAsset('background')).toBeUndefined();
    const err = await rejection(repo.setPlayerAsset('background', new Blob([])));
    expect(err.errors[0]).toMatch(/empty/);
  });
});
