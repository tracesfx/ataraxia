import { describe, expect, it } from 'vitest';
import {
  MAX_LOGICAL_HEIGHT,
  MIN_LOGICAL_HEIGHT,
  MIN_LOGICAL_WIDTH,
  computePixelLayout,
} from './pixelScale';

describe('computePixelLayout', () => {
  it('gives 960x540 at 2x on a 1080p screen', () => {
    const l = computePixelLayout(1920, 1080, 1);
    expect(l.scale).toBe(2);
    expect([l.width, l.height]).toEqual([960, 540]);
    expect([l.deviceWidth, l.deviceHeight]).toEqual([1920, 1080]);
    expect([l.offsetX, l.offsetY]).toEqual([0, 0]);
  });

  it('gives 540 rows at 4x on a 4K screen, whatever the DPR', () => {
    for (const [w, h, dpr] of [
      [3840, 2160, 1],
      [1920, 1080, 2],
      [2560, 1440, 1.5],
    ] as const) {
      const l = computePixelLayout(w, h, dpr);
      expect(l.scale).toBe(4);
      expect(l.height).toBe(540);
      expect(l.width).toBe(960);
    }
  });

  it('fills the whole window: leftover is under one logical pixel', () => {
    const l = computePixelLayout(1366, 768, 1);
    expect(l.scale).toBe(2); // 384 rows is closer to 540 than 768 in log terms
    expect([l.width, l.height]).toEqual([683, 384]);
    expect(l.deviceWidth - l.width * l.scale).toBeLessThan(l.scale);
    expect(l.deviceHeight - l.height * l.scale).toBeLessThan(l.scale);
  });

  it('keeps the height within bounds across common windows and DPRs', () => {
    const sizes = [
      [1280, 720],
      [1366, 768],
      [1440, 900],
      [1600, 900],
      [1920, 1080],
      [1920, 1200],
      [2560, 1080],
      [2560, 1440],
      [3440, 1440],
      [3840, 2160],
      [1024, 768],
      [800, 600],
    ] as const;
    for (const [w, h] of sizes) {
      for (const dpr of [1, 1.25, 1.5, 2, 3]) {
        const l = computePixelLayout(w, h, dpr);
        expect(Number.isInteger(l.scale), `${w}x${h}@${dpr}`).toBe(true);
        expect(l.height).toBeGreaterThanOrEqual(MIN_LOGICAL_HEIGHT);
        expect(l.height).toBeLessThanOrEqual(MAX_LOGICAL_HEIGHT);
        expect(l.width).toBeGreaterThanOrEqual(MIN_LOGICAL_WIDTH);
        expect(l.height).toBe(Math.floor(l.deviceHeight / l.scale));
      }
    }
  });

  it('picks the scale closest to the target in log terms', () => {
    // 1440 rows: s=3 gives 480 (|ln(480/540)| = 0.118), s=2 gives 720 (0.288).
    expect(computePixelLayout(2560, 1440, 1).scale).toBe(3);
    // 720 rows: s=1 gives 720 (0.288) and s=2 gives 360 (0.405).
    expect(computePixelLayout(1280, 720, 1).scale).toBe(1);
  });

  it('a target of 270 restores the chunky grid', () => {
    const l = computePixelLayout(1920, 1080, 1, 270);
    expect([l.scale, l.width, l.height]).toEqual([4, 480, 270]);
    const k = computePixelLayout(3840, 2160, 1, 270);
    expect([k.scale, k.height]).toEqual([8, 270]);
  });

  it('prefers the width rule for tall narrow windows', () => {
    const l = computePixelLayout(480, 860, 1);
    expect(l.scale).toBe(1);
    expect(l.width).toBe(480);
  });

  it('scales below 1x for tiny windows instead of cropping', () => {
    const l = computePixelLayout(400, 200, 1);
    expect(l.scale).toBeLessThan(1);
    expect(l.height).toBeGreaterThanOrEqual(MIN_LOGICAL_HEIGHT - 1);
    expect(l.width * l.scale).toBeLessThanOrEqual(400 + 1);
  });

  it('survives zero and invalid DPR', () => {
    const l = computePixelLayout(1920, 1080, 0);
    expect(l.scale).toBe(2);
    expect(computePixelLayout(0, 0, Number.NaN).width).toBeGreaterThan(0);
  });
});
