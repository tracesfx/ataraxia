import { audioSecToSongMs, songMsToAudioSec, type SongAnchor } from './clock';

/**
 * The song clock: maps audio-clock readings (seconds, e.g. `AudioContext.currentTime`) to song
 * time (ms). Pure state; the caller passes every audio-time reading in, so it is tested without
 * Web Audio.
 *
 * Song time 0 is the first sample of the audio file. Song time may be negative (a silent lead-in
 * before the audio begins) and runs straight through 0. While running, song time advances
 * `rate` ms per ms of audio time; while paused or stopped it holds still.
 */
export type SongClockState = 'stopped' | 'running' | 'paused';

/** When and from where an audio buffer must start so it lines up with the song clock. */
export interface AudioStartPlan {
  /** Audio-clock time (s) to start the source at; in the future for a negative song time. */
  atAudioSec: number;
  /** Position in the buffer (s) to start from. */
  offsetSec: number;
}

export class SongClock {
  private stateValue: SongClockState = 'stopped';
  private anchorValue: SongAnchor = { audioSec: 0, songMs: 0, rate: 1 };
  /** Song time while stopped or paused. */
  private heldMs = 0;
  private pausedAtSecValue = 0;
  private rateValue = 1;

  get state(): SongClockState {
    return this.stateValue;
  }

  get rate(): number {
    return this.rateValue;
  }

  /** The current mapping (meaningful while running). */
  get anchor(): Readonly<SongAnchor> {
    return this.anchorValue;
  }

  /** Audio time of the last pause. */
  get pausedAtSec(): number {
    return this.pausedAtSecValue;
  }

  /** Run so that song time `songMs` is at audio time `atAudioSec` (which may be in the future). */
  start(atAudioSec: number, songMs: number, rate = this.rateValue): void {
    assertRate(rate);
    this.rateValue = rate;
    this.anchorValue = { audioSec: atAudioSec, songMs, rate };
    this.heldMs = songMs;
    this.stateValue = 'running';
  }

  /**
   * Jump to `songMs`. While running the clock continues from there at `atAudioSec`; while paused
   * or stopped it holds the new time (a resume continues from it).
   */
  seek(songMs: number, atAudioSec: number): void {
    if (this.stateValue === 'running') {
      this.anchorValue = { audioSec: atAudioSec, songMs, rate: this.rateValue };
    } else {
      this.heldMs = songMs;
    }
  }

  /** Freeze at the song time of `audioSec`. */
  pause(audioSec: number): void {
    if (this.stateValue !== 'running') return;
    this.heldMs = this.songMsAt(audioSec);
    this.pausedAtSecValue = audioSec;
    this.stateValue = 'paused';
  }

  /**
   * Continue from the held time at `audioSec`. The time spent paused is skipped, so resuming at
   * the pause's own audio time (the clock of a suspended AudioContext stands still) keeps the
   * mapping exactly as it was, including a start scheduled ahead in a negative lead-in.
   */
  resume(audioSec: number): void {
    if (this.stateValue !== 'paused') return;
    this.anchorValue = { audioSec, songMs: this.heldMs, rate: this.rateValue };
    this.stateValue = 'running';
  }

  /** Change the speed at `audioSec` without a jump in song time. */
  setRate(rate: number, audioSec: number): void {
    assertRate(rate);
    if (this.stateValue === 'running') {
      this.anchorValue = { audioSec, songMs: this.songMsAt(audioSec), rate };
    } else {
      this.anchorValue = { ...this.anchorValue, rate };
    }
    this.rateValue = rate;
  }

  /** Stop and hold `songMs` (0 by default). */
  stop(songMs = 0): void {
    this.stateValue = 'stopped';
    this.heldMs = songMs;
  }

  /** Song time at audio time `audioSec`: linear while running (negative before 0), else held. */
  songMsAt(audioSec: number): number {
    if (this.stateValue !== 'running') return this.heldMs;
    return audioSecToSongMs(audioSec, this.anchorValue);
  }

  /** Audio time at which song time `songMs` plays, or null unless running. */
  audioSecAt(songMs: number): number | null {
    if (this.stateValue !== 'running') return null;
    return songMsToAudioSec(songMs, this.anchorValue);
  }

  /**
   * How to start a buffer of `durationMs` so that it is heard in step with the clock, beginning at
   * song time `fromSongMs` or later (never before 0, never before the clock's start). A start
   * still ahead (the clock is in negative time) gives a source start in the future at offset 0
   * on the audio clock: sample-accurate, no timer. Null when not running or past the end.
   */
  audioStart(fromSongMs: number, durationMs: number): AudioStartPlan | null {
    if (this.stateValue !== 'running') return null;
    const songMs = Math.max(0, fromSongMs, this.anchorValue.songMs);
    if (songMs >= durationMs) return null;
    return { atAudioSec: songMsToAudioSec(songMs, this.anchorValue), offsetSec: songMs / 1000 };
  }
}

function assertRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`Playback rate must be a positive number, got ${rate}`);
  }
}
