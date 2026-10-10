import { describe, expect, it } from 'vitest';
import { MAX_SEED, Rng, normalizeSeed, seededRandom } from './random';

describe('seeded random', () => {
  it('repeats the same sequence for the same seed and differs for another', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom(43);
    const seqA = Array.from({ length: 10 }, a);
    expect(Array.from({ length: 10 }, b)).toEqual(seqA);
    expect(Array.from({ length: 10 }, c)).not.toEqual(seqA);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('normalises any number to an unsigned 32-bit seed', () => {
    expect(normalizeSeed(5.9)).toBe(5);
    expect(normalizeSeed(-7)).toBe(7);
    expect(normalizeSeed(MAX_SEED + 3)).toBe(2);
    expect(normalizeSeed(Number.NaN)).toBe(1);
  });

  it('keeps Rng helpers within bounds and picks by weight', () => {
    const rng = new Rng(9);
    const counts = { a: 0, b: 0, c: 0 };
    const weights = { a: 1, b: 3, c: 0 } as const;
    for (let i = 0; i < 4000; i++) {
      const n = rng.int(5);
      expect(Number.isInteger(n) && n >= 0 && n < 5).toBe(true);
      const w = rng.weighted(['a', 'b', 'c'] as const, (k) => weights[k]);
      if (w) counts[w] += 1;
    }
    expect(counts.c).toBe(0);
    expect(counts.b / counts.a).toBeGreaterThan(2.5);
    expect(counts.b / counts.a).toBeLessThan(3.5);
    expect(rng.pick([])).toBeUndefined();
    expect(rng.weighted([1, 2], () => 0)).toBeUndefined();
  });

  it('gives the same stream for the same seed through Rng', () => {
    const a = new Rng(77);
    const b = new Rng(77);
    for (let i = 0; i < 50; i++) expect(a.float()).toBe(b.float());
  });
});
