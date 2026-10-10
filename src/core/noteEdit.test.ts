import { describe, expect, it } from 'vitest';
import type { Chart, Note } from './chart';
import {
  addNotes,
  applyEdit,
  chartStats,
  clampLaneDelta,
  copyNotes,
  deleteNotes,
  findOverlap,
  gridStepDelta,
  holdFromDrag,
  holdNote,
  lowerBoundByTime,
  minHoldSteps,
  mirrorNotes,
  moveNotes,
  normalizeChart,
  normalizeNotes,
  notesInBox,
  pasteNotes,
  placeHold,
  placeTap,
  placementTime,
  quantizeRecorded,
  replaceNote,
  swapNotes,
  tapNote,
  validatedChart,
  type EditResult,
  type SnapGrid,
} from './noteEdit';
import { parseChart } from './parseChart';

/** 120 BPM: a beat is 500 ms; 1/4 snap = 125 ms steps; beat 0 at 0. */
const GRID: SnapGrid = { bpm: 120, offsetMs: 0, snap: 4 };
const BOUNDS = { durationMs: 60_000 };

function ok(r: EditResult): { removed: Note[]; added: Note[] } {
  if (!r.ok) throw new Error(`Expected success, got: ${r.error}`);
  return r;
}

function error(r: EditResult): string {
  if (r.ok) throw new Error('Expected the edit to be rejected.');
  return r.error;
}

describe('placement with snapping', () => {
  it('snaps a tap to the nearest grid line', () => {
    expect(ok(placeTap([], 1, 1060, GRID, BOUNDS)).added).toEqual([tapNote(1, 1000)]);
    expect(ok(placeTap([], 1, 1070, GRID, BOUNDS)).added).toEqual([tapNote(1, 1125)]);
  });

  it('respects the offset and triplet snaps', () => {
    const g: SnapGrid = { bpm: 150, offsetMs: 320, snap: 3 }; // 400 ms beats, 133.3 ms steps
    expect(placementTime(320 + 140, g)).toBe(453);
    expect(placementTime(320 + 260, g)).toBe(587);
  });

  it('places at negative times, before the audio starts', () => {
    const g: SnapGrid = { bpm: 120, offsetMs: 60, snap: 4 }; // lines at -190, -65, 60, ...
    expect(placementTime(-30, g)).toBe(-65);
    expect(placementTime(0, g)).toBe(60);
    expect(placementTime(-2000, GRID)).toBe(-2000);
    expect(ok(placeTap([], 2, -1060, GRID, BOUNDS)).added).toEqual([tapNote(2, -1000)]);
    const hold = ok(placeHold([], 0, -510, -10, GRID, BOUNDS)).added;
    expect(hold).toEqual([holdNote(0, -500, 500)]);
  });

  it('never places earlier than 30 s before the audio', () => {
    // Lines every 125 ms from 0: -30000 is a line.
    expect(placementTime(-40_000, GRID)).toBe(-30_000);
    const g: SnapGrid = { bpm: 120, offsetMs: 60, snap: 4 }; // ... -29940 + k*125
    expect(placementTime(-40_000, g)).toBeGreaterThanOrEqual(-30_000);
    expect(error(addNotes([], [tapNote(0, -30_001)], BOUNDS))).toMatch(/30 seconds before/);
    expect(ok(addNotes([], [tapNote(0, -30_000)], BOUNDS)).added).toHaveLength(1);
    // A custom lower bound.
    expect(error(addNotes([], [tapNote(0, -10)], { durationMs: 1000, minMs: 0 }))).toMatch(
      /before the audio/,
    );
  });

  it('moves and pastes notes into negative time', () => {
    const notes = [tapNote(0, 500), tapNote(1, 750)];
    const moved = ok(moveNotes(notes, notes, -1500, 0, BOUNDS)).added;
    expect(moved.map((n) => n.t)).toEqual([-1000, -750]);
    const pasted = ok(pasteNotes([], copyNotes(notes), -2000, BOUNDS)).added;
    expect(pasted.map((n) => n.t)).toEqual([-2000, -1750]);
    expect(error(moveNotes(notes, notes, -31_000, 0, BOUNDS))).toMatch(/30 seconds/);
  });

  it('records presses at negative times', () => {
    expect(quantizeRecorded(3, -1010, null, GRID)).toEqual(tapNote(3, -1000));
    expect(quantizeRecorded(3, -1010, -480, GRID)).toEqual(holdNote(3, -1000, 500));
  });

  it('rejects a tap on an existing note or inside a hold', () => {
    const notes = [tapNote(0, 1000), holdNote(1, 2000, 1000)];
    expect(error(placeTap(notes, 0, 1010, GRID, BOUNDS))).toMatch(/overlap/);
    expect(error(placeTap(notes, 1, 2500, GRID, BOUNDS))).toMatch(/hold in lane 2/);
    // Exactly at the hold end overlaps too (ranges are inclusive).
    expect(error(placeTap(notes, 1, 3000, GRID, BOUNDS))).toMatch(/overlap/);
    expect(ok(placeTap(notes, 1, 3125, GRID, BOUNDS)).added).toEqual([tapNote(1, 3125)]);
    expect(ok(placeTap(notes, 2, 1000, GRID, BOUNDS)).added).toHaveLength(1);
  });

  it('rejects notes past the end of the song', () => {
    expect(error(placeTap([], 0, 61_000, GRID, BOUNDS))).toMatch(/end of the song/);
  });
});

