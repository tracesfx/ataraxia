import { describe, expect, it } from 'vitest';
import { bufferText } from './glyphMask';
import {
  PARTICLE_CAP,
  PARTICLE_LIFE_MS,
  TimingParticles,
  particleAlpha,
  particleDx,
  particleDy,
  shouldSpawnParticle,
} from './timingParticles';

describe('shouldSpawnParticle', () => {
  it('spawns at or above the threshold only', () => {
    expect(shouldSpawnParticle(40, true, 40)).toBe(true);
    expect(shouldSpawnParticle(-41, true, 40)).toBe(true);
    expect(shouldSpawnParticle(39.9, true, 40)).toBe(false);
    expect(shouldSpawnParticle(-80, true, 80)).toBe(true);
    expect(shouldSpawnParticle(79, true, 80)).toBe(false);
  });

  it('threshold 0 shows every press, including a perfect 0 ms', () => {
    expect(shouldSpawnParticle(0, true, 0)).toBe(true);
    expect(shouldSpawnParticle(-3, true, 0)).toBe(true);
  });

  it('never spawns for notes that were not pressed, or when turned off', () => {
    expect(shouldSpawnParticle(null, true, 0)).toBe(false);
    expect(shouldSpawnParticle(100, false, 0)).toBe(false);
    expect(shouldSpawnParticle(Number.NaN, true, 0)).toBe(false);
  });
});

describe('TimingParticles', () => {
  it('formats the signed error and picks early/late', () => {
    const pool = new TimingParticles();
    const late = pool.spawn(60.4, 100, 200, 0);
    expect(bufferText(late.text)).toBe('+60');
    expect(late.timing).toBe('late');
    expect(late.vx).toBeGreaterThan(0);
    const early = pool.spawn(-34, 100, 200, 0);
    expect(bufferText(early.text)).toBe('-34');
    expect(early.timing).toBe('early');
    expect(early.vx).toBeLessThan(0);
  });

  it('has deterministic, whole-pixel motion: a small pop up, then a fall', () => {
    const a = new TimingParticles().spawn(50, 10, 10, 1000);
    const b = new TimingParticles().spawn(50, 10, 10, 5000);
    for (const age of [0, 16, 100, 167, 333, 500, 699]) {
      expect(particleDx(a, age)).toBe(particleDx(b, age));
      expect(Number.isInteger(particleDx(a, age))).toBe(true);
      expect(Number.isInteger(particleDy(age))).toBe(true);
    }
    expect(particleDy(0)).toBe(0);
    expect(particleDy(150)).toBeLessThan(0);
    expect(particleDy(PARTICLE_LIFE_MS)).toBeGreaterThan(20);
    expect(Math.abs(particleDx(a, PARTICLE_LIFE_MS))).toBeLessThanOrEqual(16);
  });

  it('fades out in 4 steps over its life', () => {
    expect(particleAlpha(0)).toBe(1);
    const seen = new Set<number>();
    for (let t = 0; t < PARTICLE_LIFE_MS; t += 5) seen.add(particleAlpha(t));
    expect([...seen].sort()).toEqual([0.25, 0.5, 0.75, 1]);
    expect(particleAlpha(PARTICLE_LIFE_MS)).toBe(0);
    expect(particleAlpha(-1)).toBe(0);
  });

  it('caps the pool and reuses the oldest slot', () => {
    const pool = new TimingParticles();
    for (let i = 0; i < PARTICLE_CAP + 5; i++) pool.spawn(i + 1, 0, 0, i);
    expect(pool.slots).toHaveLength(PARTICLE_CAP);
    expect(pool.activeCount).toBe(PARTICLE_CAP);
    // The first five slots were overwritten by the newest particles.
    expect(bufferText((pool.slots[0] as (typeof pool.slots)[number]).text)).toBe(
      `+${PARTICLE_CAP + 1}`,
    );
  });

  it('retires finished particles and clears on restart', () => {
    const pool = new TimingParticles();
    pool.spawn(50, 0, 0, 0);
    pool.spawn(50, 0, 0, 600);
    pool.update(PARTICLE_LIFE_MS + 1);
    expect(pool.activeCount).toBe(1);
    pool.update(-100); // time jumped back (a restart): nothing from the future survives
    expect(pool.activeCount).toBe(0);
    pool.spawn(50, 0, 0, 0);
    pool.clear();
    expect(pool.activeCount).toBe(0);
  });
});
