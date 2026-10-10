import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANE_KEYS,
  LEGACY_DEFAULT_LANE_KEYS,
  SETTINGS_VERSION,
  clampScrollSpeed,
  defaultSettings,
  isReservedKey,
  keyLabel,
  laneBindings,
  laneKeysLabel,
  rebindLane,
  sanitizeSettings,
  stepScrollSpeed,
} from './settings';

describe('sanitizeSettings', () => {
  it('returns the defaults for missing or non-object input', () => {
    for (const input of [undefined, null, 'x', 42, [], true]) {
      expect(sanitizeSettings(input)).toEqual(defaultSettings());
    }
  });

  it('keeps a valid current-version object unchanged', () => {
    const s = {
      ...defaultSettings(),
      audioOffsetMs: 25,
      scrollSpeed: 7.2,
      laneKeys: ['KeyA', 'KeyS', 'Semicolon', 'Quote'],
      masterVolume: 0.5,
      musicVolume: 0.25,
      hitSoundVolume: 0,
      hitSounds: true,
      debugOverlay: true,
      earlyLateIndicator: false,
      resumeDelayMs: 0,
      runInMs: 3000,
    };
    expect(sanitizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('defaults the resume delay to 1 s and the run-in to 1.5 s, accepting only listed values', () => {
    const d = defaultSettings();
    expect(d.resumeDelayMs).toBe(1000);
    expect(d.runInMs).toBe(1500);
    // Older saved settings have neither field.
    expect(sanitizeSettings({ version: 2 }).resumeDelayMs).toBe(1000);
    expect(sanitizeSettings({ version: 2, resumeDelayMs: 500 }).resumeDelayMs).toBe(500);
    expect(sanitizeSettings({ version: 2, resumeDelayMs: 750 }).resumeDelayMs).toBe(1000);
    expect(sanitizeSettings({ version: 2, runInMs: -5 }).runInMs).toBe(1500);
    expect(sanitizeSettings({ version: 2, runInMs: 0 }).runInMs).toBe(0);
  });

  it('replaces each bad field with its default and keeps the good ones', () => {
    const s = sanitizeSettings({
      version: 1,
      audioOffsetMs: 999,
      scrollSpeed: 'fast',
      laneKeys: ['KeyA', 'KeyA', 'KeyJ', 'KeyK'],
      masterVolume: 1.5,
      musicVolume: -0.1,
      hitSoundVolume: 0.3,
      hitSounds: 'yes',
      debugOverlay: true,
    });
    const d = defaultSettings();
    expect(s.audioOffsetMs).toBe(d.audioOffsetMs);
    expect(s.scrollSpeed).toBe(d.scrollSpeed);
    expect(s.laneKeys).toEqual(DEFAULT_LANE_KEYS);
    expect(s.masterVolume).toBe(1);
    expect(s.musicVolume).toBe(1);
    expect(s.hitSoundVolume).toBe(0.3);
    expect(s.hitSounds).toBe(d.hitSounds);
    expect(s.debugOverlay).toBe(true);
    expect(s.earlyLateIndicator).toBe(d.earlyLateIndicator);
  });

  it('rounds offsets to whole ms and speeds to the 0.1 grid', () => {
    const s = sanitizeSettings({ version: 1, audioOffsetMs: 12.6, scrollSpeed: 4.26 });
    expect(s.audioOffsetMs).toBe(13);
    expect(s.scrollSpeed).toBe(4.3);
  });

  it('accepts the range limits and rejects values beyond them', () => {
    expect(sanitizeSettings({ version: 1, audioOffsetMs: -300 }).audioOffsetMs).toBe(-300);
    expect(sanitizeSettings({ version: 1, audioOffsetMs: 300 }).audioOffsetMs).toBe(300);
    expect(sanitizeSettings({ version: 1, audioOffsetMs: 301 }).audioOffsetMs).toBe(0);
    expect(sanitizeSettings({ version: 1, scrollSpeed: 10 }).scrollSpeed).toBe(10);
    expect(sanitizeSettings({ version: 1, scrollSpeed: 0.5 }).scrollSpeed).toBe(3.5);
  });

  it('rejects key sets with reserved keys or the wrong length', () => {
    const keys = (laneKeys: unknown): unknown =>
      sanitizeSettings({ version: 1, laneKeys }).laneKeys;
    expect(keys(['KeyA', 'KeyS', 'KeyD', 'Escape'])).toEqual(DEFAULT_LANE_KEYS);
    expect(keys(['KeyA', 'KeyS', 'KeyD'])).toEqual(DEFAULT_LANE_KEYS);
    expect(keys(['KeyA', 'KeyS', 'KeyD', 7])).toEqual(DEFAULT_LANE_KEYS);
  });

  it('gives the defaults for a version newer than this build or an invalid version', () => {
    const fromFuture = { version: SETTINGS_VERSION + 1, audioOffsetMs: 40 };
    expect(sanitizeSettings(fromFuture)).toEqual(defaultSettings());
    expect(sanitizeSettings({ version: -1, audioOffsetMs: 40 })).toEqual(defaultSettings());
    expect(sanitizeSettings({ version: 1.5, audioOffsetMs: 40 })).toEqual(defaultSettings());
  });

  it('migrates unversioned (phase 1-4) settings: px/ms speed and a code->lane table', () => {
    const s = sanitizeSettings({
      scrollSpeed: 0.5,
      keyBindings: { KeyA: 0, KeyS: 1, KeyK: 2, KeyL: 3 },
    });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.scrollSpeed).toBe(5);
    expect(s.laneKeys).toEqual(['KeyA', 'KeyS', 'KeyK', 'KeyL']);
    expect(s).not.toHaveProperty('keyBindings');
  });

  it('falls back to default keys when an unversioned table leaves a lane unbound', () => {
    const s = sanitizeSettings({ keyBindings: { KeyA: 0, KeyS: 1, KeyK: 2 } });
    expect(s.laneKeys).toEqual(DEFAULT_LANE_KEYS);
  });

  it('has S D J K as the default lane keys', () => {
    expect(DEFAULT_LANE_KEYS).toEqual(['KeyS', 'KeyD', 'KeyJ', 'KeyK']);
    expect(defaultSettings().laneKeys).toEqual(DEFAULT_LANE_KEYS);
  });

  it('moves version 1 settings with the old default keys (D F J K) to the new defaults', () => {
    const s = sanitizeSettings({
      version: 1,
      audioOffsetMs: 12,
      laneKeys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.laneKeys).toEqual(DEFAULT_LANE_KEYS);
    expect(s.audioOffsetMs).toBe(12);
  });

  it('keeps customised version 1 key bindings', () => {
    for (const laneKeys of [
      ['KeyA', 'KeyS', 'KeyK', 'KeyL'],
      ['KeyF', 'KeyD', 'KeyJ', 'KeyK'],
      ['KeyD', 'KeyF', 'KeyK', 'KeyJ'],
    ]) {
      expect(sanitizeSettings({ version: 1, laneKeys }).laneKeys).toEqual(laneKeys);
    }
  });

  it('does not touch version 2 settings that use D F J K on purpose', () => {
    const s = sanitizeSettings({ version: 2, laneKeys: [...LEGACY_DEFAULT_LANE_KEYS] });
    expect(s.laneKeys).toEqual(LEGACY_DEFAULT_LANE_KEYS);
  });

  it('adds the display settings when migrating version 2 (v3)', () => {
    const s = sanitizeSettings({ version: 2, audioOffsetMs: 20, uiScale: 3, showFps: true });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.audioOffsetMs).toBe(20);
    // A version 2 object had no display settings: the migration sets the defaults.
    expect(s.uiScale).toBe('auto');
    expect(s.showFps).toBe(false);
  });

  it('keeps valid display settings and drops invalid ones', () => {
    expect(sanitizeSettings({ version: 3, uiScale: 2, showFps: true })).toMatchObject({
      uiScale: 2,
      showFps: true,
    });
    expect(sanitizeSettings({ version: 3, uiScale: 7 }).uiScale).toBe('auto');
    expect(sanitizeSettings({ version: 3, uiScale: '2' }).uiScale).toBe('auto');
    expect(sanitizeSettings({ version: 3, showFps: 'yes' }).showFps).toBe(false);
  });

  it('adds the effects and timing particle settings when migrating version 3 (v4)', () => {
    const s = sanitizeSettings({
      version: 3,
      uiScale: 2,
      effects: 'minimal',
      timingParticles: false,
      timingParticleThresholdMs: 5,
    });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.uiScale).toBe(2);
    // Version 3 had none of these: the migration sets the defaults.
    expect(s.effects).toBe('full');
    expect(s.timingParticles).toBe(true);
    expect(s.timingParticleThresholdMs).toBe(40);
    expect(s.timingParticleSize).toBe('medium');
  });

  it('keeps valid effects and particle settings and repairs invalid ones', () => {
    expect(
      sanitizeSettings({
        version: 4,
        effects: 'minimal',
        timingParticles: false,
        timingParticleThresholdMs: 80,
        timingParticleSize: 'large',
      }),
    ).toMatchObject({
      effects: 'minimal',
      timingParticles: false,
      timingParticleThresholdMs: 80,
      timingParticleSize: 'large',
    });
    const bad = sanitizeSettings({
      version: 4,
      effects: 'max',
      timingParticles: 1,
      timingParticleThresholdMs: 500,
      timingParticleSize: 'huge',
    });
    expect(bad.effects).toBe('full');
    expect(bad.timingParticles).toBe(true);
    expect(bad.timingParticleThresholdMs).toBe(120);
    expect(bad.timingParticleSize).toBe('medium');
    expect(
      sanitizeSettings({ version: 4, timingParticleThresholdMs: -3.7 }).timingParticleThresholdMs,
    ).toBe(0);
    expect(
      sanitizeSettings({ version: 4, timingParticleThresholdMs: 'x' }).timingParticleThresholdMs,
    ).toBe(40);
  });

  it('adds the frame rate setting when migrating version 4 (v5), matching the display', () => {
    const s = sanitizeSettings({ version: 4, effects: 'minimal', showFps: true });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.frameRateLimit).toBe('display');
    expect(s.effects).toBe('minimal');
    expect(s.showFps).toBe(true);
  });

  it('keeps valid frame rate limits and repairs invalid ones', () => {
    for (const limit of ['display', 'unlimited', 30, 144, 480] as const) {
      expect(sanitizeSettings({ version: 5, frameRateLimit: limit }).frameRateLimit).toBe(limit);
    }
    for (const bad of [75, 0, -1, 'fast', null, '144']) {
      expect(sanitizeSettings({ version: 5, frameRateLimit: bad }).frameRateLimit).toBe('display');
    }
  });

  it('adds the background settings when migrating version 5 (v6), keeping the rest', () => {
    const s = sanitizeSettings({ version: 5, frameRateLimit: 144, effects: 'minimal' });
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.frameRateLimit).toBe(144);
    expect(s.effects).toBe('minimal');
    expect(s).toMatchObject({
      backgroundMode: 'song',
      backgroundDim: 0.55,
      backgroundReduceMotion: false,
      backgroundQuality: 'high',
    });
  });

  it('keeps valid background settings and repairs invalid ones', () => {
    const ok = sanitizeSettings({
      version: 6,
      backgroundMode: 'style',
      backgroundStyle: 'aurora',
      backgroundDim: 0.3,
      backgroundReduceMotion: true,
      backgroundQuality: 'low',
    });
    expect(ok).toMatchObject({
      backgroundMode: 'song',
      backgroundDim: 0.3,
      backgroundReduceMotion: true,
      backgroundQuality: 'low',
    });
    const bad = sanitizeSettings({
      version: 6,
      backgroundMode: 'disco',
      backgroundStyle: 'image',
      backgroundDim: 5,
      backgroundReduceMotion: 'yes',
      backgroundQuality: 'ultra',
    });
    expect(bad).toMatchObject({
      backgroundMode: 'song',
      backgroundDim: 0.9,
      backgroundReduceMotion: false,
      backgroundQuality: 'high',
    });
  });

  it('migrates unversioned D F J K bindings through to the new defaults', () => {
    const s = sanitizeSettings({ keyBindings: { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 } });
    expect(s.laneKeys).toEqual(DEFAULT_LANE_KEYS);
  });
});

