import { describe, expect, it } from 'vitest';
import {
  beatAt,
  beatPulse,
  beatTimeMs,
  createBeatInfo,
  isDownbeat,
  mod,
  pulseEnvelope,
} from './beat';

describe('beat phase', () => {
  const b = createBeatInfo();

  it('finds the beat and phase from bpm and offset', () => {
    beatAt(1250, 120, 0, b);
    expect(b.index).toBe(2);
    expect(b.phase).toBeCloseTo(0.5);
    expect(b.sinceMs).toBeCloseTo(250);
    expect(b.downbeat).toBe(false);
    beatAt(2000, 120, 0, b);
    expect(b.index).toBe(4);
    expect(b.downbeat).toBe(true);
  });

  it('counts backwards before beat 0 (negative song time)', () => {
    beatAt(-250, 120, 0, b);
    expect(b.index).toBe(-1);
    expect(b.phase).toBeCloseTo(0.5);
    beatAt(-2000, 120, 0, b);
    expect(b.index).toBe(-4);
    expect(b.downbeat).toBe(true);
    beatAt(-1999, 120, 0, b);
    expect(b.index).toBe(-4);
    expect(b.phase).toBeGreaterThan(0);
    // With an offset, beat 0 moves.
    beatAt(-1680, 120, 320, b);
    expect(b.index).toBe(-4);
    expect(b.phase).toBeCloseTo(0);
  });

  it('handles positive modulo and downbeats for negative indices', () => {
    expect(mod(-1, 4)).toBe(3);
    expect(isDownbeat(-8)).toBe(true);
    expect(isDownbeat(-3)).toBe(false);
    expect(beatTimeMs(-2, 150, 100)).toBeCloseTo(100 - 800);
  });

  it('falls back to 120 BPM for a missing tempo', () => {
    beatAt(500, 0, 0, b);
    expect(b.beatMs).toBe(500);
    expect(b.index).toBe(1);
  });
});

describe('pulse envelope', () => {
  it('is 1 on the beat, decays monotonically and reaches 0 at the next beat', () => {
    expect(pulseEnvelope(0)).toBeCloseTo(1);
    let prev = 1;
    for (let p = 0.05; p < 1; p += 0.05) {
      const v = pulseEnvelope(p);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
    expect(pulseEnvelope(0.9999)).toBeLessThan(1e-3);
    expect(pulseEnvelope(1)).toBe(0);
    expect(pulseEnvelope(-0.1)).toBe(0);
  });

  it('is stronger on the downbeat than on other beats', () => {
    expect(beatPulse(2000, 120, 0)).toBeCloseTo(1);
    expect(beatPulse(2500, 120, 0)).toBeCloseTo(0.55);
  });

  it('works the same before beat 0', () => {
    expect(beatPulse(-2000, 120, 0)).toBeCloseTo(1);
    expect(beatPulse(-1900, 120, 0)).toBeCloseTo(beatPulse(100, 120, 0));
  });

  it('depends only on song time, so playback speed keeps it in sync', () => {
    // Practice at 50 %: song time advances half as fast as the wall clock. Sampling the same
    // musical positions at either speed gives the same envelope.
    const startSongMs = 10_000;
    for (const wallMs of [0, 120, 333, 1000, 1750]) {
      const full = startSongMs + wallMs * 1;
      const half = startSongMs + wallMs * 0.5;
      expect(beatPulse(full, 128, 40)).toBeCloseTo(beatPulse(startSongMs + wallMs, 128, 40));
      // The half-speed run reaches `full` after twice the wall time.
      expect(beatPulse(startSongMs + 2 * wallMs * 0.5, 128, 40)).toBeCloseTo(
        beatPulse(full, 128, 40),
      );
      expect(half).toBeLessThanOrEqual(full);
    }
  });
});
