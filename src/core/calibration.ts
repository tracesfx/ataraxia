/**
 * Latency calibration maths. The player taps along to a click track; their offset is the median
 * of (tap time - nearest click time), ignoring taps that are clearly not aimed at a click.
 * The result is directly the `audioOffsetMs` setting: positive = the player hits late.
 */

/** Taps further than this from every click are discarded as stray. */
export const CALIBRATION_MAX_DEVIATION_MS = 150;
/** Fewer valid taps than this gives no result. */
export const CALIBRATION_MIN_TAPS = 12;
export const CALIBRATION_BPM = 120;
export const CALIBRATION_LEAD_IN_BEATS = 4;
export const CALIBRATION_BEATS = 20;

export type CalibrationResult =
  | {
      ok: true;
      /** Median deviation, rounded to whole ms: the offset to save. */
      offsetMs: number;
      /** Standard deviation of the valid deviations around their mean (ms, 1 decimal). */
      spreadMs: number;
      validTaps: number;
      discardedTaps: number;
    }
  | { ok: false; validTaps: number; discardedTaps: number };

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Signed distance from `timeMs` to the nearest of `clicksMs` (sorted). NaN with no clicks. */
export function nearestDeviation(timeMs: number, clicksMs: readonly number[]): number {
  let best = NaN;
  for (const click of clicksMs) {
    const d = timeMs - click;
    if (Number.isNaN(best) || Math.abs(d) < Math.abs(best)) best = d;
  }
  return best;
}

/**
 * Compute the player's offset from tap times and click times (both song ms, any order).
 * Every tap is compared with its nearest click; taps further than `maxDeviationMs` are dropped.
 * Needs at least `minTaps` valid taps, otherwise `ok: false` ("not enough consistent taps").
 */
export function computeCalibration(
  tapsMs: readonly number[],
  clicksMs: readonly number[],
  maxDeviationMs = CALIBRATION_MAX_DEVIATION_MS,
  minTaps = CALIBRATION_MIN_TAPS,
): CalibrationResult {
  const deviations: number[] = [];
  let discarded = 0;
  for (const tap of tapsMs) {
    const d = nearestDeviation(tap, clicksMs);
    if (Number.isFinite(d) && Math.abs(d) <= maxDeviationMs) deviations.push(d);
    else discarded += 1;
  }
  if (deviations.length < minTaps) {
    return { ok: false, validTaps: deviations.length, discardedTaps: discarded };
  }
  const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const variance = deviations.reduce((a, d) => a + (d - mean) ** 2, 0) / deviations.length;
  return {
    ok: true,
    offsetMs: Math.round(median(deviations)),
    spreadMs: Math.round(Math.sqrt(variance) * 10) / 10,
    validTaps: deviations.length,
    discardedTaps: discarded,
  };
}

/**
 * Song times of the calibration clicks: `leadInBeats` lead-in clicks then `beats` counted ones,
 * one beat apart, the first counted click at song time 0.
 */
export function calibrationClicks(
  bpm = CALIBRATION_BPM,
  leadInBeats = CALIBRATION_LEAD_IN_BEATS,
  beats = CALIBRATION_BEATS,
): { leadIn: number[]; counted: number[] } {
  const beatMs = 60_000 / bpm;
  return {
    leadIn: Array.from({ length: leadInBeats }, (_, i) => (i - leadInBeats) * beatMs),
    counted: Array.from({ length: beats }, (_, i) => i * beatMs),
  };
}
