/** Small numeric helpers for analysis curves (Float32Array per frame). */

/** The q-quantile (0-1) of a curve, or of its values where `include` is true. */
export function quantile(
  values: ArrayLike<number>,
  q: number,
  include?: (i: number) => boolean,
): number {
  const picked: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!include || include(i)) picked.push(values[i] as number);
  }
  if (picked.length === 0) return 0;
  picked.sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (picked.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(picked.length - 1, lo + 1);
  return (picked[lo] as number) + ((picked[hi] as number) - (picked[lo] as number)) * (pos - lo);
}

/**
 * Rescale so the `loQ` quantile maps to 0 and the `hiQ` quantile to 1, clamped to 0-1 (the
 * song-relative normalisation every intensity component uses). A flat curve becomes all 0.
 */
export function normalizeByQuantiles(
  values: Float32Array,
  loQ: number,
  hiQ: number,
  include?: (i: number) => boolean,
): Float32Array {
  const lo = quantile(values, loQ, include);
  const hi = quantile(values, hiQ, include);
  const out = new Float32Array(values.length);
  const span = hi - lo;
  if (!(span > 1e-9)) return out;
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.min(1, Math.max(0, ((values[i] as number) - lo) / span));
  }
  return out;
}

/** Centred moving average over `half` frames each side (shorter at the edges). */
export function movingAverage(values: Float32Array, half: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const h = Math.max(0, Math.round(half));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] as number) + (values[i] as number);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - h);
    const hi = Math.min(n - 1, i + h);
    out[i] = ((prefix[hi + 1] as number) - (prefix[lo] as number)) / (hi - lo + 1);
  }
  return out;
}

/** Centred moving maximum over `half` frames each side. */
export function movingMax(values: Float32Array, half: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const h = Math.max(0, Math.round(half));
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - h); k <= Math.min(n - 1, i + h); k++) {
      m = Math.max(m, values[k] as number);
    }
    out[i] = m;
  }
  return out;
}

/**
 * Least-squares slope of values[from..to] per frame (0 for fewer than two frames). Used for
 * "rising steadily": the slope times the window length is the rise across it.
 */
export function slope(values: Float32Array, from: number, to: number): number {
  const lo = Math.max(0, from);
  const hi = Math.min(values.length - 1, to);
  const count = hi - lo + 1;
  if (count < 2) return 0;
  const meanX = (lo + hi) / 2;
  let meanY = 0;
  for (let i = lo; i <= hi; i++) meanY += values[i] as number;
  meanY /= count;
  let num = 0;
  let den = 0;
  for (let i = lo; i <= hi; i++) {
    const dx = i - meanX;
    num += dx * ((values[i] as number) - meanY);
    den += dx * dx;
  }
  return den > 0 ? num / den : 0;
}

/** Mean of values[from..to] (clamped; 0 for an empty range). */
export function mean(values: Float32Array, from: number, to: number): number {
  const lo = Math.max(0, from);
  const hi = Math.min(values.length - 1, to);
  if (hi < lo) return 0;
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += values[i] as number;
  return sum / (hi - lo + 1);
}

/** Pearson correlation of two equally long series (0 when either is flat). */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
