import { describe, expect, it, vi } from 'vitest';
import { analyzeAudio, type AudioAnalysis } from '../core/analysis';
import { clickTrack } from '../core/syntheticSignals';
import { AudioAnalyzer, type AnalysisCache } from './audioAnalysis';

const RATE = 22050;
const samples = clickTrack({ bpm: 120, offsetMs: 0, durationMs: 3000, sampleRate: RATE });

/** Just enough of an AudioBuffer for the analyzer (a fresh one per test: results are cached per buffer). */
function fakeBuffer(): AudioBuffer {
  return {
    numberOfChannels: 1,
    sampleRate: RATE,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

function memoryCache(initial: AudioAnalysis | null): AnalysisCache & { saved: AudioAnalysis[] } {
  const saved: AudioAnalysis[] = [];
  return {
    saved,
    load: () => Promise.resolve(initial ?? saved[saved.length - 1] ?? null),
    save: (a) => {
      saved.push(a);
      return Promise.resolve();
    },
  };
}

describe('AudioAnalyzer cache', () => {
  it('uses a cached analysis without computing or saving', async () => {
    const cached = analyzeAudio(samples, RATE);
    const cache = memoryCache(cached);
    const analyzer = new AudioAnalyzer(fakeBuffer(), cache);
    const progress = vi.fn();
    analyzer.onProgress(progress);
    expect(await analyzer.run()).toBe(cached);
    expect(cache.saved).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
    expect(analyzer.result).toBe(cached);
  });

  it('computes on a miss (main-thread fallback without workers), then saves once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache = memoryCache(null);
    const analyzer = new AudioAnalyzer(fakeBuffer(), cache);
    const ready = vi.fn();
    analyzer.onReady(ready);
    const first = await analyzer.run();
    expect(first.onsets.length).toBeGreaterThan(3);
    expect(first.intensity).toEqual(analyzeAudio(samples, RATE).intensity);
    expect(cache.saved).toEqual([first]);
    expect(ready).toHaveBeenCalledWith(first);
    expect(await analyzer.run()).toBe(first);
    expect(cache.saved).toHaveLength(1);
    warn.mockRestore();
  });

  it('peeks at the cache without computing', async () => {
    const empty = new AudioAnalyzer(fakeBuffer(), memoryCache(null));
    expect(await empty.peek()).toBeNull();
    expect(empty.running).toBe(false);
    const cached = analyzeAudio(samples, RATE);
    const full = new AudioAnalyzer(fakeBuffer(), memoryCache(cached));
    const ready = vi.fn();
    full.onReady(ready);
    expect(await full.peek()).toBe(cached);
    expect(ready).toHaveBeenCalledWith(cached);
  });
});
