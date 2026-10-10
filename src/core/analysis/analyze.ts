import { analyzeOnsetsSteps } from '../onsets';
import { estimateTempo } from '../tempo';
import { describe } from './describe';
import { extractFeaturesSteps } from './features';
import { ANALYSIS_VERSION, type AudioAnalysis } from './types';

/** Beat length used for smoothing when the tempo is unknown (120 BPM). */
export const FALLBACK_BEAT_MS = 500;

/**
 * Beat length for smoothing: the detected tempo folded into 70-180 BPM (so a half- or
 * double-time estimate still smooths over a musically sensible span).
 */
export function smoothingBeatMs(bpm: number | null): number {
  if (bpm === null || !(bpm > 0)) return FALLBACK_BEAT_MS;
  let b = bpm;
  while (b < 70) b *= 2;
  while (b > 180) b /= 2;
  return 60000 / b;
}

/** Run the whole analysis at once (tests, scripts). */
export function analyzeAudio(samples: Float32Array, sampleRate: number): AudioAnalysis {
  const steps = analyzeAudioSteps(samples, sampleRate);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * The full analysis of a mono signal as a generator yielding progress (0-1): onsets (precise
 * times, 6 ms hop) and tempo, then 50 Hz features, then the song-level descriptions.
 */
export function* analyzeAudioSteps(
  samples: Float32Array,
  sampleRate: number,
): Generator<number, AudioAnalysis, void> {
  if (!(sampleRate > 0)) throw new RangeError(`Sample rate must be positive, got ${sampleRate}`);
  const onsetSteps = analyzeOnsetsSteps(samples, sampleRate);
  let onsetResult;
  for (;;) {
    const r = onsetSteps.next();
    if (r.done) {
      onsetResult = r.value;
      break;
    }
    yield 0.55 * r.value;
  }
  const tempo = estimateTempo(onsetResult);
  yield 0.6;
  const featureSteps = extractFeaturesSteps(samples, sampleRate);
  let raw;
  for (;;) {
    const r = featureSteps.next();
    if (r.done) {
      raw = r.value;
      break;
    }
    yield 0.6 + 0.35 * r.value;
  }
  const beatMs = smoothingBeatMs(tempo.bpm);
  const d = describe(raw, onsetResult.onsets, beatMs);
  yield 1;
  return {
    version: ANALYSIS_VERSION,
    durationMs: onsetResult.durationMs,
    frameMs: raw.frameMs,
    frameOffsetMs: 0,
    frameCount: raw.frameCount,
    beatMs,
    rms: raw.rms,
    loudness: d.loudness,
    bands: raw.bands,
    bandFlux: d.bandFlux,
    onsetEnvelope: d.onsetEnvelope,
    brightness: d.brightness,
    onsetDensity: d.onsetDensity,
    intensity: d.intensity,
    onsets: d.onsets,
    tempo,
    buildUps: d.buildUps,
    impacts: d.impacts,
    silences: d.silences,
  };
}
