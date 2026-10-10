import type { AnalysisCache } from '../audio/audioAnalysis';
import type { AudioEngine } from '../audio/audioEngine';
import { ANALYSIS_VERSION, type AudioAnalysis } from '../core/analysis';
import {
  defaultBackgroundConfig,
  sanitizeBackgroundConfig,
  type BackgroundConfig,
} from '../core/background/config';
import { emitterFromTemplate } from '../core/background/emitter';
import type { Chart } from '../core/chart';
import { backgroundFromPackage, processBackgroundImage } from './backgroundImage';
import { DEMO_DURATION_MS, createDemoChart } from '../game/demo/demoChart';
import { getDemoSong } from '../game/demo/demoSong';
import { coverFromPackage, type CoverImages } from './cover';
import { processSpriteFile } from './particleSprite';
import { extensionOf } from './fileNames';
import {
  PLAYER_BACKGROUND_ASSET,
  analysisCacheValid,
  chartFields,
  toChartFile,
  type BackgroundImageRecord,
  type ChartRecord,
  type NewScore,
  type ParticleSpriteRecord,
  type ScoreRecord,
  type SongRecord,
} from './records';
import { LibraryError, type LibraryRepository } from './repository';
import { readSongPackage } from './songPackage';

/** Ids of the built-in demo. They can't collide with stored ids (UUIDs). */
export const DEMO_SONG_ID = 'builtin:demo';
export const DEMO_CHART_ID = 'builtin:demo:normal';

/**
 * A song's custom cover as the menus see it. `key` changes whenever the cover may have changed
 * (song id + last update), so caches of object URLs can be keyed by it.
 */
export interface CoverRef {
  key: string;
  /** 512x512. */
  full: Blob;
  /** 128x128. */
  thumb: Blob;
}

/** A song as the menus see it: stored songs and the built-in demo alike. */
export interface CatalogSong {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  bpm: number;
  offsetMs: number;
  previewStartMs: number;
  audioFileName: string;
  /** The custom cover, or null for the generated placeholder. */
  cover: CoverRef | null;
  /** The song's own background (null: the default), and how many background pictures it has. */
  background: BackgroundConfig | null;
  backgroundImageCount: number;
  /** Built-in songs are read-only: no editing, deleting, or new charts. */
  builtIn: boolean;
}

export interface CatalogChart {
  id: string;
  songId: string;
  difficulty: string;
  level: number;
  charter: string;
  noteCount: number;
  builtIn: boolean;
}

export interface Catalog {
  songs: CatalogSong[];
  charts: CatalogChart[];
}

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
};
/** MIME type for stored audio, from the file name (or the browser's own type when given). */
export function audioMimeType(fileName: string, browserType = ''): string {
  return browserType || AUDIO_TYPES[extensionOf(fileName)] || 'application/octet-stream';
}

/** The demo song's built-in background (it has no picture): drifting dust and beat sparks. */
export const DEMO_BACKGROUND: BackgroundConfig = (() => {
  const c = defaultBackgroundConfig('none');
  const dust = emitterFromTemplate('dust', 'e1', 11);
  dust.count = 70;
  const sparks = emitterFromTemplate('sparks', 'e2', 23);
  sparks.emission = 'downbeat';
  sparks.count = 10;
  c.emitters = [dust, sparks];
  return c;
})();

/** A song's background as the game loads it. */
export interface SongBackground {
  config: BackgroundConfig | null;
  /** The song's background pictures (base 'image' shows the one its config names). */
  images: BackgroundImageRecord[];
  /** Custom particle sprites. */
  sprites: ParticleSpriteRecord[];
  /** The custom cover (512 px), for base 'cover'. */
  cover: Blob | null;
}

/** The picture a config's image base shows: the one it names, else the first. */
export function pictureFor(
  config: BackgroundConfig | null,
  images: readonly BackgroundImageRecord[],
): BackgroundImageRecord | null {
  const id = config?.base.imageId;
  return images.find((i) => i.id === id) ?? images[0] ?? null;
}

/** Decoded songs kept in memory (a 4-minute song is ~90 MB decoded, so keep this small). */
const AUDIO_CACHE_SIZE = 2;

function demoSong(): CatalogSong {
  const demo = createDemoChart();
  return {
    id: DEMO_SONG_ID,
    title: demo.title,
    artist: demo.artist,
    durationMs: DEMO_DURATION_MS,
    bpm: demo.bpm,
    offsetMs: demo.offsetMs,
    previewStartMs: demo.previewStartMs,
    audioFileName: demo.audio,
    cover: null,
    background: DEMO_BACKGROUND,
    backgroundImageCount: 0,
    builtIn: true,
  };
}

