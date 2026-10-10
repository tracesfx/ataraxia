/**
 * Intensity-to-parameter curves: how the song's intensity (0-1, song-relative, from the audio
 * analysis) and the reactivity setting turn into motion speed, counts, sizes and brightness.
 * Pure and monotonic, so quiet parts are calm and drops are dramatic.
 */

/** The level a background rests at with reactivity 0 (or without an analysis). */
export const REST_LEVEL = 0.4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Intensity scaled toward the rest level by reactivity (0 = always the rest level). */
export function reactiveLevel(intensity: number, reactivity: number): number {
  const r = clamp01(reactivity);
  return clamp01(REST_LEVEL + (clamp01(intensity) - REST_LEVEL) * r);
}

/** Smooth 0-1 ease (smoothstep). */
export function ease(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Motion speed factor for a level: 0.4 when silent, 1 around the middle, 1.6 at the loudest. The
 * integral of this over song time is a background's travel (see `travelAt`).
 */
export function motionSpeed(level: number): number {
  return 0.4 + 1.2 * clamp01(level);
}

/** A 0-1 value as a whole step 0..steps (for palette ladders). */
export function toStep(v: number, steps: number): number {
  return Math.max(0, Math.min(steps, Math.round(clamp01(v) * steps)));
}
