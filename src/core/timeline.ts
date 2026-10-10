import { MIN_NOTE_TIME_MS } from './chart';

/**
 * Pixel <-> time mapping for the editor's vertical timeline. Like gameplay, later times are
 * higher up: the playhead sits at a fixed y and future time extends upward. Units are CSS
 * pixels; renderers multiply by devicePixelRatio themselves.
 */

/** Zoom limits in pixels per millisecond: 20 px per second up to 3 px per ms. */
export const MIN_PX_PER_MS = 0.02;
export const MAX_PX_PER_MS = 3;
export const DEFAULT_PX_PER_MS = 0.3;

/** The editor timeline goes this far past the end of the audio. */
export const TIMELINE_END_PAD_MS = 10_000;

/** A range of song time, earliest to latest. */
export interface TimeSpan {
  startMs: number;
  endMs: number;
}

/**
 * Where the editor's playhead, view and overview can go: from as early as notes may be (30 s
 * before the audio begins) to TIMELINE_END_PAD_MS past its end.
 */
export function editorSpan(durationMs: number): TimeSpan {
  return { startMs: MIN_NOTE_TIME_MS, endMs: Math.max(0, durationMs) + TIMELINE_END_PAD_MS };
}

export function clampToSpan(ms: number, span: TimeSpan): number {
  return Math.min(span.endMs, Math.max(span.startMs, ms));
}

export interface TimelineView {
  /** Zoom: pixels per millisecond of song time. */
  pxPerMs: number;
  /** Screen y of the playhead line. */
  playheadY: number;
  /** Height of the view in pixels. */
  heightPx: number;
}

/** Screen y of song time `ms` when the playhead is at `playheadMs`. */
export function timeToY(ms: number, playheadMs: number, view: TimelineView): number {
  return view.playheadY - (ms - playheadMs) * view.pxPerMs;
}

/** Song time shown at screen y (inverse of timeToY). */
export function yToTime(y: number, playheadMs: number, view: TimelineView): number {
  return playheadMs + (view.playheadY - y) / view.pxPerMs;
}

/** Song time range visible in the view: bottom edge (earliest) to top edge (latest). */
export function visibleRange(
  playheadMs: number,
  view: TimelineView,
): { startMs: number; endMs: number } {
  return { startMs: yToTime(view.heightPx, playheadMs, view), endMs: yToTime(0, playheadMs, view) };
}

export function clampZoom(pxPerMs: number): number {
  if (!Number.isFinite(pxPerMs)) return DEFAULT_PX_PER_MS;
  return Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, pxPerMs));
}

/**
 * Zoom by `factor` keeping the song time at screen y `anchorY` in place. Returns the new zoom
 * and the playhead time that achieves it. With anchorY = the playhead's y the playhead time is
 * unchanged, which is how the editor zooms.
 */
export function zoomAround(
  view: TimelineView,
  playheadMs: number,
  factor: number,
  anchorY: number,
): { pxPerMs: number; playheadMs: number } {
  const anchorMs = yToTime(anchorY, playheadMs, view);
  const pxPerMs = clampZoom(view.pxPerMs * factor);
  // Solve timeToY(anchorMs, newPlayhead, newView) = anchorY for newPlayhead.
  const newPlayheadMs = anchorMs - (view.playheadY - anchorY) / pxPerMs;
  return { pxPerMs, playheadMs: newPlayheadMs };
}

/**
 * The horizontal minimap below the editor maps the editor span onto its width: the start at the
 * left edge, the end at the right.
 */
export function overviewTimeToX(ms: number, span: TimeSpan, widthPx: number): number {
  const length = span.endMs - span.startMs;
  if (length <= 0) return 0;
  return ((ms - span.startMs) / length) * widthPx;
}

/** Song time at minimap x, clamped to the span. */
export function overviewXToTime(x: number, span: TimeSpan, widthPx: number): number {
  if (widthPx <= 0) return span.startMs;
  return clampToSpan(span.startMs + (x / widthPx) * (span.endMs - span.startMs), span);
}
