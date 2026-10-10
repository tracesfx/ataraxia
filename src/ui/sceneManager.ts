import { FramePacer, RefreshEstimator, needsTimer, type FrameRateLimit } from '../core/framePacing';
import { countRenderedFrame } from './fpsMeter';

/**
 * Small scene manager. Each visit to a scene gets a fresh scene instance and a SceneScope.
 * Anything registered through the scope (DOM listeners, frame loops, audio nodes, other
 * cleanup) is torn down automatically after the scene's `exit` hook runs, so scenes can't
 * leak listeners or animation frames into the next scene.
 */

export interface FrameScheduler {
  request(cb: (timestampMs: number) => void): number;
  cancel(handle: number): void;
}

const browserScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export class SceneScope {
  private readonly abort = new AbortController();
  private readonly disposers: (() => void)[] = [];
  private readonly frames = new Set<number>();
  private disposedValue = false;

  constructor(private readonly scheduler: FrameScheduler) {}

  /** Aborted when the scene exits; pass to fetch() or other abortable APIs. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get disposed(): boolean {
    return this.disposedValue;
  }

  /** Add an event listener that is removed when the scene exits. */
  listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    handler: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options: AddEventListenerOptions = {},
  ): void {
    if (this.disposedValue) return;
    target.addEventListener(type, handler, { ...options, signal: this.abort.signal });
  }

  /**
   * Run `cb` every animation frame until the scene exits or the returned function is called.
   * The timestamp is for visuals only; gameplay time must come from the audio clock.
   */
  everyFrame(cb: (timestampMs: number) => void): () => void {
    let handle = -1;
    let stopped = this.disposedValue;
    const tick = (ts: number): void => {
      this.frames.delete(handle);
      if (stopped) return;
      handle = this.scheduler.request(tick);
      this.frames.add(handle);
      cb(ts);
    };
    if (!stopped) {
      handle = this.scheduler.request(tick);
      this.frames.add(handle);
    }
    return () => {
      stopped = true;
      this.scheduler.cancel(handle);
      this.frames.delete(handle);
    };
  }

  /**
   * Like `everyFrame`, paced by a frame-rate limit read on every frame (core/framePacing):
   * 'display' draws on every refresh, a cap skips refreshes (or, above the display rate, draws
   * from a timer), 'unlimited' draws from a timer as often as the page allows. The timestamp is
   * on the `performance.now()` clock either way; visuals only, never gameplay time.
   */
  everyFramePaced(limit: () => FrameRateLimit, cb: (timestampMs: number) => void): () => void {
    const pacer = new FramePacer();
    const refresh = new RefreshEstimator();
    let stopped = this.disposedValue;
    let channel: MessageChannel | null = null;
    let timerRunning = false;
    const draw = (ts: number): void => {
      countRenderedFrame();
      cb(ts);
    };
    const timerTick = (): void => {
      if (stopped || !channel) return;
      const l = limit();
      if (!needsTimer(l, refresh.hz)) {
        timerRunning = false;
        pacer.reset();
        return;
      }
      const now = performance.now();
      if (typeof l !== 'number' || pacer.due(now, l)) draw(now);
      channel.port2.postMessage(null);
    };
    const startTimer = (): void => {
      if (timerRunning || stopped) return;
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = timerTick;
      }
      timerRunning = true;
      pacer.reset();
      channel.port2.postMessage(null);
    };
    const stopFrames = this.everyFrame((ts) => {
      refresh.add(ts);
      const l = limit();
      if (needsTimer(l, refresh.hz)) {
        startTimer();
        return;
      }
      if (typeof l !== 'number' || pacer.due(ts, l)) draw(ts);
    });
    const stop = (): void => {
      stopped = true;
      stopFrames();
      if (channel) {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        channel = null;
      }
    };
    this.onDispose(stop);
    return stop;
  }

  /** Register cleanup (disconnect audio nodes, remove DOM, ...). Runs in reverse order. */
  onDispose(fn: () => void): void {
    if (this.disposedValue) {
      fn();
      return;
    }
    this.disposers.push(fn);
  }

  /** Number of pending animation frames; used by tests and the dev overlay. */
  get pendingFrames(): number {
    return this.frames.size;
  }

  dispose(): void {
    if (this.disposedValue) return;
    this.disposedValue = true;
    this.abort.abort();
    for (const handle of this.frames) this.scheduler.cancel(handle);
    this.frames.clear();
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop() as () => void;
      try {
        fn();
      } catch (err) {
        console.error('Scene cleanup failed:', err);
      }
    }
  }
}

export interface Scene<P> {
  /** Set up the scene. Register all listeners/frames/cleanup through `scope`. */
  enter(scope: SceneScope, params: P): void | Promise<void>;
  /** Optional extra teardown; runs before the scope is disposed. */
  exit?(): void;
}

type SceneFactory<P> = () => Scene<P>;

/** `Params` maps each scene id to the parameter type its enter() receives. */
export class SceneManager<Params extends object> {
  private readonly factories = new Map<keyof Params, SceneFactory<never>>();
  private active: { id: keyof Params; scene: Scene<never>; scope: SceneScope } | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly scheduler: FrameScheduler = browserScheduler) {}

  register<K extends keyof Params>(id: K, factory: SceneFactory<Params[K]>): void {
    this.factories.set(id, factory as SceneFactory<never>);
  }

  get currentId(): keyof Params | null {
    return this.active?.id ?? null;
  }

  get currentScope(): SceneScope | null {
    return this.active?.scope ?? null;
  }

  /**
   * Exit the current scene and enter `id`. Transitions are serialised: calling goTo while a
   * transition is running queues the next one. Resolves once the new scene has entered.
   */
  goTo<K extends keyof Params>(
    id: K,
    ...params: Params[K] extends undefined ? [params?: Params[K]] : [params: Params[K]]
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const factory = this.factories.get(id) as SceneFactory<Params[K]> | undefined;
      if (!factory) throw new Error(`Unknown scene "${String(id)}"`);
      this.exitCurrent();
      const scene = factory();
      const scope = new SceneScope(this.scheduler);
      this.active = { id, scene: scene as Scene<never>, scope };
      try {
        await scene.enter(scope, params[0] as Params[K]);
      } catch (err) {
        this.exitCurrent();
        throw err;
      }
    };
    const next = this.queue.then(run);
    // Keep the queue alive after a failed transition.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Exit the current scene without entering another (e.g. on app shutdown / HMR). */
  shutdown(): void {
    this.exitCurrent();
  }

  private exitCurrent(): void {
    const current = this.active;
    if (!current) return;
    this.active = null;
    try {
      current.scene.exit?.();
    } catch (err) {
      console.error(`Error exiting scene "${String(current.id)}":`, err);
    } finally {
      current.scope.dispose();
    }
  }
}
