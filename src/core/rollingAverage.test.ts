import { describe, expect, it } from 'vitest';
import { RollingAverage } from './rollingAverage';

describe('RollingAverage', () => {
  it('is null when empty', () => {
    expect(new RollingAverage(20).average).toBeNull();
  });

  it('averages only the last N values', () => {
    const avg = new RollingAverage(3);
    [10, -10, 4, 6, 8].forEach((v) => avg.push(v));
    expect(avg.count).toBe(3);
    expect(avg.average).toBe(6);
  });

  it('clears', () => {
    const avg = new RollingAverage(2);
    avg.push(5);
    avg.clear();
    expect(avg.average).toBeNull();
    expect(avg.count).toBe(0);
  });

  it('rejects bad sizes', () => {
    expect(() => new RollingAverage(0)).toThrow(RangeError);
  });
});
