import { peakRange, type PeakPyramid } from '../../core/peaks';
import { timeToY, yToTime, type TimelineView } from '../../core/timeline';
import { groupLetter } from '../charting/analysis/evaluate';
import {
  BANDS,
  LAYERS,
  LAYER_LABELS,
  SECTION_SHORT,
  type BandId,
  type ChartAnalysis,
  type LayerId,
  type LayerOnset,
  type LeadNote,
} from '../charting/analysis/types';
import type { Rejection } from '../charting/hits';
import type { EditorTheme } from './editorTheme';

/**
 * The analysis viewer's tracks (Phase 17): thin vertical strips beside the lanes that share the
 * timeline's time axis (later is higher), drawn at native resolution from pre-aggregated
 * curves. Each frame draws only the visible time range: one value lookup per device-pixel row
 * per track (a max pyramid answers any row height in a couple of reads), so the cost depends on
 * the screen size, not the song length.
 */

export type TrackId =
  | 'beats'
  | 'wave'
  | 'loudness'
  | 'bands'
  | `env-${LayerId}`
  | 'roll'
  | 'activity'
  | 'intensity'
  | 'events'
  | 'sections'
  | 'repeats';

export interface TrackDef {
  id: TrackId;
  /** Full name (panel, tooltip). */
  label: string;
  /** Header text. */
  short: string;
  description: string;
  width: number;
  minWidth: number;
  maxWidth: number;
}

const env = (layer: LayerId, short: string): TrackDef => ({
  id: `env-${layer}`,
  label: `${LAYER_LABELS[layer]} onsets`,
  short,
  description: `Onset envelope of the ${LAYER_LABELS[layer].toLowerCase()} layer, with its picked onsets as ticks on the right.`,
  width: 18,
  minWidth: 10,
  maxWidth: 80,
});

export const TRACKS: readonly TrackDef[] = [
  {
    id: 'beats',
    label: 'Bars and beats',
    short: 'Bar',
    description: 'Bar numbers and beat ticks from the chart BPM and offset.',
    width: 30,
    minWidth: 22,
    maxWidth: 60,
  },
  {
    id: 'wave',
    label: 'Waveform',
    short: 'Wave',
    description: 'The waveform.',
    width: 40,
    minWidth: 16,
    maxWidth: 160,
  },
  {
    id: 'loudness',
    label: 'Loudness',
    short: 'Loud',
    description: 'Loudness, 0-1 between the song’s quiet and loud levels.',
    width: 16,
    minWidth: 8,
    maxWidth: 80,
  },
  {
    id: 'bands',
    label: 'Band energies',
    short: 'Bands',
    description: 'Energy in five bands, left to right: sub, low, low-mid, high-mid, high.',
    width: 55,
    minWidth: 25,
    maxWidth: 200,
  },
  env('kick', 'Kick'),
  env('snare', 'Snr'),
  env('hats', 'Hat'),
  env('bass', 'Bass'),
  env('lead', 'Lead'),
  env('other', 'Oth'),
  {
    id: 'roll',
    label: 'Lead piano roll',
    short: 'Lead roll',
    description:
      'Lead notes as bars by pitch (low left, high right), the pitch contour as a line, lead runs shaded.',
    width: 170,
    minWidth: 80,
    maxWidth: 480,
  },
  {
    id: 'activity',
    label: 'Musical activity',
    short: 'Act',
    description: 'Musical activity: how much is happening (weights in the Analysis panel).',
    width: 28,
    minWidth: 10,
    maxWidth: 120,
  },
  {
    id: 'intensity',
    label: 'Intensity (older analysis)',
    short: 'Int',
    description: 'Intensity of the older analysis (loudness-led), for comparison.',
    width: 18,
    minWidth: 8,
    maxWidth: 80,
  },
  {
    id: 'events',
    label: 'Impacts and build-ups',
    short: 'Imp',
    description: 'Impacts (ticks, long ones are drops) and build-ups (shaded), older analysis.',
    width: 18,
    minWidth: 10,
    maxWidth: 60,
  },
  {
    id: 'sections',
    label: 'Sections',
    short: 'Section',
    description: 'Sections with their roles.',
    width: 48,
    minWidth: 24,
    maxWidth: 120,
  },
  {
    id: 'repeats',
    label: 'Repeat groups',
    short: 'Rep',
    description:
      'Repeated phrases: a colour per group, labelled group letter and occurrence (A2 = second A).',
    width: 32,
    minWidth: 18,
    maxWidth: 80,
  },
];

