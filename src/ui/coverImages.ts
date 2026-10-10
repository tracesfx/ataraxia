import type { CoverRef } from '../library/songLibrary';

/**
 * Object URLs and decoded bitmaps for song covers, shared by every screen.
 *
 * Covers are stored as blobs; showing one in an <img> needs an object URL, which holds the blob
 * in memory until revoked. URLs are cached by cover key (song id + last update, so a changed
 * cover gets a new key) in two small LRU caches, thumbnails (song lists) and full covers (detail
 * panels, editor, results). An evicted or forgotten URL is revoked after a grace period, long
 * enough for any <img> still loading it to finish; an image that has loaded keeps its pixels
 * after the revoke. Decoded thumbnails (ImageBitmap, for canvas drawing such as the ambient
 * backdrop) have their own small cache and are closed on eviction.
 */

const REVOKE_DELAY_MS = 30_000;

class UrlCache {
  private readonly urls = new Map<string, string>();

  constructor(private readonly limit: number) {}

  get(key: string, blob: Blob): string {
    let url = this.urls.get(key);
    if (url !== undefined) {
      // Most recently used last.
      this.urls.delete(key);
      this.urls.set(key, url);
      return url;
    }
    url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    while (this.urls.size > this.limit) {
      const [oldest] = this.urls.keys();
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    return url;
  }

  /** Revoke (after the grace period) every URL whose key matches. */
  forget(match: (key: string) => boolean): void {
    for (const key of [...this.urls.keys()]) if (match(key)) this.drop(key);
  }

  private drop(key: string): void {
    const url = this.urls.get(key);
    this.urls.delete(key);
    if (url !== undefined) setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

const thumbUrls = new UrlCache(400);
const fullUrls = new UrlCache(8);
const BITMAP_LIMIT = 12;
const bitmaps = new Map<string, Promise<ImageBitmap>>();

/** Object URL of a cover's 128 px thumbnail. */
export function coverThumbUrl(cover: CoverRef): string {
  return thumbUrls.get(cover.key, cover.thumb);
}

/** Object URL of a cover's 512 px image. */
export function coverFullUrl(cover: CoverRef): string {
  return fullUrls.get(cover.key, cover.full);
}

/** The decoded thumbnail (cached; rejects when it can't be decoded). */
export function coverThumbBitmap(cover: CoverRef): Promise<ImageBitmap> {
  let loading = bitmaps.get(cover.key);
  if (loading) {
    bitmaps.delete(cover.key);
    bitmaps.set(cover.key, loading);
    return loading;
  }
  loading = createImageBitmap(cover.thumb);
  bitmaps.set(cover.key, loading);
  loading.catch(() => {
    if (bitmaps.get(cover.key) === loading) bitmaps.delete(cover.key);
  });
  while (bitmaps.size > BITMAP_LIMIT) {
    const [oldest] = bitmaps.keys();
    if (oldest === undefined) break;
    closeBitmap(oldest);
  }
  return loading;
}

function closeBitmap(key: string): void {
  const loading = bitmaps.get(key);
  bitmaps.delete(key);
  loading?.then(
    (b) => b.close(),
    () => undefined,
  );
}

/** Drop every cached URL and bitmap of a song (its cover changed, or it was deleted). */
export function forgetSongCovers(songId: string): void {
  const match = (key: string): boolean => key.startsWith(`${songId}@`);
  thumbUrls.forget(match);
  fullUrls.forget(match);
  for (const key of [...bitmaps.keys()]) if (match(key)) closeBitmap(key);
}
