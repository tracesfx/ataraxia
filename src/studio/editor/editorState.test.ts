import { describe, expect, it } from 'vitest';
import { MAX_PX_PER_MS, MIN_PX_PER_MS } from '../../core/timeline';
import {
  EditorState,
  normalizeBpm,
  sanitizePrefs,
  validateField,
  type EditorChange,
  type EditorMeta,
} from './editorState';

const META: EditorMeta = {
  title: 'Song',
  artist: 'Artist',
  bpm: 150,
  offsetMs: 320,
  difficulty: 'Normal',
  level: 5,
  charter: 'Me',
};

function make(durationMs = 300_000): { state: EditorState; changes: EditorChange[] } {
  const state = new EditorState({ meta: META, notes: [], durationMs });
  const changes: EditorChange[] = [];
  state.subscribe((c) => changes.push(c));
  return { state, changes };
}

describe('EditorState metadata', () => {
  it('applies valid fields and reports invalid ones without applying them', () => {
    const { state, changes } = make();
    expect(state.setMeta({ title: 'New', bpm: 0 })).toHaveLength(1);
    expect(state.meta.title).toBe('New');
    expect(state.meta.bpm).toBe(150);
    expect(changes).toEqual(['meta']);
  });

  it('does not notify when nothing changes', () => {
    const { state, changes } = make();
    state.setMeta({ title: 'Song' });
    expect(changes).toEqual([]);
  });

  it('tunes BPM with buttons without float noise', () => {
    const { state } = make();
    state.setBpm(128.37);
    for (let i = 0; i < 7; i++) state.nudgeBpm(0.01);
    expect(state.meta.bpm).toBe(128.44);
    state.nudgeBpm(-0.1);
    expect(state.meta.bpm).toBe(128.34);
    state.scaleBpm(2);
    expect(state.meta.bpm).toBe(256.68);
    state.scaleBpm(0.5);
    state.scaleBpm(0.5);
    expect(state.meta.bpm).toBe(64.17);
  });

  it('nudges the offset and sets beat 0 at the playhead', () => {
    const { state } = make();
    state.nudgeOffset(-10);
    state.nudgeOffset(1);
    expect(state.meta.offsetMs).toBe(311);
    state.seek(12_345.6);
    state.setOffsetToPlayhead();
    expect(state.meta.offsetMs).toBe(12_346);
  });

  it('normalizes BPM into range', () => {
    expect(normalizeBpm(0)).toBe(1);
    expect(normalizeBpm(5000)).toBe(1000);
    expect(normalizeBpm(120.123456)).toBe(120.1235);
  });

  it('validates each field', () => {
    expect(validateField('title', ' ')).not.toBeNull();
    expect(validateField('artist', '')).toBeNull();
    expect(validateField('offsetMs', 1.5)).not.toBeNull();
    expect(validateField('offsetMs', -40)).toBeNull();
    expect(validateField('level', 21)).not.toBeNull();
    expect(validateField('level', 20)).toBeNull();
    expect(validateField('bpm', 173.37)).toBeNull();
  });
});

