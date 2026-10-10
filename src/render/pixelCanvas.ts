import { computePixelLayout, type PixelLayout } from './pixelScale';
import { windowedViewportHeight } from './windowedHeight';

/**
 * The gameplay drawing surface: an offscreen buffer at the logical resolution, presented on a
 * canvas that covers the whole window at an integer scale with nearest-neighbour sampling.
 *
 * The logical size follows the window (see `computePixelLayout`), so draw code reads `width` and
 * `height` every frame, or subscribes with `onLayout`. Draw into `ctx`, then call `present()` once
 * per frame. The few device pixels at the edges that the integer scale leaves over are painted
 * with `edgeColor` (the background layer's colour).
 *
 * An optional backdrop canvas (`attachBackdrop`, the gameplay background) sits behind the
 * visible canvas, covering exactly the scaled logical image; while one is attached, the logical
 * image is presented with its transparency, so the backdrop shows wherever the frame left the
 * buffer clear.
 */
export class PixelCanvas {
  /** Logical-resolution drawing context. */
  readonly ctx: CanvasRenderingContext2D;
  /** The visible canvas element (full window). */
  readonly element: HTMLCanvasElement;

  private readonly buffer: HTMLCanvasElement;
  private readonly screenCtx: CanvasRenderingContext2D;
  private layoutValue: PixelLayout;
  private dprQuery: MediaQueryList | null = null;
  private readonly listeners = new Set<(layout: Readonly<PixelLayout>) => void>();
  private edge = '#0b0e14';
  private backdrop: HTMLCanvasElement | null = null;
  private readonly onResize = (): void => this.resize();

  constructor(private readonly host: HTMLElement) {
    this.buffer = document.createElement('canvas');
    // Alpha, so a backdrop can show through; everything else draws it fully opaque.
    this.ctx = get2d(this.buffer, true);

    this.element = document.createElement('canvas');
    this.element.className = 'pixel-canvas';
    this.screenCtx = get2d(this.element, true);
    host.appendChild(this.element);

    this.layoutValue = computePixelLayout(1, 1, 1);
    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  get layout(): Readonly<PixelLayout> {
    return this.layoutValue;
  }

  /** Logical width and height (change on resize). */
  get width(): number {
    return this.layoutValue.width;
  }

  get height(): number {
    return this.layoutValue.height;
  }

  /** Colour for the device pixels around the scaled image. */
  set edgeColor(colour: string) {
    if (colour === this.edge) return;
    this.edge = colour;
    this.paintEdges();
  }

  /** Call `fn` after every layout change (and once now). Returns an unsubscribe function. */
  onLayout(fn: (layout: Readonly<PixelLayout>) => void): () => void {
    this.listeners.add(fn);
    fn(this.layoutValue);
    return () => this.listeners.delete(fn);
  }

  /** Recompute size. Called automatically on window resize and DPR changes. */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.host.getBoundingClientRect();
    // Picked for the windowed height, so going fullscreen keeps every size.
    const layout = computePixelLayout(
      rect.width,
      rect.height,
      dpr,
      undefined,
      windowedViewportHeight(),
    );
    const changed =
      layout.width !== this.layoutValue.width ||
      layout.height !== this.layoutValue.height ||
      layout.scale !== this.layoutValue.scale ||
      layout.deviceWidth !== this.layoutValue.deviceWidth ||
      layout.deviceHeight !== this.layoutValue.deviceHeight;
    this.layoutValue = layout;

    const el = this.element;
    if (el.width !== layout.deviceWidth) el.width = layout.deviceWidth;
    if (el.height !== layout.deviceHeight) el.height = layout.deviceHeight;
    el.style.width = `${layout.cssWidth}px`;
    el.style.height = `${layout.cssHeight}px`;
    el.style.left = '0px';
    el.style.top = '0px';
    if (this.buffer.width !== layout.width) this.buffer.width = layout.width;
    if (this.buffer.height !== layout.height) this.buffer.height = layout.height;
    // Resizing a canvas resets its context state.
    this.screenCtx.imageSmoothingEnabled = false;
    this.ctx.imageSmoothingEnabled = false;

    this.placeBackdrop();
    this.watchDpr(dpr);
    this.paintEdges();
    if (changed) for (const fn of this.listeners) fn(layout);
    this.present();
  }

  /**
   * Put `canvas` behind the visible canvas, sized (in CSS) to the scaled logical image, or remove
   * the current one with null. Its own pixel size is the caller's business.
   */
  attachBackdrop(canvas: HTMLCanvasElement | null): void {
    if (canvas === this.backdrop) return;
    this.backdrop?.remove();
    this.backdrop = canvas;
    if (canvas) {
      canvas.classList.add('pixel-backdrop');
      this.host.insertBefore(canvas, this.element);
      this.placeBackdrop();
    }
    this.paintEdges();
    this.present();
  }

  private placeBackdrop(): void {
    const c = this.backdrop;
    if (!c) return;
    const l = this.layoutValue;
    const dpr = l.deviceWidth / Math.max(1, l.cssWidth);
    c.style.left = `${l.offsetX / dpr}px`;
    c.style.top = `${l.offsetY / dpr}px`;
    c.style.width = `${(l.width * l.scale) / dpr}px`;
    c.style.height = `${(l.height * l.scale) / dpr}px`;
  }

  /** Copy the logical buffer to the screen. Call once at the end of each frame. */
  present(): void {
    const l = this.layoutValue;
    const w = Math.round(l.width * l.scale);
    const h = Math.round(l.height * l.scale);
    // With a backdrop, clear first so the buffer's transparent pixels show it.
    if (this.backdrop) this.screenCtx.clearRect(l.offsetX, l.offsetY, w, h);
    this.screenCtx.imageSmoothingEnabled = false;
    this.screenCtx.drawImage(this.buffer, l.offsetX, l.offsetY, w, h);
  }

  /** Map a pointer position (clientX/Y) to logical pixel coordinates. */
  toLogical(clientX: number, clientY: number): { x: number; y: number } {
    const l = this.layoutValue;
    const dpr = l.deviceWidth / Math.max(1, l.cssWidth);
    return {
      x: (clientX * dpr - l.offsetX) / l.scale,
      y: (clientY * dpr - l.offsetY) / l.scale,
    };
  }

  /** Logical position -> CSS pixels (for DOM elements placed over the canvas). */
  toCss(x: number, y: number): { left: number; top: number; px: number } {
    const l = this.layoutValue;
    const dpr = l.deviceWidth / Math.max(1, l.cssWidth);
    return {
      left: (l.offsetX + x * l.scale) / dpr,
      top: (l.offsetY + y * l.scale) / dpr,
      px: l.scale / dpr,
    };
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.dprQuery?.removeEventListener('change', this.onResize);
    this.dprQuery = null;
    this.listeners.clear();
    this.backdrop?.remove();
    this.backdrop = null;
    this.element.remove();
  }

  private paintEdges(): void {
    const l = this.layoutValue;
    this.screenCtx.fillStyle = this.edge;
    this.screenCtx.fillRect(0, 0, l.deviceWidth, l.deviceHeight);
  }

  /** `resize` doesn't always fire when DPR changes (e.g. moving between monitors), so watch it. */
  private watchDpr(dpr: number): void {
    this.dprQuery?.removeEventListener('change', this.onResize);
    this.dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    this.dprQuery.addEventListener('change', this.onResize);
  }
}

function get2d(canvas: HTMLCanvasElement, alpha: boolean): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha });
  if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}