describe('hold creation', () => {
  it('snaps both ends in either drag direction', () => {
    expect(holdFromDrag(2, 1010, 1990, GRID)).toEqual(holdNote(2, 1000, 1000));
    expect(holdFromDrag(2, 1990, 1010, GRID)).toEqual(holdNote(2, 1000, 1000));
  });

  it('is at least one snap division long', () => {
    expect(holdFromDrag(0, 1000, 1010, GRID)).toEqual(holdNote(0, 1000, 125));
  });

  it('is at least 50 ms long even when a division is shorter', () => {
    const fine: SnapGrid = { bpm: 300, offsetMs: 0, snap: 16 }; // 12.5 ms divisions
    const hold = holdFromDrag(0, 1000, 1000, fine);
    expect(hold.type === 'hold' && hold.dur).toBeGreaterThanOrEqual(50);
    expect(minHoldSteps(0, fine)).toBe(4);
  });

  it('rejects a hold that would swallow another note', () => {
    const notes = [tapNote(3, 1500)];
    expect(error(placeHold(notes, 3, 1000, 2000, GRID, BOUNDS))).toMatch(/overlap/);
    expect(ok(placeHold(notes, 3, 1625, 2000, GRID, BOUNDS)).added).toEqual([
      holdNote(3, 1625, 375),
    ]);
  });
});

describe('overlap detection', () => {
  it('finds overlaps among candidates and against kept notes only', () => {
    const a = tapNote(0, 1000);
    expect(findOverlap([a], [tapNote(0, 1000)])).not.toBeNull();
    expect(findOverlap([a], [tapNote(0, 1000)], new Set([a]))).toBeNull();
    expect(findOverlap([], [holdNote(1, 0, 500), tapNote(1, 400)])).not.toBeNull();
    // Overlaps between two existing notes are not the candidates' fault.
    expect(findOverlap([tapNote(2, 5), tapNote(2, 5)], [tapNote(2, 900)])).toBeNull();
  });

  it('sees a long hold past an intervening short note', () => {
    const long = holdNote(0, 0, 5000);
    const short = tapNote(0, 100);
    expect(findOverlap([long], [short, tapNote(0, 3000)])).not.toBeNull();
  });
});

describe('swapping notes (accepting a generated range)', () => {
  it('removes and adds as one edit', () => {
    const keep = tapNote(0, 1000);
    const old = tapNote(1, 2000);
    const added = [tapNote(1, 2000), holdNote(2, 2500, 400)];
    const r = ok(swapNotes([keep, old], [old], added, BOUNDS));
    expect(r.removed).toEqual([old]);
    expect(r.added).toEqual(added);
    expect(applyEdit([keep, old], r.removed, r.added)).toEqual([keep, added[0], added[1]]);
  });

  it('rejects overlaps with the notes that stay and out-of-bounds notes', () => {
    const keep = holdNote(0, 1000, 1000);
    expect(error(swapNotes([keep], [], [tapNote(0, 1500)], BOUNDS, 'A suggested note'))).toMatch(
      /A suggested note would overlap/,
    );
    expect(error(swapNotes([keep], [], [tapNote(1, 70_000)], BOUNDS))).toMatch(/past the end/);
  });

  it('ignores removals of notes that are not in the chart', () => {
    const keep = tapNote(0, 1000);
    expect(ok(swapNotes([keep], [tapNote(3, 5)], [tapNote(1, 1000)], BOUNDS)).removed).toEqual([]);
  });
});