describe('EditorState playhead', () => {
  it('seeks from 30 s before the audio to 10 s past its end', () => {
    const { state } = make(10_000);
    state.seek(-50);
    expect(state.playheadMs).toBe(-50);
    state.seek(-29_999);
    expect(state.playheadMs).toBe(-29_999);
    state.seek(-45_000);
    expect(state.playheadMs).toBe(-30_000);
    state.seek(20_000);
    expect(state.playheadMs).toBe(20_000);
    state.seek(25_000);
    expect(state.playheadMs).toBe(20_000);
    expect(state.span).toEqual({ startMs: -30_000, endMs: 20_000 });
  });

  it('scrolls, steps and follows the audio into negative time', () => {
    const { state } = make(10_000);
    state.seek(0);
    state.stepMeasure(-1); // 150 BPM, offset 320: measures every 1600 ms
    expect(state.playheadMs).toBe(-1280);
    state.stepSnap(-1);
    expect(state.playheadMs).toBe(-1380);
    state.scrollPx(-300); // 0.3 px/ms by default: 1 s earlier
    expect(state.playheadMs).toBeCloseTo(-2380, 6);
    state.followAudio(-500);
    expect(state.playheadMs).toBe(-500);
  });

  it('goes Home to the earliest of the game start, the first note and 0', () => {
    const { state } = make(10_000);
    expect(state.homeMs).toBe(0);
    state.setStartMs(-2000);
    expect(state.homeMs).toBe(-2000);
  });

  it('steps by snap division and by measure on the beat grid', () => {
    const { state, changes } = make();
    // 150 BPM, offset 320: 1/4 snap = 100 ms steps; measures 1600 ms.
    state.seek(1000);
    state.stepSnap(1);
    expect(state.playheadMs).toBe(1020);
    state.stepSnap(1);
    expect(state.playheadMs).toBe(1120);
    state.setSnap(3);
    state.stepSnap(-1);
    expect(state.playheadMs).toBe(987);
    state.stepMeasure(1);
    expect(state.playheadMs).toBe(1920);
    state.stepMeasure(-1);
    expect(state.playheadMs).toBe(320);
    expect(changes.filter((c) => c === 'seek').length).toBe(6);
  });

  it('seeks to the nearest grid line', () => {
    const { state } = make();
    state.seekSnapped(1049);
    expect(state.playheadMs).toBe(1020);
  });

  it('free-scrolls by pixels at the current zoom', () => {
    const { state } = make();
    state.seek(5000);
    state.scrollPx(30); // default 0.3 px/ms -> 100 ms later
    expect(state.playheadMs).toBeCloseTo(5100, 9);
  });

  it('follows the audio without a seek notification', () => {
    const { state, changes } = make();
    state.followAudio(777);
    expect(state.playheadMs).toBe(777);
    expect(changes).toEqual(['playhead']);
  });
});

describe('EditorState view and options', () => {
  it('clamps zoom', () => {
    const { state } = make();
    state.zoomBy(1e6);
    expect(state.pxPerMs).toBe(MAX_PX_PER_MS);
    state.zoomBy(1e-9);
    expect(state.pxPerMs).toBe(MIN_PX_PER_MS);
  });

  it('cycles snap divisions and stops at the ends', () => {
    const { state } = make();
    expect(state.snap).toBe(4);
    state.cycleSnap(1);
    expect(state.snap).toBe(6);
    for (let i = 0; i < 10; i++) state.cycleSnap(1);
    expect(state.snap).toBe(16);
    for (let i = 0; i < 10; i++) state.cycleSnap(-1);
    expect(state.snap).toBe(1);
  });

  it('clamps volumes', () => {
    const { state } = make();
    state.setVolumes({ music: 2, click: -1 });
    expect(state.prefs.musicVolume).toBe(1);
    expect(state.prefs.clickVolume).toBe(0);
  });
});

describe('EditorState view options', () => {
  it('sets lane size (clamped), invert scroll and snap on scroll stop', () => {
    const { state, changes } = make();
    expect(state.prefs.laneSize).toBe(2);
    state.setOptions({ laneSize: 9, invertScroll: true, snapOnScrollStop: true });
    expect(state.prefs).toMatchObject({ laneSize: 4, invertScroll: true, snapOnScrollStop: true });
    expect(changes).toEqual(['options']);
    state.setOptions({ laneSize: 4 });
    expect(changes).toEqual(['options']);
  });
});

describe('sanitizePrefs', () => {
  it('keeps valid values and drops the rest', () => {
    expect(
      sanitizePrefs({
        pxPerMs: 99,
        snap: 5,
        playbackRate: 0.75,
        metronome: true,
        musicVolume: 0.5,
        clickVolume: 3,
      }),
    ).toEqual({ pxPerMs: MAX_PX_PER_MS, playbackRate: 0.75, metronome: true, musicVolume: 0.5 });
    expect(sanitizePrefs(null)).toEqual({});
    expect(sanitizePrefs({ laneSize: 7, invertScroll: true, snapOnScrollStop: 'yes' })).toEqual({
      laneSize: 4,
      invertScroll: true,
    });
    expect(sanitizePrefs('x')).toEqual({});
  });
});

