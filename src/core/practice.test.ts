import { describe, expect, it } from 'vitest';
import type { Note } from './chart';
import { HIT_WINDOW_MS } from './judgement';
import { PlaySession } from './playSession';
import {
  NO_LOOP,
  clampPracticeRate,
  loopRange,
  loopRestartMs,
  notesInLoop,
  setLoopMark,
  stepPracticeRate,
} from './practice';

const notes: Note[] = [
  { t: 500, lane: 0, type: 'tap' },
  { t: 1000, lane: 1, type: 'tap' },
  { t: 2000, lane: 2, type: 'hold', dur: 1500 },
  { t: 3000, lane: 0, type: 'tap' },
  { t: 4000, lane: 3, type: 'tap' },
  { t: 5000, lane: 1, type: 'tap' },
];

describe('practice rate', () => {
  it('steps 5 % at a time between 50 % and 100 %', () => {
    expect(stepPracticeRate(1, -1)).toBe(0.95);
    expect(stepPracticeRate(0.7, 1)).toBe(0.75);
    expect(stepPracticeRate(0.5, -1)).toBe(0.5);
    expect(stepPracticeRate(1, 1)).toBe(1);
    let r = 1;
    for (let i = 0; i < 6; i++) r = stepPracticeRate(r, -1);
    expect(r).toBe(0.7);
  });

  it('clamps and snaps arbitrary values', () => {
    expect(clampPracticeRate(0.72)).toBe(0.7);
    expect(clampPracticeRate(0.2)).toBe(0.5);
    expect(clampPracticeRate(3)).toBe(1);
    expect(clampPracticeRate(Number.NaN)).toBe(1);
  });
});

describe('loop marks', () => {
  it('needs both marks', () => {
    expect(loopRange(NO_LOOP)).toBeNull();
    expect(loopRange(setLoopMark(NO_LOOP, 'a', 1000))).toBeNull();
  });

  it('rounds marks to whole ms, allowing negative times down to the limit', () => {
    expect(setLoopMark(NO_LOOP, 'a', 1234.6)).toEqual({ aMs: 1235, bMs: null });
    expect(setLoopMark(NO_LOOP, 'b', -800)).toEqual({ aMs: null, bMs: -800 });
    expect(setLoopMark(NO_LOOP, 'b', -45_000)).toEqual({ aMs: null, bMs: -30_000 });
  });

  it('orders A and B, and ignores loops that are too short', () => {
    expect(loopRange({ aMs: 4000, bMs: 1000 })).toEqual({ startMs: 1000, endMs: 4000 });
    expect(loopRange({ aMs: 1000, bMs: 1050 })).toBeNull();
  });
});

describe('notesInLoop', () => {
  it('keeps only notes whose head is inside the loop (inclusive edges)', () => {
    const loop = { startMs: 1000, endMs: 4000 };
    expect(notesInLoop(notes, loop).map((n) => n.t)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('keeps a hold that starts inside but ends after the loop, and drops one that started before', () => {
    expect(notesInLoop(notes, { startMs: 1500, endMs: 2500 }).map((n) => n.t)).toEqual([2000]);
    expect(notesInLoop(notes, { startMs: 2500, endMs: 3200 }).map((n) => n.t)).toEqual([3000]);
  });

  it('notes outside the loop are neither missed nor counted by the session', () => {
    const loop = { startMs: 2500, endMs: 4500 };
    const session = new PlaySession(notesInLoop(notes, loop));
    session.press(0, 3000);
    session.press(3, 4000);
    const events = session.update(
      loopRestartMs(
        session.notes.map((r) => r.note),
        loop,
      ),
    );
    expect(events).toEqual([]);
    expect(session.score.totalNotes).toBe(2);
    expect(session.score.counts.miss).toBe(0);
    expect(session.finished).toBe(true);
  });
});

describe('loopRestartMs', () => {
  it('is the loop end plus the hit window', () => {
    const loop = { startMs: 2500, endMs: 4500 };
    expect(loopRestartMs(notesInLoop(notes, loop), loop)).toBe(4500 + HIT_WINDOW_MS);
  });

  it('waits for a hold that runs past the loop end', () => {
    const loop = { startMs: 1500, endMs: 2500 };
    expect(loopRestartMs(notesInLoop(notes, loop), loop)).toBe(3500 + HIT_WINDOW_MS);
  });
});
