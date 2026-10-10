import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AnalysisRecord,
  ChartAnalysisRecord,
  ChartRecord,
  PlayerAssetRecord,
  ScoreRecord,
  SongRecord,
} from './records';

export const LIBRARY_DB_NAME = 'pixel-beat-library';
/** Bump when the schema changes, and add a step to `upgrade` below. */
export const LIBRARY_DB_VERSION = 7;

export interface LibrarySchema extends DBSchema {
  /**
   * Version 3: songs may carry `cover` and `coverThumb` blobs; version 5: `background` and
   * `backgroundImage`; version 7: `backgroundImages` (replacing `backgroundImage`) and
   * `particleSprites` (see SongRecord).
   */
  songs: {
    key: string;
    value: SongRecord;
  };
  charts: {
    key: string;
    value: ChartRecord;
    indexes: { bySong: string };
  };
  /** Version 2: personal best per chart. */
  scores: {
    key: string;
    value: ScoreRecord;
    indexes: { bySong: string };
  };
  /** Version 4: cached audio analysis per song (Studio charting; recomputed when missing). */
  analyses: {
    key: string;
    value: AnalysisRecord;
  };
  /** Version 5: the player's own pictures (the custom background), by fixed id. */
  playerAssets: {
    key: string;
    value: PlayerAssetRecord;
  };
  /**
   * Version 6: cached chart-analysis features per song (Studio only; opaque here, validated by
   * src/studio/charting/analysis, recomputed when missing or of another version).
   */
  chartAnalyses: {
    key: string;
    value: ChartAnalysisRecord;
  };
}

export type LibraryDb = IDBPDatabase<LibrarySchema>;

/**
 * Open (creating or upgrading) the library database. Upgrades run step by step from the
 * stored version, so a browser that skipped versions still ends up with the current schema.
 */
export async function openLibraryDb(name = LIBRARY_DB_NAME): Promise<LibraryDb> {
  const db: LibraryDb = await openDB<LibrarySchema>(name, LIBRARY_DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('songs', { keyPath: 'id' });
        const charts = db.createObjectStore('charts', { keyPath: 'id' });
        charts.createIndex('bySong', 'songId');
      }
      if (oldVersion < 2) {
        // Adds a store only: songs and charts from version 1 are kept as they are.
        const scores = db.createObjectStore('scores', { keyPath: 'chartId' });
        scores.createIndex('bySong', 'songId');
      }
      if (oldVersion >= 1 && oldVersion < 3) {
        // Covers: every existing song gets explicit empty cover fields (the placeholder is shown);
        // nothing else changes, and charts and scores are untouched.
        let cursor = await tx.objectStore('songs').openCursor();
        while (cursor) {
          const song = cursor.value;
          if (song.cover === undefined || song.coverThumb === undefined) {
            await cursor.update({
              ...song,
              cover: song.cover ?? null,
              coverThumb: song.coverThumb ?? null,
            });
          }
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 4) {
        // Adds a cache store only: nothing else changes.
        db.createObjectStore('analyses', { keyPath: 'songId' });
      }
      if (oldVersion >= 1 && oldVersion < 5) {
        // Backgrounds: every existing song gets explicit empty background fields (the default
        // background is shown); covers, charts, scores and cached analyses are untouched.
        let cursor = await tx.objectStore('songs').openCursor();
        while (cursor) {
          const song = cursor.value;
          if (song.background === undefined || song.backgroundImage === undefined) {
            await cursor.update({
              ...song,
              background: song.background ?? null,
              backgroundImage: song.backgroundImage ?? null,
            });
          }
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 5) db.createObjectStore('playerAssets', { keyPath: 'id' });
      // Adds a cache store only: nothing else changes.
      if (oldVersion < 6) db.createObjectStore('chartAnalyses', { keyPath: 'songId' });
      if (oldVersion >= 1 && oldVersion < 7) {
        // Several background pictures and custom particle sprites per song: the one picture
        // moves into the list (its config's base keeps showing it: no imageId means the first),
        // every song gets an empty sprite list; nothing else changes.
        let cursor = await tx.objectStore('songs').openCursor();
        while (cursor) {
          const song = cursor.value;
          if (song.backgroundImages === undefined || song.particleSprites === undefined) {
            const { backgroundImage, ...rest } = song;
            const images =
              song.backgroundImages ??
              (backgroundImage instanceof Blob ? [{ id: 'image-1', blob: backgroundImage }] : []);
            await cursor.update({
              ...rest,
              backgroundImages: images,
              particleSprites: song.particleSprites ?? [],
            });
          }
          cursor = await cursor.continue();
        }
      }
      // if (oldVersion < 8) { ... }
    },
    blocking() {
      // Another tab wants a newer schema: let it upgrade instead of blocking it forever.
      db.close();
    },
  });
  return db;
}