export const TRACK_BY_ID: ReadonlyMap<TrackId, TrackDef> = new Map(TRACKS.map((t) => [t.id, t]));

/** Height of the track headers (CSS px). */
export const HEADER_PX = 18;
/** Gap between tracks (CSS px). */
export const TRACK_GAP_PX = 2;

/**
 * Maximum over time ranges of a curve sampled every `stepMs`: level 0 is the curve, each level
 * the maximum of two cells of the one below. Short ranges interpolate linearly.
 */
export class CurvePyramid {
  readonly levels: Float32Array[] = [];

  constructor(
    data: Float32Array,
    readonly stepMs: number,
    readonly offsetMs = 0,
    scale = 1,
  ) {
    let level = scale === 1 ? data : data.map((v) => v / scale);
    this.levels.push(level);
    while (level.length > 1) {
      const next = new Float32Array(Math.ceil(level.length / 2));
      for (let i = 0; i < next.length; i++) {
        const a = level[2 * i] as number;
        const b = level[2 * i + 1] ?? a;
        next[i] = a > b ? a : b;
      }
      this.levels.push(next);
      level = next;
    }
  }

  /** Value for a row covering [loMs, hiMs]. */
  valueOver(loMs: number, hiMs: number): number {
    const base = this.levels[0] as Float32Array;
    const n = base.length;
    if (n === 0) return 0;
    const fLo = (loMs - this.offsetMs) / this.stepMs;
    const fHi = (hiMs - this.offsetMs) / this.stepMs;
    if (fHi < 0 || fLo > n - 1) return 0;
    if (fHi - fLo < 1) {
      const t = Math.max(0, Math.min(n - 1, (fLo + fHi) / 2));
      const i = Math.floor(t);
      const a = base[i] as number;
      const b = base[Math.min(n - 1, i + 1)] as number;
      return a + (b - a) * (t - i);
    }
    let lo = Math.max(0, Math.floor(fLo));
    let hi = Math.min(n - 1, Math.ceil(fHi));
    let lvl = 0;
    while (hi - lo > 2 && lvl + 1 < this.levels.length) {
      lvl++;
      lo >>= 1;
      hi >>= 1;
    }
    const arr = this.levels[lvl] as Float32Array;
    let m = 0;
    for (let i = lo; i <= hi; i++) {
      const v = arr[i] as number;
      if (v > m) m = v;
    }
    return m;
  }
}

/** Everything the tracks draw, prepared once per evaluated analysis. */
export interface TrackData {
  analysis: ChartAnalysis;
  loudness: CurvePyramid;
  bands: Record<BandId, CurvePyramid>;
  env: Record<LayerId, CurvePyramid>;
  activity: CurvePyramid;
  intensity: CurvePyramid | null;
  /** Pitch range of the piano roll (MIDI, inclusive). */
  pitchLo: number;
  pitchHi: number;
  /** Longest lead note (to find notes that start before the view). */
  longestNoteMs: number;
  /** Candidates the last generation left out (Suggest), drawn as marks on the lanes' right. */
  rejections: readonly Rejection[] | null;
}

