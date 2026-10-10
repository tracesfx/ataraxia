import {
  MAX_BACKGROUND_FILE_BYTES,
  MAX_BACKGROUND_STORED_BYTES,
  fitWithin,
  halvingSteps,
} from '../core/background/image';
import { isCoverImageFile, type DecodedImage } from './cover';
import { LibraryError } from './repository';

/**
 * Background pictures (the 'image' style in the Studio, and the player's custom background):
 * validate, decode, shrink smoothly to fit 1920x1080 (aspect kept, never enlarged), encode as
 * WebP (PNG where the browser can't), and keep the stored file under
 * MAX_BACKGROUND_STORED_BYTES by retrying at a lower quality, then a smaller size. The drawing
 * layer sits behind `BackgroundImageBackend`, so tests can replace it. Shared by both builds.
 */

export interface Surface {
  readonly width: number;
  readonly height: number;
}

export interface BackgroundImageBackend {
  decode(blob: Blob): Promise<DecodedImage>;
  /** A new `w`x`h` surface with all of `source` drawn smoothly into it. */
  draw(source: Surface, w: number, h: number): Surface;
  encode(surface: Surface, type: string, quality: number): Promise<Blob>;
}

/** Encoding attempts, in order: [quality, scale of the fitted size]. */
const ATTEMPTS: readonly (readonly [number, number])[] = [
  [0.86, 1],
  [0.72, 1],
  [0.72, 0.75],
  [0.6, 0.5],
];

/** Problems that make a file unusable as a background picture, as complete sentences. */
export function backgroundFileProblems(file: Blob, name = 'This file'): string[] {
  const label = name === 'This file' ? name : `"${name}"`;
  if (file.size === 0) return [`${label} is empty. Choose a PNG, JPEG, WebP, GIF or AVIF picture.`];
  if (file.size > MAX_BACKGROUND_FILE_BYTES) {
    return [
      `${label} is larger than ${MAX_BACKGROUND_FILE_BYTES / 1024 / 1024} MB. Choose a smaller picture, or shrink it in an image editor first.`,
    ];
  }
  if (!isCoverImageFile(file, name === 'This file' ? '' : name)) {
    return [`${label} is not a supported picture. Use a PNG, JPEG, WebP, GIF or AVIF file.`];
  }
  return [];
}

function shrink(backend: BackgroundImageBackend, source: Surface, w: number, h: number): Surface {
  let surface = source;
  for (const step of halvingSteps(source.width, w)) {
    const sh = step === w ? h : Math.max(1, Math.round((step * source.height) / source.width));
    surface = backend.draw(surface, step, sh);
  }
  return surface;
}

async function encodeFitted(backend: BackgroundImageBackend, image: Surface): Promise<Blob> {
  const fit = fitWithin(image.width, image.height);
  for (const [quality, scale] of ATTEMPTS) {
    const w = Math.max(1, Math.round(fit.width * scale));
    const h = Math.max(1, Math.round(fit.height * scale));
    const surface = shrink(backend, image, w, h);
    let blob = await backend.encode(surface, 'image/webp', quality);
    if (blob.type !== 'image/webp') blob = await backend.encode(surface, 'image/png', 1);
    if (blob.size <= MAX_BACKGROUND_STORED_BYTES) return blob;
  }
  throw new LibraryError([
    'This picture is too detailed to store as a background, even after shrinking it. Choose a simpler or smaller picture.',
  ]);
}

/** Turn a picture file into a stored background picture. Failures are LibraryErrors. */
export async function processBackgroundImage(
  file: Blob,
  options: { name?: string; backend?: BackgroundImageBackend } = {},
): Promise<Blob> {
  const backend = options.backend ?? browserBackgroundBackend;
  const name = options.name ?? 'This file';
  const problems = backgroundFileProblems(file, name);
  if (problems.length > 0) throw new LibraryError(problems);
  const label = name === 'This file' ? name : `"${name}"`;
  let image: DecodedImage;
  try {
    image = await backend.decode(file);
  } catch {
    throw new LibraryError([
      `${label} could not be read as a picture. It may be damaged, or this browser can't open this format. Try saving it as PNG or JPEG.`,
    ]);
  }
  try {
    if (!(image.width > 0 && image.height > 0)) {
      throw new LibraryError([`${label} has no pixels. Choose another picture.`]);
    }
    return await encodeFitted(backend, image);
  } catch (err) {
    if (err instanceof LibraryError) throw err;
    throw new LibraryError([
      'The picture could not be converted into a background. Try another picture, or save it as PNG or JPEG first.',
    ]);
  } finally {
    image.close();
  }
}

/**
 * A background picture from a song package: a WebP or PNG that already fits and is small enough
 * (what the game exports) is kept as it is; anything else is processed like an upload.
 */
export async function backgroundFromPackage(
  file: Blob,
  name: string,
  backend: BackgroundImageBackend = browserBackgroundBackend,
): Promise<Blob> {
  const fitsType = file.type === 'image/webp' || file.type === 'image/png';
  if (fitsType && file.size <= MAX_BACKGROUND_STORED_BYTES) {
    let image: DecodedImage | null = null;
    try {
      image = await backend.decode(file);
      const fit = fitWithin(image.width, image.height);
      if (image.width > 0 && fit.width === image.width && fit.height === image.height) return file;
    } catch {
      // Reported by processBackgroundImage below.
    } finally {
      image?.close();
    }
  }
  return processBackgroundImage(file, { name, backend });
}

/** The file name a background picture is stored under in a song package. */
export function backgroundEntryName(image: Blob): string {
  return image.type === 'image/png' ? 'background.png' : 'background.webp';
}

// --- Browser backend ---------------------------------------------------------------------------

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export const browserBackgroundBackend: BackgroundImageBackend = {
  decode(blob) {
    return createImageBitmap(blob);
  },
  draw(source, w, h) {
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d') as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Canvas 2D is not available.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
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
