import { ANALYSIS_VERSION, type AudioAnalysis } from '../core/analysis';
import type { BackgroundConfig } from '../core/background/config';
import {
  CHART_VERSION,
  MAX_LEVEL,
  MIN_LEVEL,
  compareNotes,
  type Chart,
  type Note,
} from '../core/chart';
import { MAX_BPM } from '../core/parseChart';
import { RANKS, type Rank } from '../core/results';
import { MAX_SCORE } from '../core/scoring';

/**
 * Library records as stored in IndexedDB, and the pure helpers around them (validation,
 * conversion to and from the chart file format, ordering). No IndexedDB or DOM here.
 */

export interface SongRecord {
  id: string;
  title: string;
  artist: string;
  /** The original encoded audio file, exactly as imported. */
  audio: Blob;
  audioFileName: string;
  durationMs: number;
  bpm: number;
  offsetMs: number;
  previewStartMs: number;
  /**
   * Custom cover (database version 3): a 512x512 image (WebP, or PNG where the browser can't
   * encode WebP) and its 128x128 thumbnail. Both set or both null; null (or missing in records
   * written before version 3) means the generated placeholder is shown.
   */
  cover?: Blob | null;
  coverThumb?: Blob | null;
  /**
   * The song's gameplay background (database version 5), made in the Studio; null (or missing
   * in older records) means the default (the cover). Older configs (Phase 15, Phase 20) are
   * migrated when read (`sanitizeBackgroundConfig`). See core/background.
   */
  background?: BackgroundConfig | null;
  /**
   * The song's background pictures (database version 7; base 'image' shows the one its config
   * names): up to MAX_BACKGROUND_IMAGES, WebP (or PNG), at most 1920x1080 each.
   */
  backgroundImages?: BackgroundImageRecord[];
  /**
   * Database versions 5-6 kept one picture here; the version 7 upgrade moves it into
   * `backgroundImages` and removes this field.
   */
  backgroundImage?: Blob | null;
  /** Custom particle sprites (database version 7): small PNGs, up to MAX_CUSTOM_SPRITES. */
  particleSprites?: ParticleSpriteRecord[];
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

/** One of a song's background pictures. `id` is what `BaseConfig.imageId` refers to. */
export interface BackgroundImageRecord {
  id: string;
  blob: Blob;
}

/** A custom particle sprite (PNG, at most 64x64). Emitters refer to it as `custom:<id>`. */
export interface ParticleSpriteRecord {
  id: string;
  name: string;
  blob: Blob;
}

export interface ChartRecord {
  id: string;
  songId: string;
  difficulty: string;
  level: number;
  charter: string;
  notes: Note[];
  /**
   * The chart's custom game start (Chart.startMs); null or missing (charts saved before chart
   * format 2) means automatic.
   */
  startMs?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A chart's personal best, one per chart (keyed by chart id, so the built-in demo chart can have
 * one too). Holds the numbers of the best-scoring play.
 */
export interface ScoreRecord {
  chartId: string;
  songId: string;
  score: number;
  /** Accuracy in percent (0-100). */
  accuracy: number;
  rank: Rank;
  maxCombo: number;
  fullCombo: boolean;
  allPerfect: boolean;
  /** Epoch ms of the play. */
  achievedAt: number;
}

export type NewScore = Omit<ScoreRecord, 'achievedAt'>;

export function validateScore(s: NewScore): string[] {
  const errors: string[] = [];
  if (typeof s.chartId !== 'string' || s.chartId === '') errors.push('A score needs a chart id.');
  if (typeof s.songId !== 'string' || s.songId === '') errors.push('A score needs a song id.');
  if (!Number.isInteger(s.score) || s.score < 0 || s.score > MAX_SCORE) {
    errors.push(`A score must be a whole number from 0 to ${MAX_SCORE}, got ${String(s.score)}.`);
  }
  if (!Number.isFinite(s.accuracy) || s.accuracy < 0 || s.accuracy > 100) {
    errors.push(`Accuracy must be from 0 to 100 %, got ${String(s.accuracy)}.`);
  }
  if (!RANKS.includes(s.rank)) errors.push(`"${String(s.rank)}" is not a rank.`);
  if (!Number.isInteger(s.maxCombo) || s.maxCombo < 0) {
    errors.push(`Max combo must be a whole number of 0 or more, got ${String(s.maxCombo)}.`);
  }
  return errors;
}

type Generated = 'id' | 'createdAt' | 'updatedAt';
export type NewSong = Omit<SongRecord, Generated>;
export type NewChart = Omit<ChartRecord, Generated>;
/** Editable song fields. The audio and its duration are fixed once imported. */
export type SongPatch = Partial<
  Pick<SongRecord, 'title' | 'artist' | 'bpm' | 'offsetMs' | 'previewStartMs'>
>;
export type ChartPatch = Partial<
  Pick<ChartRecord, 'difficulty' | 'level' | 'charter' | 'notes' | 'startMs'>
>;
/** The parts of a chart record that make up a chart file (with its song). */
export type ChartContent = Pick<ChartRecord, 'difficulty' | 'level' | 'charter' | 'notes'> &
  Partial<Pick<ChartRecord, 'startMs'>>;

/** Song-level timing and naming shared by every chart of a song. */
export interface SongMeta {
  title: string;
  artist: string;
  bpm: number;
  offsetMs: number;
  previewStartMs: number;
}

export const DEFAULT_BPM = 120;
export const DEFAULT_DIFFICULTY = 'Normal';
/** Where the preview starts for a freshly imported song, as a fraction of its length. */
export const DEFAULT_PREVIEW_FRACTION = 0.3;

/** Problems with song metadata, as complete sentences. Empty when valid. */
export function validateSongMeta(meta: SongMeta): string[] {
  const errors: string[] = [];
  if (typeof meta.title !== 'string' || meta.title.trim() === '') {
    errors.push('The song title must not be empty.');
  }
  if (typeof meta.artist !== 'string') errors.push('The artist must be text.');
  if (typeof meta.bpm !== 'number' || !Number.isFinite(meta.bpm) || meta.bpm <= 0) {
    errors.push(`The BPM must be a number greater than 0, got ${String(meta.bpm)}.`);
  } else if (meta.bpm > MAX_BPM) {
    errors.push(`The BPM must be at most ${MAX_BPM}, got ${meta.bpm}.`);
  }
  if (!Number.isInteger(meta.offsetMs)) {
    errors.push(`The offset must be a whole number of milliseconds, got ${String(meta.offsetMs)}.`);
  }
  if (!Number.isInteger(meta.previewStartMs) || meta.previewStartMs < 0) {
    errors.push(
      `The preview start must be a whole number of milliseconds, 0 or more, got ${String(meta.previewStartMs)}.`,
    );
  }
  return errors;
}

/** Problems with chart metadata (not notes; parseChart checks those). Empty when valid. */
export function validateChartMeta(meta: Pick<ChartRecord, 'difficulty' | 'level'>): string[] {
  const errors: string[] = [];
  if (typeof meta.difficulty !== 'string' || meta.difficulty.trim() === '') {
    errors.push('The difficulty name must not be empty.');
  }
  if (!Number.isInteger(meta.level) || meta.level < MIN_LEVEL || meta.level > MAX_LEVEL) {
    errors.push(
      `The level must be a whole number from ${MIN_LEVEL} to ${MAX_LEVEL}, got ${String(meta.level)}.`,
    );
  }
  return errors;
}

/** The standard chart file (current format) for a stored chart and its song. */
export function toChartFile(
  song: SongMeta & { audioFileName: string },
  chart: ChartContent,
): Chart {
  return {
    version: CHART_VERSION,
    title: song.title,
    artist: song.artist,
    audio: song.audioFileName,
    bpm: song.bpm,
    offsetMs: song.offsetMs,
    previewStartMs: song.previewStartMs,
    ...(typeof chart.startMs === 'number' ? { startMs: chart.startMs } : {}),
    difficulty: chart.difficulty,
    level: chart.level,
    charter: chart.charter,
    notes: [...chart.notes].sort(compareNotes),
  };
}

/** The chart-specific part of a chart file; song-level fields belong to the song. */
export function chartFields(chart: Chart): Omit<NewChart, 'songId'> {
  return {
    difficulty: chart.difficulty,
    level: chart.level,
    charter: chart.charter,
    notes: chart.notes,
    startMs: chart.startMs ?? null,
  };
}

/** The song-level part of a chart file. */
export function songMetaOf(chart: Chart): SongMeta {
  return {
    title: chart.title,
    artist: chart.artist,
    bpm: chart.bpm,
    offsetMs: chart.offsetMs,
    previewStartMs: chart.previewStartMs,
  };
}

/** Usual difficulty names, easiest first. Others sort after these, alphabetically. */
const DIFFICULTY_ORDER = ['beginner', 'easy', 'normal', 'hard', 'expert', 'master'];

function difficultyRank(name: string): number {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\s+\d+$/, '');
  const i = DIFFICULTY_ORDER.indexOf(base);
  return i < 0 ? DIFFICULTY_ORDER.length : i;
}

