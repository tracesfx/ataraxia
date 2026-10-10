import { describe, expect, it } from 'vitest';
import { filterIndices, matchesSearch, normalizeSearch } from './songSearch';

const songs = [
  { title: 'Still Water', artist: 'Lumen', extra: ['Normal', 'Hard'] },
  { title: 'Café Nocturne', artist: 'Ö. Berg', extra: ['Easy'] },
  { title: 'Drift', artist: 'Still Lake', extra: [] },
];

describe('song search', () => {
  it('matches everything for an empty or blank query', () => {
    expect(filterIndices(songs, '')).toEqual([0, 1, 2]);
    expect(filterIndices(songs, '   ')).toEqual([0, 1, 2]);
  });

  it('ignores case and accents', () => {
    expect(normalizeSearch('  Café  NOCTURNE ')).toBe('cafe nocturne');
    expect(filterIndices(songs, 'cafe')).toEqual([1]);
    expect(filterIndices(songs, 'berg')).toEqual([1]);
  });

  it('matches titles, artists and difficulties, keeping list order', () => {
    expect(filterIndices(songs, 'still')).toEqual([0, 2]);
    expect(filterIndices(songs, 'hard')).toEqual([0]);
  });

  it('needs every word, in any order', () => {
    expect(matchesSearch(songs[0]!, 'water still')).toBe(true);
    expect(matchesSearch(songs[0]!, 'water drift')).toBe(false);
    expect(filterIndices(songs, 'zzz')).toEqual([]);
  });
});
