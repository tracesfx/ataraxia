import { runBake, type BakeRequest } from './bakeJob';

// Web Worker entry: bakes a background's base picture off the main thread (see bakeJob.ts).
self.addEventListener('message', (e: MessageEvent<BakeRequest>) => {
  const res = runBake(e.data);
  self.postMessage(res, { transfer: [res.pixels] });
});
