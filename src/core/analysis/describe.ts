import type { Onset } from '../onsets';
import { mean, movingAverage, normalizeByQuantiles, quantile, slope } from './curves';
import type { RawFeatures } from './features';
import type { AnalysisOnset, Bands, BuildUp, Impact, Silence } from './types';

/**
 * Song-level descriptions from the raw frame features: the intensity curve, build-ups, impacts
 * and silences. Every threshold is relative to the song itself (percentiles), so a quiet acoustic
 * song and a loud club track both span the full 0-1 intensity range.
 */

/** Percentiles every intensity component is scaled between. */
export const NORM_LOW_Q = 0.05;
export const NORM_HIGH_Q = 0.95;

/**
 * How much each component contributes to intensity. Loudness leads; onset density and low-band
 * punch tell busy drum sections from loud pads; brightness lifts open, full-band sections.
 * Calibrated against a recorded reference chart (docs/charting-calibration.md).
 */
export const INTENSITY_WEIGHTS = {
  loudness: 0.4,
  density: 0.2,
  punch: 0.25,
  brightness: 0.15,
} as const;

/** Onsets weaker than this don't count towards onset density. */
export const DENSITY_MIN_STRENGTH = 0.1;

/** Build-up: a window of at least this many beats (two 4/4 measures)... */
export const BUILDUP_MIN_BEATS = 8;
/** ...across which smoothed (loudness + brightness) / 2 rises by at least this much... */
export const BUILDUP_MIN_RISE = 0.12;
/** ...while low-band punch stays below this or changes by less than BUILDUP_FLAT... */
export const BUILDUP_MAX_PUNCH = 0.45;
/** ...and onset density stays below this or changes by less than BUILDUP_FLAT. */
export const BUILDUP_MAX_DENSITY = 0.5;
export const BUILDUP_FLAT = 0.15;
/** A build-up carries on past its rising part while the lift stays within this of its top. */
export const BUILDUP_HOLD_DROP = 0.08;

/** Impacts: low-band or broadband flux above this song quantile... */
export const IMPACT_QUANTILE = 0.9;
/**
 * ...and this many times the level of the other hits within +-2 beats (the mean of its
 * SALIENCE_NEIGHBOURS strongest neighbouring peaks), unless right after a build-up or silence.
 */
export const IMPACT_SALIENCE = 1.35;
const SALIENCE_NEIGHBOURS = 3;
/** Weaker candidates (edge effects, barely-there accents) are not reported. */
export const IMPACT_MIN_STRENGTH = 0.15;
/** Two impacts are at least this many beats apart (the stronger wins). */
export const IMPACT_MIN_SPACING_BEATS = 1;

/** Silence: RMS this many dB under the song's loud level (95th percentile), for 250 ms or more. */
export const SILENCE_BELOW_DB = 36;
export const SILENCE_MIN_MS = 250;

const toDb = (rms: number): number => 20 * Math.log10(rms + 1e-6);

export interface Descriptions {
  loudness: Float32Array;
  brightness: Float32Array;
  bandFlux: Bands<Float32Array>;
  onsetEnvelope: Float32Array;
  onsetDensity: Float32Array;
  intensity: Float32Array;
  onsets: AnalysisOnset[];
  buildUps: BuildUp[];
  impacts: Impact[];
  silences: Silence[];
}

/** Divide by the value's 98th percentile (strong onsets about 1). */
function scaleToStrong(values: Float32Array): Float32Array {
  const p = quantile(values, 0.98);
  const out = new Float32Array(values.length);
  if (!(p > 1e-12)) return out;
  for (let i = 0; i < values.length; i++) out[i] = (values[i] as number) / p;
  return out;
}

/** Onsets per second within one beat either side of every frame. */
function densityCurve(
  onsets: readonly Onset[],
  frameCount: number,
  frameMs: number,
  beatMs: number,
): Float32Array {
  const out = new Float32Array(frameCount);
  const times = onsets.filter((o) => o.strength >= DENSITY_MIN_STRENGTH).map((o) => o.t);
  let lo = 0;
  let hi = 0;
  for (let n = 0; n < frameCount; n++) {
    const t = n * frameMs;
    while (lo < times.length && (times[lo] as number) < t - beatMs) lo += 1;
    while (hi < times.length && (times[hi] as number) <= t + beatMs) hi += 1;
    out[n] = (hi - lo) / ((2 * beatMs) / 1000);
  }
  return out;
}

