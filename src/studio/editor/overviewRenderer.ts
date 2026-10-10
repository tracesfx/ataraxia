import { valueAt } from '../../core/analysis';
import type { Note } from '../../core/chart';
import { densityBins, densityLevel } from '../../core/noteDensity';
import { peakRange, type PeakPyramid } from '../../core/peaks';
import { overviewTimeToX, type TimeSpan } from '../../core/timeline';
import type { OverviewBands } from './analysisView';
import type { EditorTheme } from './editorTheme';
import type { AnalysisOverlay } from './timelineRenderer';

export interface OverviewFrame {
  widthPx: number;
  heightPx: number;
  dpr: number;
  durationMs: number;
  /** The song time the minimap covers (pre-song region, song, a little after). */
  span: TimeSpan;
  /** Where the game starts (a small mark). */
  startMs: number;
  peaks: PeakPyramid | null;
  peakScale: number;
  viewStartMs: number;
  viewEndMs: number;
  playheadMs: number;
  /** Chart notes, for the density strip. */
  notes: readonly Note[];
  /** Intensity, impacts and build-ups over the waveform, or null when hidden. */
  overlay: AnalysisOverlay | null;
  /** The range a pending suggestion covers (highlighted), or null. */
  suggestionRange: { startMs: number; endMs: number } | null;
  /** Section roles and repeat groups (analysis viewer), as two bands along the top, or null. */
  bands: OverviewBands | null;
  /** Notes per second before and after a pending suggestion, drawn as two lines, or null. */
  npsCurve: NpsCurve | null;
}

/** Notes per second in consecutive windows from startMs. */
export interface NpsCurve {
  startMs: number;
  windowMs: number;
  before: readonly number[];
  after: readonly number[];
}

/** Height of each analysis band along the minimap's top edge, in CSS px. */
export const ANALYSIS_BAND_PX = 4;

/** Height of the note density strip along the bottom, in CSS px. */
export const DENSITY_STRIP_PX = 6;

/**
 * The wide minimap under the transport bar, over the editor span from left to right: the
 * waveform (flat columns, two tones), the pre-song region tinted, a note-density heat strip
 * (notes per second in flat colour bands), the range of a pending suggestion, the game start, the
 * visible window and the playhead.
 * Waveform and density are rendered into an offscreen canvas only when the size, the peaks or
 * the notes change; each frame blits it and draws the markers.
 */
export class OverviewRenderer {
  private cache: HTMLCanvasElement | null = null;
  private cacheKey = '';
  private cachePeaks: PeakPyramid | null = null;
  private cacheNotes: readonly Note[] | null = null;
  private cacheOverlay: AnalysisOverlay | null = null;
  private cacheBands: OverviewBands | null = null;

