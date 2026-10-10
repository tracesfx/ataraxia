import { LANE_COUNT } from '../core/constants';
import type { EffectsLevel } from '../core/settings';

/**
 * Lane glow on key press: per lane, a flat translucent column whose opacity rises to a peak in
 * about 30 ms, stays at its peak while the lane key is held down (notes or not) and decays
 * exponentially to nothing in about 200 ms once it is released. A new press retriggers it from the current level (the rise is shortened accordingly). Cosmetic
 * only: driven by real (event and frame) time, never used for judging. Fixed-size typed arrays,
 * so nothing is allocated per press or per frame.
 */
export const LANE_GLOW_ATTACK_MS = 30;

interface GlowShape {
  peak: number;
  /** Time from the peak until the glow is cut to zero. */
  decayMs: number;
}

export const LANE_GLOW_SHAPES: Readonly<Record<EffectsLevel, GlowShape>> = {
  full: { peak: 0.17, decayMs: 200 },
  minimal: { peak: 0.09, decayMs: 130 },
};

/** Opacity at `ageMs` after a press that started from level `from`. */
export function laneGlowLevel(ageMs: number, from: number, shape: GlowShape): number {
  if (!(ageMs >= 0)) return from;
  const start = Math.min(shape.peak, Math.max(0, from));
  const attackMs = LANE_GLOW_ATTACK_MS * (1 - start / shape.peak);
  if (ageMs < attackMs) return start + (shape.peak - start) * (ageMs / attackMs);
  const d = ageMs - attackMs;
  if (d >= shape.decayMs) return 0;
  // Time constant: a quarter of the decay, so the cut happens below 2 % of the peak.
  return shape.peak * Math.exp((-4 * d) / shape.decayMs);
}

export class LaneGlow {
  private readonly pressAt = new Float64Array(LANE_COUNT).fill(Number.NaN);
  private readonly from = new Float64Array(LANE_COUNT);
  /** Current opacity per lane (read by the renderer). */
  readonly levels = new Float32Array(LANE_COUNT);

  /** A lane key went down at `timeMs` (performance time). */
  press(lane: number, timeMs: number, effects: EffectsLevel): void {
    if (lane < 0 || lane >= LANE_COUNT) return;
    this.from[lane] = this.levelAt(lane, timeMs, effects);
    this.pressAt[lane] = timeMs;
  }

  /**
   * Recompute `levels` for `timeMs`. Lanes in `holding` (their key is down) keep the peak once
   * the rise is over; the decay starts from the last frame the key was down.
   */
  update(timeMs: number, effects: EffectsLevel, holding?: readonly boolean[]): void {
    const peak = LANE_GLOW_SHAPES[effects].peak;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const at = this.pressAt[lane] ?? Number.NaN;
      if (holding?.[lane] === true && !Number.isNaN(at)) {
        const from = Math.min(peak, this.from[lane] ?? 0);
        const attackMs = LANE_GLOW_ATTACK_MS * (1 - from / peak);
        if (timeMs - at >= attackMs) {
          // Re-anchor at the peak: "pressed just now, already at the top".
          this.from[lane] = peak;
          this.pressAt[lane] = timeMs;
        }
      }
      this.levels[lane] = this.levelAt(lane, timeMs, effects);
    }
  }

  clear(): void {
    this.pressAt.fill(Number.NaN);
    this.from.fill(0);
    this.levels.fill(0);
  }

  private levelAt(lane: number, timeMs: number, effects: EffectsLevel): number {
    const at = this.pressAt[lane] ?? Number.NaN;
    if (Number.isNaN(at)) return 0;
    // An event can carry a timestamp a little after the frame's time: treat it as age 0.
    return laneGlowLevel(Math.max(0, timeMs - at), this.from[lane] ?? 0, LANE_GLOW_SHAPES[effects]);
  }
}
