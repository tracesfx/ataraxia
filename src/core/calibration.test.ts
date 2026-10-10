import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_MIN_TAPS,
  calibrationClicks,
  computeCalibration,
  median,
  nearestDeviation,
} from './calibration';

const { counted: clicks } = calibrationClicks(120, 4, 20); // 0, 500, ..., 9500

/** One tap per click, shifted by `offsets[i]` (cycled). */
function taps(offsets: number[]): number[] {
  return clicks.map((c, i) => c + (offsets[i % offsets.length] as number));
}

describe('median / nearestDeviation', () => {
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it('finds the signed distance to the nearest click', () => {
    expect(nearestDeviation(530, clicks)).toBe(30);
    expect(nearestDeviation(980, clicks)).toBe(-20);
    expect(nearestDeviation(5, [])).toBeNaN();
  });
});

describe('calibrationClicks', () => {
  it('gives 4 lead-in clicks before 0 and 20 counted clicks from 0 at 120 BPM', () => {
    const c = calibrationClicks();
    expect(c.leadIn).toEqual([-2000, -1500, -1000, -500]);
    expect(c.counted).toHaveLength(20);
    expect(c.counted[0]).toBe(0);
    expect(c.counted[19]).toBe(9500);
  });
});

describe('computeCalibration', () => {
  it('a consistently late player gets a positive offset', () => {
    const r = computeCalibration(taps([28, 32, 30, 31, 29]), clicks);
    expect(r).toMatchObject({ ok: true, offsetMs: 30, validTaps: 20, discardedTaps: 0 });
    if (r.ok) expect(r.spreadMs).toBeCloseTo(1.4, 1);
  });

  it('a consistently early player gets a negative offset', () => {
    const r = computeCalibration(taps([-45, -50, -55]), clicks);
    expect(r).toMatchObject({ ok: true, offsetMs: -50, validTaps: 20 });
  });

  it('ignores outliers: stray taps beyond 150 ms are discarded, a few wild ones do not move the median', () => {
    const t = taps([10]);
    t[3] = clicks[3] as number; // a mistimed but valid tap (0 ms)
    t[5] = (clicks[5] as number) + 140; // valid but far: median resists it
    t[8] = (clicks[8] as number) + 240; // 240 ms late (the next click is 260 ms away): discarded
    t.push(12_000); // after the last click: discarded
    const r = computeCalibration(t, clicks);
    expect(r).toMatchObject({ ok: true, offsetMs: 10, validTaps: 19, discardedTaps: 2 });
  });

  it('counts a tap exactly 150 ms away as valid', () => {
    const r = computeCalibration(taps([150]), clicks);
    expect(r).toMatchObject({ ok: true, offsetMs: 150, validTaps: 20 });
  });

  it('refuses with too few taps', () => {
    const few = taps([20]).slice(0, CALIBRATION_MIN_TAPS - 1);
    expect(computeCalibration(few, clicks)).toEqual({
      ok: false,
      validTaps: CALIBRATION_MIN_TAPS - 1,
      discardedTaps: 0,
    });
    expect(computeCalibration([], clicks).ok).toBe(false);
  });

  it('refuses when too many taps are inconsistent', () => {
    // Taps halfway between clicks (250 ms off) are all discarded.
    const r = computeCalibration(taps([250]), clicks);
    expect(r).toEqual({ ok: false, validTaps: 0, discardedTaps: 20 });
  });

  it('succeeds with exactly the minimum number of valid taps', () => {
    const t = taps([-5]).slice(0, CALIBRATION_MIN_TAPS);
    expect(computeCalibration(t, clicks)).toMatchObject({ ok: true, offsetMs: -5 });
  });
});
