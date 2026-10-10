import { describe, expect, it } from 'vitest';

/**
 * Seeded determinism: nothing on the generation path may use Math.random (ESLint enforces it too,
 * see eslint.config.js). All randomness comes from the seeded Rng in src/core/random.ts.
 */
const sources = import.meta.glob<string>(
  [
    '/src/core/analysis/**/*.ts',
    '/src/studio/charting/**/*.ts',
    '/src/core/random.ts',
    '!**/*.test.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
);

describe('generation path', () => {
  it('covers the analysis, the generator and the random source', () => {
    const files = Object.keys(sources);
    expect(files).toContain('/src/core/random.ts');
    expect(files).toContain('/src/studio/charting/generate.ts');
    expect(files.some((f) => f.startsWith('/src/core/analysis/'))).toBe(true);
  });

  it('never calls Math.random', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /Math\s*\.\s*random\s*\(/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
