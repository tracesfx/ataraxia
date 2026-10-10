/**
 * Background configuration (Phase 21): a static base (one of the song's pictures, its cover,
 * a solid colour or nothing) with a few image adjustments baked into it once, and up to four
 * particle emitters, the only animated part. Stored per song (IndexedDB, song packages) and
 * edited in the Studio; the player can override the base in Settings. Pure:
 * `sanitizeBackgroundConfig` turns anything read back (including the Phase 15 version 1 and
 * Phase 20 version 2 configs, migrated here) into a valid current config.
 */

import {
  bool,
  colour,
  defaultEmitter,
  int,
  num,
  oneOf,
  sanitizeEmitters,
  type EmitterConfig,
} from './emitter';
import { DEFAULT_DIM, clampDim } from './readability';

// --- Base -------------------------------------------------------------------------------------

/** What fills the screen: one of the song's pictures, its cover (blurred), a colour, nothing. */
export const BASE_KINDS = ['image', 'cover', 'solid', 'none'] as const;
export type BaseKind = (typeof BASE_KINDS)[number];
export const BASE_LABELS: Readonly<Record<BaseKind, string>> = {
  image: 'Image',
  cover: 'Cover',
  solid: 'Solid colour',
  none: 'None',
};

export const BASE_FITS = ['cover', 'contain'] as const;
export type BaseFit = (typeof BASE_FITS)[number];

/** Most background pictures one song keeps. */
export const MAX_BACKGROUND_IMAGES = 8;

export interface BaseConfig {
  kind: BaseKind;
  /** Which of the song's pictures (base 'image'); null or unknown: the first one. */
  imageId: string | null;
  /** #rrggbb for base 'solid'. */
  color: string;
  /** Cover: fill the screen, cropping; contain: show the whole picture on near-black. */
  fit: BaseFit;
  /** Dark layer over the background, 0-0.9 (the player's Dim setting shifts it). */
  dim: number;
  /**
   * Render at the gameplay pixel grid's resolution (smooth, then scaled up with the grid) instead
   * of the screen's.
   */
  pixelMatch: boolean;
}

// --- Baked image effects ---------------------------------------------------------------------

export const CHROMATIC_MODES = ['radial', 'horizontal'] as const;
export type ChromaticMode = (typeof CHROMATIC_MODES)[number];

/**
 * Adjustments baked once into the base picture (never per frame). Pixel amounts are given at
 * 1080 rows and scaled to the render size.
 */
export interface ImageEffects {
  /** Blur radius, 0-40 px. */
  blur: number;
  /** -1 to +1 stops. */
  exposure: number;
  /** 0-2 (0 grey, 1 unchanged, 2 double). */
  saturation: number;
  /** Channel split, 0-12 px. */
  chromatic: number;
  chromaticMode: ChromaticMode;
  /** 0-2: how much of the bright parts' glow is added back (0 off). */
  bloom: number;
  /** 0-1: brightness above which parts glow. */
  bloomThreshold: number;
  /** 0-1: how far the glow spreads. */
  bloomRadius: number;
}

export const EFFECT_LIMITS = {
  blur: [0, 40],
  exposure: [-1, 1],
  saturation: [0, 2],
  chromatic: [0, 12],
  bloom: [0, 2],
  bloomThreshold: [0, 1],
  bloomRadius: [0, 1],
} as const;

/** The cover base is always blurred at least this much (it is a small, square picture). */
export const COVER_MIN_BLUR = 16;

// --- Config -----------------------------------------------------------------------------------

/** 1: Phase 15 styles. 2: base, effects, overlays (Phase 20). 3: base, baked effects, emitters. */
export const BACKGROUND_CONFIG_VERSION = 3;

export interface BackgroundConfig {
  version: typeof BACKGROUND_CONFIG_VERSION;
  base: BaseConfig;
  effects: ImageEffects;
  emitters: EmitterConfig[];
}

export const DEFAULT_SOLID_COLOR = '#1b2433';

export function defaultBase(kind: BaseKind = 'cover'): BaseConfig {
  return {
    kind,
    imageId: null,
    color: DEFAULT_SOLID_COLOR,
    fit: 'cover',
    dim: DEFAULT_DIM,
    pixelMatch: true,
  };
}

export function defaultEffects(): ImageEffects {
  return {
    blur: 0,
    exposure: 0,
    saturation: 1,
    chromatic: 0,
    chromaticMode: 'radial',
    bloom: 0,
    bloomThreshold: 0.7,
    bloomRadius: 0.5,
  };
}

/** A fresh song: its cover, no adjustments, no particles. */
export function defaultBackgroundConfig(kind: BaseKind = 'cover'): BackgroundConfig {
  return {
    version: BACKGROUND_CONFIG_VERSION,
    base: defaultBase(kind),
    effects: defaultEffects(),
    emitters: [],
  };
}

