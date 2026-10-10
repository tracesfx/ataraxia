import type { Lane, Note } from '../../core/chart';
import { LANE_COUNT } from '../../core/constants';
import {
  clampLaneDelta,
  findOverlap,
  holdFromDrag,
  holdNote,
  moveNotes,
  noteProblem,
  notesInBox,
  placementTime,
  tapNote,
  type EditBounds,
  type EditResult,
} from '../../core/noteEdit';
import { beatLengthMs, snapToGrid } from '../../core/time';
import { timeToY, yToTime, type TimelineView } from '../../core/timeline';
import { clampStartMs, type EditorState } from './editorState';
import { longestHoldMs, noteAtPoint, type NoteLayerFrame, type Rect } from './noteRenderer';
import { inTimelineBand, laneAt, type TimelineLayout } from './timelineLayout';

/** A press that moves less than this (CSS px) is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;
/** The "game starts here" marker can be grabbed this close to its line (CSS px). */
const START_GRAB_PX = 6;

/** Where the timeline is on screen right now (it changes with resizes, zoom and playback). */
export interface TimelineGeometry {
  layout: TimelineLayout;
  view: TimelineView;
  playheadMs: number;
}

type Drag =
  | { kind: 'place'; lane: Lane; fromMs: number; startY: number; moved: boolean }
  | {
      kind: 'move';
      anchor: Note;
      targets: Note[];
      downMs: number;
      downLane: number;
      deltaMs: number;
      deltaLane: number;
      result: EditResult;
    }
  | { kind: 'box'; fromMs: number; fromX: number; base: Note[]; additive: boolean }
  | { kind: 'start'; ms: number; startY: number; moved: boolean }
  | { kind: 'seek' };

/**
 * Mouse interaction on the timeline for both tools. Pointer positions are kept as screen
 * coordinates and turned into song time when used, so ghosts and drags stay correct while the
 * view scrolls under a still pointer during playback. Every edit goes through EditorState.
 */
export class TimelineTools {
  private pointer: { x: number; y: number } | null = null;
  private drag: Drag | null = null;
  private longestCache: { notes: readonly Note[]; ms: number } | null = null;

  constructor(
    private readonly state: EditorState,
    private readonly geometry: () => TimelineGeometry,
    /** Seek to a song time (clicks on the waveform margin outside the lanes). */
    private readonly seek: (ms: number) => void,
  ) {}

  get dragging(): boolean {
    return this.drag !== null;
  }

  private longest(): number {
    const notes = this.state.notes;
    if (this.longestCache?.notes !== notes) {
      this.longestCache = { notes, ms: longestHoldMs(notes) };
    }
    return this.longestCache.ms;
  }

  private timeAt(y: number): number {
    const g = this.geometry();
    return yToTime(y, g.playheadMs, g.view);
  }

  /** Lane index under x, clamped into the lanes (for drags that leave the lane area). */
  private laneIndexAt(x: number): number {
    const { layout } = this.geometry();
    const i = Math.floor((x - layout.lanesX) / layout.laneWidth);
    return Math.min(LANE_COUNT - 1, Math.max(0, i));
  }

  /** The note under a point, or null. */
  noteAt(x: number, y: number): Note | null {
    const g = this.geometry();
    return noteAtPoint(this.state.notes, x, y, g.layout, g.view, g.playheadMs, this.longest());
  }

  /** True when y is on the "game starts here" marker. */
  private nearStart(y: number): boolean {
    const g = this.geometry();
    return (
      Math.abs(y - timeToY(this.state.effectiveStartMs, g.playheadMs, g.view)) <= START_GRAB_PX
    );
  }

  /** The game start a drag to y gives: snapped to the grid, inside the allowed range. */
  private startAt(y: number): number {
    const { bpm, offsetMs } = this.state.meta;
    return clampStartMs(snapToGrid(this.timeAt(y), bpm, offsetMs, this.state.snap));
  }

  /** The start marker's position while it is dragged, or null. */
  startPreviewMs(): number | null {
    return this.drag?.kind === 'start' ? this.drag.ms : null;
  }

  /** True when the pointer is over the grab area of the start marker (outside the lanes). */
  overStartMarker(): boolean {
    const p = this.pointer;
    if (this.drag?.kind === 'start') return true;
    if (!p || this.drag) return false;
    return laneAt(p.x, this.geometry().layout) === null && this.nearStart(p.y);
  }

