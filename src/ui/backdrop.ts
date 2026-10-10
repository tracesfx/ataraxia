import type { CoverRef } from '../library/songLibrary';
import type { App } from './app';
import { coverThumbBitmap } from './coverImages';
import { bitmapToCanvas } from './pixel/render';
import { coverBitmap } from './pixel/cover';
import type { PixelGrid } from './pixel/install';
import type { SceneScope } from './sceneManager';
import { RAMPS } from './theme';

/**
 * The menus' ambient background: one canvas behind the DOM screens, drawn at the art-pixel grid
 * (one canvas pixel per art pixel, scaled up with `image-rendering: pixelated`).
 *
 * - `gradient` (main menu, settings, calibration, and song select until a song is selected): a
 *   slow moving gradient in the dark accent and iris tones, its angle turning and its colours drifting. Drawn smoothly at a small size and stretched over the
 *   backdrop (so neighbouring grid pixels barely differ: no visible bands or blocks), about 12
 *   times a second; still while motion is reduced.
 * - `cover`: the selected song's cover (custom picture or generated placeholder), blurred
 *   smoothly once into a faint glow, then drawn at the art-pixel grid resolution (the blur is so
 *   wide that neighbouring grid pixels barely differ: no mosaic blocks). Drawn only when the
 *   cover or the size changes; a custom cover's thumbnail is decoded first (the placeholder
 *   glow shows meanwhile).
 */
export type BackdropMode =
  { kind: 'gradient' } | { kind: 'cover'; title: string; cover?: CoverRef | null };

/** Small working size for the blur; the result is stretched over the whole backdrop. */
const GLOW_W = 48;
const GLOW_H = 27;

const S = RAMPS.steel;
const A = RAMPS.accent;
/** The moving gradient: its working size, the stops it cycles through, and its periods (s). */
const GRADIENT_W = 96;
const GRADIENT_H = 54;
const I = RAMPS.iris;
const GRADIENT_STOPS = [S[0], A[2], I[2], A[0], S[1]] as const;
const GRADIENT_TURN_S = 36;
const GRADIENT_DRIFT_S = 23;
/** Redraw interval of the moving gradient (about 12 times a second). */
const FRAME_MS = 80;

export class Backdrop {
  readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private mode: BackdropMode | null = null;
  private lastDrawMs = -Infinity;
  private dirty = true;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private coverKey = '';
  /** Blurred glow per cover (placeholder title or custom cover key), most recent only. */
  private glow: { id: string; canvas: HTMLCanvasElement } | null = null;
  /** Small working canvas of the moving gradient. */
  private gradientCanvas: HTMLCanvasElement | null = null;

