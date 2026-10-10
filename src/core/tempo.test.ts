import { describe, expect, it } from 'vitest';
import type { Onset } from './onsets';
import { analyzeOnsets } from './onsets';
import { seededRandom } from './random';
import { clickTrack, silence, whiteNoise } from './syntheticSignals';
import {
  confidenceLevel,
  estimateTempo,
  fitGrid,
  gridDistance,
  tempoPrior,
  type TempoEstimate,
} from './tempo';

function estimateClicks(
  bpm: number,
  offsetMs: number,
  accentEvery = 4,
  noise = 0.02,
): TempoEstimate {
  const signal = clickTrack({ bpm, offsetMs, durationMs: 30000, accentEvery, noise });
  return estimateTempo(analyzeOnsets(signal, 44100));
}

/** Onsets exactly on a grid (for the pure grid-fit tests). */
function gridOnsets(bpm: number, offsetMs: number, count: number, accentEvery = 0): Onset[] {
  return Array.from({ length: count }, (_, k) => ({
    t: offsetMs + (k * 60000) / bpm,
    strength: accentEvery && k % accentEvery === 0 ? 1 : 0.6,
  }));
}

describe('estimateTempo on click tracks', () => {
  it.each([
    [128, 237],
    [140, 412],
    [93.5, 85],
  ])('finds %s BPM with beat 0 at %s ms', (bpm, offsetMs) => {
    const e = estimateClicks(bpm, offsetMs);
    expect(e.bpm).not.toBeNull();
    expect(Math.abs(e.bpm! - bpm)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(e.offsetMs - offsetMs)).toBeLessThanOrEqual(15);
    expect(confidenceLevel(e.confidence)).toBe('high');
  });

  it('finds the phase of unaccented clicks too (offset on the first click)', () => {
    const e = estimateClicks(140, 60, 0);
    expect(Math.abs(e.bpm! - 140)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(e.offsetMs - 60)).toBeLessThanOrEqual(15);
  });

  it('reports the double and half tempo as alternatives with offsets on the same beats', () => {
    const e = estimateClicks(128, 237);
    expect(e.alternatives.map((a) => a.bpm)).toEqual([256, 64]);
    for (const alt of e.alternatives) {
      expect(gridDistance(alt.offsetMs, 60000 / 128, 237)).toBeLessThanOrEqual(15);
    }
  });

  it('copes with a noisy recording', () => {
    const e = estimateClicks(140, 300, 4, 0.15);
    expect(Math.abs(e.bpm! - 140)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(e.offsetMs - 300)).toBeLessThanOrEqual(15);
  });

  it('gives no tempo and zero confidence for silence and white noise', () => {
    for (const signal of [silence(20000), whiteNoise(20000)]) {
      const e = estimateTempo(analyzeOnsets(signal, 44100));
      expect(e.bpm).toBeNull();
      expect(e.confidence).toBe(0);
      expect(confidenceLevel(e.confidence)).toBe('low');
    }
  });

  it('gives low confidence for clicks at random times', () => {
    const rand = seededRandom(3);
    const onsets: Onset[] = Array.from({ length: 80 }, () => ({
      t: rand() * 30000,
      strength: 0.5 + rand() * 0.5,
    })).sort((a, b) => a.t - b.t);
    const hopMs = 5.8;
    const novelty = new Float32Array(Math.ceil(30000 / hopMs));
    for (const o of onsets) novelty[Math.round(o.t / hopMs)] = o.strength;
    const e = estimateTempo({ onsets, novelty, hopMs });
    expect(confidenceLevel(e.confidence)).toBe('low');
  });
});

describe('grid fitting', () => {
  it('puts beat 0 on the accented beat, at the first downbeat', () => {
    // Accents every 4 beats starting with the third click: the downbeat is at click 2.
    const onsets = gridOnsets(120, 100, 40).map((o, k) => ({
      ...o,
      strength: k % 4 === 2 ? 1 : 0.5,
    }));
    const fit = fitGrid(onsets, 120);
    expect(fit.offsetMs).toBe(1100);
    expect(fit.fit).toBeGreaterThan(0.95);
  });

  it('keeps the offset at or after 0', () => {
    expect(fitGrid(gridOnsets(100, 30, 30, 4), 100).offsetMs).toBe(30);
  });

  it('measures circular grid distance', () => {
    expect(gridDistance(1010, 500, 0)).toBe(10);
    expect(gridDistance(990, 500, 0)).toBe(10);
    expect(gridDistance(-10, 500, 0)).toBe(10);
  });

  it('prefers tempos between 80 and 200 BPM', () => {
    expect(tempoPrior(80)).toBe(1);
    expect(tempoPrior(200)).toBe(1);
    expect(tempoPrior(60)).toBeLessThan(0.5);
    expect(tempoPrior(280)).toBeLessThan(0.5);
  });
});