  draw(ctx: CanvasRenderingContext2D, f: OverviewFrame, theme: EditorTheme): void {
    const wDev = Math.max(1, Math.round(f.widthPx * f.dpr));
    const hDev = Math.max(1, Math.round(f.heightPx * f.dpr));
    const key = `${wDev}x${hDev} ${f.span.startMs}..${f.span.endMs} ${f.durationMs}`;
    if (
      !this.cache ||
      key !== this.cacheKey ||
      this.cachePeaks !== f.peaks ||
      this.cacheNotes !== f.notes ||
      this.cacheOverlay !== f.overlay ||
      this.cacheBands !== f.bands
    ) {
      this.cache = this.render(wDev, hDev, f, theme);
      this.cacheKey = key;
      this.cachePeaks = f.peaks;
      this.cacheNotes = f.notes;
      this.cacheOverlay = f.overlay;
      this.cacheBands = f.bands;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.cache, 0, 0);

    const xOf = (ms: number): number => Math.round(overviewTimeToX(ms, f.span, wDev));
    const s = Math.max(1, Math.round(f.dpr));
    // Pending suggestion: its range tinted, with 1-pixel edges.
    if (f.suggestionRange) {
      const r0 = xOf(Math.max(f.span.startMs, f.suggestionRange.startMs));
      const r1 = xOf(Math.min(f.span.endMs, f.suggestionRange.endMs));
      const rw = Math.max(s, r1 - r0);
      ctx.fillStyle = theme.suggestionRangeFill;
      ctx.fillRect(r0, 0, rw, hDev);
      ctx.fillStyle = theme.suggestionRangeEdge;
      ctx.fillRect(r0, 0, s, hDev);
      ctx.fillRect(r0 + rw - s, 0, s, hDev);
    }
    if (f.npsCurve) drawNpsCurve(ctx, f, f.npsCurve, wDev, hDev, theme);
    // Visible window: a faint fill with 1-pixel edges.
    const x0 = xOf(Math.max(f.span.startMs, f.viewStartMs));
    const x1 = xOf(Math.min(f.span.endMs, f.viewEndMs));
    const w = Math.max(2 * s, x1 - x0);
    ctx.fillStyle = theme.overviewWindow;
    ctx.fillRect(x0, 0, w, hDev);
    ctx.fillStyle = theme.overviewWindowEdge;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x0, 0, s, hDev);
    ctx.fillRect(x0 + w - s, 0, s, hDev);
    ctx.globalAlpha = 1;
    // Game start: a short tick from the top.
    ctx.fillStyle = theme.startLine;
    const xs = xOf(f.startMs);
    ctx.fillRect(xs, 0, s, Math.round(hDev * 0.45));
    ctx.fillRect(xs, 0, 4 * s, 3 * s);
    // Playhead.
    ctx.fillStyle = theme.playhead;
    ctx.fillRect(xOf(f.playheadMs) - s, 0, 2 * s, hDev);
  }

  private render(
    wDev: number,
    hDev: number,
    f: OverviewFrame,
    theme: EditorTheme,
  ): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = wDev;
    canvas.height = hDev;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    const strip = Math.max(2, Math.round(DENSITY_STRIP_PX * f.dpr));
    const waveH = hDev - strip - Math.max(1, Math.round(f.dpr));
    ctx.fillStyle = theme.overviewBg;
    ctx.fillRect(0, 0, wDev, hDev);
    // Before the audio and after its end.
    const x0 = Math.round(overviewTimeToX(0, f.span, wDev));
    const xEnd = Math.round(overviewTimeToX(f.durationMs, f.span, wDev));
    ctx.fillStyle = theme.beforeSong;
    ctx.fillRect(0, 0, x0, waveH);
    ctx.fillStyle = theme.outside;
    ctx.fillRect(xEnd, 0, wDev - xEnd, waveH);

    const peaks = f.peaks;
    if (peaks && f.durationMs > 0) {
      const centre = waveH / 2;
      const half = waveH / 2 - 1;
      const gain = 1 / f.peakScale;
      const spanMs = f.span.endMs - f.span.startMs;
      const samplesPerMs = peaks.sampleRate / 1000;
      const msPerCol = spanMs / wDev;
      const outer = new Path2D();
      const inner = new Path2D();
      for (let c = 0; c < wDev; c++) {
        const loMs = f.span.startMs + c * msPerCol;
        const hiMs = loMs + msPerCol;
        if (hiMs <= 0 || loMs >= f.durationMs) continue;
        const range = peakRange(peaks, Math.max(0, loMs) * samplesPerMs, hiMs * samplesPerMs);
        if (!range) continue;
        const top = Math.max(-1, -range.max * gain);
        const bottom = Math.min(1, -range.min * gain);
        const y0 = Math.floor(centre + top * half);
        const y1 = Math.ceil(centre + bottom * half);
        if (y1 - y0 < 2) continue;
        outer.rect(c, y0, 1, y1 - y0);
        const i0 = Math.floor(centre + top * half * 0.5);
        const i1 = Math.ceil(centre + bottom * half * 0.5);
        if (i1 - i0 >= 2) inner.rect(c, i0, 1, i1 - i0);
      }
      ctx.fillStyle = theme.waveOuter;
      ctx.fill(outer);
      ctx.fillStyle = theme.waveInner;
      ctx.fill(inner);
    }

    if (f.overlay) drawOverlay(ctx, f, f.overlay, wDev, waveH, theme);
    if (f.bands) {
      // Sections on the top row, repeat groups under them.
      const h = Math.max(2, Math.round(ANALYSIS_BAND_PX * f.dpr));
      const xOf = (ms: number): number => Math.round(overviewTimeToX(ms, f.span, wDev));
      const rows = [f.bands.sections, f.bands.repeats];
      rows.forEach((spans, i) => {
        for (const b of spans) {
          const x0 = xOf(b.startMs);
          ctx.fillStyle = b.color;
          ctx.fillRect(x0, i * h, Math.max(1, xOf(b.endMs) - x0), h);
        }
      });
      ctx.fillStyle = theme.analysis.separator;
      ctx.fillRect(0, 2 * h, wDev, Math.max(1, Math.round(f.dpr)));
    }

    // Density strip: one flat colour band per column.
    const bins = densityBins(f.notes, f.span.startMs, f.span.endMs, wDev);
    const top = hDev - strip;
    let runStart = 0;
    let runLevel = densityLevel(bins[0] ?? 0);
    for (let c = 1; c <= wDev; c++) {
      const level = c < wDev ? densityLevel(bins[c] ?? 0) : -1;
      if (level === runLevel) continue;
      ctx.fillStyle = theme.density[runLevel] ?? theme.overviewBg;
      ctx.fillRect(runStart, top, c - runStart, strip);
      runStart = c;
      runLevel = level;
    }
    return canvas;
  }
}