  /** The note under the pointer (Delete key, right click). */
  hoveredNote(): Note | null {
    return this.pointer ? this.noteAt(this.pointer.x, this.pointer.y) : null;
  }

  // --- Pointer events (positions in timeline CSS px) ---------------------------------------

  down(x: number, y: number, button: number, shift: boolean): boolean {
    this.pointer = { x, y };
    if (button !== 0) return false;
    const g = this.geometry();
    const lane = laneAt(x, g.layout);
    // The start marker is grabbed outside the lanes (margins and label columns).
    if (lane === null && this.nearStart(y)) {
      this.drag = { kind: 'start', ms: this.state.effectiveStartMs, startY: y, moved: false };
      return true;
    }
    if (lane === null) {
      if (!inTimelineBand(x, g.layout)) return false;
      if (this.state.tool === 'select') {
        this.startBox(x, y, shift);
        return true;
      }
      this.drag = { kind: 'seek' };
      this.seek(this.timeAt(y));
      return true;
    }
    const hit = this.noteAt(x, y);
    if (this.state.tool === 'note') {
      // Clicking a note with the note tool only selects it (for moving with the select tool).
      if (hit) {
        this.state.select([hit], shift ? 'toggle' : 'replace');
        return false;
      }
      this.drag = { kind: 'place', lane, fromMs: this.timeAt(y), startY: y, moved: false };
      return true;
    }
    if (hit) {
      if (shift) {
        this.state.select([hit], 'toggle');
        return false;
      }
      if (!this.state.selection.has(hit)) this.state.select([hit]);
      const targets = this.state.selectedNotes;
      this.drag = {
        kind: 'move',
        anchor: hit,
        targets,
        downMs: this.timeAt(y),
        downLane: lane,
        deltaMs: 0,
        deltaLane: 0,
        result: { ok: true, removed: [], added: [] },
      };
      return true;
    }
    this.startBox(x, y, shift);
    return true;
  }

  private startBox(x: number, y: number, additive: boolean): void {
    this.drag = {
      kind: 'box',
      fromMs: this.timeAt(y),
      fromX: x,
      base: additive ? this.state.selectedNotes : [],
      additive,
    };
    if (!additive) this.state.clearSelection();
  }