export function describe(
  raw: RawFeatures,
  fineOnsets: readonly Onset[],
  beatMs: number,
): Descriptions {
  const { frameCount, frameMs } = raw;
  const beatFrames = Math.max(1, Math.round(beatMs / frameMs));

  const db = new Float32Array(frameCount);
  for (let n = 0; n < frameCount; n++) db[n] = toDb(raw.rms[n] as number);
  const loudness = normalizeByQuantiles(db, NORM_LOW_Q, NORM_HIGH_Q);
  const audible = (i: number): boolean => (raw.centroidHz[i] as number) > 0;
  const brightness = normalizeByQuantiles(raw.centroidHz, NORM_LOW_Q, NORM_HIGH_Q, audible);

  const bandFlux = {
    low: scaleToStrong(raw.flux.low),
    mid: scaleToStrong(raw.flux.mid),
    high: scaleToStrong(raw.flux.high),
  };
  const combined = new Float32Array(frameCount);
  for (let n = 0; n < frameCount; n++) {
    combined[n] =
      (raw.flux.low[n] as number) + (raw.flux.mid[n] as number) + (raw.flux.high[n] as number);
  }
  const onsetEnvelope = scaleToStrong(combined);
  const onsetDensity = densityCurve(fineOnsets, frameCount, frameMs, beatMs);

  // Intensity: song-relative components, combined, smoothed over about a beat, rescaled.
  const half = Math.round(beatFrames / 2);
  const punch = normalizeByQuantiles(movingAverage(bandFlux.low, half), NORM_LOW_Q, NORM_HIGH_Q);
  const density = normalizeByQuantiles(onsetDensity, NORM_LOW_Q, NORM_HIGH_Q);
  const w = INTENSITY_WEIGHTS;
  const mix = new Float32Array(frameCount);
  for (let n = 0; n < frameCount; n++) {
    mix[n] =
      w.loudness * (loudness[n] as number) +
      w.density * (density[n] as number) +
      w.punch * (punch[n] as number) +
      w.brightness * (brightness[n] as number);
  }
  const intensity = normalizeByQuantiles(movingAverage(mix, half), NORM_LOW_Q, NORM_HIGH_Q);

  const silences = findSilences(db, frameMs);
  const buildUps = findBuildUps(loudness, brightness, punch, density, frameMs, beatFrames);
  const impacts = findImpacts(
    bandFlux.low,
    onsetEnvelope,
    db,
    fineOnsets,
    buildUps,
    silences,
    frameMs,
    beatFrames,
  );
  const onsets = fineOnsets.map((o) => describeOnset(o, bandFlux, frameMs));
  return {
    loudness,
    brightness,
    bandFlux,
    onsetEnvelope,
    onsetDensity,
    intensity,
    onsets,
    buildUps,
    impacts,
    silences,
  };
}

/** An onset's band make-up: each band's strongest flux within one frame of it. */
function describeOnset(o: Onset, flux: Bands<Float32Array>, frameMs: number): AnalysisOnset {
  const n = Math.round(o.t / frameMs);
  const peak = (curve: Float32Array): number => {
    let m = 0;
    for (let k = n - 1; k <= n + 1; k++) m = Math.max(m, curve[k] ?? 0);
    return m;
  };
  const low = peak(flux.low);
  const mid = peak(flux.mid);
  const high = peak(flux.high);
  const top = Math.max(low, mid, high);
  const broadband = top > 0 ? (low + mid + high - top) / (2 * top) : 0;
  return { t: o.t, strength: o.strength, low, mid, high, broadband };
}

