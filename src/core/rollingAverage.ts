/** Mean of the last `size` values pushed (e.g. hit errors for the debug overlay). */
export class RollingAverage {
  private readonly values: number[] = [];
  private sum = 0;

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`Window size must be a whole number >= 1, got ${size}`);
    }
  }

  push(value: number): void {
    this.values.push(value);
    this.sum += value;
    if (this.values.length > this.size) this.sum -= this.values.shift() as number;
  }

  clear(): void {
    this.values.length = 0;
    this.sum = 0;
  }

  get count(): number {
    return this.values.length;
  }

  /** Null when empty. */
  get average(): number | null {
    return this.values.length === 0 ? null : this.sum / this.values.length;
  }
}
