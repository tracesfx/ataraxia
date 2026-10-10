import type { Lane } from '../../core/chart';
import { LANE_COUNT } from '../../core/constants';
import { laneScale } from '../../core/laneScale';
import { LANE_W } from '../../render/fieldLayout';

/** Horizontal layout of the timeline canvas, in CSS pixels. */
export interface TimelineLayout {
  laneWidth: number;
  /** CSS pixels per skin sprite pixel (a whole number of device pixels). */
  unit: number;
  /** Device pixels per skin sprite pixel. */
  devicePx: number;
  /** The lane size in use (may be below the chosen one when the view is narrow). */
  laneSize: number;
  /** Left edge of lane 0 (on a whole device pixel). */
  lanesX: number;
  lanesWidth: number;
  /** Waveform band, centred on the lanes and a little wider. */
  waveX: number;
  waveWidth: number;
  /** Right edge of the measure-number column. */
  measureLabelX: number;
  /** Left edge of the game-start flag column. */
  flagX: number;
  /** Left edge of the timestamp column. */
  timeLabelX: number;
  /** Analysis tracks (Phase 17): right of the waveform band, before the flag column. */
  tracksX: number;
  tracksWidth: number;
}

/** Room for "-999" on the left and the flag plus "00:00.000" on the right. */
const LEFT_ROOM = 64;
const RIGHT_ROOM = 120;
const WAVE_MARGIN = 24;
/** Gap between the waveform band and the analysis tracks. */
const TRACKS_GAP = 10;
/** The lanes keep at least this much room when tracks are shown. */
const MIN_LANES_ROOM = 120;

/** Fraction of the view height above the playhead: the playhead sits in the lower third. */
export const PLAYHEAD_FRACTION = 0.72;

/**
 * The layout for a canvas `widthPx` CSS pixels wide at `dpr`, with lanes of the chosen lane size
 * (1-4) scaled from the skin's lane width; smaller when they would not fit. `tracksPx` reserves
 * room for the analysis tracks right of the waveform band (the lanes then centre in what is
 * left); the tracks get less when the canvas is too narrow.
 */
export function timelineLayout(
  widthPx: number,
  laneSize: number,
  dpr: number,
  tracksPx = 0,
): TimelineLayout {
  const free = widthPx - LEFT_ROOM - RIGHT_ROOM - 2 * WAVE_MARGIN;
  const tracksWidth = Math.max(0, Math.min(tracksPx, free - MIN_LANES_ROOM - TRACKS_GAP));
  const room = free - (tracksWidth > 0 ? tracksWidth + TRACKS_GAP : 0);
  const scale = laneScale(LANE_W, laneSize, dpr, room, LANE_COUNT);
  const lanesWidth = scale.laneWidth * LANE_COUNT;
  const ratio = dpr > 0 ? dpr : 1;
  // Centre the lanes in the room between the label columns, on a whole device pixel.
  const centre = LEFT_ROOM + WAVE_MARGIN + Math.max(0, room - lanesWidth) / 2;
  const lanesX = Math.round(centre * ratio) / ratio;
  const waveX = lanesX - WAVE_MARGIN;
  const waveWidth = lanesWidth + 2 * WAVE_MARGIN;
  const tracksX = waveX + waveWidth + (tracksWidth > 0 ? TRACKS_GAP : 0);
  const right = tracksX + tracksWidth;
  return {
    laneWidth: scale.laneWidth,
    unit: scale.unit,
    devicePx: scale.devicePx,
    laneSize: scale.size,
    lanesX,
    lanesWidth,
    waveX,
    waveWidth,
    measureLabelX: waveX - 22,
    flagX: right + 6,
    timeLabelX: right + 34,
    tracksX,
    tracksWidth,
  };
}

/** Lane under screen x, or null outside the lanes. */
export function laneAt(x: number, layout: TimelineLayout): Lane | null {
  const i = Math.floor((x - layout.lanesX) / layout.laneWidth);
  return i >= 0 && i < LANE_COUNT ? (i as Lane) : null;
}

/** True over the lanes and the waveform band around them (where clicks seek). */
export function inTimelineBand(x: number, layout: TimelineLayout): boolean {
  return x >= layout.waveX && x < layout.waveX + layout.waveWidth;
}
