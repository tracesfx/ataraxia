import { describe, expect, it } from 'vitest';
import type { Judgement } from './judgement';
import { MAX_SCORE, ScoreTracker } from './scoring';

function track(total: number, judgements: Judgement[]): ScoreTracker {
  const s = new ScoreTracker(total);
  for (const j of judgements) {
    if (j === 'miss') s.breakCombo();
    else s.addCombo();
    s.resolve(j);
  }
  return s;
}

describe('ScoreTracker', () => {
  it.each([1, 3, 7, 97, 333, 1001])('all Perfect on %i notes is exactly 1,000,000', (n) => {
    const s = track(n, new Array<Judgement>(n).fill('perfect'));
    expect(s.score).toBe(MAX_SCORE);
    expect(s.accuracy).toBe(100);
    expect(s.maxCombo).toBe(n);
  });

  it('weights Perfect 100%, Great 70%, Good 40%, Miss 0%', () => {
    expect(track(1, ['great']).score).toBe(700_000);
    expect(track(1, ['good']).score).toBe(400_000);
    expect(track(1, ['miss']).score).toBe(0);
    expect(track(4, ['perfect', 'great', 'good', 'miss']).score).toBe(525_000);
  });

  it('never rounds a non-perfect run up to the maximum', () => {
    const js = new Array<Judgement>(999).fill('perfect');
    js.push('great');
    expect(track(1000, js).score).toBe(999_700);
    const many = new Array<Judgement>(99_999).fill('perfect');
    many.push('great');
    expect(track(100_000, many).score).toBeLessThan(MAX_SCORE);
  });

  it('accuracy is weighted over judged notes only', () => {
    const s = track(10, ['perfect', 'good']);
    expect(s.accuracy).toBe(70);
    expect(new ScoreTracker(10).accuracy).toBe(100);
  });

  it('counts each judgement', () => {
    const s = track(5, ['perfect', 'perfect', 'great', 'good', 'miss']);
    expect(s.counts).toEqual({ perfect: 2, great: 1, good: 1, miss: 1 });
    expect(s.judged).toBe(5);
  });

  it('combo resets on a break and max combo remembers the best run', () => {
    const s = track(6, ['perfect', 'great', 'good', 'miss', 'perfect', 'perfect']);
    expect(s.combo).toBe(2);
    expect(s.maxCombo).toBe(3);
  });

  it('empty charts score 0', () => {
    expect(new ScoreTracker(0).score).toBe(0);
  });

  it('rejects invalid note counts', () => {
    expect(() => new ScoreTracker(-1)).toThrow(RangeError);
    expect(() => new ScoreTracker(1.5)).toThrow(RangeError);
  });
});
