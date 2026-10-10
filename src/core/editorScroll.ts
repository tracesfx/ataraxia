import { clampZoom } from './timeline';

/**
 * Smooth scrolling and zooming for the editor timeline. The editor keeps a target (where the
 * playhead and zoom are going: the editor state) and a displayed position that follows it with
 * frame-rate independent exponential smoothing, so wheel, key and zoom motion is continuous
 * whatever the display refresh rate. Wheel input is normalised to screen pixels first, so one
 * mouse notch moves the view the same distance on screen at any zoom.
 */

/** Screen pixels one mouse-wheel notch scrolls, at any zoom. */
export const NOTCH_PX = 80;
/** Shift+wheel scrolls this fraction of the normal distance. */
export const FINE_SCROLL_FACTOR = 0.25;
/** Pixel-mode wheel deltas at least this large come from a mouse wheel (one or more notches). */
export const NOTCH_DETECT_PX = 50;
/** A mouse notch in pixel mode is about this many pixels (Chromium, Edge, Safari). */
const PIXELS_PER_NOTCH = 100;
/** Browsers report about this many lines per notch in line mode (Firefox). */
const LINES_PER_NOTCH = 3;

/** Time constant of wheel scrolling and zooming. */
export const SCROLL_TAU_MS = 70;
/** Time constant of key steps: about 95 % of the way after 90 ms. */
export const GLIDE_TAU_MS = 30;
/** Zoom change per normalised wheel pixel (one notch is about 11 %). */
export const ZOOM_PER_PX = 0.0015;
/** The displayed position counts as arrived when it is this close on screen (CSS px). */
export const SETTLE_PX = 0.02;

/** WheelEvent.deltaMode values. */
export const DELTA_PIXEL = 0;
export const DELTA_LINE = 1;
export const DELTA_PAGE = 2;

/**
 * A wheel delta as screen pixels. Mouse notches (line or page mode, or large pixel deltas) count
 * as NOTCH_PX each, whatever the browser reports per notch; small pixel deltas (trackpads,
 * precision touchpads) pass through 1:1. Positive = wheel down / toward the user.
 */
export function normalizeWheel(delta: number, deltaMode: number, pageHeightPx: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const sign = Math.sign(delta);
  const size = Math.abs(delta);
  if (deltaMode === DELTA_PAGE) return delta * Math.max(0, pageHeightPx);
  if (deltaMode === DELTA_LINE) {
    return sign * Math.max(1, Math.round(size / LINES_PER_NOTCH)) * NOTCH_PX;
  }
  if (size >= NOTCH_DETECT_PX) {
    return sign * Math.max(1, Math.round(size / PIXELS_PER_NOTCH)) * NOTCH_PX;
  }
  return delta;
}

export interface WheelScrollOptions {
  /** Shift held: fine scroll. */
  fine?: boolean;
  /** The "Invert scroll" setting. */
  invert?: boolean;
}

/**
 * Song time a normalised wheel movement scrolls at zoom `pxPerMs`. Wheel up (negative) moves
 * later in the song, unless inverted. The result in screen pixels (time x zoom) is the same at
 * every zoom.
 */
export function wheelScrollMs(px: number, pxPerMs: number, o: WheelScrollOptions = {}): number {
  if (!(pxPerMs > 0)) return 0;
  const factor = (o.fine ? FINE_SCROLL_FACTOR : 1) * (o.invert ? 1 : -1);
  return (px * factor) / pxPerMs + 0;
}

/** The zoom a normalised Ctrl+wheel movement leads to (wheel up zooms in), clamped. */
export function wheelZoomTarget(pxPerMs: number, px: number): number {
  return clampZoom(pxPerMs * Math.exp(-px * ZOOM_PER_PX));
}

/**
 * One step of exponential smoothing: where a value moving toward `target` with time constant
 * `tauMs` is after `dtMs`. Exact for any step size, so many small steps land where one large step
 * does (frame-rate independent). tau <= 0 jumps straight to the target.
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return target;
  if (!(dtMs > 0)) return current;
  return target + (current - target) * Math.exp(-dtMs / tauMs);
}

/** `approach` in log space, for zoom: equal ratios take equal time. Both values must be > 0. */
export function approachLog(current: number, target: number, dtMs: number, tauMs: number): number {
  return Math.exp(approach(Math.log(current), Math.log(target), dtMs, tauMs));
}

/**
 * The time at the playhead that keeps song time `anchorMs` `offsetPx` pixels above the playhead
 * at zoom `pxPerMs` (zooming around the pointer instead of the playhead).
 */
export function anchoredTimeMs(anchorMs: number, offsetPx: number, pxPerMs: number): number {
  return anchorMs - offsetPx / pxPerMs;
}

/**
 * The displayed view of the timeline: time at the playhead and zoom, smoothed toward the
 * editor's target each frame. Pure (no clock of its own): the caller passes the frame time.
 */
export class SmoothView {
  timeMs: number;
  pxPerMs: number;
  /** While zooming around the pointer: the song time kept under it, and its height. */
  private anchor: { ms: number; offsetPx: number } | null = null;

  constructor(timeMs: number, pxPerMs: number) {
    this.timeMs = timeMs;
    this.pxPerMs = pxPerMs;
  }

  /** Show exactly this position and zoom now (no animation). */
  jump(timeMs: number, pxPerMs = this.pxPerMs): void {
    this.timeMs = timeMs;
    this.pxPerMs = pxPerMs;
    this.anchor = null;
  }

  /**
   * Keep song time `ms`, `offsetPx` above the playhead, fixed on screen while the zoom animates.
   * The caller moves the target time to `anchoredTimeMs(ms, offsetPx, targetZoom)`.
   */
  anchorZoom(ms: number, offsetPx: number): void {
    this.anchor = { ms, offsetPx };
  }

  get zoomAnchored(): boolean {
    return this.anchor !== null;
  }

  /**
   * Advance by `dtMs` toward the target. Returns true while still moving. Scrolling elsewhere
   * during an anchored zoom (the target no longer matches the anchor) drops the anchor.
   */
  step(
    dtMs: number,
    targetMs: number,
    targetPxPerMs: number,
    tauMs: number,
    zoomTauMs = SCROLL_TAU_MS,
  ): boolean {
    let zoom = approachLog(this.pxPerMs, targetPxPerMs, dtMs, zoomTauMs);
    if (Math.abs(Math.log(zoom / targetPxPerMs)) < 1e-4) zoom = targetPxPerMs;
    this.pxPerMs = zoom;

    const anchor = this.anchor;
    if (anchor) {
      const arrival = anchoredTimeMs(anchor.ms, anchor.offsetPx, targetPxPerMs);
      if (Math.abs(arrival - targetMs) * targetPxPerMs > 0.5) this.anchor = null;
    }
    if (this.anchor) {
      this.timeMs = anchoredTimeMs(this.anchor.ms, this.anchor.offsetPx, zoom);
      if (zoom === targetPxPerMs) {
        this.timeMs = targetMs;
        this.anchor = null;
      }
    } else {
      this.timeMs = approach(this.timeMs, targetMs, dtMs, tauMs);
    }
    if (Math.abs(this.timeMs - targetMs) * zoom < SETTLE_PX) this.timeMs = targetMs;
    return this.timeMs !== targetMs || this.pxPerMs !== targetPxPerMs;
  }
}

/** True when scrolling has been idle long enough to ease onto the grid ("Snap on scroll stop"). */
export function scrollStopped(nowMs: number, lastScrollMs: number | null, idleMs: number): boolean {
  return lastScrollMs !== null && nowMs - lastScrollMs >= idleMs;
}
