import {
  MAX_BACKGROUND_IMAGES,
  sanitizeBackgroundConfig,
  type BackgroundConfig,
} from '../core/background/config';
import { MAX_CUSTOM_SPRITES, MAX_SPRITE_BYTES } from '../core/background/emitter';
import { parseChart } from '../core/parseChart';
import type { LibraryDb } from './db';
import {
  type AnalysisRecord,
  type BackgroundImageRecord,
  type ChartAnalysisRecord,
  type ParticleSpriteRecord,
  compareCharts,
  toChartFile,
  validateChartMeta,
  validateSongMeta,
  type ChartPatch,
  type ChartRecord,
  type NewChart,
  type NewScore,
  type NewSong,
  type PlayerAssetRecord,
  type ScoreRecord,
  type SongPatch,
  type SongRecord,
  validateScore,
} from './records';

/** A library operation was refused. `errors` lists every problem as a complete sentence. */
export class LibraryError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(' '));
    this.name = 'LibraryError';
  }
}

export interface RepositoryOptions {
  /** Epoch ms for createdAt/updatedAt. */
  now?: () => number;
  newId?: () => string;
}

function validateCoverPair(cover: unknown, thumb: unknown): string[] {
  const empty = (v: unknown): boolean => v === undefined || v === null;
  if (empty(cover) && empty(thumb)) return [];
  if (cover instanceof Blob && thumb instanceof Blob && cover.size > 0 && thumb.size > 0) return [];
  return ['A cover needs both its image and its thumbnail. Upload the picture again.'];
}

const ASSET_ID = /^[\w-]{1,64}$/;

function validateBackground(config: unknown, images: unknown, sprites: unknown): string[] {
  const errors: string[] = [];
  if (config !== undefined && config !== null && sanitizeBackgroundConfig(config) === null) {
    errors.push('The background settings are not valid. Choose the background again.');
  }
  if (images !== undefined) {
    const list = Array.isArray(images) ? (images as unknown[]) : null;
    if (!list || list.length > MAX_BACKGROUND_IMAGES) {
      errors.push(
        `A song can have at most ${MAX_BACKGROUND_IMAGES} background pictures. Remove some first.`,
      );
    } else if (
      !list.every(
        (i: unknown) =>
          typeof i === 'object' &&
          i !== null &&
          ASSET_ID.test(String((i as BackgroundImageRecord).id)) &&
          (i as BackgroundImageRecord).blob instanceof Blob &&
          (i as BackgroundImageRecord).blob.size > 0,
      )
    ) {
      errors.push('A background picture is empty or unreadable. Upload it again.');
    }
  }
  if (sprites !== undefined) {
    const list = Array.isArray(sprites) ? (sprites as unknown[]) : null;
    if (!list || list.length > MAX_CUSTOM_SPRITES) {
      errors.push(
        `A song can have at most ${MAX_CUSTOM_SPRITES} custom sprites. Remove some first.`,
      );
    } else if (
      !list.every(
        (i: unknown) =>
          typeof i === 'object' &&
          i !== null &&
          ASSET_ID.test(String((i as ParticleSpriteRecord).id)) &&
          typeof (i as ParticleSpriteRecord).name === 'string' &&
          (i as ParticleSpriteRecord).blob instanceof Blob &&
          (i as ParticleSpriteRecord).blob.size > 0 &&
          (i as ParticleSpriteRecord).blob.size <= MAX_SPRITE_BYTES,
      )
    ) {
      errors.push(
        `A custom sprite is empty, unreadable or larger than ${MAX_SPRITE_BYTES / 1024} KB. Add it again.`,
      );
    }
  }
  return errors;
}

function validateNewSong(song: NewSong): string[] {
  const errors = validateSongMeta(song);
  errors.push(...validateCoverPair(song.cover, song.coverThumb));
  errors.push(...validateBackground(song.background, song.backgroundImages, song.particleSprites));
  if (!(song.audio instanceof Blob)) errors.push('The song has no audio data.');
  if (typeof song.audioFileName !== 'string') errors.push('The audio file name must be text.');
  if (!Number.isFinite(song.durationMs) || song.durationMs <= 0) {
    errors.push(`The song length must be greater than 0 ms, got ${String(song.durationMs)}.`);
  }
  return errors;
}

