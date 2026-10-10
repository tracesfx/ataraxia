import { normalizeByQuantiles } from '../../../core/analysis/curves';
import { FFT } from '../../../core/fft';
import { downsample } from '../../../core/onsets';
import { boxSmooth, medianFilter, quantileOf } from './dsp';
import {
  BANDS,
  BAND_EDGES_HZ,
  CHART_ANALYSIS_VERSION,
  CURVE_FRAME_MS,
  LAYERS,
  type BandId,
  type ChartFeatures,
  type LayerId,
} from './types';

/**
 * The heavy half of ChartAnalysis: from a mono signal to cached features (see types.ts). Runs
 * in a worker as a generator yielding progress.
 *
 * 1. Onset STFT (about 46 ms Hann window, 5.8 ms hop) folded into semitone bands.
 * 2. Median-filter harmonic/percussive separation on those bands (time median for harmonic,
 *    frequency median for percussive, soft masks).
 * 3. Per layer: adaptively whitened, log-compressed, half-wave rectified flux of the layer's
 *    bands of the harmonic or percussive part (with a neighbour-band maximum on the previous
 *    frame, which ignores vibrato and slides).
 * 4. Pitch STFT (about 93 ms window, 11.6 ms hop): a 3-frame time median, spectral whitening,
 *    harmonic summation over 52-100 MIDI candidates (harmonics up to 6 kHz), chroma.
 * 5. 50 Hz curves: RMS, loudness, five band energies, brightness, chroma, harmony changes.
 */

/** Signals are analysed at about this rate (whole downsampling factor). */
const TARGET_RATE = 22050;
const ONSET_HOP_MS = 5.8;
/** Harmonic median: about 100 ms each way in total; percussive median: 13 semitone bands. */
const HARMONIC_HALF_FRAMES = 8;
const PERCUSSIVE_HALF_BANDS = 6;
/** Flux compares with this many frames earlier (about 11.6 ms). */
const FLUX_LAG = 2;
/** Whitening memory: the per-band peak decays by half over this long. */
const WHITEN_HALF_LIFE_MS = 2000;
const LOG_GAIN = 20;

/** Pitch candidates: MIDI 52 (E3, 165 Hz) to 100 (E7, 2637 Hz) in thirds of a semitone. */
export const PITCH_MIN_MIDI = 52;
export const PITCH_MAX_MIDI = 100;
const PITCH_STEPS_PER_SEMITONE = 3;
const HARMONIC_MAX_HZ = 6000;
const MAX_HARMONICS = 10;
const HARMONIC_DECAY = 0.8;
/** Partials weigh 0.12 below this and rise to full weight over the ramp (lead emphasis). */
const LEAD_WEIGHT_LO_HZ = 220;
const LEAD_WEIGHT_RAMP_HZ = 280;

interface LayerSpec {
  source: 'harmonic' | 'percussive';
  loHz: number;
  hiHz: number;
}

export const LAYER_SPECS: Readonly<Record<LayerId, LayerSpec>> = {
  kick: { source: 'percussive', loHz: 30, hiHz: 120 },
  snare: { source: 'percussive', loHz: 200, hiHz: 3000 },
  hats: { source: 'percussive', loHz: 6000, hiHz: 20000 },
  bass: { source: 'harmonic', loHz: 40, hiHz: 250 },
  lead: { source: 'harmonic', loHz: 500, hiHz: 8000 },
  other: { source: 'harmonic', loHz: 200, hiHz: 2000 },
};

const midiToHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** Semitone bands over the bins of an FFT (low bins, wider than a semitone, one band each). */
function semitoneBands(
  bins: number,
  binHz: number,
): { bandOfBin: Int16Array; centreHz: Float32Array; count: number } {
  const bandOfBin = new Int16Array(bins).fill(-1);
  const centres: number[] = [];
  let lastSemi = Number.NaN;
  let band = -1;
  let sumHz = 0;
  let n = 0;
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    const semi = f < 27.5 ? -1 : Math.floor(12 * Math.log2(f / 27.5));
    if (semi !== lastSemi) {
      if (band >= 0) centres.push(sumHz / n);
      band++;
      lastSemi = semi;
      sumHz = 0;
      n = 0;
    }
    bandOfBin[k] = band;
    sumHz += f;
    n++;
  }
  if (n > 0) centres.push(sumHz / n);
  return { bandOfBin, centreHz: Float32Array.from(centres), count: centres.length };
}

