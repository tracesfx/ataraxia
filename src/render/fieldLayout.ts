import { LANE_COUNT } from '../core/constants';
import { DEFAULT_SCROLL_SPEED } from '../core/settings';

/**
 * Gameplay geometry in logical pixels. Sprite sizes are fixed; vertical positions are fractions
 * of the logical height H (the hit line at 0.85 H), and everything snaps to whole pixels. Pure,
 * so it can be unit tested; the renderer recomputes it whenever the pixel grid changes.
 */
export const LANE_W = 64;
export const FIELD_W = LANE_W * LANE_COUNT;
export const NOTE_W = 60;
export const NOTE_H = 16;
/** Hold body width (centred in the lane) and its cap height. */
export const HOLD_W = 44;
export const HOLD_CAP_H = 6;
/** The judgement line: two rows, the hit line and the row above it (bright top, dim bottom). */
export const JUDGE_LINE_H = 2;
export const RAIL_W = 3;
export const PROGRESS_H = 4;
/** Fraction of the height where the hit line sits. */
export const HIT_LINE_FRACTION = 0.85;
/** Fraction of the height for the top of the combo digits. */
export const COMBO_FRACTION = 0.5;
/** Rows between the hit line and the judgement text's baseline. */
export const JUDGEMENT_LIFT_PX = 24;
/** Margin of the HUD from the window edges. */
export const HUD_MARGIN = 12;

/** Travel time from the top of the screen to the hit line at the default scroll speed. */
export const REFERENCE_TRAVEL_MS = 660;

export interface FieldLayout {
  width: number;
  height: number;
  /** Left edge of lane 0. */
  fieldX: number;
  /** A note's centre is on this row at its time. */
  hitLineY: number;
  /** Notes are clipped below this row (above the progress labels). */
  noteClipBottom: number;
  /** Top of the cap height of the combo digits. */
  comboY: number;
  /** Baseline of the judgement text (descenders go below, never down to the hit line). */
  judgementY: number;
  /** Top of the progress bar (it runs to the bottom edge). */
  progressY: number;
}

export function computeFieldLayout(width: number, height: number): FieldLayout {
  const hitLineY = Math.round(height * HIT_LINE_FRACTION);
  const progressY = height - PROGRESS_H;
  return {
    width,
    height,
    fieldX: Math.floor((width - FIELD_W) / 2),
    hitLineY,
    noteClipBottom: progressY - 16,
    comboY: Math.round(height * COMBO_FRACTION),
    judgementY: hitLineY - JUDGEMENT_LIFT_PX,
    progressY,
  };
}

export function laneX(l: FieldLayout, lane: number): number {
  return l.fieldX + lane * LANE_W;
}

export function laneCenterX(l: FieldLayout, lane: number): number {
  return l.fieldX + lane * LANE_W + LANE_W / 2;
}

/** Left edge of a note sprite in its lane. */
export function noteX(l: FieldLayout, lane: number): number {
  return l.fieldX + lane * LANE_W + (LANE_W - NOTE_W) / 2;
}

/**
 * Scroll speed in logical px per ms of song time for the friendly setting: the default setting
 * takes REFERENCE_TRAVEL_MS from the top of the screen to the hit line at any window size, and
 * other settings scale proportionally.
 */
export function scrollPxPerMs(setting: number, hitLineY: number): number {
  return (hitLineY / REFERENCE_TRAVEL_MS) * (setting / DEFAULT_SCROLL_SPEED);
}

/** Fraction 0..1 of the song played (clamped; 0 for an unknown duration). */
export function progressFraction(songTimeMs: number, durationMs: number): number {
  if (!(durationMs > 0) || !Number.isFinite(songTimeMs)) return 0;
  return Math.min(1, Math.max(0, songTimeMs / durationMs));
}

/** Width in whole pixels of the progress fill for a bar `barWidth` wide. */
export function progressFillWidth(
  songTimeMs: number,
  durationMs: number,
  barWidth: number,
): number {
  return Math.floor(progressFraction(songTimeMs, durationMs) * barWidth);
}

/** Column of a song time on the progress bar (for the practice loop markers). */
export function progressMarkerX(timeMs: number, durationMs: number, barWidth: number): number {
  return Math.min(barWidth - 1, progressFillWidth(timeMs, durationMs, barWidth));
}
