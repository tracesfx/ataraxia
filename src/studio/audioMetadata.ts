/**
 * Tags embedded in an imported audio file (title, artist, artwork), read with `music-metadata`.
 * The library is loaded on first use only (its own chunk, Studio build only), and every failure
 * is swallowed: a file without tags, or tags the parser can't read, simply gives nothing.
 */

export interface AudioTags {
  title: string | null;
  artist: string | null;
  /** The front cover (or the first picture) as an image blob. */
  picture: Blob | null;
}

const NO_TAGS: AudioTags = { title: null, artist: null, picture: null };

function clean(text: string | undefined, maxLength: number): string | null {
  const t = text?.replace(/\s+/g, ' ').trim() ?? '';
  return t === '' ? null : t.slice(0, maxLength);
}

export async function readAudioTags(file: Blob): Promise<AudioTags> {
  try {
    const mm = await import('music-metadata');
    const { common } = await mm.parseBlob(file, { duration: false, skipCovers: false });
    const pic = mm.selectCover(common.picture);
    return {
      title: clean(common.title, 200),
      artist: clean(common.artist ?? common.albumartist, 200),
      picture:
        pic && pic.data.length > 0
          ? new Blob([pic.data.slice()], {
              type: pic.format.includes('/') ? pic.format : `image/${pic.format}`,
            })
          : null,
    };
  } catch (err) {
    console.info('No tags read from the audio file:', err);
    return NO_TAGS;
  }
}
