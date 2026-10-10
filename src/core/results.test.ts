import { describe, expect, it } from 'vitest';
import type { Note } from './chart';
import { PlaySession } from './playSession';
import {
  badgesFor,
  buildPlayResult,
  rankFor,
  rankIndex,
  timingHistogram,
  timingSide,
} from './results';

describe('rankFor', () => {
  it('uses inclusive thresholds S95 A90 B80 C70', () => {
    expect(rankFor(100)).toBe('S');
    expect(rankFor(95)).toBe('S');
    expect(rankFor(94.99)).toBe('A');
    expect(rankFor(90)).toBe('A');
    expect(rankFor(89.99)).toBe('B');
    expect(rankFor(80)).toBe('B');
    expect(rankFor(79.99)).toBe('C');
    expect(rankFor(70)).toBe('C');
    expect(rankFor(69.99)).toBe('D');
    expect(rankFor(0)).toBe('D');
  });

  it('orders ranks best first', () => {
    expect(rankIndex('S')).toBeLessThan(rankIndex('A'));
    expect(rankIndex('C')).toBeLessThan(rankIndex('D'));
  });
});

describe('badgesFor', () => {
  const counts = (perfect: number, great = 0, good = 0, miss = 0) => ({
    perfect,
    great,
    good,
    miss,
  });

  it('all Perfect earns both badges', () => {
    expect(badgesFor(counts(10), 0, 10)).toEqual({ fullCombo: true, allPerfect: true });
  });

  it('no misses with some Greats is a full combo only', () => {
    expect(badgesFor(counts(8, 1, 1), 0, 10)).toEqual({ fullCombo: true, allPerfect: false });
  });

  it('a miss or a dropped hold breaks the full combo', () => {
    expect(badgesFor(counts(9, 0, 0, 1), 0, 10).fullCombo).toBe(false);
    expect(badgesFor(counts(9, 0, 1), 1, 10)).toEqual({ fullCombo: false, allPerfect: false });
  });

  it('an empty chart earns nothing', () => {
    expect(badgesFor(counts(0), 0, 0)).toEqual({ fullCombo: false, allPerfect: false });
  });
});

describe('timingHistogram', () => {
  it('has 24 bins of 10 ms from -120 to +120', () => {
    const h = timingHistogram([]);
    expect(h.bins).toHaveLength(24);
    expect(h.averageMs).toBeNull();
    expect(h.count).toBe(0);
  });

  it('puts bin edges in the upper bin and +120 in the last bin', () => {
    const h = timingHistogram([-120, -110.5, -110, 0, -0.1, 9.9, 119, 120]);
    expect(h.bins[0]).toBe(2); // -120, -110.5
    expect(h.bins[1]).toBe(1); // -110
    expect(h.bins[11]).toBe(1); // -0.1
    expect(h.bins[12]).toBe(2); // 0, 9.9
    expect(h.bins[23]).toBe(2); // 119, 120
    expect(h.outside).toBe(0);
  });

  it('counts out-of-range errors separately but includes them in the average', () => {
    const h = timingHistogram([-200, 20, 30]);
    expect(h.outside).toBe(1);
    expect(h.bins.reduce((a, b) => a + b, 0)).toBe(2);
    expect(h.averageMs).toBeCloseTo(-50);
  });

  it('computes the average error', () => {
    expect(timingHistogram([10, 20, 30, -20]).averageMs).toBe(10);
  });
});

describe('timingSide', () => {
  it('Perfect hits are neither early nor late', () => {
    expect(timingSide(40)).toBeNull();
    expect(timingSide(-40)).toBeNull();
    expect(timingSide(-41)).toBe('early');
    expect(timingSide(41)).toBe('late');
  });
});

describe('buildPlayResult', () => {
  it('summarises a play: counts, drops, early/late, histogram, rank and badges', () => {
    const notes: Note[] = [
      { t: 1000, lane: 0, type: 'tap' },
      { t: 2000, lane: 1, type: 'tap' },
      { t: 3000, lane: 2, type: 'tap' },
      { t: 4000, lane: 3, type: 'hold', dur: 1000 },
      { t: 6000, lane: 0, type: 'tap' },
    ];
    const s = new PlaySession(notes);
    s.press(0, 1010); // perfect
    s.press(1, 1940); // great, early
    s.press(2, 3090); // good, late
    s.press(3, 4000); // hold head perfect
    s.release(3, 4200); // dropped
    s.update(7000); // last note missed
    const r = buildPlayResult(s.notes, s.summary());
    expect(r.counts).toEqual({ perfect: 1, great: 1, good: 2, miss: 1 });
    expect(r.drops).toBe(1);
    expect(r.early).toBe(1);
    expect(r.late).toBe(1);
    expect(r.histogram.count).toBe(4);
    expect(r.histogram.averageMs).toBeCloseTo((10 - 60 + 90 + 0) / 4);
    expect(r.badges).toEqual({ fullCombo: false, allPerfect: false });
    expect(r.rank).toBe('D');
    expect(r.totalNotes).toBe(5);
  });

  it('an all-Perfect play is rank S with both badges', () => {
    const s = new PlaySession([
      { t: 1000, lane: 0, type: 'tap' },
      { t: 1500, lane: 1, type: 'tap' },
    ]);
    s.press(0, 1000);
    s.press(1, 1520);
    const r = buildPlayResult(s.notes, s.summary());
    expect(r.score).toBe(1_000_000);
    expect(r.rank).toBe('S');
    expect(r.badges).toEqual({ fullCombo: true, allPerfect: true });
  });
});
