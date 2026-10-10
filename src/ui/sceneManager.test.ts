import { describe, expect, it, vi } from 'vitest';
import { SceneManager, type FrameScheduler, type Scene, type SceneScope } from './sceneManager';

/** Manual frame scheduler so tests control when frames fire. */
function fakeScheduler(): FrameScheduler & { flush(ts?: number): void; pending: number } {
  let next = 1;
  const callbacks = new Map<number, (ts: number) => void>();
  return {
    request(cb) {
      const h = next++;
      callbacks.set(h, cb);
      return h;
    },
    cancel(h) {
      callbacks.delete(h);
    },
    flush(ts = 0) {
      const now = [...callbacks.values()];
      callbacks.clear();
      now.forEach((cb) => cb(ts));
    },
    get pending() {
      return callbacks.size;
    },
  };
}

interface Params {
  a: undefined;
  b: { value: number };
}

describe('SceneManager', () => {
  it('calls enter/exit hooks in order and passes params', async () => {
    const log: string[] = [];
    const manager = new SceneManager<Params>(fakeScheduler());
    manager.register('a', () => ({
      enter: () => void log.push('enter a'),
      exit: () => void log.push('exit a'),
    }));
    manager.register('b', () => ({
      enter: (_scope, p) => void log.push(`enter b ${p.value}`),
      exit: () => void log.push('exit b'),
    }));

    await manager.goTo('a');
    await manager.goTo('b', { value: 7 });
    expect(manager.currentId).toBe('b');
    manager.shutdown();
    expect(log).toEqual(['enter a', 'exit a', 'enter b 7', 'exit b']);
    expect(manager.currentId).toBeNull();
  });

  it('removes listeners registered through the scope on exit', async () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const manager = new SceneManager<Params>(fakeScheduler());
    manager.register('a', () => ({ enter: (scope) => scope.listen(target, 'ping', handler) }));
    manager.register('b', () => ({ enter: () => undefined }));

    await manager.goTo('a');
    target.dispatchEvent(new Event('ping'));
    await manager.goTo('b', { value: 1 });
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stops frame loops and runs disposers on exit', async () => {
    const scheduler = fakeScheduler();
    const frame = vi.fn();
    const disposed: string[] = [];
    let scopeA: SceneScope | null = null;
    const manager = new SceneManager<Params>(scheduler);
    manager.register('a', () => ({
      enter: (scope) => {
        scopeA = scope;
        scope.everyFrame(frame);
        scope.onDispose(() => disposed.push('first'));
        scope.onDispose(() => disposed.push('second'));
      },
    }));
    manager.register('b', () => ({ enter: () => undefined }));

    await manager.goTo('a');
    scheduler.flush();
    scheduler.flush();
    expect(frame).toHaveBeenCalledTimes(2);
    expect(scheduler.pending).toBe(1);

    await manager.goTo('b', { value: 0 });
    expect(scheduler.pending).toBe(0);
    scheduler.flush();
    expect(frame).toHaveBeenCalledTimes(2);
    expect(disposed).toEqual(['second', 'first']);
    expect(scopeA!.disposed).toBe(true);
    expect(scopeA!.signal.aborted).toBe(true);
  });

  it('paces a frame loop by a frame-rate limit read every frame', async () => {
    const scheduler = fakeScheduler();
    const frame = vi.fn();
    let limit: 'display' | number = 60;
    const manager = new SceneManager<Params>(scheduler);
    manager.register('a', () => ({
      enter: (scope) => {
        scope.everyFramePaced(() => limit, frame);
      },
    }));
    await manager.goTo('a');
    // One second of a 144 Hz display under a 60 fps cap.
    for (let i = 0; i < 144; i++) scheduler.flush((i * 1000) / 144);
    expect(frame.mock.calls.length).toBeGreaterThanOrEqual(59);
    expect(frame.mock.calls.length).toBeLessThanOrEqual(61);
    frame.mockClear();
    limit = 'display';
    for (let i = 144; i < 288; i++) scheduler.flush((i * 1000) / 144);
    expect(frame).toHaveBeenCalledTimes(144);
  });

  it('draws from a timer for unlimited frames, and stops on exit', async () => {
    const scheduler = fakeScheduler();
    const frame = vi.fn();
    const manager = new SceneManager<Params>(scheduler);
    manager.register('a', () => ({
      enter: (scope) => {
        scope.everyFramePaced(() => 'unlimited', frame);
      },
    }));
    manager.register('b', () => ({ enter: () => undefined }));
    await manager.goTo('a');
    scheduler.flush(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const drawn = frame.mock.calls.length;
    expect(drawn).toBeGreaterThan(3);
    await manager.goTo('b', { value: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frame.mock.calls.length).toBeLessThanOrEqual(drawn + 1);
    expect(scheduler.pending).toBe(0);
  });

  it('a stopped frame loop does not reschedule', async () => {
    const scheduler = fakeScheduler();
    const manager = new SceneManager<Params>(scheduler);
    let stop = (): void => undefined;
    manager.register('a', () => ({
      enter: (scope) => void (stop = scope.everyFrame(() => undefined)),
    }));
    await manager.goTo('a');
    scheduler.flush();
    stop();
    expect(scheduler.pending).toBe(0);
    expect(manager.currentScope?.pendingFrames).toBe(0);
  });

  it('serialises transitions requested back to back', async () => {
    const log: string[] = [];
    const manager = new SceneManager<Params>(fakeScheduler());
    const slow = (name: string): Scene<unknown> => ({
      enter: async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`end ${name}`);
      },
      exit: () => void log.push(`exit ${name}`),
    });
    manager.register('a', () => slow('a'));
    manager.register('b', () => slow('b'));
    await Promise.all([manager.goTo('a'), manager.goTo('b', { value: 0 })]);
    expect(log).toEqual(['start a', 'end a', 'exit a', 'start b', 'end b']);
  });

  it('cleans up and stays usable when enter throws', async () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const manager = new SceneManager<Params>(fakeScheduler());
    manager.register('a', () => ({
      enter: (scope) => {
        scope.listen(target, 'ping', handler);
        throw new Error('boom');
      },
    }));
    manager.register('b', () => ({ enter: () => undefined }));

    await expect(manager.goTo('a')).rejects.toThrow('boom');
    target.dispatchEvent(new Event('ping'));
    expect(handler).not.toHaveBeenCalled();
    expect(manager.currentId).toBeNull();
    await manager.goTo('b', { value: 2 });
    expect(manager.currentId).toBe('b');
  });

  it('rejects unknown scenes', async () => {
    const manager = new SceneManager<Params>(fakeScheduler());
    await expect(manager.goTo('a')).rejects.toThrow(/Unknown scene "a"/);
  });
});
