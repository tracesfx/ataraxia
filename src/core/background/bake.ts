import type { ImageEffects } from './config';
import { rgbToHex } from './color';
import { medianCut } from './palette';

/**
 * Baking the base picture (pure, runs in a worker): blur, exposure, saturation, chromatic
 * aberration and bloom applied once to the picture at the background's render size, giving the
 * one bitmap the game draws every frame. Never per frame. Works in linear light on float planes;
 * pixel amounts are given at 1080 rows and scaled to the picture's height.
 *
 * Order: blur, exposure, saturation, chromatic aberration (channels split and offset), bloom (a
 * bright pass, a downsample chain of smooth halvings, each level softened, then upsampled and
 * added back).
 */

const DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  DECODE[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
const ENCODE_STEPS = 4096;
const ENCODE = new Uint8ClampedArray(ENCODE_STEPS + 1);
for (let i = 0; i <= ENCODE_STEPS; i++) {
  const l = i / ENCODE_STEPS;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  ENCODE[i] = Math.round(s * 255);
}

const encode = (v: number): number =>
  ENCODE[v <= 0 ? 0 : v >= 1 ? ENCODE_STEPS : Math.round(v * ENCODE_STEPS)] as number;

/** Horizontal box blur of radius `r` (clamped edges): src -> dst. */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))] as number;
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / n;
      const add = src[row + Math.min(w - 1, x + r + 1)] as number;
      const sub = src[row + Math.max(0, x - r)] as number;
      sum += add - sub;
    }
  }
}

/** Vertical box blur of radius `r` (clamped edges): src -> dst. */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const n = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[Math.min(h - 1, Math.max(0, k)) * w + x] as number;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / n;
      const add = src[Math.min(h - 1, y + r + 1) * w + x] as number;
      const sub = src[Math.max(0, y - r) * w + x] as number;
      sum += add - sub;
    }
  }
}

/** Box radii for three passes approximating a Gaussian of `sigma` (Kovesi). */
export function gaussBoxes(sigma: number): [number, number, number] {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  const r = (i: number): number => (((i < m ? wl : wu) - 1) / 2) | 0;
  return [r(0), r(1), r(2)];
}

/** Gaussian-like blur of one plane in place (three box passes each way). */
export function blurPlane(p: Float32Array, w: number, h: number, sigma: number): void {
  if (sigma < 0.5) return;
  const tmp = new Float32Array(p.length);
  for (const r of gaussBoxes(sigma)) {
    if (r <= 0) continue;
    boxH(p, tmp, w, h, r);
    boxV(tmp, p, w, h, r);
  }
}

/** Bilinear sample of a plane (clamped). */
function sample(p: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = p[y0 * w + x0] as number;
  const b = p[y0 * w + x1] as number;
  const c = p[y1 * w + x0] as number;
  const d = p[y1 * w + x1] as number;
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

interface Level {
  w: number;
  h: number;
  planes: [Float32Array, Float32Array, Float32Array];
}

/** Half-size copy (2x2 average, smooth). */
function halve(l: Level): Level {
  const w = Math.max(1, l.w >> 1);
  const h = Math.max(1, l.h >> 1);
  const planes = l.planes.map((src) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(l.h - 1, y * 2);
      const sy1 = Math.min(l.h - 1, sy + 1);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(l.w - 1, x * 2);
        const sx1 = Math.min(l.w - 1, sx + 1);
        out[y * w + x] =
          ((src[sy * l.w + sx] as number) +
            (src[sy * l.w + sx1] as number) +
            (src[sy1 * l.w + sx] as number) +
            (src[sy1 * l.w + sx1] as number)) /
          4;
      }
    }
    return out;
  }) as Level['planes'];
  return { w, h, planes };
}

/** `small` upsampled bilinearly and added into `big`. */
function addUpsampled(big: Level, small: Level, weight: number): void {
  const sx = small.w / big.w;
  const sy = small.h / big.h;
  for (let c = 0; c < 3; c++) {
    const dst = big.planes[c] as Float32Array;
    const src = small.planes[c] as Float32Array;
    for (let y = 0; y < big.h; y++) {
      const fy = (y + 0.5) * sy - 0.5;
      for (let x = 0; x < big.w; x++) {
        dst[y * big.w + x] =
          (dst[y * big.w + x] as number) +
          weight * sample(src, small.w, small.h, (x + 0.5) * sx - 0.5, fy);
      }
    }
  }
}

/**
 * Bloom: the parts brighter than `threshold` (soft knee), blurred over a downsample chain whose
 * length grows with `radius`, added back `amount` times.
 */
function bloom(
  planes: [Float32Array, Float32Array, Float32Array],
  w: number,
  h: number,
  amount: number,
  threshold: number,
  radius: number,
  scale: number,
): void {
  const knee = 0.15;
  const t = DECODE[Math.round(Math.min(1, Math.max(0, threshold)) * 255)] as number;
  const [r, g, b] = planes;
  const bright: Level['planes'] = [
    new Float32Array(w * h),
    new Float32Array(w * h),
    new Float32Array(w * h),
  ];
  for (let i = 0; i < w * h; i++) {
    const lr = r[i] as number;
    const lg = g[i] as number;
    const lb = b[i] as number;
    const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    const x = lum - t + knee;
    const soft = x <= 0 ? 0 : x >= 2 * knee ? lum - t : (x * x) / (4 * knee);
    const k = lum > 1e-6 ? Math.max(0, soft) / lum : 0;
    bright[0][i] = lr * k;
    bright[1][i] = lg * k;
    bright[2][i] = lb * k;
  }
  // Start at half size; deeper chains spread the glow further.
  const depth = Math.max(2, Math.round(2 + radius * 4 + Math.log2(Math.max(0.25, scale))));
  const chain: Level[] = [halve({ w, h, planes: bright })];
  for (let i = 1; i < depth; i++) {
    const last = chain[chain.length - 1] as Level;
    if (last.w <= 2 || last.h <= 2) break;
    chain.push(halve(last));
  }
  for (const l of chain) for (const p of l.planes) blurPlane(p, l.w, l.h, 1.2);
  for (let i = chain.length - 1; i > 0; i--) {
    addUpsampled(chain[i - 1] as Level, chain[i] as Level, 1);
  }
  const top = chain[0] as Level;
  const out: Level = {
    w,
    h,
    planes: [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)],
  };
  addUpsampled(out, top, amount / chain.length);
  for (let c = 0; c < 3; c++) {
    const dst = planes[c] as Float32Array;
    const add = out.planes[c] as Float32Array;
    for (let i = 0; i < w * h; i++) dst[i] = (dst[i] as number) + (add[i] as number);
  }
}

