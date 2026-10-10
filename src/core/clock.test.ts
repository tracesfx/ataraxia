import { describe, expect, it } from 'vitest';
import { ClockSync, audioSecToSongMs, scrollY, songMsToAudioSec } from './clock';

describe('song anchor conversions', () => {
  const anchor = { audioSec: 10, songMs: -2000 };

  it('maps audio time to song time', () => {
    expect(audioSecToSongMs(10, anchor)).toBe(-2000);
    expect(audioSecToSongMs(12, anchor)).toBe(0);
    expect(audioSecToSongMs(12.5, anchor)).toBe(500);
  });

  it('round-trips', () => {
    expect(songMsToAudioSec(audioSecToSongMs(13.25, anchor), anchor)).toBeCloseTo(13.25, 9);
  });

  it('advances song time at the playback rate', () => {
    const half = { audioSec: 10, songMs: 1000, rate: 0.5 };
    expect(audioSecToSongMs(12, half)).toBe(2000);
    expect(songMsToAudioSec(2000, half)).toBe(12);
    const fast = { ...half, rate: 1.5 };
    expect(audioSecToSongMs(12, fast)).toBe(4000);
    expect(songMsToAudioSec(audioSecToSongMs(11.3, fast), fast)).toBeCloseTo(11.3, 9);
  });
});

describe('ClockSync (event timestamp -> song time)', () => {
  it('converts a performance timestamp using the sampled reference pair', () => {
    const sync = new ClockSync();
    // At performance.now() = 5000 ms the audio heard is at context time 3.0 s.
    sync.sample(5000, 3.0);
    expect(sync.toAudioSec(5000)).toBeCloseTo(3.0, 9);
    // A key event 120 ms earlier than the sample...
    expect(sync.toAudioSec(4880)).toBeCloseTo(2.88, 9);
    // ...in a song that hit 0 ms at audio time 2.5 s is at song time 380 ms.
    expect(sync.toSongMs(4880, { audioSec: 2.5, songMs: 0 })).toBeCloseTo(380, 6);
  });

  it('handles events after the sample and negative (lead-in) song times', () => {
    const sync = new ClockSync();
    sync.sample(1000, 0.5);
    expect(sync.toSongMs(1250, { audioSec: 2.0, songMs: 0 })).toBeCloseTo(-1250, 6);
  });

  it('does not depend on how often samples arrive (frame rate)', () => {
    const at30 = new ClockSync();
    const at144 = new ClockSync();
    for (let t = 0; t <= 1000; t += 1000 / 30) at30.sample(t, (t + 200) / 1000);
    for (let t = 0; t <= 1000; t += 1000 / 144) at144.sample(t, (t + 200) / 1000);
    expect(at30.toAudioSec(777)).toBeCloseTo(0.977, 6);
    expect(at144.toAudioSec(777)).toBeCloseTo(0.977, 6);
  });

  it('smooths small jitter', () => {
    const sync = new ClockSync(0.1, 25);
    sync.sample(0, 1.0); // offset 1000
    sync.sample(16, 1.026); // raw offset 1010: averaged, not adopted
    expect(sync.toAudioSec(0) * 1000).toBeCloseTo(1001, 6);
  });

  it('resets on a large jump (e.g. after the audio context was suspended)', () => {
    const sync = new ClockSync(0.1, 25);
    sync.sample(0, 1.0);
    sync.sample(5000, 1.5); // audio clock was frozen for 4.5 s
    expect(sync.toAudioSec(5000)).toBeCloseTo(1.5, 9);
  });

  it('throws before the first sample, and after reset', () => {
    const sync = new ClockSync();
    expect(sync.hasSample).toBe(false);
    expect(() => sync.toAudioSec(0)).toThrow();
    sync.sample(0, 0);
    expect(sync.hasSample).toBe(true);
    sync.reset();
    expect(() => sync.toAudioSec(0)).toThrow();
  });
});

describe('scrollY', () => {
  it('puts a note on the hit line at its time and above it before', () => {
    expect(scrollY(1000, 1000, 230, 0.35)).toBe(230);
    expect(scrollY(2000, 1000, 230, 0.35)).toBeCloseTo(-120, 9);
    expect(scrollY(1000, 1100, 230, 0.35)).toBeCloseTo(265, 9);
  });

  it('works during the negative lead-in', () => {
    expect(scrollY(0, -200, 230, 0.35)).toBeCloseTo(160, 9);
  });
});
