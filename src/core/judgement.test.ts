import { describe, expect, it } from 'vitest';
import { HIT_WINDOW_MS, judgeError, worseJudgement } from './judgement';

describe('judgeError', () => {
  it.each([
    [0, 'perfect'],
    [40, 'perfect'],
    [41, 'great'],
    [80, 'great'],
    [81, 'good'],
    [120, 'good'],
    [121, 'miss'],
    [500, 'miss'],
  ] as const)('%i ms late and early is %s', (ms, expected) => {
    expect(judgeError(ms)).toBe(expected);
    expect(judgeError(-ms)).toBe(expected);
  });

  it('treats fractional errors past a boundary as the next grade', () => {
    expect(judgeError(40.5)).toBe('great');
    expect(judgeError(-120.01)).toBe('miss');
  });

  it('the hit window is the Good window', () => {
    expect(HIT_WINDOW_MS).toBe(120);
  });
});

describe('worseJudgement', () => {
  it('returns the lower grade', () => {
    expect(worseJudgement('perfect', 'good')).toBe('good');
    expect(worseJudgement('great', 'good')).toBe('good');
    expect(worseJudgement('good', 'good')).toBe('good');
    expect(worseJudgement('miss', 'good')).toBe('miss');
    expect(worseJudgement('good', 'perfect')).toBe('good');
  });
});
