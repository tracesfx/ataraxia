import { describe, expect, it } from 'vitest';
import {
  FRAME_RATE_CHOICES,
  FramePacer,
  RefreshEstimator,
  frameRateLabel,
  isFrameRateLimit,
  needsTimer,
} from './framePacing';

/** Frames drawn over `seconds` of display refreshes at `hz` under a cap of `fps`. */
function drawn(hz: number, fps: number, seconds: number, jitterMs = 0): number {
  const pacer = new FramePacer();
  let count = 0;
  const frames = Math.round(hz * seconds);
  for (let i = 0; i < frames; i++) {
    const t = (i * 1000) / hz + (i % 2 === 0 ? jitterMs : -jitterMs);
    if (pacer.due(t, fps)) count += 1;
  }
  return count;
}

describe('frame pacing', () => {
  it('caps the frame rate when the display refreshes faster', () => {
    expect(drawn(144, 60, 2)).toBeGreaterThanOrEqual(118);
    expect(drawn(144, 60, 2)).toBeLessThanOrEqual(122);
    expect(drawn(240, 120, 2)).toBeGreaterThanOrEqual(238);
    expect(drawn(240, 120, 2)).toBeLessThanOrEqual(242);
    expect(drawn(120, 30, 2)).toBe(60);
  });

  it('draws every refresh when the cap equals the refresh rate, despite jitter', () => {
    expect(drawn(120, 120, 2, 0.3)).toBe(240);
    expect(drawn(60, 60, 2, 0.5)).toBe(120);
  });

  it('resyncs after a stall instead of bursting to catch up', () => {
    const pacer = new FramePacer();
    expect(pacer.due(0, 60)).toBe(true);
    expect(pacer.due(500, 60)).toBe(true);
    expect(pacer.due(505, 60)).toBe(false);
    expect(pacer.due(517, 60)).toBe(true);
  });

  it('estimates the display refresh rate from frame timestamps, ignoring stalls', () => {
    const est = new RefreshEstimator();
    expect(est.hz).toBeNull();
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += i === 20 ? 300 : 1000 / 144;
      est.add(t);
    }
    expect(est.hz).toBeGreaterThan(140);
    expect(est.hz).toBeLessThan(148);
  });

  it('uses a timer only for unlimited and for caps above the display', () => {
    expect(needsTimer('display', 120)).toBe(false);
    expect(needsTimer('unlimited', 120)).toBe(true);
    expect(needsTimer(120, 120)).toBe(false);
    expect(needsTimer(240, 120)).toBe(true);
    expect(needsTimer(90, null)).toBe(true);
    expect(needsTimer(60, null)).toBe(false);
  });

  it('knows its choices and labels', () => {
    for (const c of FRAME_RATE_CHOICES) expect(isFrameRateLimit(c)).toBe(true);
    expect(isFrameRateLimit(75)).toBe(false);
    expect(isFrameRateLimit('fast')).toBe(false);
    expect(frameRateLabel('display')).toBe('Match display');
    expect(frameRateLabel('unlimited')).toBe('Unlimited');
    expect(frameRateLabel(144)).toBe('144 fps');
  });
});
