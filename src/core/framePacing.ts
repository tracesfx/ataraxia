/**
 * Frame pacing for the gameplay frame loop (the "Frame rate" setting). Pure: the scene manager
 * feeds it frame timestamps and asks which frames to draw.
 *
 * - 'display': draw on every display refresh (requestAnimationFrame), the browser default.
 * - a number: at most that many frames per second. At or below the display's refresh rate it
 *   skips refreshes; above it, frames come from a timer instead (the browser still only shows
 *   one per refresh, but the newest one is fresher, which trims visual latency a little).
 * - 'unlimited': draw as often as the page can (timer-driven, uses the most power).
 *
 * Gameplay time never depends on this: it comes from the audio clock, and key presses are
 * judged from their event timestamps.
 */

export type FrameRateLimit = 'display' | 'unlimited' | number;

/** The numeric caps offered in settings. */
export const FRAME_RATE_CAPS = [30, 60, 90, 120, 144, 165, 240, 360, 480] as const;

export const FRAME_RATE_CHOICES: readonly FrameRateLimit[] = [
  'display',
  ...FRAME_RATE_CAPS,
  'unlimited',
];

export function isFrameRateLimit(value: unknown): value is FrameRateLimit {
  return FRAME_RATE_CHOICES.includes(value as FrameRateLimit);
}

export function frameRateLabel(limit: FrameRateLimit): string {
  if (limit === 'display') return 'Match display';
  if (limit === 'unlimited') return 'Unlimited';
  return `${limit} fps`;
}

/**
 * A frame may come this early and still count as on time (timestamps jitter): this share of
 * the interval, at most FRAME_SLACK_MAX_MS. Small enough that a 144 Hz refresh can't pass for a
 * 120 fps slot.
 */
export const FRAME_SLACK_SHARE = 0.15;
export const FRAME_SLACK_MAX_MS = 2;

/** Decides which candidate frames to draw under a frames-per-second cap. */
export class FramePacer {
  private next = -Infinity;

  /** True when a frame at `nowMs` should be drawn under a cap of `fps`. */
  due(nowMs: number, fps: number): boolean {
    if (!(fps > 0)) return true;
    const interval = 1000 / fps;
    const slack = Math.min(FRAME_SLACK_MAX_MS, interval * FRAME_SLACK_SHARE);
    if (nowMs + slack < this.next) return false;
    // On schedule: the next slot follows this one. Fell behind by more than a frame: resync.
    this.next = nowMs - this.next > interval ? nowMs + interval : this.next + interval;
    return true;
  }

  reset(): void {
    this.next = -Infinity;
  }
}

/** Estimates the display refresh rate from requestAnimationFrame timestamps (median interval). */
export class RefreshEstimator {
  private readonly intervals: number[] = [];
  private last: number | null = null;

  constructor(private readonly size = 30) {}

  add(timestampMs: number): void {
    if (this.last !== null) {
      const d = timestampMs - this.last;
      // Ignore stalls (tab in the background, long tasks).
      if (d > 0 && d < 100) {
        this.intervals.push(d);
        if (this.intervals.length > this.size) this.intervals.shift();
      }
    }
    this.last = timestampMs;
  }

  /** Refresh rate in Hz, or null before enough frames were seen. */
  get hz(): number | null {
    if (this.intervals.length < 5) return null;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    return median > 0 ? 1000 / median : null;
  }
}

/**
 * True when the limit needs timer-driven frames: 'unlimited', or a cap clearly above the display
 * rate (unknown display rate: assume 60 Hz until measured).
 */
export function needsTimer(limit: FrameRateLimit, displayHz: number | null): boolean {
  if (limit === 'display') return false;
  if (limit === 'unlimited') return true;
  return limit > (displayHz ?? 60) * 1.05;
}