export function prepareTrackData(a: ChartAnalysis): TrackData {
  const f = a.features;
  const bands = {} as Record<BandId, CurvePyramid>;
  for (const b of BANDS) bands[b] = new CurvePyramid(f.bands[b], f.frameMs);
  const envs = {} as Record<LayerId, CurvePyramid>;
  for (const l of LAYERS) {
    envs[l] = new CurvePyramid(f.envelopes[l], f.onsetHopMs, 0, f.envelopeScale[l]);
  }
  let longest = 0;
  for (const n of a.leadNotes) longest = Math.max(longest, n.durMs);
  // The roll spans the 2nd to 98th percentile of note pitches (stray octave errors don't
  // squash it); notes outside are clipped.
  const midis = a.leadNotes.map((n) => n.midi).sort((x, y) => x - y);
  const at = (q: number): number => midis[Math.round(q * (midis.length - 1))] as number;
  let pitchLo = midis.length > 0 ? Math.floor(at(0.02)) - 1 : 55;
  let pitchHi = midis.length > 0 ? Math.ceil(at(0.98)) + 1 : 84;
  // At least two octaves, so a narrow melody isn't stretched into blocks.
  while (pitchHi - pitchLo < 24) {
    pitchLo -= 1;
    pitchHi += 1;
  }
  const legacy = a.legacy;
  return {
    analysis: a,
    loudness: new CurvePyramid(f.loudness, f.frameMs),
    bands,
    env: envs,
    activity: new CurvePyramid(a.activity, f.frameMs),
    intensity: legacy
      ? new CurvePyramid(legacy.intensity, legacy.frameMs, legacy.frameOffsetMs)
      : null,
    pitchLo,
    pitchHi,
    longestNoteMs: longest,
    rejections: null,
  };
}

export interface TrackColumn {
  id: TrackId;
  /** CSS px. */
  x: number;
  w: number;
}

export interface TracksFrame {
  dpr: number;
  heightPx: number;
  view: TimelineView;
  playheadMs: number;
  durationMs: number;
  bpm: number;
  offsetMs: number;
  columns: readonly TrackColumn[];
  peaks: PeakPyramid | null;
  peakScale: number;
  font: string;
}

