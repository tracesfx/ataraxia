import { meanOver, pearson, quantile, type AudioAnalysis } from '../../core/analysis';
import type { Note } from '../../core/chart';
import { beatLengthMs } from '../../core/time';
import { contrastOf, countIn, hitTimes, smoothSeries, windowNps } from './metrics';

/**
 * Compare a generated chart with a reference chart of the same song through smoothed, robust
 * statistics only (the reference is a recording of a player's inputs, with jitter and mistakes,
 * so individual note positions are never fitted): density curves over 4-beat windows, the
 * loud-to-quiet density ratio, and which onset strengths the reference charted. Used by
 * scripts/calibrate-charting.mjs and the calibration tests.
 */

export const CALIBRATION_WINDOW_BEATS = 4;
/** Windows each side for smoothing the density curves before correlating them. */
export const CALIBRATION_SMOOTH = 1;
/** A reference note "charts" an onset within this distance. */
export const MATCH_MS = 60;

export interface ChartDensity {
  /** Mean notes per second over the compared range. */
  meanNps: number;
  /** Notes per second in the loudest 30% of windows over the quietest 30%. */
  loudQuietRatio: number;
  /** Densest 10% of windows over the quietest 30%. */
  contrast: number;
}

export interface CalibrationReport {
  bpm: number;
  offsetMs: number;
  windowMs: number;
  range: { startMs: number; endMs: number };
  windows: number;
  /** Pearson correlation of the smoothed density curves. */
  correlation: number;
  reference: ChartDensity;
  generated: ChartDensity;
  /** generated.loudQuietRatio / reference.loudQuietRatio - 1. */
  ratioError: number;
  /** Reference notes near a detected onset, and those onsets' strength percentiles. */
  charted: {
    matchedShare: number;
    percentiles: { p10: number; p25: number; p50: number; p75: number };
    /** Share of the song's onsets in each strength decile that the reference charted. */
    byDecile: number[];
  };
  /** Reference density against intensity: mean nps of the windows in each intensity fifth. */
  byIntensity: { intensity: number; referenceNps: number; generatedNps: number }[];
  /** Per-window values for plotting. */
  series: {
    startMs: number;
    intensity: number;
    loudness: number;
    reference: number;
    generated: number;
  }[];
}

type CalibrationAnalysis = Pick<
  AudioAnalysis,
  'frameMs' | 'frameOffsetMs' | 'frameCount' | 'intensity' | 'loudness' | 'onsets'
>;

function density(nps: readonly number[], loudness: readonly number[]): ChartDensity {
  const order = loudness.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const k = Math.max(1, Math.round(order.length * 0.3));
  const avg = (idx: { i: number }[]): number =>
    idx.reduce((s, o) => s + (nps[o.i] as number), 0) / Math.max(1, idx.length);
  const quiet = avg(order.slice(0, k));
  const loud = avg(order.slice(order.length - k));
  return {
    meanNps: nps.reduce((s, v) => s + v, 0) / Math.max(1, nps.length),
    loudQuietRatio: quiet > 0 ? loud / quiet : loud > 0 ? Infinity : 1,
    contrast: contrastOf(nps).ratio,
  };
}

/**
 * Compare `generated` with `reference` over the reference's span (first to last note), in
 * 4-beat windows of the given tempo.
 */
export function compareCharts(
  analysis: CalibrationAnalysis,
  reference: readonly Note[],
  generated: readonly Note[],
  bpm: number,
  offsetMs: number,
): CalibrationReport {
  const refTimes = hitTimes(reference);
  const genTimes = hitTimes(generated);
  const windowMs = beatLengthMs(bpm) * CALIBRATION_WINDOW_BEATS;
  const startMs = Math.max(0, refTimes[0] ?? 0);
  const endMs = refTimes[refTimes.length - 1] ?? startMs;
  const refNps = windowNps(refTimes, startMs, endMs, windowMs);
  const genNps = windowNps(genTimes, startMs, endMs, windowMs);
  const starts = refNps.map((_, i) => startMs + i * windowMs);
  const intensity = starts.map((s) =>
    meanOver(analysis, analysis.intensity, s, Math.min(endMs, s + windowMs)),
  );
  const loudness = starts.map((s) =>
    meanOver(analysis, analysis.loudness, s, Math.min(endMs, s + windowMs)),
  );
  const correlation = pearson(
    smoothSeries(refNps, CALIBRATION_SMOOTH),
    smoothSeries(genNps, CALIBRATION_SMOOTH),
  );
  const ref = density(refNps, loudness);
  const gen = density(genNps, loudness);

  // Which onsets the reference charted.
  const strengths = analysis.onsets.map((o) => o.strength);
  const sorted = [...strengths].sort((a, b) => a - b);
  const percentileOf = (s: number): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] as number) < s) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length > 0 ? lo / sorted.length : 0;
  };
  const onsetTimes = analysis.onsets.map((o) => o.t);
  const matched: number[] = [];
  for (const t of refTimes) {
    let best = -1;
    for (let i = 0; i < onsetTimes.length; i++) {
      const d = Math.abs((onsetTimes[i] as number) - t);
      if (d <= MATCH_MS && (best < 0 || d < Math.abs((onsetTimes[best] as number) - t))) best = i;
    }
    if (best >= 0) matched.push(percentileOf(strengths[best] as number));
  }
  const deciles = Array.from({ length: 10 }, () => ({ charted: 0, total: 0 }));
  for (const o of analysis.onsets) {
    if (o.t < startMs || o.t > endMs) continue;
    const d = deciles[Math.min(9, Math.floor(percentileOf(o.strength) * 10))] as {
      charted: number;
      total: number;
    };
    d.total += 1;
    if (countIn(refTimes, o.t - MATCH_MS, o.t + MATCH_MS + 1) > 0) d.charted += 1;
  }

  // Density by intensity fifths.
  const byIntensity = [0, 1, 2, 3, 4].map((q) => {
    const lo = quantile(intensity, q / 5);
    const hi = quantile(intensity, (q + 1) / 5);
    const idx = intensity
      .map((v, i) => ({ v, i }))
      .filter((o) => (q === 4 ? o.v >= lo && o.v <= hi : o.v >= lo && o.v < hi));
    const avg = (xs: readonly number[]): number =>
      idx.reduce((s, o) => s + (xs[o.i] as number), 0) / Math.max(1, idx.length);
    return { intensity: (lo + hi) / 2, referenceNps: avg(refNps), generatedNps: avg(genNps) };
  });

  return {
    bpm,
    offsetMs,
    windowMs,
    range: { startMs, endMs },
    windows: refNps.length,
    correlation,
    reference: ref,
    generated: gen,
    ratioError: gen.loudQuietRatio / ref.loudQuietRatio - 1,
    charted: {
      matchedShare: refTimes.length > 0 ? matched.length / refTimes.length : 0,
      percentiles: {
        p10: quantile(matched, 0.1),
        p25: quantile(matched, 0.25),
        p50: quantile(matched, 0.5),
        p75: quantile(matched, 0.75),
      },
      byDecile: deciles.map((d) => (d.total > 0 ? d.charted / d.total : 0)),
    },
    byIntensity,
    series: starts.map((s, i) => ({
      startMs: s,
      intensity: intensity[i] as number,
      loudness: loudness[i] as number,
      reference: refNps[i] as number,
      generated: genNps[i] as number,
    })),
  };
}
