import { hexToRgb, hueDistance, luminance, rgbToHex, rgbToHsl, type Rgb } from './color';

/**
 * Background palettes. Every procedural background draws with a short ladder of shades taken
 * from the theme ramps (src/ui/theme.ts, passed in so this stays pure), so a background uses a
 * limited number of flat colours in the game's palette. A song's palette comes from its cover:
 * the dominant colours (downscale, then median cut) are snapped onto the nearest theme ramp
 * family; without a cover, or for a grey cover, the theme accent is used.
 */

/** The ramp families a cover colour can snap to (steel is the neutral). */
export type RampFamily = 'accent' | 'iris' | 'success' | 'warning' | 'danger' | 'steel';
export type RampSet = Readonly<Record<RampFamily, readonly string[]>>;

/** Typical hue of each coloured family (degrees). */
export const FAMILY_HUES: Readonly<Record<Exclude<RampFamily, 'steel'>, number>> = {
  accent: 210,
  iris: 236,
  success: 160,
  warning: 40,
  danger: 352,
};

/** Below this saturation (or very dark / very light) a colour counts as neutral (steel). */
const NEUTRAL_SATURATION = 0.16;

export interface BackgroundPalette {
  /** Main family (its ramp, dark to light). */
  primary: RampFamily;
  /** Second family for accents (sparkles, blob variety). */
  secondary: RampFamily;
  /**
   * The ladder every background maps luminance onto: steel 0-1 for the darks, then the primary
   * ramp from dark to light. At most LADDER_MAX shades.
   */
  ladder: readonly string[];
  /** Ladder from the secondary family (same length rules). */
  secondaryLadder: readonly string[];
}

export const LADDER_MAX = 9;

export function ladderFor(family: RampFamily, ramps: RampSet): string[] {
  const steel = ramps.steel;
  if (family === 'steel') return steel.slice(0, 8);
  const ramp = ramps[family];
  return [steel[0] as string, steel[1] as string, ...ramp].slice(0, LADDER_MAX);
}

/** The partner of a family for second colours: a neighbour that stays harmonious. */
const PARTNER: Readonly<Record<RampFamily, RampFamily>> = {
  accent: 'iris',
  iris: 'accent',
  success: 'accent',
  warning: 'danger',
  danger: 'iris',
  steel: 'accent',
};

export function makePalette(primary: RampFamily, secondary: RampFamily, ramps: RampSet) {
  const palette: BackgroundPalette = {
    primary,
    secondary,
    ladder: ladderFor(primary, ramps),
    secondaryLadder: ladderFor(secondary, ramps),
  };
  return palette;
}

/** The default palette: the theme accent with its iris sibling. */
export function defaultPalette(ramps: RampSet): BackgroundPalette {
  return makePalette('accent', 'iris', ramps);
}

/** The family a colour snaps to: steel for greys, else the nearest family hue. */
export function snapFamily(c: Rgb): RampFamily {
  const { h, s, l } = rgbToHsl(c);
  if (s < NEUTRAL_SATURATION || l < 0.06 || l > 0.95) return 'steel';
  let best: RampFamily = 'accent';
  let bestD = Infinity;
  for (const [family, hue] of Object.entries(FAMILY_HUES) as [RampFamily, number][]) {
    const d = hueDistance(h, hue);
    if (d < bestD) {
      bestD = d;
      best = family;
    }
  }
  return best;
}

/** The ramp shade with luminance closest to the colour's (for snapping single colours). */
export function nearestShade(c: Rgb, ramp: readonly string[]): string {
  const target = luminance(c);
  let best = ramp[0] as string;
  let bestD = Infinity;
  for (const hex of ramp) {
    const d = Math.abs(luminance(hexToRgb(hex)) - target);
    if (d < bestD) {
      bestD = d;
      best = hex;
    }
  }
  return best;
}

export interface DominantColor extends Rgb {
  /** Share of the pixels (0-1) in this colour's box. */
  weight: number;
}

/**
 * Dominant colours of an RGBA image by median cut: start with one box holding every opaque
 * pixel, repeatedly split the box with the widest channel range at its median, and return each
 * box's mean colour with its share of the pixels, most common first. Downscale the image first
 * (a 32x32 thumbnail is plenty); this is O(pixels x log k).
 */
