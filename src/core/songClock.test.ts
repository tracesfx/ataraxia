import { describe, expect, it } from 'vitest';
import { SongClock } from './songClock';

/** A clock started at audio time 10 s at song time `songMs`. */
function runningAt(songMs: number, rate = 1): SongClock {
  const c = new SongClock();
  c.start(10, songMs, rate);
  return c;
}

describe('SongClock', () => {
  it('holds 0 until started, and the held time when stopped', () => {
    const c = new SongClock();
    expect(c.state).toBe('stopped');
    expect(c.songMsAt(123)).toBe(0);
    expect(c.audioSecAt(0)).toBeNull();
    c.start(10, 500);
    c.stop(2500);
    expect(c.songMsAt(99)).toBe(2500);
  });

  it('runs continuously through song time 0', () => {
    const c = runningAt(-3000);
    expect(c.songMsAt(10)).toBe(-3000);
    expect(c.songMsAt(12.999)).toBeCloseTo(-1, 6);
    expect(c.songMsAt(13)).toBeCloseTo(0, 6);
    expect(c.songMsAt(13.001)).toBeCloseTo(1, 6);
    // Equal audio steps give equal song steps on both sides of 0.
    const before = c.songMsAt(12.9) - c.songMsAt(12.8);
    const across = c.songMsAt(13.05) - c.songMsAt(12.95);
    expect(before).toBeCloseTo(100, 6);
    expect(across).toBeCloseTo(100, 6);
    expect(c.audioSecAt(0)).toBeCloseTo(13, 9);
  });

  it('pauses and resumes while negative without losing time', () => {
    const c = runningAt(-3000);
    c.pause(11);
    expect(c.state).toBe('paused');
    expect(c.songMsAt(11)).toBeCloseTo(-2000, 6);
    expect(c.songMsAt(50)).toBeCloseTo(-2000, 6);
    // A suspended context's clock stood still: resume at the pause time keeps the mapping.
    c.resume(c.pausedAtSec);
    expect(c.songMsAt(11)).toBeCloseTo(-2000, 6);
    expect(c.audioSecAt(0)).toBeCloseTo(13, 9);
    // Resuming later (the audio clock kept going) skips the paused time instead.
    c.pause(12);
    c.resume(20);
    expect(c.songMsAt(20)).toBeCloseTo(-1000, 6);
    expect(c.songMsAt(21)).toBeCloseTo(0, 6);
  });

  it('seeks into negative time while running and while paused', () => {
    const c = runningAt(5000);
    c.seek(-1500, 12);
    expect(c.songMsAt(12)).toBe(-1500);
    expect(c.songMsAt(13.5)).toBeCloseTo(0, 6);
    c.pause(13);
    c.seek(-800, 13);
    expect(c.songMsAt(13)).toBe(-800);
    c.resume(14);
    expect(c.songMsAt(14.8)).toBeCloseTo(0, 6);
  });

  it('seeks from negative to positive time', () => {
    const c = runningAt(-2000);
    expect(c.songMsAt(11)).toBeCloseTo(-1000, 6);
    c.seek(42_000, 11);
    expect(c.songMsAt(11)).toBe(42_000);
    expect(c.songMsAt(12)).toBeCloseTo(43_000, 6);
  });

  it('seeks during playback without disturbing the rate', () => {
    const c = runningAt(0, 0.75);
    c.seek(10_000, 20);
    expect(c.songMsAt(24)).toBeCloseTo(13_000, 6);
  });

  it.each([0.5, 0.75, 1])('runs at playback rate %s, also through 0', (rate) => {
    const c = runningAt(-1000, rate);
    expect(c.rate).toBe(rate);
    // Song time 0 comes 1 s / rate of audio time later.
    expect(c.audioSecAt(0)).toBeCloseTo(10 + 1 / rate, 9);
    expect(c.songMsAt(12)).toBeCloseTo(-1000 + 2000 * rate, 6);
  });

  it('changes rate without a jump', () => {
    const c = runningAt(-1000, 1);
    c.setRate(0.5, 10.5);
    expect(c.songMsAt(10.5)).toBeCloseTo(-500, 6);
    expect(c.songMsAt(11.5)).toBeCloseTo(0, 6);
    expect(() => c.setRate(0, 11)).toThrow(RangeError);
  });

  describe('audioStart', () => {
    it('schedules the audio in the future at offset 0 when the clock is negative', () => {
      const c = runningAt(-2500);
      expect(c.audioStart(0, 60_000)).toEqual({ atAudioSec: 12.5, offsetSec: 0 });
    });

    it('starts at the clock position when it is already inside the song', () => {
      const c = runningAt(4000);
      expect(c.audioStart(0, 60_000)).toEqual({ atAudioSec: 10, offsetSec: 4 });
    });

    it('can hold the audio back to a later song time (silent run-in)', () => {
      const c = runningAt(1000, 0.5);
      const plan = c.audioStart(3000, 60_000);
      expect(plan?.offsetSec).toBe(3);
      expect(plan?.atAudioSec).toBeCloseTo(14, 9);
    });

    it('gives null past the end or when not running', () => {
      expect(runningAt(61_000).audioStart(0, 60_000)).toBeNull();
      expect(new SongClock().audioStart(0, 60_000)).toBeNull();
    });
  });
});
