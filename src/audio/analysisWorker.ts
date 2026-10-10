import { analysisBuffers, analyzeAudioSteps } from '../core/analysis';
import { mixToMono } from '../core/peaks';
import type { AnalysisMessage, AnalysisRequest } from './audioAnalysis';

// Web Worker entry: the full audio analysis (onsets, tempo, features, intensity, build-ups,
// impacts) off the main thread, with progress.
self.addEventListener('message', (e: MessageEvent<AnalysisRequest>) => {
  const steps = analyzeAudioSteps(mixToMono(e.data.channels), e.data.sampleRate);
  let lastSent = -1;
  for (;;) {
    const r = steps.next();
    if (r.done) {
      const message: AnalysisMessage = { kind: 'done', analysis: r.value };
      self.postMessage(message, { transfer: analysisBuffers(r.value) });
      return;
    }
    // About 50 updates over the whole run is plenty for a progress bar.
    if (r.value - lastSent >= 0.02) {
      lastSent = r.value;
      const message: AnalysisMessage = { kind: 'progress', fraction: r.value };
      self.postMessage(message);
    }
  }
});
