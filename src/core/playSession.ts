import { compareNotes, noteEnd, type Lane, type Note } from './chart';
import { LANE_COUNT } from './constants';
import { HIT_WINDOW_MS, judgeError, worseJudgement, type Judgement } from './judgement';
import { ScoreTracker, type ScoreSummary } from './scoring';

/**
 * - `pending`: not yet judged.
 * - `hit`: tap hit (final).
 * - `missed`: never hit; for holds the whole hold is missed (final).
 * - `holding`: hold head hit, lane currently held.
 * - `completed`: hold held to the end (final).
 * - `dropped`: hold released too early (final).
 */
export type NoteStatus = 'pending' | 'hit' | 'missed' | 'holding' | 'completed' | 'dropped';

export interface NoteRuntime {
  readonly note: Note;
  /** Index in the session's (sorted) note list. */
  readonly index: number;
  status: NoteStatus;
  /** Head judgement for taps and hold heads; null until hit. */
  headJudgement: Judgement | null;
  /** Press time minus note time (negative = early); null until hit. */
  errorMs: number | null;
  /** Final judgement once resolved. */
  finalJudgement: Judgement | null;
  /** Song time of the most recent status change (for effects). */
  changedAtMs: number;
}

export type JudgementEventKind = 'tap' | 'holdHead' | 'holdComplete' | 'holdDrop' | 'miss';

export interface JudgementEvent {
  kind: JudgementEventKind;
  noteIndex: number;
  lane: Lane;
  /** The judgement to display: the hit grade, Miss, or a dropped hold's capped grade. */
  judgement: Judgement;
  /** Timing error for presses (`tap`, `holdHead`); null otherwise. */
  errorMs: number | null;
  songTimeMs: number;
}

/** Releasing a hold this close to its end (or later) still completes it. */
export const HOLD_RELEASE_WINDOW_MS = HIT_WINDOW_MS;

/**
 * Which note a press in one lane targets: the earliest pending note whose time is within
 * HIT_WINDOW_MS of the press (inclusive). Returns its position in `laneNotes`, or -1.
 * `laneNotes` must be one lane's notes sorted by time.
 */
export function findPressTarget(
  laneNotes: readonly NoteRuntime[],
  songTimeMs: number,
  fromPosition = 0,
): number {
  for (let i = fromPosition; i < laneNotes.length; i++) {
    const rt = laneNotes[i] as NoteRuntime;
    if (rt.note.t - songTimeMs > HIT_WINDOW_MS) return -1; // later notes are further away
    if (rt.status !== 'pending') continue;
    if (Math.abs(songTimeMs - rt.note.t) <= HIT_WINDOW_MS) return i;
  }
  return -1;
}

/**
 * The rules of one play-through, independent of audio, input devices and rendering.
 * Feed it presses/releases at song time (ms) and call `update` every frame.
 * Every method returns the judgement events it produced, in order.
 */
export class PlaySession {
  readonly notes: readonly NoteRuntime[];
  readonly score: ScoreTracker;
  private readonly lanes: NoteRuntime[][];
  /** Per lane: notes before this position are all resolved (search starts here). */
  private readonly laneCursor: number[];
  /** Per lane: the hold currently being held, if any. */
  private readonly activeHold: (NoteRuntime | null)[];
  /** Notes before this index are past their auto-miss time and have been checked. */
  private missCursor = 0;
  private resolvedCount = 0;

  constructor(notes: readonly Note[]) {
    const sorted = [...notes].sort(compareNotes);
    this.notes = sorted.map((note, index) => ({
      note,
      index,
      status: 'pending',
      headJudgement: null,
      errorMs: null,
      finalJudgement: null,
      changedAtMs: Number.NEGATIVE_INFINITY,
    }));
    this.lanes = Array.from({ length: LANE_COUNT }, () => []);
    for (const rt of this.notes) this.lanes[rt.note.lane]?.push(rt);
    this.laneCursor = new Array<number>(LANE_COUNT).fill(0);
    this.activeHold = new Array<NoteRuntime | null>(LANE_COUNT).fill(null);
    this.score = new ScoreTracker(sorted.length);
  }

  /** True once every note has a final judgement. */
  get finished(): boolean {
    return this.resolvedCount === this.notes.length;
  }

  /** Song time when the last note can still be judged (end of chart + hit window). */
  get lastJudgeableMs(): number {
    let end = 0;
    for (const rt of this.notes) end = Math.max(end, noteEnd(rt.note));
    return end + HIT_WINDOW_MS;
  }