function hann(size: number): { window: Float64Array; sumSq: number } {
  const window = new Float64Array(size);
  let sumSq = 0;
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    window[i] = w;
    sumSq += w * w;
  }
  return { window, sumSq };
}

/** Run the whole feature extraction at once (scripts). */
export function computeChartFeatures(samples: Float32Array, sampleRate: number): ChartFeatures {
  const steps = computeChartFeaturesSteps(samples, sampleRate);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

export function* computeChartFeaturesSteps(
  samples: Float32Array,
  sampleRate: number,
): Generator<number, ChartFeatures, void> {
  if (!(sampleRate > 0)) throw new RangeError(`Sample rate must be positive, got ${sampleRate}`);
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  const rate = sampleRate / factor;
  const x = downsample(samples, factor);
  const durationMs = (samples.length / sampleRate) * 1000;

  // --- 1. Onset STFT -------------------------------------------------------------------------
  const size = rate > 30000 ? 2048 : 1024;
  const half = size / 2;
  const bins = half + 1;
  const binHz = rate / size;
  const hop = Math.max(1, Math.round((rate * ONSET_HOP_MS) / 1000));
  const hopMs = (hop / rate) * 1000;
  const frames = Math.max(0, Math.ceil(durationMs / hopMs));
  const { bandOfBin, centreHz, count: B } = semitoneBands(bins, binHz);
  const { window, sumSq } = hann(size);
  const magScale = 4 / size;
  const fft = new FFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const spec = new Float32Array(frames * B);
  const bandPow = new Float64Array(B);

  // Coarse curves accumulate per 20 ms frame.
  const frameCount = Math.max(0, Math.ceil(durationMs / CURVE_FRAME_MS));
  const sqAcc = new Float64Array(frameCount);
  const bandAcc = BANDS.map(() => new Float64Array(frameCount));
  const centroidNum = new Float64Array(frameCount);
  const centroidDen = new Float64Array(frameCount);
  const counts = new Uint16Array(frameCount);
  const displayBandOfBin = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    const i = BANDS.findIndex((b: BandId) => f >= BAND_EDGES_HZ[b][0] && f < BAND_EDGES_HZ[b][1]);
    displayBandOfBin[k] = i;
  }

  for (let n = 0; n < frames; n++) {
    const start = n * hop - half;
    let sq = 0;
    for (let i = 0; i < size; i++) {
      const v = (x[start + i] ?? 0) * (window[i] as number);
      sq += v * v;
      re[i] = v;
      im[i] = 0;
    }
    fft.forward(re, im);
    bandPow.fill(0);
    const k20 = Math.min(frameCount - 1, Math.round((n * hopMs) / CURVE_FRAME_MS));
    const disp = k20 >= 0 ? bandAcc : null;
    let magSum = 0;
    let weighted = 0;
    for (let k = 1; k < bins; k++) {
      const r = re[k] as number;
      const j = im[k] as number;
      const p = (r * r + j * j) * magScale * magScale;
      bandPow[bandOfBin[k] as number] = (bandPow[bandOfBin[k] as number] as number) + p;
      const db = displayBandOfBin[k] as number;
      if (disp && db >= 0)
        (disp[db] as Float64Array)[k20] = ((disp[db] as Float64Array)[k20] as number) + p;
      const mag = Math.sqrt(p);
      magSum += mag;
      weighted += mag * k * binHz;
    }
    const row = n * B;
    for (let b = 0; b < B; b++) spec[row + b] = Math.sqrt(bandPow[b] as number);
    if (k20 >= 0) {
      sqAcc[k20] = (sqAcc[k20] as number) + sq / sumSq;
      centroidNum[k20] = (centroidNum[k20] as number) + weighted;
      centroidDen[k20] = (centroidDen[k20] as number) + magSum;
      counts[k20] = (counts[k20] as number) + 1;
    }
    if ((n & 1023) === 1023) yield 0.33 * (n / frames);
  }
  yield 0.33;

  // --- 2. Harmonic/percussive separation -------------------------------------------------------
  const harm = new Float32Array(frames * B);
  const perc = new Float32Array(frames * B);
  {
    const win = new Float64Array(2 * Math.max(HARMONIC_HALF_FRAMES, PERCUSSIVE_HALF_BANDS) + 1);
    for (let b = 0; b < B; b++) {
      medianFilter(spec, harm, frames, B, b, HARMONIC_HALF_FRAMES, win);
      if ((b & 7) === 7) yield 0.33 + 0.1 * (b / B);
    }
    for (let n = 0; n < frames; n++) {
      medianFilter(spec, perc, B, 1, n * B, PERCUSSIVE_HALF_BANDS, win);
      if ((n & 4095) === 4095) yield 0.43 + 0.07 * (n / frames);
    }
    // Soft (Wiener) masks applied to the mixture.
    for (let i = 0; i < spec.length; i++) {
      const h = harm[i] as number;
      const p = perc[i] as number;
      const h2 = h * h;
      const p2 = p * p;
      const den = h2 + p2;
      const s = spec[i] as number;
      const mh = den > 1e-20 ? h2 / den : 0.5;
      harm[i] = s * mh;
      perc[i] = s * (1 - mh);
    }
  }
  yield 0.5;

  // --- 3. Layer onset envelopes --------------------------------------------------------------
  const floors = {
    harmonic: Math.max(1e-6, 0.004 * quantileOf(harm, 0.995, 37)),
    percussive: Math.max(1e-6, 0.004 * quantileOf(perc, 0.995, 37)),
  };
  const decay = 0.5 ** (hopMs / WHITEN_HALF_LIFE_MS);
  const envelopes = {} as Record<LayerId, Float32Array>;
  const envelopeScale = {} as Record<LayerId, number>;
  for (const [li, layer] of LAYERS.entries()) {
    const specOf = LAYER_SPECS[layer];
    const src = specOf.source === 'harmonic' ? harm : perc;
    const floor = floors[specOf.source];
    let b0 = -1;
    let b1 = -1;
    for (let b = 0; b < B; b++) {
      const c = centreHz[b] as number;
      if (c >= specOf.loHz && c < specOf.hiHz) {
        if (b0 < 0) b0 = b;
        b1 = b;
      }
    }
    const env = new Float32Array(frames);
    if (b0 >= 0) {
      const nb = b1 - b0 + 1;
      const mem = new Float64Array(nb);
      // Ring of the last FLUX_LAG + 1 compressed rows.
      const rows = Array.from({ length: FLUX_LAG + 1 }, () => new Float64Array(nb));
      for (let n = 0; n < frames; n++) {
        const cur = rows[n % (FLUX_LAG + 1)] as Float64Array;
        const row = n * B + b0;
        for (let i = 0; i < nb; i++) {
          const v = src[row + i] as number;
          const m = Math.max(v, floor, (mem[i] as number) * decay);
          mem[i] = m;
          cur[i] = Math.log1p((LOG_GAIN * v) / m);
        }
        if (n < FLUX_LAG) continue;
        const prev = rows[(n - FLUX_LAG) % (FLUX_LAG + 1)] as Float64Array;
        let sum = 0;
        for (let i = 0; i < nb; i++) {
          let ref = prev[i] as number;
          if (i > 0) ref = Math.max(ref, prev[i - 1] as number);
          if (i < nb - 1) ref = Math.max(ref, prev[i + 1] as number);
          const d = (cur[i] as number) - ref;
          if (d > 0) sum += d;
        }
        env[n] = sum / nb;
      }
    }
    envelopes[layer] = env;
    envelopeScale[layer] = Math.max(1e-6, quantileOf(env, 0.99, 3));
    yield 0.5 + 0.1 * ((li + 1) / LAYERS.length);
  }

  // --- 4. Pitch track ------------------------------------------------------------------------
  const pSize = size * 2;
  const pHalf = pSize / 2;
  const pBins = pHalf + 1;
  const pBinHz = rate / pSize;
  const pHop = hop * 2;
  const pHopMs = (pHop / rate) * 1000;
  const pFrames = Math.max(0, Math.ceil(durationMs / pHopMs));
  const pFft = new FFT(pSize);
  const pWin = hann(pSize).window;
  const pRe = new Float64Array(pSize);
  const pIm = new Float64Array(pSize);
  const ring = [new Float32Array(pBins), new Float32Array(pBins), new Float32Array(pBins)];
  const med = new Float32Array(pBins);
  const white = new Float32Array(pBins);
  const prefix = new Float64Array(pBins + 1);
  const kLo = Math.max(1, Math.floor(100 / pBinHz));
  const kHi = Math.min(pBins - 2, Math.ceil(6500 / pBinHz));
  const WHITEN_BINS = 8;
  const kTop = Math.min(kHi, Math.ceil(HARMONIC_MAX_HZ / pBinHz) + 2);

  // Harmonic summation tables: per candidate, harmonic bin positions and weights.
  const candCount = (PITCH_MAX_MIDI - PITCH_MIN_MIDI) * PITCH_STEPS_PER_SEMITONE + 1;
  const hBin = new Int32Array(candCount * MAX_HARMONICS).fill(-1);
  const hWeight = new Float32Array(candCount * MAX_HARMONICS);
  for (let c = 0; c < candCount; c++) {
    const f0 = midiToHz(PITCH_MIN_MIDI + c / PITCH_STEPS_PER_SEMITONE);
    for (let h = 1; h <= MAX_HARMONICS; h++) {
      const f = h * f0;
      if (f > HARMONIC_MAX_HZ || f / pBinHz >= pBins - 2) break;
      hBin[c * MAX_HARMONICS + h - 1] = Math.floor(f / pBinHz);
      hWeight[c * MAX_HARMONICS + h - 1] = HARMONIC_DECAY ** (h - 1);
    }
  }
  // Pitch class of each bin (100 Hz - 5 kHz), for chroma.
  const leadWeight = new Float32Array(pBins);
  for (let k = 0; k < pBins; k++) {
    const f = k * pBinHz;
    leadWeight[k] = Math.max(0.12, Math.min(1, (f - LEAD_WEIGHT_LO_HZ) / LEAD_WEIGHT_RAMP_HZ));
  }
  const pcOfBin = new Int8Array(pBins).fill(-1);
  for (let k = kLo; k <= kHi; k++) {
    const f = k * pBinHz;
    if (f < 100 || f > 5000) continue;
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    pcOfBin[k] = ((midi % 12) + 12) % 12;
  }

  const pitchMidi = new Float32Array(pFrames);
  const pitchSalience = new Float32Array(pFrames);
  const pitchConfidence = new Float32Array(pFrames);
  const pChroma = new Float32Array(pFrames * 12);
  const sal = new Float32Array(candCount);

  const spectrumInto = (m: number, out: Float32Array): void => {
    if (m < 0 || m >= pFrames) {
      out.fill(0);
      return;
    }
    const start = m * pHop - pHalf;
    for (let i = 0; i < pSize; i++) {
      pRe[i] = (x[start + i] ?? 0) * (pWin[i] as number);
      pIm[i] = 0;
    }
    pFft.forward(pRe, pIm);
    const scale = 4 / pSize;
    for (let k = 0; k < pBins; k++) {
      const r = pRe[k] as number;
      const j = pIm[k] as number;
      out[k] = scale * Math.sqrt(r * r + j * j);
    }
  };

  spectrumInto(-1, ring[2] as Float32Array);
  spectrumInto(0, ring[0] as Float32Array);
  for (let q = 0; q < pFrames; q++) {
    spectrumInto(q + 1, ring[(q + 1) % 3] as Float32Array);
    const a = ring[(q + 2) % 3] as Float32Array;
    const b = ring[q % 3] as Float32Array;
    const c = ring[(q + 1) % 3] as Float32Array;
    // 3-frame time median: steady partials stay, single-frame clicks go.
    for (let k = 0; k < pBins; k++) {
      const va = a[k] as number;
      const vb = b[k] as number;
      const vc = c[k] as number;
      med[k] = Math.max(Math.min(va, vb), Math.min(Math.max(va, vb), vc));
    }
    // Whitening: what stands above the local spectral mean, square-root compressed.
    prefix[0] = 0;
    for (let k = 0; k < pBins; k++) prefix[k + 1] = (prefix[k] as number) + (med[k] as number);
    white.fill(0);
    for (let k = kLo; k <= kHi; k++) {
      const lo = Math.max(0, k - WHITEN_BINS);
      const hi = Math.min(pBins - 1, k + WHITEN_BINS);
      const mean = ((prefix[hi + 1] as number) - (prefix[lo] as number)) / (hi - lo + 1);
      const d = (med[k] as number) - mean;
      white[k] = d > 0 ? Math.sqrt(d) : 0;
    }
    // Chroma.
    let chromaSum = 0;
    for (let k = kLo; k <= kHi; k++) {
      const pc = pcOfBin[k] as number;
      if (pc < 0) continue;
      const v = white[k] as number;
      pChroma[q * 12 + pc] = (pChroma[q * 12 + pc] as number) + v;
      chromaSum += v;
    }
    if (chromaSum > 0)
      for (let i = 0; i < 12; i++)
        pChroma[q * 12 + i] = (pChroma[q * 12 + i] as number) / chromaSum;
    // Lead weighting: partials under about 300 Hz (kick and bass, often pitched and loud)
    // count little, so they neither win the pitch search nor dilute the lead's share.
    for (let k = kLo; k <= kTop; k++) white[k] = (white[k] as number) * (leadWeight[k] as number);
    // Harmonic summation.
    let whiteTotal = 0;
    for (let k = kLo; k <= kTop; k++) whiteTotal += white[k] as number;
    let best = -1;
    let bestSal = 0;
    for (let ci = 0; ci < candCount; ci++) {
      let s = 0;
      const base = ci * MAX_HARMONICS;
      for (let h = 0; h < MAX_HARMONICS; h++) {
        const k = hBin[base + h] as number;
        if (k < 0) break;
        const v0 = white[k] as number;
        const v1 = white[k + 1] as number;
        s += (hWeight[base + h] as number) * (v0 > v1 ? v0 : v1);
      }
      sal[ci] = s;
      if (s > bestSal) {
        bestSal = s;
        best = ci;
      }
    }
    if (best >= 0 && bestSal > 1e-9) {
      // Confidence: the share of the whitened spectrum (up to 6 kHz) that the pitch's
      // harmonics explain (each harmonic's main lobe, 4 bins). High for one clear voice, low
      // for noise, drums and dense chords.
      let explained = 0;
      let lastK = -10;
      const base = best * MAX_HARMONICS;
      for (let h = 0; h < MAX_HARMONICS; h++) {
        const k = hBin[base + h] as number;
        if (k < 0) break;
        for (let j = Math.max(k - 1, lastK + 1); j <= k + 2; j++) explained += white[j] as number;
        lastK = k + 2;
      }
      let d = 0;
      if (best > 0 && best < candCount - 1) {
        const l = sal[best - 1] as number;
        const r = sal[best + 1] as number;
        const den = l - 2 * bestSal + r;
        if (den < 0) d = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
      }
      pitchMidi[q] = PITCH_MIN_MIDI + (best + d) / PITCH_STEPS_PER_SEMITONE;
      pitchSalience[q] = bestSal;
      pitchConfidence[q] = whiteTotal > 0 ? Math.min(1, explained / whiteTotal) : 0;
    }
    if ((q & 511) === 511) yield 0.6 + 0.35 * (q / pFrames);
  }
  yield 0.95;

  // --- 5. Coarse curves ----------------------------------------------------------------------
  const rms = new Float32Array(frameCount);
  const centroid = new Float32Array(frameCount);
  const bandsRaw = BANDS.map(() => new Float32Array(frameCount));
  for (let k = 0; k < frameCount; k++) {
    const c = counts[k] as number;
    if (c === 0) continue;
    rms[k] = Math.sqrt((sqAcc[k] as number) / c);
    const den = centroidDen[k] as number;
    centroid[k] = den > 0 ? (centroidNum[k] as number) / den : 0;
    for (let i = 0; i < BANDS.length; i++) {
      (bandsRaw[i] as Float32Array)[k] = ((bandAcc[i] as Float64Array)[k] as number) / c;
    }
  }
  // Fill frames that got no onset frame (cannot happen at a 5.8 ms hop, but stay safe).
  for (let k = 1; k < frameCount; k++) {
    if ((counts[k] as number) === 0 && (counts[k - 1] as number) > 0) {
      rms[k] = rms[k - 1] as number;
      centroid[k] = centroid[k - 1] as number;
      for (const arr of bandsRaw) arr[k] = arr[k - 1] as number;
    }
  }
  const SILENT = 1e-4;
  const audible = (i: number): boolean => (rms[i] as number) > SILENT;
  const db = (v: number): number => 10 * Math.log10(v + 1e-12);
  const rmsDb = rms.map((v) => 20 * Math.log10(v + 1e-9));
  const loudness = normalizeByQuantiles(rmsDb, 0.05, 0.95, audible);
  const bands = {} as Record<BandId, Float32Array>;
  BANDS.forEach((band, i) => {
    const raw = (bandsRaw[i] as Float32Array).map(db);
    bands[band] = normalizeByQuantiles(raw, 0.05, 0.99, audible);
  });
  const brightness = normalizeByQuantiles(centroid, 0.05, 0.95, (i) => audible(i));

  // Chroma on the coarse grid (nearest pitch frame), then harmony changes.
  const chroma = new Float32Array(frameCount * 12);
  for (let k = 0; k < frameCount; k++) {
    if (!audible(k)) continue;
    const q = Math.min(pFrames - 1, Math.round((k * CURVE_FRAME_MS) / pHopMs));
    if (q < 0) continue;
    for (let i = 0; i < 12; i++) chroma[k * 12 + i] = pChroma[q * 12 + i] as number;
  }
  const smoothChroma = new Float32Array(frameCount * 12);
  for (let i = 0; i < 12; i++) {
    const col = new Float32Array(frameCount);
    for (let k = 0; k < frameCount; k++) col[k] = chroma[k * 12 + i] as number;
    const sm = boxSmooth(col, 5);
    for (let k = 0; k < frameCount; k++) smoothChroma[k * 12 + i] = sm[k] as number;
  }
  const changeRaw = new Float32Array(frameCount);
  const GAP = 6;
  for (let k = GAP; k < frameCount - GAP; k++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < 12; i++) {
      const a = smoothChroma[(k - GAP) * 12 + i] as number;
      const b = smoothChroma[(k + GAP) * 12 + i] as number;
      dot += a * b;
      na += a * a;
      nb += b * b;
    }
    changeRaw[k] = na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0;
  }
  const changeTop = quantileOf(changeRaw, 0.98, 1);
  const harmonicChange = changeRaw.map((v) => (changeTop > 1e-9 ? Math.min(1, v / changeTop) : 0));
  yield 1;

  return {
    version: CHART_ANALYSIS_VERSION,
    durationMs,
    analysisRate: rate,
    onsetFftSize: size,
    onsetHop: hop,
    onsetHopMs: hopMs,
    onsetFrames: frames,
    envelopes,
    envelopeScale,
    pitchFftSize: pSize,
    pitchHopMs: pHopMs,
    pitchFrames: pFrames,
    pitchMidi,
    pitchSalience,
    pitchConfidence,
    frameMs: CURVE_FRAME_MS,
    frameCount,
    rms,
    loudness,
    bands,
    brightness,
    chroma,
    harmonicChange,
  };
}

