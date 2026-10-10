/**
 * Debounced saving: changes are merged into one pending patch and written `delayMs` after the
 * last change. Saves never overlap; a change during a save is written after it. A failed save
 * keeps its patch pending, so the next change or flush() retries it.
 */

export type SaveStatus =
  { kind: 'saved' } | { kind: 'pending' } | { kind: 'saving' } | { kind: 'error'; message: string };

export const AUTOSAVE_DELAY_MS = 500;

export class AutoSaver<P extends object> {
  private pending: Partial<P> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private disposed = false;
  private statusValue: SaveStatus = { kind: 'saved' };

  constructor(
    private readonly save: (patch: Partial<P>) => Promise<void>,
    private readonly onStatus: (status: SaveStatus) => void = () => undefined,
    private readonly delayMs = AUTOSAVE_DELAY_MS,
  ) {}

  get status(): SaveStatus {
    return this.statusValue;
  }

  /** True while anything is unsaved: a pending patch, a save in progress, or a failed save. */
  get hasUnsaved(): boolean {
    return this.pending !== null || this.inFlight !== null;
  }

  /** Merge `patch` into the pending changes and (re)start the debounce timer. */
  schedule(patch: Partial<P>): void {
    if (this.disposed) return;
    this.pending = { ...this.pending, ...patch };
    this.setStatus({ kind: 'pending' });
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Save pending changes now. Resolves true when nothing is left unsaved. */
  async flush(): Promise<boolean> {
    this.clearTimer();
    // Wait for a save already running; it may leave new changes pending.
    while (this.inFlight) await this.inFlight;
    if (!this.pending || this.disposed) return this.pending === null;
    const patch = this.pending;
    this.pending = null;
    this.setStatus({ kind: 'saving' });
    const run = this.save(patch).then(
      () => {
        if (!this.pending) this.setStatus({ kind: 'saved' });
        return true;
      },
      (err: unknown) => {
        // Keep the failed changes; newer pending values win over them.
        this.pending = { ...patch, ...this.pending };
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus({ kind: 'error', message });
        return false;
      },
    );
    this.inFlight = run;
    try {
      return (await run) && this.pending === null;
    } finally {
      this.inFlight = null;
    }
  }

  /** Stop the timer without saving (use flush() first to keep changes). */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: SaveStatus): void {
    this.statusValue = status;
    this.onStatus(status);
  }
}
