import { beatLengthMs, beatPulse, BEATS_PER_BAR, createBeatInfo } from './beat';
import { REST_LEVEL, motionSpeed } from './curves';
import type { EmitterConfig } from './emitter';
import {
  curveAt,
  lastImpactIndex,
  travelAt,
  type BackgroundAnalysis,
  type SongTiming,
} from './frame';
import { hash01 } from './hash';

/**
 * Particle positions (pure, closed form). Every particle is a function of the emitter's seed and
 * song time only: a continuous emitter runs each particle through fixed life cycles (every cycle
 * gets a new seeded start), and a burst emitter evaluates the bursts of the last few seconds from
 * the beat grid or the analysis' impacts. Nothing is integrated frame by frame, so seeking,
 * pausing, loops and practice speed changes always show the same particles for the same song
 * time. No allocation: everything is written into a caller's Float32Array.
 */

/** Floats per particle: x, y, size, alpha, angle, tint, emitter, glow. */
export const PARTICLE_STRIDE = 8;
export const P_X = 0;
export const P_Y = 1;
/** On-screen size of the sprite's longer side, render pixels. */
export const P_SIZE = 2;
export const P_ALPHA = 3;
/** Radians. */
export const P_ANGLE = 4;
export const P_TINT = 5;
export const P_EMITTER = 6;
/** 0-1: alpha of the glow drawn behind this particle. */
export const P_GLOW = 7;

/** Default cap on particles drawn at once (all emitters, trails included); quality lowers it. */
export const DEFAULT_PARTICLE_CAP = 600;
/** Sizes and speeds are given on the ~540-row gameplay grid. */
export const REFERENCE_HEIGHT = 540;
/** Tints an emitter coloured "from the base picture" picks from. */
export const IMAGE_TINTS = 4;
/** Steps of a gradient over the lifetime. */
export const GRADIENT_TINTS = 8;
/** Particles fade out this far (grid px) before the columns behind the lanes. */
export const FIELD_FADE_PX = 28;

/** How many tints the renderer prepares for an emitter (its tint indices run 0..n-1). */
export function tintCount(e: EmitterConfig): number {
  switch (e.colorMode) {
    case 'gradient':
      return GRADIENT_TINTS;
    case 'palette':
      return Math.max(1, e.palette.length);
    case 'image':
      return IMAGE_TINTS;
    default:
      return 1;
  }
}

export interface ParticleView {
  /** Render size in pixels. */
  w: number;
  h: number;
  /** The columns behind the lanes, 0-1 of the width (particles fade out there). */
  laneLeft: number;
  laneRight: number;
  /** Most particles written (the buffer may hold fewer). */
  cap: number;
}

// Salts for the independent random numbers of one particle.
const S_LIFE = 0x6a09e667;
const S_PHASE = 0x3c6ef372;
const S_X = 0x510e527f;
const S_Y = 0x1f83d9ab;
const S_EDGE = 0x5be0cd19;
const S_DIR = 0x0b5ad4ce;
const S_SPEED = 0x2c1b3c6d;
const S_SWAY = 0x297a2d39;
const S_ROT = 0x7b54a41d;
const S_SIZE = 0x4ed8aa4a;
const S_TINT = 0x391c0cb3;
const S_COUNT = 0x748f82ee;
const S_FLICKER = 0x78a5636f;

const TAU = Math.PI * 2;
const scratchBeat = createBeatInfo();

/** Per-frame values shared by every particle of an emitter (reused, no allocation). */
interface EmitterFrame {
  e: EmitterConfig;
  seed: number;
  emitter: number;
  px: number;
  w: number;
  h: number;
  songMs: number;
  /** 0-1 share of particles shown (activity reactivity). */
  countFrac: number;
  sizeMul: number;
  /** Beat pulse 0-1 now (pulse curves). */
  pulse: number;
  fieldL: number;
  fieldR: number;
  tints: number;
}

