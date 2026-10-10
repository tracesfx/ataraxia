import type { ClickSound } from '../../audio/audioEngine';
import { beatsInRange, isDownbeat } from '../../core/beatGrid';
import type { Note } from '../../core/chart';
import { lowerBoundByTime } from '../../core/noteEdit';

export type { ClickSound };

/** What the click schedulers need from the audio engine. */
export interface ClickTarget {
  readonly context: AudioContext | null;
  songMsAtContextTime(audioSec: number): number | null;
  scheduleClick(songMs: number, accent: boolean, sound?: ClickSound): void;
  cancelClicks(sound?: ClickSound): void;
}

/** One click to schedule: its song time and whether it is accented. */
export interface ClickEvent {
  ms: number;
  accent: boolean;
}

export const LOOKAHEAD_SEC = 0.1;
export const TICK_MS = 25;
/** If the scheduler fell this far behind (tab in background), skip ahead instead of catching up. */
const MAX_CATCH_UP_MS = 1000;

/**
 * Lookahead click scheduler ("A Tale of Two Clocks"): a 25 ms timer schedules every event
 * falling in the next 100 ms of audio-clock time as an audio node with an exact start time. The
 * timer only decides *when to schedule*; click timing comes from the audio clock, so clicks are
 * sample-accurate and never drift, whatever the timer jitter. Events are asked for on every
 * tick, so edits (BPM, offset, notes) take effect within one lookahead window.
 *
 * The song clock (engine anchor) already includes the playback rate, so slowed playback slows
 * the clicks too. Call `resync(fromMs)` after every play/seek: the engine drops scheduled
 * clicks when it restarts playback.
 */
export class ClickScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Events up to this song time are scheduled. Null = start from "now" on the next tick. */
  private scheduledUntilMs: number | null = null;

  /** @param events the clicks with song time in (fromMs, toMs], in time order. */
  constructor(
    private readonly target: ClickTarget,
    private readonly events: (fromMs: number, toMs: number) => Iterable<ClickEvent>,
    private readonly sound: ClickSound,
  ) {}

  get enabled(): boolean {
    return this.timer !== null;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (on) {
      this.scheduledUntilMs = null;
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.tick();
    } else {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      this.target.cancelClicks(this.sound);
    }
  }

  /** Playback (re)started at `fromSongMs`: an event exactly there clicks too. */
  resync(fromSongMs: number | null = null): void {
    this.scheduledUntilMs = fromSongMs === null ? null : fromSongMs - 0.001;
    if (this.enabled) this.tick();
  }

  /** Schedule the events in the next lookahead window. Public for tests. */
  tick(): void {
    const ctx = this.target.context;
    if (!ctx) return;
    const nowMs = this.target.songMsAtContextTime(ctx.currentTime);
    const horizonMs = this.target.songMsAtContextTime(ctx.currentTime + LOOKAHEAD_SEC);
    if (nowMs === null || horizonMs === null) {
      this.scheduledUntilMs = null;
      return;
    }
    let from = this.scheduledUntilMs ?? nowMs;
    if (horizonMs - from > MAX_CATCH_UP_MS) from = nowMs;
    if (horizonMs <= from) return;
    for (const { ms, accent } of this.events(from, horizonMs)) {
      this.target.scheduleClick(ms, accent, this.sound);
    }
    this.scheduledUntilMs = horizonMs;
  }

  dispose(): void {
    this.setEnabled(false);
  }
}

/** Metronome: a click on every beat of the chart's grid, accented on downbeats. */
export class Metronome extends ClickScheduler {
  constructor(target: ClickTarget, grid: () => { bpm: number; offsetMs: number }) {
    super(
      target,
      (fromMs, toMs) => {
        const { bpm, offsetMs } = grid();
        return beatsInRange(fromMs, toMs, bpm, offsetMs).map(({ ms, beat }) => ({
          ms,
          accent: isDownbeat(beat),
        }));
      },
      'metronome',
    );
  }
}

/** Note heads with song time in (fromMs, toMs], from a sorted note list. */
export function noteHitsInRange(
  notes: readonly Note[],
  fromMs: number,
  toMs: number,
): ClickEvent[] {
  const out: ClickEvent[] = [];
  // Heads are integer ms, so "> fromMs" is ">= floor(fromMs) + 1".
  for (let i = lowerBoundByTime(notes, Math.floor(fromMs) + 1); i < notes.length; i++) {
    const t = (notes[i] as Note).t;
    if (t > toMs) break;
    // Several notes at the same time (chords) need only one click.
    if (out[out.length - 1]?.ms !== t) out.push({ ms: t, accent: false });
  }
  return out;
}

/** Hit sounds: a click on every note head as the playhead passes it. */
export class HitSounds extends ClickScheduler {
  constructor(target: ClickTarget, notes: () => readonly Note[]) {
    super(target, (fromMs, toMs) => noteHitsInRange(notes(), fromMs, toMs), 'hit');
  }
}
