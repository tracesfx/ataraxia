import { beforeAll, describe, expect, it } from 'vitest';
import { BUILD_DROP, addKick, buildUpDropSong, clickTrack, silence } from '../syntheticSignals';
import { movingAverage, normalizeByQuantiles, pearson, quantile, slope } from './curves';
import {
  ANALYSIS_VERSION,
  FEATURE_FRAME_MS,
  analysisBuffers,
  analyzeAudio,
  analyzeAudioSteps,
  frameAt,
  meanOver,
  smoothingBeatMs,
  valueAt,
  type AudioAnalysis,
} from './index';

let song: AudioAnalysis;
beforeAll(() => {
  song = analyzeAudio(buildUpDropSong(), BUILD_DROP.rate);
});

describe('audio analysis of a build-up and a drop', () => {
  it('produces every curve on one ~50 Hz frame grid', () => {
    expect(song.version).toBe(ANALYSIS_VERSION);
    expect(song.frameMs).toBe(FEATURE_FRAME_MS);
    expect(song.frameCount).toBe(Math.ceil(BUILD_DROP.durationMs / FEATURE_FRAME_MS));
    for (const curve of [
      song.rms,
      song.loudness,
      song.bands.low,
      song.bands.mid,
      song.bands.high,
      song.bandFlux.low,
      song.bandFlux.mid,
      song.bandFlux.high,
      song.onsetEnvelope,
      song.brightness,
      song.onsetDensity,
      song.intensity,
    ]) {
      expect(curve).toHaveLength(song.frameCount);
      expect(curve.every((v) => Number.isFinite(v))).toBe(true);
    }
    for (const c of [song.loudness, song.brightness, song.intensity]) {
      expect(Math.min(...c)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...c)).toBeLessThanOrEqual(1);
    }
    expect(analysisBuffers(song)).toHaveLength(12);
  });

  it('finds the tempo of the drop', () => {
    expect(song.tempo.bpm).toBe(BUILD_DROP.bpm);
    expect(song.beatMs).toBeCloseTo(500, 5);
  });

  it('rates the drop far more intense than the build-up, and the build-up above silence', () => {
    const build = meanOver(
      song,
      song.intensity,
      BUILD_DROP.buildUpStartMs,
      BUILD_DROP.buildUpEndMs,
    );
    const drop = meanOver(song, song.intensity, BUILD_DROP.dropMs + 500, BUILD_DROP.dropEndMs);
    const before = meanOver(song, song.intensity, 0, 1500);
    expect(drop).toBeGreaterThan(0.85);
    expect(build).toBeLessThan(drop - 0.2);
    expect(build).toBeGreaterThan(before);
  });

  it('puts the low band and punch where the kicks are', () => {
    const lowBuild = meanOver(
      song,
      song.bands.low,
      BUILD_DROP.buildUpStartMs,
      BUILD_DROP.buildUpEndMs,
    );
    const lowDrop = meanOver(song, song.bands.low, BUILD_DROP.dropMs, BUILD_DROP.dropEndMs);
    expect(lowDrop).toBeGreaterThan(lowBuild * 3);
  });

  it('detects the build-up and ends it at the drop', () => {
    expect(song.buildUps.length).toBeGreaterThanOrEqual(1);
    const b = song.buildUps.find((x) => x.endMs > BUILD_DROP.buildUpStartMs + 4000);
    expect(b).toBeDefined();
    expect(b?.endMs).toBeGreaterThan(BUILD_DROP.dropMs - 1500);
    expect(b?.endMs).toBeLessThanOrEqual(BUILD_DROP.dropMs + 100);
    // Nothing in the drop itself is a build-up.
    for (const x of song.buildUps) expect(x.startMs).toBeLessThan(BUILD_DROP.dropMs);
  });

  it('marks the drop as an impact after the build-up, and not every kick', () => {
    const drop = song.impacts.find((i) => Math.abs(i.t - BUILD_DROP.dropMs) < 40);
    expect(drop?.kind).toBe('drop');
    expect(drop?.afterBuildUp).toBe(true);
    expect(drop?.strength).toBeGreaterThan(0.6);
    // 32 kicks in the drop: steady hits are not impacts.
    const inDrop = song.impacts.filter(
      (i) => i.t > BUILD_DROP.dropMs + 100 && i.t < BUILD_DROP.dropEndMs - 100,
    );
    expect(inDrop.length).toBeLessThan(4);
  });

  it('finds the silence before the build-up', () => {
    expect(song.silences[0]?.startMs).toBe(0);
    expect(song.silences[0]?.endMs).toBeGreaterThanOrEqual(1500);
  });

  it('describes each onset by band', () => {
    const kick = song.onsets.find((o) => Math.abs(o.t - (BUILD_DROP.dropMs + 1000)) < 30);
    const tick = song.onsets.find((o) => Math.abs(o.t - (BUILD_DROP.buildUpStartMs + 4000)) < 30);
    expect(kick).toBeDefined();
    expect(kick && kick.low).toBeGreaterThan(0.3);
    if (tick) expect(tick.low).toBeLessThan(tick.high);
    for (const o of song.onsets) {
      expect(o.broadband).toBeGreaterThanOrEqual(0);
      expect(o.broadband).toBeLessThanOrEqual(1);
    }
  });

  it('reports progress from 0 to 1 and is deterministic', () => {
    const steps = analyzeAudioSteps(buildUpDropSong(), BUILD_DROP.rate);
    const progress: number[] = [];
    let r = steps.next();
    while (!r.done) {
      progress.push(r.value);
      r = steps.next();
    }
    expect(progress.length).toBeGreaterThan(5);
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] as number);
    expect(progress[progress.length - 1]).toBe(1);
    expect(r.value.intensity).toEqual(song.intensity);
    expect(r.value.impacts).toEqual(song.impacts);
  });
});

