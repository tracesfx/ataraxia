import { LIBRARY_SPRITE_IDS, type LibrarySpriteId } from './sprites';

/**
 * Particle emitters (Phase 21): the only animated part of a background. A song has up to
 * MAX_EMITTERS emitters, each with its own sprite, colours, motion and emission. Pure: the
 * config, its defaults, the ready-made templates an emitter can start from, and sanitising.
 * The particle maths (closed form from a seed and song time) is in particles.ts.
 */

export const MAX_EMITTERS = 4;

/** Custom sprites: at most this many per song, each a PNG of at most 64x64 and 256 KB. */
export const MAX_CUSTOM_SPRITES = 8;
export const MAX_SPRITE_SIZE = 64;
export const MAX_SPRITE_BYTES = 256 * 1024;

/** Library sprites by id; custom sprites (stored with the song) as `custom:<id>`. */
export const CUSTOM_SPRITE_PREFIX = 'custom:';

export const SCALE_MODES = ['pixel', 'fit'] as const;
export type ScaleMode = (typeof SCALE_MODES)[number];

export const COLOR_MODES = ['single', 'gradient', 'palette', 'image', 'accent'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
export const COLOR_MODE_LABELS: Readonly<Record<ColorMode, string>> = {
  single: 'One colour',
  gradient: 'Gradient over lifetime',
  palette: 'Random from a palette',
  image: 'From the base picture',
  accent: 'Theme accent',
};

export const OPACITY_CURVES = ['fade', 'constant', 'pulse'] as const;
export type OpacityCurve = (typeof OPACITY_CURVES)[number];
export const OPACITY_CURVE_LABELS: Readonly<Record<OpacityCurve, string>> = {
  fade: 'Fade in and out',
  constant: 'Constant',
  pulse: 'Pulse on the beat',
};

export const SIZE_CURVES = ['constant', 'grow', 'shrink', 'pulse'] as const;
export type SizeCurve = (typeof SIZE_CURVES)[number];
export const SIZE_CURVE_LABELS: Readonly<Record<SizeCurve, string>> = {
  constant: 'Constant',
  grow: 'Grow',
  shrink: 'Shrink',
  pulse: 'Pulse on the beat',
};

export const ROTATION_MODES = ['none', 'fixed', 'random', 'velocity'] as const;
export type RotationMode = (typeof ROTATION_MODES)[number];
export const ROTATION_LABELS: Readonly<Record<RotationMode, string>> = {
  none: 'None',
  fixed: 'Fixed angle',
  random: 'Random',
  velocity: 'Along the motion',
};

export const SPAWN_AREAS = ['screen', 'edges', 'center', 'band', 'ring'] as const;
export type SpawnArea = (typeof SPAWN_AREAS)[number];
export const SPAWN_LABELS: Readonly<Record<SpawnArea, string>> = {
  screen: 'Full screen',
  edges: 'Edges',
  center: 'Centre',
  band: 'Horizontal band',
  ring: 'Ring',
};

export const DIRECTIONS = ['up', 'down', 'left', 'right', 'outward', 'inward', 'drift'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const DIRECTION_LABELS: Readonly<Record<Direction, string>> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  outward: 'Outward from the centre',
  inward: 'Inward to the centre',
  drift: 'Random drift',
};

export const EMISSION_MODES = ['continuous', 'beat', 'downbeat', 'impact'] as const;
export type EmissionMode = (typeof EMISSION_MODES)[number];
export const EMISSION_LABELS: Readonly<Record<EmissionMode, string>> = {
  continuous: 'Continuous',
  beat: 'Burst on every beat',
  downbeat: 'Burst on downbeats',
  impact: 'Burst on impacts and drops',
};

export interface EmitterConfig {
  /** Stable within the song (for list keys). */
  id: string;
  name: string;
  enabled: boolean;
  /** Seeds every random choice of this emitter. */
  seed: number;

  // Sprite
  /** A LibrarySpriteId, or CUSTOM_SPRITE_PREFIX + a custom sprite id. */
  sprite: string;
  /** Pixel: whole multiples of the sprite's pixels (crisp); fit: any size. */
  scaleMode: ScaleMode;
  /** On-screen size of the sprite's longer side, in pixels of the ~540-row gameplay grid. */
  sizeMin: number;
  sizeMax: number;

  // Colour and opacity
  colorMode: ColorMode;
  /** #rrggbb: the colour (single), or the gradient's start. */
  color: string;
  /** #rrggbb: the gradient's end. */
  color2: string;
  /** 1-5 colours for 'palette'. */
  palette: string[];
  /** 0-1. */
  opacity: number;
  opacityCurve: OpacityCurve;
  sizeCurve: SizeCurve;
  /** 0-1: stepped random dimming. */
  flicker: number;

  // Rotation
  rotation: RotationMode;
  /** Degrees (fixed angle; an offset for 'along the motion'). */
  angle: number;
  /** Degrees per second (fixed and random), -720..720. */
  spin: number;

  // Life and emission
  /** Seconds. */
  lifeMin: number;
  lifeMax: number;
  /** Particles alive at once (continuous) or per burst. */
  count: number;
  emission: EmissionMode;

  // Spawn and motion
  spawn: SpawnArea;
  /** Band: centre (0 top - 1 bottom) and height (0-1 of the screen). */
  bandY: number;
  bandHeight: number;
  /** Ring: radius as 0-1 of half the screen height. */
  ringRadius: number;
  direction: Direction;
  /** Grid pixels per second. */
  speedMin: number;
  speedMax: number;
  /** Grid pixels per second squared, positive pulls down. */
  gravity: number;
  /** Sideways wobble: amplitude in grid pixels and frequency in Hz. */
  swayAmp: number;
  swayFreq: number;

  // Depth
  /** 1-3 parallax layers; each deeper layer multiplies size, speed and opacity. */
  layers: number;
  layerScale: number;
  layerSpeed: number;
  layerOpacity: number;

  // Extras
  /** Positions snap to whole grid pixels. */
  snap: boolean;
  /** 0-1: a pre-rendered soft glow added behind each sprite. */
  glow: number;
  /** 0-6 stepped afterimages, `trailSpacingMs` apart. */
  trail: number;
  trailSpacingMs: number;
  /** 0-1: the song's activity scales count, speed and size. */
  reactivity: number;
}

export const LIMITS = {
  size: [1, 64],
  life: [0.2, 20],
  count: [1, 600],
  speed: [0, 600],
  gravity: [-600, 600],
  swayAmp: [0, 80],
  swayFreq: [0, 4],
  spin: [-720, 720],
  angle: [-180, 180],
  trail: [0, 6],
  trailSpacingMs: [10, 200],
  layers: [1, 3],
  layerMult: [0.2, 1],
} as const;

export const TEMPLATE_IDS = ['dust', 'embers', 'petals', 'sparks'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const TEMPLATE_LABELS: Readonly<Record<TemplateId, string>> = {
  dust: 'Drifting dust',
  embers: 'Rising embers',
  petals: 'Falling petals',
  sparks: 'Beat sparks',
};

/** A plain emitter: a few soft dots drifting over the screen (not enabled until added). */
export function defaultEmitter(id = 'e1', seed = 1): EmitterConfig {
  return {
    id,
    name: 'Emitter',
    enabled: true,
    seed,
    sprite: 'dust',
    scaleMode: 'pixel',
    sizeMin: 3,
    sizeMax: 6,
    colorMode: 'single',
    color: '#d8e6f5',
    color2: '#62a0d8',
    palette: ['#d8e6f5', '#62a0d8', '#9c8cf0'],
    opacity: 0.7,
    opacityCurve: 'fade',
    sizeCurve: 'constant',
    flicker: 0,
    rotation: 'none',
    angle: 0,
    spin: 0,
    lifeMin: 4,
    lifeMax: 8,
    count: 60,
    emission: 'continuous',
    spawn: 'screen',
    bandY: 0.5,
    bandHeight: 0.3,
    ringRadius: 0.5,
    direction: 'drift',
    speedMin: 6,
    speedMax: 18,
    gravity: 0,
    swayAmp: 6,
    swayFreq: 0.2,
    layers: 1,
    layerScale: 0.6,
    layerSpeed: 0.6,
    layerOpacity: 0.6,
    snap: true,
    glow: 0,
    trail: 0,
    trailSpacingMs: 40,
    reactivity: 0.5,
  };
}

/** An emitter started from a template (inline defaults; there is no preset management). */
export function emitterFromTemplate(t: TemplateId, id: string, seed: number): EmitterConfig {
  const e = defaultEmitter(id, seed);
  e.name = TEMPLATE_LABELS[t];
  switch (t) {
    case 'dust':
      Object.assign(e, {
        sprite: 'dust',
        sizeMin: 2,
        sizeMax: 5,
        color: '#d8e6f5',
        opacity: 0.55,
        count: 90,
        direction: 'drift',
        speedMin: 4,
        speedMax: 14,
        swayAmp: 8,
        swayFreq: 0.15,
        layers: 2,
        flicker: 0.15,
      } satisfies Partial<EmitterConfig>);
      break;
    case 'embers':
      Object.assign(e, {
        sprite: 'ember',
        sizeMin: 3,
        sizeMax: 7,
        colorMode: 'gradient',
        color: '#ffd27a',
        color2: '#e8553a',
        opacity: 0.85,
        count: 110,
        lifeMin: 3,
        lifeMax: 6,
        spawn: 'edges',
        direction: 'up',
        speedMin: 40,
        speedMax: 90,
        gravity: -6,
        swayAmp: 10,
        swayFreq: 0.35,
        flicker: 0.35,
        glow: 0.6,
        layers: 2,
        reactivity: 0.8,
      } satisfies Partial<EmitterConfig>);
      break;
    case 'petals':
      Object.assign(e, {
        sprite: 'petal',
        sizeMin: 6,
        sizeMax: 11,
        colorMode: 'palette',
        palette: ['#ffc2d6', '#ff9ec0', '#fff0f5'],
        opacity: 0.9,
        count: 45,
        lifeMin: 8,
        lifeMax: 12,
        spawn: 'screen',
        direction: 'down',
        speedMin: 22,
        speedMax: 45,
        swayAmp: 24,
        swayFreq: 0.3,
        rotation: 'random',
        spin: 90,
        layers: 3,
        reactivity: 0.3,
      } satisfies Partial<EmitterConfig>);
      break;
    case 'sparks':
      Object.assign(e, {
        sprite: 'spark',
        sizeMin: 4,
        sizeMax: 8,
        colorMode: 'accent',
        opacity: 1,
        count: 26,
        lifeMin: 0.5,
        lifeMax: 1,
        emission: 'beat',
        spawn: 'ring',
        ringRadius: 0.9,
        direction: 'outward',
        speedMin: 50,
        speedMax: 150,
        gravity: 60,
        swayAmp: 0,
        rotation: 'velocity',
        sizeCurve: 'shrink',
        glow: 0.8,
        trail: 3,
        trailSpacingMs: 30,
        reactivity: 0.6,
      } satisfies Partial<EmitterConfig>);
      break;
  }
  return e;
}

// --- Sanitising --------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

export function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
export function int(v: unknown, min: number, max: number, fallback: number): number {
  return Math.round(num(v, min, max, fallback));
}
export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
export function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}
export function colour(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
}
function text(v: unknown, max: number, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : fallback;
}

export function isLibrarySprite(id: string): id is LibrarySpriteId {
  return (LIBRARY_SPRITE_IDS as readonly string[]).includes(id);
}

function spriteRef(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  if (isLibrarySprite(v)) return v;
  if (
    v.startsWith(CUSTOM_SPRITE_PREFIX) &&
    /^[\w-]{1,64}$/.test(v.slice(CUSTOM_SPRITE_PREFIX.length))
  )
    return v;
  return fallback;
}

/** Ordered pair: min <= max. */
function pair(
  rawMin: unknown,
  rawMax: unknown,
  lo: number,
  hi: number,
  d: [number, number],
): [number, number] {
  const a = num(rawMin, lo, hi, d[0]);
  const b = num(rawMax, lo, hi, d[1]);
  return a <= b ? [a, b] : [b, a];
}

export function sanitizeEmitter(raw: unknown, index: number): EmitterConfig {
  const d = defaultEmitter(`e${index + 1}`, index + 1);
  const r = isRecord(raw) ? raw : {};
  const [sizeMin, sizeMax] = pair(r['sizeMin'], r['sizeMax'], ...LIMITS.size, [
    d.sizeMin,
    d.sizeMax,
  ]);
  const [lifeMin, lifeMax] = pair(r['lifeMin'], r['lifeMax'], ...LIMITS.life, [
    d.lifeMin,
    d.lifeMax,
  ]);
  const [speedMin, speedMax] = pair(r['speedMin'], r['speedMax'], ...LIMITS.speed, [
    d.speedMin,
    d.speedMax,
  ]);
  const paletteRaw = Array.isArray(r['palette']) ? r['palette'] : [];
  const palette = paletteRaw
    .slice(0, 5)
    .map((c) => colour(c, ''))
    .filter((c) => c !== '');
  const id = typeof r['id'] === 'string' && /^[\w-]{1,32}$/.test(r['id']) ? r['id'] : d.id;
  return {
    id,
    name: text(r['name'], 40, d.name),
    enabled: bool(r['enabled'], d.enabled),
    seed: int(r['seed'], 0, 0x7fffffff, d.seed),
    sprite: spriteRef(r['sprite'], d.sprite),
    scaleMode: oneOf(r['scaleMode'], SCALE_MODES, d.scaleMode),
    sizeMin,
    sizeMax,
    colorMode: oneOf(r['colorMode'], COLOR_MODES, d.colorMode),
    color: colour(r['color'], d.color),
    color2: colour(r['color2'], d.color2),
    palette: palette.length > 0 ? palette : d.palette,
    opacity: num(r['opacity'], 0, 1, d.opacity),
    opacityCurve: oneOf(r['opacityCurve'], OPACITY_CURVES, d.opacityCurve),
    sizeCurve: oneOf(r['sizeCurve'], SIZE_CURVES, d.sizeCurve),
    flicker: num(r['flicker'], 0, 1, d.flicker),
    rotation: oneOf(r['rotation'], ROTATION_MODES, d.rotation),
    angle: num(r['angle'], ...LIMITS.angle, d.angle),
    spin: num(r['spin'], ...LIMITS.spin, d.spin),
    lifeMin,
    lifeMax,
    count: int(r['count'], ...LIMITS.count, d.count),
    emission: oneOf(r['emission'], EMISSION_MODES, d.emission),
    spawn: oneOf(r['spawn'], SPAWN_AREAS, d.spawn),
    bandY: num(r['bandY'], 0, 1, d.bandY),
    bandHeight: num(r['bandHeight'], 0.02, 1, d.bandHeight),
    ringRadius: num(r['ringRadius'], 0.05, 1.5, d.ringRadius),
    direction: oneOf(r['direction'], DIRECTIONS, d.direction),
    speedMin,
    speedMax,
    gravity: num(r['gravity'], ...LIMITS.gravity, d.gravity),
    swayAmp: num(r['swayAmp'], ...LIMITS.swayAmp, d.swayAmp),
    swayFreq: num(r['swayFreq'], ...LIMITS.swayFreq, d.swayFreq),
    layers: int(r['layers'], ...LIMITS.layers, d.layers),
    layerScale: num(r['layerScale'], ...LIMITS.layerMult, d.layerScale),
    layerSpeed: num(r['layerSpeed'], ...LIMITS.layerMult, d.layerSpeed),
    layerOpacity: num(r['layerOpacity'], ...LIMITS.layerMult, d.layerOpacity),
    snap: bool(r['snap'], d.snap),
    glow: num(r['glow'], 0, 1, d.glow),
    trail: int(r['trail'], ...LIMITS.trail, d.trail),
    trailSpacingMs: int(r['trailSpacingMs'], ...LIMITS.trailSpacingMs, d.trailSpacingMs),
    reactivity: num(r['reactivity'], 0, 1, d.reactivity),
  };
}

/** Up to MAX_EMITTERS emitters with unique ids. */
export function sanitizeEmitters(raw: unknown): EmitterConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: EmitterConfig[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_EMITTERS)) {
    const e = sanitizeEmitter(item, out.length);
    let id = e.id;
    for (let k = 2; ids.has(id); k++) id = `${e.id}-${k}`;
    ids.add(id);
    out.push({ ...e, id });
  }
  return out;
}

/** A fresh emitter id not used in `list`. */
export function nextEmitterId(list: readonly EmitterConfig[]): string {
  const used = new Set(list.map((e) => e.id));
  for (let i = 1; ; i++) if (!used.has(`e${i}`)) return `e${i}`;
}
