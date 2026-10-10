import type { Onset } from '../onsets';
import type { TempoEstimate } from '../tempo';

/**
 * The result of analysing one song's audio: frame-rate feature curves, the song's relative
 * intensity, detected onsets with their band make-up, build-ups, impacts and silences. Pure data
 * (typed arrays and plain objects), so it can be posted from a worker, stored in IndexedDB and
 * reused by the chart generator and, later, by animated backgrounds.
 *
 * All curves share one frame grid: frame `n` is centred on song time `frameOffsetMs + n *
 * frameMs` (see `frameAt` / `valueAt`).
 */

/** Bump when the analysis changes meaning, so cached analyses are recomputed. */
export const ANALYSIS_VERSION = 1;

/** Feature frame rate: one frame every 20 ms. */
export const FEATURE_FRAME_MS = 20;

/** Band edges in Hz: low is under LOW_BAND_MAX_HZ (kick, bass), high above MID_BAND_MAX_HZ. */
export const LOW_BAND_MAX_HZ = 150;
export const MID_BAND_MAX_HZ = 2500;

export interface Bands<T> {
  low: T;
  mid: T;
  high: T;
}

/** An onset (precise time from the 6 ms onset detector) with its band make-up. */
export interface AnalysisOnset extends Onset {
  /** Onset strength in each band at this time, relative to the band's strong onsets (~0-1+). */
  low: number;
  mid: number;
  high: number;
  /** 0-1: how evenly the three bands take part (1 = a hit in every band, 0 = one band only). */
  broadband: number;
}

/** A section where loudness and brightness rise steadily while drums stay sparse or flat. */
export interface BuildUp {
  startMs: number;
  endMs: number;
  /** 0-1: how much loudness and brightness rose across it. */
  rise: number;
}

/**
 * A standout hit: low-band or broadband onset strength well above the song's usual (about its
 * 90th percentile) and above its neighbourhood. `drop` when it comes right after a build-up or
 * a silence.
 */
export interface Impact {
  t: number;
  /** 0-1. */
  strength: number;
  kind: 'drop' | 'hit';
  afterBuildUp: boolean;
  afterSilence: boolean;
  /** Mostly low band (kick, bass drop) rather than broadband. */
  lowHeavy: boolean;
}

/** A stretch of (near) silence. */
export interface Silence {
  startMs: number;
  endMs: number;
}

export interface AudioAnalysis {
  version: typeof ANALYSIS_VERSION;
  durationMs: number;
  frameMs: number;
  frameOffsetMs: number;
  frameCount: number;
  /** Beat length the smoothing used (from the detected tempo, folded into 70-180 BPM). */
  beatMs: number;
  /** RMS level per frame, 0-1 for full scale. */
  rms: Float32Array;
  /** Loudness 0-1: RMS in dB between the song's 5th and 95th percentiles. */
  loudness: Float32Array;
  /** Band amplitude per frame (RMS of the band's spectrum). */
  bands: Bands<Float32Array>;
  /** Onset strength (spectral flux) per band, relative to the band's strong onsets (p98 = 1). */
  bandFlux: Bands<Float32Array>;
  /** All bands' flux combined, p98 = 1. */
  onsetEnvelope: Float32Array;
  /** Brightness 0-1: spectral centroid between the song's 5th and 95th percentiles. */
  brightness: Float32Array;
  /** Onsets per second around each frame (one beat each side). */
  onsetDensity: Float32Array;
  /**
   * 0-1, relative to the song itself: loudness, onset density, low-band punch and brightness,
   * each scaled by the song's 5th-95th percentiles, combined, smoothed over about one beat and
   * rescaled.
   */
  intensity: Float32Array;
  onsets: AnalysisOnset[];
  tempo: TempoEstimate;
  buildUps: BuildUp[];
  impacts: Impact[];
  silences: Silence[];
}

/** Frame index nearest to song time `ms`, clamped to the analysis. */
export function frameAt(
  a: Pick<AudioAnalysis, 'frameMs' | 'frameOffsetMs' | 'frameCount'>,
  ms: number,
): number {
  const n = Math.round((ms - a.frameOffsetMs) / a.frameMs);
  return Math.min(a.frameCount - 1, Math.max(0, n));
}

/** Song time of frame `n`. */
export function frameTime(a: Pick<AudioAnalysis, 'frameMs' | 'frameOffsetMs'>, n: number): number {
  return a.frameOffsetMs + n * a.frameMs;
}

/** A curve's value at song time `ms` (nearest frame; 0 before the audio or for no frames). */
export function valueAt(
  a: Pick<AudioAnalysis, 'frameMs' | 'frameOffsetMs' | 'frameCount'>,
  curve: Float32Array,
  ms: number,
): number {
  if (a.frameCount === 0 || ms < a.frameOffsetMs - a.frameMs) return 0;
  return curve[frameAt(a, ms)] ?? 0;
}

/** Mean of a curve over [fromMs, toMs]. */
export function meanOver(
  a: Pick<AudioAnalysis, 'frameMs' | 'frameOffsetMs' | 'frameCount'>,
  curve: Float32Array,
  fromMs: number,
  toMs: number,
): number {
  if (a.frameCount === 0) return 0;
  const lo = frameAt(a, Math.min(fromMs, toMs));
  const hi = frameAt(a, Math.max(fromMs, toMs));
  let sum = 0;
  for (let n = lo; n <= hi; n++) sum += curve[n] as number;
  return sum / (hi - lo + 1);
}

/** Every typed array in an analysis (for transferring it out of a worker). */
export function analysisBuffers(a: AudioAnalysis): ArrayBuffer[] {
  return [
    a.rms,
    a.loudness,
    a.bands.low,
    a.bands.mid,
    a.bands.high,
    a.bandFlux.low,
    a.bandFlux.mid,
    a.bandFlux.high,
    a.onsetEnvelope,
    a.brightness,
    a.onsetDensity,
    a.intensity,
  ].map((arr) => arr.buffer as ArrayBuffer);
}
