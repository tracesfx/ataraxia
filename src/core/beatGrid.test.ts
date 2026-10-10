import { describe, expect, it } from 'vitest';
import {
  beatsInRange,
  displayDivision,
  formatMeasureBeat,
  formatTimestamp,
  gridLines,
  isDownbeat,
  measureOfBeat,
  stepMeasure,
  stepOnGrid,
  stepSnap,
} from './beatGrid';
import { SNAP_DIVISIONS, beatToMs, msToBeat, snapToGrid } from './time';

describe('gridLines', () => {
  it('marks measures, beats and subdivisions at 120 BPM, offset 0', () => {
    const lines = gridLines(0, 2000, 120, 0, 2);
    expect(lines.map((l) => l.ms)).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000]);
    expect(lines.map((l) => l.kind)).toEqual([
      'measure',
      'sub',
      'beat',
      'sub',
      'beat',
      'sub',
      'beat',
      'sub',
      'measure',
    ]);
    expect(lines[0]?.measure).toBe(1);
    expect(lines[8]?.measure).toBe(2);
    expect(lines[2]?.measure).toBeNull();
  });

  it('assigns the finest needed division as the tier', () => {
    const quarter = gridLines(0, 499, 120, 0, 4).map((l) => l.tier);
    expect(quarter).toEqual([1, 4, 2, 4]);
    const twelfth = gridLines(0, 499, 120, 0, 12).map((l) => l.tier);
    expect(twelfth).toEqual([1, 12, 6, 4, 3, 12, 2, 12, 3, 4, 6, 12]);
  });

  it('handles odd BPMs, offsets and times before beat 0', () => {
    const bpm = 173.37;
    const offsetMs = 2500;
    const lines = gridLines(0, 3000, bpm, offsetMs, 3);
    for (const line of lines) {
      expect(beatToMs(line.beat, bpm, offsetMs)).toBeCloseTo(line.ms, 9);
      expect(line.ms).toBeGreaterThanOrEqual(0);
      expect(line.ms).toBeLessThanOrEqual(3000);
    }
    const before = lines.filter((l) => l.ms < offsetMs);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((l) => l.beat < 0)).toBe(true);
    // Beat -4 is the downbeat of measure 0.
    const m0 = lines.find((l) => l.beat === -4);
    expect(m0?.kind).toBe('measure');
    expect(m0?.measure).toBe(0);
  });

  it('includes lines exactly on both range ends', () => {
    const lines = gridLines(500, 1000, 120, 0, 1);
    expect(lines.map((l) => l.ms)).toEqual([500, 1000]);
  });

  it('draws measure lines only with division 0', () => {
    const lines = gridLines(0, 10_000, 120, 100, 0);
    expect(lines.map((l) => l.ms)).toEqual([100, 2100, 4100, 6100, 8100]);
    expect(lines.every((l) => l.kind === 'measure')).toBe(true);
  });

  it('returns nothing for an inverted range and respects maxLines', () => {
    expect(gridLines(1000, 0, 120, 0, 4)).toEqual([]);
    expect(gridLines(0, 1e9, 120, 0, 16, 100)).toHaveLength(100);
  });
});

describe('displayDivision', () => {
  it('keeps the snap division while lines are far enough apart', () => {
    // 120 BPM at 0.2 px/ms: 100 px per beat.
    expect(displayDivision(0.2, 120, 4, 6)).toBe(4);
    expect(displayDivision(0.2, 120, 16, 6)).toBe(16);
  });

  it('falls back to beats, then measures, when zoomed out', () => {
    // 10 px per beat.
    expect(displayDivision(0.02, 120, 4, 6)).toBe(1);
    // 5 px per beat.
    expect(displayDivision(0.01, 120, 4, 6)).toBe(0);
  });
});

describe('stepOnGrid', () => {
  it('moves a whole step from a grid line', () => {
    expect(stepOnGrid(1000, 250, 0, 1)).toBe(1250);
    expect(stepOnGrid(1000, 250, 0, -1)).toBe(750);
  });

  it('moves to the nearest line in that direction from between lines', () => {
    expect(stepOnGrid(1010, 250, 0, 1)).toBe(1250);
    expect(stepOnGrid(1010, 250, 0, -1)).toBe(1000);
    expect(stepOnGrid(1240, 250, 0, -1)).toBe(1000);
  });

  it('treats a position within half a millisecond of a line as on it', () => {
    expect(stepOnGrid(1000.4, 250, 0, 1)).toBe(1250);
    expect(stepOnGrid(999.6, 250, 0, -1)).toBe(750);
  });

  it('rejects a non-positive step', () => {
    expect(() => stepOnGrid(0, 0, 0, 1)).toThrow(RangeError);
  });
});