export function medianCut(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  k: number,
): DominantColor[] {
  const pixels: Rgb[] = [];
  const n = Math.min(width * height, Math.floor(rgba.length / 4));
  for (let i = 0; i < n; i++) {
    if ((rgba[i * 4 + 3] as number) < 128) continue;
    pixels.push({
      r: rgba[i * 4] as number,
      g: rgba[i * 4 + 1] as number,
      b: rgba[i * 4 + 2] as number,
    });
  }
  if (pixels.length === 0 || k <= 0) return [];
  type Box = Rgb[];
  const range = (box: Box, ch: keyof Rgb): number => {
    let lo = 255;
    let hi = 0;
    for (const p of box) {
      lo = Math.min(lo, p[ch]);
      hi = Math.max(hi, p[ch]);
    }
    return hi - lo;
  };
  const boxes: Box[] = [pixels];
  while (boxes.length < k) {
    let pick = -1;
    let pickRange = 0;
    let pickCh: keyof Rgb = 'r';
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (const ch of ['r', 'g', 'b'] as const) {
        const r = range(box, ch);
        if (r > pickRange) {
          pickRange = r;
          pick = i;
          pickCh = ch;
        }
      }
    });
    if (pick < 0) break;
    const box = boxes[pick] as Box;
    const ch = pickCh;
    box.sort((a, b) => a[ch] - b[ch]);
    const half = box.length >> 1;
    boxes.splice(pick, 1, box.slice(0, half), box.slice(half));
  }
  const total = pixels.length;
  const means = boxes
    .map((box) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const p of box) {
        r += p.r;
        g += p.g;
        b += p.b;
      }
      return {
        r: r / box.length,
        g: g / box.length,
        b: b / box.length,
        weight: box.length / total,
      };
    })
    .filter((c) => c.weight > 0);
  // Median cut halves populations, so one big flat colour ends up in several boxes: merge boxes
  // whose colours are nearly the same, so the weights say how much of the picture a colour covers.
  const merged: DominantColor[] = [];
  for (const c of means) {
    const same = merged.find(
      (m) => (m.r - c.r) ** 2 + (m.g - c.g) ** 2 + (m.b - c.b) ** 2 < 24 * 24,
    );
    if (!same) {
      merged.push({ ...c });
      continue;
    }
    const w = same.weight + c.weight;
    same.r = (same.r * same.weight + c.r * c.weight) / w;
    same.g = (same.g * same.weight + c.g * c.weight) / w;
    same.b = (same.b * same.weight + c.b * c.weight) / w;
    same.weight = w;
  }
  return merged.sort((a, b) => b.weight - a.weight);
}

/**
 * A palette from a cover's pixels: the most common saturated colour picks the primary family,
 * the next family that differs picks the secondary (else the primary's partner). Greyscale
 * covers fall back to the accent.
 */
export function paletteFromPixels(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  ramps: RampSet,
): BackgroundPalette {
  const colours = medianCut(rgba, width, height, 8);
  const weights = new Map<RampFamily, number>();
  for (const c of colours) {
    const family = snapFamily(c);
    if (family === 'steel') continue;
    // Vivid colours count more than muddy ones of the same area.
    const { s } = rgbToHsl(c);
    weights.set(family, (weights.get(family) ?? 0) + c.weight * (0.5 + s));
  }
  const ranked = [...weights.entries()]
    .filter(([, w]) => w >= 0.04)
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);
  const primary = ranked[0] ?? 'accent';
  const secondary = ranked[1] ?? PARTNER[primary];
  return makePalette(primary, secondary, ramps);
}

/**
 * How striking a cover is, for the suggestion rules: colourfulness (Hasler-Suesstrunk, scaled
 * to about 0-1) and contrast (standard deviation of luminance, 0-~0.5).
 */
export interface CoverStats {
  colorfulness: number;
  contrast: number;
}

export function coverStats(rgba: ArrayLike<number>, width: number, height: number): CoverStats {
  const n = Math.min(width * height, Math.floor(rgba.length / 4));
  if (n === 0) return { colorfulness: 0, contrast: 0 };
  let sumRg = 0;
  let sumYb = 0;
  let sumRg2 = 0;
  let sumYb2 = 0;
  let sumL = 0;
  let sumL2 = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] as number;
    const g = rgba[i * 4 + 1] as number;
    const b = rgba[i * 4 + 2] as number;
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    sumRg += rg;
    sumYb += yb;
    sumRg2 += rg * rg;
    sumYb2 += yb * yb;
    const l = luminance({ r, g, b });
    sumL += l;
    sumL2 += l * l;
  }
  const mRg = sumRg / n;
  const mYb = sumYb / n;
  const sdRg = Math.sqrt(Math.max(0, sumRg2 / n - mRg * mRg));
  const sdYb = Math.sqrt(Math.max(0, sumYb2 / n - mYb * mYb));
  const colorfulness =
    Math.sqrt(sdRg * sdRg + sdYb * sdYb) + 0.3 * Math.sqrt(mRg * mRg + mYb * mYb);
  const mL = sumL / n;
  return {
    colorfulness: Math.min(1, colorfulness / 110),
    contrast: Math.sqrt(Math.max(0, sumL2 / n - mL * mL)),
  };
}

/**
 * The brightest pixel (by luminance) of an RGBA image within the columns `fromX`-`toX` (0-1 of
 * the width), as a hex colour: what a picture can show behind the lanes, for the readability
 * clamp. Black for an empty image.
 */
export function brightestInColumns(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  fromX = 0,
  toX = 1,
): string {
  const x0 = Math.max(0, Math.floor(fromX * width));
  const x1 = Math.min(width, Math.ceil(toX * width));
  let best: Rgb = { r: 0, g: 0, b: 0 };
  let bestL = -1;
  for (let y = 0; y < height; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const c = { r: rgba[i] as number, g: rgba[i + 1] as number, b: rgba[i + 2] as number };
      const l = luminance(c);
      if (l > bestL) {
        bestL = l;
        best = c;
      }
    }
  }
  return rgbToHex(best);
}
