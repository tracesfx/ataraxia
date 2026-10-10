import { compareNotes, type Chart, type Note } from '../../core/chart';
import { parseChart } from '../../core/parseChart';
import { button as uiButton, slider, toggle } from '../../ui/components';
import { el } from '../../ui/dom';
import { createFilePicker } from '../../ui/files';
import type { SceneScope } from '../../ui/sceneManager';
import {
  DEFAULT_COMPARE_TOLERANCE_MS,
  diffCharts,
  diffCountsIn,
  type ChartDiff,
  type DiffStatus,
  type MatchCounts,
} from '../charting/compare';
import type { EditorChange, EditorState } from './editorState';
import { collapsible, fieldRow, tip } from './editorUi';
import type { PendingSuggestion } from './suggestPanel';

/**
 * "Compare chart" (Phase 19), in the Suggest section: another chart of the same song (or a chart
 * JSON file) shown as read-only markers on the timeline, diffed against the chart being edited,
 * or against the chart with the generator's preview applied while one is shown. Markers:
 * matched (within the tolerance), missing (only in the compare chart) and extra (only in mine).
 * Counts and precision / recall / F1 for the visible range and the whole chart; "Rhythm only"
 * matches moments and ignores lanes. Never changes the chart. C shows or hides the markers.
 */

export interface CompareSource {
  /** The other charts of this song (not the one being edited). */
  listCharts(): Promise<{ id: string; label: string }[]>;
  loadChart(id: string): Promise<Chart>;
  /** The generator preview waiting for Accept, if any. */
  pending(): PendingSuggestion | null;
}

/** What the note layer draws. */
export interface CompareLayer {
  /** Compare chart notes (sorted) and their status ('matched' or 'missing'). */
  theirs: readonly Note[];
  theirStatus: readonly DiffStatus[];
  /** My notes (chart or chart + preview) that the compare chart lacks. */
  extras: readonly Note[];
}