const frame: EmitterFrame = {
  e: null as unknown as EmitterConfig,
  seed: 0,
  emitter: 0,
  px: 1,
  w: 1,
  h: 1,
  songMs: 0,
  countFrac: 1,
  sizeMul: 1,
  pulse: 0,
  fieldL: 0,
  fieldR: 0,
  tints: 1,
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Write one particle (and before it, its trail) into `out` at entry `k`; returns the next free
 * entry. `key` identifies the particle's current life (its randoms), `age` and `life` are in
 * seconds of the emitter's clock, `speedScale` multiplies its speed.
 */
function emit(
  f: EmitterFrame,
  key: number,
  index: number,
  layer: number,
  age: number,
  life: number,
  speedScale: number,
  out: Float32Array,
  k: number,
  max: number,
): number {
  const e = f.e;
  const s = f.seed;
  // Activity reactivity thins the particles; a soft edge avoids popping.
  const keep = (f.countFrac - hash01(s ^ S_COUNT, index)) / 0.08;
  if (keep <= 0) return k;
  const px = f.px;
  const w = f.w;
  const h = f.h;
  const cx = w / 2;
  const cy = h / 2;
  const margin = 12 * px;

  // Spawn point.
  let x0: number;
  let y0: number;
  const ra = hash01(s ^ S_X, key);
  const rb = hash01(s ^ S_Y, key);
  switch (e.spawn) {
    case 'edges': {
      const d = e.direction;
      if (d === 'up') {
        x0 = ra * w;
        y0 = h + margin;
      } else if (d === 'down') {
        x0 = ra * w;
        y0 = -margin;
      } else if (d === 'left') {
        x0 = w + margin;
        y0 = rb * h;
      } else if (d === 'right') {
        x0 = -margin;
        y0 = rb * h;
      } else {
        // Anywhere on the border.
        const p = hash01(s ^ S_EDGE, key) * 2 * (w + h);
        if (p < w) {
          x0 = p;
          y0 = -margin;
        } else if (p < 2 * w) {
          x0 = p - w;
          y0 = h + margin;
        } else if (p < 2 * w + h) {
          x0 = -margin;
          y0 = p - 2 * w;
        } else {
          x0 = w + margin;
          y0 = p - 2 * w - h;
        }
      }
      break;
    }
    case 'center': {
      const a = ra * TAU;
      const r = rb * 0.06 * h;
      x0 = cx + Math.cos(a) * r;
      y0 = cy + Math.sin(a) * r;
      break;
    }
    case 'band':
      x0 = ra * w;
      y0 = (e.bandY + (rb - 0.5) * e.bandHeight) * h;
      break;
    case 'ring': {
      const a = ra * TAU;
      const r = (e.ringRadius * h) / 2 + (rb - 0.5) * 0.04 * h;
      x0 = cx + Math.cos(a) * r;
      y0 = cy + Math.sin(a) * r;
      break;
    }
    default:
      x0 = ra * (w + 2 * margin) - margin;
      y0 = rb * (h + 2 * margin) - margin;
  }

  // Direction.
  const rd = hash01(s ^ S_DIR, key);
  let dx: number;
  let dy: number;
  const jitter = (rd - 0.5) * 0.3;
  switch (e.direction) {
    case 'up':
      dx = Math.sin(jitter);
      dy = -Math.cos(jitter);
      break;
    case 'down':
      dx = Math.sin(jitter);
      dy = Math.cos(jitter);
      break;
    case 'left':
      dx = -Math.cos(jitter);
      dy = Math.sin(jitter);
      break;
    case 'right':
      dx = Math.cos(jitter);
      dy = Math.sin(jitter);
      break;
    case 'outward':
    case 'inward': {
      let vx = x0 - cx;
      let vy = y0 - cy;
      const len = Math.hypot(vx, vy);
      if (len < 1) {
        vx = Math.cos(rd * TAU);
        vy = Math.sin(rd * TAU);
      } else {
        vx /= len;
        vy /= len;
      }
      const sign = e.direction === 'outward' ? 1 : -1;
      dx = vx * sign;
      dy = vy * sign;
      break;
    }
    default:
      dx = Math.cos(rd * TAU);
      dy = Math.sin(rd * TAU);
  }

  const depthScale = layer === 0 ? 1 : e.layerScale ** layer;
  const depthSpeed = layer === 0 ? 1 : e.layerSpeed ** layer;
  const depthAlpha = layer === 0 ? 1 : e.layerOpacity ** layer;
  const v =
    (e.speedMin + (e.speedMax - e.speedMin) * hash01(s ^ S_SPEED, key)) *
    px *
    depthSpeed *
    speedScale;
  const g = e.gravity * px * depthSpeed;
  const swayA = e.swayAmp * px * depthSpeed;
  const swayW = TAU * e.swayFreq;
  const swayPhase = hash01(s ^ S_SWAY, key) * TAU;
  const rotBase = hash01(s ^ S_ROT, key) * TAU;
  const size0 =
    (e.sizeMin + (e.sizeMax - e.sizeMin) * hash01(s ^ S_SIZE, key)) * px * depthScale * f.sizeMul;
  const tintRandom = hash01(s ^ S_TINT, key);
  const fieldFade = FIELD_FADE_PX * px;
  const glow = e.glow;
  const flicker =
    e.flicker > 0
      ? 1 - e.flicker * hash01(s ^ S_FLICKER, key + Math.floor(f.songMs / 70) * 977)
      : 1;
  const baseAlpha = e.opacity * depthAlpha * flicker * Math.min(1, keep);

  for (let t = e.trail; t >= 0; t--) {
    if (k >= max) return k;
    const a = age - (t * e.trailSpacingMs) / 1000;
    if (a < 0) continue;
    const fr = a / life;
    const sway = swayA * Math.sin(swayW * a + swayPhase);
    let x = x0 + dx * v * a - dy * sway;
    let y = y0 + dy * v * a + dx * sway + 0.5 * g * a * a;
    // Opacity over the lifetime.
    let alpha: number;
    if (e.opacityCurve === 'constant') alpha = Math.min(1, fr / 0.03, (1 - fr) / 0.03);
    else {
      alpha = Math.min(1, fr / 0.15, (1 - fr) / 0.3);
      if (e.opacityCurve === 'pulse') alpha *= 0.45 + 0.55 * f.pulse;
    }
    let sizeK = 1;
    if (e.sizeCurve === 'grow') sizeK = 0.4 + 0.6 * fr;
    else if (e.sizeCurve === 'shrink') sizeK = 1 - 0.7 * fr;
    else if (e.sizeCurve === 'pulse') sizeK = 1 + 0.35 * f.pulse;
    let size = size0 * sizeK;
    if (t > 0) {
      alpha *= (1 - t / (e.trail + 1)) * 0.7;
      size *= 1 - 0.1 * t;
    }
    // Fade out before the columns behind the lanes (the notes stay readable).
    const half = size / 2;
    const dist = x < f.fieldL ? f.fieldL - x - half : x > f.fieldR ? x - f.fieldR - half : -1;
    alpha *= clamp01(dist / fieldFade);
    alpha *= baseAlpha;
    if (alpha <= 0.004 || size <= 0.25) continue;
    if (x < -size * 2 || x > w + size * 2 || y < -size * 2 || y > h + size * 2) continue;
    if (e.snap) {
      x = Math.round(x / px) * px;
      y = Math.round(y / px) * px;
    }
    let angle = 0;
    switch (e.rotation) {
      case 'fixed':
        angle = (e.angle * Math.PI) / 180 + (e.spin * Math.PI * a) / 180;
        break;
      case 'random':
        angle = rotBase + (e.spin * Math.PI * a) / 180;
        break;
      case 'velocity': {
        const vx = dx * v - dy * swayA * swayW * Math.cos(swayW * a + swayPhase);
        const vy = dy * v + dx * swayA * swayW * Math.cos(swayW * a + swayPhase) + g * a;
        angle = Math.atan2(vy, vx) + Math.PI / 2 + (e.angle * Math.PI) / 180;
        break;
      }
      default:
        break;
    }
    let tint = 0;
    if (f.tints > 1) {
      tint =
        e.colorMode === 'gradient'
          ? Math.round(clamp01(fr) * (f.tints - 1))
          : Math.min(f.tints - 1, Math.floor(tintRandom * f.tints));
    }
    const o = k * PARTICLE_STRIDE;
    out[o + P_X] = x;
    out[o + P_Y] = y;
    out[o + P_SIZE] = size;
    out[o + P_ALPHA] = Math.min(1, alpha);
    out[o + P_ANGLE] = angle;
    out[o + P_TINT] = tint;
    out[o + P_EMITTER] = f.emitter;
    out[o + P_GLOW] = t === 0 ? glow : glow * 0.5;
    k++;
  }
  return k;
}

/** Continuous emission: `count` particles cycling through their lives. */
function continuous(
  f: EmitterFrame,
  clock: number,
  out: Float32Array,
  k: number,
  max: number,
): number {
  const e = f.e;
  const layers = e.layers;
  const n = e.count;
  for (let layer = layers - 1; layer >= 0 && k < max; layer--) {
    for (let i = layer; i < n && k < max; i += layers) {
      const life = e.lifeMin + (e.lifeMax - e.lifeMin) * hash01(f.seed ^ S_LIFE, i);
      const u = clock + hash01(f.seed ^ S_PHASE, i) * life;
      const cycle = Math.floor(u / life);
      const age = u - cycle * life;
      k = emit(f, i + cycle * 65537, i, layer, age, life, 1, out, k, max);
    }
  }
  return k;
}

/** Burst emission: `count` particles per event, for the events of the last `lifeMax` seconds. */
function bursts(
  f: EmitterFrame,
  prep: BackgroundAnalysis | null,
  timing: SongTiming,
  out: Float32Array,
  k: number,
  max: number,
): number {
  const e = f.e;
  const songMs = f.songMs;
  const windowMs = e.lifeMax * 1000;
  const r = e.reactivity;
  const impacts = e.emission === 'impact' ? (prep?.analysis.impacts ?? null) : null;
  if (e.emission === 'impact' && !impacts) return k;
  const period = beatLengthMs(timing.bpm) * (e.emission === 'downbeat' ? BEATS_PER_BAR : 1);
  const lastBeat = Math.floor((songMs - timing.offsetMs) / period);
  const lastImpact = impacts ? lastImpactIndex(impacts, songMs) : -1;
  for (let back = 0; k < max; back++) {
    let t: number;
    let strength: number;
    let id: number;
    if (impacts) {
      const idx = lastImpact - back;
      if (idx < 0) break;
      const imp = impacts[idx];
      if (!imp) break;
      t = imp.t;
      strength = imp.strength;
      id = idx;
    } else {
      id = lastBeat - back;
      t = timing.offsetMs + id * period;
      strength =
        e.emission === 'beat' && ((id % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR !== 0
          ? 0.8
          : 1;
    }
    const ageMs = songMs - t;
    if (ageMs > windowMs) break;
    if (ageMs < 0) continue;
    const n = Math.round(e.count * (1 - r + r * strength));
    const activity = prep ? curveAt(prep.analysis, prep.analysis.intensity, t) : REST_LEVEL;
    const speedScale = 1 - r + r * motionSpeed(activity);
    const base = id * 4099;
    for (let layer = e.layers - 1; layer >= 0 && k < max; layer--) {
      for (let i = layer; i < n && k < max; i += e.layers) {
        const key = base + i;
        const life = e.lifeMin + (e.lifeMax - e.lifeMin) * hash01(f.seed ^ S_LIFE, key);
        const age = ageMs / 1000;
        if (age >= life) continue;
        k = emit(f, key, i, layer, age, life, speedScale, out, k, max);
      }
    }
  }
  return k;
}

/**
 * Every visible particle of `emitters` at `songMs` for a `view.w`x`view.h` render, written into
 * `out` (PARTICLE_STRIDE floats each), emitters in order (later ones on top), deeper parallax
 * layers first. Returns the count (at most `view.cap` and what `out` holds). `songSeed` makes
 * each song's particles differ.
 */
export function particleState(
  emitters: readonly EmitterConfig[],
  songSeed: number,
  songMs: number,
  prep: BackgroundAnalysis | null,
  timing: SongTiming,
  view: ParticleView,
  out: Float32Array,
): number {
  const max = Math.min(view.cap, Math.floor(out.length / PARTICLE_STRIDE));
  const f = frame;
  f.px = view.h / REFERENCE_HEIGHT;
  f.w = view.w;
  f.h = view.h;
  f.songMs = songMs;
  f.fieldL = view.laneLeft * view.w;
  f.fieldR = view.laneRight * view.w;
  f.pulse = beatPulse(songMs, timing.bpm, timing.offsetMs, scratchBeat);
  const activity = prep
    ? Math.min(1, curveAt(prep.analysis, prep.analysis.intensity, songMs))
    : REST_LEVEL;
  let k = 0;
  for (let m = 0; m < emitters.length && k < max; m++) {
    const e = emitters[m];
    if (!e || !e.enabled || e.count <= 0 || e.opacity <= 0) continue;
    const r = e.reactivity;
    f.e = e;
    f.emitter = m;
    f.seed = (songSeed ^ Math.imul(e.seed + 1, 0x9e3779b1)) >>> 0;
    f.tints = tintCount(e);
    f.countFrac = 1 - r + r * Math.min(1, 0.25 + activity);
    f.sizeMul = 1 - r + r * (0.7 + 0.6 * activity);
    if (e.emission === 'continuous') {
      // The emitter's clock: plain seconds blended with travel (faster in intense parts).
      const clock = (1 - r) * (songMs / 1000) + r * travelAt(prep, songMs, 1);
      k = continuous(f, clock, out, k, max);
    } else {
      k = bursts(f, prep, timing, out, k, max);
    }
  }
  return k;
}
