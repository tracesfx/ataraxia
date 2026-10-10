import { describe, expect, it } from 'vitest';
import {
  COMBO_BUMP_MS,
  COMBO_SHAKE_MS,
  POPUP_MS,
  comboBreakAlpha,
  comboBumpOffsetY,
  comboShakeOffsetX,
  popupAlpha,
  popupOffsetY,
} from './animation';

const ages = (to: number, step = 1): number[] =>
  Array.from({ length: to / step }, (_, i) => i * step);

describe('judgement text', () => {
  it('pops in by whole pixels and settles', () => {
    expect(popupOffsetY(0)).toBe(3);
    expect(popupOffsetY(25)).toBe(2);
    expect(popupOffsetY(45)).toBe(1);
    expect(popupOffsetY(200)).toBe(0);
    for (const a of ages(POPUP_MS)) expect(Number.isInteger(popupOffsetY(a))).toBe(true);
  });

  it('fades in and out in four alpha steps', () => {
    expect(popupAlpha(0, true)).toBe(0.25);
    expect(popupAlpha(17, true)).toBe(0.5);
    expect(popupAlpha(0)).toBe(1);
    expect(popupAlpha(100)).toBe(1);
    const levels = new Set(ages(POPUP_MS).map((a) => Math.round(popupAlpha(a, true) * 4)));
    expect([...levels].sort()).toEqual([1, 2, 3, 4]);
    expect(popupAlpha(POPUP_MS)).toBe(0);
    expect(popupAlpha(-1)).toBe(0);
  });
});

describe('combo', () => {
  it('bumps 2 then 1 pixel per increment', () => {
    expect(comboBumpOffsetY(0)).toBe(-2);
    expect(comboBumpOffsetY(COMBO_BUMP_MS / 2)).toBe(-1);
    expect(comboBumpOffsetY(COMBO_BUMP_MS)).toBe(0);
    expect(comboBumpOffsetY(-5)).toBe(0);
  });

  it('shakes by whole pixels only while the break shows, then fades in steps', () => {
    for (const a of ages(COMBO_SHAKE_MS)) {
      const x = comboShakeOffsetX(a);
      expect(Number.isInteger(x)).toBe(true);
      expect(Math.abs(x)).toBeLessThanOrEqual(2);
    }
    expect(comboShakeOffsetX(COMBO_SHAKE_MS)).toBe(0);
    expect(comboBreakAlpha(0)).toBe(1);
    expect(comboBreakAlpha(COMBO_SHAKE_MS - 1)).toBe(0.33);
    expect(comboBreakAlpha(COMBO_SHAKE_MS)).toBe(0);
  });
});
