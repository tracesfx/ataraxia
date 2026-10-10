import { Mask, maskFromRows } from './bitmap';

/**
 * 16x16 pixel icons, as 1-bit masks. They are applied with CSS `mask-image` and painted with
 * `currentColor`, so an icon always matches the text it sits next to. Strokes are 1 art pixel
 * (2 at most), so icons stay fine next to the text.
 *
 * Player icons live here. Studio-only icons (edit, import, export, undo, redo, tools) are
 * registered by src/studio with `registerIcons`, so they never reach the player bundle.
 */
export const ICON_SIZE = 16;

/** Drawing helpers for building icons from strokes. */
export class IconPen {
  readonly mask = new Mask(ICON_SIZE, ICON_SIZE);

  dot(x: number, y: number): this {
    this.mask.set(x, y);
    return this;
  }

  rect(x: number, y: number, w: number, h: number): this {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.mask.set(i, j);
    return this;
  }

  /** 1-pixel rectangle outline with the corner pixels left out (rounded). */
  box(x: number, y: number, w: number, h: number): this {
    this.rect(x + 1, y, w - 2, 1).rect(x + 1, y + h - 1, w - 2, 1);
    return this.rect(x, y + 1, 1, h - 2).rect(x + w - 1, y + 1, 1, h - 2);
  }

  /** Bresenham line with a `w`-pixel horizontal brush. */
  line(x0: number, y0: number, x1: number, y1: number, w = 1): this {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.rect(x, y, w, 1);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
    return this;
  }

  /** Pixels whose centre lies between radii r0 and r1 around (cx, cy), optionally in an arc. */
  ring(cx: number, cy: number, r0: number, r1: number, keep?: (angle: number) => boolean): this {
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d < r0 || d > r1) continue;
        if (keep && !keep(Math.atan2(y + 0.5 - cy, x + 0.5 - cx))) continue;
        this.mask.set(x, y);
      }
    }
    return this;
  }

  clear(x: number, y: number, w = 1, h = 1): this {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.mask.set(i, j, false);
    return this;
  }
}

const pen = (): IconPen => new IconPen();

/** Mirror a mask left-right. */
export function mirrorX(m: Mask): Mask {
  const out = new Mask(m.w, m.h);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) out.set(m.w - 1 - x, y, m.has(x, y));
  return out;
}

/** Swap x and y (turns a left chevron into an up chevron). */
export function transpose(m: Mask): Mask {
  const out = new Mask(m.h, m.w);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) out.set(y, x, m.has(x, y));
  return out;
}

function chevronLeft(): Mask {
  return pen().line(9, 3, 5, 7, 2).line(5, 8, 9, 12, 2).mask;
}

function play(): Mask {
  const p = pen();
  for (let i = 0; i < 7; i++) {
    p.rect(4, 1 + i, 1 + i, 1);
    p.rect(4, 14 - i, 1 + i, 1);
  }
  return p.rect(4, 8, 7, 0).mask;
}

function gear(): Mask {
  const p = pen();
  p.ring(8, 8, 2.6, 5.1);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    p.ring(8, 8, 5, 7.4, (t) => {
      const diff = Math.abs(Math.atan2(Math.sin(t - a), Math.cos(t - a)));
      return diff < 0.24;
    });
  }
  return p.mask;
}