  isHolding(lane: Lane): boolean {
    return this.activeHold[lane] !== null;
  }

  summary(): ScoreSummary {
    return this.score.summary();
  }

  /** A key went down in `lane` at `songTimeMs`. Presses with no note in range do nothing. */
  press(lane: Lane, songTimeMs: number): JudgementEvent[] {
    if (this.activeHold[lane]) return [];
    const laneNotes = this.lanes[lane] as NoteRuntime[];
    const pos = findPressTarget(laneNotes, songTimeMs, this.advanceLaneCursor(lane));
    if (pos < 0) return [];
    const rt = laneNotes[pos] as NoteRuntime;
    const errorMs = songTimeMs - rt.note.t;
    const judgement = judgeError(errorMs);
    rt.headJudgement = judgement;
    rt.errorMs = errorMs;
    rt.changedAtMs = songTimeMs;
    this.score.addCombo();

    if (rt.note.type === 'tap') {
      rt.status = 'hit';
      this.finalize(rt, judgement);
      return [this.event('tap', rt, judgement, errorMs, songTimeMs)];
    }
    rt.status = 'holding';
    this.activeHold[lane] = rt;
    return [this.event('holdHead', rt, judgement, errorMs, songTimeMs)];
  }

  /** A key went up in `lane` at `songTimeMs`. Only matters while a hold is active there. */
  release(lane: Lane, songTimeMs: number): JudgementEvent[] {
    const rt = this.activeHold[lane];
    if (!rt) return [];
    if (songTimeMs >= noteEnd(rt.note) - HOLD_RELEASE_WINDOW_MS) {
      return [this.completeHold(rt, songTimeMs)];
    }
    this.activeHold[lane] = null;
    const judgement = worseJudgement(rt.headJudgement ?? 'good', 'good');
    rt.status = 'dropped';
    rt.changedAtMs = songTimeMs;
    this.score.breakCombo();
    this.finalize(rt, judgement);
    return [this.event('holdDrop', rt, judgement, null, songTimeMs)];
  }

  /**
   * Advance to `songTimeMs`: complete holds that reached their end while held, and turn notes
   * whose time + HIT_WINDOW_MS has passed (strictly) without a hit into Misses.
   */
  update(songTimeMs: number): JudgementEvent[] {
    const events: JudgementEvent[] = [];
    for (const rt of this.activeHold) {
      if (rt && songTimeMs >= noteEnd(rt.note)) events.push(this.completeHold(rt, songTimeMs));
    }
    while (this.missCursor < this.notes.length) {
      const rt = this.notes[this.missCursor] as NoteRuntime;
      if (songTimeMs <= rt.note.t + HIT_WINDOW_MS) break;
      this.missCursor += 1;
      if (rt.status !== 'pending') continue;
      rt.status = 'missed';
      rt.changedAtMs = rt.note.t + HIT_WINDOW_MS;
      this.score.breakCombo();
      this.finalize(rt, 'miss');
      events.push(this.event('miss', rt, 'miss', null, songTimeMs));
    }
    return events;
  }

  private completeHold(rt: NoteRuntime, songTimeMs: number): JudgementEvent {
    this.activeHold[rt.note.lane] = null;
    const judgement = rt.headJudgement ?? 'good';
    rt.status = 'completed';
    rt.changedAtMs = songTimeMs;
    this.finalize(rt, judgement);
    return this.event('holdComplete', rt, judgement, null, songTimeMs);
  }

  private finalize(rt: NoteRuntime, judgement: Judgement): void {
    rt.finalJudgement = judgement;
    this.score.resolve(judgement);
    this.resolvedCount += 1;
  }

  /** Skip notes at the front of a lane that no longer need searching. */
  private advanceLaneCursor(lane: Lane): number {
    const laneNotes = this.lanes[lane] as NoteRuntime[];
    let cursor = this.laneCursor[lane] as number;
    while (cursor < laneNotes.length && (laneNotes[cursor] as NoteRuntime).status !== 'pending') {
      cursor += 1;
    }
    this.laneCursor[lane] = cursor;
    return cursor;
  }

  private event(
    kind: JudgementEventKind,
    rt: NoteRuntime,
    judgement: Judgement,
    errorMs: number | null,
    songTimeMs: number,
  ): JudgementEvent {
    return { kind, noteIndex: rt.index, lane: rt.note.lane, judgement, errorMs, songTimeMs };
  }
}
