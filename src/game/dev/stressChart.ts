import { compareNotes, type Chart, type Lane, type Note } from '../../core/chart';

/**
 * A deliberately dense chart over a song (dev only, `?stress`): 16th-note streams at 240 BPM
 * across all lanes, a second note on every 8th and long holds in alternating lanes, so the
 * renderer can be checked for a steady frame rate with the screen full of notes.
 */
export const STRESS_BPM = 240;

export function stressChart(base: Chart, durationMs: number): Chart {
  const beatMs = 60_000 / STRESS_BPM;
  const stepMs = beatMs / 4;
  const notes: Note[] = [];
  /** Per-lane time until which a hold occupies the lane. */
  const busyUntil = [-Infinity, -Infinity, -Infinity, -Infinity];
  const add = (t: number, lane: Lane, dur = 0): void => {
    const time = Math.round(t);
    if (time <= (busyUntil[lane] ?? 0) + 30) return;
    if (dur >= 50) {
      notes.push({ t: time, lane, type: 'hold', dur: Math.round(dur) });
      busyUntil[lane] = time + Math.round(dur);
    } else {
      notes.push({ t: time, lane, type: 'tap' });
      busyUntil[lane] = time;
    }
  };
  const order: Lane[] = [0, 1, 2, 3, 2, 1];
  const end = durationMs - 1000;
  for (let i = 0, t = 1000; t < end; i++, t = 1000 + i * stepMs) {
    const beat = i % 4 === 0;
    const bar = i % 16 === 0;
    if (bar) {
      // A long hold on an outer lane every bar, alternating sides.
      add(t, (i / 16) % 2 === 0 ? 0 : 3, beatMs * 3);
    }
    add(t, order[i % order.length] as Lane);
    if (i % 2 === 0) add(t, beat ? 3 : 1);
  }
  notes.sort(compareNotes);
  const { startMs: _unused, ...rest } = base;
  return { ...rest, title: `${base.title} (stress)`, notes };
}