export function toCatalogSong(s: SongRecord): CatalogSong {
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    durationMs: s.durationMs,
    bpm: s.bpm,
    offsetMs: s.offsetMs,
    previewStartMs: s.previewStartMs,
    audioFileName: s.audioFileName,
    cover: coverRefOf(s),
    background: sanitizeBackgroundConfig(s.background),
    backgroundImageCount: s.backgroundImages?.length ?? 0,
    builtIn: false,
  };
}

/** The cover reference of a stored song (null without a custom cover). */
export function coverRefOf(s: SongRecord): CoverRef | null {
  if (!(s.cover instanceof Blob) || !(s.coverThumb instanceof Blob)) return null;
  return { key: `${s.id}@${s.updatedAt}`, full: s.cover, thumb: s.coverThumb };
}

export function toCatalogChart(c: ChartRecord): CatalogChart {
  return {
    id: c.id,
    songId: c.songId,
    difficulty: c.difficulty,
    level: c.level,
    charter: c.charter,
    noteCount: c.notes.length,
    builtIn: false,
  };
}

export const READ_ONLY =
  'The demo song is built in and cannot be changed. Import your own audio to make charts.';

/**
 * The song library as the player uses it: stored songs plus the read-only built-in demo, decoding
 * with a small cache, best scores, song package import and song deletion. Creating and editing
 * content (audio import, charts, metadata, exports) lives in the Studio's `StudioLibrary`, which
 * builds on the public building blocks below. All user-facing failures are thrown as
 * LibraryError with complete-sentence messages.
 */
export class SongLibrary {
  private readonly audioCache = new Map<string, Promise<AudioBuffer>>();
  /** Analyses of songs that can't be stored (the built-in demo), for this page load. */
  private readonly memoryAnalyses = new Map<string, AudioAnalysis>();

  /**
   * @param repo null when IndexedDB could not be opened; then only the demo is available and
   *   `storageError` says why.
   */
  constructor(
    private readonly repo: LibraryRepository | null,
    private readonly audio: AudioEngine,
    readonly storageError: string | null = null,
  ) {}

  // --- Building blocks (also used by the Studio library in src/studio) -------------------------

  requireRepo(): LibraryRepository {
    if (!this.repo) {
      throw new LibraryError([
        this.storageError ?? 'The song library is not available in this browser.',
      ]);
    }
    return this.repo;
  }

  /** A stored song; the demo and missing songs throw a LibraryError. */
  async requireSong(songId: string): Promise<SongRecord> {
    if (songId === DEMO_SONG_ID) throw new LibraryError([READ_ONLY]);
    const song = await this.requireRepo().getSong(songId);
    if (!song)
      throw new LibraryError([
        'This song no longer exists. It may have been deleted in another tab.',
      ]);
    return song;
  }

  async requireChart(chartId: string): Promise<ChartRecord> {
    const chart = await this.requireRepo().getChart(chartId);
    if (!chart)
      throw new LibraryError([
        'This chart no longer exists. It may have been deleted in another tab.',
      ]);
    return chart;
  }

  // --- Best scores ---------------------------------------------------------------------------

  /** Personal best per chart id. Empty when storage is unavailable. */
  async bestScores(): Promise<Map<string, ScoreRecord>> {
    if (!this.repo) return new Map();
    const all = await this.repo.listBestScores();
    return new Map(all.map((s) => [s.chartId, s]));
  }

  /**
   * Save a finished play as the chart's best if it beats the stored one. Null when storage is
   * unavailable (the play is simply not saved).
   */
  async recordScore(
    score: NewScore,
  ): Promise<{ best: ScoreRecord; previous: ScoreRecord | null; isNewBest: boolean } | null> {
    if (!this.repo) return null;
    return this.repo.recordScore(score);
  }

  /** Every song (demo first, then stored songs by title) and every chart. */
  async catalog(): Promise<Catalog> {
    const demo = createDemoChart();
    const songs = [demoSong()];
    const charts: CatalogChart[] = [
      {
        id: DEMO_CHART_ID,
        songId: DEMO_SONG_ID,
        difficulty: demo.difficulty,
        level: demo.level,
        charter: demo.charter,
        noteCount: demo.notes.length,
        builtIn: true,
      },
    ];
    if (this.repo) {
      const [stored, storedCharts] = await Promise.all([
        this.repo.listSongs(),
        this.repo.listCharts(),
      ]);
      songs.push(...stored.map(toCatalogSong));
      charts.push(...storedCharts.map(toCatalogChart));
    }
    return { songs, charts };
  }

