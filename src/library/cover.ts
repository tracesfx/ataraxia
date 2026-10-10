import {
  COVER_SIZE,
  COVER_THUMB_SIZE,
  centerSquareCrop,
  clampCrop,
  downscaleSteps,
  type CropRect,
} from '../core/coverCrop';
import { extensionOf } from './fileNames';
import { LibraryError } from './repository';

/**
 * Song cover images: decode a picture (createImageBitmap), crop it to a square (centred, or the
 * user's crop), shrink it smoothly to 512x512 and 128x128, and encode both as WebP (PNG where the
 * browser can't encode WebP). The browser drawing layer sits behind `CoverBackend`, so tests can
 * replace it. Used by the player (package import) and the Studio (cover upload, audio artwork).
 */

/** Largest picture file accepted for a cover. */
export const MAX_COVER_FILE_BYTES = 25 * 1024 * 1024;
const WEBP_QUALITY = 0.9;

const COVER_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};
const COVER_MIME_TYPES = new Set(Object.values(COVER_MIME_BY_EXT));
/** For file pickers. */
export const COVER_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/avif,.png,.jpg,.jpeg,.webp,.gif,.avif';

/** A stored cover: the 512 px image and its 128 px thumbnail. */
export interface CoverImages {
  cover: Blob;
  coverThumb: Blob;
}

/** Anything with a size that the backend can draw from (a decoded image or a drawn surface). */
export interface CoverSurface {
  readonly width: number;
  readonly height: number;
}

export interface DecodedImage extends CoverSurface {
  close(): void;
}

/** The drawing layer: decoding, smoothed drawing and encoding. */
export interface CoverBackend {
  /** Decode a picture file; rejects when it isn't a picture this browser can read. */
  decode(blob: Blob): Promise<DecodedImage>;
  /** A new `size`x`size` surface with the `crop` region of `source` drawn smoothly into it. */
  draw(source: CoverSurface, crop: CropRect, size: number): CoverSurface;
  /** Encode a surface; browsers that can't produce `type` return PNG instead. */
  encode(surface: CoverSurface, type: string, quality: number): Promise<Blob>;
}

/** Is this a picture type covers accept (by MIME type, or by extension when that's missing)? */
export function isCoverImageFile(file: Blob, name = ''): boolean {
  if (file.type && COVER_MIME_TYPES.has(file.type.toLowerCase())) return true;
  if (file.type && file.type.startsWith('image/')) return false;
  return extensionOf(name) in COVER_MIME_BY_EXT;
}

/** Problems that make a file unusable as a cover before decoding it, as complete sentences. */
export function coverFileProblems(file: Blob, name = 'This file'): string[] {
  const label = name === 'This file' ? name : `"${name}"`;
  if (file.size === 0) return [`${label} is empty. Choose a PNG, JPEG, WebP, GIF or AVIF picture.`];
  if (file.size > MAX_COVER_FILE_BYTES) {
    return [
      `${label} is larger than ${MAX_COVER_FILE_BYTES / 1024 / 1024} MB. Choose a smaller picture, or shrink it in an image editor first.`,
    ];
  }
  if (!isCoverImageFile(file, name === 'This file' ? '' : name)) {
    return [`${label} is not a supported picture. Use a PNG, JPEG, WebP, GIF or AVIF file.`];
  }
  return [];
}

/** Decode a picture, failing with a LibraryError that says what to do. */
export async function decodeCoverImage(
  file: Blob,
  name = 'This file',
  backend: CoverBackend = browserCoverBackend,
): Promise<DecodedImage> {
  const problems = coverFileProblems(file, name);
  if (problems.length > 0) throw new LibraryError(problems);
  const label = name === 'This file' ? name : `"${name}"`;
  let image: DecodedImage;
  try {
    image = await backend.decode(file);
  } catch {
    throw new LibraryError([
      `${label} could not be read as a picture. It may be damaged, or this browser can't open this format (AVIF needs a recent browser). Try saving it as PNG or JPEG.`,
    ]);
  }
  if (!(image.width > 0 && image.height > 0)) {
    image.close();
    throw new LibraryError([`${label} has no pixels. Choose another picture.`]);
  }
  return image;
}

