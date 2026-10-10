/**
 * Small seeded pseudo-random generator (mulberry32): the same seed always gives the same
 * sequence, so generated charts and test signals are reproducible.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Largest seed value (seeds are unsigned 32-bit integers). */
export const MAX_SEED = 0xffffffff;

/** Turn any number into a valid seed (whole, unsigned 32-bit). */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  return Math.abs(Math.trunc(seed)) % (MAX_SEED + 1);
}

/**
 * The one random source of a generation run: a mulberry32 stream with the helpers the chart
 * generator needs. Everything random in a run must come from one `Rng`, never `Math.random`,
 * so the same seed reproduces the same result.
 */
export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = seededRandom(normalizeSeed(seed));
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Whole number in [0, n). */
  int(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** One element, uniformly; undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[this.int(items.length)];
  }

  /** One element chosen with probability proportional to its weight (0 = never). */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T | undefined {
    let total = 0;
    for (const item of items) total += Math.max(0, weightOf(item));
    if (!(total > 0)) return undefined;
    let r = this.next() * total;
    for (const item of items) {
      r -= Math.max(0, weightOf(item));
      if (r < 0) return item;
    }
    return items[items.length - 1];
  }
}
