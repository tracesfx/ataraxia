import { thresholdGlyphPixels, type CodeBuffer } from './glyphMask';
import { context2d, createCanvas } from './canvas';

/**
 * Hard-edged canvas text from glyph atlases. Each (font, size) is rasterised once at load: every
 * printable ASCII glyph is drawn into an offscreen canvas, its alpha thresholded to a 1-bit mask
 * (no anti-aliased fringe), then recoloured per colour on first use (tint on blit). Text is drawn
 * at whole logical pixels only. Digits share one advance (tabular), so numbers never jitter.
 *
 * Positions: `y` is the top of the capitals; text occupies `capHeight` rows from there
 * (descenders go below).
 */
const FIRST = 32;
const LAST = 126;
const COUNT = LAST - FIRST + 1;
const QUESTION = 63;
const SPACE = 32;
const DIGIT_0 = 48;
const DIGIT_9 = 57;

export type TextAlign = 'left' | 'center' | 'right';

/**
 * How `drawStyled` paints text: at a whole number of logical pixels per font pixel, with a
 * vertical colour ramp (one flat band per few font-pixel rows, so it stays crisp), a 1-pixel
 * outline, a 1-pixel drop shadow and an optional vertical shine band. Renderers keep one style
 * per text element and mutate it, so drawing allocates nothing.
 */
export interface GlyphStyle {
  /** Logical pixels per font pixel (a whole number, at least 1). */
  scale: number;
  /** Colour bands from top to bottom (at least one). */
  ramp: readonly string[];
  /** Where the ramp starts: the cap height (digits, capitals) or the x-height (lowercase). */
  rampFrom: 'cap' | 'x';
  /** Flat colours per glyph instead of the ramp (glyph i: `(phase + i * step) % length`). */
  glyphColours: readonly string[] | null;
  glyphPhase: number;
  glyphStep: number;
  /** 1-pixel outline on all eight sides, or null. */
  outline: string | null;
  /** 1-pixel drop shadow below the outline, or null, and its opacity (1 = solid). */
  shadow: string | null;
  shadowAlpha: number;
  /**
   * A faint glow: the glyphs grown by 2 pixels (a rounded step, no blur) in `glow`, drawn once
   * behind everything at `glowAlpha`; null for none.
   */
  glow: string | null;
  glowAlpha: number;
  /**
   * A shine band over the letters, leaning at 45 degrees: its colour (null: none), its left edge
   * on the bottom row of the glyph cells (it moves a pixel right per row up) and its width, in
   * logical px.
   */
  shine: string | null;
  shineX: number;
  shineW: number;
  /** Opacity of the shine band (1 = solid). */
  shineAlpha: number;
}

/** A style with defaults (1x, one colour, no outline, shadow or shine). */
export function glyphStyle(ramp: readonly string[], scale = 1): GlyphStyle {
  return {
    scale,
    ramp,
    rampFrom: 'cap',
    glyphColours: null,
    glyphPhase: 0,
    glyphStep: 1,
    outline: null,
    shadow: null,
    shadowAlpha: 1,
    glow: null,
    glowAlpha: 0,
    shine: null,
    shineX: 0,
    shineW: 0,
    shineAlpha: 1,
  };
}

/** Glow offsets (x, y pairs): every offset within a radius of about 2 (a rounded diamond). */
const GLOW = Int8Array.from(
  [-2, -1, 0, 1, 2].flatMap((dy) =>
    [-2, -1, 0, 1, 2].flatMap((dx) => (dx * dx + dy * dy <= 5 ? [dx, dy] : [])),
  ),
);
const GLOW_R = 2;

/** Outline offsets (x, y pairs): the eight neighbours. */
const OUTLINE = Int8Array.of(-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1);

/** Glyph rows for a hand-made font: '#' set, anything else empty. All rows the same height. */
export type GlyphRows = Readonly<Partial<Record<string, readonly string[]>>>;

