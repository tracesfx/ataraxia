import { describe, expect, it } from 'vitest';
import { DEFAULT_LANE_SIZE, clampLaneSize, laneScale } from './laneScale';

describe('clampLaneSize', () => {
  it('keeps whole sizes from 1 to 4', () => {
    expect(clampLaneSize(0)).toBe(1);
    expect(clampLaneSize(2.4)).toBe(2);
    expect(clampLaneSize(9)).toBe(4);
    expect(clampLaneSize(Number.NaN)).toBe(DEFAULT_LANE_SIZE);
  });
});

describe('laneScale', () => {
  it('scales the skin lane by a whole number of device pixels', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (const size of [1, 2, 3, 4]) {
        const s = laneScale(64, size, dpr, 100_000);
        expect(Number.isInteger(s.devicePx)).toBe(true);
        expect(s.laneWidth * dpr).toBeCloseTo(64 * s.devicePx, 9);
        expect(s.unit).toBeCloseTo(s.devicePx / dpr, 12);
      }
    }
  });

  it('lane width = skin lane width x size on standard displays', () => {
    expect(laneScale(64, 1, 1, 10_000).laneWidth).toBe(64);
    expect(laneScale(64, 2, 1, 10_000).laneWidth).toBe(128);
    expect(laneScale(64, 4, 1, 10_000).laneWidth).toBe(256);
    // Retina: the same CSS size, twice the device pixels.
    const retina = laneScale(64, 2, 2, 10_000);
    expect(retina.laneWidth).toBe(128);
    expect(retina.devicePx).toBe(4);
  });

  it('steps down when the lanes do not fit, never below 1', () => {
    expect(laneScale(64, 4, 1, 600).size).toBe(2);
    expect(laneScale(64, 4, 1, 600).laneWidth).toBe(128);
    expect(laneScale(64, 3, 1, 100).size).toBe(1);
  });
});
