/**
 * In-place radix-2 complex FFT for one fixed size. Twiddles and the bit-reversal table are
 * computed once, so transforming many frames of the same size (onset detection) is cheap.
 */
export class FFT {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reversed: Uint32Array;

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new RangeError(`FFT size must be a power of two >= 2, got ${size}`);
    }
    const half = size / 2;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reversed[i] = r;
    }
  }

  /** Forward transform of (re, im), in place. Both arrays must have `size` elements. */
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) {
      throw new RangeError(`FFT input must have ${n} elements`);
    }
    const rev = this.reversed;
    for (let i = 0; i < n; i++) {
      const j = rev[i] as number;
      if (j > i) {
        const tr = re[i] as number;
        re[i] = re[j] as number;
        re[j] = tr;
        const ti = im[i] as number;
        im[i] = im[j] as number;
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len *= 2) {
      const halfLen = len / 2;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < halfLen; k++) {
          const wr = this.cos[k * step] as number;
          const wi = this.sin[k * step] as number;
          const a = start + k;
          const b = a + halfLen;
          const br = re[b] as number;
          const bi = im[b] as number;
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          const ar = re[a] as number;
          const ai = im[a] as number;
          re[b] = ar - xr;
          im[b] = ai - xi;
          re[a] = ar + xr;
          im[a] = ai + xi;
        }
      }
    }
  }
}
