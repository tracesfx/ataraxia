import { mixToMono } from '../../../core/peaks';
import type { ChartAnalysisStore } from '../../studioLibrary';
import type { ChartAnalysisMessage, ChartAnalysisRequest } from './chartAnalysisWorker';
import { computeChartFeaturesSteps, isChartFeatures } from './features';
import type { ChartFeatures } from './types';

/** Finished features per decoded song (dropped with the AudioBuffer). */
const finished = new WeakMap<AudioBuffer, ChartFeatures>();

/**
 * Computes a song's chart-analysis features at most once: from memory (same decoded buffer),
 * else from the song's IndexedDB cache (checked against CHART_ANALYSIS_VERSION), else in a Web
 * Worker with progress, then cached. Without workers it runs on the main thread in slices.
 */
export class ChartAnalyzer {
  private job: Promise<ChartFeatures> | null = null;
  private worker: Worker | null = null;
  private readonly listeners = new Set<(fraction: number) => void>();
  private disposed = false;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly buffer: AudioBuffer,
    private readonly store: ChartAnalysisStore | null,
  ) {}

  get result(): ChartFeatures | null {
    return finished.get(this.buffer) ?? null;
  }

  get running(): boolean {
    return this.job !== null && this.result === null;
  }

  onProgress(fn: (fraction: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  run(): Promise<ChartFeatures> {
    const done = this.result;
    if (done) return Promise.resolve(done);
    if (this.disposed) return Promise.reject(new Error('The analysis was stopped.'));
    if (!this.job) {
      this.job = this.load().then(
        (f) => {
          finished.set(this.buffer, f);
          return f;
        },
        (err: unknown) => {
          this.job = null;
          throw err;
        },
      );
    }
    return this.job;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.worker?.terminate();
    this.worker = null;
    this.cancel?.();
  }

  private async load(): Promise<ChartFeatures> {
    const cached = this.store ? await this.store.load() : null;
    if (isChartFeatures(cached)) return cached;
    const features = await this.start();
    if (this.store && !this.disposed) void this.store.save(features);
    return features;
  }

  private progress(fraction: number): void {
    for (const fn of this.listeners) fn(fraction);
  }

  private channels(): Float32Array[] {
    const out: Float32Array[] = [];
    for (let c = 0; c < this.buffer.numberOfChannels; c++) out.push(this.buffer.getChannelData(c));
    return out;
  }

  private start(): Promise<ChartFeatures> {
    return this.inWorker().catch((err: unknown) => {
      if (this.disposed) throw err;
      console.warn('Chart analysis worker failed; analysing on the main thread instead.', err);
      return this.onMainThread();
    });
  }

  private inWorker(): Promise<ChartFeatures> {
    return new Promise<ChartFeatures>((resolve, reject) => {
      const worker = new Worker(new URL('./chartAnalysisWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker = worker;
      this.cancel = () => reject(new Error('The analysis was cancelled.'));
      worker.addEventListener('message', (e: MessageEvent<ChartAnalysisMessage>) => {
        const m = e.data;
        if (m.kind === 'progress') {
          this.progress(m.fraction);
          return;
        }
        worker.terminate();
        this.worker = null;
        if (m.kind === 'error') {
          reject(new Error(m.message));
          return;
        }
        this.progress(1);
        resolve(m.features);
      });
      worker.addEventListener('error', (e) => {
        worker.terminate();
        this.worker = null;
        reject(new Error(e.message || 'The chart analysis worker failed to start.'));
      });
      const channels = this.channels().map((ch) => ch.slice());
      const request: ChartAnalysisRequest = { channels, sampleRate: this.buffer.sampleRate };
      worker.postMessage(
        request,
        channels.map((ch) => ch.buffer as ArrayBuffer),
      );
    });
  }

  private async onMainThread(): Promise<ChartFeatures> {
    let cancelled = false;
    this.cancel = () => {
      cancelled = true;
    };
    const steps = computeChartFeaturesSteps(mixToMono(this.channels()), this.buffer.sampleRate);
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
      this.progress(r.value);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled) throw new Error('The analysis was cancelled.');
    }
  }
}
