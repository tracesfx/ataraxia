import { describe, expect, it } from 'vitest';
import {
  DELTA_LINE,
  DELTA_PAGE,
  DELTA_PIXEL,
  FINE_SCROLL_FACTOR,
  GLIDE_TAU_MS,
  NOTCH_PX,
  SCROLL_TAU_MS,
  SmoothView,
  anchoredTimeMs,
  approach,
  approachLog,
  normalizeWheel,
  scrollStopped,
  wheelScrollMs,
  wheelZoomTarget,
} from './editorScroll';
import { MAX_PX_PER_MS, MIN_PX_PER_MS } from './timeline';

/** Run a SmoothView for `totalMs` at `hz` frames per second toward a fixed target. */
function simulate(hz: number, totalMs: number, target: number, zoom = 0.3): SmoothView {
  const view = new SmoothView(0, zoom);
  const frames = Math.round((totalMs * hz) / 1000);
  for (let i = 0; i < frames; i++) view.step(1000 / hz, target, zoom, SCROLL_TAU_MS);
  return view;
}

describe('normalizeWheel', () => {
  it('turns mouse notches into a fixed number of pixels in every delta mode', () => {
    expect(normalizeWheel(100, DELTA_PIXEL, 800)).toBe(NOTCH_PX);
    expect(normalizeWheel(-100, DELTA_PIXEL, 800)).toBe(-NOTCH_PX);
    // Scaled displays report 120 or 125 per notch.
    expect(normalizeWheel(125, DELTA_PIXEL, 800)).toBe(NOTCH_PX);
    expect(normalizeWheel(240, DELTA_PIXEL, 800)).toBe(2 * NOTCH_PX);
    expect(normalizeWheel(3, DELTA_LINE, 800)).toBe(NOTCH_PX);
    expect(normalizeWheel(-6, DELTA_LINE, 800)).toBe(-2 * NOTCH_PX);
    // One line per notch configured: still a notch.
    expect(normalizeWheel(1, DELTA_LINE, 800)).toBe(NOTCH_PX);
  });

  it('passes trackpad pixel deltas through', () => {
    expect(normalizeWheel(4, DELTA_PIXEL, 800)).toBe(4);
    expect(normalizeWheel(-12.5, DELTA_PIXEL, 800)).toBe(-12.5);
  });

  it('handles pages and nonsense', () => {
    expect(normalizeWheel(1, DELTA_PAGE, 700)).toBe(700);
    expect(normalizeWheel(0, DELTA_PIXEL, 700)).toBe(0);
    expect(normalizeWheel(Number.NaN, DELTA_PIXEL, 700)).toBe(0);
  });
});

describe('wheelScrollMs', () => {
  it('moves a constant number of screen pixels per notch at any zoom', () => {
    const notch = normalizeWheel(100, DELTA_PIXEL, 800);
    for (const zoom of [MIN_PX_PER_MS, 0.05, 0.3, 1.7, MAX_PX_PER_MS]) {
      const ms = wheelScrollMs(notch, zoom);
      expect(Math.abs(ms * zoom)).toBeCloseTo(NOTCH_PX, 9);
    }
  });

  it('wheel up moves later, invert flips it, shift is fine scroll', () => {
    expect(wheelScrollMs(-NOTCH_PX, 0.4)).toBeGreaterThan(0);
    expect(wheelScrollMs(NOTCH_PX, 0.4)).toBeLessThan(0);
    expect(wheelScrollMs(-NOTCH_PX, 0.4, { invert: true })).toBeLessThan(0);
    expect(wheelScrollMs(-NOTCH_PX, 0.4, { fine: true })).toBeCloseTo(
      wheelScrollMs(-NOTCH_PX, 0.4) * FINE_SCROLL_FACTOR,
      9,
    );
    expect(wheelScrollMs(10, 0)).toBe(0);
  });
});

describe('wheelZoomTarget', () => {
  it('zooms in on wheel up, symmetrically in log scale, within limits', () => {
    expect(wheelZoomTarget(0.3, -NOTCH_PX)).toBeGreaterThan(0.3);
    expect(wheelZoomTarget(wheelZoomTarget(0.3, -NOTCH_PX), NOTCH_PX)).toBeCloseTo(0.3, 9);
    expect(wheelZoomTarget(MAX_PX_PER_MS, -10_000)).toBe(MAX_PX_PER_MS);
    expect(wheelZoomTarget(MIN_PX_PER_MS, 10_000)).toBe(MIN_PX_PER_MS);
  });
});