  /** A song's custom cover (null for the demo, songs without one, or no storage). */
  async coverOf(songId: string): Promise<CoverRef | null> {
    if (songId === DEMO_SONG_ID || !this.repo) return null;
    const song = await this.repo.getSong(songId);
    return song ? coverRefOf(song) : null;
  }

  // --- Backgrounds -----------------------------------------------------------------------------

  /** A song's background config, pictures, sprites and cover (the demo has a built-in config). */
  async backgroundOf(songId: string): Promise<SongBackground> {
    const empty = { images: [], sprites: [], cover: null };
    if (songId === DEMO_SONG_ID || !this.repo) {
      return { config: songId === DEMO_SONG_ID ? DEMO_BACKGROUND : null, ...empty };
    }
    const song = await this.repo.getSong(songId);
    if (!song) return { config: null, ...empty };
    return {
      // Stored configs from older versions are migrated as they are read (and saved as the
      // current version the next time the background is saved).
      config: sanitizeBackgroundConfig(song.background),
      images: (song.backgroundImages ?? []).filter((i) => i.blob instanceof Blob),
      sprites: (song.particleSprites ?? []).filter((i) => i.blob instanceof Blob),
      cover: song.cover instanceof Blob ? song.cover : null,
    };
  }

  /** The player's custom background picture (Settings -> Display), or null. Never throws. */
  async playerBackground(): Promise<Blob | null> {
    if (!this.repo) return null;
    try {
      return (await this.repo.getPlayerAsset(PLAYER_BACKGROUND_ASSET))?.blob ?? null;
    } catch (err) {
      console.warn('Reading the custom background failed.', err);
      return null;
    }
  }

  /**
   * Set the player's custom background from a picture file (validated, shrunk to fit 1920x1080,
   * size-limited like a Studio upload), or remove it with null.
   */
  async setPlayerBackground(file: Blob | null, name?: string): Promise<void> {
    const repo = this.requireRepo();
    if (file === null) {
      await repo.setPlayerAsset(PLAYER_BACKGROUND_ASSET, null);
      return;
    }
    const blob = await processBackgroundImage(file, name ? { name } : {});
    await repo.setPlayerAsset(PLAYER_BACKGROUND_ASSET, blob);
  }

  // --- Audio analysis cache ------------------------------------------------------------------

  /** The song's cached audio analysis if it still matches its audio, else null. Never throws. */
  async cachedAnalysis(songId: string): Promise<AudioAnalysis | null> {
    const memory = this.memoryAnalyses.get(songId);
    if (memory) return memory;
    if (songId === DEMO_SONG_ID || !this.repo) return null;
    try {
      const [record, song] = await Promise.all([
        this.repo.getAnalysis(songId),
        this.repo.getSong(songId),
      ]);
      return record && song && analysisCacheValid(record, song) ? record.analysis : null;
    } catch (err) {
      console.warn('Reading the cached audio analysis failed; it will be recomputed.', err);
      return null;
    }
  }

  /** Cache a song's audio analysis. Failures are logged, never thrown (it is only a cache). */
  async saveAnalysis(songId: string, analysis: AudioAnalysis): Promise<void> {
    if (songId === DEMO_SONG_ID || !this.repo) {
      this.memoryAnalyses.set(songId, analysis);
      return;
    }
    try {
      const song = await this.repo.getSong(songId);
      if (!song) return;
      await this.repo.putAnalysis({
        songId,
        analysisVersion: ANALYSIS_VERSION,
        audioSize: song.audio.size,
        durationMs: song.durationMs,
        analysis,
      });
    } catch (err) {
      console.warn('Caching the audio analysis failed.', err);
    }
  }

  /** The analysis cache of one song, for `AudioAnalyzer`. */
  analysisCache(songId: string): AnalysisCache {
    return {
      load: () => this.cachedAnalysis(songId),
      save: (a) => this.saveAnalysis(songId, a),
    };
  }

  /** A playable chart file (standard format) for a song and chart. */
  async loadChart(songId: string, chartId: string): Promise<{ song: CatalogSong; chart: Chart }> {
    if (songId === DEMO_SONG_ID) return { song: demoSong(), chart: createDemoChart() };
    const [song, chart] = await Promise.all([this.requireSong(songId), this.requireChart(chartId)]);
    if (chart.songId !== songId) {
      throw new LibraryError([
        'This chart belongs to a different song. Pick it again from the song list.',
      ]);
    }
    return { song: toCatalogSong(song), chart: toChartFile(song, chart) };
  }

