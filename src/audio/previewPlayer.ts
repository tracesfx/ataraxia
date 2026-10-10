import type { AudioEngine } from './audioEngine';

const START_DELAY_SEC = 0.05;
const STOP_FADE_SEC = 0.08;

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

/**
 * Song-select preview: loops one window of a song with a fade-in and fade-out each time round.
 * Every loop is its own source node scheduled on the audio clock, one loop ahead; a finished
 * loop disconnects itself and schedules the one after next. Only one preview ever plays:
 * `play` stops the previous one first.
 */
export class PreviewPlayer {
  private readonly voices = new Set<Voice>();
  private generation = 0;

  constructor(private readonly engine: AudioEngine) {}

  get playing(): boolean {
    return this.voices.size > 0;
  }

  play(buffer: AudioBuffer, startMs: number, lengthMs: number, fadeMs = 1000, gapMs = 400): void {
    this.stop();
    const gen = this.generation;
    const { ctx, node } = this.engine.musicOutput;
    const lenSec = Math.min(lengthMs / 1000, buffer.duration - startMs / 1000);
    if (lenSec <= 0) return;
    const fadeSec = Math.min(fadeMs / 1000, lenSec / 4);
    const periodSec = lenSec + gapMs / 1000;
    const t0 = ctx.currentTime + START_DELAY_SEC;

    const schedule = (loop: number): void => {
      if (gen !== this.generation) return;
      const when = t0 + loop * periodSec;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + fadeSec);
      gain.gain.setValueAtTime(1, when + lenSec - fadeSec);
      gain.gain.linearRampToValueAtTime(0, when + lenSec);
      src.connect(gain).connect(node);
      src.start(when, startMs / 1000, lenSec);
      const voice: Voice = { src, gain };
      this.voices.add(voice);
      src.onended = () => {
        this.release(voice);
        schedule(loop + 2);
      };
    };
    schedule(0);
    schedule(1);
  }

  /** Fade out quickly and stop. Safe to call when nothing is playing. */
  stop(): void {
    this.generation += 1;
    const ctx = this.engine.context;
    for (const voice of this.voices) {
      if (!ctx || ctx.state !== 'running') {
        // Nothing audible; a suspended context would never fire onended, so clean up now.
        this.stopNow(voice);
        continue;
      }
      const now = ctx.currentTime;
      const g = voice.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + STOP_FADE_SEC);
      try {
        voice.src.stop(now + STOP_FADE_SEC);
      } catch {
        this.stopNow(voice);
      }
    }
  }

  private stopNow(voice: Voice): void {
    try {
      voice.src.stop();
    } catch {
      // Never started or already stopped.
    }
    this.release(voice);
  }

  private release(voice: Voice): void {
    voice.src.onended = null;
    voice.src.disconnect();
    voice.gain.disconnect();
    this.voices.delete(voice);
  }
}
