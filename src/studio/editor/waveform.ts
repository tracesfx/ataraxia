import { buildPeakPyramid, mixToMono, type PeakPyramid } from '../../core/peaks';
import type { PeakRequest } from './peakWorker';

/** Pyramids per decoded song; dropped with the AudioBuffer when the library forgets it. */
const cache = new WeakMap<AudioBuffer, Promise<PeakPyramid>>();

/**
 * The waveform peak pyramid of a decoded song, computed once per buffer in a Web Worker (the
 * main thread only copies the channels). Falls back to computing on the main thread if
 * workers are unavailable.
 */
export function loadPeaks(buffer: AudioBuffer): Promise<PeakPyramid> {
  const cached = cache.get(buffer);
  if (cached) return cached;
  const loading = computeInWorker(buffer).catch((err: unknown) => {
    console.warn('Waveform worker failed; computing on the main thread instead.', err);
    return computeHere(buffer);
  });
  cache.set(buffer, loading);
  return loading;
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

function computeHere(buffer: AudioBuffer): PeakPyramid {
  return buildPeakPyramid(mixToMono(channelsOf(buffer)), buffer.sampleRate);
}

function computeInWorker(buffer: AudioBuffer): Promise<PeakPyramid> {
  return new Promise<PeakPyramid>((resolve, reject) => {
    const worker = new Worker(new URL('./peakWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e: MessageEvent<PeakPyramid>) => {
      worker.terminate();
      resolve(e.data);
    });
    worker.addEventListener('error', (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The waveform worker failed to start.'));
    });
    // Copies, because the AudioBuffer's own channel arrays can't be transferred.
    const channels = channelsOf(buffer).map((ch) => ch.slice());
    const request: PeakRequest = { channels, sampleRate: buffer.sampleRate };
    worker.postMessage(
      request,
      channels.map((ch) => ch.buffer as ArrayBuffer),
    );
  });
}
