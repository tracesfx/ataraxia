import { describe, expect, it } from 'vitest';
import type { Note } from '../../core/chart';
import { compareCharts } from './calibration';

/** A flat analysis: intensity rising over the song, onsets every 250 ms. */
function rampAnalysis(durationMs: number): Parameters<typeof compareCharts>[0] {
  const frameMs = 20;
  const frameCount = Math.ceil(durationMs / frameMs);
  const intensity = new Float32Array(frameCount).map((_, n) => n / frameCount);
  const onsets = [];
  for (let t = 0; t < durationMs; t += 250) {
    onsets.push({ t, strength: (t % 1000) / 1000, low: 0, mid: 0, high: 0, broadband: 0 });
  }
  return { frameMs, frameOffsetMs: 0, frameCount, intensity, loudness: intensity, onsets };
}

const taps = (times: readonly number[]): Note[] => times.map((t) => ({ t, lane: 0, type: 'tap' }));

describe('chart comparison', () => {
  it('scores a chart against itself as a perfect match', () => {
    const a = rampAnalysis(32000);
    const notes = taps(Array.from({ length: 100 }, (_, i) => Math.round(i * 300 + (i % 7) * 20)));
    const r = compareCharts(a, notes, notes, 120, 0);
    expect(r.correlation).toBeCloseTo(1, 6);
    expect(r.ratioError).toBeCloseTo(0, 6);
    expect(r.windows).toBeGreaterThan(10);
  });

  it('sees a density curve that follows the reference, and one that does not', () => {
    const a = rampAnalysis(32000);
    // Reference: denser later. Follower: the same shape at double density. Opposite: reversed.
    const ref: number[] = [];
    const follow: number[] = [];
    const opposite: number[] = [];
    for (let t = 0; t < 32000; t += 50) {
      const p = t / 32000;
      if ((t / 50) % Math.max(1, Math.round(12 - 10 * p)) === 0) ref.push(t);
      if ((t / 50) % Math.max(1, Math.round(6 - 5 * p)) === 0) follow.push(t);
      if ((t / 50) % Math.max(1, Math.round(2 + 10 * p)) === 0) opposite.push(t);
    }
    expect(compareCharts(a, taps(ref), taps(follow), 120, 0).correlation).toBeGreaterThan(0.8);
    expect(compareCharts(a, taps(ref), taps(opposite), 120, 0).correlation).toBeLessThan(-0.5);
  });

  it('reports which onset strengths the reference charted', () => {
    const a = rampAnalysis(16000);
    // Chart only the strongest onsets (strength 0.75 at t % 1000 = 750).
    const ref = taps(a.onsets.filter((o) => o.strength >= 0.75).map((o) => o.t));
    const r = compareCharts(a, ref, ref, 120, 0);
    expect(r.charted.matchedShare).toBe(1);
    expect(r.charted.percentiles.p10).toBeGreaterThanOrEqual(0.7);
    expect(r.charted.byDecile[0]).toBe(0);
  });
});
