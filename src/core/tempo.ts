import { BEATS_PER_MEASURE } from './beatGrid';
import type { Onset, OnsetAnalysis } from './onsets';

/**
 * Tempo and offset estimation from detected onsets (single BPM for the whole song, matching the
 * chart format).
 *
 * 1. Coarse tempo: autocorrelation of the onset envelope. Its peaks are at lags where the
 *    rhythm repeats: the beat period and its multiples. Each peak is weighted by a preference
 *    for 80-200 BPM, which settles the usual "half or double?" ambiguity.
 * 2. Fine tempo: around the coarse value, the BPM whose beat grid best fits the onset times
 *    over the whole song (small errors add up over hundreds of beats, so this is precise).
 * 3. Offset: the grid phase that best fits the onsets, refined by the average deviation of the
 *    onsets next to grid lines, then moved to the beat of the measure with the strongest onsets.
 *
 * Grid fit: each onset's phase within the beat is scored with a comb made of the first four
 * harmonics, which rewards onsets on the beat most, then on half and quarter beats, and scores
 * random times at about zero. It is normalised so a pure click on every beat scores 1.
 */

export interface TempoCandidate {
  bpm: number;
  /** Time of beat 0 for this BPM, whole ms. */
  offsetMs: number;
  /** How well the grid fits the onsets, 0-1. */
  fit: number;
}

export interface TempoEstimate {
  /** Suggested BPM (2 decimals), or null when the audio has no usable rhythm. */
  bpm: number | null;
  offsetMs: number;
  /** 0-1: grid fit scaled down when there are few onsets. */
  confidence: number;
  /** The same grid at x2 and /2 (when in range), with their own offsets. */
  alternatives: TempoCandidate[];
  onsetCount: number;
}

/** BPM range searched; the preferred range gets full weight. */
export const MIN_SEARCH_BPM = 40;
export const MAX_SEARCH_BPM = 320;
export const PREFERRED_BPM: readonly [number, number] = [80, 200];
/** Fewer onsets than this: no estimate at all. */
export const MIN_ONSETS = 8;
/** Confidence reaches its full value from this many onsets on. */
const FULL_CONFIDENCE_ONSETS = 32;
/** Comb harmonic weights (beat, 1/2, 1/3, 1/4 of a beat period). */
const HARMONIC_WEIGHTS = [0.5, 1, 0.5, 2] as const;
const PHASE_STEPS = 96;
/** Fine search: +-this fraction around the coarse BPM, in steps of FINE_STEP_BPM. */
const FINE_RANGE = 0.03;
const FINE_STEP_BPM = 0.01;
/** A round BPM (whole or .5) is preferred when it fits at least this well relative to the best. */
const ROUND_BPM_TOLERANCE = 0.985;

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export function confidenceLevel(confidence: number): ConfidenceLevel {
  return confidence >= 0.7 ? 'high' : confidence >= 0.4 ? 'medium' : 'low';
}

/** Weight of a tempo in the coarse search: 1 inside the preferred range, falling off outside. */
export function tempoPrior(bpm: number): number {
  const [lo, hi] = PREFERRED_BPM;
  if (bpm >= lo && bpm <= hi) return 1;
  const octaves = Math.log2(bpm < lo ? lo / bpm : bpm / hi);
  return Math.exp(-(octaves * octaves) / (2 * 0.25 * 0.25));
}

/** Circular distance (ms) from `t` to the nearest line of a grid with this period and phase. */
export function gridDistance(t: number, periodMs: number, phaseMs: number): number {
  const d = (((t - phaseMs) % periodMs) + periodMs) % periodMs;
  return Math.min(d, periodMs - d);
}

/** Harmonic sums of the onset phases for one period (see the module comment). */
function harmonicSums(onsets: readonly Onset[], periodMs: number): { re: number[]; im: number[] } {
  const H = HARMONIC_WEIGHTS.length;
  const re = new Array<number>(H).fill(0);
  const im = new Array<number>(H).fill(0);
  const w = (2 * Math.PI) / periodMs;
  for (const o of onsets) {
    const c = Math.cos(w * o.t);
    const s = Math.sin(w * o.t);
    // Powers of e^(i w t) by repeated multiplication: one cos/sin per onset.
    let pr = c;
    let pi = s;
    for (let h = 0; h < H; h++) {
      re[h] = (re[h] as number) + o.strength * pr;
      im[h] = (im[h] as number) + o.strength * pi;
      const nr = pr * c - pi * s;
      pi = pr * s + pi * c;
      pr = nr;
    }
  }
  return { re, im };
}

