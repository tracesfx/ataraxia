import { noteEnd, type Note } from '../../core/chart';
import { lowerBoundByTime } from '../../core/noteEdit';
import { timeToY, visibleRange, type TimelineView } from '../../core/timeline';
import { HOLD_CAP_H, HOLD_W, LANE_W, NOTE_H, NOTE_W } from '../../render/fieldLayout';
import { laneHue, type Skin, type SpriteImage } from '../../render/skin';
import type { CompareLayer } from './comparePanel';
import type { EditorTheme } from './editorTheme';
import type { TimelineLayout } from './timelineLayout';

/**
 * Notes on the editor timeline, drawn with the active skin's gameplay sprites (note, hold body and
 * cap, in the lane's hue) scaled by a whole number of device pixels per sprite pixel
 * (nearest-neighbour, on whole device pixels, so they stay crisp; see core/laneScale). Holds
 * stretch their one-row body between head and tail. Also draws the tool overlays: ghost note,
 * drag previews, box selection, the hold length label and the record badge.
 */
/** Notes already passed during playback are drawn this faint. */
const PAST_ALPHA = 0.45;
const GHOST_ALPHA = 0.45;
/** Suggested notes before Accept: translucent with a thin outline. */
const SUGGESTION_ALPHA = 0.5;
const MOVING_ORIGIN_ALPHA = 0.25;

/** Note size on the timeline for a layout, in CSS px. */
export interface NoteMetrics {
  width: number;
  /** Tap / head height. */
  height: number;
  tailHeight: number;
  /** Gap between the lane's left edge and the note. */
  inset: number;
}

export function noteMetrics(layout: TimelineLayout): NoteMetrics {
  const u = layout.unit;
  return {
    width: NOTE_W * u,
    height: NOTE_H * u,
    tailHeight: HOLD_CAP_H * u,
    inset: ((LANE_W - NOTE_W) / 2) * u,
  };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen rectangle a note covers (holds: from the tail cap down to the head). */
export function noteRect(
  note: Note,
  layout: TimelineLayout,
  view: TimelineView,
  playheadMs: number,
): Rect {
  const m = noteMetrics(layout);
  const x = layout.lanesX + note.lane * layout.laneWidth + m.inset;
  const headY = timeToY(note.t, playheadMs, view);
  const bottom = headY + m.height / 2;
  const top =
    note.type === 'hold'
      ? Math.min(timeToY(noteEnd(note), playheadMs, view) - m.tailHeight, headY - m.height / 2)
      : headY - m.height / 2;
  return { x, y: top, w: m.width, h: bottom - top };
}

/** Longest hold in a note list (for searching notes that reach into a time range). */
export function longestHoldMs(notes: readonly Note[]): number {
  let longest = 0;
  for (const n of notes) if (n.type === 'hold' && n.dur > longest) longest = n.dur;
  return longest;
}

/** Notes that may be on screen, in chart order. */
export function visibleNotes(
  notes: readonly Note[],
  view: TimelineView,
  playheadMs: number,
  longestMs: number,
): Note[] {
  const { startMs, endMs } = visibleRange(playheadMs, view);
  // Pad by a (largest) note height so notes half off the edges still count.
  const pad = (NOTE_H * 8) / view.pxPerMs;
  const out: Note[] = [];
  for (let i = lowerBoundByTime(notes, startMs - pad - longestMs); i < notes.length; i++) {
    const n = notes[i] as Note;
    if (n.t > endMs + pad) break;
    if (noteEnd(n) >= startMs - pad) out.push(n);
  }
  return out;
}

/** The topmost note under a point, or null. */
export function noteAtPoint(
  notes: readonly Note[],
  x: number,
  y: number,
  layout: TimelineLayout,
  view: TimelineView,
  playheadMs: number,
  longestMs = longestHoldMs(notes),
): Note | null {
  const candidates = visibleNotes(notes, view, playheadMs, longestMs);
  // Later notes draw on top, so search from the end.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const n = candidates[i] as Note;
    const r = noteRect(n, layout, view, playheadMs);
    if (x >= r.x && x < r.x + r.w && y >= r.y && y <= r.y + r.h) return n;
  }
  return null;
}