/** Every typed array of the features (to transfer them out of a worker). */
export function featureBuffers(f: ChartFeatures): ArrayBuffer[] {
  return [
    ...LAYERS.map((l) => f.envelopes[l]),
    f.pitchMidi,
    f.pitchSalience,
    f.pitchConfidence,
    f.rms,
    f.loudness,
    ...BANDS.map((b) => f.bands[b]),
    f.brightness,
    f.chroma,
    f.harmonicChange,
  ].map((a) => a.buffer as ArrayBuffer);
}

/** True when `x` looks like features of this version (a cache read; never trusts blindly). */
export function isChartFeatures(x: unknown): x is ChartFeatures {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Partial<ChartFeatures>;
  if (f.version !== CHART_ANALYSIS_VERSION) return false;
  if (typeof f.durationMs !== 'number' || typeof f.onsetFrames !== 'number') return false;
  if (!(f.pitchMidi instanceof Float32Array) || !(f.loudness instanceof Float32Array)) return false;
  if (!(f.chroma instanceof Float32Array) || !(f.harmonicChange instanceof Float32Array))
    return false;
  if (!f.envelopes || !f.bands || !f.envelopeScale) return false;
  return (
    LAYERS.every((l) => f.envelopes?.[l] instanceof Float32Array) &&
    BANDS.every((b) => f.bands?.[b] instanceof Float32Array)
  );
}
