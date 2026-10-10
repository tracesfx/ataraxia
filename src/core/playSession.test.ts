import { describe, expect, it } from 'vitest';
import type { HoldNote, Lane, Note, TapNote } from './chart';
import { MAX_SCORE } from './scoring';
import { PlaySession, findPressTarget } from './playSession';

const tap = (t: number, lane: Lane): TapNote => ({ t, lane, type: 'tap' });
const hold = (t: number, lane: Lane, dur: number): HoldNote => ({ t, lane, type: 'hold', dur });

function session(...notes: Note[]): PlaySession {
  return new PlaySession(notes);
}

describe('PlaySession: tap windows', () => {
  it.each([
    [-121, null],
    [-120, 'good'],
    [-81, 'good'],
    [-80, 'great'],
    [-41, 'great'],
    [-40, 'perfect'],
    [0, 'perfect'],
    [40, 'perfect'],
    [41, 'great'],
    [80, 'great'],
    [81, 'good'],
    [120, 'good'],
    [121, null],
  ] as const)('press at %i ms -> %s', (error, expected) => {
    const s = session(tap(1000, 0));
    const events = s.press(0, 1000 + error);
    if (expected === null) {
      expect(events).toEqual([]);
      expect(s.notes[0]!.status).toBe('pending');
    } else {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tap', judgement: expected, errorMs: error });
      expect(s.notes[0]!.status).toBe('hit');
    }
  });

  it('reports negative error for early presses', () => {
    const s = session(tap(1000, 0));
    expect(s.press(0, 970)[0]!.errorMs).toBe(-30);
  });

  it('a press with no note in range does nothing (no penalty)', () => {
    const s = session(tap(1000, 0), tap(2000, 0));
    s.press(0, 1000);
    expect(s.score.combo).toBe(1);
    expect(s.press(0, 1500)).toEqual([]);
    expect(s.press(1, 1000)).toEqual([]);
    expect(s.score.combo).toBe(1);
    expect(s.score.judged).toBe(1);
  });

  it('a note can only be hit once', () => {
    const s = session(tap(1000, 0));
    s.press(0, 1000);
    expect(s.press(0, 1010)).toEqual([]);
  });

  it('targets the earliest unjudged note in the lane within the window', () => {
    const s = session(tap(1000, 2), tap(1100, 2));
    // 1060 is closer to 1100, but 1000 is earlier and still in range.
    expect(s.press(2, 1060)[0]).toMatchObject({ noteIndex: 0, judgement: 'great' });
    expect(s.press(2, 1100)[0]).toMatchObject({ noteIndex: 1, judgement: 'perfect' });
  });

  it('skips an earlier note that is already out of range', () => {
    const s = session(tap(1000, 2), tap(1200, 2));
    // 1125 is 125 ms after the first note (out of range) but 75 ms before the second.
    expect(s.press(2, 1125)[0]).toMatchObject({ noteIndex: 1, judgement: 'great' });
  });

  it('only looks at the pressed lane', () => {
    const s = session(tap(1000, 0), tap(1000, 3));
    expect(s.press(3, 1000)[0]).toMatchObject({ noteIndex: 1, lane: 3 });
    expect(s.notes[0]!.status).toBe('pending');
  });
});

describe('PlaySession: simultaneous notes', () => {
  it('judges notes at the same time in different lanes independently', () => {
    const s = session(tap(1000, 1), tap(1000, 2));
    expect(s.press(1, 990)[0]).toMatchObject({ lane: 1, judgement: 'perfect', errorMs: -10 });
    expect(s.press(2, 1050)[0]).toMatchObject({ lane: 2, judgement: 'great', errorMs: 50 });
    expect(s.score.combo).toBe(2);
    expect(s.finished).toBe(true);
  });

  it('auto-misses both if neither is pressed', () => {
    const s = session(tap(1000, 0), tap(1000, 3));
    const events = s.update(1121);
    expect(events.map((e) => e.lane)).toEqual([0, 3]);
    expect(events.every((e) => e.kind === 'miss')).toBe(true);
  });
});

