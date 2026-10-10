import { describe, expect, it } from 'vitest';
import { RAMPS } from '../../ui/theme';
import { hexToRgb, luminance } from './color';
import {
  DIM_MAX,
  LANE_MAX_LUMINANCE,
  afterLayers,
  clampAlpha,
  clampDim,
  readabilityLayers,
} from './readability';

const BG = RAMPS.steel[0];

describe('dim and luminance clamp', () => {
  it('clamps the dim setting to 0-90 %', () => {
    expect(clampDim(0.55)).toBe(0.55);
    expect(clampDim(2)).toBe(DIM_MAX);
    expect(clampDim(-1)).toBe(0);
    expect(clampDim('x')).toBe(0.55);
  });

  it('keeps anything behind the lanes at or below the target luminance, for any dim', () => {
    for (const bright of ['#ffffff', '#ffd27a', RAMPS.accent[6], RAMPS.warning[3], '#ff0000']) {
      for (const dim of [0, 0.3, 0.55, 0.9]) {
        const layers = readabilityLayers(bright, BG, dim);
        expect(layers.dimAlpha).toBe(dim);
        expect(luminance(afterLayers(bright, BG, layers))).toBeLessThanOrEqual(
          LANE_MAX_LUMINANCE + 1e-4,
        );
      }
    }
  });

  it('adds no clamp when the background is already dark enough', () => {
    expect(readabilityLayers(RAMPS.steel[1], BG, 0).laneAlpha).toBe(0);
    expect(clampAlpha(hexToRgb(RAMPS.steel[0]), hexToRgb(BG), LANE_MAX_LUMINANCE)).toBe(0);
  });

  it('uses the smallest alpha that works (a darker dim needs less clamp)', () => {
    const light = readabilityLayers('#ffffff', BG, 0).laneAlpha;
    const dimmed = readabilityLayers('#ffffff', BG, 0.6).laneAlpha;
    expect(dimmed).toBeLessThan(light);
    expect(light).toBeGreaterThan(0.5);
    expect(light).toBeLessThan(1);
  });
});