describe('stepSnap at odd BPMs and offsets', () => {
  const cases = [
    { bpm: 173.37, offsetMs: 1234 },
    { bpm: 87.5, offsetMs: -312 },
    { bpm: 222.22, offsetMs: 7 },
    { bpm: 133.33, offsetMs: 0 },
  ];

  for (const { bpm, offsetMs } of cases) {
    for (const division of SNAP_DIVISIONS) {
      it(`${bpm} BPM, offset ${offsetMs}, 1/${division}: walks the grid without drift`, () => {
        let ms = snapToGrid(5000, bpm, offsetMs, division);
        const startStep = Math.round(msToBeat(ms, bpm, offsetMs) * division);
        // 200 steps forward then back must land on consecutive grid lines and return home.
        for (let i = 1; i <= 200; i++) {
          ms = stepSnap(ms, bpm, offsetMs, division, 1);
          expect(Number.isInteger(ms)).toBe(true);
          const exact = beatToMs((startStep + i) / division, bpm, offsetMs);
          expect(Math.abs(ms - exact)).toBeLessThanOrEqual(0.5);
        }
        for (let i = 0; i < 200; i++) ms = stepSnap(ms, bpm, offsetMs, division, -1);
        expect(ms).toBe(snapToGrid(5000, bpm, offsetMs, division));
      });
    }
  }

  it('snaps forward from an off-grid position to the next line', () => {
    // 150 BPM: 400 ms beats; offset 320. 1/4 grid = 100 ms steps from 320.
    expect(stepSnap(1000, 150, 320, 4, 1)).toBe(1020);
    expect(stepSnap(1000, 150, 320, 4, -1)).toBe(920);
  });
});

describe('stepMeasure', () => {
  it('moves by four beats along measure lines', () => {
    // 150 BPM: 1600 ms measures from offset 320.
    expect(stepMeasure(320, 150, 320, 1)).toBe(1920);
    expect(stepMeasure(1920, 150, 320, -1)).toBe(320);
    expect(stepMeasure(1000, 150, 320, 1)).toBe(1920);
    expect(stepMeasure(1000, 150, 320, -1)).toBe(320);
    expect(stepMeasure(320, 150, 320, -1)).toBe(-1280);
  });
});

describe('beatsInRange (metronome lookahead)', () => {
  it('returns beats in (after, until]', () => {
    expect(beatsInRange(0, 1000, 120, 0)).toEqual([
      { ms: 500, beat: 1 },
      { ms: 1000, beat: 2 },
    ]);
    expect(beatsInRange(-1, 500, 120, 0).map((b) => b.beat)).toEqual([0, 1]);
  });

  it('never repeats or skips a beat across consecutive windows', () => {
    const bpm = 173.37;
    const offsetMs = -41;
    const seen: number[] = [];
    // 25 ms ticks scheduling up to 100 ms ahead, like the editor's scheduler.
    let scheduledUntil = 999.5;
    for (let now = 1000; now < 60_000; now += 25) {
      const until = now + 100;
      for (const b of beatsInRange(scheduledUntil, until, bpm, offsetMs)) seen.push(b.beat);
      scheduledUntil = until;
    }
    const first = seen[0] as number;
    expect(seen).toEqual(seen.map((_, i) => first + i));
    expect(beatToMs(first, bpm, offsetMs)).toBeGreaterThan(999.5);
    expect(beatToMs(first - 1, bpm, offsetMs)).toBeLessThanOrEqual(999.5);
  });

  it('is empty for an empty window', () => {
    expect(beatsInRange(500, 500, 120, 0)).toEqual([]);
  });

  it('identifies downbeats including negative beats', () => {
    expect([-8, -4, 0, 4, 8].every(isDownbeat)).toBe(true);
    expect([-3, -1, 1, 2, 3, 5].some(isDownbeat)).toBe(false);
  });
});

describe('labels', () => {
  it('formats timestamps as mm:ss.mmm', () => {
    expect(formatTimestamp(0)).toBe('00:00.000');
    expect(formatTimestamp(61_234)).toBe('01:01.234');
    expect(formatTimestamp(359_999.6)).toBe('06:00.000');
    expect(formatTimestamp(-1500)).toBe('-00:01.500');
    expect(formatTimestamp(12.4)).toBe('00:00.012');
  });

  it('numbers measures from 1 at beat 0', () => {
    expect(measureOfBeat(0)).toBe(1);
    expect(measureOfBeat(3.99)).toBe(1);
    expect(measureOfBeat(4)).toBe(2);
    expect(measureOfBeat(-1)).toBe(0);
    expect(measureOfBeat(-5)).toBe(-1);
  });

  it('formats measure:beat at odd BPMs and offsets', () => {
    expect(formatMeasureBeat(320, 150, 320)).toBe('1:1');
    expect(formatMeasureBeat(720, 150, 320)).toBe('1:2');
    expect(formatMeasureBeat(1919, 150, 320)).toBe('1:4');
    expect(formatMeasureBeat(1920, 150, 320)).toBe('2:1');
    expect(formatMeasureBeat(0, 150, 320)).toBe('0:4');
    // A beat rounded to whole ms still reads as that beat.
    const ms = snapToGrid(10_000, 173.37, 1234, 1);
    const beat = Math.round(msToBeat(ms, 173.37, 1234));
    expect(formatMeasureBeat(ms, 173.37, 1234)).toBe(
      `${Math.floor(beat / 4) + 1}:${(beat % 4) + 1}`,
    );
  });
});
