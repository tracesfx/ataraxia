/**
 * Type-to-search for the song list. Pure: matches a query against song titles, artists and
 * chart difficulties. Case and accents are ignored; every word of the query must match
 * somewhere (in any order). An empty query matches everything.
 */

export interface Searchable {
  title: string;
  artist: string;
  /** Extra words to match (chart difficulty names, charters). */
  extra?: readonly string[];
}

export function normalizeSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesSearch(item: Searchable, query: string): boolean {
  const words = normalizeSearch(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeSearch([item.title, item.artist, ...(item.extra ?? [])].join(' '));
  return words.every((w) => haystack.includes(w));
}

/** Indices of the items that match, in their original order. */
export function filterIndices(items: readonly Searchable[], query: string): number[] {
  const out: number[] = [];
  items.forEach((item, i) => {
    if (matchesSearch(item, query)) out.push(i);
  });
  return out;
}
