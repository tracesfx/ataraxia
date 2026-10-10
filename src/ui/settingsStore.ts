import { sanitizeSettings, type Settings } from '../core/settings';

export const SETTINGS_STORAGE_KEY = 'pixel-beat.settings';

/** The bits of `Storage` we use, so tests can pass a fake. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    // Blocked storage (some privacy modes) throws on access.
    return null;
  }
}

/**
 * The player's settings, loaded from localStorage at boot (sanitised: bad or old values fall back
 * to defaults) and saved on every change. Everything that needs settings (game, editor live
 * recording, calibration, menus) reads `value`, so all of them share one key binding config.
 */
export class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(private readonly storage: KeyValueStorage | null = browserStorage()) {
    this.current = sanitizeSettings(this.read());
  }

  get value(): Readonly<Settings> {
    return this.current;
  }

  /** Apply a change, sanitise the result, persist it and notify listeners. */
  update(patch: Partial<Omit<Settings, 'version'>>): Settings {
    this.current = sanitizeSettings({ ...this.current, ...patch });
    this.write();
    for (const fn of this.listeners) fn(this.current);
    return this.current;
  }

  /** Call `fn` after every change. Returns the unsubscribe function. */
  subscribe(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private read(): unknown {
    try {
      const text = this.storage?.getItem(SETTINGS_STORAGE_KEY);
      return text ? (JSON.parse(text) as unknown) : null;
    } catch (err) {
      console.warn('Stored settings could not be read; using defaults.', err);
      return null;
    }
  }

  private write(): void {
    try {
      this.storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.current));
    } catch (err) {
      console.warn('Settings could not be saved (storage full or blocked).', err);
    }
  }
}