describe('scroll speed units', () => {
  it('steps by 0.1 and clamps to 1-10', () => {
    expect(stepScrollSpeed(3.5, 1)).toBe(3.6);
    expect(stepScrollSpeed(3.5, -1)).toBe(3.4);
    expect(stepScrollSpeed(10, 1)).toBe(10);
    expect(stepScrollSpeed(1, -1)).toBe(1);
    expect(clampScrollSpeed(0.3)).toBe(1);
    // Repeated float steps stay on the grid.
    let v = 1;
    for (let i = 0; i < 25; i++) v = stepScrollSpeed(v, 1);
    expect(v).toBe(3.5);
  });
});

describe('key bindings', () => {
  it('reserves Esc, Enter, F-keys, Tab and modifiers', () => {
    for (const code of ['Escape', 'Enter', 'NumpadEnter', 'F1', 'F4', 'F12', 'Tab', 'ShiftLeft']) {
      expect(isReservedKey(code)).toBe(true);
    }
    for (const code of ['KeyF', 'Space', 'Semicolon', 'Digit1', 'Numpad4']) {
      expect(isReservedKey(code)).toBe(false);
    }
  });

  it('rebinds a lane to a free key', () => {
    const r = rebindLane(DEFAULT_LANE_KEYS, 1, 'KeyG');
    expect(r).toEqual({ ok: true, keys: ['KeyS', 'KeyG', 'KeyJ', 'KeyK'] });
  });

  it('refuses a key already bound to another lane', () => {
    const r = rebindLane(DEFAULT_LANE_KEYS, 0, 'KeyJ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/lane 3/);
  });

  it('allows rebinding a lane to its own key', () => {
    expect(rebindLane(DEFAULT_LANE_KEYS, 2, 'KeyJ').ok).toBe(true);
  });

  it('refuses reserved keys', () => {
    const r = rebindLane(DEFAULT_LANE_KEYS, 0, 'F3');
    expect(r.ok).toBe(false);
  });

  it('builds the code -> lane table and labels', () => {
    expect(laneBindings(DEFAULT_LANE_KEYS)).toEqual({ KeyS: 0, KeyD: 1, KeyJ: 2, KeyK: 3 });
    expect(laneKeysLabel(DEFAULT_LANE_KEYS)).toBe('S D J K');
    expect(laneKeysLabel(['KeyA', 'Semicolon', 'Digit1', 'Space'])).toBe('A ; 1 SPACE');
    expect(keyLabel('KeyD')).toBe('D');
    expect(keyLabel('Digit7')).toBe('7');
    expect(keyLabel('Semicolon')).toBe(';');
    expect(keyLabel('Numpad5')).toBe('NUM5');
  });
});
