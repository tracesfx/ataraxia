import type { Chart } from '../core/chart';
import type { PlayResult } from '../core/results';
import type { CoverRef } from '../library/songLibrary';

/**
 * Scene ids and the parameters each scene's enter() receives.
 *
 * `studio` and `editor` are Studio-only: they are registered by src/studio (through
 * src/app/studio-entry.ts) and never exist in the player build. Their params are plain data
 * declared here so shared code (the game's playtest return) can name them without importing
 * src/studio.
 */
export interface SceneParams {
  menu: undefined;
  /** Optionally reselect a song and chart (e.g. when coming back from a game). */
  songSelect: SongSelectParams;
  game: GameParams;
  settings: { returnTo: SettingsReturn };
  /** Opened from settings; goes back to settings (with the same `returnTo`) when done. */
  calibration: { returnTo: SettingsReturn };
  results: ResultsParams;
  /** Studio home: the creator's library (Studio build only). */
  studio: SongSelectParams;
  /** Chart editor (Studio build only). */
  editor: EditorParams;
}

export interface SongSelectParams {
  songId?: string;
  chartId?: string;
}

/** Where the settings screen goes back to. */
export type SettingsReturn =
  | { scene: 'menu' }
  | { scene: 'songSelect'; select: SongSelectParams }
  | { scene: 'studio'; select: SongSelectParams };

export interface ResultsParams {
  /** The play that finished: Retry starts it again. */
  game: GameParams;
  result: PlayResult;
  chartInfo: {
    title: string;
    artist: string;
    difficulty: string;
    level: number;
    /** The song's custom cover, or null for the placeholder. */
    cover: CoverRef | null;
  };
  /** Save as personal best if it beats the stored one (only full plays in "play" mode). */
  save: boolean;
}

/** Practice mode settings for a game (see src/core/practice.ts). */
export interface PracticeParams {
  /** Playback speed, 0.5-1 in 0.05 steps. */
  rate: number;
}

export interface EditorParams {
  songId: string;
  chartId: string;
  /**
   * Coming back from a playtest: carry on with this editor state (notes, undo history,
   * selection, playhead and zoom) instead of loading the chart from the library again. Opaque
   * here; only the Studio editor knows (and checks) its type.
   */
  resume?: unknown;
}

/**
 * How a game runs:
 * - `play`: a normal play; a full play saves the personal best.
 * - `practice`: slowed playback and A-B loops (`practice`); no results and no saved score.
 * - `playtest`: a Studio test run (`returnTo`); never saved, goes back to Studio afterwards.
 */
export type GameMode = 'play' | 'practice' | 'playtest';

/** Where a playtest goes back to: the editor (with its state) or Studio home. */
export type PlaytestReturn =
  { scene: 'editor'; params: EditorParams } | { scene: 'studio'; params: SongSelectParams };

export interface GameParams {
  mode: GameMode;
  songId: string;
  chartId: string;
  /**
   * Start from this song time ("playtest from here"; may be negative). Notes before it are left
   * out of play and scoring, and play runs in for the player's "Run-in time" setting before it.
   * Default: a play from the beginning, which starts at the chart's effective start
   * (`effectiveStartMs`) with every note judged.
   */
  startTimeMs?: number;
  /** Play this chart instead of loading it from the library (the editor's unsaved chart). */
  chart?: Chart;
  /** Playtest only: where Esc and the end of play go back to. */
  returnTo?: PlaytestReturn;
  /** Practice only: the playback speed to start with. */
  practice?: PracticeParams;
}