  /** The decoded audio of a song (cached for the most recent songs). */
  loadAudio(songId: string): Promise<AudioBuffer> {
    const cached = this.audioCache.get(songId);
    if (cached) {
      // Mark as most recently used.
      this.audioCache.delete(songId);
      this.audioCache.set(songId, cached);
      return cached;
    }
    const loading =
      songId === DEMO_SONG_ID
        ? getDemoSong(createDemoChart())
        : this.requireSong(songId).then((song) => this.decode(song.audio, song.audioFileName));
    this.remember(songId, loading);
    return loading;
  }

  /** Put decoded audio in the cache (e.g. right after an import decoded it). */
  remember(songId: string, loading: Promise<AudioBuffer>): void {
    this.audioCache.set(songId, loading);
    loading.catch(() => {
      if (this.audioCache.get(songId) === loading) this.audioCache.delete(songId);
    });
    while (this.audioCache.size > AUDIO_CACHE_SIZE) {
      const oldest = this.audioCache.keys().next().value;
      if (oldest === undefined) break;
      this.audioCache.delete(oldest);
    }
  }

  /** Decode audio bytes; failures become a LibraryError that says what to do. */
  async decode(data: Blob | ArrayBuffer, fileName: string): Promise<AudioBuffer> {
    try {
      const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
      return await this.audio.decode(bytes);
    } catch {
      throw new LibraryError([
        `"${fileName}" could not be decoded. This browser can't play this audio format, or the file is damaged. Try converting it to MP3, OGG or WAV.`,
      ]);
    }
  }

  // --- Player library operations --------------------------------------------------------------

  /**
   * Import a song package (.zip). All-or-nothing for the song, audio and charts: validates and
   * decodes before writing. A missing or unreadable cover doesn't stop the import: the song is
   * imported without it and `warnings` says why.
   */
  async importPackage(file: File): Promise<{ song: CatalogSong; warnings: string[] }> {
    const repo = this.requireRepo();
    const result = readSongPackage(new Uint8Array(await file.arrayBuffer()));
    if (!result.ok) throw new LibraryError(result.errors);
    const { song, audioFileName, audio, charts, cover, background, backgroundImages } =
      result.contents;
    const warnings = [...result.warnings];
    // slice(): decoding detaches the buffer, and the bytes are still needed for storage.
    const buffer = await this.decode(audio.slice().buffer, audioFileName);
    let images: CoverImages | null = null;
    if (cover) {
      try {
        images = await coverFromPackage(
          new Blob([cover.bytes.slice()], { type: cover.type }),
          cover.fileName,
        );
      } catch (err) {
        const reason = err instanceof LibraryError ? ` ${err.errors.join(' ')}` : '';
        warnings.push(`The cover could not be read, so the song was imported without it.${reason}`);
      }
    }
    const pictures: BackgroundImageRecord[] = [];
    for (const image of backgroundImages) {
      try {
        const blob = await backgroundFromPackage(
          new Blob([image.bytes.slice()], { type: image.type }),
          image.fileName,
        );
        pictures.push({ id: image.id, blob });
      } catch (err) {
        const reason = err instanceof LibraryError ? ` ${err.errors.join(' ')}` : '';
        warnings.push(
          `The background picture "${image.fileName}" could not be read, so the song was imported without it.${reason}`,
        );
      }
    }
    const sprites: ParticleSpriteRecord[] = [];
    for (const sprite of result.contents.particleSprites) {
      try {
        const blob = await processSpriteFile(
          new Blob([sprite.bytes.slice()], { type: 'image/png' }),
          sprite.fileName,
        );
        sprites.push({ id: sprite.id, name: sprite.name, blob });
      } catch (err) {
        const reason = err instanceof LibraryError ? ` ${err.errors.join(' ')}` : '';
        warnings.push(
          `The custom sprite "${sprite.name}" could not be read, so particles using it are hidden.${reason}`,
        );
      }
    }
    const created = await repo.createSongWithCharts(
      {
        ...song,
        audio: new Blob([audio.slice()], { type: audioMimeType(audioFileName) }),
        audioFileName,
        durationMs: Math.round(buffer.duration * 1000),
        cover: images?.cover ?? null,
        coverThumb: images?.coverThumb ?? null,
        background,
        backgroundImages: pictures,
        particleSprites: sprites,
      },
      charts.map(chartFields),
    );
    this.remember(created.song.id, Promise.resolve(buffer));
    return { song: toCatalogSong(created.song), warnings };
  }

  /** Delete a song with its audio, charts and best scores. */
  async deleteSong(songId: string): Promise<void> {
    if (songId === DEMO_SONG_ID) throw new LibraryError([READ_ONLY]);
    await this.requireRepo().deleteSong(songId);
    this.audioCache.delete(songId);
  }
}
