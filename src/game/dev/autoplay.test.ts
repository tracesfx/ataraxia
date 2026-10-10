import { describe, expect, it } from 'vitest';
import { PlaySession } from '../../core/playSession';
import { createDemoChart } from '../demo/demoChart';
import { Autoplay, autoplayErrorMs, autoplayMode } from './autoplay';

function run(mode: 'perfect' | 'jitter'): PlaySession {
  const chart = createDemoChart();
  const session = new PlaySession(chart.notes);
  const auto = new Autoplay(mode);
  const input = {
    press: (lane: 0 | 1 | 2 | 3, ms: number) => void session.press(lane, ms),
    release: (lane: 0 | 1 | 2 | 3, ms: number) => void session.release(lane, ms),
  };
  for (let now = -2000; now < 70_000; now += 16) {
    auto.step(session.notes, now, input);
    session.update(now);
  }
  return session;
}

describe('autoplay', () => {
  it('reads the mode from the query string', () => {
    expect(autoplayMode('')).toBeNull();
    expect(autoplayMode('?autoplay')).toBe('perfect');
    expect(autoplayMode('?x=1&autoplay=jitter')).toBe('jitter');
  });

  it('plays every note perfectly', () => {
    const s = run('perfect').summary();
    expect(s.counts.miss).toBe(0);
    expect(s.counts.perfect).toBe(s.totalNotes);
  });

  it('jitter stays inside the hit window and is repeatable', () => {
    for (let i = 0; i < 500; i++)
      expect(Math.abs(autoplayErrorMs('jitter', i))).toBeLessThanOrEqual(90);
    expect(run('jitter').summary().score).toBe(run('jitter').summary().score);
  });
});