interface Metrics {
  /** Source x of the glyph's ink box in the mask. */
  sx: Int16Array;
  /** Ink box width (0 = nothing to draw). */
  inkW: Uint8Array;
  /** Ink box left relative to the pen position. */
  inkX: Int8Array;
  advance: Uint8Array;
}

export class GlyphFont {
  private readonly tints = new Map<string, HTMLCanvasElement>();
  private readonly codes = new Uint8Array(128);
  private readonly scratchStyle = glyphStyle(['#ffffff']);
  /** Offscreen layer for the glow (grown when a larger text needs it; reused otherwise). */
  private glowLayer: HTMLCanvasElement | null = null;

  private constructor(
    /** White glyphs on transparent, ink boxes packed in a row. */
    private readonly mask: HTMLCanvasElement,
    private readonly m: Metrics,
    /** Mask rows above the cap top (the mask row for `y`). */
    private readonly capTop: number,
    readonly capHeight: number,
    /** Rows from the cap top to the bottom of descenders. */
    readonly height: number,
    /** Mask row of the top of the x-height (the first inked row of 'x'). */
    private readonly xTop: number,
  ) {}

  /** Rows from the top of the x-height to the baseline (lowercase letters without ascenders). */
  get xHeight(): number {
    return this.capTop + this.capHeight - this.xTop;
  }

  /**
   * Rasterise a CSS font. `glyphPx` is the size of one font pixel in logical pixels (Jersey 10:
   * font size = glyphPx * `pixelEm`), `ascent`/`line` are in font pixels.
   */
  static fromFont(o: {
    family: string;
    pixelEm: number;
    glyphPx: number;
    ascent: number;
    line: number;
  }): GlyphFont {
    const g = o.glyphPx;
    const size = o.pixelEm * g;
    const font = `${size}px ${o.family}`;
    const cellH = o.line * g + 2 * g;
    const baseline = g + o.ascent * g;
    const probe = context2d(createCanvas(1, 1));
    probe.font = font;
    const advance = new Uint8Array(COUNT);
    let slotW = 0;
    for (let i = 0; i < COUNT; i++) {
      advance[i] = Math.max(1, Math.round(probe.measureText(String.fromCharCode(FIRST + i)).width));
      slotW = Math.max(slotW, (advance[i] as number) + 4 * g);
    }
    const scratch = createCanvas(slotW * COUNT, cellH);
    const ctx = context2d(scratch);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    const pad = 2 * g;
    for (let i = 0; i < COUNT; i++)
      ctx.fillText(String.fromCharCode(FIRST + i), i * slotW + pad, baseline);
    return GlyphFont.pack(scratch, slotW, pad, advance, baseline);
  }