describe('PlaySession: auto-miss', () => {
  it('a note is still hittable at time + 120 and missed once that has passed', () => {
    const s = session(tap(1000, 0));
    expect(s.update(1120)).toEqual([]);
    expect(s.notes[0]!.status).toBe('pending');
    const events = s.update(1120.5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'miss', judgement: 'miss', noteIndex: 0 });
    expect(s.notes[0]!.status).toBe('missed');
    expect(s.score.counts.miss).toBe(1);
  });

  it('a missed note cannot be hit afterwards', () => {
    const s = session(tap(1000, 0));
    s.update(1121);
    expect(s.press(0, 1110)).toEqual([]);
  });

  it('misses each note once even across many updates', () => {
    const s = session(tap(1000, 0), tap(1500, 1));
    expect(s.update(1200)).toHaveLength(1);
    expect(s.update(1300)).toHaveLength(0);
    expect(s.update(5000)).toHaveLength(1);
    expect(s.score.counts.miss).toBe(2);
    expect(s.finished).toBe(true);
  });

  it('does not miss notes that were hit', () => {
    const s = session(tap(1000, 0));
    s.press(0, 1000);
    expect(s.update(5000)).toEqual([]);
  });
});

describe('PlaySession: combo', () => {
  it('increments on hits and resets on a miss', () => {
    const s = session(tap(1000, 0), tap(1500, 1), tap(2000, 2), tap(2500, 3));
    s.press(0, 1000);
    s.press(1, 1600); // good
    expect(s.score.combo).toBe(2);
    s.update(2200); // note at 2000 missed
    expect(s.score.combo).toBe(0);
    s.press(3, 2500);
    expect(s.score.combo).toBe(1);
    expect(s.score.maxCombo).toBe(2);
  });
});

describe('PlaySession: hold notes', () => {
  // Hold from 1000 to 2000 in lane 1.
  const h = (): PlaySession => session(hold(1000, 1, 1000));

  it('head is judged like a tap and adds combo immediately', () => {
    const s = h();
    expect(s.press(1, 1050)[0]).toMatchObject({ kind: 'holdHead', judgement: 'great' });
    expect(s.notes[0]!.status).toBe('holding');
    expect(s.isHolding(1)).toBe(true);
    expect(s.score.combo).toBe(1);
    expect(s.score.judged).toBe(0); // final judgement not known yet
  });

  it('completes when held to the end, keeping the head judgement', () => {
    const s = h();
    s.press(1, 1000);
    expect(s.update(1999)).toEqual([]);
    const events = s.update(2000);
    expect(events[0]).toMatchObject({ kind: 'holdComplete', judgement: 'perfect' });
    expect(s.notes[0]!.status).toBe('completed');
    expect(s.score.counts.perfect).toBe(1);
    expect(s.score.combo).toBe(1);
    expect(s.score.score).toBe(MAX_SCORE);
    // Releasing afterwards changes nothing.
    expect(s.release(1, 2100)).toEqual([]);
  });

  it('releasing within 120 ms of the end (inclusive) completes it', () => {
    const s = h();
    s.press(1, 1050);
    expect(s.release(1, 1880)[0]).toMatchObject({ kind: 'holdComplete', judgement: 'great' });
    expect(s.score.combo).toBe(1);
  });

  it('releasing 121 ms before the end drops it: combo breaks, score capped at Good', () => {
    const s = h();
    s.press(1, 1000); // perfect head
    const events = s.release(1, 1879);
    expect(events[0]).toMatchObject({ kind: 'holdDrop', judgement: 'good' });
    expect(s.notes[0]!.status).toBe('dropped');
    expect(s.score.combo).toBe(0);
    expect(s.score.maxCombo).toBe(1);
    expect(s.score.counts).toEqual({ perfect: 0, great: 0, good: 1, miss: 0 });
    expect(s.score.score).toBe(400_000);
  });

  it('an early release right after the head also drops', () => {
    const s = h();
    s.press(1, 1100); // good head
    expect(s.release(1, 1101)[0]).toMatchObject({ kind: 'holdDrop', judgement: 'good' });
  });

  it('a dropped hold is never revived by pressing again', () => {
    const s = h();
    s.press(1, 1000);
    s.release(1, 1200);
    expect(s.press(1, 1300)).toEqual([]);
    expect(s.update(3000)).toEqual([]);
    expect(s.score.judged).toBe(1);
  });

  it('a missed head misses the whole hold', () => {
    const s = h();
    const events = s.update(1121);
    expect(events[0]).toMatchObject({ kind: 'miss', judgement: 'miss' });
    expect(s.notes[0]!.status).toBe('missed');
    // Pressing during the body does nothing.
    expect(s.press(1, 1500)).toEqual([]);
    expect(s.update(2500)).toEqual([]);
    expect(s.score.counts.miss).toBe(1);
    expect(s.finished).toBe(true);
  });

  it('a late head on a short hold can be released immediately and still complete', () => {
    const s = session(hold(1000, 0, 60)); // ends at 1060
    s.press(0, 1100);
    expect(s.release(0, 1101)[0]).toMatchObject({ kind: 'holdComplete', judgement: 'good' });
  });

  it('holds in one lane do not block presses in another', () => {
    const s = session(hold(1000, 0, 1000), tap(1500, 3));
    s.press(0, 1000);
    expect(s.press(3, 1500)[0]).toMatchObject({ kind: 'tap', judgement: 'perfect' });
    expect(s.score.combo).toBe(2);
    s.update(2000);
    expect(s.score.counts.perfect).toBe(2);
  });

  it('release without an active hold does nothing', () => {
    const s = session(tap(1000, 0));
    expect(s.release(0, 1000)).toEqual([]);
  });
});