/** Order for listing a song's charts: by difficulty name rank, then level, then name. */
export function compareCharts(
  a: Pick<ChartRecord, 'difficulty' | 'level'>,
  b: Pick<ChartRecord, 'difficulty' | 'level'>,
): number {
  return (
    difficultyRank(a.difficulty) - difficultyRank(b.difficulty) ||
    a.level - b.level ||
    a.difficulty.localeCompare(b.difficulty)
  );
}

/**
 * `wanted` if no chart uses that difficulty name yet, otherwise `wanted 2`, `wanted 3`, ...
 * (case-insensitive), so a song's charts stay distinguishable.
 */
export function uniqueDifficulty(wanted: string, taken: readonly string[]): string {
  const used = new Set(taken.map((d) => d.trim().toLowerCase()));
  if (!used.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; ; n++) {
    const name = `${wanted} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/**
 * A song's cached audio analysis (src/core/analysis). Valid only while `analysisVersion` matches
 * ANALYSIS_VERSION and the audio's size and length match the song's; otherwise it is recomputed.
 */
export interface AnalysisRecord {
  songId: string;
  analysisVersion: number;
  audioSize: number;
  durationMs: number;
  createdAt: number;
  analysis: AudioAnalysis;
}

/** True when a cached analysis still belongs to the song's audio and this analysis version. */
export function analysisCacheValid(
  record: Pick<AnalysisRecord, 'analysisVersion' | 'audioSize' | 'durationMs'>,
  song: Pick<SongRecord, 'audio' | 'durationMs'>,
): boolean {
  return (
    record.analysisVersion === ANALYSIS_VERSION &&
    record.audioSize === song.audio.size &&
    record.durationMs === song.durationMs
  );
}

/**
 * Cached chart-analysis features of one song (database version 6, Studio only). The library
 * keeps `data` opaque: the Studio's analyzer checks its shape and `analysisVersion` (its own
 * version number) before using it, so old caches are recomputed.
 */
export interface ChartAnalysisRecord {
  songId: string;
  analysisVersion: number;
  audioSize: number;
  durationMs: number;
  createdAt: number;
  data: unknown;
}

/**
 * A picture the player stored for themselves (database version 5), e.g. the custom background
 * that Settings -> Display can put behind every song. Keyed by a fixed id.
 */
export interface PlayerAssetRecord {
  id: string;
  blob: Blob;
  updatedAt: number;
}

/** The player's custom background picture. */
export const PLAYER_BACKGROUND_ASSET = 'background';
