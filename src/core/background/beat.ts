/**
 * Beat maths for backgrounds, from the chart's `bpm` and `offsetMs` (the time of beat 0). Works
 * for any song time, including the negative lead-in before the audio (Phase 8): beat indices
 * below zero are counted backwards from beat 0, so the pulse keeps its rhythm through the lead-in.
 *
 * Everything is a function of song time (never wall-clock time), so practice-mode speed changes,
 * seeks and pauses keep the background in step with the music: at half speed, song time and
 * therefore the beat phase advance half as fast.
 */

export const BEATS_PER_BAR = 4;

export interface BeatInfo {
  /** Beat number (floor), negative before beat 0. */
  index: number;
  /** 0-1 position inside the beat. */
  phase: number;
  /** Song time since the beat started (>= 0). */
  sinceMs: number;
  beatMs: number;
  /** First beat of a 4/4 bar (index divisible by 4, also for negative indices). */
  downbeat: boolean;
}

/** Positive modulo (for negative beat indices). */
export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function beatLengthMs(bpm: number): number {
  return bpm > 0 && Number.isFinite(bpm) ? 60000 / bpm : 500;
}

export function isDownbeat(index: number): boolean {
  return mod(index, BEATS_PER_BAR) === 0;
}

export function createBeatInfo(): BeatInfo {
  return { index: 0, phase: 0, sinceMs: 0, beatMs: 500, downbeat: true };
}

/** The beat at `songTimeMs`, written into `out` (no allocation). */
export function beatAt(songTimeMs: number, bpm: number, offsetMs: number, out: BeatInfo): BeatInfo {
  const beatMs = beatLengthMs(bpm);
  const beats = (songTimeMs - offsetMs) / beatMs;
  const index = Math.floor(beats);
  out.index = index;
  out.phase = beats - index;
  out.sinceMs = out.phase * beatMs;
  out.beatMs = beatMs;
  out.downbeat = isDownbeat(index);
  return out;
}

/** Song time at which beat `index` starts. */
export function beatTimeMs(index: number, bpm: number, offsetMs: number): number {
  return offsetMs + index * beatLengthMs(bpm);
}

/**
 * The pulse envelope over one beat: 1 at the beat, an exponential decay over `decayBeats` (the
 * time constant, in beats) and 0 by the next beat. A function of the phase only, so it is the
 * same at any playback speed.
 */
export function pulseEnvelope(phase: number, decayBeats = 0.22): number {
  if (!(phase >= 0) || phase >= 1) return 0;
  const raw = Math.exp(-phase / Math.max(1e-3, decayBeats));
  const tail = Math.exp(-1 / Math.max(1e-3, decayBeats));
  // Shift down so the envelope reaches exactly 0 at the next beat (no step at the boundary).
  return Math.max(0, (raw - tail) / (1 - tail));
}

/** Weight of a beat in a bar: the downbeat is strongest. */
export const DOWNBEAT_WEIGHT = 1;
export const OFFBEAT_WEIGHT = 0.55;

/** The beat pulse at a song time: the envelope, weighted by downbeat. 0-1. */
export function beatPulse(
  songTimeMs: number,
  bpm: number,
  offsetMs: number,
  scratch: BeatInfo = createBeatInfo(),
  decayBeats?: number,
): number {
  const b = beatAt(songTimeMs, bpm, offsetMs, scratch);
  return pulseEnvelope(b.phase, decayBeats) * (b.downbeat ? DOWNBEAT_WEIGHT : OFFBEAT_WEIGHT);
}
