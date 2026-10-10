/**
 * Lane size in the chart editor: the editor draws notes from the gameplay skin, scaled up by a
 * whole number of device pixels per sprite pixel (nearest neighbour), so sprites stay crisp.
 * The "lane size" setting (1-4) is roughly CSS pixels per sprite pixel; the device scale is that
 * times devicePixelRatio, rounded to a whole number.
 */

export const MIN_LANE_SIZE = 1;
export const MAX_LANE_SIZE = 4;
export const DEFAULT_LANE_SIZE = 2;

export function clampLaneSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_LANE_SIZE;
  return Math.min(MAX_LANE_SIZE, Math.max(MIN_LANE_SIZE, Math.round(size)));
}

export interface LaneScale {
  /** The lane size actually used (lowered when the chosen one doesn't fit). */
  size: number;
  /** Device pixels per sprite pixel: a whole number. */
  devicePx: number;
  /** CSS pixels per sprite pixel (devicePx / dpr). */
  unit: number;
  /** One lane, in CSS pixels. */
  laneWidth: number;
}

/**
 * The scale for `size` with lanes `skinLaneW` sprite pixels wide. When `laneCount` lanes would
 * be wider than `maxWidthPx` CSS pixels, smaller sizes are tried, down to 1.
 */
export function laneScale(
  skinLaneW: number,
  size: number,
  dpr: number,
  maxWidthPx: number,
  laneCount = 4,
): LaneScale {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  for (let s = clampLaneSize(size); ; s--) {
    const devicePx = Math.max(1, Math.round(s * ratio));
    const unit = devicePx / ratio;
    const laneWidth = skinLaneW * unit;
    if (laneWidth * laneCount <= maxWidthPx || s <= MIN_LANE_SIZE) {
      return { size: s, devicePx, unit, laneWidth };
    }
  }
}
