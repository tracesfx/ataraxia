import { describe, expect, it } from 'vitest';
import { noteEnd, type Lane } from '../../core/chart';
import { holdNote, normalizeChart, tapNote } from '../../core/noteEdit';
import { parseChart, serializeChart } from '../../core/parseChart';
import { PlaySession } from '../../core/playSession';
import { MAX_SCORE } from '../../core/scoring';
import { EditorState, type EditorChange, type EditorMeta } from './editorState';

/** 120 BPM, beat 0 at 0: beats every 500 ms, 1/4 snap = 125 ms. */
const META: EditorMeta = {
  title: 'Song',
  artist: 'Artist',
  bpm: 120,
  offsetMs: 0,
  difficulty: 'Normal',
  level: 5,
  charter: 'Me',
};

function make(): { state: EditorState; changes: EditorChange[] } {
  const state = new EditorState({
    meta: META,
    notes: [],
    durationMs: 60_000,
    audioFileName: 'song.ogg',
    previewStartMs: 1000,
    prefs: { snap: 4 },
  });
  const changes: EditorChange[] = [];
  state.subscribe((c) => changes.push(c));
  return { state, changes };
}

describe('EditorState note editing', () => {
  it('places snapped taps and holds, and rejects overlaps with a message', () => {
    const { state, changes } = make();
    expect(state.placeTap(0, 1010)).toBe(true);
    expect(state.placeHold(1, 2000, 2990)).toBe(true);
    expect(state.notes).toEqual([tapNote(0, 1000), holdNote(1, 2000, 1000)]);
    expect(state.placeTap(1, 2500)).toBe(false);
    expect(state.message).toMatch(/overlap/);
    expect(changes).toContain('message');
    expect(state.notes).toHaveLength(2);
  });

  it('undoes and redoes each edit, a move being one step', () => {
    const { state } = make();
    state.placeTap(0, 1000);
    state.placeTap(1, 1000);
    state.selectAll();
    state.moveSelection(500, 1);
    expect(state.notes).toEqual([tapNote(1, 1500), tapNote(2, 1500)]);
    state.undo();
    expect(state.notes).toEqual([tapNote(0, 1000), tapNote(1, 1000)]);
    // Undo re-selects the notes that came back.
    expect(state.selection.size).toBe(2);
    state.undo();
    state.undo();
    expect(state.notes).toEqual([]);
    state.redo();
    state.redo();
    state.redo();
    expect(state.notes).toEqual([tapNote(1, 1500), tapNote(2, 1500)]);
  });

  it('pastes at the playhead as one step and mirrors the selection', () => {
    const { state } = make();
    state.placeTap(0, 0);
    state.placeHold(1, 250, 750);
    state.selectAll();
    state.copySelection();
    state.seek(4010);
    expect(state.paste()).toBe(true);
    expect(state.selectedNotes).toEqual([tapNote(0, 4000), holdNote(1, 4250, 500)]);
    state.mirrorSelection();
    expect(state.selectedNotes).toEqual([tapNote(3, 4000), holdNote(2, 4250, 500)]);
    state.undo();
    state.undo();
    expect(state.notes).toHaveLength(2);
    // Pasting over existing notes is refused.
    state.seek(0);
    expect(state.paste()).toBe(false);
  });

  it('nudges by a snap division and cuts', () => {
    const { state } = make();
    state.placeTap(2, 1000);
    state.selectAll();
    state.nudgeSelection(1);
    expect(state.notes).toEqual([tapNote(2, 1125)]);
    state.nudgeSelection(-2);
    expect(state.notes).toEqual([tapNote(2, 875)]);
    state.cutSelection();
    expect(state.notes).toEqual([]);
    state.seek(2000);
    state.paste();
    expect(state.notes).toEqual([tapNote(2, 2000)]);
  });

  it('selects with replace, add and toggle', () => {
    const { state } = make();
    state.placeTap(0, 0);
    state.placeTap(1, 0);
    const [a, b] = state.notes;
    state.select([a!]);
    state.select([b!], 'add');
    expect(state.selection.size).toBe(2);
    state.select([a!], 'toggle');
    expect([...state.selection]).toEqual([b]);
    state.clearSelection();
    expect(state.selection.size).toBe(0);
  });
});

describe('EditorState live recording', () => {
  it('records quantized taps and holds as one undo step, skipping overlaps', () => {
    const { state } = make();
    state.placeTap(3, 2000);
    state.setRecordArmed(true);
    state.recordPress(0, 990);
    state.recordRelease(0, 1050); // short: tap
    state.recordPress(1, 1240);
    state.recordRelease(1, 1760); // > quarter beat: hold to 1750
    state.recordPress(3, 2010); // overlaps the existing tap: skipped
    state.recordRelease(3, 2600);
    state.setRecordArmed(false);
    expect(state.notes).toEqual([tapNote(0, 1000), holdNote(1, 1250, 500), tapNote(3, 2000)]);
    expect(state.history.undoLabel).toBe('Record notes');
    state.undo();
    expect(state.notes).toEqual([tapNote(3, 2000)]);
    state.redo();
    expect(state.notes).toHaveLength(3);
  });

  it('keeps a recorded tap when its hold would run into the next note', () => {
    const { state } = make();
    state.placeTap(0, 1500);
    state.setRecordArmed(true);
    state.recordPress(0, 1000);
    state.recordRelease(0, 2000);
    state.endRecordingSession();
    expect(state.notes).toEqual([tapNote(0, 1000), tapNote(0, 1500)]);
  });

  it('ignores lane presses while not armed', () => {
    const { state } = make();
    state.recordPress(0, 1000);
    expect(state.notes).toEqual([]);
  });
});

