import { describe, expect, it } from 'vitest';
import type { Lane, Note } from './chart';
import { DENSITY_LEVELS, densityBins, densityLevel } from './noteDensity';

const tap = (t: number, lane: Lane = 0): Note => ({ t, lane, type: 'tap' });

describe('densityBins', () => {
  it('counts notes per second around each bin', () => {
    // 4 notes per second from 10 s to 20 s.
    const notes: Note[] = [];
    for (let t = 10_000; t < 20_000; t += 250) notes.push(tap(t));
    const bins = densityBins(notes, 0, 30_000, 30);
    expect(bins[2]).toBe(0);
    expect(bins[15]).toBeCloseTo(4, 6);
    expect(bins[25]).toBe(0);
  });

  it('averages over at least a second when bins are short', () => {
    const notes = [tap(1000), tap(1100, 1)];
    const bins = densityBins(notes, 0, 2000, 200);
    // Each 10 ms bin around 1 s sees both notes in its 1 s window: 2 nps, not 200.
    expect(Math.max(...bins)).toBeCloseTo(2, 6);
  });

  it('uses the bin width when bins are longer than a second', () => {
    const notes = [tap(0), tap(500), tap(4000)];
    const bins = densityBins(notes, 0, 10_000, 2);
    expect(bins[0]).toBeCloseTo(3 / 5, 6);
    expect(bins[1]).toBe(0);
  });

  it('includes the region before the song', () => {
    const bins = densityBins([tap(-5000), tap(-4800)], -10_000, 0, 10);
    expect(bins[5]).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    expect(densityBins([], 0, 1000, 10).every((v) => v === 0)).toBe(true);
    expect(densityBins([tap(0)], 0, 0, 10).length).toBe(10);
    expect(densityBins([tap(0)], 0, 1000, 0).length).toBe(0);
  });
});

describe('densityLevel', () => {
  it('puts densities in flat bands', () => {
    expect(densityLevel(0)).toBe(0);
    expect(densityLevel(0.5)).toBe(1);
    expect(densityLevel(2.5)).toBe(2);
    expect(densityLevel(6)).toBe(3);
    expect(densityLevel(20)).toBe(DENSITY_LEVELS - 1);
    expect(densityLevel(Number.NaN)).toBe(0);
  });
});
