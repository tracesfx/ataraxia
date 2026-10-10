import { describe, expect, it } from 'vitest';
import { noteEnd } from '../../core/chart';
import { parseChart, serializeChart } from '../../core/parseChart';
import { DEMO_DURATION_MS, DEMO_SECTIONS, createDemoChart, demoTimeMs } from './demoChart';

describe('demo chart', () => {
  const chart = createDemoChart();

  it('is a valid chart', () => {
    const result = parseChart(JSON.parse(JSON.stringify(chart)));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(parseChart(serializeChart(chart)).chart).toEqual(chart);
  });

  it('fits inside the song and leaves the intro empty', () => {
    const first = Math.min(...chart.notes.map((n) => n.t));
    const last = Math.max(...chart.notes.map(noteEnd));
    expect(first).toBe(demoTimeMs(DEMO_SECTIONS.singles[0]));
    expect(last).toBeLessThan(DEMO_DURATION_MS);
  });

  it('has taps, holds, jumps and a 16th-note stream', () => {
    const taps = chart.notes.filter((n) => n.type === 'tap');
    const holds = chart.notes.filter((n) => n.type === 'hold');
    expect(taps.length).toBeGreaterThan(100);
    expect(holds.length).toBeGreaterThanOrEqual(5);

    const byTime = new Map<number, number>();
    for (const n of chart.notes) byTime.set(n.t, (byTime.get(n.t) ?? 0) + 1);
    expect([...byTime.values()].filter((c) => c === 2).length).toBeGreaterThan(10);

    const times = [...byTime.keys()].sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
    expect(Math.min(...gaps)).toBe(125); // 16ths at 120 BPM
  });

  it('stays playable: no chords wider than two notes, no same-lane notes closer than 250 ms', () => {
    const byTime = new Map<number, number>();
    for (const n of chart.notes) byTime.set(n.t, (byTime.get(n.t) ?? 0) + 1);
    expect(Math.max(...byTime.values())).toBe(2);

    for (const lane of [0, 1, 2, 3]) {
      const inLane = chart.notes.filter((n) => n.lane === lane);
      for (let i = 1; i < inLane.length; i++) {
        expect(inLane[i]!.t - noteEnd(inLane[i - 1]!)).toBeGreaterThanOrEqual(250);
      }
    }
  });
});
