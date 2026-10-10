import { blurPlane } from '../../core/background/bake';
import { hexToRgb, rgbToHex } from '../../core/background/color';
import {
  CUSTOM_SPRITE_PREFIX,
  isLibrarySprite,
  type EmitterConfig,
} from '../../core/background/emitter';
import { GRADIENT_TINTS, tintCount } from '../../core/background/particles';
import { librarySprite, spriteRgba } from '../../core/background/sprites';
import { ctx2d, makeCanvas, type AnySource } from './pictures';

/**
 * Pre-rendered particle sprites: for each emitter, its sprite tinted in each of its colours, and
 * for glowing emitters a soft additive glow variant (the sprite's alpha blurred once on the CPU,
 * no canvas filters). Built when an emitter's look changes, never per frame.
 */

export interface TintedSprite {
  sprite: HTMLCanvasElement;
  /** Larger than the sprite by `pad` on each side; null when the emitter has no glow. */
  glow: HTMLCanvasElement | null;
  pad: number;
  w: number;
  h: number;
}

export interface TintSources {
  accent: string;
  /** Colours taken from the base picture (the theme accent ladder without one). */
  image: readonly string[];
}

/** The emitter's colours, one per tint index. */
export function emitterTints(e: EmitterConfig, src: TintSources): string[] {
  const n = tintCount(e);
  switch (e.colorMode) {
    case 'gradient': {
      const a = hexToRgb(e.color);
      const b = hexToRgb(e.color2);
      return Array.from({ length: GRADIENT_TINTS }, (_, i) => {
        const t = i / (GRADIENT_TINTS - 1);
        return rgbToHex({
          r: a.r + (b.r - a.r) * t,
          g: a.g + (b.g - a.g) * t,
          b: a.b + (b.b - a.b) * t,
        });
      });
    }
    case 'palette':
      return e.palette.slice(0, n);
    case 'image':
      return Array.from(
        { length: n },
        (_, i) => src.image[i % Math.max(1, src.image.length)] ?? src.accent,
      );
    case 'accent':
      return [src.accent];
    default:
      return [e.color];
  }
}

/** A white-based canvas of the emitter's sprite (null for a custom sprite that isn't loaded). */
export function spriteCanvas(
  id: string,
  custom: ReadonlyMap<string, AnySource>,
): HTMLCanvasElement | null {
  if (isLibrarySprite(id)) {
    const s = librarySprite(id);
    const c = makeCanvas(s.w, s.h);
    ctx2d(c).putImageData(new ImageData(spriteRgba(s), s.w, s.h), 0, 0);
    return c;
  }
  const src = custom.get(id.slice(CUSTOM_SPRITE_PREFIX.length));
  if (!src) return null;
  const c = makeCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

function tinted(base: HTMLCanvasElement, hex: string): HTMLCanvasElement {
  const c = makeCanvas(base.width, base.height);
  const g = ctx2d(c);
  g.drawImage(base, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = hex;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(base, 0, 0);
  return c;
}

/** A soft glow around the sprite's shape in `hex`, `pad` pixels larger on each side. */
function glowOf(base: HTMLCanvasElement, hex: string, pad: number): HTMLCanvasElement {
  const w = base.width + 2 * pad;
  const h = base.height + 2 * pad;
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  g.drawImage(base, pad, pad);
  const img = g.getImageData(0, 0, w, h);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = (img.data[i * 4 + 3] as number) / 255;
  blurPlane(alpha, w, h, Math.max(1, pad / 2.2));
  const { r, g: gg, b } = hexToRgb(hex);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = Math.min(255, (alpha[i] as number) * 255 * 1.8);
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Tinted sprites for each emitter (index = emitter index, then tint index). */
export function buildAtlas(
  emitters: readonly EmitterConfig[],
  custom: ReadonlyMap<string, AnySource>,
  src: TintSources,
): (TintedSprite[] | null)[] {
  return emitters.map((e) => {
    const base = spriteCanvas(e.sprite, custom);
    if (!base) return null;
    const pad = Math.max(2, Math.ceil(Math.max(base.width, base.height) * 0.6));
    return emitterTints(e, src).map((hex) => ({
      sprite: tinted(base, hex),
      glow: e.glow > 0 ? glowOf(base, hex, pad) : null,
      pad,
      w: base.width,
      h: base.height,
    }));
  });
}

/** A key that changes whenever an atlas would look different. */
export function atlasKey(emitters: readonly EmitterConfig[], src: TintSources, customKey: string) {
  return JSON.stringify([
    emitters.map((e) => [e.sprite, e.colorMode, e.color, e.color2, e.palette, e.glow > 0]),
    src.accent,
    src.image,
    customKey,
  ]);
}
