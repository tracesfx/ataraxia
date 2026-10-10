import { bitmapCanvas, context2d, createCanvas } from '../../render/canvas';
import type { FieldLayout } from '../../render/fieldLayout';
import { GlyphFont } from '../../render/glyphAtlas';
import {
  NOTE_HUES,
  type BackgroundLayer,
  type NoteHue,
  type Skin,
  type SkinColors,
  type SpriteImage,
} from '../../render/skin';
import type { Bitmap } from '../../ui/pixel/bitmap';
import { COLORS, FONTS, METAL_RAMPS as M, RAINBOW, RAMPS, TIMING_COLORS } from '../../ui/theme';
import { MICRO_DIGITS, MICRO_BASELINE } from './microFont';
import { backgroundBitmap, buildDefaultSprites, fieldBitmap, fieldGlowBitmap } from './sprites';

const { steel: S, accent: A, iris: I } = RAMPS;

/** Colours of the default skin, all from the theme tokens. */
export const DEFAULT_COLORS: SkinColors = {
  background: COLORS.bg,
  text: COLORS.text,
  textMuted: COLORS.textMuted,
  textFaint: COLORS.textFaint,
  shadow: RAMPS.steel[0],
  accentText: COLORS.accentText,
  outline: S[0],
  // Metallic ramps, top row first: a lit top, the body colour, a darker foot.
  judgementRamps: { perfect: M.gold, great: M.tealGreen, good: M.steel, miss: M.red },
  judgementGlow: M.gold[2],
  early: TIMING_COLORS.early,
  late: TIMING_COLORS.late,
  // 0-24 steel white, 25-49 cyan, 50-99 green, 100-199 gold, 200-299 orange, 300-499 magenta,
  // 500+ rainbow (drawn from `rainbow`; this ramp is the static gold fallback).
  comboTiers: [M.white, M.cyan, M.green, M.gold, M.ember, M.orchid, M.gold],
  comboBroken: [S[7], S[6], S[6], S[5], S[5]],
  rainbow: RAINBOW,
  comboShine: S[8],
  laneGlow: { outer: A[6], inner: I[6] },
  hudPanel: S[1],
  hudPanelEdge: S[3],
  loopMarker: RAMPS.accent[6],
  panel: RAMPS.steel[1],
};

/** The background bands, cached per logical size. */
class StaticGradientBackground implements BackgroundLayer {
  private canvas: HTMLCanvasElement = createCanvas(1, 1);
  private w = 0;
  private h = 0;

  resize(width: number, height: number): void {
    if (width === this.w && height === this.h) return;
    this.w = width;
    this.h = height;
    this.canvas = bitmapCanvas(backgroundBitmap(width, height), this.canvas);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.drawImage(this.canvas, 0, 0);
  }
}

/** Jersey 10 at whole font-pixel sizes (font pixel = `glyphPx` logical pixels). */
function jersey(glyphPx: number): GlyphFont {
  return GlyphFont.fromFont({
    family: "'Jersey 10', monospace",
    pixelEm: FONTS.pixelEm,
    glyphPx,
    ascent: 15,
    line: FONTS.pixelLine,
  });
}

function perHue(src: Record<NoteHue, Bitmap>): Record<NoteHue, SpriteImage> {
  const out = {} as Record<NoteHue, SpriteImage>;
  for (const hue of NOTE_HUES) out[hue] = bitmapCanvas(src[hue]);
  return out;
}

/**
 * Build the default skin: waits for the pixel font, rasterises the glyph atlases and generates
 * every sprite at logical resolution (a few ms). Never rejects: without the font, the atlases
 * fall back to a system font.
 */
export async function createDefaultSkin(): Promise<Skin> {
  const spec = `${FONTS.pixelEm}px 'Jersey 10'`;
  try {
    await document.fonts.load(spec, 'Aa0');
    if (!document.fonts.check(spec, 'Aa0'))
      console.warn('Jersey 10 is unavailable; canvas text uses a fallback font.');
  } catch (err) {
    console.warn('The pixel font failed to load; canvas text uses a fallback font.', err);
  }

  const b = buildDefaultSprites();
  const label = jersey(1);
  const title = jersey(2);
  const skin: Skin = {
    id: 'default',
    name: 'Default',
    colors: DEFAULT_COLORS,
    sprites: {
      note: perHue(b.note),
      holdBody: perHue(b.holdBody),
      holdBodyHeld: perHue(b.holdBodyHeld),
      holdCap: perHue(b.holdCap),
      progressTrack: bitmapCanvas(b.progressTrack),
      progressFill: bitmapCanvas(b.progressFill),
    },
    fonts: {
      label,
      title,
      particle: {
        small: GlyphFont.fromRows(MICRO_DIGITS, MICRO_BASELINE),
        medium: label,
        large: title,
      },
    },
    createBackground: () => new StaticGradientBackground(),
    buildField: (layout: FieldLayout) => {
      const canvas = bitmapCanvas(fieldBitmap(layout.height, layout.hitLineY));
      const glow = bitmapCanvas(fieldGlowBitmap(layout.height, layout.hitLineY));
      context2d(canvas).drawImage(glow, 0, 0);
      return canvas;
    },
  };
  return skin;
}
