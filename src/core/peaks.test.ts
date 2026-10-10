import { describe, expect, it } from 'vitest';
import { buildPeakPyramid, mixToMono, peakRange, pyramidBuffers } from './peaks';

/** Quiet noise-free signal with a few known spikes. */
function spikes(length: number, at: Record<number, number>): Float32Array {
  const s = new Float32Array(length);
  for (let i = 0; i < length; i++) s[i] = 0.1 * Math.sin(i / 7);
  for (const [i, v] of Object.entries(at)) s[Number(i)] = v;
  return s;
}

/** Brute-force min/max over a range. */
function exact(s: Float32Array, start: number, end: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < end; i++) {
    min = Math.min(min, s[i] as number);
    max = Math.max(max, s[i] as number);
  }
  return { min, max };
}

describe('mixToMono', () => {
  it('averages channels', () => {
    const l = Float32Array.from([1, 0, -1, 0.5]);
    const r = Float32Array.from([0, 0, 1, 0.5]);
    expect(Array.from(mixToMono([l, r]))).toEqual([0.5, 0, 0, 0.5]);
  });

  it('passes a single channel through and handles no channels', () => {
    const m = Float32Array.from([0.25]);
    expect(mixToMono([m])).toBe(m);
    expect(mixToMono([])).toHaveLength(0);
  });
});

describe('buildPeakPyramid', () => {
  it('halves each level down to a single bucket', () => {
    const p = buildPeakPyramid(new Float32Array(1000), 48000, 16);
    expect(p.length).toBe(1000);
    expect(p.levels.map((l) => l.min.length)).toEqual([63, 32, 16, 8, 4, 2, 1]);
    expect(p.levels.map((l) => l.bucketSize)).toEqual([16, 32, 64, 128, 256, 512, 1024]);
  });

  it('finds known peaks on every level', () => {
    const s = spikes(10_000, { 1234: 0.9, 5000: -0.8, 9999: 0.95 });
    const p = buildPeakPyramid(s, 44100, 64);
    // Level 0: the bucket containing each spike holds it.
    expect(p.levels[0]?.max[Math.floor(1234 / 64)]).toBeCloseTo(0.9, 6);
    expect(p.levels[0]?.min[Math.floor(5000 / 64)]).toBeCloseTo(-0.8, 6);
    expect(p.levels[0]?.max[Math.floor(9999 / 64)]).toBeCloseTo(0.95, 6);
    // The top level covers everything.
    const top = p.levels[p.levels.length - 1];
    expect(top?.max[0]).toBeCloseTo(0.95, 6);
    expect(top?.min[0]).toBeCloseTo(-0.8, 6);
    // Every level's global extremes match the signal's.
    for (const level of p.levels) {
      expect(Math.max(...level.max)).toBeCloseTo(0.95, 6);
      expect(Math.min(...level.min)).toBeCloseTo(-0.8, 6);
    }
  });

  it('reduces a 5-minute song quickly', () => {
    const sampleRate = 48000;
    const s = new Float32Array(sampleRate * 300);
    for (let i = 0; i < s.length; i += 997) s[i] = ((i % 2000) - 1000) / 1000;
    const t0 = performance.now();
    const p = buildPeakPyramid(s, sampleRate);
    const elapsed = performance.now() - t0;
    expect(p.levels[0]?.min.length).toBe(Math.ceil(s.length / 64));
    // Generous bound for slow CI machines; typically ~50 ms.
    expect(elapsed).toBeLessThan(2000);
  });

  it('rejects a bad bucket size', () => {
    expect(() => buildPeakPyramid(new Float32Array(10), 44100, 0)).toThrow(RangeError);
  });
});

describe('peakRange', () => {
  const s = spikes(100_000, { 10: 0.5, 31_337: 0.99, 31_338: -0.97, 77_777: 0.7 });
  const p = buildPeakPyramid(s, 44100, 64);

  it('contains the exact extremes of any range (never misses a peak)', () => {
    const ranges: [number, number][] = [
      [0, 100_000],
      [31_000, 32_000],
      [31_337, 31_338],
      [70_000, 80_000],
      [12_345, 12_999],
      [500, 501],
    ];
    for (const [a, b] of ranges) {
      const r = peakRange(p, a, b);
      const e = exact(s, a, b);
      expect(r).not.toBeNull();
      expect(r?.max).toBeGreaterThanOrEqual(e.max - 1e-6);
      expect(r?.min).toBeLessThanOrEqual(e.min + 1e-6);
    }
  });

  it('is exact for ranges aligned to buckets', () => {
    for (const [a, b] of [
      [0, 64],
      [31_296, 31_360],
      [0, 100_000],
      [65_536, 98_304],
    ] as const) {
      const r = peakRange(p, a, b);
      const e = exact(s, a, b);
      expect(r?.max).toBeCloseTo(e.max, 6);
      expect(r?.min).toBeCloseTo(e.min, 6);
    }
  });

  it('widens by at most one bucket of the level used', () => {
    // A range of 2000 samples away from the spikes picks a level with buckets <= 2000.
    const r = peakRange(p, 40_000, 42_000);
    const widened = exact(s, 40_000 - 1024, 42_000 + 1024);
    expect(r?.max).toBeLessThanOrEqual(widened.max + 1e-6);
    expect(r?.min).toBeGreaterThanOrEqual(widened.min - 1e-6);
  });

  it('returns null outside the signal and clips partial ranges', () => {
    expect(peakRange(p, -500, -10)).toBeNull();
    expect(peakRange(p, 100_000, 100_500)).toBeNull();
    expect(peakRange(p, 99_990, 100_500)?.max).toBeGreaterThanOrEqual(
      exact(s, 99_990, 100_000).max - 1e-6,
    );
    expect(peakRange(p, -100, 20)?.max).toBeCloseTo(0.5, 6);
  });

  it('lists every array for transfer', () => {
    expect(pyramidBuffers(p)).toHaveLength(p.levels.length * 2);
  });
});