describe('move, paste, mirror', () => {
  const a = tapNote(0, 1000);
  const b = holdNote(1, 1250, 500);
  const c = tapNote(3, 1000);
  const notes = [a, c, b];

  it('moves notes in time and lanes as a block', () => {
    const r = ok(moveNotes(notes, [a, b], 250, 1, BOUNDS));
    expect(r.removed).toEqual([a, b]);
    expect(r.added).toEqual([tapNote(1, 1250), holdNote(2, 1500, 500)]);
  });

  it('lets moved notes pass through their own old positions', () => {
    const run = [tapNote(0, 0), tapNote(0, 125), tapNote(0, 250)];
    expect(ok(moveNotes(run, run, 125, 0, BOUNDS)).added.map((n) => n.t)).toEqual([125, 250, 375]);
  });

  it('rejects moves that overlap, leave the lanes or go too far before the audio', () => {
    expect(error(moveNotes(notes, [a], 0, 3, BOUNDS))).toMatch(/overlap/);
    expect(error(moveNotes(notes, [c], 0, 1, BOUNDS))).toMatch(/lanes/);
    expect(error(moveNotes(notes, [a], -40_000, 0, BOUNDS))).toMatch(/before the audio starts/);
  });

  it('nudges by one grid step from the nearest line, keeping spacing', () => {
    const g: SnapGrid = { bpm: 150, offsetMs: 0, snap: 3 }; // lines 0, 133, 267, 400
    expect(gridStepDelta(133, 1, g)).toBe(134);
    expect(gridStepDelta(267, -1, g)).toBe(-134);
  });

  it('clamps a dragged lane offset so the block stays in the lanes', () => {
    expect(clampLaneDelta([a, b], 5)).toBe(2);
    expect(clampLaneDelta([b, c], -3)).toBe(-1);
  });

  it('copies relative to the earliest note and pastes at a time', () => {
    const clip = copyNotes([b, a]);
    expect(clip.notes).toEqual([tapNote(0, 0), holdNote(1, 250, 500)]);
    const r = ok(pasteNotes([], clip, 4000, BOUNDS));
    expect(r.added).toEqual([tapNote(0, 4000), holdNote(1, 4250, 500)]);
    expect(error(pasteNotes(notes, clip, 1000, BOUNDS))).toMatch(/overlap/);
    expect(error(pasteNotes([], { notes: [] }, 0, BOUNDS))).toMatch(/nothing to paste/);
  });

  it('mirrors lanes and rejects clashes with unselected notes', () => {
    expect(ok(mirrorNotes([a, b], [a, b], BOUNDS)).added).toEqual([
      tapNote(3, 1000),
      holdNote(2, 1250, 500),
    ]);
    // a -> lane 3 collides with c, which is not selected.
    expect(error(mirrorNotes(notes, [a], BOUNDS))).toMatch(/overlap/);
    // Mirroring both a and c swaps them.
    expect(ok(mirrorNotes(notes, [a, c], BOUNDS)).added).toEqual([
      tapNote(3, 1000),
      tapNote(0, 1000),
    ]);
  });

  it('deletes only notes that exist and applies edits sorted', () => {
    expect(ok(deleteNotes(notes, [a, tapNote(0, 1000)])).removed).toEqual([a]);
    expect(applyEdit(notes, [a], [tapNote(2, 0)])).toEqual([tapNote(2, 0), c, b]);
  });

  it('adds and replaces notes with checks', () => {
    expect(error(addNotes(notes, [tapNote(3, 1000)], BOUNDS))).toMatch(/overlap/);
    expect(ok(replaceNote(notes, a, holdNote(0, 1000, 250), BOUNDS)).added).toHaveLength(1);
    expect(error(replaceNote(notes, tapNote(0, 1000), tapNote(0, 9), BOUNDS))).toMatch(/no longer/);
  });
});

