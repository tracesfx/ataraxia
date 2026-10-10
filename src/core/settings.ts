import { isBackgroundMode, type BackgroundMode } from './background/precedence';
import { isQualityPreset, type QualityPreset } from './background/quality';
import { DEFAULT_DIM, clampDim } from './background/readability';
import type { Lane } from './chart';
import { LANE_COUNT } from './constants';
import { isFrameRateLimit, type FrameRateLimit } from './framePacing';

/**
 * Player settings: one versioned object, stored as JSON in localStorage by `src/ui/settingsStore`.
 * `sanitizeSettings` turns anything read back (missing, corrupt, old or hand-edited) into a valid
 * current-version object, falling back to the default field by field.
 */
export const SETTINGS_VERSION = 9;

/** Physical key (`KeyboardEvent.code`, layout independent) for each lane, left to right. */
export type LaneKeys = readonly [string, string, string, string];

export interface Settings {
  version: typeof SETTINGS_VERSION;
  /**
   * Player latency in ms, subtracted from every input time before judging (game, editor live
   * recording, calibration fine-tune). Someone who hits 30 ms late sets +30.
   */
  audioOffsetMs: number;
  /**
   * Scroll speed in the friendly unit shown to players (1.0-10.0). The default 3.5 takes about
   * 660 ms from the top of the screen to the hit line; see `scrollPxPerMs` in
   * src/render/fieldLayout.ts.
   */
  scrollSpeed: number;
  laneKeys: LaneKeys;
  /** Volumes 0-1. Master scales everything; music the song; hit sound the gameplay hit clicks. */
  masterVolume: number;
  musicVolume: number;
  hitSoundVolume: number;
  /** A short click on each judged hit during gameplay. */
  hitSounds: boolean;
  /** Timing numbers overlay during gameplay (F3 toggles it too). */
  debugOverlay: boolean;
  /** EARLY / LATE under non-Perfect judgements. */
  earlyLateIndicator: boolean;
  /** Time between choosing Resume in the pause menu and play continuing (one of RESUME_DELAYS_MS). */
  resumeDelayMs: number;
  /** Silent lead before a practice loop or a "playtest from here" start (one of RUN_IN_TIMES_MS). */
  runInMs: number;
  /** Menu pixel size: device pixels per art pixel, or 'auto' (picked from the window). */
  uiScale: UiScale;
  /** Frames-per-second counter in the corner of the screen. */
  showFps: boolean;
  /**
   * Gameplay effects: 'minimal' softens the lane glow, drops the combo bump, shine, rainbow
   * animation and milestone pop, and draws judgements in the simple style.
   */
  effects: EffectsLevel;
  /** Lane glow strength on key press, 0 (off) to 2 (twice the default) (settings v9). */
  laneGlow: number;
  /** Combo digits change colour with the combo (settings v9); off keeps them steel white. */
  comboColors: boolean;
  /** Size of the score and accuracy in the top-right corner (settings v9). */
  hudSize: HudSize;
  /** Judgement text: 'full' rises into place (a miss shakes), 'simple' only fades (v9). */
  judgementStyle: JudgementStyle;
  /** Signed timing error ("+60", "-34") floating up from the hit line on judged hits. */
  timingParticles: boolean;
  /** Smallest absolute timing error (ms) that shows a particle (0-120). */
  timingParticleThresholdMs: number;
  timingParticleSize: ParticleSize;
  /** Gameplay frame rate: match the display, a cap in fps, or unlimited (core/framePacing). */
  frameRateLimit: FrameRateLimit;
  /**
   * Gameplay background (settings v6, v7): the song's own (default), only its cover, the
   * player's custom picture (stored in IndexedDB), or off. See core/background/precedence.ts.
   */
  backgroundMode: BackgroundMode;
  /**
   * The player's dim, 0-0.9. The default (55 %) leaves each song's own dim as it is; above or
   * below it darkens or lightens every song by the difference.
   */
  backgroundDim: number;
  /** No background particles (the only moving part of a background). */
  backgroundReduceMotion: boolean;
  /** Render scale and particle cap (dropped automatically if a background gets too slow). */
  backgroundQuality: QualityPreset;
}

