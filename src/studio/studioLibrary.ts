import { sanitizeBackgroundConfig, type BackgroundConfig } from '../core/background/config';
import type { CropRect } from '../core/coverCrop';
import { parseChart, serializeChart } from '../core/parseChart';
import { processBackgroundImage } from '../library/backgroundImage';
import { processSpriteFile } from '../library/particleSprite';
import type { BackgroundImageRecord, ParticleSpriteRecord } from '../library/records';
import { coverEntryName, processCover, type CoverImages } from '../library/cover';
import { safeFileName, titleFromFileName } from '../library/fileNames';
import {
  DEFAULT_BPM,
  DEFAULT_DIFFICULTY,
  DEFAULT_PREVIEW_FRACTION,
  chartFields,
  songMetaOf,
  uniqueDifficulty,
  type ChartPatch,
  type SongPatch,
} from '../library/records';
import { LibraryError } from '../library/repository';
import {
  DEMO_CHART_ID,
  DEMO_SONG_ID,
  READ_ONLY,
  audioMimeType,
  toCatalogChart,
  toCatalogSong,
  type CatalogChart,
  type CatalogSong,
  type SongLibrary,
} from '../library/songLibrary';
import { buildSongPackage } from '../library/songPackage';
import { readAudioTags } from './audioMetadata';

/** Where one song's chart-analysis features are cached (opaque data plus a version). */
export interface ChartAnalysisStore {
  /** The cached data for this analysis version and the song's current audio, else null. */
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

/** A file ready for the browser's download prompt. */
export interface Download {
  blob: Blob;
  fileName: string;
}

/**
 * Creating and editing library content (Studio only): audio import, charts (new, duplicate,
 * import, delete), song and chart metadata, chart and song package export. Works on the same
 * IndexedDB data as the player's `SongLibrary` (and shares its audio cache), so nothing is
 * duplicated or migrated; it only adds the operations the player build leaves out.
 */
export class StudioLibrary {
  /** Chart analyses of songs that can't be stored (the built-in demo), for this page load. */
  private readonly memoryChartAnalyses = new Map<string, { version: number; data: unknown }>();

  constructor(private readonly library: SongLibrary) {}

  // --- Chart analysis cache ----------------------------------------------------------------------

  /**
   * The chart-analysis cache of one song (IndexedDB, database version 6). A cache only: reads
   * that fail return null and writes that fail are logged, never thrown.
   */
  chartAnalysisStore(songId: string, version: number): ChartAnalysisStore {
    const memory = this.memoryChartAnalyses;
    const library = this.library;
    return {
      async load() {
        const kept = memory.get(songId);
        if (kept) return kept.version === version ? kept.data : null;
        if (songId === DEMO_SONG_ID) return null;
        try {
          const repo = library.requireRepo();
          const [record, song] = await Promise.all([
            repo.getChartAnalysis(songId),
            repo.getSong(songId),
          ]);
          if (!record || !song) return null;
          const valid =
            record.analysisVersion === version &&
            record.audioSize === song.audio.size &&
            record.durationMs === song.durationMs;
          return valid ? record.data : null;
        } catch (err) {
          console.warn('Reading the cached chart analysis failed; it will be recomputed.', err);
          return null;
        }
      },
      async save(data) {
        if (songId === DEMO_SONG_ID) {
          memory.set(songId, { version, data });
          return;
        }
        try {
          const repo = library.requireRepo();
          const song = await repo.getSong(songId);
          if (!song) return;
          await repo.putChartAnalysis({
            songId,
            analysisVersion: version,
            audioSize: song.audio.size,
            durationMs: song.durationMs,
            data,
          });
        } catch (err) {
          console.warn('Caching the chart analysis failed.', err);
        }
      },
    };
  }

  // --- Import ----------------------------------------------------------------------------------

