import type { Lane } from '../core/chart';
import { LANE_COUNT } from '../core/constants';
import type { SceneScope } from '../ui/sceneManager';

export interface LaneInputHandlers {
  /** A lane key went down. `timeStamp` is the event's timeStamp (performance-time ms). */
  press(lane: Lane, timeStamp: number): void;
  release(lane: Lane, timeStamp: number): void;
}

/**
 * Turns lane key events into press/release calls the moment they arrive (never polled per
 * frame), using `event.timeStamp` so judgement doesn't depend on frame rate. Key repeat is
 * ignored, and several keys bound to the same lane act as one.
 */
export class LaneInput {
  private readonly downKeys = new Map<string, Lane>();

  constructor(
    scope: SceneScope,
    private readonly bindings: () => Record<string, Lane>,
    private readonly handlers: LaneInputHandlers,
  ) {
    scope.listen(window, 'keydown', (e) => this.onDown(e));
    scope.listen(window, 'keyup', (e) => this.onUp(e));
  }

  isHeld(lane: Lane): boolean {
    for (const l of this.downKeys.values()) if (l === lane) return true;
    return false;
  }

  heldLanes(): boolean[] {
    return this.fillHeldLanes(new Array<boolean>(LANE_COUNT));
  }

  /** Write which lanes are held into `out` (reused every frame to avoid allocation). */
  fillHeldLanes(out: boolean[]): boolean[] {
    out.fill(false);
    for (const l of this.downKeys.values()) out[l] = true;
    return out;
  }

  /** Forget all held keys (e.g. on window blur, when keyup events will never arrive). */
  releaseAll(timeStamp: number): void {
    const lanes = new Set(this.downKeys.values());
    this.downKeys.clear();
    for (const lane of lanes) this.handlers.release(lane, timeStamp);
  }

  private onDown(e: KeyboardEvent): void {
    const lane = this.bindings()[e.code];
    if (lane === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (e.repeat || this.downKeys.has(e.code)) return;
    const wasHeld = this.isHeld(lane);
    this.downKeys.set(e.code, lane);
    if (!wasHeld) this.handlers.press(lane, e.timeStamp);
  }

  private onUp(e: KeyboardEvent): void {
    const lane = this.downKeys.get(e.code);
    if (lane === undefined) return;
    e.preventDefault();
    this.downKeys.delete(e.code);
    if (!this.isHeld(lane)) this.handlers.release(lane, e.timeStamp);
  }
}
