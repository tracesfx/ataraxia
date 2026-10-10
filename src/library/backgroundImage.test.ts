import { describe, expect, it } from 'vitest';
import { MAX_BACKGROUND_STORED_BYTES } from '../core/background/image';
import {
  backgroundEntryName,
  backgroundFileProblems,
  backgroundFromPackage,
  processBackgroundImage,
  type BackgroundImageBackend,
} from './backgroundImage';
import type { DecodedImage } from './cover';
import { LibraryError } from './repository';

/** Images of a fixed size; an encode is width x height x bytesPerPixel x quality bytes. */
function fakeBackend(o: {
  width: number;
  height: number;
  bytesPerPixel?: number;
  failDecode?: boolean;
}) {
  const draws: { w: number; h: number }[] = [];
  const encodes: { w: number; quality: number }[] = [];
  let closed = 0;
  const backend: BackgroundImageBackend = {
    decode() {
      if (o.failDecode) return Promise.reject(new Error('bad'));
      const image: DecodedImage = {
        width: o.width,
        height: o.height,
        close: () => {
          closed += 1;
        },
      };
      return Promise.resolve(image);
    },
    draw(_from, w, h) {
      draws.push({ w, h });
      return { width: w, height: h };
    },
    encode(surface, type, quality) {
      encodes.push({ w: surface.width, quality });
      const size = Math.round(surface.width * surface.height * (o.bytesPerPixel ?? 0.1) * quality);
      return Promise.resolve(new Blob([new Uint8Array(size)], { type }));
    },
  };
  return { backend, draws, encodes, closed: () => closed };
}

const jpeg = (size = 1000): Blob => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });

describe('background pictures', () => {
  it('shrinks smoothly (halving steps) to fit 1920x1080, keeping the aspect', async () => {
    const fake = fakeBackend({ width: 6000, height: 3000 });
    const blob = await processBackgroundImage(jpeg(), { backend: fake.backend });
    expect(blob.type).toBe('image/webp');
    expect(fake.draws.at(-1)).toEqual({ w: 1920, h: 960 });
    expect(fake.draws.map((d) => d.w)).toEqual([3000, 1920]);
    expect(fake.closed()).toBe(1);
  });

  it('never enlarges a small picture', async () => {
    const fake = fakeBackend({ width: 800, height: 600 });
    await processBackgroundImage(jpeg(), { backend: fake.backend });
    expect(fake.draws).toEqual([{ w: 800, h: 600 }]);
  });

  it('retries at lower quality, then smaller, to stay under the size limit', async () => {
    const fake = fakeBackend({ width: 1920, height: 1080, bytesPerPixel: 2 });
    const blob = await processBackgroundImage(jpeg(), { backend: fake.backend });
    expect(blob.size).toBeLessThanOrEqual(MAX_BACKGROUND_STORED_BYTES);
    expect(fake.encodes.length).toBeGreaterThan(1);
    const huge = fakeBackend({ width: 1920, height: 1080, bytesPerPixel: 50 });
    await expect(processBackgroundImage(jpeg(), { backend: huge.backend })).rejects.toThrow(
      /too detailed/,
    );
  });

  it('refuses empty, oversized, non-picture and unreadable files with complete sentences', async () => {
    expect(backgroundFileProblems(new Blob([]))[0]).toMatch(/empty/);
    expect(backgroundFileProblems(jpeg(26 * 1024 * 1024), 'big.jpg')[0]).toMatch(
      /larger than 25 MB/,
    );
    expect(
      backgroundFileProblems(new Blob([new Uint8Array(4)], { type: 'text/plain' }))[0],
    ).toMatch(/not a supported picture/);
    const err = await processBackgroundImage(jpeg(), {
      backend: fakeBackend({ width: 1, height: 1, failDecode: true }).backend,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryError);
  });

  it('keeps a fitting WebP from a package as it is, and reprocesses anything else', async () => {
    const fits = new Blob([new Uint8Array(100)], { type: 'image/webp' });
    const fake = fakeBackend({ width: 1920, height: 1080 });
    expect(await backgroundFromPackage(fits, 'background.webp', fake.backend)).toBe(fits);
    expect(fake.encodes).toEqual([]);
    const big = fakeBackend({ width: 4000, height: 2000 });
    const out = await backgroundFromPackage(fits, 'background.webp', big.backend);
    expect(out).not.toBe(fits);
    expect(big.draws.at(-1)).toEqual({ w: 1920, h: 960 });
    expect(backgroundEntryName(new Blob([], { type: 'image/png' }))).toBe('background.png');
    expect(backgroundEntryName(fits)).toBe('background.webp');
  });
});
