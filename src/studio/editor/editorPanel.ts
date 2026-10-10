import { AUTO_START_LEAD_MS, MAX_LEVEL, MIN_LEVEL, type Note } from '../../core/chart';
import { formatTimestamp } from '../../core/beatGrid';
import { chartStats, type ChartStats } from '../../core/noteEdit';
import { TapTempo } from '../../core/tapTempo';
import { button, toggle } from '../../ui/components';
import { el } from '../../ui/dom';
import type { SceneScope } from '../../ui/sceneManager';
import type { AssistParts } from './assistPanel';
import type { EditorChange, EditorMeta, EditorState } from './editorState';
import { collapsible, disclosure, fieldRow, iconTool, tip, type PanelSection } from './editorUi';

type FieldKey = keyof EditorMeta;

interface FieldSpec {
  key: FieldKey;
  label: string;
  type: 'text' | 'number';
  attrs?: Record<string, string>;
  /** Text -> value; NaN / null means "not a value" (shown as an error). */
  parse: (text: string) => EditorMeta[FieldKey] | null;
  format: (value: EditorMeta[FieldKey]) => string;
  /** Unit shown after the input. */
  unit?: string;
}

const asText = (t: string): string => t;
const asNumber = (t: string): number | null => (t.trim() === '' ? null : Number(t));
const show = (v: EditorMeta[FieldKey]): string => String(v);

const INFO_FIELDS: FieldSpec[] = [
  { key: 'title', label: 'Title', type: 'text', parse: asText, format: show },
  { key: 'artist', label: 'Artist', type: 'text', parse: asText, format: show },
  { key: 'difficulty', label: 'Difficulty', type: 'text', parse: asText, format: show },
  {
    key: 'level',
    label: 'Level',
    type: 'number',
    attrs: { min: String(MIN_LEVEL), max: String(MAX_LEVEL), step: '1' },
    parse: asNumber,
    format: show,
  },
  { key: 'charter', label: 'Charter', type: 'text', parse: asText, format: show },
];

const BPM_FIELD: FieldSpec = {
  key: 'bpm',
  label: 'BPM',
  type: 'number',
  attrs: { min: '1', max: '1000', step: '0.01' },
  parse: asNumber,
  format: show,
};

const OFFSET_FIELD: FieldSpec = {
  key: 'offsetMs',
  label: 'Offset',
  type: 'number',
  attrs: { step: '1' },
  parse: asNumber,
  format: show,
  unit: 'ms',
};

/** Which sections are open, remembered between sessions (a new key: "ataraxia." prefix). */
const SECTIONS_KEY = 'ataraxia.editor-sections';
type SectionId = 'timing' | 'info' | 'selection' | 'stats' | 'suggest';
const DEFAULT_OPEN: Record<SectionId, boolean> = {
  timing: true,
  info: false,
  selection: true,
  stats: false,
  suggest: false,
};

function loadOpen(): Record<SectionId, boolean> {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const out = { ...DEFAULT_OPEN };
    if (typeof parsed === 'object' && parsed !== null) {
      for (const id of Object.keys(DEFAULT_OPEN) as SectionId[]) {
        const v = (parsed as Record<string, unknown>)[id];
        if (typeof v === 'boolean') out[id] = v;
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_OPEN };
  }
}

function saveOpen(open: Record<SectionId, boolean>): void {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(open));
  } catch {
    // Not remembered: fine.
  }
}

export interface EditorPanelOptions {
  /** Time base for tap tempo: song time while playing (so slowed playback still gives the song's BPM). */
  tapTimeMs: (eventTimeStamp: number) => number;
  /** Detect BPM (Timing, under More) and Suggest notes (Suggest section). */
  assist: AssistParts;
}