  /**
   * Import an audio file as a new song with default timing. Title, artist and cover come from the
   * file's embedded tags when it has them (title otherwise from the file name); everything can
   * be changed afterwards. Tags that can't be read never stop the import.
   */
  async importAudio(file: File): Promise<{ song: CatalogSong; fromTags: string[] }> {
    const repo = this.library.requireRepo();
    const [buffer, tags] = await Promise.all([
      this.library.decode(await file.arrayBuffer(), file.name),
      readAudioTags(file),
    ]);
    const durationMs = Math.round(buffer.duration * 1000);
    if (durationMs <= 0) throw new LibraryError([`"${file.name}" contains no audio.`]);
    let cover: CoverImages | null = null;
    if (tags.picture) {
      try {
        cover = await processCover(tags.picture, { name: 'The embedded artwork' });
      } catch (err) {
        console.info('The embedded artwork could not be used as a cover:', err);
      }
    }
    const fromTags = [
      ...(tags.title ? ['title'] : []),
      ...(tags.artist ? ['artist'] : []),
      ...(cover ? ['cover'] : []),
    ];
    const song = await repo.createSong({
      title: tags.title ?? titleFromFileName(file.name),
      artist: tags.artist ?? '',
      audio: new Blob([file], { type: audioMimeType(file.name, file.type) }),
      audioFileName: file.name,
      durationMs,
      bpm: DEFAULT_BPM,
      offsetMs: 0,
      previewStartMs: Math.round(durationMs * DEFAULT_PREVIEW_FRACTION),
      cover: cover?.cover ?? null,
      coverThumb: cover?.coverThumb ?? null,
    });
    this.library.remember(song.id, Promise.resolve(buffer));
    return { song: toCatalogSong(song), fromTags };
  }

  /**
   * Import a chart file (JSON) into a song. A song's first chart also sets the song's title,
   * artist and timing; later charts keep the song's (a notice says so if they differ).
   */
  async importChart(
    file: File,
    songId: string,
  ): Promise<{ chart: CatalogChart; notice: string | null }> {
    const song = await this.library.requireSong(songId);
    const repo = this.library.requireRepo();
    const parsed = parseChart(await file.text());
    if (!parsed.ok) throw new LibraryError(parsed.errors);
    const existing = await repo.listCharts(songId);
    const fields = chartFields(parsed.chart);
    fields.difficulty = uniqueDifficulty(
      fields.difficulty,
      existing.map((c) => c.difficulty),
    );
    const chart = await repo.createChart({ ...fields, songId });
    let notice: string | null = null;
    const meta = songMetaOf(parsed.chart);
    if (existing.length === 0) {
      await repo.updateSong(songId, meta);
    } else if (meta.bpm !== song.bpm || meta.offsetMs !== song.offsetMs) {
      notice = `The chart's BPM and offset (${meta.bpm}, ${meta.offsetMs} ms) differ from the song's (${song.bpm}, ${song.offsetMs} ms). The song's values were kept.`;
    }
    return { chart: toCatalogChart(chart), notice };
  }

  // --- Charts ----------------------------------------------------------------------------------

  /** Add an empty chart ("Normal", level 1; "Normal 2" etc. if that name is taken). */
  async createBlankChart(songId: string): Promise<CatalogChart> {
    await this.library.requireSong(songId);
    const repo = this.library.requireRepo();
    const taken = (await repo.listCharts(songId)).map((c) => c.difficulty);
    const chart = await repo.createChart({
      songId,
      difficulty: uniqueDifficulty(DEFAULT_DIFFICULTY, taken),
      level: 1,
      charter: '',
      notes: [],
    });
    return toCatalogChart(chart);
  }

  /** Copy a chart within its song, named "<difficulty> copy" (numbered if taken). */
  async duplicateChart(songId: string, chartId: string): Promise<CatalogChart> {
    await this.library.requireSong(songId);
    const repo = this.library.requireRepo();
    const source = await this.library.requireChart(chartId);
    if (source.songId !== songId) {
      throw new LibraryError([
        'This chart belongs to a different song. Pick it again from the song list.',
      ]);
    }
    const taken = (await repo.listCharts(songId)).map((c) => c.difficulty);
    const chart = await repo.createChart({
      songId,
      difficulty: uniqueDifficulty(`${source.difficulty} copy`.slice(0, 40), taken),
      level: source.level,
      charter: source.charter,
      notes: source.notes.map((n) => ({ ...n })),
      startMs: source.startMs ?? null,
    });
    return toCatalogChart(chart);
  }

  // --- Edit / delete ---------------------------------------------------------------------------

  async updateSong(songId: string, patch: SongPatch): Promise<void> {
    await this.library.requireSong(songId);
    await this.library.requireRepo().updateSong(songId, patch);
  }