/** First index in a time-sorted array whose time is >= ms. */
function firstAtOrAfter<T>(items: readonly T[], ms: number, time: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time(items[mid] as T) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const onsetTime = (o: LayerOnset): number => o.tMs;

/** Device-pixel helpers for one frame. */
class Rows {
  readonly rows: number;
  readonly step: number;
  constructor(readonly f: TracksFrame) {
    this.rows = Math.ceil(f.heightPx * f.dpr);
    this.step = Math.max(1, Math.round(f.dpr));
  }
  /** Device row of a song time. */
  row(ms: number): number {
    return Math.round(timeToY(ms, this.f.playheadMs, this.f.view) * this.f.dpr);
  }
  /** Song time at device row r (top edge). */
  time(r: number): number {
    return yToTime(r / this.f.dpr, this.f.playheadMs, this.f.view);
  }
  col(x: number): number {
    return Math.round(x * this.f.dpr);
  }
}

/** Draw every visible track, then the headers on top. */
export function drawTracks(
  ctx: CanvasRenderingContext2D,
  f: TracksFrame,
  d: TrackData,
  theme: EditorTheme,
): void {
  const t = theme.analysis;
  const rows = new Rows(f);
  const header = Math.round(HEADER_PX * f.dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  f.columns.forEach((c, i) => {
    ctx.fillStyle = t.trackBg[i % 2] as string;
    ctx.fillRect(rows.col(c.x), 0, rows.col(c.x + c.w) - rows.col(c.x), rows.rows);
  });
  // Faint bar lines across every track, so values line up with bars.
  const barMs = d.analysis.structure.barMs;
  const span = { lo: rows.time(rows.rows), hi: rows.time(0) };
  const barPx = barMs * f.view.pxPerMs * f.dpr;
  if (barMs > 0 && barPx >= 6) {
    ctx.fillStyle = t.barLine;
    const origin = f.bpm > 0 ? f.offsetMs : 0;
    const k0 = Math.floor((span.lo - origin) / barMs);
    const k1 = Math.ceil((span.hi - origin) / barMs);
    for (let k = k0; k <= k1; k++) {
      const y = rows.row(origin + k * barMs);
      for (const c of f.columns) {
        ctx.fillRect(rows.col(c.x), y, rows.col(c.x + c.w) - rows.col(c.x), 1);
      }
    }
  }
  for (const c of f.columns) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rows.col(c.x), header, rows.col(c.x + c.w) - rows.col(c.x), rows.rows - header);
    ctx.clip();
    drawTrack(ctx, rows, c, d, theme, span);
    ctx.restore();
  }
  // Headers and separators.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = t.header;
  for (const c of f.columns) {
    ctx.fillRect(rows.col(c.x), 0, rows.col(c.x + c.w) - rows.col(c.x), header);
  }
  ctx.fillStyle = t.separator;
  for (const c of f.columns) ctx.fillRect(rows.col(c.x + c.w), 0, 1, rows.rows);
  ctx.fillRect(rows.col(f.columns[0]?.x ?? 0) - 1, 0, 1, rows.rows);
  // The playhead continues across the tracks.
  const firstCol = f.columns[0];
  const lastCol = f.columns[f.columns.length - 1];
  if (firstCol && lastCol) {
    const y = Math.round(f.view.playheadY * f.dpr);
    const x0 = rows.col(firstCol.x);
    ctx.fillStyle = theme.playhead;
    ctx.fillRect(x0, y, rows.col(lastCol.x + lastCol.w) - x0, rows.step);
  }
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.font = `600 10px ${f.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = t.headerText;
  for (const c of f.columns) {
    const def = TRACK_BY_ID.get(c.id);
    if (!def) continue;
    let text = def.short;
    if (ctx.measureText(text).width > c.w - 2)
      text = text.slice(0, Math.max(1, Math.floor(c.w / 7)));
    ctx.fillText(text, c.x + c.w / 2, HEADER_PX / 2 + 0.5);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawTrack(
  ctx: CanvasRenderingContext2D,
  rows: Rows,
  c: TrackColumn,
  d: TrackData,
  theme: EditorTheme,
  span: { lo: number; hi: number },
): void {
  const t = theme.analysis;
  const a = d.analysis;
  switch (c.id) {
    case 'beats':
      drawBeats(ctx, rows, c, theme, span);
      return;
    case 'wave':
      drawWave(ctx, rows, c, theme);
      return;
    case 'loudness':
      barTrack(ctx, rows, c, d.loudness, t.loudness, a.durationMs);
      return;
    case 'bands': {
      const sub = c.w / BANDS.length;
      BANDS.forEach((b, i) => {
        barTrack(
          ctx,
          rows,
          { id: c.id, x: c.x + i * sub, w: sub },
          d.bands[b],
          t.bands[i] as string,
          a.durationMs,
        );
      });
      return;
    }
    case 'roll':
      drawRoll(ctx, rows, c, d, theme, span);
      return;
    case 'activity':
      barTrack(ctx, rows, c, d.activity, t.activity, a.durationMs);
      return;
    case 'intensity':
      if (d.intensity) barTrack(ctx, rows, c, d.intensity, t.intensity, a.durationMs);
      return;
    case 'events':
      drawEvents(ctx, rows, c, d, theme);
      return;
    case 'sections':
      drawSections(ctx, rows, c, d, theme);
      return;
    case 'repeats':
      drawRepeats(ctx, rows, c, d, theme, span);
      return;
    default: {
      const layer = c.id.slice(4) as LayerId;
      const li = LAYERS.indexOf(layer);
      if (li < 0) return;
      const color = t.layers[li] as string;
      const tickRoom = Math.min(6, Math.floor(c.w / 3));
      barTrack(
        ctx,
        rows,
        { id: c.id, x: c.x, w: c.w - tickRoom },
        d.env[layer],
        color,
        a.durationMs,
        0.55,
      );
      // Picked onsets as ticks on the right edge.
      const onsets = a.layerOnsets[layer];
      const x1 = rows.col(c.x + c.w) - 1;
      const room = rows.col(tickRoom);
      ctx.fillStyle = color;
      const s = rows.step;
      for (let i = firstAtOrAfter(onsets, span.lo, onsetTime); i < onsets.length; i++) {
        const o = onsets[i] as LayerOnset;
        if (o.tMs > span.hi) break;
        const len = Math.max(s, Math.round(room * (0.35 + 0.65 * o.strength)));
        ctx.fillRect(x1 - len, rows.row(o.tMs) - s, len, 2 * s);
      }
    }
  }
}

/** A value 0-1 as a bar growing right, one row per device pixel (or per dpr step). */
function barTrack(
  ctx: CanvasRenderingContext2D,
  rows: Rows,
  c: TrackColumn,
  p: CurvePyramid,
  color: string,
  durationMs: number,
  alpha = 1,
): void {
  const x0 = rows.col(c.x) + 1;
  const w = rows.col(c.x + c.w) - x0 - 1;
  if (w <= 0) return;
  const s = rows.step;
  const path = new Path2D();
  const edge = new Path2D();
  for (let r = 0; r < rows.rows; r += s) {
    const hi = rows.time(r);
    const lo = rows.time(r + s);
    if (hi < 0 || lo > durationMs) continue;
    const v = p.valueOver(lo, hi);
    const len = Math.round(w * (v > 1 ? 1 : v));
    if (len <= 0) continue;
    path.rect(x0, r, len, s);
    edge.rect(x0 + len - s, r, s, s);
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.globalAlpha = 1;
  ctx.fill(edge);
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  rows: Rows,
  c: TrackColumn,
  theme: EditorTheme,
): void {
  const peaks = rows.f.peaks;
  if (!peaks) return;
  const centre = rows.col(c.x + c.w / 2);
  const half = rows.col(c.w / 2) - 1;
  const gain = 1 / rows.f.peakScale;
  const perMs = peaks.sampleRate / 1000;
  const s = rows.step;
  const path = new Path2D();
  for (let r = 0; r < rows.rows; r += s) {
    const hi = rows.time(r);
    const lo = rows.time(r + s);
    if (hi < 0 || lo > rows.f.durationMs) continue;
    const range = peakRange(peaks, Math.max(0, lo) * perMs, hi * perMs);
    if (!range) continue;
    const x0 = Math.floor(centre + Math.max(-1, range.min * gain) * half);
    const x1 = Math.ceil(centre + Math.min(1, range.max * gain) * half);
    if (x1 - x0 >= 1) path.rect(x0, r, x1 - x0, s);
  }
  ctx.fillStyle = theme.analysis.loudness;
  ctx.globalAlpha = 0.7;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

function drawBeats(
  ctx: CanvasRenderingContext2D,
  rows: Rows,
  c: TrackColumn,
  theme: EditorTheme,
  span: { lo: number; hi: number },
): void {
  const f = rows.f;
  if (!(f.bpm > 0)) return;
  const beatMs = 60000 / f.bpm;
  const beatPx = beatMs * f.view.pxPerMs * f.dpr;
  const x0 = rows.col(c.x);
  const w = rows.col(c.x + c.w) - x0;
  const b0 = Math.floor((span.lo - f.offsetMs) / beatMs);
  const b1 = Math.ceil((span.hi - f.offsetMs) / beatMs);
  ctx.fillStyle = theme.measure;
  if (b1 - b0 > 4000) return;
  for (let b = b0; b <= b1; b++) {
    const isBar = ((b % 4) + 4) % 4 === 0;
    if (!isBar && beatPx < 5) continue;
    const y = rows.row(f.offsetMs + b * beatMs);
    ctx.fillRect(isBar ? x0 : x0 + w - Math.round(w / 3), y, isBar ? w : Math.round(w / 3), 1);
  }
  // Bar numbers, thinned when bars are close.
  const barPx = beatPx * 4;
  const labelPx = 14 * f.dpr;
  const stride = barPx >= labelPx ? 1 : 2 ** Math.ceil(Math.log2(labelPx / Math.max(0.01, barPx)));
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.font = `500 10px ${f.font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = theme.label;
  for (let b = b0 - (((b0 % 4) + 4) % 4); b <= b1; b += 4) {
    const measure = Math.floor(b / 4) + 1;
    if (stride > 1 && measure % stride !== 0) continue;
    const y = rows.row(f.offsetMs + b * beatMs) / f.dpr;
    ctx.fillText(String(measure), c.x + 2, y - 1);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawRoll(
  ctx: CanvasRenderingContext2D,
  rows: Rows,
  c: TrackColumn,
  d: TrackData,
  theme: EditorTheme,
  span: { lo: number; hi: number },
): void {
  const t = theme.analysis;
  const a = d.analysis;
  const f = rows.f;
  const x0 = rows.col(c.x) + 1;
  const w = rows.col(c.x + c.w) - x0 - 1;
  const keys = d.pitchHi - d.pitchLo + 1;
  const keyW = w / keys;
  const xOf = (midi: number): number => x0 + (midi - d.pitchLo) * keyW;
  // Black keys as darker columns, C lines brighter.
  ctx.fillStyle = t.rollKey;
  for (let m = d.pitchLo; m <= d.pitchHi; m++) {
    const pc = ((m % 12) + 12) % 12;
    if ([1, 3, 6, 8, 10].includes(pc)) {
      ctx.fillRect(Math.round(xOf(m)), 0, Math.max(1, Math.round(keyW)), rows.rows);
    }
  }
  ctx.fillStyle = t.rollOctave;
  for (let m = d.pitchLo; m <= d.pitchHi; m++) {
    if (((m % 12) + 12) % 12 === 0) ctx.fillRect(Math.round(xOf(m)), 0, 1, rows.rows);
  }
  // Lead runs.
  ctx.fillStyle = t.run;
  for (const r of a.leadRuns) {
    if (r.endMs < span.lo || r.startMs > span.hi) continue;
    const top = rows.row(r.endMs);
    ctx.fillRect(x0, top, w, rows.row(r.startMs) - top);
  }
  // Notes.
  const strong = new Path2D();
  const weak = new Path2D();
  const nw = Math.max(2, Math.round(keyW));
  const notes = a.leadNotes;
  for (
    let i = firstAtOrAfter(notes, span.lo - d.longestNoteMs, (n: LeadNote) => n.tMs);
    i < notes.length;
    i++
  ) {
    const n = notes[i] as LeadNote;
    if (n.tMs > span.hi) break;
    if (n.tMs + n.durMs < span.lo) continue;
    const top = rows.row(n.tMs + n.durMs);
    const bottom = rows.row(n.tMs);
    const x = Math.round(xOf(n.midi) - nw / 2 + keyW / 2);
    (n.strength >= 0.45 ? strong : weak).rect(x, top, nw, Math.max(2, bottom - top));
  }
  ctx.fillStyle = t.rollNoteWeak;
  ctx.fill(weak);
  ctx.fillStyle = t.rollNote;
  ctx.fill(strong);
  // Note starts: a bright cap at each onset.
  ctx.fillStyle = t.contour;
  for (let i = firstAtOrAfter(notes, span.lo, (n: LeadNote) => n.tMs); i < notes.length; i++) {
    const n = notes[i] as LeadNote;
    if (n.tMs > span.hi) break;
    ctx.fillRect(Math.round(xOf(n.midi) - nw / 2 + keyW / 2), rows.row(n.tMs) - 1, nw, 2);
  }
  // Pitch contour: the tracked pitch where it is confident, one dot per row.
  const feat = a.features;
  const contour = new Path2D();
  const s = rows.step;
  for (let r = 0; r < rows.rows; r += s) {
    const ms = rows.time(r + s / 2);
    if (ms < 0 || ms > a.durationMs) continue;
    const q = Math.round(ms / feat.pitchHopMs);
    const m = feat.pitchMidi[q] ?? 0;
    if (m <= 0 || (feat.pitchConfidence[q] ?? 0) < 0.15) continue;
    if (m < d.pitchLo - 0.5 || m > d.pitchHi + 0.5) continue;
    contour.rect(Math.round(xOf(m) + keyW / 2) - s, r, 2 * s, s);
  }
  ctx.globalAlpha = 0.85;
  ctx.fill(contour);
  ctx.globalAlpha = 1;
  // Octave labels under the header.
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.font = `500 9px ${f.font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = theme.labelDim;
  for (let m = d.pitchLo; m <= d.pitchHi; m++) {
    if (((m % 12) + 12) % 12 !== 0) continue;
    ctx.fillText(`C${Math.floor(m / 12) - 1}`, xOf(m) / f.dpr + 2, HEADER_PX + 2);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawEvents(
  ctx: CanvasRenderingContext2D,
  rows: Rows,
  c: TrackColumn,
  d: TrackData,
  theme: EditorTheme,
): void {
  const legacy = d.analysis.legacy;
  if (!legacy) return;
  const x0 = rows.col(c.x) + 1;
  const w = rows.col(c.x + c.w) - x0 - 1;
  ctx.fillStyle = theme.buildUp;
  for (const b of legacy.buildUps) {
    const top = rows.row(b.endMs);
    const bottom = rows.row(b.startMs);
    if (bottom < 0 || top > rows.rows) continue;
    ctx.fillRect(x0, top, w, bottom - top);
  }
  ctx.fillStyle = theme.impact;
  const s = rows.step;
  for (const imp of legacy.impacts) {
    const y = rows.row(imp.t);
    if (y < -4 || y > rows.rows + 4) continue;
    const h = imp.kind === 'drop' ? 3 * s : 2 * s;
    ctx.fillRect(x0, y - Math.floor(h / 2), Math.round(w * (0.4 + 0.6 * imp.strength)), h);
  }
}

function drawSections(
  ctx: CanvasRenderingContext2D,
  rows: Rows,
  c: TrackColumn,
  d: TrackData,
  theme: EditorTheme,
): void {
  const t = theme.analysis;
  const x0 = rows.col(c.x) + 1;
  const w = rows.col(c.x + c.w) - x0 - 1;
  const f = rows.f;
  const visible = d.analysis.structure.sections.filter((s) => {
    const top = rows.row(s.endMs);
    const bottom = rows.row(s.startMs);
    return bottom >= 0 && top <= rows.rows;
  });
  for (const s of visible) {
    const top = rows.row(s.endMs);
    const bottom = rows.row(s.startMs);
    ctx.fillStyle = t.roles[s.role] ?? t.silentGroup;
    ctx.fillRect(x0, top, w, bottom - top);
    ctx.fillStyle = t.separator;
    ctx.fillRect(x0, bottom - 1, w, Math.max(1, rows.step));
  }
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.font = `600 10px ${f.font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = theme.label;
  const minY = HEADER_PX + 12;
  for (const s of visible) {
    const top = rows.row(s.endMs) / f.dpr;
    const bottom = rows.row(s.startMs) / f.dpr;
    // The label at the section's start (its bottom), kept on screen while it is visible.
    const y = Math.min(bottom - 3, f.heightPx - 3);
    if (y < Math.max(minY, top + 12)) continue;
    ctx.fillText(SECTION_SHORT[s.role], c.x + 3, y);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawRepeats(
  ctx: CanvasRenderingContext2D,
  rows: Rows,
  c: TrackColumn,
  d: TrackData,
  theme: EditorTheme,
  span: { lo: number; hi: number },
): void {
  const t = theme.analysis;
  const s = d.analysis.structure;
  const bars = s.bars;
  if (bars.length === 0) return;
  const x0 = rows.col(c.x) + 1;
  const w = rows.col(c.x + c.w) - x0 - 1;
  const first = Math.max(0, Math.floor((span.lo - (bars[0]?.startMs ?? 0)) / s.barMs) - 1);
  const last = Math.min(
    bars.length - 1,
    Math.ceil((span.hi - (bars[0]?.startMs ?? 0)) / s.barMs) + 1,
  );
  for (let i = first; i <= last; i++) {
    const b = bars[i];
    if (!b) continue;
    const top = rows.row(b.endMs);
    const bottom = rows.row(b.startMs);
    ctx.fillStyle = b.group < 0 ? t.silentGroup : (t.groups[b.group % t.groups.length] as string);
    ctx.fillRect(x0, top, w, bottom - top);
    if (b.barInPhrase === 0) {
      ctx.fillStyle = t.separator;
      ctx.fillRect(x0, bottom - 1, w, Math.max(1, rows.step));
    }
  }
  const f = rows.f;
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.font = `600 10px ${f.font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = theme.label;
  const phrasePx = s.barMs * s.phraseBars * f.view.pxPerMs;
  if (phrasePx >= 14) {
    for (let i = first; i <= last; i++) {
      const b = bars[i];
      if (!b || b.barInPhrase !== 0 || b.group < 0) continue;
      const y = rows.row(b.startMs) / f.dpr - 2;
      if (y < HEADER_PX + 12 || y > f.heightPx + 12) continue;
      ctx.fillText(`${groupLetter(b.group)}${b.repeatIndex + 1}`, c.x + 3, y);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export interface LaneOverlayFrame {
  dpr: number;
  heightPx: number;
  view: TimelineView;
  playheadMs: number;
  lanesX: number;
  lanesWidth: number;
}

/**
 * Over the lanes (under the notes): lead runs shaded, and every candidate onset as a small tick
 * per contributing layer, in that layer's column (kick left ... other right), as long as its
 * strength allows.
 */
export function drawLaneOverlay(
  ctx: CanvasRenderingContext2D,
  f: LaneOverlayFrame,
  d: TrackData,
  theme: EditorTheme,
): void {
  const t = theme.analysis;
  const a = d.analysis;
  const rf: TracksFrame = {
    dpr: f.dpr,
    heightPx: f.heightPx,
    view: f.view,
    playheadMs: f.playheadMs,
    durationMs: a.durationMs,
    bpm: 0,
    offsetMs: 0,
    columns: [],
    peaks: null,
    peakScale: 1,
    font: theme.font,
  };
  const rows = new Rows(rf);
  const lo = rows.time(rows.rows);
  const hi = rows.time(0);
  const x0 = rows.col(f.lanesX);
  const w = rows.col(f.lanesX + f.lanesWidth) - x0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = t.run;
  for (const r of a.leadRuns) {
    if (r.endMs < lo || r.startMs > hi) continue;
    const top = rows.row(r.endMs);
    ctx.fillRect(x0, top, w, rows.row(r.startMs) - top);
  }
  const slot = w / LAYERS.length;
  const s = rows.step;
  const paths = LAYERS.map(() => new Path2D());
  const cands = a.candidates;
  for (let i = firstAtOrAfter(cands, lo, (c) => c.tMs); i < cands.length; i++) {
    const c = cands[i];
    if (!c || c.tMs > hi) break;
    const y = rows.row(c.tMs);
    LAYERS.forEach((layer, li) => {
      const strength = c.layers[layer];
      if (strength === undefined) return;
      const len = Math.max(2 * s, Math.round(slot * 0.85 * (0.25 + 0.75 * strength)));
      const cx = x0 + slot * (li + 0.5);
      (paths[li] as Path2D).rect(Math.round(cx - len / 2), y - s, len, 2 * s);
    });
  }
  paths.forEach((p, li) => {
    ctx.fillStyle = t.layers[li] as string;
    ctx.fill(p);
  });
  // Candidates the generator left out: a short red bar inside the right edge (hover for why).
  const rej = d.rejections;
  if (rej && rej.length > 0) {
    const marks = new Path2D();
    const len = 6 * s;
    for (let i = firstAtOrAfter(rej, lo, (r) => r.tMs); i < rej.length; i++) {
      const r = rej[i];
      if (!r || r.tMs > hi) break;
      const y = rows.row(r.tMs);
      marks.rect(x0 + w - len - s, y - s, len, 2 * s);
    }
    ctx.fillStyle = theme.invalid;
    ctx.fill(marks);
  }
}
