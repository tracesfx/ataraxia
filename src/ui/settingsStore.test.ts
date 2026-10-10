import { describe, expect, it } from 'vitest';
import { SETTINGS_VERSION, defaultSettings } from '../core/settings';
import { SETTINGS_STORAGE_KEY, SettingsStore, type KeyValueStorage } from './settingsStore';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('SettingsStore', () => {
  it('starts with defaults when nothing is stored', () => {
    expect(new SettingsStore(memoryStorage()).value).toEqual(defaultSettings());
  });

  it('starts with defaults when the stored text is not JSON', () => {
    const store = new SettingsStore(memoryStorage({ [SETTINGS_STORAGE_KEY]: '{oops' }));
    expect(store.value).toEqual(defaultSettings());
  });

  it('saves updates and loads them back', () => {
    const storage = memoryStorage();
    const store = new SettingsStore(storage);
    store.update({ audioOffsetMs: 42, laneKeys: ['KeyA', 'KeyS', 'KeyK', 'KeyL'] });
    const again = new SettingsStore(storage);
    expect(again.value.audioOffsetMs).toBe(42);
    expect(again.value.laneKeys).toEqual(['KeyA', 'KeyS', 'KeyK', 'KeyL']);
    expect(JSON.parse(storage.data[SETTINGS_STORAGE_KEY] as string)).toMatchObject({
      version: SETTINGS_VERSION,
    });
  });

  it('sanitises updates and notifies listeners', () => {
    const store = new SettingsStore(memoryStorage());
    const seen: number[] = [];
    const off = store.subscribe((s) => seen.push(s.scrollSpeed));
    store.update({ scrollSpeed: 99 });
    expect(store.value.scrollSpeed).toBe(defaultSettings().scrollSpeed);
    off();
    store.update({ scrollSpeed: 5 });
    expect(seen).toEqual([defaultSettings().scrollSpeed]);
  });

  it('upgrades stored version 1 settings with the old default keys', () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        laneKeys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
      }),
    });
    expect(new SettingsStore(storage).value.laneKeys).toEqual(['KeyS', 'KeyD', 'KeyJ', 'KeyK']);
  });

  it('works without storage', () => {
    const store = new SettingsStore(null);
    expect(store.update({ hitSounds: true }).hitSounds).toBe(true);
  });
});