export type EffectsLevel = 'full' | 'minimal';
export const EFFECTS_LEVELS: readonly EffectsLevel[] = ['full', 'minimal'];
export const LANE_GLOW_MIN = 0;
export const LANE_GLOW_MAX = 2;
export const LANE_GLOW_STEP = 0.1;

/** Round a lane glow strength to the 0.1 grid and clamp it to 0-2 (the default for junk). */
export function clampLaneGlow(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(LANE_GLOW_MAX, Math.max(LANE_GLOW_MIN, Math.round(value * 10) / 10));
}

export type HudSize = 'small' | 'medium' | 'large';
export const HUD_SIZES: readonly HudSize[] = ['small', 'medium', 'large'];
export type JudgementStyle = 'full' | 'simple';
export const JUDGEMENT_STYLES: readonly JudgementStyle[] = ['full', 'simple'];
export type ParticleSize = 'small' | 'medium' | 'large';
export const PARTICLE_SIZES: readonly ParticleSize[] = ['small', 'medium', 'large'];
export const PARTICLE_THRESHOLD_MIN_MS = 0;
export const PARTICLE_THRESHOLD_MAX_MS = 120;
/** Threshold presets: every hit, anything worse than Perfect, anything worse than Great. */
export const PARTICLE_THRESHOLD_PRESETS = [
  { id: 'all', label: 'All hits', ms: 0 },
  { id: 'perfect', label: 'Beyond Perfect', ms: 40 },
  { id: 'great', label: 'Beyond Great', ms: 80 },
] as const;
export const DEFAULT_PARTICLE_THRESHOLD_MS = 40;

export type UiScale = 'auto' | 1 | 2 | 3;
export const UI_SCALES: readonly UiScale[] = ['auto', 1, 2, 3];

export const AUDIO_OFFSET_MIN_MS = -300;
export const AUDIO_OFFSET_MAX_MS = 300;
export const SCROLL_SPEED_MIN = 1;
export const SCROLL_SPEED_MAX = 10;
export const SCROLL_SPEED_STEP = 0.1;
export const DEFAULT_SCROLL_SPEED = 3.5;
/** Pre-versioning settings stored px/ms on the old 270-row grid; one friendly unit was 0.1 px/ms. */
export const SCROLL_PX_PER_MS_PER_UNIT = 0.1;
export const DEFAULT_LANE_KEYS: LaneKeys = ['KeyS', 'KeyD', 'KeyJ', 'KeyK'];
/** The defaults before settings version 2. Saved bindings equal to these move to the new ones. */
export const LEGACY_DEFAULT_LANE_KEYS: LaneKeys = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
/** Resume delay choices (0 resumes instantly). */
export const RESUME_DELAYS_MS = [0, 500, 1000, 2000, 3000] as const;
export const DEFAULT_RESUME_DELAY_MS = 1000;
/** Run-in time choices. */
export const RUN_IN_TIMES_MS = [0, 500, 1000, 1500, 2000, 3000] as const;
export const DEFAULT_RUN_IN_MS = 1500;

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    audioOffsetMs: 0,
    scrollSpeed: DEFAULT_SCROLL_SPEED,
    laneKeys: DEFAULT_LANE_KEYS,
    masterVolume: 1,
    musicVolume: 1,
    hitSoundVolume: 0.6,
    hitSounds: false,
    debugOverlay: false,
    earlyLateIndicator: true,
    resumeDelayMs: DEFAULT_RESUME_DELAY_MS,
    runInMs: DEFAULT_RUN_IN_MS,
    uiScale: 'auto',
    showFps: false,
    effects: 'full',
    laneGlow: 1,
    comboColors: true,
    hudSize: 'large',
    judgementStyle: 'full',
    timingParticles: true,
    timingParticleThresholdMs: DEFAULT_PARTICLE_THRESHOLD_MS,
    timingParticleSize: 'medium',
    frameRateLimit: 'display',
    backgroundMode: 'song',
    backgroundDim: DEFAULT_DIM,
    backgroundReduceMotion: false,
    backgroundQuality: 'high',
  };
}

// --- Units -----------------------------------------------------------------------------------

