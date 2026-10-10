import { describe, expect, it } from 'vitest';
import { validatedChart } from '../../core/noteEdit';
import { sampleChartNotes } from './devSampleChart';

describe('sampleChartNotes', () => {
  it('builds a valid chart with taps and holds', () => {
    const notes = sampleChartNotes(120, 0, 60_000);
    expect(notes.length).toBeGreaterThan(50);
    expect(notes.some((n) => n.type === 'hold')).toBe(true);
    const checked = validatedChart({
      version: 2,
      title: 'Sample',
      artist: 'Dev',
      audio: 'x.ogg',
      bpm: 120,
      offsetMs: 0,
      previewStartMs: 0,
      difficulty: 'Normal',
      level: 5,
      charter: 'Dev',
      notes,
    });
    expect(checked.ok).toBe(true);
  });
});
