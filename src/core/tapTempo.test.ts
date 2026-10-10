import { describe, expect, it } from 'vitest';
import { TAP_TEMPO_RESET_MS, TapTempo } from './tapTempo';

describe('TapTempo', () => {
  it('has no BPM until the second tap', () => {
    const t = new TapTempo();
    expect(t.tap(1000)).toBeNull();
    expect(t.tap(1500)).toBe(120);
    expect(t.count).toBe(2);
  });

  it('averages the intervals of the taps so far', () => {
    const t = new TapTempo();
    // Intervals 500, 400, 600: mean 500 ms -> 120 BPM.
    for (const ms of [0, 500, 900, 1500]) t.tap(ms);
    expect(t.bpm).toBeCloseTo(120, 9);
  });

  it('uses only the last 8 taps', () => {
    const t = new TapTempo();
    // Four slow taps (1000 ms apart), then eight at 400 ms: the window forgets the slow ones.
    let ms = 0;
    for (let i = 0; i < 4; i++) t.tap((ms += 1000));
    for (let i = 0; i < 8; i++) t.tap((ms += 400));
    expect(t.count).toBe(8);
    expect(t.bpm).toBeCloseTo(150, 9);
  });

  it('averages jittery taps to the underlying tempo', () => {
    const t = new TapTempo();
    const jitter = [0, 12, -9, 7, -14, 3, 10, -6];
    jitter.forEach((j, i) => t.tap(10_000 + i * (60000 / 173) + j));
    // Error = (last jitter - first jitter) / 7 intervals: within 1 BPM.
    expect(t.bpm).not.toBeNull();
    expect(Math.abs((t.bpm as number) - 173)).toBeLessThan(1);
  });

  it(`resets after a gap longer than ${TAP_TEMPO_RESET_MS} ms`, () => {
    const t = new TapTempo();
    t.tap(0);
    t.tap(500);
    t.tap(1000);
    expect(t.tap(1000 + TAP_TEMPO_RESET_MS + 1)).toBeNull();
    expect(t.count).toBe(1);
    expect(t.tap(1000 + TAP_TEMPO_RESET_MS + 1 + 300)).toBe(200);
  });

  it('does not reset on a gap of exactly the limit', () => {
    const t = new TapTempo();
    t.tap(0);
    expect(t.tap(TAP_TEMPO_RESET_MS)).toBe(30);
  });

  it('restarts when time goes backwards (a new clock) and on reset()', () => {
    const t = new TapTempo();
    t.tap(5000);
    t.tap(5500);
    expect(t.tap(100)).toBeNull();
    t.tap(600);
    t.reset();
    expect(t.count).toBe(0);
    expect(t.bpm).toBeNull();
  });

  it('rejects a window smaller than two taps', () => {
    expect(() => new TapTempo(1)).toThrow(RangeError);
  });
});
