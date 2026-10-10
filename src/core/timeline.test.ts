import { describe, expect, it } from 'vitest';
import {
  MAX_PX_PER_MS,
  MIN_PX_PER_MS,
  clampZoom,
  clampToSpan,
  editorSpan,
  overviewTimeToX,
  overviewXToTime,
  timeToY,
  visibleRange,
  yToTime,
  zoomAround,
  type TimelineView,
} from './timeline';

const view = (pxPerMs: number): TimelineView => ({ pxPerMs, playheadY: 600, heightPx: 900 });

describe('timeToY / yToTime', () => {
  it('puts the playhead time on the playhead line', () => {
    expect(timeToY(12_345, 12_345, view(0.3))).toBe(600);
    expect(yToTime(600, 12_345, view(0.3))).toBe(12_345);
  });

  it('draws later times higher up', () => {
    const v = view(0.5);
    expect(timeToY(11_000, 10_000, v)).toBe(100);
    expect(timeToY(9_000, 10_000, v)).toBe(1100);
  });

  for (const pxPerMs of [MIN_PX_PER_MS, 0.05, 0.3, 1, 2.5, MAX_PX_PER_MS]) {
    it(`round-trips at ${pxPerMs} px/ms`, () => {
      const v = view(pxPerMs);
      for (const y of [0, 1, 123.5, 600, 899, 900]) {
        expect(timeToY(yToTime(y, 50_000, v), 50_000, v)).toBeCloseTo(y, 6);
      }
      for (const ms of [0, 49_000, 50_000, 50_001.25, 51_000]) {
        expect(yToTime(timeToY(ms, 50_000, v), 50_000, v)).toBeCloseTo(ms, 6);
      }
      // One second of song time spans pxPerMs * 1000 pixels.
      expect(timeToY(50_000, 50_000, v) - timeToY(51_000, 50_000, v)).toBeCloseTo(
        pxPerMs * 1000,
        6,
      );
    });
  }
});

describe('visibleRange', () => {
  it('spans from the bottom edge (earliest) to the top edge (latest)', () => {
    // 300 px below the playhead and 600 px above it, at 0.3 px/ms.
    expect(visibleRange(10_000, view(0.3))).toEqual({ startMs: 9_000, endMs: 12_000 });
    // Zooming in by 10x shows a tenth of the time.
    expect(visibleRange(10_000, view(3))).toEqual({ startMs: 9_900, endMs: 10_200 });
  });
});

describe('zoom', () => {
  it('clamps to the limits', () => {
    expect(clampZoom(0)).toBe(MIN_PX_PER_MS);
    expect(clampZoom(100)).toBe(MAX_PX_PER_MS);
    expect(clampZoom(0.5)).toBe(0.5);
    expect(clampZoom(Number.NaN)).toBeGreaterThan(0);
  });

  it('keeps the playhead time and screen position fixed when anchored on it', () => {
    const v = view(0.3);
    const z = zoomAround(v, 42_000, 2, v.playheadY);
    expect(z.pxPerMs).toBeCloseTo(0.6, 12);
    expect(z.playheadMs).toBeCloseTo(42_000, 9);
  });

  it('keeps any anchored time under the anchor', () => {
    const v = view(0.3);
    const anchorY = 150;
    const before = yToTime(anchorY, 42_000, v);
    const z = zoomAround(v, 42_000, 1.7, anchorY);
    const after = yToTime(anchorY, z.playheadMs, { ...v, pxPerMs: z.pxPerMs });
    expect(after).toBeCloseTo(before, 6);
  });

  it('stops at the zoom limits', () => {
    const z = zoomAround(view(MAX_PX_PER_MS), 1000, 4, 600);
    expect(z.pxPerMs).toBe(MAX_PX_PER_MS);
    expect(z.playheadMs).toBeCloseTo(1000, 9);
  });
});

describe('minimap mapping', () => {
  const song = { startMs: 0, endMs: 300_000 };

  it('puts the span start at the left and the end at the right', () => {
    expect(overviewTimeToX(0, song, 600)).toBe(0);
    expect(overviewTimeToX(300_000, song, 600)).toBe(600);
    expect(overviewTimeToX(150_000, song, 600)).toBe(300);
  });

  it('maps x back to a clamped song time', () => {
    expect(overviewXToTime(300, song, 600)).toBe(150_000);
    expect(overviewXToTime(-50, song, 600)).toBe(0);
    expect(overviewXToTime(700, song, 600)).toBe(300_000);
  });

  it('shows the pre-song region of the editor span', () => {
    const span = editorSpan(60_000); // -30 s .. 70 s
    expect(overviewTimeToX(-30_000, span, 1000)).toBe(0);
    expect(overviewTimeToX(0, span, 1000)).toBe(300);
    expect(overviewXToTime(150, span, 1000)).toBe(-15_000);
    expect(overviewXToTime(-200, span, 1000)).toBe(-30_000);
  });

  it('copes with an empty span or strip', () => {
    expect(overviewTimeToX(10, { startMs: 0, endMs: 0 }, 600)).toBe(0);
    expect(overviewXToTime(10, song, 0)).toBe(0);
  });
});

describe('editor view bounds', () => {
  it('runs from 30 s before the audio to 10 s past its end', () => {
    expect(editorSpan(90_000)).toEqual({ startMs: -30_000, endMs: 100_000 });
    expect(editorSpan(0)).toEqual({ startMs: -30_000, endMs: 10_000 });
  });

  it('clamps times into the span', () => {
    const span = editorSpan(90_000);
    expect(clampToSpan(-45_000, span)).toBe(-30_000);
    expect(clampToSpan(-1234, span)).toBe(-1234);
    expect(clampToSpan(250_000, span)).toBe(100_000);
  });

  it('shows negative time in the view before the audio', () => {
    const view = { pxPerMs: 0.1, playheadY: 700, heightPx: 1000 };
    // Playhead at -20 s: the view spans -23 s (bottom) to -13 s (top).
    expect(visibleRange(-20_000, view)).toEqual({ startMs: -23_000, endMs: -13_000 });
    expect(timeToY(0, -20_000, view)).toBe(-1300);
  });
});
