import { valueAt, type AudioAnalysis } from '../../core/analysis';
import { displayDivision, formatTimestamp, gridLines, type GridLine } from '../../core/beatGrid';
import { LANE_COUNT } from '../../core/constants';
import { peakRange, type PeakPyramid } from '../../core/peaks';
import type { LoopMarks } from '../../core/practice';
import { beatLengthMs, type SnapDivision } from '../../core/time';
import { timeToY, visibleRange, yToTime, type TimelineView } from '../../core/timeline';
import type { EditorTheme } from './editorTheme';
import type { TimelineLayout } from './timelineLayout';

/** Everything one timeline frame depends on. */
export interface TimelineFrame {
  widthPx: number;
  heightPx: number;
  dpr: number;
  layout: TimelineLayout;
  view: TimelineView;
  /** The displayed (smoothed) time at the playhead. */
  playheadMs: number;
  bpm: number;
  offsetMs: number;
  snap: SnapDivision;
  durationMs: number;
  peaks: PeakPyramid | null;
  /** Peak value drawn at full width (the loudest sample), so quiet songs still fill the band. */
  peakScale: number;
  /** A-B range marks (either may be unset). */
  rangeMarks: LoopMarks;
  /** The "game starts here" marker: where play from the beginning starts. */
  start: { ms: number; auto: boolean; dragging: boolean };
  /** What the note generator sees (intensity, impacts, build-ups), or null when hidden. */
  overlay: AnalysisOverlay | null;
}

/** The analysis data the overlays draw. */
export type AnalysisOverlay = Pick<
  AudioAnalysis,
  'frameMs' | 'frameOffsetMs' | 'frameCount' | 'intensity' | 'impacts' | 'buildUps'
>;

/** The intensity bar in the left margin: from this far left of the waveform band, this wide. */
const OVERLAY_LEFT_PX = 18;
const OVERLAY_WIDTH_PX = 12;

/** Closest two subdivision lines may be before the grid falls back to coarser lines. */
const MIN_LINE_SPACING_PX = 7;
/** Show timestamps on beat lines (not just measures) when beats are at least this far apart. */
const BEAT_LABEL_SPACING_PX = 30;
const LABEL_HEIGHT_PX = 14;
/** Line alpha by kind: subdivisions quietest. */
const LINE_ALPHA = { sub: 0.42, beat: 0.7, measure: 1 } as const;

/** The loudest absolute sample in a pyramid (0-1), from its top level. */
export function peakScaleOf(peaks: PeakPyramid | null): number {
  const top = peaks?.levels[peaks.levels.length - 1];
  if (!top || top.min.length === 0) return 1;
  const v = Math.max(Math.abs(top.min[0] as number), Math.abs(top.max[0] as number));
  return v > 0.01 ? v : 1;
}

/** Device-pixel row of song time `ms`. */
function rowOf(f: TimelineFrame, ms: number): number {
  return Math.round(timeToY(ms, f.playheadMs, f.view) * f.dpr);
}

/** Device-pixel column of CSS x. */
function colOf(f: TimelineFrame, x: number): number {
  return Math.round(x * f.dpr);
}

/**
 * Draw the editor timeline: lanes, waveform, beat grid, labels, game start and playhead. Flat
 * colours on whole device pixels (1-device-pixel lines, no antialiased shapes). Cost is
 * proportional to the screen size (one peak lookup per device-pixel row, one rect per visible
 * grid line), independent of the song length.
 */
