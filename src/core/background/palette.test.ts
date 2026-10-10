import { describe, expect, it } from 'vitest';
import { PALETTE, RAMPS } from '../../ui/theme';
import {
  LADDER_MAX,
  brightestInColumns,
  coverStats,
  defaultPalette,
  ladderFor,
  medianCut,
  paletteFromPixels,
  snapFamily,
  type RampFamily,
} from './palette';

/** A w x h RGBA image filled by `colour(x, y)`. */
function image(w: number, h: number, colour: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colour(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('median cut', () => {
  it('finds the dominant colours with their shares', () => {
    // 3/4 red, 1/4 blue.
    const px = image(32, 32, (x) => (x < 24 ? [200, 40, 50] : [30, 60, 200]));
    const colours = medianCut(px, 32, 32, 4);
    expect(colours[0]!.weight).toBeCloseTo(0.75, 1);
    expect(colours[0]!.r).toBeGreaterThan(150);
    expect(colours.some((c) => c.b > 150)).toBe(true);
    expect(colours.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1);
  });

  it('ignores transparent pixels and copes with empty images', () => {
    const px = new Uint8ClampedArray(16);
    expect(medianCut(px, 2, 2, 4)).toEqual([]);
  });
});

describe('palette from a cover', () => {
  it('snaps colours onto the ramp families by hue', () => {
    const cases: [[number, number, number], RampFamily][] = [
      [[40, 110, 200], 'accent'],
      [[90, 90, 210], 'iris'],
      [[40, 170, 120], 'success'],
      [[220, 160, 40], 'warning'],
      [[210, 50, 70], 'danger'],
      [[128, 128, 130], 'steel'],
      [[5, 5, 5], 'steel'],
    ];
    for (const [[r, g, b], family] of cases) expect(snapFamily({ r, g, b })).toBe(family);
  });

  it('a mostly amber cover with some red gives warning + danger', () => {
    const px = image(32, 32, (x, y) =>
      y < 22 ? [230, 150, 40] : x < 16 ? [200, 40, 60] : [20, 20, 25],
    );
    const p = paletteFromPixels(px, 32, 32, RAMPS);
    expect(p.primary).toBe('warning');
    expect(p.secondary).toBe('danger');
  });

  it('a grey cover falls back to the theme accent', () => {
    const px = image(16, 16, (x) => [x * 10, x * 10, x * 10]);
    const p = paletteFromPixels(px, 16, 16, RAMPS);
    expect(p).toEqual(defaultPalette(RAMPS));
    expect(p.primary).toBe('accent');
  });

  it('ladders are theme colours only, dark to light, with a limited number of shades', () => {
    for (const family of ['accent', 'iris', 'success', 'warning', 'danger', 'steel'] as const) {
      const ladder = ladderFor(family, RAMPS);
      expect(ladder.length).toBeLessThanOrEqual(LADDER_MAX);
      expect(new Set(ladder).size).toBe(ladder.length);
      for (const c of ladder) expect(PALETTE).toContain(c);
      expect(ladder[0]).toBe(RAMPS.steel[0]);
    }
  });

  it('measures colourfulness, contrast and the brightest pixel in the lane columns', () => {
    const flat = coverStats(
      image(8, 8, () => [100, 100, 100]),
      8,
      8,
    );
    expect(flat.colorfulness).toBeCloseTo(0);
    expect(flat.contrast).toBeCloseTo(0);
    const vivid = coverStats(
      image(8, 8, (x) => (x < 4 ? [255, 0, 0] : [0, 0, 255])),
      8,
      8,
    );
    expect(vivid.colorfulness).toBeGreaterThan(0.5);
    expect(vivid.contrast).toBeGreaterThan(0);
    const px = image(10, 2, (x) => (x === 0 ? [255, 255, 255] : x === 5 ? [200, 0, 0] : [0, 0, 0]));
    expect(brightestInColumns(px, 10, 2, 0.3, 0.7)).toBe('#c80000');
    expect(brightestInColumns(px, 10, 2)).toBe('#ffffff');
  });
});