describe('audio analysis edge cases', () => {
  it('handles silence: no onsets, no impacts, flat intensity', () => {
    const a = analyzeAudio(silence(3000, 22050), 22050);
    expect(a.onsets).toEqual([]);
    expect(a.impacts).toEqual([]);
    expect(a.buildUps).toEqual([]);
    expect(Math.max(...a.intensity)).toBe(0);
    expect(a.tempo.bpm).toBeNull();
  });

  it('does not call a steady four-on-the-floor kick an impact', () => {
    const rate = 22050;
    const out = clickTrack({
      bpm: 120,
      offsetMs: 0,
      durationMs: 12000,
      sampleRate: rate,
      level: 0.1,
    });
    for (let t = 0; t < 12000; t += 500) addKick(out, t, 0.8, rate);
    const a = analyzeAudio(out, rate);
    // Only the very first kick (out of silence) may stand out.
    expect(a.impacts.filter((i) => i.t > 600).length).toBe(0);
  });

  it('rejects a bad sample rate', () => {
    expect(() => analyzeAudio(new Float32Array(10), 0)).toThrow(RangeError);
  });
});

describe('analysis helpers', () => {
  it('folds the smoothing beat into 70-180 BPM', () => {
    expect(smoothingBeatMs(120)).toBe(500);
    expect(smoothingBeatMs(240)).toBe(500);
    expect(smoothingBeatMs(50)).toBeCloseTo(600, 6);
    expect(smoothingBeatMs(null)).toBe(500);
  });

  it('reads curves at song times', () => {
    const a = { frameMs: 20, frameOffsetMs: 0, frameCount: 5 };
    const curve = new Float32Array([0, 1, 2, 3, 4]);
    expect(frameAt(a, 41)).toBe(2);
    expect(frameAt(a, 1000)).toBe(4);
    expect(valueAt(a, curve, 60)).toBe(3);
    expect(valueAt(a, curve, -100)).toBe(0);
    expect(meanOver(a, curve, 20, 60)).toBe(2);
  });

  it('computes quantiles, normalisation, smoothing, slopes and correlation', () => {
    const v = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(quantile(v, 0.5)).toBe(5);
    expect(quantile(v, 0.05)).toBeCloseTo(0.5, 6);
    const n = normalizeByQuantiles(v, 0.1, 0.9);
    expect(n[0]).toBe(0);
    expect(n[10]).toBe(1);
    expect(n[5]).toBeCloseTo(0.5, 6);
    expect(normalizeByQuantiles(new Float32Array([3, 3, 3]), 0.05, 0.95)).toEqual(
      new Float32Array(3),
    );
    expect(movingAverage(new Float32Array([0, 3, 0]), 1)).toEqual(new Float32Array([1.5, 1, 1.5]));
    expect(slope(v, 0, 10)).toBeCloseTo(1, 6);
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 6);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});