export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  f: TimelineFrame,
  theme: EditorTheme,
  /** Drawn above the grid and below the playhead (the note layer). */
  overlay?: () => void,
): void {
  const { layout } = f;
  const hDev = Math.ceil(f.heightPx * f.dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, Math.ceil(f.widthPx * f.dpr), hDev);

  // Lanes: flat fills and 1-device-pixel dividers.
  const lane0 = colOf(f, layout.lanesX);
  const laneDev = Math.round(layout.laneWidth * f.dpr);
  for (let i = 0; i < LANE_COUNT; i++) {
    ctx.fillStyle = theme.laneBg[i] ?? theme.background;
    ctx.fillRect(lane0 + i * laneDev, 0, laneDev, hDev);
  }
  ctx.fillStyle = theme.laneDivider;
  for (let i = 0; i <= LANE_COUNT; i++) ctx.fillRect(lane0 + i * laneDev, 0, 1, hDev);

  drawWaveform(ctx, f, theme);

  // Before the audio starts (tinted, no waveform) and after it ends (dimmed).
  const waveL = colOf(f, layout.waveX);
  const waveW = colOf(f, layout.waveX + layout.waveWidth) - waveL;
  const y0 = rowOf(f, 0);
  const yEnd = rowOf(f, f.durationMs);
  if (y0 < hDev) {
    ctx.fillStyle = theme.beforeSong;
    ctx.fillRect(waveL, Math.max(0, y0), waveW, hDev - Math.max(0, y0));
  }
  if (yEnd > 0) {
    ctx.fillStyle = theme.outside;
    ctx.fillRect(waveL, 0, waveW, Math.min(hDev, yEnd));
  }

  drawRange(ctx, f, theme);
  drawGrid(ctx, f, theme);
  if (f.overlay) drawAnalysisMargin(ctx, f, f.overlay, theme);
  drawSongEdges(ctx, f, theme, y0, yEnd);
  if (overlay) {
    overlay();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
  drawStart(ctx, f, theme);
  drawPlayhead(ctx, f, theme);
}

/**
 * The analysis in the margin left of the waveform: intensity as a bar growing to the right (one
 * row per device pixel), build-ups as a tinted column, impacts as ticks reaching into the band.
 */
function drawAnalysisMargin(
  ctx: CanvasRenderingContext2D,
  f: TimelineFrame,
  a: AnalysisOverlay,
  theme: EditorTheme,
): void {
  const { dpr, view, layout } = f;
  const x0 = colOf(f, layout.waveX - OVERLAY_LEFT_PX);
  const w = Math.round(OVERLAY_WIDTH_PX * dpr);
  const rows = Math.ceil(f.heightPx * dpr);
  const s = Math.max(1, Math.round(dpr));
  ctx.fillStyle = theme.buildUp;
  for (const b of a.buildUps) {
    const top = Math.max(0, rowOf(f, b.endMs));
    const bottom = Math.min(rows, rowOf(f, b.startMs));
    if (bottom > top) ctx.fillRect(x0, top, w, bottom - top);
  }
  ctx.fillStyle = theme.intensityFill;
  for (let r = 0; r < rows; r += s) {
    const ms = yToTime((r + s / 2) / dpr, f.playheadMs, view);
    if (ms < 0 || ms > f.durationMs) continue;
    const v = valueAt(a, a.intensity, ms);
    const len = Math.round(w * v);
    if (len > 0) ctx.fillRect(x0, r, len, s);
  }
  ctx.fillStyle = theme.intensityLine;
  ctx.fillRect(x0 - s, 0, s, rows);
  ctx.fillStyle = theme.impact;
  const reach = colOf(f, layout.waveX + 6) - x0;
  for (const imp of a.impacts) {
    const y = rowOf(f, imp.t);
    if (y < -4 || y > rows + 4) continue;
    const h = imp.kind === 'drop' ? 3 * s : 2 * s;
    ctx.fillRect(x0, y - Math.floor(h / 2), Math.round(reach * (0.5 + 0.5 * imp.strength)), h);
  }
}

/** Small labels where the audio starts ("before song" under it) and where it ends. */
function drawSongEdges(
  ctx: CanvasRenderingContext2D,
  f: TimelineFrame,
  theme: EditorTheme,
  y0Dev: number,
  yEndDev: number,
): void {
  const { layout, dpr } = f;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `500 11px ${theme.font}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.labelDim;
  const right = layout.waveX + layout.waveWidth - 6;
  const y0 = y0Dev / dpr;
  const yEnd = yEndDev / dpr;
  if (y0 > -20 && y0 < f.heightPx + 20) {
    ctx.textBaseline = 'top';
    ctx.fillText('before song', right, y0 + 4);
    ctx.textBaseline = 'bottom';
    ctx.fillText('audio starts', right, y0 - 4);
  }
  if (yEnd > -20 && yEnd < f.heightPx + 20) {
    ctx.textBaseline = 'bottom';
    ctx.fillText('audio ends', right, yEnd - 4);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // The audio start line itself, 1 device pixel.
  if (y0Dev >= 0 && y0Dev < f.heightPx * dpr) {
    ctx.fillStyle = theme.labelDim;
    ctx.fillRect(colOf(f, layout.waveX), y0Dev, colOf(f, layout.waveWidth), 1);
  }
}

/** Pixels of the start flag, 9 x 12: pole in column 0, cloth with a notched end. */
const FLAG_W = 9;
const FLAG_H = 12;

/**
 * The flag drawn as rectangles in flag pixels of `s` device pixels each: a steel pole and a
 * metallic cloth (highlight row, flat bands, darker bottom edge, notched end).
 */
function drawFlag(
  ctx: CanvasRenderingContext2D,
  theme: EditorTheme,
  x: number,
  bottom: number,
  s: number,
): void {
  const top = bottom - FLAG_H * s;
  ctx.fillStyle = theme.flagPole;
  ctx.fillRect(x, top, s, FLAG_H * s);
  ctx.fillStyle = theme.flagEdge;
  ctx.fillRect(x - s, bottom - s, 3 * s, s);
  const bands = theme.flagCloth;
  for (let row = 0; row < 5; row++) {
    ctx.fillStyle = bands[row] ?? theme.flagPole;
    // Rows 1-3 are notched at the free end.
    const w = row >= 1 && row <= 3 ? (row === 2 ? 6 : 7) : 8;
    ctx.fillRect(x + s, top + (row + 1) * s, w * s, s);
  }
  ctx.fillStyle = theme.flagEdge;
  ctx.fillRect(x + s, top + 6 * s, 8 * s, s);
}

/**
 * The "game starts here" marker: a thin line across the band and a small metallic flag in the
 * column right of it (grabbed there or anywhere outside the lanes). Dashed while automatic.
 */
function drawStart(ctx: CanvasRenderingContext2D, f: TimelineFrame, theme: EditorTheme): void {
  const { layout, dpr } = f;
  const y = rowOf(f, f.start.ms);
  if (y < -40 * dpr || y > (f.heightPx + 20) * dpr) return;
  const x0 = colOf(f, layout.waveX);
  const x1 = colOf(f, layout.flagX);
  const thick = Math.max(1, Math.round(dpr)) * (f.start.dragging ? 2 : 1);
  ctx.fillStyle = theme.startLine;
  if (f.start.auto && !f.start.dragging) {
    const dash = Math.round(6 * dpr);
    for (let x = x0; x < x1; x += dash * 2)
      ctx.fillRect(x, y - thick + 1, Math.min(dash, x1 - x), thick);
  } else {
    ctx.fillRect(x0, y - thick + 1, x1 - x0, thick);
  }
  const s = Math.max(1, Math.round(2 * dpr));
  drawFlag(ctx, theme, x1 + s, y + 1, s);

  const text = f.start.auto ? 'start (auto)' : 'start';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `500 11px ${theme.font}`;
  const w = Math.ceil(ctx.measureText(text).width) + 10;
  const tx = layout.flagX + (FLAG_W + 3) * (s / dpr);
  const ty = y / dpr - (FLAG_H * s) / dpr + 2;
  ctx.fillStyle = theme.labelBg;
  ctx.fillRect(tx, ty - 1, w, 16);
  ctx.fillStyle = theme.startLine;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(text, tx + 5, ty + 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** The waveform as flat rows: the peak envelope and, over it, a brighter inner core. */
function drawWaveform(ctx: CanvasRenderingContext2D, f: TimelineFrame, theme: EditorTheme): void {
  const peaks = f.peaks;
  if (!peaks) return;
  const { dpr, view, layout } = f;
  const centre = (layout.waveX + layout.waveWidth / 2) * dpr;
  const half = (layout.waveWidth / 2 - 2) * dpr;
  const gain = 1 / f.peakScale;
  const samplesPerMs = peaks.sampleRate / 1000;
  const rows = Math.ceil(f.heightPx * dpr);
  // Later time is higher up: row r spans [time at its bottom edge, time at its top edge).
  const msPerRow = 1 / (view.pxPerMs * dpr);
  const topMs = yToTime(0, f.playheadMs, view);
  const outer = new Path2D();
  const inner = new Path2D();
  for (let r = 0; r < rows; r++) {
    const hiMs = topMs - r * msPerRow;
    const loMs = hiMs - msPerRow;
    if (hiMs < 0) break;
    if (loMs > f.durationMs) continue;
    const range = peakRange(peaks, Math.max(0, loMs) * samplesPerMs, hiMs * samplesPerMs);
    if (!range) continue;
    const lo = Math.max(-1, range.min * gain);
    const hi = Math.min(1, range.max * gain);
    const x0 = Math.floor(centre + lo * half);
    const x1 = Math.ceil(centre + hi * half);
    // Silence draws nothing (no 1-pixel spine down the middle).
    if (x1 - x0 < 2) continue;
    outer.rect(x0, r, x1 - x0, 1);
    const i0 = Math.floor(centre + lo * half * 0.5);
    const i1 = Math.ceil(centre + hi * half * 0.5);
    if (i1 - i0 >= 2) inner.rect(i0, r, i1 - i0, 1);
  }
  ctx.fillStyle = theme.waveOuter;
  ctx.fill(outer);
  ctx.fillStyle = theme.waveInner;
  ctx.fill(inner);
}

function lineColor(line: GridLine, theme: EditorTheme): string {
  if (line.kind === 'measure') return theme.measure;
  return theme.tiers[line.kind === 'beat' ? 1 : line.tier] ?? theme.labelDim;
}

function drawGrid(ctx: CanvasRenderingContext2D, f: TimelineFrame, theme: EditorTheme): void {
  const { dpr, layout, view } = f;
  const { startMs, endMs } = visibleRange(f.playheadMs, view);
  const division = displayDivision(view.pxPerMs, f.bpm, f.snap, MIN_LINE_SPACING_PX);
  // Pad by a label height so labels at the edges don't pop in.
  const pad = LABEL_HEIGHT_PX / view.pxPerMs;
  const lines = gridLines(startMs - pad, endMs + pad, f.bpm, f.offsetMs, division);
  const beatPx = beatLengthMs(f.bpm) * view.pxPerMs;
  const measurePx = beatPx * 4;
  // Thin out measure labels when measures are closer than a label.
  const labelStride =
    measurePx >= LABEL_HEIGHT_PX ? 1 : 2 ** Math.ceil(Math.log2(LABEL_HEIGHT_PX / measurePx));
  const beatLabels = beatPx >= BEAT_LABEL_SPACING_PX;

  const lanesL = colOf(f, layout.lanesX);
  const lanesW = Math.round(layout.lanesWidth * dpr);
  const waveL = colOf(f, layout.waveX);
  const waveW = colOf(f, layout.waveX + layout.waveWidth) - waveL;
  // One device pixel per line, fine lines first so beats and measures draw on top.
  for (const kind of ['sub', 'beat', 'measure'] as const) {
    ctx.globalAlpha = LINE_ALPHA[kind];
    for (const line of lines) {
      if (line.kind !== kind) continue;
      const y = rowOf(f, line.ms);
      ctx.fillStyle = lineColor(line, theme);
      if (kind === 'measure') ctx.fillRect(waveL, y, waveW, 1);
      else ctx.fillRect(lanesL, y, lanesW, 1);
    }
  }
  ctx.globalAlpha = 1;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `500 11px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (const line of lines) {
    const isMeasure = line.kind === 'measure' && line.measure !== null;
    if (isMeasure && (line.measure as number) % labelStride !== 0 && labelStride > 1) continue;
    if (!isMeasure && !(line.kind === 'beat' && beatLabels)) continue;
    const y = rowOf(f, line.ms) / dpr;
    if (isMeasure) {
      ctx.textAlign = 'right';
      ctx.fillStyle = theme.label;
      ctx.fillText(String(line.measure), layout.measureLabelX, y);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = isMeasure ? theme.label : theme.labelDim;
    ctx.fillText(formatTimestamp(line.ms), layout.timeLabelX, y);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** The A-B range: a tinted band plus labelled A and B lines. */
function drawRange(ctx: CanvasRenderingContext2D, f: TimelineFrame, theme: EditorTheme): void {
  const { layout, dpr } = f;
  const { aMs, bMs } = f.rangeMarks;
  const waveL = colOf(f, layout.waveX);
  const waveW = colOf(f, layout.waveX + layout.waveWidth) - waveL;
  if (aMs !== null && bMs !== null) {
    const top = rowOf(f, Math.max(aMs, bMs));
    const bottom = rowOf(f, Math.min(aMs, bMs));
    if (bottom > 0 && top < f.heightPx * dpr) {
      ctx.fillStyle = theme.rangeFill;
      ctx.fillRect(waveL, top, waveW, bottom - top);
    }
  }
  for (const [label, ms] of [
    ['A', aMs],
    ['B', bMs],
  ] as const) {
    if (ms === null) continue;
    const y = rowOf(f, ms);
    if (y < -20 * dpr || y > (f.heightPx + 20) * dpr) continue;
    ctx.fillStyle = theme.rangeEdge;
    ctx.fillRect(waveL, y, waveW, Math.max(1, Math.round(dpr)));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `600 11px ${theme.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, layout.waveX + 4, y / dpr - 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

/** The playhead: a 2-device-pixel line with stepped pixel arrows on both sides. */
function drawPlayhead(ctx: CanvasRenderingContext2D, f: TimelineFrame, theme: EditorTheme): void {
  const { layout, view, dpr } = f;
  const y = Math.round(view.playheadY * dpr);
  const s = Math.max(1, Math.round(dpr));
  const left = colOf(f, layout.waveX) - 4 * s;
  const right = colOf(f, layout.waveX + layout.waveWidth) + 4 * s;
  ctx.fillStyle = theme.playheadEdge;
  ctx.fillRect(left, y - s, right - left, s * 3);
  ctx.fillStyle = theme.playhead;
  ctx.fillRect(left, y, right - left, s);
  // Arrows: rows of shrinking width pointing at the band.
  for (let i = 0; i < 5; i++) {
    const w = (5 - i) * s;
    ctx.fillRect(left - 6 * s, y - i * s, w, s);
    ctx.fillRect(left - 6 * s, y + i * s, w, s);
    ctx.fillRect(right + 6 * s - w, y - i * s, w, s);
    ctx.fillRect(right + 6 * s - w, y + i * s, w, s);
  }
}
