import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, QUALITY, lowerQuality } from './quality';

function run(q: AdaptiveQuality, frames: number, costMs: number, frameMs: number): number {
  let drops = 0;
  for (let i = 0; i < frames; i++) if (q.sample(costMs, frameMs)) drops += 1;
  return drops;
}

describe('quality presets', () => {
  it('render smaller with fewer particles as quality falls', () => {
    expect(QUALITY.high.renderScale).toBe(1);
    expect(QUALITY.medium.renderScale).toBe(0.75);
    expect(QUALITY.high.particleCap).toBe(600);
    expect(QUALITY.medium.particleCap).toBeLessThan(QUALITY.high.particleCap);
    expect(QUALITY.low.particleCap).toBeLessThan(QUALITY.medium.particleCap);
    expect(lowerQuality('high')).toBe('medium');
    expect(lowerQuality('low')).toBe('low');
  });
});

describe('adaptive quality', () => {
  it('stays put while the background is cheap and frames are on time', () => {
    const q = new AdaptiveQuality('high', { window: 30 });
    expect(run(q, 600, 0.8, 16.7)).toBe(0);
    expect(q.current).toBe('high');
  });

  it('steps down when the background costs too much, one level per window after a cooldown', () => {
    const q = new AdaptiveQuality('high', { window: 30, cooldown: 20 });
    expect(run(q, 30, 5, 16.7)).toBe(1);
    expect(q.current).toBe('medium');
    // Cooldown: no judgement for 20 frames, then another full window.
    expect(run(q, 49, 5, 16.7)).toBe(0);
    expect(run(q, 1, 5, 16.7)).toBe(1);
    expect(q.current).toBe('low');
    expect(run(q, 500, 5, 16.7)).toBe(0);
    expect(q.current).toBe('low');
    expect(q.drops).toBe(2);
  });

  it('steps down on slow frames only when the background takes a real share', () => {
    const slowGame = new AdaptiveQuality('high', { window: 30 });
    expect(run(slowGame, 300, 0.1, 30)).toBe(0);
    const slowBg = new AdaptiveQuality('high', { window: 30 });
    expect(run(slowBg, 30, 1.5, 30)).toBe(1);
  });

  it('does not treat a capped frame rate as slow', () => {
    const q = new AdaptiveQuality('high', { window: 30 });
    q.setFrameBudget(1000 / 30);
    expect(run(q, 300, 1.5, 33.3)).toBe(0);
  });

  it('ignores stalls (tab switches) and restarts from a new preset', () => {
    const q = new AdaptiveQuality('high', { window: 10 });
    expect(run(q, 50, 9, 1000)).toBe(0);
    run(q, 10, 9, 16);
    expect(q.current).toBe('medium');
    q.reset('high');
    expect(q.current).toBe('high');
    expect(q.drops).toBe(0);
    expect(q.configured).toBe('high');
  });
});