// --- Sanitising and migration -----------------------------------------------------------------

type Raw = Record<string, unknown>;

const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

export function sanitizeEffects(raw: unknown): ImageEffects {
  const d = defaultEffects();
  const r = isRecord(raw) ? raw : {};
  const L = EFFECT_LIMITS;
  return {
    blur: num(r['blur'], ...L.blur, d.blur),
    exposure: num(r['exposure'], ...L.exposure, d.exposure),
    saturation: num(r['saturation'], ...L.saturation, d.saturation),
    chromatic: num(r['chromatic'], ...L.chromatic, d.chromatic),
    chromaticMode: oneOf(r['chromaticMode'], CHROMATIC_MODES, d.chromaticMode),
    bloom: num(r['bloom'], ...L.bloom, d.bloom),
    bloomThreshold: num(r['bloomThreshold'], ...L.bloomThreshold, d.bloomThreshold),
    bloomRadius: num(r['bloomRadius'], ...L.bloomRadius, d.bloomRadius),
  };
}

/**
 * An old particles overlay (versions 1-2: shape, count, size, speed, direction, gravity,
 * reactivity, colour) as emitter 1 with equivalent settings.
 */
function emitterFromOverlay(p: Raw): EmitterConfig {
  const e = defaultEmitter('e1', 1);
  e.name = 'Particles';
  const shape = p['shape'];
  e.sprite = shape === 'circle' ? 'circle' : shape === 'spark' ? 'streak' : 'square';
  e.count = int(p['count'], 10, 400, 90);
  const size = num(p['size'], 1, 8, 2);
  // Old sprites were filled squares of `size` px; new ones are a few pixels across.
  e.scaleMode = 'fit';
  e.sizeMin = Math.max(1, Math.round(size * 0.55));
  e.sizeMax = Math.max(e.sizeMin, Math.round(size));
  if (e.sprite === 'streak') {
    e.sizeMin *= 3;
    e.sizeMax *= 3;
    e.rotation = 'velocity';
  }
  const speed = num(p['speed'], 0.1, 3, 1);
  const direction =
    p['direction'] === 'down' ? 'down' : p['direction'] === 'outward' ? 'outward' : 'up';
  e.direction = direction;
  e.spawn = direction === 'outward' ? 'center' : 'edges';
  e.lifeMin = 3;
  e.lifeMax = 7;
  e.speedMin = Math.round((direction === 'outward' ? 110 : 90) * speed);
  e.speedMax = Math.round((direction === 'outward' ? 160 : 130) * speed);
  // Old gravity: -1 floats away, 1 falls back (relative to the motion).
  const g = num(p['gravity'], -1, 1, 0) * 190;
  e.gravity = Math.round(direction === 'down' ? -g : g);
  e.swayAmp = direction === 'outward' ? 0 : 8;
  e.swayFreq = 0.15;
  e.opacity = num(p['opacity'], 0, 1, 0.8);
  e.reactivity = num(p['reactivity'], 0, 1, 0.7);
  const c = p['color'];
  e.colorMode = c === 'accent' ? 'accent' : c === 'custom' ? 'single' : 'image';
  e.color = colour(p['customColor'], e.color);
  e.enabled = bool(p['enabled'], false);
  return e;
}

/**
 * Version 2 (Phase 20) -> 3. Kept: the base (image / cover / none, fit, pixel match, dim), blur
 * (its 0-1 amount as a radius), exposure (its amount in stops), saturation (where its amount
 * took the colour toward its target) and the particles overlay as emitter 1. Everything else
 * (the slow zoom, the other effects and their music bindings, the spectrum) is dropped.
 */
function migrateV2(r: Raw): Raw {
  const b = isRecord(r['base']) ? r['base'] : {};
  const fx = isRecord(r['effects']) ? r['effects'] : {};
  const effect = (id: string): Raw | null => {
    const e = fx[id];
    return isRecord(e) && e['enabled'] === true && typeof e['amount'] === 'number' ? e : null;
  };
  const effects = defaultEffects();
  const blur = effect('blur');
  if (blur) effects.blur = Math.round(num(blur['amount'], 0, 1, 0) * 24);
  const exposure = effect('exposure');
  if (exposure) effects.exposure = num(exposure['amount'], 0, 1, 0);
  const sat = effect('saturation');
  if (sat) {
    const params = isRecord(sat['params']) ? sat['params'] : {};
    const target = num(params['target'], 0, 2, 1.6);
    effects.saturation = 1 + num(sat['amount'], 0, 1, 0) * (target - 1);
  }
  const overlays = isRecord(r['overlays']) ? r['overlays'] : {};
  const particles = overlays['particles'];
  const emitters =
    isRecord(particles) && particles['enabled'] === true ? [emitterFromOverlay(particles)] : [];
  return {
    version: 3,
    base: {
      kind: b['kind'],
      fit: b['fit'],
      dim: b['dim'],
      pixelMatch: b['pixelMatch'],
    },
    effects,
    emitters,
  };
}