  move(x: number, y: number): void {
    this.pointer = { x, y };
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'seek') {
      this.seek(this.timeAt(y));
    } else if (d.kind === 'start') {
      if (Math.abs(y - d.startY) > DRAG_THRESHOLD_PX) d.moved = true;
      if (d.moved) d.ms = this.startAt(y);
    } else if (d.kind === 'place') {
      if (Math.abs(y - d.startY) > DRAG_THRESHOLD_PX) d.moved = true;
    } else if (d.kind === 'move') {
      this.updateMove(d, x, y);
    } else {
      this.state.select([...d.base, ...this.boxNotes(d, x, y)], 'replace');
    }
  }

  private updateMove(d: Extract<Drag, { kind: 'move' }>, x: number, y: number): void {
    const { grid, bounds, notes } = this.state;
    const t = this.timeAt(y);
    d.deltaMs = placementTime(d.anchor.t + (t - d.downMs), grid) - d.anchor.t;
    d.deltaLane = clampLaneDelta(d.targets, this.laneIndexAt(x) - d.downLane);
    d.result = moveNotes(notes, d.targets, d.deltaMs, d.deltaLane, bounds);
  }

  private boxNotes(d: Extract<Drag, { kind: 'box' }>, x: number, y: number): Note[] {
    const { layout } = this.geometry();
    const left = Math.min(x, d.fromX);
    const right = Math.max(x, d.fromX);
    if (right < layout.lanesX || left >= layout.lanesX + layout.lanesWidth) return [];
    return notesInBox(
      this.state.notes,
      this.laneIndexAt(left),
      this.laneIndexAt(right),
      d.fromMs,
      this.timeAt(y),
    );
  }

  up(x: number, y: number): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.pointer = { x, y };
    if (d.kind === 'place') {
      const toMs = this.timeAt(y);
      if (d.moved) this.state.placeHold(d.lane, d.fromMs, toMs);
      else this.state.placeTap(d.lane, d.fromMs);
    } else if (d.kind === 'move') {
      this.updateMove(d, x, y);
      if (d.deltaMs !== 0 || d.deltaLane !== 0) this.state.moveSelection(d.deltaMs, d.deltaLane);
    } else if (d.kind === 'start' && d.moved) {
      // One undo step for the whole drag.
      this.state.setStartMs(this.startAt(y));
    }
  }

  /** Right click: delete the note under the pointer. Returns true if one was deleted. */
  contextMenu(x: number, y: number): boolean {
    if (this.drag) return false;
    const hit = this.noteAt(x, y);
    return hit ? this.state.deleteNote(hit) : false;
  }

  leave(): void {
    if (!this.drag) this.pointer = null;
  }

  /** Abandon the current drag (Esc, focus loss). Returns true if there was one. */
  cancel(): boolean {
    const had = this.drag !== null && this.drag.kind !== 'seek';
    this.drag = null;
    return had;
  }

  // --- What to draw --------------------------------------------------------------------------

  /** Overlay fields of the note layer frame for the current pointer and drag. */
  overlay(): Pick<
    NoteLayerFrame,
    'moving' | 'previews' | 'previewValid' | 'previewSolid' | 'box' | 'label'
  > {
    const none = {
      moving: new Set<Note>(),
      previews: [] as Note[],
      previewValid: true,
      previewSolid: false,
      box: null,
      label: null,
    };
    const p = this.pointer;
    if (!p) return none;
    const g = this.geometry();
    const d = this.drag;
    const { grid, bounds, notes } = this.state;

    if (d?.kind === 'place') {
      const toMs = this.timeAt(p.y);
      if (!d.moved) {
        return { ...none, previews: [tapNote(d.lane, placementTime(d.fromMs, grid))] };
      }
      const hold = holdFromDrag(d.lane, d.fromMs, toMs, grid);
      const dur = hold.type === 'hold' ? hold.dur : 0;
      const beats = dur / beatLengthMs(grid.bpm);
      return {
        ...none,
        previews: [hold],
        previewValid: placeable(notes, hold, bounds),
        label: { text: `${trimBeats(beats)} beats  ${dur} ms`, x: p.x + 16, y: p.y },
      };
    }
    if (d?.kind === 'move') {
      const moved =
        d.result.ok && d.result.added.length > 0
          ? d.result.added
          : d.targets.map((n) => {
              const lane = (n.lane + d.deltaLane) as Lane;
              const t = n.t + d.deltaMs;
              return n.type === 'hold' ? holdNote(lane, t, n.dur) : tapNote(lane, t);
            });
      const label =
        d.deltaMs !== 0 || d.deltaLane !== 0
          ? { text: formatDelta(d.deltaMs, d.deltaLane), x: p.x + 16, y: p.y }
          : null;
      return {
        ...none,
        moving: new Set(d.targets),
        previews: moved,
        previewValid: d.result.ok,
        previewSolid: true,
        label,
      };
    }
    if (d?.kind === 'box') {
      const y0 = timeToY(d.fromMs, g.playheadMs, g.view);
      const box: Rect = {
        x: Math.min(d.fromX, p.x),
        y: Math.min(y0, p.y),
        w: Math.abs(p.x - d.fromX),
        h: Math.abs(p.y - y0),
      };
      return { ...none, box };
    }
    if (d) return none;

    // Hover ghost (note tool only, over an empty spot of a lane).
    const lane = laneAt(p.x, g.layout);
    if (this.state.tool !== 'note' || lane === null || this.noteAt(p.x, p.y)) return none;
    const ghost = tapNote(lane, placementTime(this.timeAt(p.y), grid));
    return { ...none, previews: [ghost], previewValid: placeable(notes, ghost, bounds) };
  }
}

/** Whether a new note could be placed (no overlap, inside the song). */
function placeable(notes: readonly Note[], note: Note, bounds: EditBounds): boolean {
  return noteProblem(note, bounds) === null && findOverlap(notes, [note]) === null;
}

function trimBeats(beats: number): string {
  return beats.toFixed(3).replace(/\.?0+$/, '');
}

function formatDelta(deltaMs: number, deltaLane: number): string {
  const parts: string[] = [];
  if (deltaMs !== 0) parts.push(`${deltaMs > 0 ? '+' : ''}${deltaMs} ms`);
  if (deltaLane !== 0) parts.push(`${deltaLane > 0 ? '+' : ''}${deltaLane} lane`);
  return parts.join('  ');
}
