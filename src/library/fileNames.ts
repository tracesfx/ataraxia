/** Pure helpers for file names going in and out of the library. */

/** Strip a final extension: `song.final.mp3` -> `song.final`. Dotfiles keep their name. */
export function stripExtension(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Lower-case extension without the dot, or '' if none. */
export function extensionOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** A song title guessed from an audio file name: no extension, underscores become spaces. */
export function titleFromFileName(fileName: string): string {
  const title = stripExtension(fileName).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return title === '' ? 'Untitled' : title;
}

/**
 * A name that is safe as a download or zip entry on every OS: no path separators or reserved
 * characters, no control characters, no trailing dots or spaces, at most 80 characters.
 */
export function safeFileName(name: string, fallback = 'untitled'): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return cleaned === '' ? fallback : cleaned;
}

/** Make each name unique by appending ` (2)`, ` (3)` ... before the extension. */
export function dedupeFileNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    const ext = extensionOf(name);
    const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      candidate = ext ? `${stem} (${n}).${ext}` : `${stem} (${n})`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