/**
 * The analysis over the minimap's waveform: build-ups as tinted spans, intensity as a flat area
 * rising from the bottom (with a 1-pixel edge), impacts as ticks from the top.
 */
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  f: OverviewFrame,
  a: AnalysisOverlay,
  wDev: number,
  waveH: number,
  theme: EditorTheme,
): void {
  const xOf = (ms: number): number => Math.round(overviewTimeToX(ms, f.span, wDev));
  ctx.fillStyle = theme.buildUp;
  for (const b of a.buildUps) ctx.fillRect(xOf(b.startMs), 0, xOf(b.endMs) - xOf(b.startMs), waveH);
  const spanMs = f.span.endMs - f.span.startMs;
  const area = new Path2D();
  const edge = new Path2D();
  const maxH = Math.round(waveH * 0.6);
  for (let c = 0; c < wDev; c++) {
    const ms = f.span.startMs + ((c + 0.5) * spanMs) / wDev;
    if (ms < 0 || ms > f.durationMs) continue;
    const h = Math.round(maxH * valueAt(a, a.intensity, ms));
    if (h <= 0) continue;
    area.rect(c, waveH - h, 1, h);
    edge.rect(c, waveH - h, 1, Math.max(1, Math.round(f.dpr)));
  }
  ctx.fillStyle = theme.intensityFill;
  ctx.fill(area);
  ctx.fillStyle = theme.intensityLine;
  ctx.fill(edge);
  ctx.fillStyle = theme.impact;
  const s = Math.max(1, Math.round(f.dpr));
  for (const imp of a.impacts) {
    ctx.fillRect(xOf(imp.t), 0, s, Math.round(waveH * (0.25 + 0.35 * imp.strength)));
  }
}

/**
 * Before (dim) and after (suggestion colour) notes per second as two step lines over the
 * waveform, on one scale, so the change a suggestion makes is visible along the whole song.
 */
function drawNpsCurve(
  ctx: CanvasRenderingContext2D,
  f: OverviewFrame,
  c: NpsCurve,
  wDev: number,
  hDev: number,
  theme: EditorTheme,
): void {
  const top = Math.round(hDev * 0.08);
  const bottom = hDev - Math.max(2, Math.round(DENSITY_STRIP_PX * f.dpr)) - 1;
  let peak = 1;
  for (const v of c.before) peak = Math.max(peak, v);
  for (const v of c.after) peak = Math.max(peak, v);
  const s = Math.max(1, Math.round(f.dpr));
  const line = (values: readonly number[], color: string): void => {
    const path = new Path2D();
    let prevY: number | null = null;
    values.forEach((v, i) => {
      const x0 = Math.round(overviewTimeToX(c.startMs + i * c.windowMs, f.span, wDev));
      const x1 = Math.round(overviewTimeToX(c.startMs + (i + 1) * c.windowMs, f.span, wDev));
      const y = Math.round(bottom - (v / peak) * (bottom - top));
      path.rect(x0, y - s + 1, Math.max(1, x1 - x0), s);
      if (prevY !== null && prevY !== y) {
        path.rect(x0, Math.min(prevY, y), s, Math.abs(prevY - y) + 1);
      }
      prevY = y;
    });
    ctx.fillStyle = color;
    ctx.fill(path);
  };
  line(c.before, theme.labelDim);
  line(c.after, theme.suggestion);
}