  constructor(
    host: HTMLElement,
    private readonly grid: PixelGrid,
  ) {
    this.element = document.createElement('canvas');
    this.element.className = 'backdrop';
    this.element.hidden = true;
    const ctx = this.element.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
    this.ctx = ctx;
    host.prepend(this.element);
    grid.subscribe(() => this.resize());
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  show(mode: BackdropMode): void {
    const same =
      this.mode?.kind === mode.kind &&
      (mode.kind !== 'cover' ||
        (this.mode.kind === 'cover' && coverId(this.mode) === coverId(mode)));
    this.mode = mode;
    this.element.hidden = false;
    if (!same) {
      this.dirty = true;
      // Something else may have been drawn since this cover: draw it again, don't trust the key.
      this.coverKey = '';
    }
  }

  hide(): void {
    this.mode = null;
    this.coverKey = '';
    this.element.hidden = true;
  }

  /** Redraw if needed. `timeMs` is visual (rAF) time. */
  frame(timeMs: number): void {
    if (!this.mode || document.hidden) return;
    const animated = this.mode.kind === 'gradient' && !this.reducedMotion.matches;
    if (!this.dirty && !(animated && timeMs - this.lastDrawMs >= FRAME_MS)) return;
    this.dirty = false;
    this.lastDrawMs = timeMs;
    if (this.mode.kind === 'gradient') this.drawGradient(animated ? timeMs : 0);
    else this.drawCover(this.mode);
  }

  private resize(): void {
    const n = this.grid.artPixel;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.ceil((window.innerWidth * dpr) / n);
    const h = Math.ceil((window.innerHeight * dpr) / n);
    if (this.element.width !== w || this.element.height !== h) {
      this.element.width = w;
      this.element.height = h;
    }
    this.element.style.width = `${(w * n) / dpr}px`;
    this.element.style.height = `${(h * n) / dpr}px`;
    this.dirty = true;
    this.coverKey = '';
  }

  private drawGradient(timeMs: number): void {
    let small = this.gradientCanvas;
    if (!small) {
      small = document.createElement('canvas');
      small.width = GRADIENT_W;
      small.height = GRADIENT_H;
      this.gradientCanvas = small;
    }
    const g = small.getContext('2d');
    if (!g) return;
    const t = timeMs / 1000;
    const w = GRADIENT_W;
    const h = GRADIENT_H;
    // A linear gradient whose direction turns slowly through the screen.
    const angle = (2 * Math.PI * t) / GRADIENT_TURN_S + 0.6;
    const r = Math.hypot(w, h) / 2;
    const dx = Math.cos(angle) * r;
    const dy = Math.sin(angle) * r;
    const lin = g.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
    // The stops slide a little along it, so the colours drift as well as turn.
    const shift = 0.16 * Math.sin((2 * Math.PI * t) / GRADIENT_DRIFT_S);
    GRADIENT_STOPS.forEach((colour, i) => {
      const at =
        i / (GRADIENT_STOPS.length - 1) + (i > 0 && i < GRADIENT_STOPS.length - 1 ? shift : 0);
      lin.addColorStop(Math.min(1, Math.max(0, at)), colour);
    });
    g.fillStyle = lin;
    g.fillRect(0, 0, w, h);
    // A soft, wandering lift of light on top for depth.
    const cx = w * (0.5 + 0.34 * Math.sin((2 * Math.PI * t) / 28));
    const cy = h * (0.4 + 0.28 * Math.cos((2 * Math.PI * t) / 22));
    const rad = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.55);
    rad.addColorStop(0, A[2]);
    rad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.globalAlpha = 0.35;
    g.fillStyle = rad;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;

    const { ctx } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, this.element.width, this.element.height);
    ctx.imageSmoothingEnabled = false;
  }

  private drawCover(mode: Extract<BackdropMode, { kind: 'cover' }>): void {
    const id = coverId(mode);
    const key = `${id}@${this.element.width}x${this.element.height}`;
    if (key === this.coverKey) return;
    let glow = this.glow?.id === id ? this.glow.canvas : null;
    if (!glow && !mode.cover) {
      glow = blurredGlow(bitmapToCanvas(coverBitmap(mode.title, 6)));
      this.glow = { id, canvas: glow };
    } else if (!glow && mode.cover) {
      // Decode the thumbnail, then draw again; the placeholder glow stands in until then.
      coverThumbBitmap(mode.cover).then(
        (bitmap) => {
          if (this.mode?.kind !== 'cover' || coverId(this.mode) !== id) return;
          this.glow = { id, canvas: blurredGlow(bitmap) };
          this.dirty = true;
        },
        (err: unknown) => console.warn('The cover could not be decoded for the backdrop:', err),
      );
    }
    // Only a final glow marks this cover as drawn; the stand-in is replaced once decoded.
    if (glow) this.coverKey = key;
    const shown = glow ?? blurredGlow(bitmapToCanvas(coverBitmap(mode.title, 6)));
    const { ctx } = this;
    const w = this.element.width;
    const h = this.element.height;
    ctx.fillStyle = S[0];
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.3;
    ctx.drawImage(shown, 0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
  }
}

/** Which cover a cover mode shows (custom cover key, else the placeholder's title). */
function coverId(mode: Extract<BackdropMode, { kind: 'cover' }>): string {
  return mode.cover ? `cover:${mode.cover.key}` : `title:${mode.title}`;
}

/**
 * A cover blurred smoothly once into a small glow: shrunk to a few pixels with high-quality
 * smoothing, then scaled to the glow size with a canvas blur filter where supported (the
 * smooth upscale alone already blurs it).
 */
function blurredGlow(source: CanvasImageSource): HTMLCanvasElement {
  const tiny = document.createElement('canvas');
  tiny.width = 8;
  tiny.height = 8;
  const tctx = tiny.getContext('2d');
  const glow = document.createElement('canvas');
  glow.width = GLOW_W;
  glow.height = GLOW_H;
  const gctx = glow.getContext('2d');
  if (!tctx || !gctx) return glow;
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(source, 0, 0, 8, 8);
  gctx.imageSmoothingEnabled = true;
  gctx.imageSmoothingQuality = 'high';
  if ('filter' in gctx) gctx.filter = 'blur(2px)';
  // Overdraw the edges so the blur doesn't fade to transparent at the borders.
  gctx.drawImage(tiny, -4, -4, GLOW_W + 8, GLOW_H + 8);
  return glow;
}

/** Show the backdrop for a scene, keep it drawn, and hide it when the scene exits. */
export function useBackdrop(scope: SceneScope, app: App, mode: BackdropMode): Backdrop {
  app.backdrop.show(mode);
  scope.everyFrame((ts) => app.backdrop.frame(ts));
  scope.onDispose(() => app.backdrop.hide());
  return app.backdrop;
}