/** Comb score at a phase (ms), from harmonic sums; not normalised. */
function combScore(
  sums: { re: number[]; im: number[] },
  periodMs: number,
  phaseMs: number,
): number {
  let score = 0;
  for (let h = 0; h < HARMONIC_WEIGHTS.length; h++) {
    const a = (2 * Math.PI * (h + 1) * phaseMs) / periodMs;
    score +=
      (HARMONIC_WEIGHTS[h] as number) *
      ((sums.re[h] as number) * Math.cos(a) + (sums.im[h] as number) * Math.sin(a));
  }
  return score;
}

const WEIGHT_SUM = HARMONIC_WEIGHTS.reduce((s, w) => s + w, 0);

function totalStrength(onsets: readonly Onset[]): number {
  let s = 0;
  for (const o of onsets) s += o.strength;
  return s;
}

/** Best grid phase (ms in [0, period)) for a BPM and its fit (0-1). */
export function bestPhase(onsets: readonly Onset[], bpm: number): { phaseMs: number; fit: number } {
  const period = 60000 / bpm;
  const total = totalStrength(onsets);
  if (total <= 0) return { phaseMs: 0, fit: 0 };
  const sums = harmonicSums(onsets, period);
  let bestI = 0;
  let best = -Infinity;
  const scores: number[] = [];
  for (let i = 0; i < PHASE_STEPS; i++) {
    const s = combScore(sums, period, (i / PHASE_STEPS) * period);
    scores.push(s);
    if (s > best) {
      best = s;
      bestI = i;
    }
  }
  // Parabolic refinement between the neighbouring phase steps.
  const a = scores[(bestI + PHASE_STEPS - 1) % PHASE_STEPS] as number;
  const c = scores[(bestI + 1) % PHASE_STEPS] as number;
  const denom = a - 2 * best + c;
  const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  let phaseMs = (((bestI + delta) / PHASE_STEPS) * period + period) % period;
  phaseMs = refinePhase(onsets, period, phaseMs);
  const fit = combScore(sums, period, phaseMs) / (total * WEIGHT_SUM);
  return { phaseMs, fit: Math.max(0, Math.min(1, fit)) };
}

/** Move the phase by the strength-weighted mean deviation of the onsets near beat lines. */
function refinePhase(onsets: readonly Onset[], period: number, phaseMs: number): number {
  const window = Math.min(40, period / 8);
  let phase = phaseMs;
  for (let iter = 0; iter < 3; iter++) {
    let sum = 0;
    let weight = 0;
    for (const o of onsets) {
      const d = (((o.t - phase) % period) + period) % period;
      const signed = d > period / 2 ? d - period : d;
      if (Math.abs(signed) <= window) {
        sum += signed * o.strength;
        weight += o.strength;
      }
    }
    if (weight <= 0) break;
    phase = (((phase + sum / weight) % period) + period) % period;
  }
  return phase;
}

/**
 * Fit a beat grid at a fixed BPM: phase from bestPhase, then beat 0 put on the beat of the
 * measure with the most onset strength, at the last such downbeat not after the first onset
 * (never before song time 0).
 */
export function fitGrid(onsets: readonly Onset[], bpm: number): TempoCandidate {
  const period = 60000 / bpm;
  const { phaseMs, fit } = bestPhase(onsets, bpm);
  const tolerance = Math.min(40, period / 8);
  const perBeat = new Array<number>(BEATS_PER_MEASURE).fill(0);
  let firstOnset = Infinity;
  for (const o of onsets) {
    const beats = (o.t - phaseMs) / period;
    const nearest = Math.round(beats);
    if (Math.abs(beats - nearest) * period > tolerance) continue;
    const k = ((nearest % BEATS_PER_MEASURE) + BEATS_PER_MEASURE) % BEATS_PER_MEASURE;
    perBeat[k] = (perBeat[k] as number) + o.strength;
    if (o.t < firstOnset) firstOnset = o.t;
  }
  let downbeat = 0;
  for (let k = 1; k < BEATS_PER_MEASURE; k++) {
    if ((perBeat[k] as number) > (perBeat[downbeat] as number) * 1.05) downbeat = k;
  }
  const measure = period * BEATS_PER_MEASURE;
  const first = phaseMs + downbeat * period;
  const steps = Number.isFinite(firstOnset)
    ? Math.max(0, Math.floor((firstOnset + tolerance - first) / measure))
    : 0;
  return { bpm, offsetMs: Math.round(first + steps * measure), fit };
}