export interface NoteLayerFrame {
  dpr: number;
  widthPx: number;
  heightPx: number;
  layout: TimelineLayout;
  view: TimelineView;
  playheadMs: number;
  notes: readonly Note[];
  longestHoldMs: number;
  selection: ReadonlySet<Note>;
  playing: boolean;
  /** Notes being dragged: drawn faint where they were. */
  moving: ReadonlySet<Note>;
  /** Ghost / drag / move preview notes. */
  previews: readonly Note[];
  /** False when the previewed edit would be rejected (drawn in the warning colour). */
  previewValid: boolean;
  /** Draw previews at full strength with a selection outline (moving notes). */
  previewSolid: boolean;
  /** Box selection in screen coordinates. */
  box: Rect | null;
  /** Text next to the pointer (hold length while dragging). */
  label: { text: string; x: number; y: number } | null;
  /** Show the red REC badge. */
  recording: boolean;
  /** Generated notes waiting for Accept or Discard (sorted), drawn as outlined ghosts. */
  suggestions: readonly Note[];
  /** Existing notes the suggestion would replace: drawn faint. */
  replaced: ReadonlySet<Note>;
  /** Compare chart markers (read-only), or null. */
  compare: CompareLayer | null;
}

/** Device-pixel rectangle for a CSS-pixel one (rounded so sprites land on whole pixels). */
function devRect(r: Rect, dpr: number): Rect {
  const x = Math.round(r.x * dpr);
  const y = Math.round(r.y * dpr);
  return { x, y, w: Math.round((r.x + r.w) * dpr) - x, h: Math.round((r.y + r.h) * dpr) - y };
}

/** Draw notes and tool overlays. Expects the timeline's background and grid already drawn. */
export function drawNoteLayer(
  ctx: CanvasRenderingContext2D,
  f: NoteLayerFrame,
  skin: Skin,
  theme: EditorTheme,
): void {
  ctx.save();
  // Work in device pixels with smoothing off: nearest-neighbour scaling of the pixel sprites.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.beginPath();
  ctx.rect(
    Math.round(f.layout.lanesX * f.dpr),
    0,
    Math.round(f.layout.lanesWidth * f.dpr),
    Math.ceil(f.heightPx * f.dpr),
  );
  ctx.clip();

  for (const note of visibleNotes(f.notes, f.view, f.playheadMs, f.longestHoldMs)) {
    let alpha = 1;
    if (f.moving.has(note) || f.replaced.has(note)) alpha = MOVING_ORIGIN_ALPHA;
    else if (f.playing && noteEnd(note) < f.playheadMs) alpha = PAST_ALPHA;
    drawNote(ctx, f, skin, note, alpha);
    if (f.selection.has(note) && !f.moving.has(note)) outline(ctx, f, note, theme.selection);
  }

  if (f.suggestions.length > 0) {
    const longest = longestHoldMs(f.suggestions);
    for (const note of visibleNotes(f.suggestions, f.view, f.playheadMs, longest)) {
      drawNote(ctx, f, skin, note, SUGGESTION_ALPHA);
      outline(ctx, f, note, theme.suggestion, 1);
    }
  }

  if (f.compare) {
    // Missing notes (compare chart only): amber tint and outline; matched: a thin outline.
    const c = f.compare;
    const longest = longestHoldMs(c.theirs);
    const { startMs, endMs } = visibleRange(f.playheadMs, f.view);
    const pad = (NOTE_H * 8) / f.view.pxPerMs;
    for (let i = lowerBoundByTime(c.theirs, startMs - pad - longest); i < c.theirs.length; i++) {
      const note = c.theirs[i] as Note;
      if (note.t > endMs + pad) break;
      if (noteEnd(note) < startMs - pad) continue;
      if (c.theirStatus[i] === 'missing') {
        tint(ctx, f, note, theme.compareMissing, 0.3);
        outline(ctx, f, note, theme.compareMissing, 2);
      } else {
        outline(ctx, f, note, theme.compareMatched, 1);
      }
    }
    // Extra notes (mine only): violet outline.
    for (const note of visibleNotes(c.extras, f.view, f.playheadMs, longestHoldMs(c.extras))) {
      outline(ctx, f, note, theme.compareExtra, 2);
    }
  }

  for (const note of f.previews) {
    drawNote(ctx, f, skin, note, f.previewSolid ? 0.85 : GHOST_ALPHA);
    if (!f.previewValid) {
      tint(ctx, f, note, theme.invalid);
      outline(ctx, f, note, theme.invalid);
    } else if (f.previewSolid) {
      outline(ctx, f, note, theme.selection);
    }
  }
  ctx.restore();

  ctx.save();
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  if (f.box) {
    ctx.fillStyle = theme.boxFill;
    ctx.fillRect(f.box.x, f.box.y, f.box.w, f.box.h);
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      f.box.x + 0.5,
      f.box.y + 0.5,
      Math.max(0, f.box.w - 1),
      Math.max(0, f.box.h - 1),
    );
  }
  if (f.label) {
    ctx.font = `500 12px ${theme.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const w = ctx.measureText(f.label.text).width + 10;
    const x = Math.min(f.label.x, f.widthPx - w - 4);
    ctx.fillStyle = theme.labelBg;
    ctx.fillRect(x, f.label.y - 9, w, 18);
    ctx.fillStyle = theme.label;
    ctx.fillText(f.label.text, x + 5, f.label.y);
  }
  if (f.recording) {
    ctx.font = `600 12px ${theme.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.labelBg;
    ctx.fillRect(10, 10, 92, 20);
    ctx.fillStyle = theme.record;
    // A pixel dot: a square with its corners cut.
    ctx.fillRect(17, 15, 6, 10);
    ctx.fillRect(15, 17, 10, 6);
    ctx.fillText('recording', 32, 20);
  }
  ctx.restore();
}

