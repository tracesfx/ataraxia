import { describe, expect, it } from 'vitest';
import { parseChart } from '../../core/parseChart';
import { createDemoChart } from '../demo/demoChart';
import { stressChart } from './stressChart';

describe('stressChart', () => {
  it('is a valid, dense chart', () => {
    const chart = stressChart(createDemoChart(), 60_000);
    const parsed = parseChart(JSON.parse(JSON.stringify(chart)));
    expect(parsed.errors).toEqual([]);
    expect(chart.notes.length).toBeGreaterThan(1200);
    expect(chart.notes.some((n) => n.type === 'hold')).toBe(true);
  });
});
