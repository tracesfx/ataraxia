import { describe, expect, it } from 'vitest';
import { FONTS } from '../theme';
import { chooseArtPixel, layoutClass, scaleVariables, textLadder } from './scale';

describe('chooseArtPixel', () => {
  it('uses 2 at 1080p and 720p, more on taller screens', () => {
    expect(chooseArtPixel(1920, 1080, 1)).toBe(2);
    expect(chooseArtPixel(1280, 720, 1)).toBe(2);
    expect(chooseArtPixel(2560, 1440, 1)).toBe(3);
    expect(chooseArtPixel(3840, 2160, 1)).toBe(4);
    expect(chooseArtPixel(800, 500, 1)).toBe(1);
  });

  it('measures in device pixels', () => {
    // A 1440x900 window at devicePixelRatio 2 is 1800 device pixels tall.
    expect(chooseArtPixel(1440, 900, 2)).toBe(4);
    expect(chooseArtPixel(1280, 720, 1.5)).toBe(2);
    expect(chooseArtPixel(1920, 1080, 1.25)).toBe(3);
  });

  it('lowers the scale for narrow windows', () => {
    expect(chooseArtPixel(500, 1080, 1)).toBe(1);
    expect(chooseArtPixel(700, 1080, 1)).toBe(2);
    expect(chooseArtPixel(390, 844, 3)).toBe(3);
  });

  it('is always a whole number of at least 1, even for odd inputs', () => {
    for (const [w, h, dpr] of [
      [0, 0, 1],
      [100, 100, 0],
      [1000, 1000, Number.NaN],
      [1366, 768, 1.333],
    ] as const) {
      const n = chooseArtPixel(w, h, dpr);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it('respects a fixed UI scale setting', () => {
    expect(chooseArtPixel(1920, 1080, 1, 1)).toBe(1);
    expect(chooseArtPixel(1920, 1080, 1, 3)).toBe(3);
    expect(chooseArtPixel(400, 300, 1, 2)).toBe(2);
  });
});

describe('text sizes', () => {
  it('keeps every glyph pixel a whole number of device pixels', () => {
    for (const n of [1, 2, 3, 4]) {
      const ladder = textLadder(n);
      for (const gp of Object.values(ladder)) expect(Number.isInteger(gp)).toBe(true);
      expect(ladder.title).toBeGreaterThan(ladder.label);
      expect(ladder.display).toBeGreaterThan(ladder.title);
    }
  });

  it('derives font sizes from the pixel-font grid', () => {
    const { vars } = scaleVariables(2, 1, 1920);
    expect(vars['--px']).toBe('2px');
    expect(parseFloat(vars['--fs-label'] as string)).toBeCloseTo(FONTS.pixelEm, 3);
    expect(vars['--lh-label']).toBe('20px');
    // At devicePixelRatio 2, CSS sizes halve.
    const hi = scaleVariables(4, 2, 1440).vars;
    expect(hi['--px']).toBe('2px');
    expect(hi['--lh-label']).toBe('20px');
  });

  it('classifies the layout by width in art pixels', () => {
    expect(layoutClass(300)).toBe('narrow');
    expect(layoutClass(640)).toBe('medium');
    expect(layoutClass(960)).toBe('wide');
    expect(scaleVariables(2, 1, 1280).layout).toBe('medium');
  });
});