/** Runs of frames quieter than SILENCE_BELOW_DB under the song's loud level. */
export function findSilences(db: Float32Array, frameMs: number): Silence[] {
  const loud = quantile(db, 0.95);
  const threshold = Math.max(-60, loud - SILENCE_BELOW_DB);
  const out: Silence[] = [];
  let start = -1;
  for (let n = 0; n <= db.length; n++) {
    const quiet = n < db.length && (db[n] as number) < threshold;
    if (quiet && start < 0) start = n;
    if (!quiet && start >= 0) {
      if ((n - start) * frameMs >= SILENCE_MIN_MS) {
        out.push({ startMs: start * frameMs, endMs: n * frameMs });
      }
      start = -1;
    }
  }
  return out;
}

/**
 * Build-ups: windows of BUILDUP_MIN_BEATS where (loudness + brightness) / 2 rises steadily
 * while punch and onset density stay low or flat. Overlapping windows merge into one section.
 */
export function findBuildUps(
  loudness: Float32Array,
  brightness: Float32Array,
  punch: Float32Array,
  density: Float32Array,
  frameMs: number,
  beatFrames: number,
): BuildUp[] {
  const n = loudness.length;
  const measureHalf = beatFrames * 2;
  const lift = new Float32Array(n);
  for (let i = 0; i < n; i++) lift[i] = ((loudness[i] as number) + (brightness[i] as number)) / 2;
  const smoothLift = movingAverage(lift, measureHalf);
  const smoothPunch = movingAverage(punch, measureHalf);
  const smoothDensity = movingAverage(density, measureHalf);
  const win = BUILDUP_MIN_BEATS * beatFrames;
  const marked = new Uint8Array(n);
  // Check every half beat.
  const stride = Math.max(1, Math.round(beatFrames / 2));
  for (let end = win; end < n; end += stride) {
    const from = end - win;
    const rise = slope(smoothLift, from, end) * win;
    if (rise < BUILDUP_MIN_RISE) continue;
    const punchOk =
      mean(smoothPunch, from, end) <= BUILDUP_MAX_PUNCH ||
      Math.abs(slope(smoothPunch, from, end) * win) <= BUILDUP_FLAT;
    const densityOk =
      mean(smoothDensity, from, end) <= BUILDUP_MAX_DENSITY ||
      Math.abs(slope(smoothDensity, from, end) * win) <= BUILDUP_FLAT;
    // Punch rising as fast as the lift means the drums are already in: not a build-up.
    const punchRise = slope(smoothPunch, from, end) * win;
    if (!punchOk || !densityOk || punchRise > rise) continue;
    for (let k = from; k <= end; k++) marked[k] = 1;
  }
  const out: BuildUp[] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && marked[i] === 1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      // A riser often flattens out before the drop: carry the build-up on while the lift
      // holds and the drums stay out (beat-smoothed punch still low).
      let end = i - 1;
      const held = (smoothLift[end] as number) - BUILDUP_HOLD_DROP;
      while (
        end + 1 < n &&
        (smoothLift[end + 1] as number) >= held &&
        (punch[end + 1] as number) <= BUILDUP_MAX_PUNCH
      ) {
        end += 1;
      }
      i = Math.max(i, end + 1);
      if (end - start >= win) {
        const rise = (smoothLift[end] as number) - (smoothLift[start] as number);
        out.push({
          startMs: start * frameMs,
          endMs: end * frameMs,
          rise: Math.min(1, Math.max(0, rise / 0.5)),
        });
      }
      start = -1;
    }
  }
  return out;
}

/**
 * Impacts: local peaks of low-band or broadband flux above the song's IMPACT_QUANTILE that also
 * stand out from the 2 beats around them (or come right after a build-up or silence).
 */
