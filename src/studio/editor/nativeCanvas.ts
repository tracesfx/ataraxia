/**
 * A canvas drawn at the device's native resolution (unlike the game's 480x270 pixel canvas):
 * its backing store follows the element's CSS size times devicePixelRatio. Call `sync()` once
 * per frame; it returns true when the size changed and everything must be redrawn.
 */
export class NativeCanvas {
  readonly element: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** CSS pixel size. */
  widthPx = 0;
  heightPx = 0;
  dpr = 1;
  private readonly observer: ResizeObserver;
  private resized = true;

  constructor(className: string) {
    this.element = document.createElement('canvas');
    this.element.className = className;
    const ctx = this.element.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser cannot draw 2D canvas graphics.');
    this.ctx = ctx;
    this.observer = new ResizeObserver(() => {
      this.resized = true;
    });
    this.observer.observe(this.element);
  }

  sync(): boolean {
    const dpr = window.devicePixelRatio || 1;
    if (!this.resized && dpr === this.dpr) return false;
    this.resized = false;
    const rect = this.element.getBoundingClientRect();
    this.widthPx = rect.width;
    this.heightPx = rect.height;
    this.dpr = dpr;
    this.element.width = Math.max(1, Math.round(rect.width * dpr));
    this.element.height = Math.max(1, Math.round(rect.height * dpr));
    return true;
  }

  /** Element-relative CSS coordinates of a pointer event. */
  pointerPos(e: MouseEvent): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  dispose(): void {
    this.observer.disconnect();
  }
}
