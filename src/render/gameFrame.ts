import type { Judgement } from '../core/judgement';
import type { NoteRuntime } from '../core/playSession';
import type { ScoreSummary } from '../core/scoring';
import type { EffectsLevel, HudSize, JudgementStyle, ParticleSize } from '../core/settings';
import { SkinGameRenderer } from './gameRenderer';
import type { BackgroundLayer, Skin } from './skin';
import type { TimingParticles } from './timingParticles';

/**
 * Everything a game renderer needs for one frame. The gameplay scene builds this from its
 * state (mutating one object in place); renderers only draw it, so a skin can replace the art
 * without touching logic. Menus, messages and the practice panel are DOM, not part of the frame.
 */
export type GamePhase = 'loading' | 'ready' | 'playing' | 'paused' | 'results';

export interface JudgementPopup {
  judgement: Judgement;
  /** Timing error for presses (negative = early); null for misses and hold ends. */
  errorMs: number | null;
  /** True when a hold was released too early. */
  dropped: boolean;
  /** Song time since the popup appeared. */
  ageMs: number;
}

/** Combo animation triggers, timed in song ms (so they freeze while paused). */
export interface ComboFx {
  /** Time since the combo last went up, or null if it never has this run. */
  bumpAgeMs: number | null;
  /** Time since a combo of 2+ broke, or null. */
  breakAgeMs: number | null;
  /** The combo that broke (shown shaking as it fades). */
  brokenCombo: number;
}

/** Practice A-B loop marks, for the progress bar. */
export interface LoopHud {
  aMs: number | null;
  bMs: number | null;
  looping: boolean;
}

export interface GameFrame {
  phase: GamePhase;
  songTimeMs: number;
  songDurationMs: number;
  /** The scroll speed setting (friendly units); the renderer maps it to its layout. */
  scrollSetting: number;
  notes: readonly NoteRuntime[];
  heldLanes: readonly boolean[];
  /** Lane glow opacity per lane, 0 for none (see `LaneGlow`). */
  laneGlow: ArrayLike<number>;
  /** The player's lane glow strength (0-2), multiplied into `laneGlow`. */
  laneGlowStrength: number;
  score: ScoreSummary;
  popup: JudgementPopup | null;
  comboFx: ComboFx;
  /** Key labels per lane, shown under the judgement line before the song starts. */
  keyLabels: readonly string[];
  /** rAF time in ms. Cosmetic animation only; never for gameplay. */
  visualTimeMs: number;
  /** Show "early" / "late" over non-Perfect judgements (a player setting). */
  showEarlyLate: boolean;
  effects: EffectsLevel;
  /** Combo colour tiers (a player setting). */
  comboColors: boolean;
  hudSize: HudSize;
  judgementStyle: JudgementStyle;
  /** The system asks for reduced motion: no pops, shine, sparkles or rainbow animation. */
  reducedMotion: boolean;
  /** Timing particles to draw (null: none). */
  particles: TimingParticles | null;
  particleSize: ParticleSize;
  /** Practice loop marks, or null outside practice. */
  loop: LoopHud | null;
  /** Score, accuracy and progress bar (off in calibration). */
  showHud: boolean;
}

export interface GameRenderer {
  draw(ctx: CanvasRenderingContext2D, frame: GameFrame): void;
}

/** The renderer for a skin, optionally with another background layer than the skin's own. */
export function createGameRenderer(skin: Skin, background?: BackgroundLayer): GameRenderer {
  return new SkinGameRenderer(skin, background);
}