/** Is there anything to bake (otherwise the picture is used as it is)? */
export function hasBakedEffects(fx: ImageEffects, minBlur = 0): boolean {
  return (
    Math.max(fx.blur, minBlur) > 0 ||
    fx.exposure !== 0 ||
    fx.saturation !== 1 ||
    fx.chromatic > 0 ||
    fx.bloom > 0
  );
}

/**
 * Bake `fx` into an RGBA picture of `w`x`h` in place (alpha is left alone). `minBlur` raises the
 * blur radius (the cover base is always blurred).
 */
export function bakeImage(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  fx: ImageEffects,
  minBlur = 0,
): void {
  const n = w * h;
  const scale = h / 1080;
  const planes: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(n),
    new Float32Array(n),
    new Float32Array(n),
  ];
  const [r, g, b] = planes;
  for (let i = 0; i < n; i++) {
    r[i] = DECODE[rgba[i * 4] as number] as number;
    g[i] = DECODE[rgba[i * 4 + 1] as number] as number;
    b[i] = DECODE[rgba[i * 4 + 2] as number] as number;
  }
  const blur = Math.max(fx.blur, minBlur) * scale;
  if (blur >= 0.5) for (const p of planes) blurPlane(p, w, h, blur / 2);

  const gain = 2 ** fx.exposure;
  const sat = fx.saturation;
  if (gain !== 1 || sat !== 1) {
    for (let i = 0; i < n; i++) {
      const lr = (r[i] as number) * gain;
      const lg = (g[i] as number) * gain;
      const lb = (b[i] as number) * gain;
      const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      r[i] = Math.max(0, lum + (lr - lum) * sat);
      g[i] = Math.max(0, lum + (lg - lum) * sat);
      b[i] = Math.max(0, lum + (lb - lum) * sat);
    }
  }

  const shift = fx.chromatic * scale;
  if (shift >= 0.25) {
    const rs = r.slice();
    const bs = b.slice();
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const k = shift / Math.max(1, Math.hypot(cx, cy));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (fx.chromaticMode === 'horizontal') {
          r[i] = sample(rs, w, h, x - shift, y);
          b[i] = sample(bs, w, h, x + shift, y);
        } else {
          const dx = x - cx;
          const dy = y - cy;
          r[i] = sample(rs, w, h, cx + dx * (1 - k), cy + dy * (1 - k));
          b[i] = sample(bs, w, h, cx + dx * (1 + k), cy + dy * (1 + k));
        }
      }
    }
  }

  if (fx.bloom > 0) bloom(planes, w, h, fx.bloom, fx.bloomThreshold, fx.bloomRadius, scale);

  for (let i = 0; i < n; i++) {
    rgba[i * 4] = encode(r[i] as number);
    rgba[i * 4 + 1] = encode(g[i] as number);
    rgba[i * 4 + 2] = encode(b[i] as number);
  }
}

/**
 * The brightest colour in the columns from `left` to `right` (0-1 of the width), as #rrggbb: the
 * lane clamp darkens just enough that it ends up dark behind the lanes.
 */
export function brightestIn(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  left: number,
  right: number,
): string {
  const x0 = Math.max(0, Math.floor(left * w));
  const x1 = Math.min(w, Math.ceil(right * w));
  let best = -1;
  let br = 0;
  let bg = 0;
  let bb = 0;
  const step = Math.max(1, Math.round(h / 270));
  for (let y = 0; y < h; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4;
      const cr = DECODE[rgba[i] as number] as number;
      const cg = DECODE[rgba[i + 1] as number] as number;
      const cb = DECODE[rgba[i + 2] as number] as number;
      const lum = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
      if (lum > best) {
        best = lum;
        br = rgba[i] as number;
        bg = rgba[i + 1] as number;
        bb = rgba[i + 2] as number;
      }
    }
  }
  return rgbToHex({ r: br, g: bg, b: bb });
}

/**
 * Up to `k` colours for particles "from the base picture": the dominant colours (median cut on
 * a small sample), lifted so they read on a dark, dimmed background.
 */
export function tintColorsFromPixels(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  k: number,
): string[] {
  const sw = Math.min(w, 48);
  const sh = Math.max(1, Math.round((h * sw) / w));
  const small = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const si = (Math.floor((y * h) / sh) * w + Math.floor((x * w) / sw)) * 4;
      const di = (y * sw + x) * 4;
      small[di] = rgba[si] as number;
      small[di + 1] = rgba[si + 1] as number;
      small[di + 2] = rgba[si + 2] as number;
      small[di + 3] = 255;
    }
  }
  return medianCut(small, sw, sh, k).map((c) => {
    const top = Math.max(c.r, c.g, c.b, 1);
    const lift = Math.max(1, 235 / top);
    return rgbToHex({ r: c.r * lift, g: c.g * lift, b: c.b * lift });
  });
}
