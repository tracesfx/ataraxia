import { describe, expect, it } from 'vitest';
import { FFT } from './fft';

function naiveDft(re: number[]): { re: number[]; im: number[] } {
  const n = re.length;
  const outRe: number[] = [];
  const outIm: number[] = [];
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      sr += re[t]! * Math.cos((2 * Math.PI * k * t) / n);
      si -= re[t]! * Math.sin((2 * Math.PI * k * t) / n);
    }
    outRe.push(sr);
    outIm.push(si);
  }
  return { re: outRe, im: outIm };
}

describe('FFT', () => {
  it('matches a naive DFT', () => {
    const input = Array.from({ length: 16 }, (_, i) => Math.sin(i * 0.7) + (i % 3) * 0.25);
    const re = Float64Array.from(input);
    const im = new Float64Array(16);
    new FFT(16).forward(re, im);
    const expected = naiveDft(input);
    for (let k = 0; k < 16; k++) {
      expect(re[k]).toBeCloseTo(expected.re[k]!, 9);
      expect(im[k]).toBeCloseTo(expected.im[k]!, 9);
    }
  });

  it('puts a pure tone in its bin', () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
    const im = new Float64Array(n);
    new FFT(n).forward(re, im);
    expect(Math.hypot(re[5]!, im[5]!)).toBeCloseTo(n / 2, 9);
    expect(Math.hypot(re[6]!, im[6]!)).toBeCloseTo(0, 9);
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => new FFT(12)).toThrow(RangeError);
    expect(() => new FFT(1)).toThrow(RangeError);
    expect(() => new FFT(8).forward(new Float64Array(4), new Float64Array(4))).toThrow(RangeError);
  });
});