  /** A font from hand-drawn rows (unlisted characters are blank); advance = width + 1. */
  static fromRows(rows: GlyphRows, baselineRow: number): GlyphFont {
    const entries = Object.values(rows).filter((r): r is readonly string[] => r !== undefined);
    const cellH = Math.max(1, ...entries.map((r) => r.length));
    let slotW = 1;
    for (const r of entries) slotW = Math.max(slotW, ...r.map((row) => row.length));
    slotW += 2;
    const scratch = createCanvas(slotW * COUNT, cellH);
    const ctx = context2d(scratch);
    ctx.fillStyle = '#ffffff';
    const advance = new Uint8Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const glyph = rows[String.fromCharCode(FIRST + i)];
      const w = glyph ? Math.max(...glyph.map((row) => row.length)) : 3;
      advance[i] = w + 1;
      glyph?.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (row[x] === '#') ctx.fillRect(i * slotW + 1 + x, y, 1, 1);
        }
      });
    }
    return GlyphFont.pack(scratch, slotW, 1, advance, baselineRow);
  }

  /** Threshold the scratch atlas, find each glyph's ink box and pack them into the mask. */
  private static pack(
    scratch: HTMLCanvasElement,
    slotW: number,
    pad: number,
    advance: Uint8Array,
    baseline: number,
  ): GlyphFont {
    const sctx = context2d(scratch);
    const image = sctx.getImageData(0, 0, scratch.width, scratch.height);
    thresholdGlyphPixels(image.data);
    const cellH = scratch.height;
    const on = (x: number, y: number): boolean =>
      (image.data[(y * scratch.width + x) * 4 + 3] ?? 0) > 0;

    // Tabular digits: every digit advances by the widest digit.
    let digitAdvance = 0;
    for (let c = DIGIT_0; c <= DIGIT_9; c++)
      digitAdvance = Math.max(digitAdvance, advance[c - FIRST] ?? 0);

    const m: Metrics = {
      sx: new Int16Array(COUNT),
      inkW: new Uint8Array(COUNT),
      inkX: new Int8Array(COUNT),
      advance,
    };
    let total = 0;
    const left = new Int16Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      let x0 = slotW;
      let x1 = -1;
      for (let x = 0; x < slotW; x++) {
        for (let y = 0; y < cellH; y++) {
          if (on(i * slotW + x, y)) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            break;
          }
        }
      }
      if (x1 < 0) continue;
      left[i] = x0;
      m.inkW[i] = x1 - x0 + 1;
      m.inkX[i] = x0 - pad;
      const code = FIRST + i;
      if (code >= DIGIT_0 && code <= DIGIT_9) {
        const own = advance[i] ?? 0;
        m.inkX[i] = (m.inkX[i] ?? 0) + Math.floor((digitAdvance - own) / 2);
        advance[i] = digitAdvance;
      }
      total += (m.inkW[i] ?? 0) + 1;
    }

    // Cap top: the first inked row of 'H' (fall back to the top of any capital).
    let capTop = cellH;
    for (const ch of ['H', 'E', '0']) {
      const i = ch.charCodeAt(0) - FIRST;
      for (let y = 0; y < cellH && capTop === cellH; y++) {
        for (let x = 0; x < slotW; x++) {
          if (on(i * slotW + x, y)) {
            capTop = y;
            break;
          }
        }
      }
      if (capTop < cellH) break;
    }
    if (capTop >= baseline) capTop = 0;
    let xTop = capTop;
    const xi = 'x'.charCodeAt(0) - FIRST;
    rows: for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < slotW; x++) {
        if (on(xi * slotW + x, y)) {
          xTop = y;
          break rows;
        }
      }
    }
    if (xTop < capTop || xTop >= baseline) xTop = capTop;
    let bottom = baseline;
    for (let y = cellH - 1; y >= baseline; y--) {
      let any = false;
      for (let x = 0; x < scratch.width && !any; x++) any = on(x, y);
      if (any) {
        bottom = y + 1;
        break;
      }
    }

    const mask = createCanvas(Math.max(1, total), cellH);
    const out = context2d(mask).createImageData(mask.width, cellH);
    let sx = 0;
    for (let i = 0; i < COUNT; i++) {
      const w = m.inkW[i] ?? 0;
      if (w === 0) continue;
      m.sx[i] = sx;
      for (let y = 0; y < cellH; y++) {
        for (let x = 0; x < w; x++) {
          if (!on(i * slotW + (left[i] ?? 0) + x, y)) continue;
          const o = (y * mask.width + sx + x) * 4;
          out.data[o] = 255;
          out.data[o + 1] = 255;
          out.data[o + 2] = 255;
          out.data[o + 3] = 255;
        }
      }
      sx += w + 1;
    }
    context2d(mask).putImageData(out, 0, 0);
    return new GlyphFont(mask, m, capTop, baseline - capTop, bottom - capTop, xTop);
  }

  /** Recolour the atlas for `colour` now (call at load so the frame loop never allocates). */
  prepare(...colours: string[]): void {
    for (const c of colours) this.tint(c);
  }

  /** Width in logical px of a string. */
  measure(text: string): number {
    let w = 0;
    for (let i = 0; i < text.length; i++) w += this.advanceOf(text.charCodeAt(i));
    return w;
  }

  measureCodes(buf: CodeBuffer): number {
    let w = 0;
    for (let i = 0; i < buf.length; i++) w += this.advanceOf(buf.codes[i] ?? SPACE);
    return w;
  }

  /** Draw `text` with a 1-pixel shadow (down-right) when `shadow` is given. */
  draw(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    colour: string,
    shadow: string | null,
    align: TextAlign = 'left',
  ): void {
    const n = Math.min(text.length, this.codes.length);
    for (let i = 0; i < n; i++) this.codes[i] = text.charCodeAt(i) & 127;
    this.drawRaw(ctx, this.codes, n, x, y, colour, colour, shadow, align);
  }

  /** Two-tone text: `top` above the middle of the capitals, `bottom` below. */
  drawTwoTone(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    top: string,
    bottom: string,
    shadow: string | null,
    align: TextAlign = 'left',
  ): void {
    const n = Math.min(text.length, this.codes.length);
    for (let i = 0; i < n; i++) this.codes[i] = text.charCodeAt(i) & 127;
    this.drawRaw(ctx, this.codes, n, x, y, top, bottom, shadow, align);
  }

  /** Draw a code buffer (numbers formatted without building strings). */
  drawCodes(
    ctx: CanvasRenderingContext2D,
    buf: CodeBuffer,
    x: number,
    y: number,
    colour: string,
    shadow: string | null,
    align: TextAlign = 'left',
    bottomColour: string = colour,
  ): void {
    this.drawRaw(ctx, buf.codes, buf.length, x, y, colour, bottomColour, shadow, align);
  }

  /** Rows of one glyph cell at 1x (the shine band leans across this many rows per scale). */
  get cellHeight(): number {
    return this.mask.height;
  }

  /** Width in logical px of `n` codes drawn at `scale`. */
  measureScaled(codes: Uint8Array, n: number, scale: number): number {
    let w = 0;
    for (let i = 0; i < n; i++) w += this.advanceOf(codes[i] ?? SPACE);
    return w * scale;
  }

  /** Styled text from a string (see `drawStyled`). */
  drawStyledText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    align: TextAlign,
    style: GlyphStyle,
  ): void {
    const n = Math.min(text.length, this.codes.length);
    for (let i = 0; i < n; i++) this.codes[i] = text.charCodeAt(i) & 127;
    this.drawStyled(ctx, this.codes, n, x, y, align, style);
  }

  /** Ramp-coloured, outlined text at a whole scale (a convenience; allocates nothing). */
  drawText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    scale: number,
    ramp: readonly string[],
    outline: string | null,
    align: TextAlign = 'left',
  ): void {
    const st = this.scratchStyle;
    st.scale = scale;
    st.ramp = ramp;
    st.outline = outline;
    st.shadow = outline;
    this.drawStyledText(ctx, text, x, y, align, st);
  }

  /**
   * Draw `n` codes with `style`. `y` is the top of the capitals at that scale (the text covers
   * `capHeight * scale` rows from there); `x` is aligned by `align`. Everything lands on whole
   * logical pixels: each font pixel is a `scale` x `scale` block.
   */
  drawStyled(
    ctx: CanvasRenderingContext2D,
    codes: Uint8Array,
    n: number,
    x: number,
    y: number,
    align: TextAlign,
    style: GlyphStyle,
  ): void {
    const k = Math.max(1, Math.round(style.scale));
    const width = align === 'left' ? 0 : this.measureScaled(codes, n, k);
    const left = Math.round(align === 'left' ? x : align === 'right' ? x - width : x - width / 2);
    const ty = Math.round(y) - this.capTop * k;
    const full = this.mask.height;
    if (style.glow !== null && style.glowAlpha > 0) {
      this.drawGlow(ctx, codes, n, left, ty, k, style.glow, style.glowAlpha);
    }
    if (style.shadow !== null && style.shadowAlpha > 0) {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * style.shadowAlpha;
      this.passScaled(ctx, this.tint(style.shadow), codes, n, left + 1, ty + 2, k, 0, full);
      ctx.globalAlpha = alpha;
    }
    if (style.outline !== null) {
      const o = this.tint(style.outline);
      for (let i = 0; i < OUTLINE.length; i += 2) {
        const dx = OUTLINE[i] ?? 0;
        const dy = OUTLINE[i + 1] ?? 0;
        this.passScaled(ctx, o, codes, n, left + dx, ty + dy, k, 0, full);
      }
    }
    const colours = style.glyphColours;
    if (colours !== null && colours.length > 0) {
      const len = colours.length;
      let pen = left;
      for (let i = 0; i < n; i++) {
        const code = codes[i] ?? SPACE;
        const ci = (((style.glyphPhase + i * style.glyphStep) % len) + len) % len;
        this.glyphScaled(ctx, this.tint(colours[ci] as string), code, pen, ty, k, 0, full);
        pen += this.advanceOf(code) * k;
      }
    } else {
      const ramp = style.ramp;
      const bands = Math.max(1, ramp.length);
      const top = style.rampFrom === 'x' ? this.xTop : this.capTop;
      const rows = Math.max(1, this.capTop + this.capHeight - top);
      let row0 = 0;
      for (let b = 0; b < bands; b++) {
        // Band b ends at mask row top + rows * (b + 1) / bands; the last runs to the bottom.
        const row1 = b === bands - 1 ? full : top + Math.round((rows * (b + 1)) / bands);
        if (row1 > row0) {
          const colour = ramp[b] ?? ramp[0] ?? '#ffffff';
          this.passScaled(ctx, this.tint(colour), codes, n, left, ty, k, row0, row1);
          row0 = row1;
        }
      }
    }
    if (style.shine !== null && style.shineW > 0) {
      ctx.save();
      // A band leaning at 45 degrees ("/"): one row per step, shifted a pixel right per row up,
      // so its edges are a crisp staircase (an angled path would anti-alias them).
      ctx.beginPath();
      const rows = full * k;
      const x0 = left + Math.round(style.shineX);
      const bw = Math.round(style.shineW);
      for (let r = 0; r < rows; r++) ctx.rect(x0 + (rows - 1 - r), ty + r, bw, 1);
      ctx.clip();
      ctx.globalAlpha *= style.shineAlpha;
      this.passScaled(ctx, this.tint(style.shine), codes, n, left, ty, k, 0, full);
      ctx.restore();
    }
  }

  /**
   * The glow: the grown glyphs drawn opaque into an offscreen layer (so overlapping offsets do
   * not add up), then that layer blitted once at `alpha`.
   */
  private drawGlow(
    ctx: CanvasRenderingContext2D,
    codes: Uint8Array,
    n: number,
    left: number,
    ty: number,
    k: number,
    colour: string,
    alpha: number,
  ): void {
    const w = this.measureScaled(codes, n, k) + 2 * GLOW_R + 4;
    const h = this.mask.height * k + 2 * GLOW_R;
    let layer = this.glowLayer;
    if (!layer || layer.width < w || layer.height < h) {
      layer = createCanvas(Math.max(w, layer?.width ?? 0), Math.max(h, layer?.height ?? 0));
      this.glowLayer = layer;
    }
    const g = context2d(layer);
    g.globalAlpha = 1;
    g.clearRect(0, 0, w, h);
    const atlas = this.tint(colour);
    for (let i = 0; i < GLOW.length; i += 2) {
      const dx = GLOW[i] ?? 0;
      const dy = GLOW[i + 1] ?? 0;
      this.passScaled(g, atlas, codes, n, GLOW_R + 2 + dx, GLOW_R + dy, k, 0, this.mask.height);
    }
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    ctx.drawImage(layer, 0, 0, w, h, left - GLOW_R - 2, ty - GLOW_R, w, h);
    ctx.globalAlpha = prev;
  }

  private passScaled(
    ctx: CanvasRenderingContext2D,
    atlas: HTMLCanvasElement,
    codes: Uint8Array,
    n: number,
    x: number,
    y: number,
    k: number,
    row0: number,
    row1: number,
  ): void {
    let pen = x;
    for (let i = 0; i < n; i++) {
      const code = codes[i] ?? SPACE;
      this.glyphScaled(ctx, atlas, code, pen, y, k, row0, row1);
      pen += this.advanceOf(code) * k;
    }
  }

  private glyphScaled(
    ctx: CanvasRenderingContext2D,
    atlas: HTMLCanvasElement,
    code: number,
    pen: number,
    y: number,
    k: number,
    row0: number,
    row1: number,
  ): void {
    const g = this.index(code);
    const w = this.m.inkW[g] ?? 0;
    const h = row1 - row0;
    if (w === 0 || h <= 0) return;
    ctx.drawImage(
      atlas,
      this.m.sx[g] ?? 0,
      row0,
      w,
      h,
      pen + (this.m.inkX[g] ?? 0) * k,
      y + row0 * k,
      w * k,
      h * k,
    );
  }

  private drawRaw(
    ctx: CanvasRenderingContext2D,
    codes: Uint8Array,
    n: number,
    x: number,
    y: number,
    top: string,
    bottom: string,
    shadow: string | null,
    align: TextAlign,
  ): void {
    let width = 0;
    if (align !== 'left') for (let i = 0; i < n; i++) width += this.advanceOf(codes[i] ?? SPACE);
    const left = Math.round(align === 'left' ? x : align === 'right' ? x - width : x - width / 2);
    const ty = Math.round(y) - this.capTop;
    if (shadow !== null) this.pass(ctx, this.tint(shadow), codes, n, left + 1, ty + 1);
    if (top === bottom) {
      this.pass(ctx, this.tint(top), codes, n, left, ty);
    } else {
      // Two passes clipped to the halves of the cap height.
      const split = this.capTop + Math.ceil(this.capHeight / 2);
      this.pass(ctx, this.tint(top), codes, n, left, ty, 0, split);
      this.pass(ctx, this.tint(bottom), codes, n, left, ty, split, this.mask.height);
    }
  }

  private pass(
    ctx: CanvasRenderingContext2D,
    atlas: HTMLCanvasElement,
    codes: Uint8Array,
    n: number,
    x: number,
    y: number,
    row0 = 0,
    row1 = this.mask.height,
  ): void {
    const h = row1 - row0;
    let pen = x;
    for (let i = 0; i < n; i++) {
      const g = this.index(codes[i] ?? SPACE);
      const w = this.m.inkW[g] ?? 0;
      if (w > 0) {
        ctx.drawImage(
          atlas,
          this.m.sx[g] ?? 0,
          row0,
          w,
          h,
          pen + (this.m.inkX[g] ?? 0),
          y + row0,
          w,
          h,
        );
      }
      pen += this.m.advance[g] ?? 0;
    }
  }

  private index(code: number): number {
    return code >= FIRST && code <= LAST ? code - FIRST : QUESTION - FIRST;
  }

  /** Pixels (at 1x) from the pen position to the first inked column of `code`. */
  inkLeft(code: number): number {
    return this.m.inkX[this.index(code)] ?? 0;
  }

  /** Pixels (at 1x) from the last inked column of `code` to the end of its advance. */
  inkRightGap(code: number): number {
    const g = this.index(code);
    return (this.m.advance[g] ?? 0) - (this.m.inkX[g] ?? 0) - (this.m.inkW[g] ?? 0);
  }

  private advanceOf(code: number): number {
    return this.m.advance[this.index(code)] ?? 0;
  }

  private tint(colour: string): HTMLCanvasElement {
    let canvas = this.tints.get(colour);
    if (!canvas) {
      canvas = createCanvas(this.mask.width, this.mask.height);
      const ctx = context2d(canvas);
      ctx.drawImage(this.mask, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.tints.set(colour, canvas);
    }
    return canvas;
  }
}
