import { FFT } from './fft';

/**
 * Onset detection by spectral flux. The song is mixed to mono, downsampled to about 11 kHz and
 * cut into overlapping Hann-windowed frames (46 ms, hop ~6 ms). The flux of a frame is the sum
 * of the increases in (log-compressed) magnitude per frequency bin since the previous frame:
 * it jumps when something new starts sounding. Onsets are the local maxima of the flux that
 * stand clearly above its local median, so steady sounds (noise, pads) produce none.
 *
 * Everything here is pure and synchronous; `analyzeOnsetsSteps` yields its progress so a worker
 * can report it.
 */

/** A detected onset: song time in ms (fractional) and strength from 0 (weak) to 1 (strong). */
export interface Onset {
  t: number;
  strength: number;
}

export interface OnsetAnalysis {
  /** Rate the analysis ran at (after downsampling). */
  sampleRate: number;
  /** Time between analysis frames, ms. */
  hopMs: number;
  /** Song time of frame 0, ms (the centre of the first window, bias-corrected). */
  frameOffsetMs: number;
  /** Onset envelope per frame: flux above the local median, scaled so strong onsets are ~1. */
  novelty: Float32Array;
  /** RMS level per frame (0-1 for full scale), for sustain detection. */
  energy: Float32Array;
  onsets: Onset[];
  durationMs: number;
}

/** Analysis rate the input is downsampled to (by a whole factor). */
export const ANALYSIS_RATE = 11025;
export const FRAME_SIZE = 512;
export const HOP_SIZE = 64;
/** A frame is an onset only if its flux is this many times its local median... */
const MEDIAN_RATIO = 1.5;
/** ...plus this absolute floor (silence and digital noise floors never reach it). */
const FLUX_FLOOR = 0.05;
/** Window of the local median, ms each side. */
const MEDIAN_HALF_WINDOW_MS = 400;
/** Two onsets are at least this far apart (the stronger wins). */
const MIN_ONSET_GAP_MS = 35;
/** Log compression of magnitudes: log(1 + C * |X|). */
const LOG_COMPRESSION = 10;
/**
 * The flux of a sharp attack peaks while the attack is still in the later half of the window
 * (where the Hann window rises fastest as frames move on). Measured with click tracks; added to
 * every frame time so onset times match the attacks.
 */
const FLUX_BIAS_MS = 8.75;

/** Mix channels to mono and downsample by a whole factor (box filter: average each group). */
export function downsample(samples: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return samples;
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += samples[base + k] as number;
    out[i] = sum / factor;
  }
  return out;
}

/** Whole downsampling factor that brings `sampleRate` closest to ANALYSIS_RATE from above. */
export function downsampleFactor(sampleRate: number): number {
  return Math.max(1, Math.floor(sampleRate / ANALYSIS_RATE));
}