/** Normalised autocorrelation of the envelope at whole lags [minLag, maxLag]. */
export function autocorrelation(env: Float32Array, minLag: number, maxLag: number): Float64Array {
  const out = new Float64Array(maxLag + 1);
  let zero = 0;
  for (let n = 0; n < env.length; n++) zero += (env[n] as number) * (env[n] as number);
  zero /= Math.max(1, env.length);
  if (zero <= 0) return out;
  for (let lag = Math.max(1, minLag); lag <= maxLag && lag < env.length; lag++) {
    let s = 0;
    for (let n = 0; n + lag < env.length; n++) s += (env[n] as number) * (env[n + lag] as number);
    out[lag] = s / (env.length - lag) / zero;
  }
  return out;
}

/** Coarse tempo from the envelope autocorrelation (peak with the best prior-weighted height). */
export function coarseTempo(novelty: Float32Array, hopMs: number): number | null {
  const minLag = Math.floor(60000 / MAX_SEARCH_BPM / hopMs);
  const maxLag = Math.ceil(60000 / MIN_SEARCH_BPM / hopMs);
  const r = autocorrelation(novelty, minLag, maxLag);
  let best: number | null = null;
  let bestScore = 0;
  for (let lag = Math.max(2, minLag); lag < maxLag; lag++) {
    const v = r[lag] as number;
    if (!(v > (r[lag - 1] as number) && v >= (r[lag + 1] as number)) || v <= 0) continue;
    const a = r[lag - 1] as number;
    const c = r[lag + 1] as number;
    const denom = a - 2 * v + c;
    const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const bpm = 60000 / ((lag + delta) * hopMs);
    const score = v * tempoPrior(bpm);
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return best;
}

/** BPM near `coarse` whose grid best fits the onsets (scan, then parabolic refinement). */
export function refineTempo(onsets: readonly Onset[], coarse: number): number {
  const lo = coarse * (1 - FINE_RANGE);
  const steps = Math.ceil((coarse * 2 * FINE_RANGE) / FINE_STEP_BPM);
  const scores: number[] = [];
  let bestI = 0;
  for (let i = 0; i <= steps; i++) {
    const bpm = lo + i * FINE_STEP_BPM;
    const period = 60000 / bpm;
    const sums = harmonicSums(onsets, period);
    let best = -Infinity;
    for (let p = 0; p < PHASE_STEPS / 2; p++) {
      best = Math.max(best, combScore(sums, period, (p / (PHASE_STEPS / 2)) * period));
    }
    scores.push(best);
    if (best > (scores[bestI] as number)) bestI = i;
  }
  const a = scores[bestI - 1];
  const b = scores[bestI] as number;
  const c = scores[bestI + 1];
  let delta = 0;
  if (a !== undefined && c !== undefined) {
    const denom = a - 2 * b + c;
    if (denom < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  }
  return lo + (bestI + delta) * FINE_STEP_BPM;
}

/** Round to 2 decimals, or to a whole / half BPM when that fits (almost) as well. */
export function roundBpm(onsets: readonly Onset[], bpm: number): number {
  const exact = bestPhase(onsets, bpm).fit;
  for (const step of [1, 0.5]) {
    const round = Math.round(bpm / step) * step;
    if (
      Math.abs(round - bpm) <= 0.25 &&
      bestPhase(onsets, round).fit >= exact * ROUND_BPM_TOLERANCE
    ) {
      return round;
    }
  }
  return Math.round(bpm * 100) / 100;
}

const NO_TEMPO = (onsetCount: number): TempoEstimate => ({
  bpm: null,
  offsetMs: 0,
  confidence: 0,
  alternatives: [],
  onsetCount,
});

/** Estimate BPM, offset and confidence from an onset analysis. */
export function estimateTempo(
  analysis: Pick<OnsetAnalysis, 'novelty' | 'hopMs' | 'onsets'>,
): TempoEstimate {
  const { onsets } = analysis;
  if (onsets.length < MIN_ONSETS) return NO_TEMPO(onsets.length);
  const coarse = coarseTempo(analysis.novelty, analysis.hopMs);
  if (coarse === null) return NO_TEMPO(onsets.length);
  const bpm = roundBpm(onsets, refineTempo(onsets, coarse));
  const main = fitGrid(onsets, bpm);
  const countFactor = Math.min(1, onsets.length / FULL_CONFIDENCE_ONSETS);
  const confidence = Math.max(0, Math.min(1, (main.fit - 0.05) / 0.55)) * countFactor;
  const alternatives: TempoCandidate[] = [];
  for (const factor of [2, 0.5]) {
    const alt = Math.round(bpm * factor * 100) / 100;
    if (alt >= MIN_SEARCH_BPM / 2 && alt <= MAX_SEARCH_BPM * 2)
      alternatives.push(fitGrid(onsets, alt));
  }
  return { bpm, offsetMs: main.offsetMs, confidence, alternatives, onsetCount: onsets.length };
}
