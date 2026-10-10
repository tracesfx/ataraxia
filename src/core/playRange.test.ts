import { describe, expect, it } from 'vitest';
import type { Note } from './chart';
import { notesFromStart, previewWindow, runPlan } from './playRange';
import { SongClock } from './songClock';
import { PlaySession } from './playSession';

const notes: Note[] = [
  { t: 500, lane: 0, type: 'tap' },
  { t: 900, lane: 1, type: 'hold', dur: 400 },
  { t: 1000, lane: 2, type: 'tap' },
  { t: 1500, lane: 3, type: 'hold', dur: 200 },
];

describe('notesFromStart', () => {
  it('keeps every note when starting from the beginning', () => {
    expect(notesFromStart(notes)).toEqual(notes);
    expect(notesFromStart(notes, -2000)).toEqual(notes);
  });

  it('works with negative note times and start points', () => {
    const early: Note[] = [
      { t: -2000, lane: 0, type: 'tap' },
      { t: -500, lane: 1, type: 'tap' },
      { t: 0, lane: 2, type: 'tap' },
    ];
    expect(notesFromStart(early, -1000).map((n) => n.t)).toEqual([-500, 0]);
    expect(notesFromStart(early, 0).map((n) => n.t)).toEqual([0]);
  });

  it('drops notes before the start, keeping one exactly at it', () => {
    expect(notesFromStart(notes, 1000).map((n) => n.t)).toEqual([1000, 1500]);
  });

  it('drops a hold whose head is before the start even if its tail is after', () => {
    const kept = notesFromStart(notes, 950);
    expect(kept.some((n) => n.lane === 1)).toBe(false);
    expect(kept).toHaveLength(2);
  });

  it('returns an empty list when starting after the last note', () => {
    expect(notesFromStart(notes, 5000)).toEqual([]);
  });

  it('does not modify the input', () => {
    const copy = structuredClone(notes);
    notesFromStart(notes, 1000);
    expect(notes).toEqual(copy);
  });

  it('excluded notes are not scored: the session only counts the kept notes', () => {
    const session = new PlaySession(notesFromStart(notes, 1000));
    expect(session.score.totalNotes).toBe(2);
    // Time passing over the excluded notes produces no Misses.
    expect(session.update(999)).toEqual([]);
    expect(session.score.counts.miss).toBe(0);
  });
});

describe('runPlan', () => {
  const chart = { notes };

  it('plays from the effective start with every note judged', () => {
    // First note at 500: auto start is min(0, 500 - 1500) = -1000.
    expect(runPlan(chart, undefined, 1500)).toEqual({ clockFromMs: -1000, judgeFromMs: null });
    expect(runPlan({ ...chart, startMs: -3000 }, undefined, 1500).clockFromMs).toBe(-3000);
  });

  it('starts a run-in before a start point and judges from it', () => {
    expect(runPlan(chart, 10_000, 1500)).toEqual({ clockFromMs: 8500, judgeFromMs: 10_000 });
    expect(runPlan(chart, 400, 1500)).toEqual({ clockFromMs: -1100, judgeFromMs: 400 });
    expect(runPlan(chart, 400, 0).clockFromMs).toBe(400);
  });
});

describe('a song that starts at a negative time', () => {
  it('judges a note at t=0 correctly after a silent lead-in', () => {
    const chart: { notes: Note[]; startMs: number } = {
      startMs: -3000,
      notes: [
        { t: -1000, lane: 1, type: 'tap' },
        { t: 0, lane: 0, type: 'tap' },
      ],
    };
    const plan = runPlan(chart, undefined, 1500);
    const session = new PlaySession(notesFromStart(chart.notes, plan.judgeFromMs ?? undefined));
    const clock = new SongClock();
    // The clock starts at audio time 5 s at the chart's start; the audio is due 3 s later.
    clock.start(5, plan.clockFromMs);
    expect(clock.audioStart(0, 60_000)).toEqual({ atAudioSec: 8, offsetSec: 0 });

    // Nothing is missed while the notes scroll in.
    expect(session.update(clock.songMsAt(5.5))).toEqual([]);
    // The note before the audio is hit too.
    const early = session.press(1, clock.songMsAt(7.01));
    expect(early[0]?.judgement).toBe('perfect');
    expect(early[0]?.errorMs).toBeCloseTo(10, 6);
    // 20 ms after the audio began.
    const events = session.press(0, clock.songMsAt(8.02));
    expect(events).toHaveLength(1);
    expect(events[0]?.judgement).toBe('perfect');
    expect(events[0]?.errorMs).toBeCloseTo(20, 6);
    expect(session.score.counts.perfect).toBe(2);
  });
});

describe('previewWindow', () => {
  it('uses previewStartMs when the window fits', () => {
    expect(previewWindow(30000, 120000, 10000)).toEqual({ startMs: 30000, lengthMs: 10000 });
  });

  it('moves the window earlier so it ends with the song', () => {
    expect(previewWindow(115000, 120000, 10000)).toEqual({ startMs: 110000, lengthMs: 10000 });
  });

  it('previews a short song whole', () => {
    expect(previewWindow(3000, 8000, 10000)).toEqual({ startMs: 0, lengthMs: 8000 });
  });

  it('clamps negative starts', () => {
    expect(previewWindow(-50, 60000, 10000)).toEqual({ startMs: 0, lengthMs: 10000 });
  });
});