const ICONS: Record<string, () => Mask> = {
  play,
  pause: () => pen().rect(4, 2, 3, 12).rect(9, 2, 3, 12).mask,
  back: () => pen().line(7, 3, 3, 7).line(3, 8, 7, 12).rect(3, 7, 10, 2).mask,
  'chevron-left': chevronLeft,
  'chevron-right': () => mirrorX(chevronLeft()),
  'chevron-up': () => transpose(chevronLeft()),
  'chevron-down': () => transpose(mirrorX(chevronLeft())),
  close: () => pen().line(3, 3, 11, 11, 2).line(11, 3, 3, 11, 2).mask,
  check: () => pen().line(2, 8, 5, 11, 2).line(6, 11, 12, 4, 2).mask,
  plus: () => pen().rect(7, 3, 2, 10).rect(3, 7, 10, 2).mask,
  minus: () => pen().rect(3, 7, 10, 2).mask,
  settings: gear,
  search: () => pen().ring(6.5, 6.5, 3.6, 5).line(10, 10, 13, 13, 2).mask,
  volume: () =>
    pen()
      .rect(2, 6, 3, 4)
      .line(5, 6, 8, 3)
      .line(5, 9, 8, 12)
      .rect(8, 3, 1, 10)
      .rect(5, 6, 3, 4)
      .rect(6, 5, 2, 6)
      .ring(8, 8, 3.6, 4.6, (t) => Math.abs(t) < 0.9)
      .ring(8, 8, 6, 7, (t) => Math.abs(t) < 0.9).mask,
  music: () =>
    maskFromRows([
      '................',
      '.........#####..',
      '......#######...',
      '......####..#...',
      '......#.....#...',
      '......#.....#...',
      '......#.....#...',
      '......#.....#...',
      '......#.....#...',
      '......#...###...',
      '......#..####...',
      '....###..###....',
      '...####.........',
      '...###..........',
      '................',
      '................',
    ]),
  package: () =>
    pen()
      .box(2, 5, 12, 9)
      .rect(1, 3, 14, 3)
      .clear(1, 3)
      .clear(14, 3)
      .rect(6, 8, 4, 1)
      .clear(2, 6, 12, 1).mask,
  trash: () =>
    pen().rect(6, 1, 4, 1).rect(2, 3, 12, 1).box(3, 4, 10, 11).rect(6, 6, 1, 7).rect(9, 6, 1, 7)
      .mask,
  keyboard: () =>
    pen()
      .box(1, 4, 14, 9)
      .dot(3, 6)
      .dot(5, 6)
      .dot(7, 6)
      .dot(9, 6)
      .dot(11, 6)
      .dot(4, 8)
      .dot(6, 8)
      .dot(8, 8)
      .dot(10, 8)
      .dot(12, 8)
      .rect(5, 10, 6, 1).mask,
  display: () => pen().box(1, 2, 14, 10).rect(7, 12, 2, 1).rect(4, 13, 8, 1).mask,
  sliders: () =>
    pen()
      .rect(2, 4, 12, 1)
      .rect(9, 2, 2, 5)
      .rect(2, 8, 12, 1)
      .rect(4, 6, 2, 5)
      .rect(2, 12, 12, 1)
      .rect(10, 10, 2, 5).mask,
  target: () =>
    pen()
      .ring(8, 8, 5.6, 6.6)
      .ring(8, 8, 2.3, 3.3)
      .rect(7, 7, 2, 2)
      .rect(7, 0, 2, 2)
      .rect(7, 14, 2, 2).mask,
  clock: () => pen().ring(8, 8, 5.8, 6.9).rect(7, 4, 2, 5).rect(9, 7, 3, 2).mask,
  pulse: () =>
    pen().rect(1, 8, 3, 1).line(4, 8, 6, 3).line(6, 3, 9, 13).line(9, 13, 11, 8).rect(11, 8, 4, 1)
      .mask,
  retry: () =>
    pen()
      .ring(8, 8.5, 4.6, 5.8, (t) => !(t > -1.75 && t < -0.6))
      .rect(8, 1, 4, 1)
      .rect(10, 2, 2, 3)
      .line(8, 2, 9, 3).mask,
  star: () =>
    maskFromRows([
      '................',
      '.......##.......',
      '.......##.......',
      '......####......',
      '......####......',
      '.##############.',
      '..############..',
      '...##########...',
      '....########....',
      '....########....',
      '...####..####...',
      '...###....###...',
      '..###......###..',
      '..##........##..',
      '................',
      '................',
    ]),
  info: () => pen().ring(8, 8, 5.8, 6.9).rect(7, 4, 2, 2).rect(7, 7, 2, 5).mask,
  alert: () =>
    pen().line(8, 1, 1, 14).line(7, 1, 14, 14).rect(1, 14, 14, 1).rect(7, 5, 2, 5).rect(7, 11, 2, 2)
      .mask,
  expand: () =>
    pen()
      .rect(1, 1, 5, 1)
      .rect(1, 1, 1, 5)
      .rect(10, 1, 5, 1)
      .rect(14, 1, 1, 5)
      .rect(1, 14, 5, 1)
      .rect(1, 10, 1, 5)
      .rect(10, 14, 5, 1)
      .rect(14, 10, 1, 5).mask,
  speed: () =>
    pen()
      .ring(8, 10, 5.6, 6.7, (t) => t < 0.1 && t > -3.25)
      .line(8, 10, 11, 6, 2).mask,
  enter: () => pen().rect(12, 3, 1, 7).rect(4, 9, 9, 1).line(4, 9, 7, 6).line(4, 9, 7, 12).mask,
};

const extra = new Map<string, () => Mask>();

/** Add icons (Studio). Names must not clash with the built-in set. */
export function registerIcons(icons: Record<string, () => Mask>): void {
  for (const [name, make] of Object.entries(icons)) {
    if (name in ICONS || extra.has(name)) throw new Error(`Icon "${name}" already exists.`);
    extra.set(name, make);
  }
}

export function iconNames(): string[] {
  return [...Object.keys(ICONS), ...extra.keys()];
}

/** The mask of an icon, or null for an unknown name. */
export function iconMask(name: string): Mask | null {
  const make = ICONS[name] ?? extra.get(name);
  return make ? make() : null;
}