function drawNote(
  ctx: CanvasRenderingContext2D,
  f: NoteLayerFrame,
  skin: Skin,
  note: Note,
  alpha: number,
): void {
  const m = noteMetrics(f.layout);
  const x = f.layout.lanesX + note.lane * f.layout.laneWidth + m.inset;
  const headY = timeToY(note.t, f.playheadMs, f.view);
  ctx.globalAlpha = alpha;
  const s = skin.sprites;
  const hue = laneHue(note.lane);
  if (note.type === 'hold') {
    const tailY = timeToY(noteEnd(note), f.playheadMs, f.view);
    const bodyW = HOLD_W * f.layout.unit;
    const bodyX = x + ((NOTE_W - HOLD_W) / 2) * f.layout.unit;
    stretchBody(ctx, s.holdBody[hue], bodyX, tailY, headY, bodyW, f);
    blit(
      ctx,
      s.holdCap[hue],
      { x: bodyX, y: tailY - m.tailHeight, w: bodyW, h: m.tailHeight },
      f.dpr,
    );
    blit(ctx, s.note[hue], { x, y: headY - m.height / 2, w: m.width, h: m.height }, f.dpr);
  } else {
    blit(ctx, s.note[hue], { x, y: headY - m.height / 2, w: m.width, h: m.height }, f.dpr);
  }
  ctx.globalAlpha = 1;
}

function blit(ctx: CanvasRenderingContext2D, img: SpriteImage, r: Rect, dpr: number): void {
  const d = devRect(r, dpr);
  ctx.drawImage(img, d.x, d.y, d.w, d.h);
}

/** Stretch the one-row hold body from the tail cap down to the head (visible part only). */
function stretchBody(
  ctx: CanvasRenderingContext2D,
  body: SpriteImage,
  x: number,
  tailY: number,
  headY: number,
  width: number,
  f: NoteLayerFrame,
): void {
  const dpr = f.dpr;
  const left = Math.round(x * dpr);
  const w = Math.round((x + width) * dpr) - left;
  const top = Math.max(0, Math.round(tailY * dpr));
  const bottom = Math.min(Math.round(headY * dpr), Math.ceil(f.heightPx * dpr));
  if (bottom > top) ctx.drawImage(body, 0, 0, body.width, body.height, left, top, w, bottom - top);
}

function outline(
  ctx: CanvasRenderingContext2D,
  f: NoteLayerFrame,
  note: Note,
  colour: string,
  widthPx = 2,
): void {
  const d = devRect(noteRect(note, f.layout, f.view, f.playheadMs), f.dpr);
  const lw = Math.max(widthPx, Math.round(widthPx * f.dpr));
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colour;
  ctx.lineWidth = lw;
  ctx.strokeRect(d.x - lw / 2, d.y - lw / 2, d.w + lw, d.h + lw);
}

function tint(
  ctx: CanvasRenderingContext2D,
  f: NoteLayerFrame,
  note: Note,
  colour: string,
  alpha = 0.45,
): void {
  const d = devRect(noteRect(note, f.layout, f.view, f.playheadMs), f.dpr);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.fillRect(d.x, d.y, d.w, d.h);
  ctx.globalAlpha = 1;
}
