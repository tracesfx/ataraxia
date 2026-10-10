import { mixToMono } from '../../../core/peaks';
import { computeChartFeaturesSteps, featureBuffers } from './features';
import type { ChartFeatures } from './types';

/** Message to the chart analysis worker: copies of the song's channels (transferred). */
export interface ChartAnalysisRequest {
  channels: Float32Array[];
  sampleRate: number;
}

export type ChartAnalysisMessage =
  | { kind: 'progress'; fraction: number }
  | { kind: 'done'; features: ChartFeatures }
  | { kind: 'error'; message: string };

// Web Worker entry (Studio only): the heavy chart-analysis features off the main thread.
self.addEventListener('message', (e: MessageEvent<ChartAnalysisRequest>) => {
  try {
    const steps = computeChartFeaturesSteps(mixToMono(e.data.channels), e.data.sampleRate);
    let lastSent = -1;
    for (;;) {
      const r = steps.next();
      if (r.done) {
        const message: ChartAnalysisMessage = { kind: 'done', features: r.value };
        self.postMessage(message, { transfer: featureBuffers(r.value) });
        return;
      }
      if (r.value - lastSent >= 0.02) {
        lastSent = r.value;
        const message: ChartAnalysisMessage = { kind: 'progress', fraction: r.value };
        self.postMessage(message);
      }
    }
  } catch (err) {
    const message: ChartAnalysisMessage = {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(message);
  }
});