export interface CompareParts {
  parts: HTMLElement[];
  layer(): CompareLayer | null;
  /** The visible time range changed (each frame; cheap when it didn't). */
  updateVisible(range: { startMs: number; endMs: number }): void;
  /** C: show / hide the markers (only with a compare chart loaded). */
  toggleShown(): void;
  update(change: EditorChange): void;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const countsText = (c: MatchCounts): string =>
  `${c.matched} matched · ${c.missing} missing · ${c.extra} extra`;
const scoreText = (c: MatchCounts): string =>
  `precision ${pct(c.precision)} · recall ${pct(c.recall)} · F1 ${pct(c.f1)}`;

export function createComparePanel(
  scope: SceneScope,
  state: EditorState,
  source: CompareSource,
  onVisualChange: () => void,
): CompareParts {
  let theirs: Note[] | null = null;
  let theirName = '';
  let shown = true;
  let rhythmOnly = false;
  let toleranceMs = DEFAULT_COMPARE_TOLERANCE_MS;

  const section = collapsible(scope, {
    id: 'suggest-compare',
    title: 'Compare chart',
    open: false,
  });
  section.root.classList.add('editor-suggest-group');
  const host = el('div');
  const status = el('p', { className: 'editor-assist-note', attrs: { role: 'status' } });
  status.hidden = true;
  const say = (text: string): void => {
    status.textContent = text;
    status.hidden = text === '';
  };

  // --- Choosing the compare chart -------------------------------------------------------------
  const chartSelect = el('select', {
    className: 'select-input',
    attrs: { 'aria-label': 'Chart to compare with' },
  });
  const chartSelectRoot = el('span', { className: 'field select' }, [chartSelect]);
  const fillCharts = async (): Promise<void> => {
    let list: { id: string; label: string }[];
    try {
      list = await source.listCharts();
    } catch {
      list = [];
    }
    if (scope.disposed) return;
    chartSelect.replaceChildren(
      el('option', {
        text: list.length > 0 ? 'Pick a chart of this song...' : 'No other charts of this song',
        attrs: { value: '' },
      }),
      ...list.map((c) => el('option', { text: c.label, attrs: { value: c.id } })),
    );
    chartSelect.value = '';
  };
  void fillCharts();
  scope.listen(chartSelect, 'focus', () => void fillCharts());
  scope.listen(chartSelect, 'change', () => {
    const id = chartSelect.value;
    const label = chartSelect.selectedOptions[0]?.textContent ?? 'chart';
    chartSelect.blur();
    if (id === '') return;
    source.loadChart(id).then(
      (chart) => {
        if (!scope.disposed) use(chart.notes, label);
      },
      () => {
        if (!scope.disposed)
          say('That chart could not be loaded. Pick it again, or import it as JSON.');
      },
    );
  });

  const filePicker = createFilePicker(scope, host, (files) => void importFile(files[0]));
  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      say(`"${file.name}" could not be read. Check that the file still exists and try again.`);
      return;
    }
    const parsed = parseChart(text);
    if (scope.disposed) return;
    if (!parsed.ok) {
      say(`"${file.name}" is not a valid chart: ${parsed.errors.slice(0, 3).join(' ')}`);
      return;
    }
    use(parsed.chart.notes, file.name);
  };

  const use = (notes: readonly Note[], name: string): void => {
    theirs = [...notes].sort(compareNotes);
    theirName = name;
    shown = true;
    showToggle.set(true);
    cache = null;
    say('');
    render();
    onVisualChange();
  };
  const clear = (): void => {
    theirs = null;
    theirName = '';
    cache = null;
    render();
    onVisualChange();
  };

  // --- Options --------------------------------------------------------------------------------
  const showToggle = toggle(scope, {
    label: 'Show compare markers',
    checked: shown,
    onChange: (v) => {
      shown = v;
      onVisualChange();
    },
  });
  const rhythmToggle = toggle(scope, {
    label: 'Rhythm only',
    checked: rhythmOnly,
    onChange: (v) => {
      rhythmOnly = v;
      cache = null;
      render();
      onVisualChange();
    },
  });
  const tolerance = slider(scope, {
    label: 'Match tolerance',
    min: 10,
    max: 100,
    step: 5,
    value: toleranceMs,
    format: (v) => `${Math.round(v)} ms`,
    onInput: (v) => {
      toleranceMs = v;
      cache = null;
      render();
      onVisualChange();
    },
  });
  const switchRow = (label: string, root: HTMLElement, help: string): HTMLElement =>
    tip(
      el('div', { className: 'editor-row is-spread' }, [
        el('span', { className: 'editor-toggle-label', text: label }),
        root,
      ]),
      help,
      [],
      'left',
    );
  const button = (label: string, title: string, run: () => void): HTMLButtonElement =>
    tip(uiButton(scope, { label, variant: 'ghost', onClick: run }), title, [], 'left');

  // --- Results ----------------------------------------------------------------------------------
  const sourceOut = el('p', { className: 'editor-assist-note' });
  const stats = el('dl', { className: 'editor-suggest-stats tabular' });
  const resultBox = el('div', { className: 'card editor-assist-result' }, [sourceOut, stats]);
  resultBox.hidden = true;

  /** The notes being judged: the chart, with the preview applied while one is shown. */
  const mine = (): { notes: readonly Note[]; preview: boolean } => {
    const p = source.pending();
    if (!p) return { notes: state.notes, preview: false };
    const notes = state.notes
      .filter((n) => !p.replaced.has(n))
      .concat(p.notes)
      .sort(compareNotes);
    return { notes, preview: true };
  };

  let cache: {
    base: readonly Note[];
    pending: PendingSuggestion | null;
    mine: readonly Note[];
    preview: boolean;
    diff: ChartDiff;
    layer: CompareLayer;
  } | null = null;
  const current = (): NonNullable<typeof cache> | null => {
    if (!theirs) return null;
    const pending = source.pending();
    if (cache && cache.base === state.notes && cache.pending?.notes === pending?.notes)
      return cache;
    const m = mine();
    const diff = diffCharts(m.notes, theirs, { toleranceMs, rhythmOnly });
    cache = {
      base: state.notes,
      pending,
      mine: m.notes,
      preview: m.preview,
      diff,
      layer: {
        theirs,
        theirStatus: diff.theirs,
        extras: m.notes.filter((_, i) => diff.mine[i] === 'extra'),
      },
    };
    lastVisibleKey = '';
    return cache;
  };

  let visible = { startMs: 0, endMs: 0 };
  let lastVisibleKey = '';
  const renderStats = (): void => {
    const c = current();
    if (!c || !theirs) return;
    const whole = c.diff.total;
    const vis = diffCountsIn(c.mine, theirs, c.diff, rhythmOnly, visible.startMs, visible.endMs);
    const unit = rhythmOnly ? 'hits (lanes ignored)' : 'notes (same lane)';
    const rows: [string, string][] = [
      ['Whole chart', countsText(whole)],
      ['', scoreText(whole)],
      ['On screen', countsText(vis)],
      ['', scoreText(vis)],
    ];
    stats.replaceChildren(
      ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]),
    );
    sourceOut.textContent =
      `Comparing ${c.preview ? 'this chart with the preview applied' : 'this chart'} with ` +
      `"${theirName}": ${unit}, within ${toleranceMs} ms. Precision: share of mine the compare ` +
      'chart has; recall: share of the compare chart I have.';
  };
  function render(): void {
    resultBox.hidden = theirs === null;
    clearButton.disabled = theirs === null;
    if (theirs) renderStats();
  }

  const clearButton = button('Clear', 'Stop comparing (the markers go away)', clear);
  section.body.append(
    host,
    el('p', {
      className: 'editor-help-text',
      text: 'Show another chart of this song as read-only markers: matched notes thin, missing ones (only in the compare chart) amber, extra ones (only in this chart or the preview) violet. Works on the generator preview too. Nothing in the chart changes.',
    }),
    fieldRow('Compare with', chartSelectRoot),
    el('div', { className: 'editor-row' }, [
      button('Import JSON', 'Compare with a chart file (.json) instead', () =>
        filePicker.open('.json,application/json', 'compare'),
      ),
      clearButton,
    ]),
    switchRow('Show markers', showToggle.root, 'Show or hide the compare markers (C).'),
    switchRow(
      'Rhythm only',
      rhythmToggle.root,
      'Match moments regardless of lane (a chord counts once).',
    ),
    tip(
      fieldRow('Tolerance', tolerance.root),
      'Notes this close in time count as the same note.',
      [],
      'left',
    ),
    status,
    resultBox,
  );
  render();

  return {
    parts: [section.root],
    layer() {
      if (!shown) return null;
      return current()?.layer ?? null;
    },
    updateVisible(range) {
      if (!theirs) return;
      const c = current();
      const key = `${Math.round(range.startMs)}|${Math.round(range.endMs)}|${c?.mine.length ?? 0}`;
      if (key === lastVisibleKey) return;
      lastVisibleKey = key;
      visible = range;
      renderStats();
    },
    toggleShown() {
      if (!theirs) {
        state.notify('Pick a chart to compare with first (Suggest > Compare chart).');
        return;
      }
      shown = !shown;
      showToggle.set(shown);
      onVisualChange();
    },
    update(change) {
      if (change === 'notes' && theirs) {
        cache = null;
        render();
      }
    },
  };
}
