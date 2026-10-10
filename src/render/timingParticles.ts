import { codeBuffer, writeSignedMs, type CodeBuffer } from './glyphMask';

/**
 * Timing particles: a small number at the hit line showing a hit's signed timing error ("+60"
 * late, "-34" early) that pops up, falls with gravity, drifts sideways (early to the left, late
 * to the right) and fades out. Pure and allocation-free after construction: a fixed pool of
 * slots, reused oldest-first when full. Positions are closed-form functions of the age, so the
 * motion is deterministic and frame-rate independent.
 */
export const PARTICLE_LIFE_MS = 700;
/** Pool size: the most particles on screen at once. */
export const PARTICLE_CAP = 24;
/** Initial upward speed (px/ms, negative = up), gravity (px/ms²) and sideways speed (px/ms). */
export const PARTICLE_VY = -0.05;
export const PARTICLE_GRAVITY = 0.0003;
export const PARTICLE_VX = 0.012;
/** Sideways speed multipliers, cycled per spawn so neighbours separate. */
const SPREAD = [1, 0.55, 1.35, 0.8, 1.15] as const;

export type ParticleTiming = 'early' | 'late';

export interface TimingParticle {
  active: boolean;
  timing: ParticleTiming;
  /** Spawn point (centre of the text) in logical px. */
  x0: number;
  y0: number;
  vx: number;
  /** Song time of the spawn. */
  bornMs: number;
  text: CodeBuffer;
}

/** Whether a judged hit gets a particle: only presses (non-null error) at or over the threshold. */
export function shouldSpawnParticle(
  errorMs: number | null,
  enabled: boolean,
  thresholdMs: number,
): boolean {
  if (!enabled || errorMs === null || !Number.isFinite(errorMs)) return false;
  return Math.abs(errorMs) >= thresholdMs;
}

export function particleTiming(errorMs: number): ParticleTiming {
  return errorMs < 0 ? 'early' : 'late';
}

/** Horizontal offset from the spawn point at `ageMs`, in whole pixels. */
export function particleDx(p: Readonly<TimingParticle>, ageMs: number): number {
  return Math.round(p.vx * ageMs);
}

/** Vertical offset from the spawn point at `ageMs` (down is positive), in whole pixels. */
export function particleDy(ageMs: number): number {
  return Math.round(PARTICLE_VY * ageMs + 0.5 * PARTICLE_GRAVITY * ageMs * ageMs);
}

/** Opacity in 4 steps: solid for the first 40 % of the life, then 3/4, 1/2, 1/4; 0 = gone. */
export function particleAlpha(ageMs: number): number {
  if (ageMs < 0 || ageMs >= PARTICLE_LIFE_MS) return 0;
  const solid = PARTICLE_LIFE_MS * 0.4;
  if (ageMs < solid) return 1;
  const step = Math.floor(((ageMs - solid) / (PARTICLE_LIFE_MS - solid)) * 3);
  return (3 - step) / 4;
}

export class TimingParticles {
  readonly slots: readonly TimingParticle[];
  private next = 0;
  private spawned = 0;

  constructor(capacity = PARTICLE_CAP) {
    this.slots = Array.from({ length: capacity }, () => ({
      active: false,
      timing: 'late' as ParticleTiming,
      x0: 0,
      y0: 0,
      vx: 0,
      bornMs: 0,
      text: codeBuffer(6),
    }));
  }

  /** Start a particle (reusing the oldest slot when the pool is full). */
  spawn(errorMs: number, x: number, y: number, nowMs: number): TimingParticle {
    const p = this.slots[this.next] as TimingParticle;
    this.next = (this.next + 1) % this.slots.length;
    const timing = particleTiming(errorMs);
    const spread = SPREAD[this.spawned % SPREAD.length] as number;
    this.spawned += 1;
    p.active = true;
    p.timing = timing;
    p.x0 = Math.round(x);
    p.y0 = Math.round(y);
    p.vx = (timing === 'early' ? -1 : 1) * PARTICLE_VX * spread;
    p.bornMs = nowMs;
    writeSignedMs(p.text, errorMs);
    return p;
  }

  /** Retire particles that have finished (or lie in the future after a restart). */
  update(nowMs: number): void {
    for (const p of this.slots) {
      if (!p.active) continue;
      const age = nowMs - p.bornMs;
      if (age < 0 || age >= PARTICLE_LIFE_MS) p.active = false;
    }
  }

  clear(): void {
    for (const p of this.slots) p.active = false;
    this.next = 0;
    this.spawned = 0;
  }

  get activeCount(): number {
    let n = 0;
    for (const p of this.slots) if (p.active) n += 1;
    return n;
  }
}