describe('PlaySession: full runs', () => {
  const chart: Note[] = [
    tap(1000, 0),
    tap(1000, 3),
    hold(1500, 1, 500),
    tap(1750, 3),
    tap(2500, 2),
    hold(3000, 0, 1000),
    tap(3200, 2),
  ];

  it('all Perfect gives exactly 1,000,000 and max combo = note count', () => {
    const s = new PlaySession(chart);
    for (const rt of s.notes) {
      s.update(rt.note.t);
      s.press(rt.note.lane, rt.note.t);
      if (rt.note.type === 'tap') s.release(rt.note.lane, rt.note.t + 30);
    }
    s.update(10_000);
    expect(s.finished).toBe(true);
    expect(s.score.score).toBe(MAX_SCORE);
    expect(s.score.accuracy).toBe(100);
    expect(s.score.maxCombo).toBe(chart.length);
    expect(s.score.counts.perfect).toBe(chart.length);
  });

  it('missing everything gives 0 and finishes', () => {
    const s = new PlaySession(chart);
    s.update(10_000);
    expect(s.finished).toBe(true);
    expect(s.score.score).toBe(0);
    expect(s.score.counts.miss).toBe(chart.length);
    expect(s.score.maxCombo).toBe(0);
  });

  it('sorts unsorted input and reports when the last note is judgeable', () => {
    const s = new PlaySession([tap(2000, 0), hold(500, 1, 3000)]);
    expect(s.notes.map((n) => n.note.t)).toEqual([500, 2000]);
    expect(s.lastJudgeableMs).toBe(3620);
  });
});

describe('findPressTarget', () => {
  it('returns -1 for an empty lane or no note in range', () => {
    expect(findPressTarget([], 0)).toBe(-1);
    const s = session(tap(1000, 0));
    expect(findPressTarget(s.notes, 500)).toBe(-1);
    expect(findPressTarget(s.notes, 880)).toBe(0);
  });
});
