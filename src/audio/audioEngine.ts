import { ClockSync } from '../core/clock';
import { SongClock } from '../core/songClock';

/** Scheduled click kinds: metronome beats and editor hit sounds can be cancelled separately. */
export type ClickSound = 'metronome' | 'hit';

/** Delay between asking to play and the first sample, so the start is never late or clipped. */
const START_DELAY_SEC = 0.05;

export type PlaybackState = 'stopped' | 'playing' | 'paused';

/**
 * Owns the AudioContext and the song clock.
 *
 * Song time is derived from the audio clock only. We use the time of the sample currently
 * being *heard* (AudioContext.getOutputTimestamp, falling back to currentTime minus the
 * reported latency) so visuals and input line up with what the player hears, not with what
 * the audio thread is rendering ahead of time. A smoothed (performance.now, audio time)
 * reference pair lets key events' `timeStamp` be converted to song time too.
 *
 * The mapping from audio time to song time is a SongClock (src/core). Song time may be negative:
 * the clock runs from there and the audio source is started *in the future* on the audio clock,
 * exactly when song time reaches 0 (sample-accurate, no timers). Clicks use the same mapping, so
 * the metronome and hit sounds work in the negative region too.
 *
 * Pausing suspends the context, which freezes the audio clock, a source start scheduled ahead
 * and the song together; the SongClock is paused at the frozen audio time and resumed at it.
 *
 * Routing: song -> music gain -> master gain -> speakers, and metronome clicks -> click gain ->
 * master gain, so the editor can balance music and clicks while `setVolume` stays the overall
 * level. A playback rate below 1 (editor preview) slows the song clock along with the audio.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private clickGain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly clock = new SongClock();
  private readonly sync = new ClockSync();
  private stateValue: PlaybackState = 'stopped';
  /** Song time shown while paused: what was heard when the pause was asked for. */
  private pausedSongMs = 0;
  /** A seek made while paused: resume plays from here. */
  private pendingSeekMs: number | null = null;
  /** Bumped by every play/pause/resume/stop so stale async completions are ignored. */
  private generation = 0;
  private readonly clicks = new Map<AudioScheduledSourceNode, ClickSound>();
  private volumeValue = 1;
  private musicVolumeValue = 1;
  private clickVolumeValue = 1;
  private rateValue = 1;

  get context(): AudioContext | null {
    return this.ctx;
  }

  get state(): PlaybackState {
    return this.stateValue;
  }

  /** True once the context exists and is running (autoplay policy satisfied). */
  get isUnlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /**
   * Create (first time) and resume the AudioContext. Call this synchronously inside a user
   * gesture handler (keydown/click) to satisfy the browser autoplay policy.
   */
  unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'running' || this.stateValue === 'paused') return Promise.resolve();
    return ctx.resume();
  }

  /**
   * Decode an encoded audio file (mp3/ogg/wav...) into an AudioBuffer at the context's sample
   * rate. Works before unlock(): a suspended context can still decode. Detaches `data`.
   */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ensureContext().decodeAudioData(data);
  }

  /** The node everything should play into (master volume), creating the context if needed. */
  get output(): { ctx: AudioContext; node: AudioNode } {
    const ctx = this.ensureContext();
    return { ctx, node: this.master as GainNode };
  }

  /** The music bus (under the master volume): song previews play into it. */
  get musicOutput(): { ctx: AudioContext; node: AudioNode } {
    const ctx = this.ensureContext();
    return { ctx, node: this.musicGain as GainNode };
  }

  /** Set the song to play. Stops current playback. */
  setBuffer(buffer: AudioBuffer | null): void {
    this.stop();
    this.buffer = buffer;
  }

  get durationMs(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  setVolume(volume: number): void {
    this.volumeValue = clamp01(volume);
    if (this.master) this.master.gain.value = this.volumeValue;
  }

  /** Level of the song alone (0-1), under the master volume. */
  setMusicVolume(volume: number): void {
    this.musicVolumeValue = clamp01(volume);
    if (this.musicGain) this.musicGain.gain.value = this.musicVolumeValue;
  }

  /** Level of metronome clicks alone (0-1), under the master volume. */
  setClickVolume(volume: number): void {
    this.clickVolumeValue = clamp01(volume);
    if (this.clickGain) this.clickGain.gain.value = this.clickVolumeValue;
  }

  get playbackRate(): number {
    return this.rateValue;
  }

  /**
   * Playback speed (source playbackRate, so pitch changes with it). The song clock runs at the
   * same rate. While playing, playback restarts from the current position at the new rate.
   */
  async setPlaybackRate(rate: number): Promise<void> {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new RangeError(`Playback rate must be a positive number, got ${rate}`);
    }
    if (rate === this.rateValue) return;
    const wasPlaying = this.stateValue === 'playing';
    const songMs = this.getSongTimeMs();
    this.rateValue = rate;
    if (wasPlaying) await this.play(songMs);
    else this.clock.setRate(rate, this.ctx?.currentTime ?? 0);
  }

  /**
   * Start playback so that song time `fromSongMs` is heard shortly from now. Negative values
   * give a lead-in: the clock runs from there and the audio starts at song time 0.
   * `audioFromMs` delays the audio further (a silent lead-in before a mid-song start): the clock
   * runs from `fromSongMs` and the audio starts at song time `audioFromMs`.
   * Resumes a paused/suspended context first.
   */
  async play(fromSongMs = 0, audioFromMs = 0): Promise<void> {
    const ctx = this.requireContext();
    const gen = ++this.generation;
    this.stopNodes();
    this.stateValue = 'stopped';
    this.pendingSeekMs = null;
    this.clock.stop(fromSongMs);
    if (ctx.state !== 'running') {
      await ctx.resume();
      if (gen !== this.generation) return;
      this.sync.reset();
    }

    this.clock.start(ctx.currentTime + START_DELAY_SEC, fromSongMs, this.rateValue);
    const plan = this.clock.audioStart(audioFromMs, this.durationMs);
    if (this.buffer && this.musicGain && plan) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this.rateValue;
      src.connect(this.musicGain);
      src.start(plan.atAudioSec, plan.offsetSec);
      this.source = src;
    }
    this.stateValue = 'playing';
  }

  /** Jump to a song position (may be negative), keeping the current play/pause state. */
  async seek(songMs: number): Promise<void> {
    if (this.stateValue === 'playing') {
      await this.play(songMs);
      return;
    }
    this.stopNodes();
    this.clock.seek(songMs, this.ctx?.currentTime ?? 0);
    if (this.stateValue === 'paused') {
      this.pausedSongMs = songMs;
      this.pendingSeekMs = songMs;
    }
  }

  /** Freeze playback and the song clock by suspending the context. */
  async pause(): Promise<void> {
    if (this.stateValue !== 'playing' || !this.ctx) return;
    const ctx = this.ctx;
    this.pausedSongMs = this.getSongTimeMs();
    this.stateValue = 'paused';
    const gen = ++this.generation;
    await ctx.suspend();
    // Pause the song clock at the frozen audio time. A resume that came first skips this: the
    // context only stood still meanwhile, so the running mapping is still right.
    if (gen === this.generation) this.clock.pause(ctx.currentTime);
  }

  async resume(): Promise<void> {
    if (this.stateValue !== 'paused' || !this.ctx) return;
    if (this.pendingSeekMs !== null) {
      await this.play(this.pendingSeekMs);
      return;
    }
    const gen = ++this.generation;
    await this.ctx.resume();
    if (gen !== this.generation) return;
    // The context's clock stood still while suspended: continue the mapping exactly as it was.
    this.clock.resume(this.clock.pausedAtSec);
    // Performance time kept going meanwhile: re-sync from scratch.
    this.sync.reset();
    this.stateValue = 'playing';
  }

  stop(): void {
    this.generation += 1;
    this.stopNodes();
    this.stateValue = 'stopped';
    this.pendingSeekMs = null;
    this.clock.stop(0);
  }

  /** Current song time in ms (negative before the audio begins). Frozen while paused/stopped. */
  getSongTimeMs(perfNowMs: number = performance.now()): number {
    if (this.stateValue === 'paused') return this.pausedSongMs;
    if (this.stateValue !== 'playing' || !this.ctx) return this.clock.songMsAt(0);
    this.sampleClock(perfNowMs);
    return this.clock.songMsAt(this.sync.toAudioSec(perfNowMs));
  }

  /**
   * Song time at which an input event happened, from its `event.timeStamp` (same time base as
   * performance.now()). Independent of frame rate: the event is placed exactly on the clock.
   */
  eventTimeToSongMs(eventTimeStamp: number): number {
    if (this.stateValue !== 'playing' || !this.ctx) return this.getSongTimeMs();
    if (!this.sync.hasSample) this.sampleClock(performance.now());
    return this.clock.songMsAt(this.sync.toAudioSec(eventTimeStamp));
  }

  /**
   * The song time that will be playing when the audio clock reaches `audioSec` (a context
   * time, not the heard time). Null unless playing. Lookahead schedulers use this to find
   * which beats fall inside their window.
   */
  songMsAtContextTime(audioSec: number): number | null {
    if (this.stateValue !== 'playing' || !this.ctx) return null;
    return this.clock.songMsAt(audioSec);
  }

  /**
   * Schedule a short click at a song time (skipped if already past): a metronome beep, or a
   * lower, woodier "hit" for editor hit sounds. Both go through the click volume.
   */
  scheduleClick(songMs: number, accent = false, sound: ClickSound = 'metronome'): void {
    const ctx = this.ctx;
    if (!ctx || !this.clickGain || this.stateValue === 'stopped') return;
    const t = this.clock.audioSecAt(songMs);
    if (t === null || t < ctx.currentTime) return;
    this.startClick(ctx, this.clickGain, t, accent, sound, 1);
  }

  /**
   * Play a click right now (gameplay hit sounds: feedback for a press that just happened).
   * `gain` (0-1) scales it on top of the click and master volumes.
   */
  playClickNow(sound: ClickSound = 'hit', gain = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.clickGain || ctx.state !== 'running' || gain <= 0) return;
    this.startClick(ctx, this.clickGain, ctx.currentTime, false, sound, clamp01(gain));
  }

  private startClick(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    accent: boolean,
    sound: ClickSound,
    level: number,
  ): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    if (sound === 'hit') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1100, t);
      osc.frequency.exponentialRampToValueAtTime(440, t + 0.03);
      g.gain.setValueAtTime(0.35 * level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    } else {
      osc.type = 'square';
      osc.frequency.value = accent ? 1760 : 1320;
      g.gain.setValueAtTime(0.12 * level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    }
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.05);
    this.clicks.set(osc, sound);
    osc.onended = () => {
      this.clicks.delete(osc);
      g.disconnect();
    };
  }

  /**
   * Stop scheduled clicks that haven't finished (e.g. when the metronome is turned off): only
   * those of one kind, or all of them.
   */
  cancelClicks(sound?: ClickSound): void {
    for (const [click, kind] of this.clicks) {
      if (sound !== undefined && kind !== sound) continue;
      this.clicks.delete(click);
      try {
        click.stop();
      } catch {
        // Already stopped.
      }
      click.disconnect();
    }
  }

  /** Output latency estimate in ms (for the debug overlay). */
  get latencyMs(): number {
    if (!this.ctx) return 0;
    return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000;
  }

  /** Close the context entirely (HMR / app shutdown). */
  async close(): Promise<void> {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.clickGain = null;
    this.sync.reset();
    if (ctx) await ctx.close();
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volumeValue;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolumeValue;
      this.musicGain.connect(this.master);
      this.clickGain = this.ctx.createGain();
      this.clickGain.gain.value = this.clickVolumeValue;
      this.clickGain.connect(this.master);
    }
    return this.ctx;
  }

  private requireContext(): AudioContext {
    if (!this.ctx)
      throw new Error('Audio is not started yet. Press a key or click to enable sound.');
    return this.ctx;
  }

  private stopNodes(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // Already stopped.
      }
      this.source.disconnect();
      this.source = null;
    }
    this.cancelClicks();
  }

  /** Feed the clock sync one (performance time, heard audio time) pair. */
  private sampleClock(perfNowMs: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const latencySec = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    let heardSec = now - latencySec;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      const { contextTime, performanceTime } = ts;
      if (contextTime !== undefined && performanceTime !== undefined && performanceTime > 0) {
        const extrapolated = contextTime + (perfNowMs - performanceTime) / 1000;
        // Reject stale or nonsensical readings (seen right after resume in some browsers):
        // the heard sample can't be ahead of the rendered one or far behind it.
        if (extrapolated <= now + 0.005 && extrapolated > now - 1) heardSec = extrapolated;
      }
    }
    this.sync.sample(perfNowMs, heardSec);
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}
