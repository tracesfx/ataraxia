import { describe, expect, it } from 'vitest';
import {
  analyzeOnsets,
  analyzeOnsetsSteps,
  downsample,
  downsampleFactor,
  localMedian,
  percentile,
} from './onsets';
import { addTone, clickTimes, clickTrack, silence, whiteNoise } from './syntheticSignals';

describe('downsampling', () => {
  it('averages groups of samples', () => {
    expect([...downsample(Float32Array.from([1, 3, 5, 7, 9]), 2)]).toEqual([2, 6]);
    const same = Float32Array.from([1, 2]);
    expect(downsample(same, 1)).toBe(same);
  });

  it('picks a whole factor that keeps the rate at or above the analysis rate', () => {
    expect(downsampleFactor(44100)).toBe(4);
    expect(downsampleFactor(48000)).toBe(4);
    expect(downsampleFactor(22050)).toBe(2);
    expect(downsampleFactor(8000)).toBe(1);
  });
});

describe('helpers', () => {
  it('computes a running median and percentiles', () => {
    const v = Float32Array.from([0, 0, 10, 0, 0, 0, 0]);
    expect([...localMedian(v, 2)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([], 0.9)).toBe(0);
  });
});

describe('analyzeOnsets', () => {
  it('finds every click of a click track within a few ms', () => {
    const opts = { bpm: 128, offsetMs: 237, durationMs: 20000 };
    const analysis = analyzeOnsets(clickTrack(opts), 44100);
    const truth = clickTimes(opts);
    expect(analysis.onsets).toHaveLength(truth.length);
    analysis.onsets.forEach((o, i) => {
      expect(Math.abs(o.t - truth[i]!)).toBeLessThan(4);
    });
  });

  it('gives accented clicks a higher strength', () => {
    const analysis = analyzeOnsets(
      clickTrack({ bpm: 120, offsetMs: 100, durationMs: 10000, accentEvery: 4, level: 0.4 }),
      44100,
    );
    const [first, second] = analysis.onsets;
    expect(first!.strength).toBeGreaterThan(second!.strength + 0.2);
    expect(Math.max(...analysis.onsets.map((o) => o.strength))).toBeLessThanOrEqual(1);
  });

  it('works at 48 kHz', () => {
    const opts = { bpm: 100, offsetMs: 50, durationMs: 8000, sampleRate: 48000 };
    const analysis = analyzeOnsets(clickTrack(opts), 48000);
    expect(analysis.onsets).toHaveLength(clickTimes(opts).length);
    expect(Math.abs(analysis.onsets[3]!.t - clickTimes(opts)[3]!)).toBeLessThan(4);
  });

  it('finds nothing in silence or steady noise', () => {
    expect(analyzeOnsets(silence(10000), 44100).onsets).toEqual([]);
    expect(analyzeOnsets(whiteNoise(20000), 44100).onsets).toEqual([]);
  });

  it('handles audio shorter than one frame', () => {
    const analysis = analyzeOnsets(new Float32Array(100), 44100);
    expect(analysis.onsets).toEqual([]);
    expect(analysis.novelty).toHaveLength(0);
  });

  it('reports a sustained tone in the energy envelope', () => {
    const signal = silence(4000);
    addTone(signal, 1000, 1500, 330, 0.5);
    const a = analyzeOnsets(signal, 44100);
    const at = (ms: number): number => a.energy[Math.round((ms - a.frameOffsetMs) / a.hopMs)]!;
    expect(at(1700)).toBeGreaterThan(0.3);
    expect(at(3200)).toBeLessThan(0.01);
  });

  it('yields increasing progress up to 1', () => {
    const steps = analyzeOnsetsSteps(
      clickTrack({ bpm: 120, offsetMs: 0, durationMs: 30000 }),
      44100,
    );
    const progress: number[] = [];
    for (let r = steps.next(); !r.done; r = steps.next()) progress.push(r.value);
    expect(progress.length).toBeGreaterThan(3);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
    expect(progress.at(-1)).toBe(1);
  });
});
