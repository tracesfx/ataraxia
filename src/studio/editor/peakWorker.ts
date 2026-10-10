import { buildPeakPyramid, mixToMono, pyramidBuffers } from '../../core/peaks';

/** Message to the peak worker: copies of the song's channels (transferred, not shared). */
export interface PeakRequest {
  channels: Float32Array[];
  sampleRate: number;
}

// Web Worker entry: mix to mono and build the waveform peak pyramid off the main thread.
self.addEventListener('message', (e: MessageEvent<PeakRequest>) => {
  const pyramid = buildPeakPyramid(mixToMono(e.data.channels), e.data.sampleRate);
  self.postMessage(pyramid, { transfer: pyramidBuffers(pyramid) });
});
