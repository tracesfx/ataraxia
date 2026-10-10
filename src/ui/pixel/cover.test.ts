import { describe, expect, it } from 'vitest';
import { coverBitmap, coverStyle, hashString } from './cover';

describe('placeholder covers', () => {
  it('the same title always gives the same gradient', () => {
    expect(coverStyle('Night Drive')).toEqual(coverStyle('Night Drive'));
    expect([...coverBitmap('Night Drive', 32).data]).toEqual([
      ...coverBitmap('Night Drive', 32).data,
    ]);
  });

  it('ignores case and surrounding spaces', () => {
    expect(coverStyle('  night drive ')).toEqual(coverStyle('Night Drive'));
  });

  it('is stable across runs (fixed hash)', () => {
    expect(hashString('ataraxia')).toBe(hashString('ataraxia'));
    expect(hashString('')).toBe(0x811c9dc5);
  });

  it('different titles give different gradients', () => {
    const styles = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map((t) =>
      JSON.stringify(coverStyle(t)),
    );
    expect(new Set(styles).size).toBeGreaterThan(1);
  });

  it('paints only flat ramp colours (no smoothing between bands)', () => {
    const bmp = coverBitmap('Banded', 24);
    expect(new Set(bmp.data).size).toBeLessThanOrEqual(6);
  });
});
