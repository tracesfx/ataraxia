import {
  bakeImage,
  brightestIn,
  hasBakedEffects,
  tintColorsFromPixels,
} from '../../core/background/bake';
import type { ImageEffects } from '../../core/background/config';
import { IMAGE_TINTS } from '../../core/background/particles';

/**
 * One bake of a background's base picture (see core/background/bake.ts): the fitted picture's
 * pixels come in, the baked pixels go back (transferred when run in the worker), with the
 * brightest colour behind the lanes and the particle tints taken from the picture.
 */

export interface BakeRequest {
  id: number;
  w: number;
  h: number;
  pixels: ArrayBuffer;
  effects: ImageEffects;
  minBlur: number;
  laneLeft: number;
  laneRight: number;
}

export interface BakeResponse {
  id: number;
  pixels: ArrayBuffer;
  brightest: string;
  tints: string[];
}

export function runBake(req: BakeRequest): BakeResponse {
  const rgba = new Uint8ClampedArray(req.pixels);
  if (hasBakedEffects(req.effects, req.minBlur)) {
    bakeImage(rgba, req.w, req.h, req.effects, req.minBlur);
  }
  // The lanes' columns with a margin (the clamp layer covers them and a little more).
  const brightest = brightestIn(rgba, req.w, req.h, req.laneLeft - 0.02, req.laneRight + 0.02);
  const tints = tintColorsFromPixels(rgba, req.w, req.h, IMAGE_TINTS);
  return { id: req.id, pixels: rgba.buffer, brightest, tints };
}

interface Job {
  req: BakeRequest;
  done: (r: BakeResponse) => void;
  failed: () => void;
}

/**
 * Runs bakes in a worker, one at a time, latest request wins: a request made while one is
 * running replaces any waiting one. Falls back to the main thread (after a yield) if the worker
 * can't start.
 */
export class Baker {
  private worker: Worker | null = null;
  private failed = false;
  private running = false;
  private waiting: Job | null = null;
  private current: Job | null = null;
  private disposed = false;

  private ensureWorker(): Worker | null {
    if (this.worker || this.failed) return this.worker;
    try {
      const w = new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' });
      w.addEventListener('message', (e: MessageEvent<BakeResponse>) => this.finish(e.data));
      w.addEventListener('error', (e) => {
        e.preventDefault();
        console.warn('The background bake worker failed; baking on the main thread instead.');
        this.failed = true;
        this.worker?.terminate();
        this.worker = null;
        this.running = false;
        const lost = this.current;
        this.current = null;
        // Its pixels went to the worker: the requester has to ask again.
        if (lost && !this.disposed) lost.failed();
        this.pump();
      });
      this.worker = w;
    } catch {
      this.failed = true;
    }
    return this.worker;
  }

  /**
   * Queue a bake; `done` runs with the result unless a newer request replaces this one, `failed`
   * if the worker broke down while working on it.
   */
  request(req: BakeRequest, done: (r: BakeResponse) => void, failed: () => void): void {
    this.waiting = { req, done, failed };
    this.pump();
  }

  private pump(): void {
    if (this.running || !this.waiting || this.disposed) return;
    const job = this.waiting;
    this.waiting = null;
    this.running = true;
    this.current = job;
    const worker = this.ensureWorker();
    if (worker) {
      worker.postMessage(job.req, [job.req.pixels]);
    } else {
      setTimeout(() => this.finish(runBake(job.req)), 0);
    }
  }

  private finish(res: BakeResponse): void {
    this.running = false;
    const job = this.current;
    this.current = null;
    // A newer request is waiting: skip this result, it is already stale.
    if (job && !this.waiting && !this.disposed) job.done(res);
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.waiting = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