export interface EditorPanel {
  element: HTMLElement;
  /** Refresh the controls after a state change. */
  update(change: EditorChange): void;
  /** Register a tap (T key or the Tap button). */
  tap(eventTimeStamp: number): void;
  /** Stats for the visible part of the timeline (cheap when the section is closed). */
  updateVisible(range: { startMs: number; endMs: number }): void;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The right panel: collapsible sections with the everyday controls visible and the advanced
 * ones under "More". Timing (open by default), Chart info, Selection (only while notes are
 * selected), Stats and Suggest.
 */
export function createEditorPanel(
  scope: SceneScope,
  state: EditorState,
  options: EditorPanelOptions,
): EditorPanel {
  const open = loadOpen();
  const section = (id: SectionId, title: string): PanelSection =>
    collapsible(scope, {
      id,
      title,
      open: open[id],
      onToggle: (o) => {
        open[id] = o;
        saveOpen(open);
        if (id === 'stats') renderStats();
      },
    });

  const inputs = new Map<FieldKey, { input: HTMLInputElement; spec: FieldSpec }>();
  const errorLine = el('p', { className: 'editor-field-error', attrs: { role: 'alert' } });
  errorLine.hidden = true;
  const fieldErrors = new Map<FieldKey, string>();
  const showErrors = (): void => {
    const messages = [...fieldErrors.values()];
    errorLine.textContent = messages.join(' ');
    errorLine.hidden = messages.length === 0;
  };

  const field = (spec: FieldSpec): HTMLElement => {
    const id = `editor-field-${spec.key}`;
    const input = el('input', {
      className: 'field-input',
      attrs: {
        id,
        type: spec.type,
        autocomplete: 'off',
        spellcheck: 'false',
        ...(spec.type === 'number' ? { inputmode: 'decimal' } : {}),
        ...spec.attrs,
      },
    });
    input.value = spec.format(state.meta[spec.key]);
    inputs.set(spec.key, { input, spec });
    scope.listen(input, 'input', () => {
      const value = spec.parse(input.value);
      const errors =
        value === null || (typeof value === 'number' && Number.isNaN(value))
          ? [`Enter a value for ${spec.label.toLowerCase()}.`]
          : state.setMeta({ [spec.key]: value });
      input.closest('.field')?.classList.toggle('is-invalid', errors.length > 0);
      if (errors.length > 0) fieldErrors.set(spec.key, errors.join(' '));
      else fieldErrors.delete(spec.key);
      showErrors();
    });
    // Leaving a field with an invalid value puts the last valid value back.
    scope.listen(input, 'blur', () => {
      if (!fieldErrors.has(spec.key)) return;
      fieldErrors.delete(spec.key);
      input.closest('.field')?.classList.remove('is-invalid');
      input.value = spec.format(state.meta[spec.key]);
      showErrors();
    });
    const box = el('span', { className: 'field field--text editor-input' }, [
      input,
      ...(spec.unit ? [el('span', { className: 'editor-unit', text: spec.unit })] : []),
    ]);
    return fieldRow(spec.label, box, id);
  };

  const small = (
    label: string,
    tipText: string,
    run: () => void,
    keys: string[] = [],
  ): HTMLButtonElement =>
    tip(button(scope, { label, variant: 'ghost', onClick: run }), tipText, keys, 'left');

  // --- Timing ------------------------------------------------------------------------------

  const tapper = new TapTempo();
  let tappedBpm: number | null = null;
  const tapReadout = el('output', {
    className: 'editor-tap-readout',
    text: 'Tap along to the beat.',
  });
  const applyTap = tip(
    button(scope, {
      label: 'Apply',
      variant: 'secondary',
      onClick: () => {
        if (tappedBpm !== null) state.setBpm(Math.round(tappedBpm * 100) / 100);
      },
    }),
    'Use the tapped BPM',
    [],
    'left',
  );
  applyTap.disabled = true;
  const renderTap = (): void => {
    tappedBpm = tapper.bpm;
    applyTap.disabled = tappedBpm === null;
    tapReadout.textContent =
      tappedBpm === null
        ? tapper.count === 1
          ? 'Keep tapping...'
          : 'Tap along to the beat.'
        : `${tappedBpm.toFixed(2)} BPM from ${tapper.count} taps`;
  };
  const tap = (eventTimeStamp: number): void => {
    tapper.tap(options.tapTimeMs(eventTimeStamp));
    renderTap();
  };
  const tapButton = tip(
    button(scope, { label: 'Tap', variant: 'secondary', hint: 'T' }),
    'Tap tempo: tap on every beat, the last 8 taps are averaged',
    ['T'],
    'left',
  );
  // pointerdown, not click: taps should register when the finger goes down.
  scope.listen(tapButton, 'pointerdown', (e) => tap(e.timeStamp));

  const metronome = toggle(scope, {
    label: 'Metronome',
    checked: state.prefs.metronome,
    onChange: (on) => state.setMetronome(on),
  });
  tip(metronome.root, 'Click on every beat while playing', ['M'], 'left');

  const beatZero = tip(
    button(scope, {
      label: 'Set beat 0 here',
      variant: 'ghost',
      icon: 'target',
      onClick: () => state.setOffsetToPlayhead(),
    }),
    'Set the offset to the playhead time, so a measure starts here',
    [],
    'left',
  );

  const timingMore = disclosure(scope, 'More', [
    el('div', { className: 'editor-more-label', text: 'BPM' }),
    el('div', { className: 'editor-button-grid' }, [
      small('/2', 'Halve the BPM', () => state.scaleBpm(0.5)),
      small('x2', 'Double the BPM', () => state.scaleBpm(2)),
      small('-0.1', 'BPM - 0.1', () => state.nudgeBpm(-0.1)),
      small('+0.1', 'BPM + 0.1', () => state.nudgeBpm(0.1)),
      small('-0.01', 'BPM - 0.01', () => state.nudgeBpm(-0.01)),
      small('+0.01', 'BPM + 0.01', () => state.nudgeBpm(0.01)),
    ]),
    el('div', { className: 'editor-more-label', text: 'Offset' }),
    el('div', { className: 'editor-button-grid is-four' }, [
      small('-10', 'Offset - 10 ms (grid moves earlier)', () => state.nudgeOffset(-10)),
      small('-1', 'Offset - 1 ms', () => state.nudgeOffset(-1)),
      small('+1', 'Offset + 1 ms', () => state.nudgeOffset(1)),
      small('+10', 'Offset + 10 ms (grid moves later)', () => state.nudgeOffset(10)),
    ]),
    el('div', { className: 'editor-more-label', text: 'Detect from the audio' }),
    ...options.assist.detect,
  ]);

  const timing = section('timing', 'Timing');
  timing.body.append(
    el('div', { className: 'editor-field-pair' }, [field(BPM_FIELD), field(OFFSET_FIELD)]),
    el('div', { className: 'editor-row' }, [tapButton, applyTap]),
    tapReadout,
    el('div', { className: 'editor-row is-spread' }, [
      el('span', { className: 'editor-toggle-label' }, [
        el('span', { text: 'Metronome' }),
        el('span', { className: 'editor-dim', text: 'M' }),
      ]),
      metronome.root,
    ]),
    beatZero,
    timingMore.button,
    timingMore.body,
  );

  // --- Chart info and game start -----------------------------------------------------------

  const startReadout = el('output', { className: 'editor-start-readout' });
  const startHelp = el('p', { className: 'editor-help-text' });
  const resetStart = tip(
    button(scope, { label: 'Auto', variant: 'ghost', onClick: () => state.resetStartToAuto() }),
    `Start automatically: ${AUTO_START_LEAD_MS / 1000} s before the first note, or at 0 if that is later`,
    [],
    'left',
  );
  const setStart = tip(
    button(scope, {
      label: 'Set at playhead',
      variant: 'secondary',
      icon: 'flag',
      onClick: () => state.setStartAtPlayhead(),
    }),
    'The game starts at the playhead (at most 30 s before the audio, and no later than 0)',
    [],
    'left',
  );
  const renderStart = (): void => {
    const auto = state.startIsAuto;
    startReadout.textContent = `${formatTimestamp(state.effectiveStartMs)} ${auto ? '(auto)' : '(custom)'}`;
    startReadout.classList.toggle('is-custom', !auto);
    resetStart.disabled = auto;
    startHelp.textContent = auto
      ? `Automatic: ${AUTO_START_LEAD_MS / 1000} s before the first note, never after 0. Drag the flag on the timeline to set it yourself.`
      : 'Before 0 the notes scroll in silently, then the audio begins. Drag the flag to move it.';
  };
  renderStart();

  const info = section('info', 'Chart info');
  info.body.append(
    ...INFO_FIELDS.map(field),
    fieldRow('Start offset', startReadout),
    el('div', { className: 'editor-row' }, [setStart, resetStart]),
    startHelp,
  );

  // --- Selection ---------------------------------------------------------------------------

  const selectionText = el('p', { className: 'editor-selection-text' });
  const selection = section('selection', 'Selection');
  const selTool = (
    iconName: string,
    label: string,
    keys: string[],
    run: () => void,
  ): HTMLButtonElement =>
    iconTool(scope, { icon: iconName, label, keys, side: 'left', onClick: run });
  selection.body.append(
    selectionText,
    el('div', { className: 'editor-row editor-icon-row' }, [
      selTool('chevron-down', 'Move one snap earlier', ['Alt+ArrowDown'], () =>
        state.nudgeSelection(-1),
      ),
      selTool('chevron-up', 'Move one snap later', ['Alt+ArrowUp'], () => state.nudgeSelection(1)),
      selTool('chevron-left', 'Move one lane left', ['Alt+ArrowLeft'], () =>
        state.moveSelection(0, -1),
      ),
      selTool('chevron-right', 'Move one lane right', ['Alt+ArrowRight'], () =>
        state.moveSelection(0, 1),
      ),
      selTool('mirror', 'Mirror (lane becomes 3 - lane)', ['H'], () => state.mirrorSelection()),
      selTool('copy', 'Copy', ['Ctrl+C'], () => state.copySelection()),
      selTool('trash', 'Delete', ['Delete'], () => state.deleteSelection()),
    ]),
  );
  const renderSelection = (): void => {
    const notes = state.selectedNotes;
    selection.root.hidden = notes.length === 0;
    const holds = notes.filter((n) => n.type === 'hold').length;
    const first = notes[0];
    selectionText.textContent =
      notes.length === 0 || !first
        ? ''
        : `${plural(notes.length, 'note')} selected${holds > 0 ? `, ${plural(holds, 'hold')}` : ''}, from ${formatTimestamp(first.t)}`;
  };
  renderSelection();

  // --- Stats -------------------------------------------------------------------------------

  const statRow = (label: string): { row: HTMLElement; value: HTMLElement } => {
    const value = el('dd', { className: 'tabular' });
    return {
      row: el('div', { className: 'editor-stat' }, [el('dt', { text: label }), value]),
      value,
    };
  };
  const sNotes = statRow('Notes');
  const sHolds = statRow('Holds');
  const sAvg = statRow('Average');
  const sPeak = statRow('Peak');
  const sLength = statRow('Length');
  const sVisible = statRow('On screen');
  const stats = section('stats', 'Stats');
  stats.body.append(
    el('dl', { className: 'editor-stats' }, [
      sNotes.row,
      sHolds.row,
      sAvg.row,
      sPeak.row,
      sLength.row,
      sVisible.row,
    ]),
  );
  let statsFor: readonly Note[] | null = null;
  const renderStats = (): void => {
    if (!stats.open || statsFor === state.notes) return;
    statsFor = state.notes;
    const s: ChartStats = chartStats(state.notes);
    sNotes.value.textContent = String(s.notes);
    sHolds.value.textContent = String(s.holds);
    sAvg.value.textContent = `${s.avgNps.toFixed(1)} nps`;
    sPeak.value.textContent = `${s.peakNps} nps`;
    sLength.value.textContent = formatTimestamp(s.lengthMs);
    lastVisible = '';
  };
  let lastVisible = '';
  const updateVisible = (range: { startMs: number; endMs: number }): void => {
    if (!stats.open) return;
    renderStats();
    const v = chartStats(state.notes, range);
    const text = `${plural(v.notes, 'note')}, peak ${v.peakNps} nps`;
    if (text !== lastVisible) {
      lastVisible = text;
      sVisible.value.textContent = text;
    }
  };
  renderStats();

  // --- Suggest -----------------------------------------------------------------------------

  const suggest = section('suggest', 'Suggest');
  suggest.body.append(...options.assist.suggest);

  const element = el(
    'aside',
    { className: 'editor-panel', attrs: { 'aria-label': 'Chart settings' } },
    [errorLine, timing.root, selection.root, info.root, stats.root, suggest.root],
  );

  const update = (change: EditorChange): void => {
    if (change === 'meta') {
      for (const [key, { input, spec }] of inputs) {
        // Never overwrite what the user is typing.
        if (document.activeElement === input) continue;
        input.value = spec.format(state.meta[key]);
      }
    } else if (change === 'start') {
      renderStart();
    } else if (change === 'notes') {
      renderStart();
      renderSelection();
      renderStats();
    } else if (change === 'selection') {
      renderSelection();
    } else if (change === 'metronome') {
      metronome.set(state.prefs.metronome);
    } else if (change === 'playing') {
      // Song time and wall time can't be mixed in one measurement.
      tapper.reset();
      renderTap();
    }
  };

  return { element, update, tap, updateVisible };
}
