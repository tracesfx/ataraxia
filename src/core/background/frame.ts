import { frameAt, type AudioAnalysis, type Impact } from '../analysis/types';
import { motionSpeed } from './curves';

/**
 * The audio analysis prepared once for backgrounds: the travel integral (motion that runs
 * faster in intense parts). Particles are then a pure function of song time and this, so seeks,
 * pauses, loops and practice speed changes always show the same picture for the same song time.
 */

export interface BackgroundAnalysis {
  analysis: AudioAnalysis;
  /** travel[n]: integral of motionSpeed(intensity) from 0 to the start of frame n, in seconds. */
  travel: Float64Array;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function prepareBackgroundAnalysis(analysis: AudioAnalysis): BackgroundAnalysis {
  const n = analysis.frameCount;
  const travel = new Float64Array(n + 1);
  const stepSec = analysis.frameMs / 1000;
  for (let i = 0; i < n; i++) {
    travel[i + 1] = (travel[i] as number) + motionSpeed(analysis.intensity[i] as number) * stepSec;
  }
  return { analysis, travel };
}

/**
 * Travel at a song time, in seconds of motion: with reactivity 1 the integral of
 * `motionSpeed(intensity)`, so shapes move faster in intense parts; with reactivity 0 plain song
 * seconds. Continuous and increasing, defined for negative times and past the end, and the same
 * for the same song time however it was reached (seeks, loops, practice speed).
 */
export function travelAt(
  prep: BackgroundAnalysis | null,
  songTimeMs: number,
  reactivity: number,
): number {
  const plain = songTimeMs / 1000;
  const r = clamp01(reactivity);
  if (!prep || r === 0 || prep.analysis.frameCount === 0) return plain;
  const a = prep.analysis;
  const rel = (songTimeMs - a.frameOffsetMs) / a.frameMs;
  const silent = motionSpeed(0);
  let reactive: number;
  if (rel <= 0) {
    reactive = ((songTimeMs - a.frameOffsetMs) / 1000) * silent;
  } else if (rel >= a.frameCount) {
    const end = prep.travel[a.frameCount] as number;
    reactive = end + ((rel - a.frameCount) * a.frameMs * silent) / 1000;
  } else {
    const i = Math.floor(rel);
    const lo = prep.travel[i] as number;
    const hi = prep.travel[i + 1] as number;
    reactive = lo + (hi - lo) * (rel - i);
  }
  return plain + (reactive - plain) * r;
}

/** Index of the last impact at or before `ms` (-1 for none). Impacts are sorted by time. */
export function lastImpactIndex(impacts: readonly Impact[], ms: number): number {
  let lo = 0;
  let hi = impacts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((impacts[mid] as Impact).t <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export interface SongTiming {
  bpm: number;
  offsetMs: number;
}

/** Whether the song time lies inside the analysed audio. */
export function insideAnalysis(a: AudioAnalysis, songTimeMs: number): boolean {
  return (
    a.frameCount > 0 &&
    songTimeMs >= a.frameOffsetMs - a.frameMs &&
    songTimeMs <= a.frameOffsetMs + a.frameCount * a.frameMs
  );
}

/** A curve's value at a song time (0 outside the audio). */
export function curveAt(a: AudioAnalysis, curve: Float32Array, songTimeMs: number): number {
  return insideAnalysis(a, songTimeMs) ? (curve[frameAt(a, songTimeMs)] as number) : 0;
}
