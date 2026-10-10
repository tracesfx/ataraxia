import type { Chart, Lane, Note } from '../../core/chart';
import {
  CHART_VERSION,
  MAX_LEVEL,
  MAX_START_MS,
  MIN_LEVEL,
  MIN_NOTE_TIME_MS,
  MIN_START_MS,
  autoStartMs,
  compareNotes,
  noteEnd,
} from '../../core/chart';
import { stepMeasure, stepSnap } from '../../core/beatGrid';
import {
  NO_LOOP,
  loopRange,
  setLoopMark,
  type LoopMarks,
  type LoopRange,
} from '../../core/practice';
import {
  addNotes,
  applyEdit,
  copyNotes,
  deleteNotes,
  gridStepDelta,
  mirrorNotes,
  moveNotes,
  pasteNotes,
  placeHold,
  placeTap,
  placementTime,
  quantizeRecorded,
  replaceAllNotes,
  replaceNote,
  swapNotes,
  type Clipboard,
  type EditBounds,
  type EditResult,
  type SnapGrid,
} from '../../core/noteEdit';
import { MAX_BPM } from '../../core/parseChart';
import { SNAP_DIVISIONS, snapToGrid, type SnapDivision } from '../../core/time';
import {
  DEFAULT_PX_PER_MS,
  clampToSpan,
  clampZoom,
  editorSpan,
  type TimeSpan,
} from '../../core/timeline';
import { UndoHistory, type Command } from '../../core/undoHistory';
import { DEFAULT_LANE_SIZE, clampLaneSize } from '../../core/laneScale';

/**
 * The editor's state, kept apart from rendering and the DOM so it can be tested. Every change
 * goes through a method that emits what changed; the scene redraws and the panel refreshes from
 * those notifications. Note edits are computed by the pure operations in core/noteEdit and run
 * as commands on an UndoHistory, so every edit is undoable and none can leave an invalid chart.
 */

/** Note tool: place/delete notes. Select tool: select, move, copy. */
export type EditorTool = 'note' | 'select';

export const PLAYBACK_RATES = [0.5, 0.75, 1] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export function isPlaybackRate(value: unknown): value is PlaybackRate {
  return (PLAYBACK_RATES as readonly unknown[]).includes(value);
}

/** Lowest BPM the tuning buttons go to (the format only requires > 0). */
export const MIN_EDITOR_BPM = 1;

/** Song-level fields (shared by every chart of the song). */
export interface SongFields {
  title: string;
  artist: string;
  bpm: number;
  offsetMs: number;
}

/** Fields that belong to this chart only. */
export interface ChartFields {
  difficulty: string;
  level: number;
  charter: string;
}

export type EditorMeta = SongFields & ChartFields;
export const SONG_FIELDS = ['title', 'artist', 'bpm', 'offsetMs'] as const;
export const CHART_FIELDS = ['difficulty', 'level', 'charter'] as const;

/** Per-user editor preferences, remembered between sessions. */
export interface EditorPrefs {
  pxPerMs: number;
  snap: SnapDivision;
  playbackRate: PlaybackRate;
  metronome: boolean;
  musicVolume: number;
  clickVolume: number;
  /** Click on every note as the playhead passes it. */
  hitSounds: boolean;
  /** Lane size: sprite scale of the notes on the timeline (1-4, see core/laneScale). */
  laneSize: number;
  /** Wheel down moves later instead of earlier. */
  invertScroll: boolean;
  /** Ease the playhead onto the nearest snap line when wheel scrolling stops. */
  snapOnScrollStop: boolean;
}

export const DEFAULT_PREFS: EditorPrefs = {
  pxPerMs: DEFAULT_PX_PER_MS,
  snap: 4,
  playbackRate: 1,
  metronome: false,
  musicVolume: 0.8,
  clickVolume: 0.8,
  hitSounds: false,
  laneSize: DEFAULT_LANE_SIZE,
  invertScroll: false,
  snapOnScrollStop: false,
};

