import { describe, expect, it } from 'vitest';
import { REST_LEVEL, motionSpeed, reactiveLevel, toStep } from './curves';

const levels = Array.from({ length: 11 }, (_, i) => i / 10);

describe('intensity-to-parameter curves', () => {
  it('reactivity scales the level toward a calm rest level', () => {
    expect(reactiveLevel(1, 1)).toBe(1);
    expect(reactiveLevel(0, 1)).toBe(0);
    expect(reactiveLevel(1, 0)).toBe(REST_LEVEL);
    expect(reactiveLevel(0, 0)).toBe(REST_LEVEL);
    expect(reactiveLevel(1, 0.5)).toBeCloseTo(REST_LEVEL + (1 - REST_LEVEL) / 2);
    expect(reactiveLevel(5, 2)).toBe(1);
  });

  it('motion speed rises with the level', () => {
    for (let i = 1; i < levels.length; i++) {
      expect(motionSpeed(levels[i]!)).toBeGreaterThan(motionSpeed(levels[i - 1]!));
    }
    expect(motionSpeed(0)).toBeGreaterThan(0);
  });

  it('steps clamp to the ladder', () => {
    expect(toStep(0.5, 2)).toBe(1);
    expect(toStep(-1, 2)).toBe(0);
    expect(toStep(3, 2)).toBe(2);
  });
});
