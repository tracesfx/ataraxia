import { describe, expect, it } from 'vitest';
import {
  bufferText,
  codeBuffer,
  thresholdGlyphPixels,
  writeClock,
  writeInt,
  writePercent,
  writeSignedMs,
} from './glyphMask';

describe('thresholdGlyphPixels', () => {
  it('leaves only fully transparent or fully opaque pixels', () => {
    // An anti-aliased edge: every alpha level 0..255 with coloured channels.
    const data = new Uint8ClampedArray(256 * 4);
    for (let a = 0; a < 256; a++) {
      data[a * 4] = 200;
      data[a * 4 + 1] = 17;
      data[a * 4 + 2] = 90;
      data[a * 4 + 3] = a;
    }
    const on = thresholdGlyphPixels(data);
    expect(on).toBe(128);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      expect(a === 0 || a === 255).toBe(true);
      // Opaque pixels are white (tinted on blit); transparent ones carry no colour.
      expect(data[i]).toBe(a);
      expect(data[i + 1]).toBe(a);
      expect(data[i + 2]).toBe(a);
    }
  });
});

describe('number formatting into code buffers', () => {
  const buf = codeBuffer(12);

  it('formats timing errors with the debug overlay sign convention', () => {
    expect(bufferText(writeSignedMs(buf, 60))).toBe('+60');
    expect(bufferText(writeSignedMs(buf, -34))).toBe('-34');
    expect(bufferText(writeSignedMs(buf, 59.6))).toBe('+60');
    expect(bufferText(writeSignedMs(buf, -0.4))).toBe('0');
    expect(bufferText(writeSignedMs(buf, 0))).toBe('0');
    expect(bufferText(writeSignedMs(buf, -120))).toBe('-120');
  });

  it('formats integers, percentages and clocks', () => {
    expect(bufferText(writeInt(buf, 0))).toBe('0');
    expect(bufferText(writeInt(buf, 1_000_000))).toBe('1000000');
    expect(bufferText(writePercent(buf, 9876))).toBe('98.76%');
    expect(bufferText(writePercent(buf, 10000))).toBe('100.00%');
    expect(bufferText(writePercent(buf, 5))).toBe('0.05%');
    expect(bufferText(writeClock(buf, 0))).toBe('0:00');
    expect(bufferText(writeClock(buf, 83))).toBe('1:23');
    expect(bufferText(writeClock(buf, -2))).toBe('-0:02');
  });

  it('never writes past the buffer', () => {
    const small = codeBuffer(3);
    expect(bufferText(writeInt(small, 123456))).toBe('123');
    expect(small.length).toBe(3);
  });
});