/** Validate a chart's metadata and notes against the song it belongs to. */
function validateChart(song: SongRecord, chart: Omit<NewChart, 'songId'>): string[] {
  const errors = validateChartMeta(chart);
  if (errors.length > 0) return errors;
  const parsed = parseChart(toChartFile(song, chart));
  return parsed.ok ? [] : parsed.errors;
}

/**
 * Typed async access to the song library (IndexedDB). Every write validates first and either
 * fully succeeds or changes nothing. Songs come back sorted by title, charts by difficulty.
 */
export class LibraryRepository {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly db: LibraryDb,
    options: RepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  close(): void {
    this.db.close();
  }

  // --- Songs ---------------------------------------------------------------------------------

  async listSongs(): Promise<SongRecord[]> {
    const songs = await this.db.getAll('songs');
    return songs.sort(
      (a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
        a.createdAt - b.createdAt,
    );
  }

  getSong(id: string): Promise<SongRecord | undefined> {
    return this.db.get('songs', id);
  }

  async createSong(input: NewSong): Promise<SongRecord> {
    return (await this.createSongWithCharts(input, [])).song;
  }

  /**
   * Create a song and its charts in one transaction (used by package import): if anything is
   * invalid, nothing is written.
   */
  async createSongWithCharts(
    input: NewSong,
    charts: readonly Omit<NewChart, 'songId'>[],
  ): Promise<{ song: SongRecord; charts: ChartRecord[] }> {
    const errors = validateNewSong(input);
    const now = this.now();
    const song: SongRecord = {
      ...input,
      cover: input.cover ?? null,
      coverThumb: input.coverThumb ?? null,
      background: input.background ? sanitizeBackgroundConfig(input.background) : null,
      backgroundImages: input.backgroundImages ?? [],
      particleSprites: input.particleSprites ?? [],
      id: this.newId(),
      createdAt: now,
      updatedAt: now,
    };
    if (errors.length === 0) {
      charts.forEach((c, i) => {
        for (const e of validateChart(song, c))
          errors.push(`Chart ${i + 1} (${c.difficulty}): ${e}`);
      });
    }
    if (errors.length > 0) throw new LibraryError(errors);

    const records: ChartRecord[] = charts.map((c) => ({
      ...c,
      notes: [...c.notes],
      songId: song.id,
      id: this.newId(),
      createdAt: now,
      updatedAt: now,
    }));
    const tx = this.db.transaction(['songs', 'charts'], 'readwrite');
    await Promise.all([
      tx.objectStore('songs').add(song),
      ...records.map((r) => tx.objectStore('charts').add(r)),
      tx.done,
    ]);
    return { song, charts: records };
  }

  async updateSong(id: string, patch: SongPatch): Promise<SongRecord> {
    const tx = this.db.transaction('songs', 'readwrite');
    const store = tx.objectStore('songs');
    const current = await store.get(id);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new LibraryError([
        'This song no longer exists. It may have been deleted in another tab.',
      ]);
    }
    const next: SongRecord = { ...current, ...definedOnly(patch), id, updatedAt: this.now() };
    const errors = validateSongMeta(next);
    if (errors.length > 0) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new LibraryError(errors);
    }
    await Promise.all([store.put(next), tx.done]);
    return next;
  }

  /** Set (or with null, remove) a song's custom cover. */
  async setCover(
    id: string,
    images: { cover: Blob; coverThumb: Blob } | null,
  ): Promise<SongRecord> {
    const errors = images ? validateCoverPair(images.cover, images.coverThumb) : [];
    if (errors.length > 0) throw new LibraryError(errors);
    const tx = this.db.transaction('songs', 'readwrite');
    const store = tx.objectStore('songs');
    const current = await store.get(id);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new LibraryError([
        'This song no longer exists. It may have been deleted in another tab.',
      ]);
    }
    const next: SongRecord = {
      ...current,
      cover: images?.cover ?? null,
      coverThumb: images?.coverThumb ?? null,
      updatedAt: this.now(),
    };
    await Promise.all([store.put(next), tx.done]);
    return next;
  }

  /**
   * Set (or with null, clear) a song's background. `assets.images` and `assets.sprites` replace
   * the background pictures and custom sprites; left out, the stored ones are kept.
   */
  async setBackground(
    id: string,
    config: BackgroundConfig | null,
    assets: { images?: BackgroundImageRecord[]; sprites?: ParticleSpriteRecord[] } = {},
  ): Promise<SongRecord> {
    const errors = validateBackground(config, assets.images, assets.sprites);
    if (errors.length > 0) throw new LibraryError(errors);
    const tx = this.db.transaction('songs', 'readwrite');
    const store = tx.objectStore('songs');
    const current = await store.get(id);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new LibraryError([
        'This song no longer exists. It may have been deleted in another tab.',
      ]);
    }
    const next: SongRecord = {
      ...current,
      background: config ? sanitizeBackgroundConfig(config) : null,
      backgroundImages: assets.images ?? current.backgroundImages ?? [],
      particleSprites: assets.sprites ?? current.particleSprites ?? [],
      updatedAt: this.now(),
    };
    await Promise.all([store.put(next), tx.done]);
    return next;
  }

  /** Delete a song with all of its charts, their best scores and its cached analyses. */
  async deleteSong(id: string): Promise<void> {
    const tx = this.db.transaction(
      ['songs', 'charts', 'scores', 'analyses', 'chartAnalyses'],
      'readwrite',
    );
    const charts = tx.objectStore('charts');
    const scores = tx.objectStore('scores');
    const [chartKeys, scoreKeys] = await Promise.all([
      charts.index('bySong').getAllKeys(id),
      scores.index('bySong').getAllKeys(id),
    ]);
    await Promise.all([
      tx.objectStore('songs').delete(id),
      ...chartKeys.map((k) => charts.delete(k)),
      ...scoreKeys.map((k) => scores.delete(k)),
      tx.objectStore('analyses').delete(id),
      tx.objectStore('chartAnalyses').delete(id),
      tx.done,
    ]);
  }

  // --- Charts --------------------------------------------------------------------------------

  /** Charts of one song, or of every song when `songId` is omitted. */
  async listCharts(songId?: string): Promise<ChartRecord[]> {
    const charts =
      songId === undefined
        ? await this.db.getAll('charts')
        : await this.db.getAllFromIndex('charts', 'bySong', songId);
    return charts.sort((a, b) => compareCharts(a, b) || a.createdAt - b.createdAt);
  }

  getChart(id: string): Promise<ChartRecord | undefined> {
    return this.db.get('charts', id);
  }

  async createChart(input: NewChart): Promise<ChartRecord> {
    const tx = this.db.transaction(['songs', 'charts'], 'readwrite');
    const song = await tx.objectStore('songs').get(input.songId);
    const errors = song
      ? validateChart(song, input)
      : ['The song for this chart does not exist. It may have been deleted.'];
    if (errors.length > 0) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new LibraryError(errors);
    }
    const now = this.now();
    const record: ChartRecord = {
      ...input,
      notes: [...input.notes],
      id: this.newId(),
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([tx.objectStore('charts').add(record), tx.done]);
    return record;
  }

  async updateChart(id: string, patch: ChartPatch): Promise<ChartRecord> {
    const tx = this.db.transaction(['songs', 'charts'], 'readwrite');
    const store = tx.objectStore('charts');
    const current = await store.get(id);
    const song = current ? await tx.objectStore('songs').get(current.songId) : undefined;
    let errors: string[];
    let next: ChartRecord | null = null;
    if (!current || !song) {
      errors = ['This chart no longer exists. It may have been deleted in another tab.'];
    } else {
      next = { ...current, ...definedOnly(patch), id, updatedAt: this.now() };
      errors = validateChart(song, next);
    }
    if (errors.length > 0 || !next) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new LibraryError(errors);
    }
    await Promise.all([store.put(next), tx.done]);
    return next;
  }

  /** Delete one chart and its best score. Deleting a missing chart does nothing. */
  async deleteChart(id: string): Promise<void> {
    const tx = this.db.transaction(['charts', 'scores'], 'readwrite');
    await Promise.all([
      tx.objectStore('charts').delete(id),
      tx.objectStore('scores').delete(id),
      tx.done,
    ]);
  }

  // --- Scores --------------------------------------------------------------------------------

  getBestScore(chartId: string): Promise<ScoreRecord | undefined> {
    return this.db.get('scores', chartId);
  }

  listBestScores(): Promise<ScoreRecord[]> {
    return this.db.getAll('scores');
  }

  /**
   * Record a finished play. It becomes the chart's best if it scores strictly higher than the
   * stored best (or there is none). Returns the best after the update and the one before.
   */
  async recordScore(
    input: NewScore,
  ): Promise<{ best: ScoreRecord; previous: ScoreRecord | null; isNewBest: boolean }> {
    const errors = validateScore(input);
    if (errors.length > 0) throw new LibraryError(errors);
    const tx = this.db.transaction('scores', 'readwrite');
    const store = tx.objectStore('scores');
    const previous = (await store.get(input.chartId)) ?? null;
    if (previous && previous.score >= input.score) {
      await tx.done;
      return { best: previous, previous, isNewBest: false };
    }
    const best: ScoreRecord = { ...input, achievedAt: this.now() };
    await Promise.all([store.put(best), tx.done]);
    return { best, previous, isNewBest: true };
  }

  // --- Player assets --------------------------------------------------------------------------

  getPlayerAsset(id: string): Promise<PlayerAssetRecord | undefined> {
    return this.db.get('playerAssets', id);
  }

  /** Store (or with null, delete) one of the player's pictures. */
  async setPlayerAsset(id: string, blob: Blob | null): Promise<void> {
    if (blob === null) {
      await this.db.delete('playerAssets', id);
      return;
    }
    if (!(blob instanceof Blob) || blob.size === 0) {
      throw new LibraryError(['The picture is empty or unreadable. Choose it again.']);
    }
    await this.db.put('playerAssets', { id, blob, updatedAt: this.now() });
  }

  // --- Analysis cache ------------------------------------------------------------------------

  /** The cached audio analysis of a song, if any (the caller checks it is still valid). */
  getAnalysis(songId: string): Promise<AnalysisRecord | undefined> {
    return this.db.get('analyses', songId);
  }

  /** Cache a song's audio analysis (replacing an older one). Ignored for unknown songs. */
  async putAnalysis(record: Omit<AnalysisRecord, 'createdAt'>): Promise<void> {
    const tx = this.db.transaction(['songs', 'analyses'], 'readwrite');
    const song = await tx.objectStore('songs').get(record.songId);
    if (song) await tx.objectStore('analyses').put({ ...record, createdAt: this.now() });
    await tx.done;
  }

  /** The cached chart-analysis features of a song, if any (the caller checks them). */
  getChartAnalysis(songId: string): Promise<ChartAnalysisRecord | undefined> {
    return this.db.get('chartAnalyses', songId);
  }

  /** Cache a song's chart-analysis features (replacing older ones). Ignored for unknown songs. */
  async putChartAnalysis(record: Omit<ChartAnalysisRecord, 'createdAt'>): Promise<void> {
    const tx = this.db.transaction(['songs', 'chartAnalyses'], 'readwrite');
    const song = await tx.objectStore('songs').get(record.songId);
    if (song) await tx.objectStore('chartAnalyses').put({ ...record, createdAt: this.now() });
    await tx.done;
  }
}

/** Drop `undefined` values so a patch can't erase fields. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}
