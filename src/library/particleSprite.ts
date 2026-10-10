import { MAX_SPRITE_BYTES, MAX_SPRITE_SIZE } from '../core/background/emitter';
import { LibraryError } from './repository';

/**
 * Custom particle sprites (Studio uploads and the sprite editor, package import): a PNG of at
 * most 64x64 pixels and 256 KB, kept exactly as it is. Shared by both builds (the player imports
 * them with song packages).
 */

/** Problems that make a file unusable as a sprite, as complete sentences. */
export function spriteFileProblems(file: Blob, name = 'This file'): string[] {
  const label = name === 'This file' ? name : `"${name}"`;
  if (file.size === 0) return [`${label} is empty. Choose a PNG picture.`];
  if (file.size > MAX_SPRITE_BYTES) {
    return [
      `${label} is larger than ${MAX_SPRITE_BYTES / 1024} KB. Sprites are small pictures: save it at most ${MAX_SPRITE_SIZE}x${MAX_SPRITE_SIZE} pixels.`,
    ];
  }
  const type = file.type;
  if (type !== '' && type !== 'image/png') {
    return [`${label} is not a PNG picture. Save the sprite as PNG and try again.`];
  }
  return [];
}

/** Check a PNG and its size; returns it as a PNG blob. Failures are LibraryErrors. */
export async function processSpriteFile(file: Blob, name = 'This file'): Promise<Blob> {
  const problems = spriteFileProblems(file, name);
  if (problems.length > 0) throw new LibraryError(problems);
  const label = name === 'This file' ? name : `"${name}"`;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new LibraryError([`${label} could not be read as a PNG picture. It may be damaged.`]);
  }
  try {
    if (bitmap.width > MAX_SPRITE_SIZE || bitmap.height > MAX_SPRITE_SIZE) {
      throw new LibraryError([
        `${label} is ${bitmap.width}x${bitmap.height} pixels; sprites are at most ${MAX_SPRITE_SIZE}x${MAX_SPRITE_SIZE}. Shrink it in an image editor, or draw it in the sprite editor.`,
      ]);
    }
  } finally {
    bitmap.close();
  }
  return file.type === 'image/png'
    ? file
    : new Blob([await file.arrayBuffer()], { type: 'image/png' });
}