describe('approach', () => {
  it('moves toward the target by the exponential factor', () => {
    expect(approach(0, 100, SCROLL_TAU_MS, SCROLL_TAU_MS)).toBeCloseTo(100 * (1 - Math.exp(-1)), 9);
    expect(approach(5, 100, 0, 70)).toBe(5);
    expect(approach(5, 100, 16, 0)).toBe(100);
  });

  it('is frame-rate independent: one big step equals many small ones', () => {
    let v = 0;
    for (let i = 0; i < 10; i++) v = approach(v, 1000, 10, 70);
    expect(v).toBeCloseTo(approach(0, 1000, 100, 70), 9);
  });

  it('approaches zoom in log space', () => {
    // Half way in log space after tau*ln2: the geometric mean.
    const mid = approachLog(0.1, 0.4, 70 * Math.log(2), 70);
    expect(mid).toBeCloseTo(0.2, 9);
  });
});

describe('SmoothView', () => {
  it('converges to the same position at 30, 60 and 144 Hz', () => {
    const positions = [30, 60, 144].map((hz) => simulate(hz, 500, 1000).timeMs);
    for (const p of positions) expect(p).toBeCloseTo(positions[0] as number, 6);
    // And mid-way, sampled at a time all three rates hit (1/6 s).
    const early = [30, 60, 144].map((hz) => simulate(hz, 1000 / 6, 1000).timeMs);
    for (const p of early) expect(Math.abs(p - (early[0] as number))).toBeLessThan(0.01);
  });

  it('settles exactly on the target and then reports no motion', () => {
    const view = simulate(60, 2000, 1234.5);
    expect(view.timeMs).toBe(1234.5);
    expect(view.step(16, 1234.5, 0.3, SCROLL_TAU_MS)).toBe(false);
  });

  it('glides a key step in about 90 ms', () => {
    const view = new SmoothView(0, 0.3);
    for (let t = 0; t < 90; t += 1000 / 144) view.step(1000 / 144, 100, 0.3, GLIDE_TAU_MS);
    expect(view.timeMs).toBeGreaterThan(94);
  });

  it('keeps the anchor under the pointer fixed on screen while zooming', () => {
    const playheadY = 600;
    const view = new SmoothView(10_000, 0.3);
    const pointerY = 200;
    const offsetPx = playheadY - pointerY;
    const anchorMs = anchoredTimeMs(10_000, -offsetPx, 0.3); // song time under the pointer
    expect(anchorMs).toBeCloseTo(10_000 + offsetPx / 0.3, 9);
    const targetZoom = 1.2;
    view.anchorZoom(anchorMs, offsetPx);
    const targetMs = anchoredTimeMs(anchorMs, offsetPx, targetZoom);
    for (let i = 0; i < 30; i++) {
      view.step(1000 / 60, targetMs, targetZoom, SCROLL_TAU_MS);
      const y = playheadY - (anchorMs - view.timeMs) * view.pxPerMs;
      expect(y).toBeCloseTo(pointerY, 6);
    }
    for (let i = 0; i < 200; i++) view.step(1000 / 60, targetMs, targetZoom, SCROLL_TAU_MS);
    expect(view.pxPerMs).toBe(targetZoom);
    expect(view.timeMs).toBe(targetMs);
    expect(view.zoomAnchored).toBe(false);
  });

  it('drops the zoom anchor when the target moves elsewhere', () => {
    const view = new SmoothView(0, 0.3);
    view.anchorZoom(500, 100);
    view.step(16, 5000, 0.6, SCROLL_TAU_MS);
    expect(view.zoomAnchored).toBe(false);
  });

  it('jumps without animation', () => {
    const view = new SmoothView(0, 0.3);
    view.jump(-20_000, 0.5);
    expect(view.step(16, -20_000, 0.5, SCROLL_TAU_MS)).toBe(false);
  });
});

describe('scrollStopped', () => {
  it('fires once scrolling has been idle long enough', () => {
    expect(scrollStopped(1000, null, 150)).toBe(false);
    expect(scrollStopped(1100, 1000, 150)).toBe(false);
    expect(scrollStopped(1150, 1000, 150)).toBe(true);
  });
});
