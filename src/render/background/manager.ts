import type { AudioAnalysis } from '../../core/analysis/types';
import {
  COVER_MIN_BLUR,
  activeEmitters,
  type BackgroundConfig,
} from '../../core/background/config';
import type { EmitterConfig } from '../../core/background/emitter';
import {
  prepareBackgroundAnalysis,
  type BackgroundAnalysis,
  type SongTiming,
} from '../../core/background/frame';
import { containFitRect, coverFitRect, type SourceRect } from '../../core/background/image';
import type { RampSet } from '../../core/background/palette';
import {
  DEFAULT_PARTICLE_CAP,
  PARTICLE_STRIDE,
  P_ALPHA,
  P_ANGLE,
  P_EMITTER,
  P_GLOW,
  P_SIZE,
  P_TINT,
  P_X,
  P_Y,
  particleState,
  type ParticleView,
} from '../../core/background/particles';
import { AdaptiveQuality, QUALITY, type QualityPreset } from '../../core/background/quality';
import { DEFAULT_DIM, clampDim, readabilityLayers } from '../../core/background/readability';
import type { PixelLayout } from '../pixelScale';
import { FIELD_W, RAIL_W, type FieldLayout } from '../fieldLayout';
import type { BackgroundLayer, BackgroundView } from '../skin';
import { Baker, type BakeResponse } from './bakeJob';
import { coverScaled, ctx2d, type AnySource } from './pictures';
import { atlasKey, buildAtlas, type TintSources, type TintedSprite } from './spriteAtlas';

/** Where the background canvas goes in the game: behind the pixel canvas (see PixelCanvas). */
export interface BackdropHost {
  attachBackdrop(canvas: HTMLCanvasElement | null): void;
  readonly layout: Readonly<PixelLayout>;
}

export interface BackgroundManagerDeps {
  /** The skin's static layer: shown while a background is loading. */
  fallback: BackgroundLayer;
  ramps: RampSet;
  /** Colour of the dim (the darkest steel). */
  overlay: string;
  /**
   * The game's pixel canvas: the background canvas is placed behind it and the logical buffer is
   * left clear. Without one (Studio previews), the result is copied into the drawing context.
   */
  host?: BackdropHost | null;
  /** Canvas factory (tests can stub it). */
  createCanvas: (w: number, h: number) => HTMLCanvasElement;
  /** Clock for measuring the background's cost (performance.now). */
  now?: () => number;
}

export interface BackgroundOptions {
  /** The player's dim, 0-0.9: the default leaves each song's dim; above or below shifts it. */
  dim: number;
  /** Turns particles off. */
  reduceMotion: boolean;
  quality: QualityPreset;
  /** Expected frame interval (from the frame rate setting), so a capped frame rate isn't "slow". */
  frameMs: number;
}

export const DEFAULT_OPTIONS: BackgroundOptions = {
  dim: DEFAULT_DIM,
  reduceMotion: false,
  quality: 'high',
  frameMs: 1000 / 60,
};

/**
 * The gameplay background: implements the renderer's `BackgroundLayer` with Canvas 2D. The base
 * (picture, cover, colour or nothing) is fitted to the render size and its adjustments are baked
 * once in a worker (debounced; the unbaked picture shows meanwhile), then the dim and the lane
 * clamp are drawn over it into one cached bitmap. Each frame draws that bitmap and the particles
 * (closed form from song time, pre-tinted sprites); with no particles nothing is redrawn at all.
 * In the game the canvas sits behind the pixel canvas; in Studio previews the result is copied
 * into the given context. Quality drops automatically if the particles get too slow.
 */