/** Run the whole analysis at once (tests, fallbacks). */
export function analyzeOnsets(samples: Float32Array, sampleRate: number): OnsetAnalysis {
  const steps = analyzeOnsetsSteps(samples, sampleRate);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * The analysis as a generator: yields progress (0-1) every few hundred frames and returns the
 * result. `samples` is the mono signal at `sampleRate`.
 */
export function* analyzeOnsetsSteps(
  samples: Float32Array,
  sampleRate: number,
): Generator<number, OnsetAnalysis, void> {
  if (!(sampleRate > 0)) throw new RangeError(`Sample rate must be positive, got ${sampleRate}`);
  const durationMs = (samples.length / sampleRate) * 1000;
  const factor = downsampleFactor(sampleRate);
  const rate = sampleRate / factor;
  const x = downsample(samples, factor);
  yield 0.05;

  const hopMs = (HOP_SIZE / rate) * 1000;
  const frameOffsetMs = (FRAME_SIZE / 2 / rate) * 1000 + FLUX_BIAS_MS;
  const frames = x.length >= FRAME_SIZE ? Math.floor((x.length - FRAME_SIZE) / HOP_SIZE) + 1 : 0;
  const flux = new Float32Array(frames);
  const energy = new Float32Array(frames);

  const fft = new FFT(FRAME_SIZE);
  const window = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME_SIZE);
  }
  const bins = FRAME_SIZE / 2 + 1;
  // Magnitudes are scaled so a full-scale sine is ~1 in its bin.
  const magScale = 4 / FRAME_SIZE;
  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);

  for (let n = 0; n < frames; n++) {
    const start = n * HOP_SIZE;
    let sq = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const v = x[start + i] as number;
      sq += v * v;
      re[i] = v * (window[i] as number);
      im[i] = 0;
    }
    energy[n] = Math.sqrt(sq / FRAME_SIZE);
    fft.forward(re, im);
    let sum = 0;
    for (let k = 0; k < bins; k++) {
      const r = re[k] as number;
      const j = im[k] as number;
      const m = Math.log1p(LOG_COMPRESSION * magScale * Math.sqrt(r * r + j * j));
      cur[k] = m;
      const d = m - (prev[k] as number);
      if (d > 0) sum += d;
    }
    flux[n] = n === 0 ? 0 : sum;
    const swap = prev;
    prev = cur;
    cur = swap;
    if ((n & 511) === 511) yield 0.05 + 0.85 * (n / frames);
  }
  yield 0.9;

  const median = localMedian(flux, Math.max(1, Math.round(MEDIAN_HALF_WINDOW_MS / hopMs)));
  const raw: { frame: number; prominence: number }[] = [];
  const gap = Math.max(1, Math.round(MIN_ONSET_GAP_MS / hopMs));
  const novelty = new Float32Array(frames);
  for (let n = 0; n < frames; n++) {
    novelty[n] = Math.max(0, (flux[n] as number) - (median[n] as number));
  }
  for (let n = 1; n < frames - 1; n++) {
    const v = flux[n] as number;
    if (v < MEDIAN_RATIO * (median[n] as number) + FLUX_FLOOR) continue;
    // Strict on the left, non-strict on the right: a flat top counts once.
    let isPeak = true;
    for (let k = Math.max(0, n - gap); k <= Math.min(frames - 1, n + gap) && isPeak; k++) {
      const w = flux[k] as number;
      if (k < n ? w >= v : k > n && w > v) isPeak = false;
    }
    if (isPeak) raw.push({ frame: n, prominence: novelty[n] as number });
  }

  // Strengths relative to the strong onsets (98th percentile), so one spike can't squash all.
  const norm = percentile(
    raw.map((o) => o.prominence),
    0.98,
  );
  const onsets: Onset[] = [];
  for (const { frame, prominence } of raw) {
    const a = flux[frame - 1] as number;
    const b = flux[frame] as number;
    const c = flux[frame + 1] as number;
    const denom = a - 2 * b + c;
    const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    onsets.push({
      t: frameOffsetMs + (frame + delta) * hopMs,
      strength: norm > 0 ? Math.min(1, prominence / norm) : 0,
    });
  }
  if (norm > 0) for (let n = 0; n < frames; n++) novelty[n] = (novelty[n] as number) / norm;
  yield 1;
  return { sampleRate: rate, hopMs, frameOffsetMs, novelty, energy, onsets, durationMs };
}

/** Median of `values` over [n - half, n + half] for every n (recomputed every few frames). */
export function localMedian(values: Float32Array, half: number): Float32Array {
  const out = new Float32Array(values.length);
  const stride = Math.max(1, Math.floor(half / 8));
  const scratch: number[] = [];
  for (let block = 0; block < values.length; block += stride) {
    const centre = Math.min(values.length - 1, block + Math.floor(stride / 2));
    scratch.length = 0;
    const lo = Math.max(0, centre - half);
    const hi = Math.min(values.length - 1, centre + half);
    for (let k = lo; k <= hi; k++) scratch.push(values[k] as number);
    scratch.sort((p, q) => p - q);
    const m = scratch[Math.floor(scratch.length / 2)] ?? 0;
    for (let n = block; n < Math.min(values.length, block + stride); n++) out[n] = m;
  }
  return out;
}

/** The q-quantile (0-1) of the values, 0 for none. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i] as number;
}
