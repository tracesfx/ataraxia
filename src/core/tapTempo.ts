/** Taps averaged by tap tempo; 8 taps give 7 intervals. */
export const TAP_TEMPO_WINDOW = 8;
/** A pause longer than this starts a new measurement. */
export const TAP_TEMPO_RESET_MS = 2000;

/**
 * Tap tempo: the BPM from the average interval between the last few taps. Times are in ms on
 * any steady clock (event timestamps or song time); only differences matter.
 */
export class TapTempo {
  private readonly taps: number[] = [];

  constructor(
    readonly windowSize = TAP_TEMPO_WINDOW,
    readonly resetAfterMs = TAP_TEMPO_RESET_MS,
  ) {
    if (!Number.isInteger(windowSize) || windowSize < 2) {
      throw new RangeError(`Tap window must be a whole number >= 2, got ${windowSize}`);
    }
  }

  /** Record a tap. Returns the BPM so far, or null after the first tap of a measurement. */
  tap(timeMs: number): number | null {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && (timeMs - last > this.resetAfterMs || timeMs <= last)) {
      this.taps.length = 0;
    }
    this.taps.push(timeMs);
    if (this.taps.length > this.windowSize) this.taps.shift();
    return this.bpm;
  }

  reset(): void {
    this.taps.length = 0;
  }

  /** Taps in the current measurement (at most the window size). */
  get count(): number {
    return this.taps.length;
  }

  /** BPM from the taps in the window, or null with fewer than two taps. */
  get bpm(): number | null {
    const n = this.taps.length;
    if (n < 2) return null;
    const first = this.taps[0] as number;
    const last = this.taps[n - 1] as number;
    // Mean interval = total span / number of intervals.
    return (60000 * (n - 1)) / (last - first);
  }
}
