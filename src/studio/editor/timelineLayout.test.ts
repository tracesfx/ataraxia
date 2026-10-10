import { describe, expect, it } from 'vitest';
import { inTimelineBand, laneAt, timelineLayout } from './timelineLayout';

describe('timelineLayout', () => {
  it('keeps label columns outside the waveform and the lanes centred', () => {
    const l = timelineLayout(1200, 2, 1);
    expect(l.lanesWidth).toBe(l.laneWidth * 4);
    expect(l.laneWidth).toBe(128);
    expect(l.measureLabelX).toBeLessThan(l.waveX);
    expect(l.flagX).toBeGreaterThan(l.waveX + l.waveWidth);
    expect(l.timeLabelX).toBeGreaterThan(l.flagX);
  });

  it('puts the lanes on whole device pixels with an integer sprite scale', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const l = timelineLayout(1333, 2, dpr);
      expect(Number.isInteger(Math.round(l.lanesX * dpr * 1000) / 1000)).toBe(true);
      expect(Number.isInteger(l.devicePx)).toBe(true);
      expect(l.laneWidth * dpr).toBeCloseTo(64 * l.devicePx, 9);
    }
  });

  it('uses a smaller lane size when the chosen one does not fit', () => {
    expect(timelineLayout(2400, 4, 1).laneSize).toBe(4);
    expect(timelineLayout(700, 4, 1).laneSize).toBe(1);
  });

  it('finds the lane under x', () => {
    const l = timelineLayout(1000, 2, 1);
    expect(laneAt(l.lanesX, l)).toBe(0);
    expect(laneAt(l.lanesX + l.laneWidth * 2.5, l)).toBe(2);
    expect(laneAt(l.lanesX + l.lanesWidth - 1, l)).toBe(3);
    expect(laneAt(l.lanesX - 1, l)).toBeNull();
    expect(laneAt(l.lanesX + l.lanesWidth, l)).toBeNull();
    expect(inTimelineBand(l.waveX, l)).toBe(true);
    expect(inTimelineBand(l.waveX - 1, l)).toBe(false);
  });
});
