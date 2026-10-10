/**
 * Waveform peak pyramid. Level 0 holds the min and max sample of every `baseBucket` samples;
 * each further level merges pairs of buckets of the level below, halving its length. To draw
 * any time range at any zoom, pick the coarsest level whose buckets are still no larger than
 * the range and merge the few buckets it spans: drawing cost depends on the screen height, not
 * on the song length.
 */

export interface PeakLevel {
  /** Samples per bucket at this level. */
  bucketSize: number;
  min: Float32Array;
  max: Float32Array;
}

export interface PeakPyramid {
  sampleRate: number;
  /** Total samples in the (mono) signal. */
  length: number;
  levels: PeakLevel[];
}

export const DEFAULT_BASE_BUCKET = 64;

/** Average the channels into one. All channels must have the same length. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const ch of channels) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (ch[i] as number);
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * scale;
  return out;
}

/** Build the pyramid. Linear in the signal length: about 1.03 passes over the samples. */
export function buildPeakPyramid(
  samples: Float32Array,
  sampleRate: number,
  baseBucket = DEFAULT_BASE_BUCKET,
): PeakPyramid {
  if (!Number.isInteger(baseBucket) || baseBucket < 1) {
    throw new RangeError(`Base bucket size must be a whole number >= 1, got ${baseBucket}`);
  }
  const length = samples.length;
  const count0 = Math.ceil(length / baseBucket);
  const min0 = new Float32Array(count0);
  const max0 = new Float32Array(count0);
  for (let b = 0; b < count0; b++) {
    const start = b * baseBucket;
    const end = Math.min(length, start + baseBucket);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end; i++) {
      const v = samples[i] as number;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min0[b] = lo;
    max0[b] = hi;
  }
  const levels: PeakLevel[] = [{ bucketSize: baseBucket, min: min0, max: max0 }];
  let prev = levels[0] as PeakLevel;
  while (prev.min.length > 1) {
    const count = Math.ceil(prev.min.length / 2);
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    for (let b = 0; b < count; b++) {
      const a = 2 * b;
      const c = a + 1 < prev.min.length ? a + 1 : a;
      min[b] = Math.min(prev.min[a] as number, prev.min[c] as number);
      max[b] = Math.max(prev.max[a] as number, prev.max[c] as number);
    }
    prev = { bucketSize: prev.bucketSize * 2, min, max };
    levels.push(prev);
  }
  return { sampleRate, length, levels };
}

/**
 * Min and max sample over [startSample, endSample) using the pyramid, or null if the range
 * lies outside the signal. The range is widened to whole buckets of the level used (at most
 * one bucket each side), which is invisible at drawing resolution. Ranges smaller than one
 * base bucket return that bucket's peaks.
 */
export function peakRange(
  pyramid: PeakPyramid,
  startSample: number,
  endSample: number,
): { min: number; max: number } | null {
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(pyramid.length, Math.max(start + 1, Math.ceil(endSample)));
  if (end <= start || endSample < 0 || pyramid.levels.length === 0) return null;
  const span = end - start;
  // Coarsest level whose buckets are no larger than the span (at most ~3 buckets to merge).
  let level = pyramid.levels[0] as PeakLevel;
  for (const l of pyramid.levels) {
    if (l.bucketSize <= span) level = l;
    else break;
  }
  const first = Math.floor(start / level.bucketSize);
  const last = Math.min(level.min.length - 1, Math.floor((end - 1) / level.bucketSize));
  let lo = Infinity;
  let hi = -Infinity;
  for (let b = first; b <= last; b++) {
    const mn = level.min[b] as number;
    const mx = level.max[b] as number;
    if (mn < lo) lo = mn;
    if (mx > hi) hi = mx;
  }
  return { min: lo, max: hi };
}

/** Every array in the pyramid, for transferring it out of a worker without copying. */
export function pyramidBuffers(pyramid: PeakPyramid): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const l of pyramid.levels)
    out.push(l.min.buffer as ArrayBuffer, l.max.buffer as ArrayBuffer);
  return out;
}
