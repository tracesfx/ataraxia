import { describe, expect, it } from 'vitest';
import { AUTO_START_LEAD_MS, autoStartMs, effectiveStartMs, type Note } from './chart';

const tap = (t: number): Note => ({ t, lane: 0, type: 'tap' });

describe('effective start', () => {
  it('starts at 0 for an empty chart or one with a quiet intro', () => {
    expect(autoStartMs([])).toBe(0);
    expect(autoStartMs([tap(1500)])).toBe(0);
    expect(autoStartMs([tap(20_000), tap(30_000)])).toBe(0);
  });

  it(`starts ${AUTO_START_LEAD_MS} ms before an early first note`, () => {
    expect(autoStartMs([tap(1000)])).toBe(-500);
    expect(autoStartMs([tap(0)])).toBe(-1500);
    expect(autoStartMs([tap(-4000), tap(200)])).toBe(-5500);
  });

  it('never starts more than 30 s before the audio', () => {
    expect(autoStartMs([tap(-30_000)])).toBe(-30_000);
  });

  it('uses the custom start when there is one, even after the first note', () => {
    expect(effectiveStartMs({ notes: [tap(0)], startMs: -3000 })).toBe(-3000);
    expect(effectiveStartMs({ notes: [tap(0)], startMs: 0 })).toBe(0);
    expect(effectiveStartMs({ notes: [tap(0)] })).toBe(-1500);
  });
});