/** Round to the 0.1 grid and clamp to 1.0-10.0. */
export function clampScrollSpeed(friendly: number): number {
  const stepped = Math.round(friendly * 10) / 10;
  return Math.min(SCROLL_SPEED_MAX, Math.max(SCROLL_SPEED_MIN, stepped));
}

/** One 0.1 step faster (`direction` 1) or slower (-1), clamped. */
export function stepScrollSpeed(friendly: number, direction: 1 | -1): number {
  return clampScrollSpeed(friendly + direction * SCROLL_SPEED_STEP);
}

/** Round and clamp a particle threshold to 0-120 ms (the default for anything invalid). */
export function particleThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PARTICLE_THRESHOLD_MS;
  return Math.min(
    PARTICLE_THRESHOLD_MAX_MS,
    Math.max(PARTICLE_THRESHOLD_MIN_MS, Math.round(value)),
  );
}

export function clampAudioOffset(ms: number): number {
  return Math.min(AUDIO_OFFSET_MAX_MS, Math.max(AUDIO_OFFSET_MIN_MS, Math.round(ms)));
}

// --- Key bindings ----------------------------------------------------------------------------

/** Keys that the menus and pause need, or that browsers reserve: never lane keys. */
export function isReservedKey(code: string): boolean {
  return (
    /^F\d{1,2}$/.test(code) ||
    code === 'Escape' ||
    code === 'Enter' ||
    code === 'NumpadEnter' ||
    code === 'Tab' ||
    /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(code) ||
    code === 'ContextMenu' ||
    code === 'CapsLock'
  );
}

/** Lookup table `code -> lane` for the input handlers. */
export function laneBindings(keys: LaneKeys): Record<string, Lane> {
  const out: Record<string, Lane> = {};
  keys.forEach((code, lane) => {
    out[code] = lane as Lane;
  });
  return out;
}

/** All lane keys as one label for help texts ("S D J K"). */
export function laneKeysLabel(keys: LaneKeys): string {
  return keys.map(keyLabel).join(' ');
}

/** Short label for a key code, for HUD and settings ("KeyD" -> "D", "Semicolon" -> ";"). */
export function keyLabel(code: string): string {
  const named: Record<string, string> = {
    Space: 'SPACE',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
    ArrowLeft: 'LEFT',
    ArrowRight: 'RIGHT',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
  };
  if (named[code]) return named[code];
  return code.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'NUM');
}

export type RebindResult = { ok: true; keys: LaneKeys } | { ok: false; error: string };

/**
 * Bind `code` to `lane`. Refused for reserved keys and for a key another lane already uses
 * (the player must free it first); binding a lane to its own key again is a no-op.
 */
export function rebindLane(keys: LaneKeys, lane: Lane, code: string): RebindResult {
  if (isReservedKey(code)) {
    return {
      ok: false,
      error: `${keyLabel(code)} is reserved for menus. Choose a letter, number or symbol key.`,
    };
  }
  const other = keys.findIndex((k, i) => k === code && i !== lane);
  if (other >= 0) {
    return {
      ok: false,
      error: `${keyLabel(code)} is already bound to lane ${other + 1}. Rebind that lane first.`,
    };
  }
  const next = [...keys] as [string, string, string, string];
  next[lane] = code;
  return { ok: true, keys: next };
}

// --- Sanitising and migration ----------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function volume(value: unknown, fallback: number): number {
  const n = finite(value);
  return n === null || n < 0 || n > 1 ? fallback : n;
}

