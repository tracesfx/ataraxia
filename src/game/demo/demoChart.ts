import { CHART_VERSION, compareNotes, type Chart, type Lane, type Note } from '../../core/chart';
import { GAME_TITLE } from '../../core/constants';

/**
 * Built-in demo: an original song generated in code (see demoSong.ts) and a chart for it.
 * Pure (no DOM/audio) so it can be tested in Node.
 */
export const DEMO_BPM = 120;
export const DEMO_BEAT_MS = 60000 / DEMO_BPM; // 500
export const DEMO_BEATS_PER_BAR = 4;
/** 30 bars of 4/4 at 120 BPM = 60 s of music. */
export const DEMO_BARS = 30;
/** Extra audio after the last bar so the final notes can ring out. */
export const DEMO_TAIL_MS = 1500;
export const DEMO_DURATION_MS = DEMO_BARS * DEMO_BEATS_PER_BAR * DEMO_BEAT_MS + DEMO_TAIL_MS;

/** Song time (integer ms) of a bar + beat (beats may be fractional: 0.5 = an 8th, 0.25 = a 16th). */
export function demoTimeMs(bar: number, beat = 0): number {
  return Math.round((bar * DEMO_BEATS_PER_BAR + beat) * DEMO_BEAT_MS);
}

/** Section names, for docs/tests: [first bar, last bar]. */
export const DEMO_SECTIONS = {
  intro: [0, 1],
  singles: [2, 5],
  alternating: [6, 9],
  jumps: [10, 13],
  holds: [14, 17],
  stream: [18, 21],
  mix: [22, 27],
  finale: [28, 29],
} as const;

class ChartBuilder {
  readonly notes: Note[] = [];

  tap(bar: number, beat: number, ...lanes: Lane[]): this {
    for (const lane of lanes) this.notes.push({ t: demoTimeMs(bar, beat), lane, type: 'tap' });
    return this;
  }

  /** A run of evenly spaced taps, one lane per step. */
  run(bar: number, beat: number, stepBeats: number, lanes: readonly Lane[]): this {
    lanes.forEach((lane, i) => this.tap(bar, beat + i * stepBeats, lane));
    return this;
  }

  hold(bar: number, beat: number, beats: number, ...lanes: Lane[]): this {
    const t = demoTimeMs(bar, beat);
    const dur = demoTimeMs(bar, beat + beats) - t;
    for (const lane of lanes) this.notes.push({ t, lane, type: 'hold', dur });
    return this;
  }
}

function buildNotes(): Note[] {
  const c = new ChartBuilder();

  // Bars 0-1: intro, drums only. Nothing to hit.

  // Bars 2-5: single taps on every beat.
  c.run(2, 0, 1, [0, 1, 2, 3]);
  c.run(3, 0, 1, [3, 2, 1, 0]);
  c.run(4, 0, 1, [0, 2, 1, 3]);
  c.run(5, 0, 1, [3, 1, 2]); // beat 4 rests

  // Bars 6-9: alternating 8ths (hand to hand), resting on beat 4.
  c.run(6, 0, 0.5, [0, 3, 0, 3, 0, 3]);
  c.run(7, 0, 0.5, [1, 2, 1, 2, 1, 2]);
  c.run(8, 0, 0.5, [0, 2, 1, 3, 0, 2]);
  c.run(9, 0, 0.5, [3, 1, 2, 0, 3, 1]);

  // Bars 10-13: jumps on beats 1 and 3, single taps in between.
  c.tap(10, 0, 0, 3).tap(10, 1, 1).tap(10, 2, 1, 2).tap(10, 3, 3);
  c.tap(11, 0, 0, 2).tap(11, 1, 3).tap(11, 2, 1, 3).tap(11, 3, 0);
  c.tap(12, 0, 0, 3).tap(12, 1, 1).tap(12, 2, 1, 2).tap(12, 3, 3);
  c.tap(13, 0, 0, 3).tap(13, 1, 1, 2).tap(13, 2, 0, 3); // beat 4 rests

  // Bars 14-17: holds, with the other hand tapping.
  c.hold(14, 0, 2, 0).tap(14, 1, 3).tap(14, 2, 2).tap(14, 3, 1);
  c.hold(15, 0, 2, 3).tap(15, 1, 0).tap(15, 2, 1).tap(15, 3, 2);
  c.hold(16, 0, 3, 1).tap(16, 1, 3).tap(16, 2, 2);
  c.hold(17, 0, 2, 0, 3).tap(17, 3, 1).tap(17, 3.5, 2);

  // Bars 18-21: 8th-note stairs building into two short 16th-note bursts.
  c.run(18, 0, 0.5, [0, 1, 2, 3, 2, 1, 0, 1]);
  c.run(19, 0, 0.5, [3, 2, 1, 0, 1, 2, 3, 2]);
  c.run(20, 0, 0.25, [0, 1, 2, 3, 2, 1, 0, 1]).tap(20, 2, 0, 3);
  c.run(21, 0, 0.25, [3, 2, 1, 0, 1, 2, 3, 2]).tap(21, 2, 0, 3);

  // Bars 22-27: everything mixed.
  c.tap(22, 0, 0, 3).run(22, 1, 0.5, [1, 2, 1]).tap(22, 3, 0, 3);
  c.hold(23, 0, 2, 2).tap(23, 1, 0).tap(23, 1.5, 1).tap(23, 2.5, 0).tap(23, 3, 3);
  c.tap(24, 0, 1, 2).run(24, 1, 0.5, [0, 3, 0]).tap(24, 3, 1, 2);
  c.hold(25, 0, 2, 1).tap(25, 1, 3).tap(25, 1.5, 2).tap(25, 2.5, 3).tap(25, 3, 0);
  c.tap(26, 0, 0, 2).tap(26, 1, 1, 3).tap(26, 2, 0, 2).tap(26, 3, 1, 3);
  c.run(27, 0, 0.5, [0, 1, 2, 3]).tap(27, 2, 0, 3); // beat 4 rests

  // Bars 28-29: final two-lane hold.
  c.hold(28, 0, 4, 1, 2);

  return c.notes.sort(compareNotes);
}

export function createDemoChart(): Chart {
  return {
    version: CHART_VERSION,
    title: 'First Steps',
    artist: `${GAME_TITLE} demo`,
    audio: 'demo (generated)',
    bpm: DEMO_BPM,
    offsetMs: 0,
    previewStartMs: demoTimeMs(10),
    difficulty: 'Normal',
    level: 4,
    charter: GAME_TITLE,
    notes: buildNotes(),
  };
}