/**
 * What a notification is about:
 * - meta: chart/song fields (title ... charter)
 * - seek: the user moved the playhead (playback must restart there if playing)
 * - playhead: the playhead followed the audio while playing (no restart)
 * - view: zoom
 * - snap, rate, metronome, mix (volumes), playing, hitSounds: transport/options
 * - options: view options (lane size, invert scroll, snap on scroll stop)
 * - notes, selection: the chart's notes / the selected notes
 * - tool, record: the active tool / record mode armed
 * - history: what can be undone or redone changed
 * - range: the A-B range marks
 * - start: the game start (custom startMs or automatic)
 * - message: a short notice for the user (e.g. why an edit was rejected), in `message`
 */
export type EditorChange =
  | 'meta'
  | 'seek'
  | 'playhead'
  | 'view'
  | 'snap'
  | 'rate'
  | 'metronome'
  | 'mix'
  | 'playing'
  | 'notes'
  | 'selection'
  | 'tool'
  | 'record'
  | 'hitSounds'
  | 'options'
  | 'history'
  | 'range'
  | 'start'
  | 'message';

export type EditorListener = (change: EditorChange) => void;

/** BPM rounded to 4 decimals (keeps button nudges free of float noise) and clamped. */
export function normalizeBpm(bpm: number): number {
  const clamped = Math.min(MAX_BPM, Math.max(MIN_EDITOR_BPM, bpm));
  return Math.round(clamped * 10_000) / 10_000;
}

/** Problems with one field's value, as a sentence, or null when valid. */
export function validateField<K extends keyof EditorMeta>(
  key: K,
  value: EditorMeta[K],
): string | null {
  switch (key) {
    case 'title':
      return typeof value === 'string' && value.trim() !== ''
        ? null
        : 'The title must not be empty.';
    case 'difficulty':
      return typeof value === 'string' && value.trim() !== ''
        ? null
        : 'The difficulty name must not be empty.';
    case 'bpm':
      return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_BPM
        ? null
        : `The BPM must be a number greater than 0 and at most ${MAX_BPM}.`;
    case 'offsetMs':
      return Number.isInteger(value) ? null : 'The offset must be a whole number of milliseconds.';
    case 'level':
      return Number.isInteger(value) &&
        (value as number) >= MIN_LEVEL &&
        (value as number) <= MAX_LEVEL
        ? null
        : `The level must be a whole number from ${MIN_LEVEL} to ${MAX_LEVEL}.`;
    default:
      return typeof value === 'string' ? null : 'This field must be text.';
  }
}

export interface EditorStateInit {
  meta: EditorMeta;
  notes: readonly Note[];
  durationMs: number;
  prefs?: Partial<EditorPrefs>;
  /** Chart-file fields the editor doesn't change but saving and exporting need. */
  audioFileName?: string;
  previewStartMs?: number;
  /** The chart's custom game start, or null / missing for automatic. */
  startMs?: number | null;
}

/** A lane key held down during live recording. */
interface RecordPress {
  pressMs: number;
  /** The tap placed on press, or null if it was skipped (overlap). */
  note: Note | null;
}

export class EditorState {
  private metaValue: EditorMeta;
  private notesValue: readonly Note[];
  /** Selected notes, by identity (note objects are immutable and kept by undo). */
  private selectionValue: ReadonlySet<Note> = new Set();
  private toolValue: EditorTool = 'note';
  private clipboardValue: Clipboard | null = null;
  private recordArmedValue = false;
  private readonly recordPresses = new Map<Lane, RecordPress>();
  private recordingGroupOpen = false;
  private messageValue = '';
  private rangeMarks: LoopMarks = NO_LOOP;
  /** Custom game start (startMs), or null when automatic. */
  private startValue: number | null;
  readonly history = new UndoHistory();
  readonly audioFileName: string;
  readonly previewStartMs: number;
  private playheadValue = 0;
  private playingValue = false;
  private prefsValue: EditorPrefs;
  private readonly listeners = new Set<EditorListener>();
  readonly durationMs: number;

