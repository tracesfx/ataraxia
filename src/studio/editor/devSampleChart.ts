import { compareNotes, type Lane, type Note } from '../../core/chart';
import { beatToMs } from '../../core/time';

/**
 * A plausible chart for screenshots of the editor (dev only, `?editorChart=sample`): a few bars
 * each of quarter-note taps, an eighth-note stream, holds under taps and jumps, repeating over
 * the song on its grid. Never shipped: only reached behind `import.meta.env.DEV`.
 */
export function sampleChartNotes(bpm: number, offsetMs: number, durationMs: number): Note[] {
  const notes: Note[] = [];
  const at = (beat: number): number => Math.round(beatToMs(beat, bpm, offsetMs));
  const tap = (beat: number, lane: Lane): void => {
    notes.push({ t: at(beat), lane, type: 'tap' });
  };
  const hold = (beat: number, lane: Lane, beats: number): void => {
    const t = at(beat);
    notes.push({ t, lane, type: 'hold', dur: at(beat + beats) - t });
  };
  const lastBeat = Math.floor(((durationMs - offsetMs) * bpm) / 60_000) - 4;
  for (let bar = 1; bar * 4 + 4 <= lastBeat; bar++) {
    const b = bar * 4;
    switch (bar % 4) {
      case 1:
        ([0, 2, 1, 3] as const).forEach((lane, i) => tap(b + i, lane));
        break;
      case 2:
        ([0, 1, 2, 3, 2, 1, 0, 1] as const).forEach((lane, i) => tap(b + i / 2, lane));
        break;
      case 3:
        hold(b, 0, 2);
        tap(b, 2);
        tap(b + 1, 3);
        tap(b + 2, 1);
        hold(b + 2, 3, 1.5);
        tap(b + 3, 0);
        break;
      default:
        tap(b, 0);
        tap(b, 3);
        tap(b + 0.5, 1);
        tap(b + 1, 2);
        tap(b + 1.5, 1);
        tap(b + 2, 1);
        tap(b + 2, 2);
        tap(b + 2.75, 0);
        tap(b + 3, 3);
        tap(b + 3.5, 2);
        break;
    }
  }
  return notes.sort(compareNotes);
}