describe('editor to gameplay round trip', () => {
  it('builds a chart with editor commands that parses and scores 1,000,000 with perfect play', () => {
    const { state } = make();
    // A short pattern: taps on every lane, a hold, a pasted copy, a mirrored copy, a recording.
    for (let i = 0; i < 8; i++) state.placeTap((i % 4) as Lane, 1000 + i * 250);
    state.placeHold(0, 3000, 3990);
    state.select(state.notes.filter((n) => n.t < 2000));
    state.copySelection();
    state.seek(5000);
    state.paste();
    state.mirrorSelection();
    state.setRecordArmed(true);
    state.recordPress(2, 8010);
    state.recordRelease(2, 8800);
    state.recordPress(3, 9000);
    state.recordRelease(3, 9050);
    state.setRecordArmed(false);

    const json = serializeChart(normalizeChart(state.toChart()));
    const parsed = parseChart(json);
    expect(parsed.errors).toEqual([]);
    if (!parsed.ok) return;
    expect(parsed.chart.notes).toHaveLength(state.notes.length);
    expect(parsed.chart.notes.length).toBe(15);

    const session = new PlaySession(parsed.chart.notes);
    // Perfect play: walk through every press, release and frame update in time order.
    const events: { ms: number; run: () => void }[] = [];
    for (const n of parsed.chart.notes) {
      events.push({ ms: n.t, run: () => session.press(n.lane, n.t) });
      events.push({ ms: noteEnd(n) + 0.1, run: () => session.release(n.lane, noteEnd(n)) });
    }
    events.sort((a, b) => a.ms - b.ms);
    for (const e of events) {
      session.update(e.ms);
      e.run();
    }
    session.update(session.lastJudgeableMs + 1);
    expect(session.finished).toBe(true);
    const summary = session.summary();
    expect(summary.counts.perfect).toBe(15);
    expect(summary.score).toBe(MAX_SCORE);
    expect(summary.maxCombo).toBe(15);
  });
});

describe('EditorState notes before the audio starts', () => {
  it('places, moves, pastes and records notes at negative times', () => {
    const { state } = make();
    expect(state.placeTap(0, -1010)).toBe(true);
    expect(state.placeHold(1, -2000, -1010)).toBe(true);
    expect(state.notes).toEqual([holdNote(1, -2000, 1000), tapNote(0, -1000)]);

    state.selectAll();
    state.copySelection();
    state.seek(-10_000);
    expect(state.paste()).toBe(true);
    expect(state.notes.map((n) => n.t)).toEqual([-10_000, -9000, -2000, -1000]);

    state.select([state.notes[1]!]);
    expect(state.moveSelection(-500, 0)).toBe(true);
    expect(state.notes.map((n) => n.t)).toEqual([-10_000, -9500, -2000, -1000]);

    state.setRecordArmed(true);
    state.recordPress(3, -5010);
    state.recordRelease(3, -5000);
    state.endRecordingSession();
    expect(state.notes).toContainEqual(tapNote(3, -5000));
  });

  it('refuses notes earlier than 30 s before the audio', () => {
    const { state } = make();
    expect(state.placeTap(0, -40_000)).toBe(true); // snaps up to the limit
    expect(state.notes).toEqual([tapNote(0, -30_000)]);
    state.selectAll();
    expect(state.moveSelection(-125, 0)).toBe(false);
    expect(state.message).toMatch(/30 seconds before the audio/);
  });

  it('exports negative notes and a custom start that survive a round trip', () => {
    const { state } = make();
    state.placeTap(2, -1500);
    state.placeTap(0, 0);
    state.setStartMs(-3000);
    const json = serializeChart(normalizeChart(state.toChart()));
    const parsed = parseChart(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.chart?.version).toBe(2);
    expect(parsed.chart?.startMs).toBe(-3000);
    expect(parsed.chart?.notes).toEqual([tapNote(2, -1500), tapNote(0, 0)]);
    // Importing it again restores the same chart.
    const again = new EditorState({
      meta: META,
      notes: parsed.chart!.notes,
      durationMs: 60_000,
      startMs: parsed.chart!.startMs ?? null,
      audioFileName: 'song.ogg',
      previewStartMs: 1000,
    });
    expect(again.toChart()).toEqual(parsed.chart);
  });
});
