import type { Lane } from '../../core/chart';
import { LANE_COUNT } from '../../core/constants';
import type { NoteRuntime } from '../../core/playSession';

/**
 * Dev-only autoplay (`?autoplay`, stripped from production builds by the `import.meta.env.DEV`
 * guard in the game scene): presses every note exactly on time and releases holds at their end,
 * so screenshots of a song in progress are deterministic. `?autoplay=jitter` adds a fixed,
 * repeating pattern of timing errors (up to 90 ms early or late) to show timing particles.
 */
export type AutoplayMode = 'perfect' | 'jitter';

/** Visual press length of a tap, for the key labels. */
const TAP_HOLD_MS = 70;

export function autoplayMode(search: string): AutoplayMode | null {
  const params = new URLSearchParams(search);
  if (!params.has('autoplay')) return null;
  return params.get('autoplay') === 'jitter' ? 'jitter' : 'perfect';
}

/** The timing error autoplay uses for note `index`: 0, or a fixed pattern in [-90, 90]. */
export function autoplayErrorMs(mode: AutoplayMode, index: number): number {
  if (mode === 'perfect') return 0;
  return ((index * 37) % 181) - 90;
}

export interface AutoplayInput {
  press(lane: Lane, songMs: number): void;
  release(lane: Lane, songMs: number): void;
}

export class Autoplay {
  private cursor = 0;
  private readonly releaseAt = new Float64Array(LANE_COUNT).fill(Number.NaN);
  private readonly visualUntil = new Float64Array(LANE_COUNT).fill(Number.NEGATIVE_INFINITY);

  constructor(readonly mode: AutoplayMode) {}

  reset(): void {
    this.cursor = 0;
    this.releaseAt.fill(Number.NaN);
    this.visualUntil.fill(Number.NEGATIVE_INFINITY);
  }

  /** Send every press and release due by `nowMs`, at its exact song time. */
  step(notes: readonly NoteRuntime[], nowMs: number, input: AutoplayInput): void {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const at = this.releaseAt[lane] ?? Number.NaN;
      if (!Number.isNaN(at) && nowMs >= at) {
        this.releaseAt[lane] = Number.NaN;
        input.release(lane as Lane, at);
      }
    }
    while (this.cursor < notes.length) {
      const rt = notes[this.cursor] as NoteRuntime;
      const pressMs = rt.note.t + autoplayErrorMs(this.mode, rt.index);
      if (nowMs < pressMs) break;
      this.cursor += 1;
      if (rt.status !== 'pending') continue;
      const lane = rt.note.lane;
      const pending = this.releaseAt[lane] ?? Number.NaN;
      if (!Number.isNaN(pending)) {
        this.releaseAt[lane] = Number.NaN;
        input.release(lane, Math.min(pending, pressMs));
      }
      input.press(lane, pressMs);
      if (rt.note.type === 'hold') {
        this.releaseAt[lane] = rt.note.t + rt.note.dur;
        this.visualUntil[lane] = rt.note.t + rt.note.dur;
      } else {
        this.releaseAt[lane] = pressMs + TAP_HOLD_MS;
        this.visualUntil[lane] = pressMs + TAP_HOLD_MS;
      }
    }
  }

  /** Lanes autoplay is holding down at `nowMs` (the key labels). */
  fillHeld(out: boolean[], nowMs: number): void {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      out[lane] = nowMs < (this.visualUntil[lane] ?? Number.NEGATIVE_INFINITY);
    }
  }
}
