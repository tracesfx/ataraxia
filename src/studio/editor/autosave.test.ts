import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoSaver, type SaveStatus } from './autosave';

interface Patch {
  a: number;
  b: string;
}

describe('AutoSaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(save = vi.fn((_: Partial<Patch>) => Promise.resolve())) {
    const statuses: SaveStatus['kind'][] = [];
    const saver = new AutoSaver<Patch>(save, (s) => statuses.push(s.kind), 500);
    return { saver, save, statuses };
  }

  it('debounces and merges changes into one save', async () => {
    const { saver, save, statuses } = make();
    saver.schedule({ a: 1 });
    await vi.advanceTimersByTimeAsync(300);
    saver.schedule({ b: 'x' });
    saver.schedule({ a: 2 });
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    expect(saver.hasUnsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ a: 2, b: 'x' });
    expect(saver.hasUnsaved).toBe(false);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('flushes immediately', async () => {
    const { saver, save } = make();
    saver.schedule({ a: 1 });
    expect(await saver.flush()).toBe(true);
    expect(save).toHaveBeenCalledWith({ a: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed patch and retries it with the next change', async () => {
    const save = vi
      .fn((_: Partial<Patch>) => Promise.resolve())
      .mockRejectedValueOnce(new Error('Disk full.'));
    const { saver, statuses } = make(save);
    saver.schedule({ a: 1, b: 'old' });
    expect(await saver.flush()).toBe(false);
    expect(saver.status).toEqual({ kind: 'error', message: 'Disk full.' });
    expect(saver.hasUnsaved).toBe(true);
    saver.schedule({ b: 'new' });
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenLastCalledWith({ a: 1, b: 'new' });
    expect(statuses.at(-1)).toBe('saved');
  });

  it('never overlaps saves; changes made during a save are saved after it', async () => {
    let release: () => void = () => undefined;
    const calls: Partial<Patch>[] = [];
    let running = 0;
    let maxRunning = 0;
    const save = vi.fn((p: Partial<Patch>) => {
      calls.push(p);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<void>((resolve) => {
        release = () => {
          running -= 1;
          resolve();
        };
      });
    });
    const { saver } = make(save);
    saver.schedule({ a: 1 });
    const first = saver.flush();
    saver.schedule({ a: 2 });
    const second = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ a: 1 }]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ a: 1 }, { a: 2 }]);
    release();
    expect(await first).toBe(false); // a newer change was still pending when it finished
    expect(await second).toBe(true);
    expect(maxRunning).toBe(1);
  });

  it('does nothing after dispose', async () => {
    const { saver, save } = make();
    saver.schedule({ a: 1 });
    saver.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });
});