export class BackgroundManager implements BackgroundLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Fitted base (before baking), the baked base, and the composed one (dim and clamp). */
  private fitted: HTMLCanvasElement;
  private baked: HTMLCanvasElement | null = null;
  private composed: HTMLCanvasElement;
  private brightest = '#ffffff';
  private imageTints: string[] = [];
  private config: BackgroundConfig | null = null;
  private picture: AnySource | null = null;
  private analysis: BackgroundAnalysis | null = null;
  private timing: SongTiming = { bpm: 120, offsetMs: 0 };
  private seed = 1;
  private options: BackgroundOptions = { ...DEFAULT_OPTIONS };
  private readonly adaptive: AdaptiveQuality;
  private readonly baker = new Baker();
  /** Ids of bake requests, and the one whose result is awaited (0: none). */
  private bakeSeq = 0;
  private pendingBake = 0;
  private bakeTimer: ReturnType<typeof setTimeout> | null = null;
  private bakeKey = '';
  private bakeShape = '';
  private customSprites: ReadonlyMap<string, AnySource> = new Map();
  private customKey = '';
  private atlas: (TintedSprite[] | null)[] = [];
  private currentAtlasKey = '';
  private emitters: EmitterConfig[] = [];
  private readonly particles = new Float32Array(DEFAULT_PARTICLE_CAP * PARTICLE_STRIDE);
  private readonly view: ParticleView = { w: 1, h: 1, laneLeft: 0.4, laneRight: 0.6, cap: 600 };
  private readonly rect: SourceRect = { x: 0, y: 0, w: 1, h: 1 };
  private w = 1;
  private h = 1;
  private laneLeft = 0.4;
  private laneRight = 0.6;
  private renderW = 0;
  private renderH = 0;
  private hostScale = 0;
  private dirty = true;
  private lastSongMs = Number.NaN;
  private lastVisual = Number.NaN;
  private readonly now: () => number;
  private readonly external: boolean;
  private bakedListener: (() => void) | null = null;
  /** CPU cost of the last redraw in ms, for the debug overlay. */
  lastCostMs = 0;
  /** Particles drawn in the last frame. */
  lastParticleCount = 0;

  constructor(private readonly deps: BackgroundManagerDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.adaptive = new AdaptiveQuality(this.options.quality);
    this.external = !!deps.host;
    this.canvas = deps.createCanvas(1, 1);
    this.canvas.classList.add('bg-canvas');
    this.ctx = ctx2d(this.canvas);
    this.fitted = deps.createCanvas(1, 1);
    this.composed = deps.createCanvas(1, 1);
  }

  /** '2d' (kept for the debug overlay). */
  get rendererKind(): string {
    return '2d';
  }

  /** The quality in use (after automatic drops). */
  get quality(): QualityPreset {
    return this.adaptive.current;
  }

  get qualityDrops(): number {
    return this.adaptive.drops;
  }

  /** What is on screen: the base kind, or 'loading' for the static layer. */
  get showing(): string {
    return this.config ? this.config.base.kind : 'loading';
  }

  /** True while the base's adjustments are still being baked. */
  get baking(): boolean {
    return this.bakeTimer !== null || this.pendingBake > 0;
  }

  /** Called whenever a bake lands (Studio previews, screenshots). */
  set onBaked(fn: (() => void) | null) {
    this.bakedListener = fn;
  }

  setSong(seed: number, timing: SongTiming): void {
    this.seed = seed;
    this.timing = { bpm: timing.bpm, offsetMs: timing.offsetMs };
    this.dirty = true;
  }

  setAnalysis(analysis: AudioAnalysis | null): void {
    this.analysis = analysis ? prepareBackgroundAnalysis(analysis) : null;
    this.dirty = true;
  }

  /** Custom sprites by id (decoded), for emitters using `custom:<id>`; `key` identifies the set. */
  setCustomSprites(sprites: ReadonlyMap<string, AnySource>, key: string): void {
    this.customSprites = sprites;
    this.customKey = key;
    this.install();
  }

  /** Show `config` with its base picture (null config: the static layer, while loading). */
  setBackground(config: BackgroundConfig | null, picture: AnySource | null = null): void {
    this.config = config;
    this.picture = picture;
    this.install();
  }

  setOptions(options: Partial<BackgroundOptions>): void {
    const next = { ...this.options, ...options };
    const qualityChanged = next.quality !== this.options.quality;
    const dimChanged = next.dim !== this.options.dim;
    this.options = next;
    if (qualityChanged) this.adaptive.reset(next.quality);
    this.adaptive.setFrameBudget(next.frameMs);
    if (dimChanged) this.compose();
    this.install();
  }

  resize(width: number, height: number, layout: FieldLayout): void {
    this.w = width;
    this.h = height;
    this.deps.fallback.resize(width, height, layout);
    const left = layout.fieldX - RAIL_W - 2;
    this.laneLeft = left / Math.max(1, width);
    this.laneRight = (left + FIELD_W + 2 * RAIL_W + 4) / Math.max(1, width);
    this.install();
  }

  /** Apply the config and options (cheap; on any change). */
  private install(): void {
    const c = this.config;
    this.emitters = c && !this.options.reduceMotion ? activeEmitters(c) : [];
    this.sizeRenderer();
    this.scheduleBake();
    this.updateAtlas();
    this.dirty = true;
  }

  /** Render size: the pixel grid (pixel match, or no host) or the screen, x quality. */
  private sizeRenderer(): void {
    const q = QUALITY[this.adaptive.current].renderScale;
    const host = this.deps.host;
    const pixelMatch = this.config?.base.pixelMatch ?? true;
    let w = this.w;
    let h = this.h;
    if (host && !pixelMatch) {
      w = host.layout.width * host.layout.scale;
      h = host.layout.height * host.layout.scale;
    }
    const rw = Math.max(1, Math.round(w * q));
    const rh = Math.max(1, Math.round(h * q));
    if (rw !== this.renderW || rh !== this.renderH) {
      this.renderW = rw;
      this.renderH = rh;
      this.canvas.width = rw;
      this.canvas.height = rh;
      this.composed.width = rw;
      this.composed.height = rh;
    }
    if (host) {
      this.canvas.style.imageRendering = pixelMatch ? 'pixelated' : 'auto';
      host.attachBackdrop(this.config ? this.canvas : null);
    }
  }

  // --- Base ----------------------------------------------------------------------------------

  private minBlur(): number {
    return this.config?.base.kind === 'cover' ? COVER_MIN_BLUR : 0;
  }

  /** Fit the base to the render size now and bake its adjustments (debounced) in the worker. */
  private scheduleBake(): void {
    const c = this.config;
    if (!c) return;
    const b = c.base;
    const pictureId = this.picture ? this.pictureId(this.picture) : 0;
    const shape = `${b.kind}|${pictureId}|${this.renderW}x${this.renderH}`;
    const key = JSON.stringify([shape, b.fit, b.color, c.effects, this.laneLeft, this.laneRight]);
    if (key === this.bakeKey) return;
    const sizeOrPictureChanged = shape !== this.bakeShape;
    this.bakeKey = key;
    this.bakeShape = shape;
    this.fit();
    if (b.kind === 'none' || (b.kind !== 'solid' && !this.picture)) {
      // Nothing to bake: the neutral vignette.
      this.cancelBake();
      this.baked = null;
      this.brightest = this.deps.ramps.steel[1] as string;
      this.imageTints = [];
      this.compose();
      return;
    }
    if (sizeOrPictureChanged) {
      // Show the new picture right away, unbaked, with the strictest clamp until the bake lands.
      this.baked = null;
      this.brightest = '#ffffff';
      this.compose();
    }
    if (this.bakeTimer !== null) clearTimeout(this.bakeTimer);
    const delay = this.baked ? 140 : 0;
    this.bakeTimer = setTimeout(() => {
      this.bakeTimer = null;
      this.startBake();
    }, delay);
  }

  private readonly pictureIds = new WeakMap<object, number>();
  private nextPictureId = 1;
  private pictureId(p: AnySource): number {
    let id = this.pictureIds.get(p);
    if (!id) {
      id = this.nextPictureId++;
      this.pictureIds.set(p, id);
    }
    return id;
  }

  private cancelBake(): void {
    if (this.bakeTimer !== null) clearTimeout(this.bakeTimer);
    this.bakeTimer = null;
    this.pendingBake = 0;
  }

  private startBake(): void {
    const c = this.config;
    if (!c) return;
    const w = this.renderW;
    const h = this.renderH;
    const data = ctx2d(this.fitted).getImageData(0, 0, w, h);
    const id = ++this.bakeSeq;
    this.pendingBake = id;
    this.baker.request(
      {
        id,
        w,
        h,
        pixels: data.data.buffer,
        effects: { ...c.effects },
        minBlur: this.minBlur(),
        laneLeft: this.laneLeft,
        laneRight: this.laneRight,
      },
      (res) => this.landBake(res, w, h),
      () => {
        // The worker failed with this job: bake again (on the main thread from now on).
        if (this.pendingBake !== id) return;
        this.pendingBake = 0;
        this.bakeKey = '';
        this.scheduleBake();
      },
    );
  }

  private landBake(res: BakeResponse, w: number, h: number): void {
    if (res.id !== this.pendingBake || w !== this.renderW || h !== this.renderH) return;
    this.pendingBake = 0;
    const baked = this.baked ?? this.deps.createCanvas(w, h);
    baked.width = w;
    baked.height = h;
    ctx2d(baked).putImageData(new ImageData(new Uint8ClampedArray(res.pixels), w, h), 0, 0);
    this.baked = baked;
    this.brightest = res.brightest;
    this.imageTints = res.tints;
    this.compose();
    this.updateAtlas();
    this.dirty = true;
    this.bakedListener?.();
  }

  /** The base fitted to the render size, unbaked. */
  private fit(): void {
    const c = this.config;
    const w = this.renderW;
    const h = this.renderH;
    this.fitted.width = w;
    this.fitted.height = h;
    const g = ctx2d(this.fitted);
    const steel = this.deps.ramps.steel;
    if (!c || c.base.kind === 'none' || (c.base.kind !== 'solid' && !this.picture)) {
      const v = g.createRadialGradient(
        w / 2,
        h * 0.45,
        0,
        w / 2,
        h * 0.45,
        Math.hypot(w, h) * 0.55,
      );
      v.addColorStop(0, steel[1] as string);
      v.addColorStop(1, steel[0] as string);
      g.fillStyle = v;
      g.fillRect(0, 0, w, h);
      return;
    }
    if (c.base.kind === 'solid') {
      g.fillStyle = c.base.color;
      g.fillRect(0, 0, w, h);
      return;
    }
    const pic = this.picture;
    if (!pic) return;
    g.fillStyle = steel[0] as string;
    g.fillRect(0, 0, w, h);
    const src = coverScaled(pic, w, h);
    if (c.base.fit === 'contain') {
      const r = containFitRect(src.width, src.height, w, h, 1, this.rect);
      g.drawImage(src, r.x, r.y, r.w, r.h);
    } else {
      const r = coverFitRect(src.width, src.height, w, h, 1, 0, 0, this.rect);
      g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, w, h);
    }
  }

  /** The base (baked, else fitted) with the dim and the lane clamp: the bitmap drawn each frame. */
  private compose(): void {
    const c = this.config;
    const w = this.renderW;
    const h = this.renderH;
    if (!c || w <= 1) return;
    const g = ctx2d(this.composed);
    g.globalAlpha = 1;
    g.drawImage(this.baked ?? this.fitted, 0, 0, w, h);
    const dim = clampDim(c.base.dim + (this.options.dim - DEFAULT_DIM));
    const layers = readabilityLayers(this.brightest, this.deps.overlay, dim);
    g.fillStyle = this.deps.overlay;
    if (layers.dimAlpha > 0) {
      g.globalAlpha = layers.dimAlpha;
      g.fillRect(0, 0, w, h);
    }
    if (layers.laneAlpha > 0) {
      const x0 = Math.floor(this.laneLeft * w);
      g.globalAlpha = layers.laneAlpha;
      g.fillRect(x0, 0, Math.ceil(this.laneRight * w) - x0, h);
    }
    g.globalAlpha = 1;
    this.dirty = true;
  }

  // --- Particles -----------------------------------------------------------------------------

  private tintSources(): TintSources {
    const accent = this.deps.ramps.accent;
    return {
      accent: accent[5] as string,
      image:
        this.imageTints.length > 0 ? this.imageTints : [accent[6] as string, accent[4] as string],
    };
  }

  private updateAtlas(): void {
    const src = this.tintSources();
    const key = atlasKey(this.emitters, src, this.customKey);
    if (key === this.currentAtlasKey) return;
    this.currentAtlasKey = key;
    this.atlas = buildAtlas(this.emitters, this.customSprites, src);
  }

  private drawParticles(songMs: number): void {
    const v = this.view;
    v.w = this.renderW;
    v.h = this.renderH;
    v.laneLeft = this.laneLeft;
    v.laneRight = this.laneRight;
    v.cap = QUALITY[this.adaptive.current].particleCap;
    const n = particleState(
      this.emitters,
      this.seed,
      songMs,
      this.analysis,
      this.timing,
      v,
      this.particles,
    );
    this.lastParticleCount = n;
    if (n === 0) return;
    const g = this.ctx;
    const p = this.particles;
    // Glows first, added; then the sprites over them.
    g.globalCompositeOperation = 'lighter';
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) g.globalCompositeOperation = 'source-over';
      for (let i = 0; i < n; i++) {
        const o = i * PARTICLE_STRIDE;
        const e = this.emitters[p[o + P_EMITTER] as number];
        const set = this.atlas[p[o + P_EMITTER] as number];
        const t = set?.[p[o + P_TINT] as number] ?? set?.[0];
        if (!e || !t) continue;
        const glow = p[o + P_GLOW] as number;
        if (pass === 0 && (glow <= 0 || !t.glow)) continue;
        const long = Math.max(t.w, t.h);
        let s = (p[o + P_SIZE] as number) / long;
        const pixel = e.scaleMode === 'pixel';
        if (pixel) s = Math.max(1, Math.round(s));
        g.imageSmoothingEnabled = !pixel;
        const alpha = p[o + P_ALPHA] as number;
        g.globalAlpha = pass === 0 ? Math.min(1, alpha * glow * 0.9) : alpha;
        const img = pass === 0 ? (t.glow as HTMLCanvasElement) : t.sprite;
        const pad = pass === 0 ? t.pad : 0;
        const x = p[o + P_X] as number;
        const y = p[o + P_Y] as number;
        const angle = p[o + P_ANGLE] as number;
        const dw = (t.w + 2 * pad) * s;
        const dh = (t.h + 2 * pad) * s;
        if (angle === 0) {
          const dx = pixel ? Math.round(x - dw / 2) : x - dw / 2;
          const dy = pixel ? Math.round(y - dh / 2) : y - dh / 2;
          g.drawImage(img, dx, dy, dw, dh);
        } else {
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          g.setTransform(cos, sin, -sin, cos, x, y);
          g.drawImage(img, -dw / 2, -dh / 2, dw, dh);
          g.setTransform(1, 0, 0, 1, 0, 0);
        }
      }
    }
    g.globalAlpha = 1;
    g.imageSmoothingEnabled = true;
  }

  // --- Frame ---------------------------------------------------------------------------------

  private renderFrame(songMs: number): void {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.composed, 0, 0);
    g.globalCompositeOperation = 'source-over';
    this.lastParticleCount = 0;
    if (this.emitters.length > 0) this.drawParticles(songMs);
  }

  draw(ctx: CanvasRenderingContext2D, view: BackgroundView): void {
    const songMs = view.songTimeMs;
    const visual = view.visualTimeMs;
    if (!this.config) {
      // Loading: the skin's static layer, drawn into the game canvas.
      this.deps.host?.attachBackdrop(null);
      this.deps.fallback.draw(ctx, view);
      this.lastVisual = visual;
      return;
    }
    // A window resize can change the screen scale without changing the logical size.
    const host = this.deps.host;
    if (host && host.layout.scale !== this.hostScale) {
      this.hostScale = host.layout.scale;
      this.install();
    }
    let cost = 0;
    const animated = this.emitters.length > 0;
    // Without particles the background is static: draw it only when something changed.
    if (this.dirty || (animated && songMs !== this.lastSongMs)) {
      const t0 = this.now();
      this.renderFrame(songMs);
      this.dirty = false;
      this.lastSongMs = songMs;
      cost = this.now() - t0;
      this.lastCostMs = cost;
    }
    if (this.external) {
      // The background canvas shows through: leave the logical buffer clear.
      ctx.clearRect(0, 0, this.w, this.h);
    } else {
      ctx.imageSmoothingEnabled = !(this.config.base.pixelMatch && this.renderW >= this.w);
      ctx.drawImage(this.canvas, 0, 0, this.w, this.h);
      ctx.imageSmoothingEnabled = false;
    }
    if (
      animated &&
      Number.isFinite(this.lastVisual) &&
      this.adaptive.sample(cost, visual - this.lastVisual)
    ) {
      this.install();
    }
    this.lastVisual = visual;
  }

  dispose(): void {
    this.deps.host?.attachBackdrop(null);
    this.cancelBake();
    this.baker.dispose();
  }
}