describe('quantizing recorded input', () => {
  it('quantizes presses to the snap', () => {
    expect(quantizeRecorded(1, 1040, 1100, GRID)).toEqual(tapNote(1, 1000));
    expect(quantizeRecorded(1, 1070, null, GRID)).toEqual(tapNote(1, 1125));
  });

  it('keeps short presses (<= a quarter beat) as taps', () => {
    expect(quantizeRecorded(0, 1000, 1125, GRID)).toEqual(tapNote(0, 1000));
  });

  it('turns longer presses into holds ending at the snapped release', () => {
    expect(quantizeRecorded(0, 990, 1740, GRID)).toEqual(holdNote(0, 1000, 750));
    // Held just over the threshold but releasing near the start: one division minimum.
    expect(quantizeRecorded(0, 1000, 1130, GRID)).toEqual(holdNote(0, 1000, 125));
  });

  it('uses the active snap for holds too', () => {
    const half: SnapGrid = { ...GRID, snap: 2 };
    expect(quantizeRecorded(2, 1010, 1600, half)).toEqual(holdNote(2, 1000, 500));
  });
});

describe('queries and stats', () => {
  const notes = [tapNote(0, 0), tapNote(1, 100), holdNote(2, 200, 1000), tapNote(3, 2000)];

  it('binary-searches by time', () => {
    expect(lowerBoundByTime(notes, 150)).toBe(2);
    expect(lowerBoundByTime(notes, 5000)).toBe(4);
  });

  it('box-selects by lane span and time overlap', () => {
    expect(notesInBox(notes, 1, 2, 1100, 50)).toEqual([notes[1], notes[2]]);
    expect(notesInBox(notes, 2, 3, 1150, 1199)).toEqual([notes[2]]);
  });

  it('computes chart and range stats', () => {
    const all = chartStats(notes);
    expect(all).toMatchObject({ notes: 4, holds: 1, lengthMs: 2000, peakNps: 3 });
    expect(all.avgNps).toBeCloseTo(2);
    const part = chartStats(notes, { startMs: 0, endMs: 500 });
    expect(part).toMatchObject({ notes: 3, holds: 1, lengthMs: 500 });
    expect(part.avgNps).toBeCloseTo(6);
    expect(chartStats([])).toMatchObject({ notes: 0, avgNps: 0, peakNps: 0, lengthMs: 0 });
  });
});

describe('normalisation', () => {
  it('rounds, clamps and sorts notes', () => {
    const messy = [
      { t: 500.4, lane: 2, type: 'tap' },
      { t: -40_000, lane: 7, type: 'hold', dur: 20.2 },
      { t: 100, lane: 0, type: 'tap' },
      { t: -3.4, lane: 1, type: 'tap' },
    ] as Note[];
    expect(normalizeNotes(messy)).toEqual([
      holdNote(3, -30_000, 50),
      tapNote(1, -3),
      tapNote(0, 100),
      tapNote(2, 500),
    ]);
  });

  it('produces a chart that parses', () => {
    const chart = {
      version: 2,
      title: 'T',
      artist: '',
      audio: 'a.ogg',
      bpm: 128.5,
      offsetMs: 12.6,
      previewStartMs: -5,
      difficulty: 'Hard',
      level: 25,
      charter: '',
      startMs: -45_000.2,
      notes: [tapNote(1, 900.7), tapNote(0, 900)],
    } as Chart;
    const normal = normalizeChart(chart);
    expect(normal).toMatchObject({ offsetMs: 13, previewStartMs: 0, level: 20, startMs: -30_000 });
    expect(parseChart(normal).ok).toBe(true);
  });
});

describe('validatedChart', () => {
  const base = {
    version: 2,
    title: 'T',
    artist: '',
    audio: '',
    bpm: 120,
    offsetMs: 0,
    previewStartMs: 0,
    difficulty: 'Normal',
    level: 3,
    charter: '',
  } as const;

  it('accepts a chart after normalising it', () => {
    const r = validatedChart({ ...base, notes: [tapNote(1, 10.2), tapNote(0, 10)] });
    expect(r.ok && r.chart.notes).toEqual([tapNote(0, 10), tapNote(1, 10)]);
  });

  it('reports overlaps instead of guessing which note to drop', () => {
    const r = validatedChart({ ...base, notes: [tapNote(0, 10), holdNote(0, 0, 100)] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Overlapping/);
  });
});