  constructor(init: EditorStateInit) {
    this.metaValue = { ...init.meta };
    this.notesValue = [...init.notes].sort(compareNotes);
    this.durationMs = Math.max(0, init.durationMs);
    this.audioFileName = init.audioFileName ?? '';
    this.previewStartMs = init.previewStartMs ?? 0;
    this.startValue = init.startMs ?? null;
    this.prefsValue = { ...DEFAULT_PREFS, ...init.prefs };
    this.prefsValue.pxPerMs = clampZoom(this.prefsValue.pxPerMs);
    this.prefsValue.laneSize = clampLaneSize(this.prefsValue.laneSize);
  }

  subscribe(fn: EditorListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(change: EditorChange): void {
    for (const fn of this.listeners) fn(change);
  }

  // --- Read access -------------------------------------------------------------------------

  get meta(): Readonly<EditorMeta> {
    return this.metaValue;
  }
  get notes(): readonly Note[] {
    return this.notesValue;
  }
  get selection(): ReadonlySet<Note> {
    return this.selectionValue;
  }
  /** Selected notes in chart order. */
  get selectedNotes(): Note[] {
    return [...this.selectionValue].sort(compareNotes);
  }
  get tool(): EditorTool {
    return this.toolValue;
  }
  get recordArmed(): boolean {
    return this.recordArmedValue;
  }
  get hasClipboard(): boolean {
    return (this.clipboardValue?.notes.length ?? 0) > 0;
  }
  /** The latest notice (see the 'message' change). */
  get message(): string {
    return this.messageValue;
  }
  get grid(): SnapGrid {
    const { bpm, offsetMs } = this.metaValue;
    return { bpm, offsetMs, snap: this.prefsValue.snap };
  }
  get bounds(): EditBounds {
    return { durationMs: this.durationMs, minMs: MIN_NOTE_TIME_MS };
  }
  /** Where the playhead and view can go: 30 s before the audio to a little past its end. */
  get span(): TimeSpan {
    return editorSpan(this.durationMs);
  }
  /** Where Home goes: the game start, the first note or 0, whichever is earliest. */
  get homeMs(): number {
    return Math.min(0, this.effectiveStartMs, this.notesValue[0]?.t ?? 0);
  }
  get playheadMs(): number {
    return this.playheadValue;
  }
  get playing(): boolean {
    return this.playingValue;
  }
  get prefs(): Readonly<EditorPrefs> {
    return this.prefsValue;
  }
  get pxPerMs(): number {
    return this.prefsValue.pxPerMs;
  }
  get snap(): SnapDivision {
    return this.prefsValue.snap;
  }

  // --- Metadata ----------------------------------------------------------------------------

  /**
   * Apply field values. Invalid values are rejected (the panel keeps showing what was typed
   * and the error); returns the problems, empty when everything was applied.
   */
  setMeta(patch: Partial<EditorMeta>): string[] {
    const errors: string[] = [];
    const next = { ...this.metaValue };
    let changed = false;
    for (const key of Object.keys(patch) as (keyof EditorMeta)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      const problem = validateField(key, value);
      if (problem) {
        errors.push(problem);
        continue;
      }
      if (next[key] !== value) {
        (next as Record<keyof EditorMeta, unknown>)[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.metaValue = next;
      this.emit('meta');
    }
    return errors;
  }

  setBpm(bpm: number): void {
    if (!Number.isFinite(bpm)) return;
    this.setMeta({ bpm: normalizeBpm(bpm) });
  }

  scaleBpm(factor: number): void {
    this.setBpm(this.metaValue.bpm * factor);
  }

  nudgeBpm(delta: number): void {
    this.setBpm(this.metaValue.bpm + delta);
  }

  nudgeOffset(deltaMs: number): void {
    this.setMeta({ offsetMs: Math.round(this.metaValue.offsetMs + deltaMs) });
  }

  /**
   * Set BPM and offset together as one undoable step (applying a detected tempo). Returns false
   * when the values are invalid or already set.
   */
  applyTiming(bpm: number, offsetMs: number, label = 'Apply detected timing'): boolean {
    const next = { bpm: normalizeBpm(bpm), offsetMs: Math.round(offsetMs) };
    const problem = validateField('bpm', next.bpm) ?? validateField('offsetMs', next.offsetMs);
    if (problem || !Number.isFinite(bpm)) {
      this.notify(problem ?? 'The BPM must be a number.');
      return false;
    }
    const prev = { bpm: this.metaValue.bpm, offsetMs: this.metaValue.offsetMs };
    if (prev.bpm === next.bpm && prev.offsetMs === next.offsetMs) return false;
    this.endRecordingSession();
    this.history.execute({
      label,
      do: () => this.setMeta(next),
      undo: () => this.setMeta(prev),
    });
    this.emit('history');
    return true;
  }

  /** "Set beat 0 here": the offset becomes the playhead time. */
  setOffsetToPlayhead(): void {
    this.setMeta({ offsetMs: Math.round(this.playheadValue) });
  }

  // --- Playhead ----------------------------------------------------------------------------

  /** Playhead positions run from 30 s before the audio to a little past its end. */
  private clampTime(ms: number): number {
    return clampToSpan(ms, this.span);
  }

  /** Move the playhead (user action). */
  seek(ms: number): void {
    if (!Number.isFinite(ms)) return;
    const t = this.clampTime(ms);
    if (t === this.playheadValue) return;
    this.playheadValue = t;
    this.emit('seek');
  }

  /** Follow the audio clock while playing (no restart). */
  followAudio(ms: number): void {
    this.playheadValue = this.clampTime(ms);
    this.emit('playhead');
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playingValue) return;
    this.playingValue = playing;
    this.emit('playing');
  }

  stepSnap(direction: 1 | -1): void {
    const { bpm, offsetMs } = this.metaValue;
    this.seek(stepSnap(this.playheadValue, bpm, offsetMs, this.prefsValue.snap, direction));
  }

  stepMeasure(direction: 1 | -1): void {
    const { bpm, offsetMs } = this.metaValue;
    this.seek(stepMeasure(this.playheadValue, bpm, offsetMs, direction));
  }

  /** Seek to the grid line (at the current snap) nearest `ms`. */
  seekSnapped(ms: number): void {
    const { bpm, offsetMs } = this.metaValue;
    this.seek(snapToGrid(ms, bpm, offsetMs, this.prefsValue.snap));
  }

  /** Free scroll by screen pixels at the current zoom (positive = later). */
  scrollPx(px: number): void {
    this.seek(this.playheadValue + px / this.prefsValue.pxPerMs);
  }

  // --- Notes -------------------------------------------------------------------------------

  /** Show a notice (the scene uses this for its own messages too). */
  notify(text: string): void {
    this.messageValue = text;
    this.emit('message');
  }

  /**
   * Run an edit result as an undoable command. A rejected edit shows its reason and changes
   * nothing. With `reselect`, doing selects the added notes and undoing selects the removed
   * ones again. Returns false when the edit was rejected.
   */
  private commit(label: string, result: EditResult, reselect: boolean): boolean {
    if (!result.ok) {
      this.notify(result.error);
      return false;
    }
    const { removed, added } = result;
    if (removed.length === 0 && added.length === 0) return true;
    const command: Command = {
      label,
      do: () => this.applyDiff(removed, added, reselect),
      undo: () => this.applyDiff(added, removed, reselect),
    };
    this.history.execute(command);
    this.emit('history');
    return true;
  }

  private applyDiff(removed: readonly Note[], added: readonly Note[], reselect: boolean): void {
    this.notesValue = applyEdit(this.notesValue, removed, added);
    const selection = new Set(this.selectionValue);
    for (const n of removed) selection.delete(n);
    if (reselect) for (const n of added) selection.add(n);
    this.emit('notes');
    this.setSelection(selection);
  }

  private setSelection(next: ReadonlySet<Note>): void {
    const current = this.selectionValue;
    if (next.size === current.size && [...next].every((n) => current.has(n))) return;
    this.selectionValue = next;
    this.emit('selection');
  }

  placeTap(lane: Lane, ms: number): boolean {
    const result = placeTap(this.notesValue, lane, ms, this.grid, this.bounds);
    return this.commit('Place note', result, false);
  }

  /** A hold from a drag between two times (snapped, either direction, min one division). */
  placeHold(lane: Lane, fromMs: number, toMs: number): boolean {
    const result = placeHold(this.notesValue, lane, fromMs, toMs, this.grid, this.bounds);
    return this.commit('Place hold', result, false);
  }

  deleteNote(note: Note): boolean {
    return this.commit('Delete note', deleteNotes(this.notesValue, [note]), false);
  }

  deleteSelection(): boolean {
    if (this.selectionValue.size === 0) return false;
    return this.commit('Delete notes', deleteNotes(this.notesValue, this.selectedNotes), true);
  }

  /** Change the selection: replace it, add to it, or toggle each note. */
  select(notes: Iterable<Note>, mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    const present = new Set(this.notesValue);
    const next = new Set(mode === 'replace' ? [] : this.selectionValue);
    for (const n of notes) {
      if (!present.has(n)) continue;
      if (mode === 'toggle' && next.has(n)) next.delete(n);
      else next.add(n);
    }
    this.setSelection(next);
  }

  selectAll(): void {
    this.setSelection(new Set(this.notesValue));
  }

  clearSelection(): void {
    this.setSelection(new Set());
  }

  /** Move the selection by a time and lane offset as one undo step. */
  moveSelection(deltaMs: number, deltaLane: number): boolean {
    const targets = this.selectedNotes;
    if (targets.length === 0) return false;
    const result = moveNotes(this.notesValue, targets, deltaMs, deltaLane, this.bounds);
    return this.commit('Move notes', result, true);
  }

  /** Alt+Up/Down: move the selection `steps` snap divisions, keeping its spacing exact. */
  nudgeSelection(steps: number): boolean {
    const first = this.selectedNotes[0];
    if (!first) return false;
    return this.moveSelection(gridStepDelta(first.t, steps, this.grid), 0);
  }

  copySelection(): number {
    const targets = this.selectedNotes;
    if (targets.length === 0) {
      this.notify('Select notes to copy first.');
      return 0;
    }
    this.clipboardValue = copyNotes(targets);
    this.notify(`Copied ${targets.length} note${targets.length === 1 ? '' : 's'}.`);
    return targets.length;
  }

  cutSelection(): boolean {
    const targets = this.selectedNotes;
    if (targets.length === 0) {
      this.notify('Select notes to cut first.');
      return false;
    }
    this.clipboardValue = copyNotes(targets);
    return this.commit('Cut notes', deleteNotes(this.notesValue, targets), true);
  }

  /** Paste with the earliest copied note on the grid line nearest the playhead. */
  paste(): boolean {
    const clipboard = this.clipboardValue;
    if (!clipboard || clipboard.notes.length === 0) {
      this.notify('There is nothing to paste. Copy some notes first (Ctrl+C).');
      return false;
    }
    const at = placementTime(this.playheadValue, this.grid);
    const result = pasteNotes(this.notesValue, clipboard, at, this.bounds);
    if (result.ok) this.clearSelection();
    return this.commit('Paste notes', result, true);
  }

  mirrorSelection(): boolean {
    const targets = this.selectedNotes;
    if (targets.length === 0) {
      this.notify('Select notes to mirror first.');
      return false;
    }
    return this.commit('Mirror notes', mirrorNotes(this.notesValue, targets, this.bounds), true);
  }

  /**
   * Accept generated notes as one undo step: remove `removed` (replace mode) and add `notes`,
   * then select the new notes (and switch to the select tool) so they can be adjusted or deleted
   * right away. Rejected if any would overlap a note that stays.
   */
  insertSuggested(notes: readonly Note[], removed: readonly Note[] = []): boolean {
    if (notes.length === 0 && removed.length === 0) return false;
    const result = swapNotes(this.notesValue, removed, notes, this.bounds, 'A suggested note');
    if (!result.ok) {
      this.notify(result.error);
      return false;
    }
    this.endRecordingSession();
    this.clearSelection();
    this.commit('Suggest notes', result, true);
    this.setTool('select');
    return true;
  }

  // --- Game start --------------------------------------------------------------------------

  /** The custom game start, or null when it is automatic. */
  get customStartMs(): number | null {
    return this.startValue;
  }

  get startIsAuto(): boolean {
    return this.startValue === null;
  }

  /** Where play from the beginning starts (custom, or automatic from the first note). */
  get effectiveStartMs(): number {
    return this.startValue ?? autoStartMs(this.notesValue);
  }

  /**
   * Set a custom game start (whole ms, clamped to the allowed range: up to 30 s before the
   * audio and no later than 0), or null for automatic. One undo step. Returns false when nothing
   * changed.
   */
  setStartMs(
    ms: number | null,
    label = ms === null ? 'Reset game start' : 'Set game start',
  ): boolean {
    if (ms !== null && !Number.isFinite(ms)) return false;
    const next = ms === null ? null : clampStartMs(ms);
    const prev = this.startValue;
    if (next === prev) return false;
    this.endRecordingSession();
    const apply = (value: number | null): void => {
      this.startValue = value;
      this.emit('start');
    };
    this.history.execute({ label, do: () => apply(next), undo: () => apply(prev) });
    this.emit('history');
    return true;
  }

  /** "Set start at playhead": a playhead after 0 sets the latest allowed start, 0. */
  setStartAtPlayhead(): boolean {
    const changed = this.setStartMs(this.playheadValue);
    if (this.playheadValue > MAX_START_MS) {
      this.notify(
        'The game can start at 0 (when the audio begins) at the latest, so it starts at 0.',
      );
    }
    return changed;
  }

  resetStartToAuto(): boolean {
    return this.setStartMs(null);
  }

  // --- A-B range ---------------------------------------------------------------------------

  /** The marks as set (either may be missing). */
  get rangeMarksSet(): LoopMarks {
    return this.rangeMarks;
  }

  /** The A-B range when both marks are set (in either order) and apart. */
  get range(): LoopRange | null {
    return loopRange(this.rangeMarks);
  }

  /** Set mark A or B (at the playhead unless a time is given). */
  setRangeMark(which: 'a' | 'b', ms = this.playheadValue): void {
    this.rangeMarks = setLoopMark(this.rangeMarks, which, Math.min(this.span.endMs, ms));
    this.emit('range');
  }

  clearRange(): void {
    if (this.rangeMarks.aMs === null && this.rangeMarks.bMs === null) return;
    this.rangeMarks = NO_LOOP;
    this.emit('range');
  }

  /**
   * The range a "selected range only" action works on: the A-B range if set, else the span of
   * the selection (first head to last end), else null.
   */
  workingRange(): { range: LoopRange; source: 'ab' | 'selection' } | null {
    const ab = this.range;
    if (ab) return { range: ab, source: 'ab' };
    const selected = this.selectedNotes;
    const first = selected[0];
    if (!first) return null;
    let endMs = first.t;
    for (const n of selected) endMs = Math.max(endMs, noteEnd(n));
    return { range: { startMs: first.t, endMs }, source: 'selection' };
  }

  /** Replace every note (chart import) as one undo step. `notes` must form a valid chart. */
  replaceNotes(notes: readonly Note[], label = 'Import chart'): boolean {
    this.clearSelection();
    return this.commit(label, replaceAllNotes(this.notesValue, notes), false);
  }

  undo(): boolean {
    this.endRecordingSession();
    const command = this.history.undo();
    if (!command) {
      this.notify('Nothing to undo.');
      return false;
    }
    this.emit('history');
    this.notify(`Undo: ${command.label}.`);
    return true;
  }

  redo(): boolean {
    this.endRecordingSession();
    const command = this.history.redo();
    if (!command) {
      this.notify('Nothing to redo.');
      return false;
    }
    this.emit('history');
    this.notify(`Redo: ${command.label}.`);
    return true;
  }

  // --- Tools and live recording ------------------------------------------------------------

  setTool(tool: EditorTool): void {
    if (tool === this.toolValue) return;
    this.toolValue = tool;
    this.emit('tool');
  }

  setRecordArmed(armed: boolean): void {
    if (armed === this.recordArmedValue) return;
    if (!armed) this.endRecordingSession();
    this.recordArmedValue = armed;
    this.emit('record');
  }

  /**
   * A lane key went down at song time `songMs` while recording: place a tap quantized to the
   * snap. A note that would overlap an existing one is skipped silently. Everything recorded
   * until endRecordingSession() is one undo step.
   */
  recordPress(lane: Lane, songMs: number): void {
    if (!this.recordArmedValue || this.recordPresses.has(lane)) return;
    if (!this.recordingGroupOpen) {
      this.history.beginGroup('Record notes');
      this.recordingGroupOpen = true;
    }
    const tap = quantizeRecorded(lane, songMs, null, this.grid);
    const result = addNotes(this.notesValue, [tap], this.bounds);
    const placed = result.ok && this.commit('Record note', result, false);
    this.recordPresses.set(lane, { pressMs: songMs, note: placed ? tap : null });
  }

  /** The lane key went up: a press held over a quarter beat turns its tap into a hold. */
  recordRelease(lane: Lane, songMs: number): void {
    const press = this.recordPresses.get(lane);
    if (!press) return;
    this.recordPresses.delete(lane);
    if (!press.note || !this.recordArmedValue) return;
    const note = quantizeRecorded(lane, press.pressMs, songMs, this.grid);
    if (note.type !== 'hold') return;
    const result = replaceNote(this.notesValue, press.note, note, this.bounds);
    // A hold that would run into the next note stays a tap.
    if (result.ok) this.commit('Record hold', result, false);
  }

  /** Close the recording session's undo step (playback stopped or record disarmed). */
  endRecordingSession(): void {
    this.recordPresses.clear();
    if (!this.recordingGroupOpen) return;
    this.recordingGroupOpen = false;
    this.history.endGroup();
    this.emit('history');
  }

  setHitSounds(on: boolean): void {
    if (on === this.prefsValue.hitSounds) return;
    this.prefsValue.hitSounds = on;
    this.emit('hitSounds');
  }

  /** The chart as it stands (unsaved edits included), in the standard file format. */
  toChart(): Chart {
    const m = this.metaValue;
    return {
      version: CHART_VERSION,
      title: m.title,
      artist: m.artist,
      audio: this.audioFileName,
      bpm: m.bpm,
      offsetMs: m.offsetMs,
      previewStartMs: this.previewStartMs,
      ...(this.startValue === null ? {} : { startMs: this.startValue }),
      difficulty: m.difficulty,
      level: m.level,
      charter: m.charter,
      notes: [...this.notesValue],
    };
  }

  // --- View and options --------------------------------------------------------------------

  /** Zoom by a factor. The playhead stays where it is on screen, so nothing else moves. */
  zoomBy(factor: number): void {
    const next = clampZoom(this.prefsValue.pxPerMs * factor);
    if (next === this.prefsValue.pxPerMs) return;
    this.prefsValue.pxPerMs = next;
    this.emit('view');
  }

  setSnap(snap: SnapDivision): void {
    if (snap === this.prefsValue.snap) return;
    this.prefsValue.snap = snap;
    this.emit('snap');
  }

  /** Step through SNAP_DIVISIONS ([ and ] keys), stopping at either end. */
  cycleSnap(direction: 1 | -1): void {
    const i = SNAP_DIVISIONS.indexOf(this.prefsValue.snap);
    const next = SNAP_DIVISIONS[Math.min(SNAP_DIVISIONS.length - 1, Math.max(0, i + direction))];
    if (next !== undefined) this.setSnap(next);
  }

  setPlaybackRate(rate: PlaybackRate): void {
    if (rate === this.prefsValue.playbackRate) return;
    this.prefsValue.playbackRate = rate;
    this.emit('rate');
  }

  setMetronome(on: boolean): void {
    if (on === this.prefsValue.metronome) return;
    this.prefsValue.metronome = on;
    this.emit('metronome');
  }

  /** View options: lane size (clamped to 1-4), invert scroll, snap on scroll stop. */
  setOptions(
    options: Partial<Pick<EditorPrefs, 'laneSize' | 'invertScroll' | 'snapOnScrollStop'>>,
  ): void {
    const next = { ...this.prefsValue };
    if (options.laneSize !== undefined) next.laneSize = clampLaneSize(options.laneSize);
    if (options.invertScroll !== undefined) next.invertScroll = options.invertScroll;
    if (options.snapOnScrollStop !== undefined) next.snapOnScrollStop = options.snapOnScrollStop;
    const p = this.prefsValue;
    if (
      next.laneSize === p.laneSize &&
      next.invertScroll === p.invertScroll &&
      next.snapOnScrollStop === p.snapOnScrollStop
    ) {
      return;
    }
    this.prefsValue = next;
    this.emit('options');
  }

  setVolumes(volumes: { music?: number; click?: number }): void {
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    if (volumes.music !== undefined) this.prefsValue.musicVolume = clamp(volumes.music);
    if (volumes.click !== undefined) this.prefsValue.clickVolume = clamp(volumes.click);
    this.emit('mix');
  }
}

/** A game start as whole ms inside MIN_START_MS..MAX_START_MS. */
export function clampStartMs(ms: number): number {
  return Math.min(MAX_START_MS, Math.max(MIN_START_MS, Math.round(ms))) + 0;
}

/** Saved preferences from untrusted storage: unknown or out-of-range values are dropped. */
export function sanitizePrefs(raw: unknown): Partial<EditorPrefs> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<EditorPrefs> = {};
  const unit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
  if (typeof r['pxPerMs'] === 'number' && Number.isFinite(r['pxPerMs'])) {
    out.pxPerMs = clampZoom(r['pxPerMs']);
  }
  if ((SNAP_DIVISIONS as readonly unknown[]).includes(r['snap'])) {
    out.snap = r['snap'] as SnapDivision;
  }
  if (isPlaybackRate(r['playbackRate'])) out.playbackRate = r['playbackRate'];
  if (typeof r['metronome'] === 'boolean') out.metronome = r['metronome'];
  if (unit(r['musicVolume'])) out.musicVolume = r['musicVolume'];
  if (unit(r['clickVolume'])) out.clickVolume = r['clickVolume'];
  if (typeof r['hitSounds'] === 'boolean') out.hitSounds = r['hitSounds'];
  if (typeof r['laneSize'] === 'number' && Number.isFinite(r['laneSize'])) {
    out.laneSize = clampLaneSize(r['laneSize']);
  }
  if (typeof r['invertScroll'] === 'boolean') out.invertScroll = r['invertScroll'];
  if (typeof r['snapOnScrollStop'] === 'boolean') out.snapOnScrollStop = r['snapOnScrollStop'];
  return out;
}
