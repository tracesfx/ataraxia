import { describe, expect, it } from 'vitest';
import { scrollY } from '../core/clock';
import {
  FIELD_W,
  LANE_W,
  NOTE_W,
  computeFieldLayout,
  laneCenterX,
  noteX,
  progressFillWidth,
  progressFraction,
  progressMarkerX,
  scrollPxPerMs,
} from './fieldLayout';
import { computePixelLayout } from './pixelScale';

describe('computeFieldLayout', () => {
  it('centres four 64 px lanes and puts the hit line at 0.85 H', () => {
    for (const [w, h] of [
      [960, 540],
      [683, 384],
      [853, 480],
      [1280, 720],
      [480, 860],
    ] as const) {
      const l = computeFieldLayout(w, h);
      expect(l.hitLineY).toBe(Math.round(h * 0.85));
      const left = l.fieldX;
      const right = w - (l.fieldX + FIELD_W);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      expect(laneCenterX(l, 0)).toBe(l.fieldX + 32);
      expect(laneCenterX(l, 3) - laneCenterX(l, 0)).toBe(3 * LANE_W);
      expect(noteX(l, 1) + NOTE_W / 2).toBe(laneCenterX(l, 1));
      expect(Number.isInteger(l.comboY) && Number.isInteger(l.judgementY)).toBe(true);
      expect(l.judgementY).toBeLessThan(l.hitLineY);
      expect(l.noteClipBottom).toBeGreaterThan(l.hitLineY);
      expect(l.progressY).toBe(h - 4);
    }
  });

  it('works with the layouts the pixel grid produces', () => {
    for (const [w, h, dpr] of [
      [1920, 1080, 1],
      [3840, 2160, 1],
      [1366, 768, 1],
      [2560, 1440, 1.25],
    ] as const) {
      const px = computePixelLayout(w, h, dpr);
      const l = computeFieldLayout(px.width, px.height);
      expect(l.fieldX).toBeGreaterThan(0);
      expect(l.hitLineY).toBeLessThan(px.height);
    }
  });
});

describe('scrollPxPerMs', () => {
  it('takes about 660 ms from the top to the hit line at 3.5 for any height', () => {
    for (const h of [360, 384, 480, 540, 720, 770]) {
      const hit = computeFieldLayout(960, h).hitLineY;
      const speed = scrollPxPerMs(3.5, hit);
      // A note 660 ms ahead sits on row 0.
      expect(scrollY(660, 0, hit, speed)).toBeCloseTo(0, 6);
      expect(hit / speed).toBeCloseTo(660, 6);
    }
  });

  it('scales proportionally with the setting', () => {
    const hit = 459;
    expect(hit / scrollPxPerMs(7, hit)).toBeCloseTo(330, 6);
    expect(hit / scrollPxPerMs(1.75, hit)).toBeCloseTo(1320, 6);
  });
});

describe('progress mapping', () => {
  it('clamps to 0..1 and handles unknown durations', () => {
    expect(progressFraction(-500, 1000)).toBe(0);
    expect(progressFraction(500, 1000)).toBe(0.5);
    expect(progressFraction(5000, 1000)).toBe(1);
    expect(progressFraction(100, 0)).toBe(0);
    expect(progressFraction(Number.NaN, 1000)).toBe(0);
  });

  it('maps to whole pixels across the full width', () => {
    expect(progressFillWidth(0, 1000, 960)).toBe(0);
    expect(progressFillWidth(500, 1000, 960)).toBe(480);
    expect(progressFillWidth(1000, 1000, 960)).toBe(960);
    expect(progressFillWidth(333, 1000, 683)).toBe(227);
    expect(progressMarkerX(1000, 1000, 960)).toBe(959);
    expect(progressMarkerX(250, 1000, 960)).toBe(240);
  });
});
