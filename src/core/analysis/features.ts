import { FFT } from '../fft';
import { downsample } from '../onsets';
import { FEATURE_FRAME_MS, LOW_BAND_MAX_HZ, MID_BAND_MAX_HZ, type Bands } from './types';

/**
 * Raw frame features of a mono signal: one Hann-windowed FFT frame every FEATURE_FRAME_MS,
 * centred on the frame's time (the signal is treated as silent outside its length).
 */
export interface RawFeatures {
  frameMs: number;
  frameCount: number;
  rms: Float32Array;
  bands: Bands<Float32Array>;
  /** Spectral flux (increase of log-compressed magnitude) summed per band. */
  flux: Bands<Float32Array>;
  /** Spectral centroid, Hz (0 for silent frames). */
  centroidHz: Float32Array;
}

/** Rate the features are computed at (downsampled by a whole factor), enough for the high band. */
export const FEATURE_RATE = 22050;
export const FEATURE_FFT_SIZE = 1024;
const LOG_COMPRESSION = 10;
/** Frames quieter than this RMS count as silent (no brightness). */
export const SILENT_RMS = 1e-4;

export function* extractFeaturesSteps(
  samples: Float32Array,
  sampleRate: number,
): Generator<number, RawFeatures, void> {
  const factor = Math.max(1, Math.floor(sampleRate / FEATURE_RATE));
  const rate = sampleRate / factor;
  const x = downsample(samples, factor);
  const durationMs = (samples.length / sampleRate) * 1000;
  const hop = (rate * FEATURE_FRAME_MS) / 1000;
  const frameCount = Math.max(0, Math.ceil(durationMs / FEATURE_FRAME_MS));
  const size = FEATURE_FFT_SIZE;
  const half = size / 2;
  const bins = half + 1;
  const binHz = rate / size;
  const lowEnd = Math.max(1, Math.round(LOW_BAND_MAX_HZ / binHz));
  const midEnd = Math.max(lowEnd + 1, Math.round(MID_BAND_MAX_HZ / binHz));

  const rms = new Float32Array(frameCount);
  const bands = {
    low: new Float32Array(frameCount),
    mid: new Float32Array(frameCount),
    high: new Float32Array(frameCount),
  };
  const flux = {
    low: new Float32Array(frameCount),
    mid: new Float32Array(frameCount),
    high: new Float32Array(frameCount),
  };
  const centroidHz = new Float32Array(frameCount);

  const fft = new FFT(size);
  const window = new Float64Array(size);
  let windowSq = 0;
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    windowSq += (window[i] as number) ** 2;
  }
  // A full-scale sine is ~1 in its bin.
  const magScale = 4 / size;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);

  for (let n = 0; n < frameCount; n++) {
    const start = Math.round(n * hop) - half;
    let sq = 0;
    for (let i = 0; i < size; i++) {
      const v = x[start + i] ?? 0;
      const w = v * (window[i] as number);
      sq += w * w;
      re[i] = w;
      im[i] = 0;
    }
    rms[n] = Math.sqrt(sq / windowSq);
    fft.forward(re, im);
    let pLow = 0;
    let pMid = 0;
    let pHigh = 0;
    let fLow = 0;
    let fMid = 0;
    let fHigh = 0;
    let magSum = 0;
    let weighted = 0;
    for (let k = 1; k < bins; k++) {
      const r = re[k] as number;
      const j = im[k] as number;
      const mag = magScale * Math.sqrt(r * r + j * j);
      const p = mag * mag;
      const lm = Math.log1p(LOG_COMPRESSION * mag);
      cur[k] = lm;
      const d = n === 0 ? 0 : Math.max(0, lm - (prev[k] as number));
      magSum += mag;
      weighted += mag * k * binHz;
      if (k < lowEnd) {
        pLow += p;
        fLow += d;
      } else if (k < midEnd) {
        pMid += p;
        fMid += d;
      } else {
        pHigh += p;
        fHigh += d;
      }
    }
    bands.low[n] = Math.sqrt(pLow);
    bands.mid[n] = Math.sqrt(pMid);
    bands.high[n] = Math.sqrt(pHigh);
    // Per-bin averages, so the narrow low band isn't drowned by the many high bins.
    flux.low[n] = fLow / (lowEnd - 1);
    flux.mid[n] = fMid / (midEnd - lowEnd);
    flux.high[n] = fHigh / (bins - midEnd);
    centroidHz[n] = (rms[n] as number) > SILENT_RMS && magSum > 0 ? weighted / magSum : 0;
    const swap = prev;
    prev = cur;
    cur = swap;
    if ((n & 255) === 255) yield n / frameCount;
  }
  return { frameMs: FEATURE_FRAME_MS, frameCount, rms, bands, flux, centroidHz };
}
