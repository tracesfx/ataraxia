import type { Judgement } from './judgement';

export const MAX_SCORE = 1_000_000;

/** Score weight of each judgement, in percent (integers keep the maths exact). */
export const JUDGEMENT_WEIGHT_PERCENT: Readonly<Record<Judgement, number>> = {
  perfect: 100,
  great: 70,
  good: 40,
  miss: 0,
};

export type JudgementCounts = Record<Judgement, number>;

export interface ScoreSummary {
  score: number;
  /** Weighted accuracy in percent (0-100) over the notes judged so far. 100 before any note. */
  accuracy: number;
  combo: number;
  maxCombo: number;
  counts: JudgementCounts;
  /** Notes with a final judgement (a hold counts once, when it resolves). */
  judged: number;
  totalNotes: number;
}

/**
 * Tracks score, accuracy, combo and per-judgement counts.
 *
 * Combo and final judgements are separate on purpose: a hold note adds to the combo when its
 * head is hit, but its final judgement (and score) is only known when it completes or drops.
 */
export class ScoreTracker {
  readonly counts: JudgementCounts = { perfect: 0, great: 0, good: 0, miss: 0 };
  private points = 0;
  private judgedValue = 0;
  private comboValue = 0;
  private maxComboValue = 0;

  constructor(readonly totalNotes: number) {
    if (!Number.isInteger(totalNotes) || totalNotes < 0) {
      throw new RangeError(`Note count must be a whole number >= 0, got ${totalNotes}`);
    }
  }

  /** A successful hit: combo + 1. */
  addCombo(): void {
    this.comboValue += 1;
    if (this.comboValue > this.maxComboValue) this.maxComboValue = this.comboValue;
  }

  breakCombo(): void {
    this.comboValue = 0;
  }

  /** Record a note's final judgement. Does not touch the combo. */
  resolve(judgement: Judgement): void {
    this.counts[judgement] += 1;
    this.points += JUDGEMENT_WEIGHT_PERCENT[judgement];
    this.judgedValue += 1;
  }

  get combo(): number {
    return this.comboValue;
  }

  get maxCombo(): number {
    return this.maxComboValue;
  }

  get judged(): number {
    return this.judgedValue;
  }

  /** Each note is worth MAX_SCORE / totalNotes; all Perfect gives exactly MAX_SCORE. */
  get score(): number {
    if (this.totalNotes === 0) return 0;
    return Math.floor((this.points * MAX_SCORE) / (this.totalNotes * 100));
  }

  get accuracy(): number {
    if (this.judgedValue === 0) return 100;
    return this.points / this.judgedValue;
  }

  summary(): ScoreSummary {
    return {
      score: this.score,
      accuracy: this.accuracy,
      combo: this.comboValue,
      maxCombo: this.maxComboValue,
      counts: { ...this.counts },
      judged: this.judgedValue,
      totalNotes: this.totalNotes,
    };
  }
}