/** Shrink `crop` of `source` to `size` through steps of at most 2x (no aliasing). */
function shrink(
  backend: CoverBackend,
  source: CoverSurface,
  crop: CropRect,
  size: number,
): CoverSurface {
  const [first = size, ...rest] = downscaleSteps(crop.size, size);
  let surface = backend.draw(source, crop, first);
  for (const step of rest) {
    surface = backend.draw(surface, { x: 0, y: 0, size: surface.width }, step);
  }
  return surface;
}

async function encodeCover(backend: CoverBackend, surface: CoverSurface): Promise<Blob> {
  const webp = await backend.encode(surface, 'image/webp', WEBP_QUALITY);
  if (webp.type === 'image/webp' || webp.type === 'image/png') return webp;
  return backend.encode(surface, 'image/png', 1);
}

/** Make the stored cover and thumbnail from an already decoded image. Doesn't close it. */
export async function coverFromImage(
  image: CoverSurface,
  crop: CropRect | null = null,
  backend: CoverBackend = browserCoverBackend,
): Promise<CoverImages> {
  const rect = clampCrop(
    crop ?? centerSquareCrop(image.width, image.height),
    image.width,
    image.height,
  );
  const big = shrink(backend, image, rect, COVER_SIZE);
  const thumb = shrink(backend, big, { x: 0, y: 0, size: COVER_SIZE }, COVER_THUMB_SIZE);
  const [cover, coverThumb] = await Promise.all([
    encodeCover(backend, big),
    encodeCover(backend, thumb),
  ]);
  return { cover, coverThumb };
}

/**
 * Turn a picture file into a stored cover: validate (type, at most 25 MB), decode, crop (the
 * user's square, else the centred square), shrink and encode. Failures are LibraryErrors.
 */
export async function processCover(
  file: Blob,
  options: { name?: string; crop?: CropRect | null; backend?: CoverBackend } = {},
): Promise<CoverImages> {
  const backend = options.backend ?? browserCoverBackend;
  const image = await decodeCoverImage(file, options.name, backend);
  try {
    return await coverFromImage(image, options.crop ?? null, backend);
  } catch (err) {
    if (err instanceof LibraryError) throw err;
    throw new LibraryError([
      'The picture could not be converted into a cover. Try another picture, or save it as PNG or JPEG first.',
    ]);
  } finally {
    image.close();
  }
}

/**
 * A cover from a song package: a 512x512 WebP or PNG (what the game exports) is kept as it is
 * (no second lossy encode) and only gets a thumbnail; anything else is processed like an upload.
 */
export async function coverFromPackage(
  file: Blob,
  name: string,
  backend: CoverBackend = browserCoverBackend,
): Promise<CoverImages> {
  const image = await decodeCoverImage(file, name, backend);
  try {
    const keep =
      image.width === COVER_SIZE &&
      image.height === COVER_SIZE &&
      (file.type === 'image/webp' || file.type === 'image/png');
    if (!keep) return await coverFromImage(image, null, backend);
    const thumb = shrink(backend, image, { x: 0, y: 0, size: COVER_SIZE }, COVER_THUMB_SIZE);
    return { cover: file, coverThumb: await encodeCover(backend, thumb) };
  } finally {
    image.close();
  }
}

/** The file name a cover is stored under in a song package. */
export function coverEntryName(cover: Blob): string {
  return cover.type === 'image/png' ? 'cover.png' : 'cover.webp';
}

// --- Browser backend ---------------------------------------------------------------------------

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(size: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

export const browserCoverBackend: CoverBackend = {
  decode(blob) {
    return createImageBitmap(blob);
  },
  draw(source, crop, size) {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d') as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Canvas 2D is not available.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      source as CanvasImageSource,
      crop.x,
      crop.y,
      crop.size,
      crop.size,
      0,
      0,
      size,
      size,
    );
    return canvas;
  },
  encode(surface, type, quality) {
    const canvas = surface as AnyCanvas;
    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed.'))),
        type,
        quality,
      );
    });
  },
};
