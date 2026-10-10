/**
 * Conversions between the three clocks gameplay cares about:
 * - performance time (ms): `performance.now()` and `event.timeStamp`
 * - audio time (s): the AudioContext clock, ideally the time of the sample being heard now
 * - song time (ms): position in the chart; 0 is the start of the audio file
 */

/**
 * Audio-clock time (s) at which song time equals `songMs`. Song time advances `rate` ms per ms
 * of audio time (the playback rate; 1 when omitted, 0.5 in a half-speed editor preview).
 */
export interface SongAnchor {
  audioSec: number;
  songMs: number;
  rate?: number;
}

export function audioSecToSongMs(audioSec: number, anchor: SongAnchor): number {
  return anchor.songMs + (audioSec - anchor.audioSec) * 1000 * (anchor.rate ?? 1);
}

export function songMsToAudioSec(songMs: number, anchor: SongAnchor): number {
  return anchor.audioSec + (songMs - anchor.songMs) / 1000 / (anchor.rate ?? 1);
}

/**
 * Estimates the offset between performance time and audio time from (perfMs, audioSec)
 * pairs sampled each frame. Samples jitter by a few ms (the audio clock moves in blocks), so
 * the offset is smoothed; a large jump (e.g. after the context was suspended) resets it.
 */
export class ClockSync {
  private offsetMs: number | null = null;

  constructor(
    /** Weight of each new sample, 0-1. */
    private readonly smoothing = 0.1,
    /** A sample further than this from the estimate replaces it instead of being averaged. */
    private readonly resetThresholdMs = 25,
  ) {}

  get hasSample(): boolean {
    return this.offsetMs !== null;
  }

  /** Feed a pair of readings taken at the same moment. */
  sample(perfMs: number, audioSec: number): void {
    const raw = audioSec * 1000 - perfMs;
    if (this.offsetMs === null || Math.abs(raw - this.offsetMs) > this.resetThresholdMs) {
      this.offsetMs = raw;
    } else {
      this.offsetMs += (raw - this.offsetMs) * this.smoothing;
    }
  }

  reset(): void {
    this.offsetMs = null;
  }

  /** Audio time (s) corresponding to a performance timestamp (ms). Throws before any sample. */
  toAudioSec(perfMs: number): number {
    if (this.offsetMs === null) throw new Error('ClockSync has no samples yet.');
    return (perfMs + this.offsetMs) / 1000;
  }

  /** Song time (ms) for a performance timestamp, e.g. a key event's `timeStamp`. */
  toSongMs(perfMs: number, anchor: SongAnchor): number {
    return audioSecToSongMs(this.toAudioSec(perfMs), anchor);
  }
}

/**
 * The note's vertical position: `hitLineY - (noteTimeMs - songTimeMs) * scrollSpeed`.
 * Not rounded; renderers round to whole pixels.
 */
export function scrollY(
  noteTimeMs: number,
  songTimeMs: number,
  hitLineY: number,
  scrollSpeedPxPerMs: number,
): number {
  return hitLineY - (noteTimeMs - songTimeMs) * scrollSpeedPxPerMs;
}
