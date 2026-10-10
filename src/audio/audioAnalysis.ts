import { analyzeAudioSteps, type AudioAnalysis } from '../core/analysis';
import { mixToMono } from '../core/peaks';

export type { AudioAnalysis };

/** Message to the analysis worker: copies of the song's channels (transferred). */
export interface AnalysisRequest {
  channels: Float32Array[];
  sampleRate: number;
}

/** Messages from the analysis worker. */
export type AnalysisMessage =
  { kind: 'progress'; fraction: number } | { kind: 'done'; analysis: AudioAnalysis };

/** Where finished analyses are kept between editor visits (IndexedDB, per song). */
export interface AnalysisCache {
  load(): Promise<AudioAnalysis | null>;
  save(analysis: AudioAnalysis): Promise<void>;
}

/** Finished analyses per decoded song (dropped with the AudioBuffer). */
const finished = new WeakMap<AudioBuffer, AudioAnalysis>();

export type ProgressListener = (fraction: number) => void;

/**
 * Runs the audio analysis of one song at most once and shares the result between the editor's
 * assist tools: from memory (same decoded buffer), else from the song's IndexedDB cache, else
 * computed in a Web Worker and then cached. If workers are unavailable it runs on the main thread
 * in small slices so the page stays responsive.
 */
export class AudioAnalyzer {
  private job: Promise<AudioAnalysis> | null = null;
  private worker: Worker | null = null;
  private readonly listeners = new Set<ProgressListener>();
  private readonly readyListeners = new Set<(a: AudioAnalysis) => void>();
  private disposed = false;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly buffer: AudioBuffer,
    private readonly cache: AnalysisCache | null = null,
  ) {}

  /** The analysis if it has finished. */
  get result(): AudioAnalysis | null {
    return finished.get(this.buffer) ?? null;
  }

  get running(): boolean {
    return this.job !== null && this.result === null;
  }

  /** Progress (0-1) of a running analysis. Returns the unsubscribe function. */
  onProgress(fn: ProgressListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called once the analysis is available (now, if it already is). */
  onReady(fn: (a: AudioAnalysis) => void): () => void {
    const done = this.result;
    if (done) fn(done);
    else this.readyListeners.add(fn);
    return () => this.readyListeners.delete(fn);
  }

  /** Load a cached analysis without computing one (cheap; for overlays). */
  async peek(): Promise<AudioAnalysis | null> {
    const done = this.result;
    if (done || !this.cache) return done;
    const cached = await this.cache.load();
    if (cached && !this.disposed && !this.result) this.finish(cached);
    return this.result;
  }

  /** The analysis: in memory, cached, already running, or started now. */
  run(): Promise<AudioAnalysis> {
    const done = this.result;
    if (done) return Promise.resolve(done);
    if (this.disposed) return Promise.reject(new Error('The analysis was stopped.'));
    if (!this.job) {
      this.job = this.load().then(
        (analysis) => {
          this.finish(analysis);
          return analysis;
        },
        (err: unknown) => {
          this.job = null;
          throw err;
        },
      );
    }
    return this.job;
  }

  /** Stop a running analysis (scene exit). */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.readyListeners.clear();
    this.worker?.terminate();
    this.worker = null;
    this.cancel?.();
  }

  private finish(analysis: AudioAnalysis): void {
    if (finished.get(this.buffer) === analysis) return;
    finished.set(this.buffer, analysis);
    for (const fn of this.readyListeners) fn(analysis);
    this.readyListeners.clear();
  }

  private async load(): Promise<AudioAnalysis> {
    const cached = this.cache ? await this.cache.load() : null;
    if (cached) return cached;
    const analysis = await this.start();
    if (this.cache && !this.disposed) void this.cache.save(analysis);
    return analysis;
  }

  private progress(fraction: number): void {
    for (const fn of this.listeners) fn(fraction);
  }

  private channels(): Float32Array[] {
    const out: Float32Array[] = [];
    for (let c = 0; c < this.buffer.numberOfChannels; c++) out.push(this.buffer.getChannelData(c));
    return out;
  }

  private start(): Promise<AudioAnalysis> {
    return this.inWorker().catch((err: unknown) => {
      if (this.disposed) throw err;
      console.warn('Audio analysis worker failed; analysing on the main thread instead.', err);
      return this.onMainThread();
    });
  }

  private inWorker(): Promise<AudioAnalysis> {
    return new Promise<AudioAnalysis>((resolve, reject) => {
      const worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker = worker;
      this.cancel = () => reject(new Error('The analysis was cancelled.'));
      worker.addEventListener('message', (e: MessageEvent<AnalysisMessage>) => {
        if (e.data.kind === 'progress') {
          this.progress(e.data.fraction);
          return;
        }
        worker.terminate();
        this.worker = null;
        this.progress(1);
        resolve(e.data.analysis);
      });
      worker.addEventListener('error', (e) => {
        worker.terminate();
        this.worker = null;
        reject(new Error(e.message || 'The analysis worker failed to start.'));
      });
      // Copies, because the AudioBuffer's own channel arrays can't be transferred.
      const channels = this.channels().map((ch) => ch.slice());
      const request: AnalysisRequest = { channels, sampleRate: this.buffer.sampleRate };
      worker.postMessage(
        request,
        channels.map((ch) => ch.buffer as ArrayBuffer),
      );
    });
  }

  private async onMainThread(): Promise<AudioAnalysis> {
    let cancelled = false;
    this.cancel = () => {
      cancelled = true;
    };
    const steps = analyzeAudioSteps(mixToMono(this.channels()), this.buffer.sampleRate);
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
      this.progress(r.value);
      // Let the page breathe between slices.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled) throw new Error('The analysis was cancelled.');
    }
  }
}