describe('EditorState charting assistance', () => {
  it('applies a detected BPM and offset as one undoable step', () => {
    const { state, changes } = make();
    expect(state.applyTiming(128, 237.4)).toBe(true);
    expect(state.meta.bpm).toBe(128);
    expect(state.meta.offsetMs).toBe(237);
    expect(changes).toContain('meta');
    expect(state.history.undoLabel).toBe('Apply detected timing');
    state.undo();
    expect(state.meta.bpm).toBe(150);
    expect(state.meta.offsetMs).toBe(320);
    state.redo();
    expect(state.meta.bpm).toBe(128);
  });

  it('refuses invalid or unchanged timing without adding an undo step', () => {
    const { state } = make();
    expect(state.applyTiming(150, 320)).toBe(false);
    expect(state.applyTiming(Number.NaN, 0)).toBe(false);
    expect(state.history.canUndo).toBe(false);
  });

  it('inserts suggested notes as one step, selected, with the select tool', () => {
    const { state } = make();
    state.placeTap(0, 1000);
    const suggested = [
      { t: 2000, lane: 1, type: 'tap' } as const,
      { t: 2500, lane: 2, type: 'hold', dur: 400 } as const,
    ];
    expect(state.insertSuggested(suggested)).toBe(true);
    expect(state.notes).toHaveLength(3);
    expect(state.selectedNotes).toEqual(suggested);
    expect(state.tool).toBe('select');
    state.undo();
    expect(state.notes).toHaveLength(1);
    expect(state.selection.size).toBe(0);
  });

  it('rejects suggestions that would overlap existing notes', () => {
    const { state } = make();
    state.placeTap(0, 1000);
    const before = state.notes;
    const t = state.notes[0]!.t;
    expect(state.insertSuggested([{ t, lane: 0, type: 'tap' }])).toBe(false);
    expect(state.notes).toBe(before);
    expect(state.message).toMatch(/overlap/);
  });

  it('keeps A-B marks and picks the working range: A-B first, then the selection', () => {
    const { state, changes } = make();
    expect(state.workingRange()).toBeNull();
    state.placeTap(0, 1000);
    state.placeHold(1, 3000, 4000);
    state.selectAll();
    // Snapped to the grid (beat 0 at 320 ms, 1/4 snap = 100 ms steps).
    expect(state.workingRange()).toEqual({
      range: { startMs: 1020, endMs: 4020 },
      source: 'selection',
    });
    state.seek(9000);
    state.setRangeMark('b');
    state.setRangeMark('a', 5000);
    expect(changes).toContain('range');
    expect(state.range).toEqual({ startMs: 5000, endMs: 9000 });
    expect(state.workingRange()?.source).toBe('ab');
    state.clearRange();
    expect(state.range).toBeNull();
    expect(state.workingRange()?.source).toBe('selection');
  });
});

describe('EditorState game start', () => {
  it('is automatic at first and follows the notes', () => {
    const { state } = make(60_000);
    expect(state.startIsAuto).toBe(true);
    expect(state.effectiveStartMs).toBe(0);
    state.seek(-1000);
    state.placeTap(0, -1000);
    // 150 BPM, offset 320, 1/4 snap: lines every 100 ms, the nearest to -1000 is -980.
    expect(state.notes[0]?.t).toBe(-980);
    expect(state.effectiveStartMs).toBe(-2480);
    expect(state.toChart()).not.toHaveProperty('startMs');
  });

  it('sets a custom start as one undoable step, saved with the chart', () => {
    const { state, changes } = make(60_000);
    expect(state.setStartMs(-3000.4)).toBe(true);
    expect(changes).toContain('start');
    expect(state.customStartMs).toBe(-3000);
    expect(state.startIsAuto).toBe(false);
    expect(state.toChart().startMs).toBe(-3000);
    expect(state.history.undoLabel).toBe('Set game start');
    expect(state.setStartMs(-3000)).toBe(false);
    state.undo();
    expect(state.startIsAuto).toBe(true);
    state.redo();
    expect(state.customStartMs).toBe(-3000);
    expect(state.resetStartToAuto()).toBe(true);
    expect(state.toChart()).not.toHaveProperty('startMs');
    state.undo();
    expect(state.customStartMs).toBe(-3000);
  });

  it('clamps the start to 30 s before the audio and no later than 0', () => {
    const { state } = make(60_000);
    state.setStartMs(-90_000);
    expect(state.customStartMs).toBe(-30_000);
    state.seek(5000);
    state.setStartAtPlayhead();
    expect(state.customStartMs).toBe(0);
    expect(state.message).toMatch(/at 0/);
    state.seek(-1234);
    state.setStartAtPlayhead();
    expect(state.customStartMs).toBe(-1234);
  });

  it('loads a saved start', () => {
    const state = new EditorState({ meta: META, notes: [], durationMs: 1000, startMs: -500 });
    expect(state.effectiveStartMs).toBe(-500);
    expect(
      new EditorState({ meta: META, notes: [], durationMs: 1000, startMs: null }).startIsAuto,
    ).toBe(true);
  });
});