/** `value` if it is one of `choices`, else the fallback. */
function choice(value: unknown, choices: readonly number[], fallback: number): number {
  return typeof value === 'number' && choices.includes(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function validLaneKeys(value: unknown): LaneKeys | null {
  if (!Array.isArray(value) || value.length !== LANE_COUNT) return null;
  if (!value.every((k): k is string => typeof k === 'string' && k.length > 0)) return null;
  if (new Set(value).size !== LANE_COUNT || value.some(isReservedKey)) return null;
  return [value[0], value[1], value[2], value[3]] as LaneKeys;
}

/**
 * Settings before versioning (version 0): the in-memory `PlaySettings` shape of phases 1-4,
 * `{ scrollSpeed: px/ms, keyBindings: { code: lane } }`. Converted to version 1 fields.
 */
function migrateV0(raw: Raw): Raw {
  const out: Raw = { ...raw, version: 1 };
  const px = finite(raw.scrollSpeed);
  out.scrollSpeed = px === null ? undefined : px / SCROLL_PX_PER_MS_PER_UNIT;
  if (isRecord(raw.keyBindings)) {
    const keys: (string | undefined)[] = Array.from({ length: LANE_COUNT }, () => undefined);
    for (const [code, lane] of Object.entries(raw.keyBindings)) {
      if (typeof lane === 'number' && Number.isInteger(lane) && lane >= 0 && lane < LANE_COUNT) {
        keys[lane] ??= code;
      }
    }
    out.laneKeys = keys;
  }
  delete out.keyBindings;
  return out;
}

/**
 * Version 1 -> 2: the default lane keys changed from D F J K to S D J K. Bindings still exactly
 * equal to the old defaults follow the new defaults; customised bindings are kept as they are.
 */
function migrateV1(raw: Raw): Raw {
  const out: Raw = { ...raw, version: 2 };
  const keys = raw.laneKeys;
  if (
    Array.isArray(keys) &&
    keys.length === LEGACY_DEFAULT_LANE_KEYS.length &&
    keys.every((k, i) => k === LEGACY_DEFAULT_LANE_KEYS[i])
  ) {
    out.laneKeys = [...DEFAULT_LANE_KEYS];
  }
  return out;
}

/** Version 2 -> 3: display settings (UI scale, FPS counter) added with their defaults. */
function migrateV2(raw: Raw): Raw {
  return { ...raw, version: 3, uiScale: 'auto', showFps: false };
}

/** Version 3 -> 4: gameplay effects level and timing particles added with their defaults. */
function migrateV3(raw: Raw): Raw {
  const d = defaultSettings();
  return {
    ...raw,
    version: 4,
    effects: d.effects,
    timingParticles: d.timingParticles,
    timingParticleThresholdMs: d.timingParticleThresholdMs,
    timingParticleSize: d.timingParticleSize,
  };
}

/** Version 4 -> 5: gameplay frame rate added (matching the display, as before). */
function migrateV4(raw: Raw): Raw {
  return { ...raw, version: 5, frameRateLimit: defaultSettings().frameRateLimit };
}

/** Version 5 -> 6: gameplay background settings added with their defaults. */
function migrateV5(raw: Raw): Raw {
  const d = defaultSettings();
  return {
    ...raw,
    version: 6,
    backgroundMode: d.backgroundMode,
    backgroundStyle: 'pulse',
    backgroundDim: d.backgroundDim,
    backgroundReactivity: 1,
    backgroundReduceMotion: d.backgroundReduceMotion,
    backgroundQuality: d.backgroundQuality,
  };
}

/**
 * Version 6 -> 7 (Phase 20): the standalone background styles are gone. "Always use one style"
 * becomes "Cover only" when the style was the cover, else the song's background; the effects,
 * overlays and reduce flashing switches are added with their defaults.
 */
function migrateV6(raw: Raw): Raw {
  const out: Raw = {
    ...raw,
    version: 7,
    backgroundReduceFlashing: false,
    backgroundEffects: true,
    backgroundOverlays: true,
  };
  if (raw.backgroundMode === 'style') {
    out.backgroundMode = raw.backgroundStyle === 'cover' ? 'cover' : 'song';
  }
  delete out.backgroundStyle;
  return out;
}

/**
 * Version 7 -> 8 (Phase 21): backgrounds no longer follow the music with effects or flash, so the
 * reactivity, reduce flashing, effects and overlays settings are gone.
 */
function migrateV7(raw: Raw): Raw {
  const out: Raw = { ...raw, version: 8 };
  delete out.backgroundReactivity;
  delete out.backgroundReduceFlashing;
  delete out.backgroundEffects;
  delete out.backgroundOverlays;
  return out;
}

/**
 * Version 8 -> 9 (Phase 22): lane glow, combo colours, HUD size and judgement style with their
 * defaults.
 */
function migrateV8(raw: Raw): Raw {
  const d = defaultSettings();
  return {
    ...raw,
    version: 9,
    laneGlow: d.laneGlow,
    comboColors: d.comboColors,
    hudSize: d.hudSize,
    judgementStyle: d.judgementStyle,
  };
}

/** `MIGRATIONS[v]` upgrades a raw version-v object to version v + 1. */
const MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
  0: migrateV0,
  1: migrateV1,
  2: migrateV2,
  3: migrateV3,
  4: migrateV4,
  5: migrateV5,
  6: migrateV6,
  7: migrateV7,
  8: migrateV8,
};

/**
 * Any stored value -> valid current settings. Old versions are migrated step by step; each
 * field that is missing or out of range falls back to its default (the rest are kept). A newer
 * version than this build knows (or anything that isn't an object) gives the defaults.
 */
export function sanitizeSettings(input: unknown): Settings {
  const d = defaultSettings();
  if (!isRecord(input)) return d;
  let raw = input;
  let version = input.version === undefined ? 0 : finite(input.version);
  if (version === null || !Number.isInteger(version) || version < 0) return d;
  if (version > SETTINGS_VERSION) return d;
  while (version < SETTINGS_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return d;
    raw = step(raw);
    version += 1;
  }

  const offset = finite(raw.audioOffsetMs);
  const speed = finite(raw.scrollSpeed);
  return {
    version: SETTINGS_VERSION,
    audioOffsetMs:
      offset === null || offset < AUDIO_OFFSET_MIN_MS || offset > AUDIO_OFFSET_MAX_MS
        ? d.audioOffsetMs
        : Math.round(offset),
    scrollSpeed:
      speed === null || speed < SCROLL_SPEED_MIN - 1e-9 || speed > SCROLL_SPEED_MAX + 1e-9
        ? d.scrollSpeed
        : clampScrollSpeed(speed),
    laneKeys: validLaneKeys(raw.laneKeys) ?? d.laneKeys,
    masterVolume: volume(raw.masterVolume, d.masterVolume),
    musicVolume: volume(raw.musicVolume, d.musicVolume),
    hitSoundVolume: volume(raw.hitSoundVolume, d.hitSoundVolume),
    hitSounds: bool(raw.hitSounds, d.hitSounds),
    debugOverlay: bool(raw.debugOverlay, d.debugOverlay),
    earlyLateIndicator: bool(raw.earlyLateIndicator, d.earlyLateIndicator),
    resumeDelayMs: choice(raw.resumeDelayMs, RESUME_DELAYS_MS, d.resumeDelayMs),
    runInMs: choice(raw.runInMs, RUN_IN_TIMES_MS, d.runInMs),
    uiScale: UI_SCALES.includes(raw.uiScale as UiScale) ? (raw.uiScale as UiScale) : d.uiScale,
    showFps: bool(raw.showFps, d.showFps),
    effects: EFFECTS_LEVELS.includes(raw.effects as EffectsLevel)
      ? (raw.effects as EffectsLevel)
      : d.effects,
    laneGlow: clampLaneGlow(raw.laneGlow),
    comboColors: bool(raw.comboColors, d.comboColors),
    hudSize: HUD_SIZES.includes(raw.hudSize as HudSize) ? (raw.hudSize as HudSize) : d.hudSize,
    judgementStyle: JUDGEMENT_STYLES.includes(raw.judgementStyle as JudgementStyle)
      ? (raw.judgementStyle as JudgementStyle)
      : d.judgementStyle,
    timingParticles: bool(raw.timingParticles, d.timingParticles),
    timingParticleThresholdMs: particleThreshold(raw.timingParticleThresholdMs),
    timingParticleSize: PARTICLE_SIZES.includes(raw.timingParticleSize as ParticleSize)
      ? (raw.timingParticleSize as ParticleSize)
      : d.timingParticleSize,
    frameRateLimit: isFrameRateLimit(raw.frameRateLimit) ? raw.frameRateLimit : d.frameRateLimit,
    backgroundMode: isBackgroundMode(raw.backgroundMode) ? raw.backgroundMode : d.backgroundMode,
    backgroundDim: clampDim(raw.backgroundDim, d.backgroundDim),
    backgroundReduceMotion: bool(raw.backgroundReduceMotion, d.backgroundReduceMotion),
    backgroundQuality: isQualityPreset(raw.backgroundQuality)
      ? raw.backgroundQuality
      : d.backgroundQuality,
  };
}