/**
 * Version 1 (Phase 15: one style with reactivity, speed and density, plus blur and pixel match
 * for pictures) -> 3. image / cover / none become the base; the procedural styles get the cover
 * as their base (they drew in the cover's colours; without a cover it resolves to none). The
 * particles style becomes emitter 1; the other styles are dropped.
 */
export function migrateV1(r: Raw): Raw | null {
  const style = r['style'];
  const styles = ['pulse', 'particles', 'ripples', 'aurora', 'spectrum', 'image', 'cover', 'none'];
  if (typeof style !== 'string' || !styles.includes(style)) return null;
  const p = isRecord(r['params']) ? r['params'] : {};
  const kind: BaseKind = style === 'image' ? 'image' : style === 'none' ? 'none' : 'cover';
  const effects = defaultEffects();
  if (style === 'image' && r['blur'] === true) effects.blur = 12;
  const emitters: EmitterConfig[] = [];
  if (style === 'particles') {
    const density = num(p['density'], 0, 1, 0.6);
    emitters.push(
      emitterFromOverlay({
        enabled: true,
        count: Math.round(40 + 160 * density),
        speed: num(p['speed'], 0.25, 2, 1),
        reactivity: num(p['reactivity'], 0, 1, 0.8),
        color: 'image',
      }),
    );
  }
  return {
    version: 3,
    base: { ...defaultBase(kind), pixelMatch: bool(r['pixelMatch'], true) },
    effects,
    emitters,
  };
}

/**
 * Anything stored or read from a package -> a valid current config, field by field; null when it
 * isn't a background config at all, or comes from a newer version than this build.
 */
export function sanitizeBackgroundConfig(raw: unknown): BackgroundConfig | null {
  if (!isRecord(raw)) return null;
  const version = raw['version'] ?? (raw['style'] !== undefined ? 1 : BACKGROUND_CONFIG_VERSION);
  if (typeof version !== 'number' || version > BACKGROUND_CONFIG_VERSION) return null;
  let r: Raw | null = raw;
  if (version < 2) r = migrateV1(raw);
  else if (version < 3) r = isRecord(raw['base']) ? migrateV2(raw) : null;
  if (!r || !isRecord(r['base'])) return null;
  const b = r['base'];
  const kind = oneOf(b['kind'], BASE_KINDS, 'cover');
  const db = defaultBase(kind);
  const imageId = b['imageId'];
  return {
    version: BACKGROUND_CONFIG_VERSION,
    base: {
      kind,
      imageId: typeof imageId === 'string' && /^[\w-]{1,64}$/.test(imageId) ? imageId : null,
      color: colour(b['color'], db.color),
      fit: oneOf(b['fit'], BASE_FITS, db.fit),
      dim: clampDim(b['dim'], db.dim),
      pixelMatch: bool(b['pixelMatch'], db.pixelMatch),
    },
    effects: sanitizeEffects(r['effects']),
    emitters: sanitizeEmitters(r['emitters']),
  };
}

/** Do two configs draw the same thing? */
export function sameBackgroundConfig(a: BackgroundConfig, b: BackgroundConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Names of the baked effects that are on. */
export function activeEffects(e: ImageEffects): string[] {
  const out: string[] = [];
  if (e.blur > 0) out.push('Blur');
  if (e.exposure !== 0) out.push('Exposure');
  if (e.saturation !== 1) out.push('Saturation');
  if (e.chromatic > 0) out.push('Chromatic aberration');
  if (e.bloom > 0) out.push('Bloom');
  return out;
}

/** Emitters that draw anything. */
export function activeEmitters(c: BackgroundConfig): EmitterConfig[] {
  return c.emitters.filter((e) => e.enabled && e.count > 0 && e.opacity > 0);
}

/** A short summary for lists ("Cover · Blur, Bloom · 2 emitters"). */
export function describeBackground(c: BackgroundConfig): string {
  const parts: string[] = [BASE_LABELS[c.base.kind]];
  const fx = activeEffects(c.effects);
  if (fx.length > 0 && c.base.kind !== 'none') parts.push(fx.join(', '));
  const n = activeEmitters(c).length;
  if (n > 0) parts.push(`${n} particle emitter${n === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** A stable 32-bit seed from text (FNV-1a), e.g. a song id, so each song's shapes stay put. */
export function seedFromText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
