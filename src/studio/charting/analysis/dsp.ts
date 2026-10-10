/**
 * Small signal helpers for the chart analysis: sliding medians (for harmonic/percussive
 * separation), moving means and maxima, quantiles of large arrays. Allocation happens once per
 * call, never per sample.
 */

/**
 * Median filter of the sequence seq(i) = src[offset + i * stride], i in [0, n), over a window of
 * `half` items each side (values outside the sequence count as 0), written to
 * out[offset + i * stride]. A sorted window is kept and updated incrementally, so the cost per
 * item is about the window length in memory moves, not a sort.
 */
export function medianFilter(
  src: Float32Array,
  out: Float32Array,
  n: number,
  stride: number,
  offset: number,
  half: number,
  win: Float64Array,
): void {
  const k = 2 * half + 1;
  const at = (i: number): number => (i < 0 || i >= n ? 0 : (src[offset + i * stride] as number));
  for (let j = 0; j < k; j++) win[j] = at(j - half);
  win.subarray(0, k).sort();
  for (let i = 0; i < n; i++) {
    out[offset + i * stride] = win[half] as number;
    if (i === n - 1) break;
    // Slide: drop seq(i - half), add seq(i + half + 1).
    const drop = at(i - half);
    const add = at(i + half + 1);
    if (drop === add) continue;
    let pos = lowerBound(win, k, drop);
    // Remove at pos.
    win.copyWithin(pos, pos + 1, k);
    // Insert `add` into the first k - 1 items.
    pos = lowerBound(win, k - 1, add);
    win.copyWithin(pos + 1, pos, k - 1);
    win[pos] = add;
  }
}

/** First index in a[0..len) whose value is >= v (a sorted ascending). */
function lowerBound(a: Float64Array, len: number, v: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((a[mid] as number) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Prefix sums (length n + 1) for O(1) window means. */
export function prefixSums(values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) out[i + 1] = (out[i] as number) + (values[i] as number);
  return out;
}

/** Mean of values[lo..hi] (inclusive, clamped) from prefix sums. */
export function windowMean(prefix: Float64Array, lo: number, hi: number): number {
  const n = prefix.length - 1;
  const a = Math.max(0, lo);
  const b = Math.min(n - 1, hi);
  if (b < a) return 0;
  return ((prefix[b + 1] as number) - (prefix[a] as number)) / (b - a + 1);
}

/**
 * Centred moving maximum over `half` items each side in O(n) (a monotonic deque), for long
 * windows on long curves.
 */
export function slidingMax(values: Float32Array, half: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const h = Math.max(0, Math.round(half));
  const dq = new Int32Array(n + 1);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + h);
    while (next <= hi) {
      const v = values[next] as number;
      while (tail > head && (values[dq[tail - 1] as number] as number) <= v) tail--;
      dq[tail++] = next;
      next++;
    }
    while ((dq[head] as number) < i - h) head++;
    out[i] = values[dq[head] as number] as number;
  }
  return out;
}

/** The q-quantile of values (every `step`-th value, for speed on long arrays). */
export function quantileOf(
  values: ArrayLike<number>,
  q: number,
  step = 1,
  include?: (v: number) => boolean,
): number {
  const picked: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    const v = values[i] as number;
    if (!include || include(v)) picked.push(v);
  }
  if (picked.length === 0) return 0;
  picked.sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (picked.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(picked.length - 1, lo + 1);
  return (picked[lo] as number) + ((picked[hi] as number) - (picked[lo] as number)) * (pos - lo);
}

/** Centred box smoothing over `half` items each side. */
export function boxSmooth(values: Float32Array, half: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const prefix = prefixSums(values);
  const h = Math.max(0, Math.round(half));
  for (let i = 0; i < n; i++) out[i] = windowMean(prefix, i - h, i + h);
  return out;
}

/** Map to 0-1 by dividing by the q-quantile (clamped); a silent curve stays 0. */
export function scaleByQuantile(values: Float32Array, q: number): Float32Array {
  const top = quantileOf(values, q, Math.max(1, Math.floor(values.length / 20000)));
  const out = new Float32Array(values.length);
  if (!(top > 1e-12)) return out;
  for (let i = 0; i < values.length; i++) out[i] = Math.min(1, (values[i] as number) / top);
  return out;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
