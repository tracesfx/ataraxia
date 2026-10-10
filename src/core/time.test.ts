import { describe, expect, it } from 'vitest';
import {
  SNAP_DIVISIONS,
  beatLengthMs,
  formatSongTime,
  beatToMs,
  msToBeat,
  snapToGrid,
  type SnapDivision,
} from './time';

describe('beatLengthMs', () => {
  it('computes ms per beat', () => {
    expect(beatLengthMs(120)).toBe(500);
    expect(beatLengthMs(150)).toBe(400);
    expect(beatLengthMs(128.5)).toBeCloseTo(466.926, 3);
  });

  it('rejects non-positive or non-finite BPM', () => {
    expect(() => beatLengthMs(0)).toThrow(RangeError);
    expect(() => beatLengthMs(-120)).toThrow(RangeError);
    expect(() => beatLengthMs(Number.NaN)).toThrow(RangeError);
    expect(() => beatLengthMs(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('msToBeat / beatToMs', () => {
  it('beat 0 is at the offset', () => {
    expect(msToBeat(320, 150, 320)).toBe(0);
    expect(beatToMs(0, 150, 320)).toBe(320);
  });

  it('converts whole and fractional beats', () => {
    expect(msToBeat(720, 150, 320)).toBe(1);
    expect(msToBeat(520, 150, 320)).toBe(0.5);
    expect(beatToMs(4, 150, 320)).toBe(1920);
    expect(beatToMs(0.25, 120, 0)).toBe(125);
  });

  it('gives negative beats before the offset', () => {
    expect(msToBeat(0, 150, 320)).toBeCloseTo(-0.8, 10);
    expect(msToBeat(-80, 150, 320)).toBe(-1);
    expect(beatToMs(-2, 120, 100)).toBe(-900);
  });

  it('handles fractional BPM', () => {
    const bpm = 128.5;
    expect(beatToMs(1, bpm, 0)).toBeCloseTo(60000 / 128.5, 9);
    expect(msToBeat(beatToMs(37.75, bpm, 250), bpm, 250)).toBeCloseTo(37.75, 9);
  });

  it('round-trips over a wide range', () => {
    for (const bpm of [60, 99.9, 128.5, 174, 300]) {
      for (const beat of [-16, -1.5, 0, 0.333, 7.125, 1000]) {
        expect(msToBeat(beatToMs(beat, bpm, -45), bpm, -45)).toBeCloseTo(beat, 9);
      }
    }
  });
});

describe('snapToGrid', () => {
  it('snaps to the nearest beat with division 1', () => {
    // 120 BPM, offset 0: grid every 500 ms
    expect(snapToGrid(0, 120, 0, 1)).toBe(0);
    expect(snapToGrid(240, 120, 0, 1)).toBe(0);
    expect(snapToGrid(260, 120, 0, 1)).toBe(500);
    expect(snapToGrid(1499, 120, 0, 1)).toBe(1500);
  });

  it('respects the offset', () => {
    // 150 BPM: 400 ms beats starting at 320
    expect(snapToGrid(700, 150, 320, 1)).toBe(720);
    expect(snapToGrid(500, 150, 320, 1)).toBe(320);
    expect(snapToGrid(530, 150, 320, 2)).toBe(520);
  });

  it('snaps times before the offset onto the negative grid', () => {
    // offset 320, 400 ms beats: grid lines at ..., -480, -80, 320
    expect(snapToGrid(0, 150, 320, 1)).toBe(-80);
    expect(snapToGrid(-300, 150, 320, 1)).toBe(-480);
    expect(snapToGrid(-100, 150, 320, 4)).toBe(-80);
    expect(snapToGrid(130, 150, 320, 4)).toBe(120);
  });

  it('never returns -0', () => {
    expect(Object.is(snapToGrid(-1, 120, 0, 4), 0)).toBe(true);
  });

  it('supports every division', () => {
    // 120 BPM, offset 0 -> step = 500 / division
    const expected: Record<SnapDivision, number> = {
      1: 500,
      2: 250,
      3: 333,
      4: 375,
      6: 333,
      8: 375,
      12: 333,
      16: 344,
    };
    for (const d of SNAP_DIVISIONS) {
      expect(snapToGrid(350, 120, 0, d), `division ${d}`).toBe(expected[d]);
    }
  });

  it('handles triplet divisions exactly on grid lines', () => {
    // 100 BPM: 600 ms beats; 1/3 = 200 ms, 1/12 = 50 ms
    expect(snapToGrid(200, 100, 0, 3)).toBe(200);
    expect(snapToGrid(1250, 100, 0, 12)).toBe(1250);
    expect(snapToGrid(1274, 100, 0, 12)).toBe(1250);
  });

  it('handles fractional BPM and returns integer ms', () => {
    const bpm = 128.5;
    const beat = 60000 / bpm; // ~466.93 ms
    const snapped = snapToGrid(10 * beat + 30, bpm, 0, 4);
    expect(Number.isInteger(snapped)).toBe(true);
    expect(snapped).toBe(Math.round(10 * beat));
    // Snapping is stable: a snapped value snaps to itself.
    for (let ms = -2000; ms < 5000; ms += 37) {
      for (const d of SNAP_DIVISIONS) {
        const s = snapToGrid(ms, bpm, 13, d);
        expect(snapToGrid(s, bpm, 13, d)).toBe(s);
      }
    }
  });

  it('rejects unsupported divisions', () => {
    expect(() => snapToGrid(0, 120, 0, 5 as SnapDivision)).toThrow(RangeError);
    expect(() => snapToGrid(0, 120, 0, 0 as SnapDivision)).toThrow(RangeError);
  });
});

describe('formatSongTime', () => {
  it('formats m:ss.t and clamps negatives to zero', () => {
    expect(formatSongTime(72_350)).toBe('1:12.4');
    expect(formatSongTime(0)).toBe('0:00.0');
    expect(formatSongTime(9_960)).toBe('0:10.0');
    expect(formatSongTime(-500)).toBe('0:00.0');
  });
});

describe('negative song time (before the audio starts)', () => {
  it('converts negative song times to beats and back', () => {
    // 120 BPM, beat 0 at 320 ms: song time -2180 is five beats earlier.
    expect(msToBeat(-2180, 120, 320)).toBe(-5);
    expect(beatToMs(-5, 120, 320)).toBe(-2180);
    expect(msToBeat(-30000, 150, 0)).toBe(-75);
    for (const ms of [-29999, -12345.5, -1, 0]) {
      expect(beatToMs(msToBeat(ms, 133.3, -40), 133.3, -40)).toBeCloseTo(ms, 6);
    }
  });

  it('snaps negative song times onto the grid', () => {
    expect(snapToGrid(-1060, 120, 0, 4)).toBe(-1000);
    expect(snapToGrid(-1070, 120, 0, 4)).toBe(-1125);
    expect(snapToGrid(-2950, 150, 320, 3)).toBe(-3013);
    expect(snapToGrid(-2900, 150, 320, 3)).toBe(-2880);
    expect(snapToGrid(-30010, 120, 0, 16)).toBe(-30000);
    expect(Object.is(snapToGrid(-10, 120, 0, 4), -0)).toBe(false);
  });
});
