import { describe, expect, it } from 'vitest';
import type { CropRect } from '../core/coverCrop';
import {
  MAX_COVER_FILE_BYTES,
  coverEntryName,
  coverFromPackage,
  coverFileProblems,
  isCoverImageFile,
  processCover,
  type CoverBackend,
  type CoverSurface,
  type DecodedImage,
} from './cover';
import { LibraryError } from './repository';

interface Draw {
  from: CoverSurface;
  crop: CropRect;
  size: number;
}

/** A fake drawing layer: images have a fixed size, surfaces remember their size. */
function fakeBackend(o: { width: number; height: number; webp?: boolean; failDecode?: boolean }) {
  const draws: Draw[] = [];
  const encodes: { size: number; type: string }[] = [];
  let closed = 0;
  const backend: CoverBackend = {
    decode() {
      if (o.failDecode) return Promise.reject(new Error('bad image'));
      const image: DecodedImage = {
        width: o.width,
        height: o.height,
        close: () => {
          closed += 1;
        },
      };
      return Promise.resolve(image);
    },
    draw(from, crop, size) {
      draws.push({ from, crop, size });
      return { width: size, height: size };
    },
    encode(surface, type) {
      const actual = type === 'image/webp' && o.webp === false ? 'image/png' : type;
      encodes.push({ size: surface.width, type: actual });
      return Promise.resolve(new Blob([new Uint8Array(surface.width)], { type: actual }));
    },
  };
  return { backend, draws, encodes, closed: () => closed };
}

const jpeg = (bytes = 10): Blob => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });

describe('processCover', () => {
  it('centre-crops a landscape picture and makes a 512 cover and 128 thumbnail as WebP', async () => {
    const fake = fakeBackend({ width: 1600, height: 900 });
    const out = await processCover(jpeg(), { backend: fake.backend });
    expect(fake.draws[0]?.crop).toEqual({ x: 350, y: 0, size: 900 });
    expect(fake.draws[0]?.size).toBe(512);
    expect(out.cover.type).toBe('image/webp');
    expect(out.coverThumb.type).toBe('image/webp');
    expect(out.cover.size).toBe(512);
    expect(out.coverThumb.size).toBe(128);
    expect(fake.closed()).toBe(1);
  });

  it('centre-crops a portrait picture', async () => {
    const fake = fakeBackend({ width: 600, height: 1000 });
    await processCover(jpeg(), { backend: fake.backend });
    expect(fake.draws[0]?.crop).toEqual({ x: 0, y: 200, size: 600 });
  });

  it("uses the user's crop, clamped into the picture", async () => {
    const fake = fakeBackend({ width: 1000, height: 800 });
    await processCover(jpeg(), { backend: fake.backend, crop: { x: 900, y: -20, size: 300 } });
    expect(fake.draws[0]?.crop).toEqual({ x: 700, y: 0, size: 300 });
  });

  it('shrinks large pictures in steps of at most 2x', async () => {
    const fake = fakeBackend({ width: 4000, height: 4000 });
    await processCover(jpeg(), { backend: fake.backend });
    expect(fake.draws.map((d) => d.size)).toEqual([2000, 1000, 512, 256, 128]);
    // Later steps draw the whole previous surface.
    expect(fake.draws[1]?.crop).toEqual({ x: 0, y: 0, size: 2000 });
  });

  it('scales small pictures up to 512 in one smooth draw', async () => {
    const fake = fakeBackend({ width: 100, height: 60 });
    const out = await processCover(jpeg(), { backend: fake.backend });
    expect(fake.draws[0]).toMatchObject({ crop: { x: 20, y: 0, size: 60 }, size: 512 });
    expect(out.cover.size).toBe(512);
  });

  it('falls back to PNG when the browser cannot encode WebP', async () => {
    const fake = fakeBackend({ width: 512, height: 512, webp: false });
    const out = await processCover(jpeg(), { backend: fake.backend });
    expect(out.cover.type).toBe('image/png');
    expect(out.coverThumb.type).toBe('image/png');
    expect(coverEntryName(out.cover)).toBe('cover.png');
  });

  it('rejects files that do not decode, and still closes nothing it did not open', async () => {
    const fake = fakeBackend({ width: 1, height: 1, failDecode: true });
    const err = await processCover(jpeg(), { backend: fake.backend, name: 'x.jpg' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).errors[0]).toMatch(/"x\.jpg" could not be read as a picture/);
    expect(fake.draws).toHaveLength(0);
  });

  it('rejects zero-sized images', async () => {
    const fake = fakeBackend({ width: 0, height: 10 });
    await expect(processCover(jpeg(), { backend: fake.backend })).rejects.toThrow(/no pixels/);
    expect(fake.closed()).toBe(1);
  });

  it('rejects files over 25 MB before decoding them', async () => {
    const fake = fakeBackend({ width: 10, height: 10 });
    const big = { size: MAX_COVER_FILE_BYTES + 1, type: 'image/png' } as Blob;
    await expect(processCover(big, { backend: fake.backend })).rejects.toThrow(/larger than 25 MB/);
    expect(fake.draws).toHaveLength(0);
  });
});

describe('cover file checks', () => {
  it('accepts the supported picture types by MIME type or extension', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']) {
      expect(isCoverImageFile(new Blob([], { type }))).toBe(true);
    }
    expect(isCoverImageFile(new Blob([]), 'art.JPG')).toBe(true);
    expect(isCoverImageFile(new Blob([]), 'art.avif')).toBe(true);
  });

  it('refuses other types', () => {
    expect(isCoverImageFile(new Blob([], { type: 'image/svg+xml' }), 'a.svg')).toBe(false);
    expect(isCoverImageFile(new Blob([], { type: 'image/bmp' }), 'a.png')).toBe(false);
    expect(isCoverImageFile(new Blob([]), 'notes.txt')).toBe(false);
    expect(coverFileProblems(new Blob([new Uint8Array(3)]), 'notes.txt')[0]).toMatch(
      /not a supported picture/,
    );
  });

  it('refuses empty files', () => {
    expect(coverFileProblems(new Blob([], { type: 'image/png' }))[0]).toMatch(/is empty/);
  });
});

describe('coverFromPackage', () => {
  it('keeps a 512x512 WebP as it is and only makes the thumbnail', async () => {
    const fake = fakeBackend({ width: 512, height: 512 });
    const file = new Blob([new Uint8Array(7)], { type: 'image/webp' });
    const out = await coverFromPackage(file, 'cover.webp', fake.backend);
    expect(out.cover).toBe(file);
    expect(out.coverThumb.size).toBe(128);
    expect(fake.encodes).toEqual([{ size: 128, type: 'image/webp' }]);
  });

  it('processes covers of any other size like an upload', async () => {
    const fake = fakeBackend({ width: 1000, height: 700 });
    const out = await coverFromPackage(
      new Blob([new Uint8Array(7)], { type: 'image/webp' }),
      'cover.webp',
      fake.backend,
    );
    expect(out.cover.size).toBe(512);
    expect(fake.draws[0]?.crop).toEqual({ x: 150, y: 0, size: 700 });
  });

  it('rejects a corrupt cover', async () => {
    const fake = fakeBackend({ width: 1, height: 1, failDecode: true });
    await expect(
      coverFromPackage(
        new Blob([new Uint8Array(7)], { type: 'image/webp' }),
        'cover.webp',
        fake.backend,
      ),
    ).rejects.toBeInstanceOf(LibraryError);
  });
});
