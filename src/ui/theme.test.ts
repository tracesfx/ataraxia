import { describe, expect, it } from 'vitest';
import { contrastRatio, over, parseHex, relativeLuminance } from './pixel/color';
import {
  ALPHA,
  COLORS,
  JUDGEMENT_COLORS,
  PALETTE,
  RAMPS,
  RANK_RAMPS,
  TOKENS,
  cssVariables,
} from './theme';

const AA = 4.5;

describe('theme tokens', () => {
  it('exports every ramp as CSS custom properties', () => {
    const vars = cssVariables();
    expect(vars['--steel-0']).toBe(RAMPS.steel[0]);
    expect(vars['--steel-8']).toBe(RAMPS.steel[8]);
    expect(vars['--accent-6']).toBe(RAMPS.accent[6]);
    expect(vars['--danger-3']).toBe(RAMPS.danger[3]);
    expect(vars['--c-text']).toBe(COLORS.text);
    expect(vars['--c-accent-text']).toBe(COLORS.accentText);
    expect(vars['--j-perfect']).toBe(JUDGEMENT_COLORS.perfect);
    expect(vars['--space-4']).toBe('16');
    expect(vars['--motion-fast']).toBe('120ms');
    expect(vars['--font-pixel']).toContain('Jersey 10');
  });

  it('exports the same values as a typed object', () => {
    expect(TOKENS.ramps.steel).toHaveLength(9);
    expect(TOKENS.ramps.accent).toHaveLength(7);
    for (const name of ['success', 'warning', 'danger'] as const) {
      expect(TOKENS.ramps[name]).toHaveLength(4);
    }
    expect(TOKENS.colors.text).toBe(COLORS.text);
  });

  it('ramps rise monotonically in luminance', () => {
    const ramps: (readonly string[])[] = [...Object.values(RAMPS), ...Object.values(RANK_RAMPS)];
    for (const ramp of ramps) {
      const lum = ramp.map(relativeLuminance);
      for (let i = 1; i < lum.length; i++) {
        expect(lum[i]).toBeGreaterThan(lum[i - 1] as number);
      }
    }
  });

  it('never uses pure black, pure white or saturated primaries', () => {
    for (const hex of PALETTE) {
      expect(hex).not.toBe('#000000');
      expect(hex).not.toBe('#ffffff');
      const { r, g, b } = parseHex(hex);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // Saturation of a fully saturated primary is 1; keep everything well below it.
      const saturation = max === 0 ? 0 : (max - min) / max;
      expect(saturation).toBeLessThan(0.85);
    }
  });

  it('steel stays a cool neutral (blue channel at least red)', () => {
    for (const hex of RAMPS.steel) {
      const { r, b } = parseHex(hex);
      expect(b).toBeGreaterThanOrEqual(r);
    }
  });

  it('text colours meet WCAG AA on the background and on glass', () => {
    const glass = over(RAMPS.steel[1], ALPHA.glass, COLORS.bg);
    const pairs: [string, string][] = [
      [COLORS.text, COLORS.bg],
      [COLORS.text, COLORS.surface],
      [COLORS.text, glass],
      [COLORS.textMuted, COLORS.bg],
      [COLORS.textMuted, COLORS.surface],
      [COLORS.textMuted, glass],
      [COLORS.accentText, COLORS.surface],
      [COLORS.successText, COLORS.surface],
      [COLORS.warningText, COLORS.surface],
      [COLORS.dangerText, COLORS.surface],
      [COLORS.text, COLORS.control],
      [COLORS.textOnAccent, COLORS.accentFace],
      ...Object.values(JUDGEMENT_COLORS).map((c): [string, string] => [c, COLORS.surface]),
    ];
    for (const [fg, bg] of pairs) {
      expect(contrastRatio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(AA);
    }
  });
});
