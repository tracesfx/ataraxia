/** Divisions of a beat the editor can snap to (1 = quarter notes at 4/4, 4 = 16ths, 3 = triplets...). */
export const SNAP_DIVISIONS = [1, 2, 3, 4, 6, 8, 12, 16] as const;
export type SnapDivision = (typeof SNAP_DIVISIONS)[number];

export function isSnapDivision(value: unknown): value is SnapDivision {
  return (SNAP_DIVISIONS as readonly unknown[]).includes(value);
}

function assertBpm(bpm: number): void {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError(`BPM must be a positive finite number, got ${bpm}`);
  }
}

/** Duration of one beat in milliseconds. */
export function beatLengthMs(bpm: number): number {
  assertBpm(bpm);
  return 60000 / bpm;
}

/** Convert song time (ms) to a (fractional) beat number. Beat 0 is at offsetMs; earlier times give negative beats. */
export function msToBeat(ms: number, bpm: number, offsetMs: number): number {
  return (ms - offsetMs) / beatLengthMs(bpm);
}

/** Convert a (fractional) beat number to song time in ms (not rounded). */
export function beatToMs(beat: number, bpm: number, offsetMs: number): number {
  return offsetMs + beat * beatLengthMs(bpm);
}

/**
 * Snap a song time to the nearest grid line of 1/division beats and return integer ms.
 * Works before the offset (negative beats) and with fractional BPM.
 */
export function snapToGrid(
  ms: number,
  bpm: number,
  offsetMs: number,
  division: SnapDivision,
): number {
  if (!isSnapDivision(division)) {
    throw new RangeError(
      `Unsupported snap division ${String(division)}; use one of ${SNAP_DIVISIONS.join(', ')}`,
    );
  }
  const steps = Math.round(msToBeat(ms, bpm, offsetMs) * division);
  // "+ 0" normalises -0 to 0.
  return Math.round(beatToMs(steps / division, bpm, offsetMs)) + 0;
}

/** Song time for HUD labels: `m:ss.t` (tenths), e.g. 72350 -> "1:12.3". Negative shows as 0. */
export function formatSongTime(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const min = Math.floor(tenths / 600);
  const sec = Math.floor((tenths % 600) / 10);
  return `${min}:${String(sec).padStart(2, '0')}.${tenths % 10}`;
}