  /**
   * Set a song's cover from a picture file, cropped to `crop` (source pixels; centred square when
   * null). Validates, decodes, shrinks and encodes; failures are LibraryErrors.
   */
  async setCover(
    songId: string,
    file: Blob,
    crop: CropRect | null,
    name?: string,
  ): Promise<CatalogSong> {
    await this.library.requireSong(songId);
    const images = await processCover(file, { crop, ...(name ? { name } : {}) });
    return toCatalogSong(await this.library.requireRepo().setCover(songId, images));
  }

  /** Remove a song's cover (the generated placeholder is shown again). */
  async removeCover(songId: string): Promise<CatalogSong> {
    await this.library.requireSong(songId);
    return toCatalogSong(await this.library.requireRepo().setCover(songId, null));
  }

  async updateChart(chartId: string, patch: ChartPatch): Promise<void> {
    if (chartId === DEMO_CHART_ID) throw new LibraryError([READ_ONLY]);
    await this.library.requireRepo().updateChart(chartId, patch);
  }

  async deleteChart(chartId: string): Promise<void> {
    if (chartId === DEMO_CHART_ID) throw new LibraryError([READ_ONLY]);
    await this.library.requireRepo().deleteChart(chartId);
  }

  // --- Background ------------------------------------------------------------------------------

  /**
   * Save a song's background (null: back to the default) with its pictures (already processed
   * with `prepareBackgroundImage`) and custom sprites (`prepareSprite`); a list left out keeps
   * the stored one.
   */
  async setBackground(
    songId: string,
    config: BackgroundConfig | null,
    assets: { images?: BackgroundImageRecord[]; sprites?: ParticleSpriteRecord[] } = {},
  ): Promise<CatalogSong> {
    await this.library.requireSong(songId);
    return toCatalogSong(await this.library.requireRepo().setBackground(songId, config, assets));
  }

  /** Validate, shrink and encode a picture file as a background picture (LibraryError on failure). */
  prepareBackgroundImage(file: Blob, name?: string): Promise<Blob> {
    return processBackgroundImage(file, name ? { name } : {});
  }

  /** Check a PNG as a custom particle sprite (at most 64x64, 256 KB; LibraryError on failure). */
  prepareSprite(file: Blob, name?: string): Promise<Blob> {
    return processSpriteFile(file, name);
  }

  // --- Export ----------------------------------------------------------------------------------

  /** One chart as a standard chart file (works for the demo too). */
  async exportChart(songId: string, chartId: string): Promise<Download> {
    const { song, chart } = await this.library.loadChart(songId, chartId);
    return {
      blob: new Blob([serializeChart(chart)], { type: 'application/json' }),
      fileName: `${safeFileName(`${song.title} - ${chart.difficulty}`, 'chart')}.json`,
    };
  }

  /** A song with its audio and every chart as a .zip package. */
  async exportPackage(songId: string): Promise<Download> {
    if (songId === DEMO_SONG_ID) throw new LibraryError([READ_ONLY]);
    const song = await this.library.requireSong(songId);
    const charts = await this.library.requireRepo().listCharts(songId);
    const cover = song.cover
      ? {
          fileName: coverEntryName(song.cover),
          bytes: new Uint8Array(await song.cover.arrayBuffer()),
        }
      : null;
    const backgroundImages = await Promise.all(
      (song.backgroundImages ?? []).map(async (i) => ({
        id: i.id,
        type: i.blob.type,
        bytes: new Uint8Array(await i.blob.arrayBuffer()),
      })),
    );
    const particleSprites = await Promise.all(
      (song.particleSprites ?? []).map(async (i) => ({
        id: i.id,
        name: i.name,
        bytes: new Uint8Array(await i.blob.arrayBuffer()),
      })),
    );
    const zip = buildSongPackage({
      song,
      audio: new Uint8Array(await song.audio.arrayBuffer()),
      charts,
      cover,
      background: sanitizeBackgroundConfig(song.background),
      backgroundImages,
      particleSprites,
    });
    return {
      // fflate allocates plain ArrayBuffers; its types just don't say so.
      blob: new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
      fileName: `${safeFileName(song.title, 'song')}.zip`,
    };
  }
}