export function findImpacts(
  lowFlux: Float32Array,
  broadFlux: Float32Array,
  db: Float32Array,
  onsets: readonly Onset[],
  buildUps: readonly BuildUp[],
  silences: readonly Silence[],
  frameMs: number,
  beatFrames: number,
): Impact[] {
  const n = lowFlux.length;
  if (n === 0) return [];
  const active = (i: number): boolean => (broadFlux[i] as number) > 0.02;
  const lowQ = Math.max(1e-6, quantile(lowFlux, IMPACT_QUANTILE, active));
  const broadQ = Math.max(1e-6, quantile(broadFlux, IMPACT_QUANTILE, active));
  const lowTop = Math.max(lowQ * 1.01, quantile(lowFlux, 0.995, active));
  const broadTop = Math.max(broadQ * 1.01, quantile(broadFlux, 0.995, active));
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ratio[i] = Math.max((lowFlux[i] as number) / lowQ, (broadFlux[i] as number) / broadQ);
  }
  const beatMs = beatFrames * frameMs;
  const peakHalf = Math.max(1, Math.round(beatFrames / 4));
  const around = beatFrames * 2;
  const candidates: Impact[] = [];
  for (let i = 1; i < n - 1; i++) {
    const r = ratio[i] as number;
    if (r < 1) continue;
    let isPeak = true;
    for (let k = Math.max(0, i - peakHalf); k <= Math.min(n - 1, i + peakHalf) && isPeak; k++) {
      const v = ratio[k] as number;
      if (k < i ? v >= r : k > i && v > r) isPeak = false;
    }
    if (!isPeak) continue;
    const t = i * frameMs;
    const afterBuildUp = buildUps.some((b) => t >= b.endMs - beatMs && t <= b.endMs + 2 * beatMs);
    // After silence: a silence ending within a beat before, or a whole beat before it much
    // quieter (its loudest frame, so staccato drums with gaps between hits don't count).
    let quietBefore = -Infinity;
    for (let k = Math.max(0, i - beatFrames); k <= i - 3; k++)
      quietBefore = Math.max(quietBefore, db[k] as number);
    if (!Number.isFinite(quietBefore)) quietBefore = 0;
    const loudAfter = mean(db, i, i + Math.round(beatFrames / 2));
    const afterSilence =
      silences.some((s) => s.endMs <= t + frameMs && t - s.endMs <= beatMs) ||
      loudAfter - quietBefore >= 15;
    // Salience: against the other hits around it (the mean of the strongest neighbouring peaks),
    // so a steady kick on every beat is not an impact but an accent above it is.
    const neighbours: number[] = [];
    for (let k = Math.max(1, i - around); k <= Math.min(n - 2, i + around); k++) {
      if (Math.abs(k - i) <= peakHalf) continue;
      const v = ratio[k] as number;
      if (v >= (ratio[k - 1] as number) && v > (ratio[k + 1] as number)) neighbours.push(v);
    }
    neighbours.sort((a, b) => b - a);
    const top = neighbours.slice(0, SALIENCE_NEIGHBOURS);
    const level0 = top.length > 0 ? top.reduce((s, v) => s + v, 0) / top.length : 0;
    const salience = r / Math.max(0.3, level0);
    if (salience < IMPACT_SALIENCE && !afterBuildUp && !afterSilence) continue;
    const lowShare = (lowFlux[i] as number) / lowQ;
    const level = Math.min(
      1,
      Math.max(
        ((lowFlux[i] as number) - lowQ) / (lowTop - lowQ),
        ((broadFlux[i] as number) - broadQ) / (broadTop - broadQ),
      ),
    );
    const strength = Math.min(
      1,
      0.45 * Math.max(0, level) +
        0.35 * Math.min(1, (salience - 1) / 1.5) +
        (afterBuildUp ? 0.25 : 0) +
        (afterSilence ? 0.15 : 0),
    );
    // Use the precise onset time when the onset detector has one nearby.
    let best: Onset | null = null;
    for (const o of onsets) {
      if (Math.abs(o.t - t) > 2 * frameMs) continue;
      if (!best || o.strength > best.strength) best = o;
    }
    if (strength < IMPACT_MIN_STRENGTH) continue;
    candidates.push({
      t: best ? best.t : t,
      strength,
      kind: afterBuildUp || afterSilence ? 'drop' : 'hit',
      afterBuildUp,
      afterSilence,
      lowHeavy: lowShare >= (broadFlux[i] as number) / broadQ,
    });
  }
  // Keep the strongest in each beat-wide neighbourhood.
  const spacing = IMPACT_MIN_SPACING_BEATS * beatMs;
  const kept: Impact[] = [];
  for (const c of [...candidates].sort((a, b) => b.strength - a.strength || a.t - b.t)) {
    if (kept.some((k) => Math.abs(k.t - c.t) < spacing)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.t - b.t);
}
