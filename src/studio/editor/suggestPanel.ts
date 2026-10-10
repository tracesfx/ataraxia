import { formatTimestamp } from '../../core/beatGrid';
import type { Lane, Note } from '../../core/chart';
import { noteEnd } from '../../core/chart';
import { normalizeSeed } from '../../core/random';
import { beatLengthMs } from '../../core/time';
import {
  button as uiButton,
  iconButton,
  progressBar,
  select,
  slider,
  textField,
  toggle,
} from '../../ui/components';
import { el } from '../../ui/dom';
import { createFilePicker, downloadBlob } from '../../ui/files';
import type { SceneScope } from '../../ui/sceneManager';
import { groupLetter } from '../charting/analysis/evaluate';
import { LAYER_LABELS, type ChartAnalysis, type LayerId } from '../charting/analysis/types';
import { generateChart, type GenerateResult } from '../charting/generate';
import type { HitSource, NoteDecision, Rejection } from '../charting/hits';
import { hitTimes, windowNps } from '../charting/metrics';
import {
  DIFFICULTIES,
  PARAM_GROUPS,
  cloneParams,
  presetParams,
  sanitizeParams,
  type Difficulty,
  type GeneratorParams,
  type ParamControl,
} from '../charting/presets';
import type { EditorChange, EditorState } from './editorState';
import { collapsible, fieldRow, iconTool, segmented, tip } from './editorUi';
import type { NpsCurve } from './overviewRenderer';
import type { AnalysisOverlay } from './timelineRenderer';

/**
 * The Suggest section (Phase 18): every generator setting in collapsible groups (each with a
 * reset to the difficulty's default), named presets of your own (saved locally, exported and
 * imported as JSON), seed, range and fill mode, live preview (regenerates ~250 ms after a change),
 * the last five generations to compare, measured stats with a per-section table, decision
 * entries on hover, a before/after density curve on the minimap and the generator's rejected
 * candidates in the analysis viewer. Accept / Discard as before (accept bar: Enter / Esc / G).
 */

/** Where the generator's analysis comes from (the analysis viewer owns it). */
export interface ChartAnalysisSource {
  chartAnalysis(): Promise<ChartAnalysis | null>;
  onProgress(fn: (fraction: number) => void): () => void;
  setRejections(rejections: readonly Rejection[] | null): void;
}

export interface SuggestParts {
  parts: HTMLElement[];
  update(change: EditorChange): void;
  suggestion(): PendingSuggestion | null;
  accept(): void;
  discard(): void;
  regenerate(): void;
  /** The density plan as an overlay (timeline margin and minimap), or null when hidden. */
  overlay(): AnalysisOverlay | null;
  /** Before/after notes per second for the minimap, while a suggestion is shown. */
  npsCurve(): NpsCurve | null;
  /** The decision entry of a suggested note near (ms, lane), as label/value rows. */
  describeAt(ms: number, lane: Lane, toleranceMs: number): [string, string][] | null;
}

export interface PendingSuggestion {
  notes: readonly Note[];
  replaced: ReadonlySet<Note>;
  rangeMs: { startMs: number; endMs: number };
  summary: string;
}

type RangeChoice = 'song' | 'selection' | 'ab';
type FillMode = 'empty' | 'replace';

/** Settings key (new, so the "ataraxia." prefix) and the named presets key. */
const SETTINGS_KEY = 'ataraxia.suggest-settings';
const PRESETS_KEY = 'ataraxia.suggest-presets';
const HISTORY_SIZE = 5;
const LIVE_DELAY_MS = 250;

interface Settings {
  difficulty: Difficulty;
  params: GeneratorParams;
  seed: number;
  range: RangeChoice;
  fill: FillMode;
  live: boolean;
  overlay: boolean;
}

interface NamedPreset {
  name: string;
  difficulty: Difficulty;
  params: GeneratorParams;
}

function isDifficulty(v: unknown): v is Difficulty {
  return DIFFICULTIES.includes(v as Difficulty);
}

function loadSettings(chartDifficulty: Difficulty | undefined): Settings {
  const difficulty = chartDifficulty ?? 'Normal';
  const s: Settings = {
    difficulty,
    params: presetParams(difficulty),
    seed: randomSeed(),
    range: 'song',
    fill: 'empty',
    live: false,
    overlay: false,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return s;
    const d = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    if (isDifficulty(d.difficulty)) s.difficulty = d.difficulty;
    s.params = sanitizeParams(d.params, presetParams(s.difficulty));
    if (typeof d.seed === 'number') s.seed = normalizeSeed(d.seed);
    if (d.range === 'song' || d.range === 'selection' || d.range === 'ab') s.range = d.range;
    if (d.fill === 'empty' || d.fill === 'replace') s.fill = d.fill;
    if (typeof d.live === 'boolean') s.live = d.live;
    if (typeof d.overlay === 'boolean') s.overlay = d.overlay;
  } catch {
    // Unreadable: defaults.
  }
  return s;
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Not remembered: fine.
  }
}

function parsePresets(raw: unknown): NamedPreset[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { presets?: unknown }).presets)
      ? (raw as { presets: unknown[] }).presets
      : raw && typeof raw === 'object'
        ? [raw]
        : [];
  const out: NamedPreset[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['name'] !== 'string' || o['name'].trim() === '') continue;
    const difficulty = isDifficulty(o['difficulty']) ? o['difficulty'] : 'Expert';
    out.push({
      name: o['name'].trim().slice(0, 60),
      difficulty,
      params: sanitizeParams(o['params'], presetParams(difficulty)),
    });
  }
  return out;
}

function loadPresets(): NamedPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? parsePresets(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function savePresets(list: readonly NamedPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
  } catch {
    // Not remembered: fine.
  }
}

/** A fresh random seed (the UI's choice; generation itself only ever uses the seed). */
function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return normalizeSeed(buf[0] ?? 1);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (v: number): string => `${Math.round(v * 100)}%`;

function sourceLabel(s: HitSource): string {
  return s === 'grid' ? 'Grid' : LAYER_LABELS[s as LayerId];
}

function formatValue(c: Extract<ParamControl, { kind: 'num' }>, v: number): string {
  switch (c.unit) {
    case 'nps':
      return `${v.toFixed(1)} nps`;
    case '%':
      return `${Math.round(v * 100)}%`;
    case 'x':
      return `${v.toFixed(2)}x`;
    case 'beats':
      return `${+v.toFixed(3)} beat${v === 1 ? '' : 's'}`;
    case 'ms':
      return `${Math.round(v)} ms`;
    case 'int':
      return String(Math.round(v));
    case 'gamma':
      return v.toFixed(2);
  }
}

interface Entry {
  result: GenerateResult;
  replaced: ReadonlySet<Note>;
  summary: string;
  label: string;
  bpm: number;
  offsetMs: number;
}

export function createSuggestPanel(
  scope: SceneScope,
  state: EditorState,
  source: ChartAnalysisSource,
  onVisualChange: () => void,
  onPendingChange: () => void,
): SuggestParts {
  const chartDifficulty = DIFFICULTIES.find(
    (d) => d.toLowerCase() === state.meta.difficulty.trim().toLowerCase(),
  );
  const settings = loadSettings(chartDifficulty);
  let presets = loadPresets();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  scope.onDispose(() => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    if (liveTimer !== null) clearTimeout(liveTimer);
    saveSettings(settings);
  });
  const persist = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveSettings(settings);
    }, 300);
  };

  const host = el('div', { className: 'editor-suggest' });
  const filePicker = createFilePicker(scope, host, (files) => void importPresets(files));

  const button = (
    label: string,
    title: string,
    run: () => void,
    o: { primary?: boolean; block?: boolean } = {},
  ): HTMLButtonElement =>
    tip(
      uiButton(scope, {
        label,
        variant: o.primary ? 'primary' : 'ghost',
        block: o.block ?? false,
        onClick: run,
      }),
      title,
      [],
      'left',
    );

  const status = el('p', { className: 'editor-assist-note', attrs: { role: 'status' } });
  status.hidden = true;
  const say = (text: string): void => {
    status.textContent = text;
    status.hidden = text === '';
  };

  // --- Progress (the analysis runs once per song, cached) ----------------------------------
  const bar = progressBar('Song analysis');
  const progressLabel = el('span', { className: 'editor-dim', text: 'Analysing the song...' });
  const progressRow = el('div', { className: 'editor-progress-row' }, [bar.root, progressLabel]);
  progressRow.hidden = true;
  let analysing = false;
  scope.onDispose(
    source.onProgress((f) => {
      if (!analysing) return;
      progressRow.hidden = false;
      bar.set(f);
      progressLabel.textContent = `Analysing the song... ${Math.round(f * 100)}%`;
    }),
  );

  // --- Controls -----------------------------------------------------------------------------
  /** Refreshers for every control (after a difficulty, preset or reset change). */
  const refreshers: (() => void)[] = [];
  const changed = (): void => {
    persist();
    scheduleLive();
  };

  const difficulty = select<Difficulty>(scope, {
    label: 'Suggest difficulty',
    options: DIFFICULTIES.map((d) => {
      const p = presetParams(d);
      return { value: d, label: `${d} (${p.baseNps}-${p.peakNps} nps)` };
    }),
    value: settings.difficulty,
    onChange: (d) => {
      settings.difficulty = d;
      settings.params = presetParams(d);
      refreshAll();
      changed();
      difficulty.select.blur();
    },
  });

  const controlRow = (c: ParamControl): HTMLElement => {
    if (c.kind === 'bool') {
      const t = toggle(scope, {
        label: c.label,
        checked: c.get(settings.params),
        onChange: (v) => {
          c.set(settings.params, v);
          changed();
        },
      });
      refreshers.push(() => t.set(c.get(settings.params)));
      return tip(
        el('div', { className: 'editor-row is-spread' }, [
          el('span', { className: 'editor-toggle-label', text: c.label }),
          t.root,
        ]),
        c.help,
        [],
        'left',
      );
    }
    if (c.kind === 'choice') {
      const s = select<number>(scope, {
        label: c.label,
        options: c.options,
        value: c.get(settings.params),
        onChange: (v) => {
          c.set(settings.params, v);
          changed();
          s.select.blur();
        },
      });
      refreshers.push(() => s.set(c.get(settings.params)));
      return tip(fieldRow(c.label, s.root), c.help, [], 'left');
    }
    const percent = c.unit === '%';
    const toUi = (v: number): number => (percent ? Math.round(v * 100) : v);
    const s = slider(scope, {
      label: c.label,
      min: toUi(c.min),
      max: toUi(c.max),
      step: percent ? Math.round(c.step * 100) : c.step,
      value: toUi(c.get(settings.params)),
      format: (v) => formatValue(c, percent ? v / 100 : v),
      onInput: (v) => {
        c.set(settings.params, percent ? v / 100 : v);
        changed();
      },
    });
    refreshers.push(() => s.set(toUi(c.get(settings.params))));
    return tip(fieldRow(c.label, s.root), c.help, [], 'left');
  };

  const groups = PARAM_GROUPS.map((g) => {
    const section = collapsible(scope, {
      id: `suggest-${g.id}`,
      title: g.title,
      open: g.id === 'density',
    });
    section.root.classList.add('editor-suggest-group');
    section.headerEnd.append(
      iconTool(scope, {
        icon: 'retry',
        label: `Reset ${g.title.toLowerCase()} to the ${settings.difficulty} defaults`,
        side: 'left',
        onClick: () => {
          const defaults = presetParams(settings.difficulty);
          for (const c of g.controls) {
            if (c.kind === 'bool') c.set(settings.params, c.get(defaults));
            else c.set(settings.params, c.get(defaults));
          }
          refreshAll();
          changed();
          say(`${g.title} reset to the ${settings.difficulty} defaults.`);
        },
      }),
    );
    section.body.append(
      el('p', { className: 'editor-help-text', text: g.help }),
      ...g.controls.map(controlRow),
    );
    return section.root;
  });

  // --- Named presets ------------------------------------------------------------------------
  const presetSelect = el('select', {
    className: 'select-input',
    attrs: { 'aria-label': 'My presets' },
  });
  const presetSelectRoot = el('span', { className: 'field select' }, [presetSelect]);
  const renderPresets = (): void => {
    presetSelect.replaceChildren(
      el('option', {
        text: presets.length > 0 ? 'Load a preset...' : 'No saved presets',
        attrs: { value: '' },
      }),
      ...presets.map((p, i) => el('option', { text: p.name, attrs: { value: String(i) } })),
    );
    presetSelect.value = '';
  };
  renderPresets();
  scope.listen(presetSelect, 'change', () => {
    const p = presets[Number(presetSelect.value)];
    if (!p || presetSelect.value === '') return;
    settings.difficulty = p.difficulty;
    settings.params = cloneParams(p.params);
    difficulty.set(p.difficulty);
    refreshAll();
    changed();
    presetSelect.blur();
    say(`Preset "${p.name}" loaded.`);
  });
  const presetName = textField(scope, {
    label: 'Preset name',
    value: '',
    onInput: () => undefined,
  });
  const savePreset = button(
    'Save',
    'Save the current settings under this name (in this browser)',
    () => {
      const name = presetName.input.value.trim();
      if (name === '') {
        say('Type a name for the preset first, then press Save.');
        return;
      }
      const entry: NamedPreset = {
        name,
        difficulty: settings.difficulty,
        params: cloneParams(settings.params),
      };
      const i = presets.findIndex((p) => p.name === name);
      if (i >= 0) presets[i] = entry;
      else presets.push(entry);
      savePresets(presets);
      renderPresets();
      say(`Preset "${name}" saved.`);
    },
  );
  const deletePreset = button('Delete', 'Delete the preset with this name', () => {
    const name = presetName.input.value.trim();
    const before = presets.length;
    presets = presets.filter((p) => p.name !== name);
    if (presets.length === before) {
      say('No preset has that name. Type the name of a saved preset to delete it.');
      return;
    }
    savePresets(presets);
    renderPresets();
    say(`Preset "${name}" deleted.`);
  });
  const exportPresets = button(
    'Export',
    'Download your presets and the current settings as JSON',
    () => {
      const data = {
        format: 'ataraxia-suggest-presets',
        version: 1,
        presets: [
          ...presets,
          { name: 'Current settings', difficulty: settings.difficulty, params: settings.params },
        ],
      };
      downloadBlob(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        'suggest presets.json',
      );
    },
  );
  const importButton = button('Import', 'Add presets from a JSON file', () =>
    filePicker.open('.json,application/json', 'presets'),
  );
  const importPresets = async (files: File[]): Promise<void> => {
    const file = files[0];
    if (!file) return;
    try {
      const found = parsePresets(JSON.parse(await file.text()));
      if (found.length === 0) {
        say('No presets were found in that file. It must be JSON exported from this panel.');
        return;
      }
      for (const p of found) {
        const i = presets.findIndex((q) => q.name === p.name);
        if (i >= 0) presets[i] = p;
        else presets.push(p);
      }
      savePresets(presets);
      renderPresets();
      say(`Imported ${plural(found.length, 'preset')}.`);
    } catch {
      say('That file could not be read as JSON. Choose a presets file exported from this panel.');
    }
  };

  // --- Seed, range, fill, live ----------------------------------------------------------------
  const seedField = textField(scope, {
    label: 'Seed',
    value: String(settings.seed),
    attrs: { inputmode: 'numeric' },
    onInput: (v) => {
      const n = Number(v.trim());
      if (v.trim() !== '' && Number.isFinite(n)) {
        settings.seed = normalizeSeed(n);
        changed();
      }
    },
  });
  const showSeed = (seed: number): void => {
    settings.seed = seed;
    seedField.input.value = String(seed);
    persist();
  };
  const diceButton = iconButton(scope, {
    icon: 'dice',
    label: 'New random seed, then generate',
    onClick: () => {
      showSeed(randomSeed());
      void generate();
    },
  });

  const rangeChoice = segmented<RangeChoice>(scope, {
    label: 'Suggest range',
    options: [
      { value: 'song', label: 'Song', tip: 'Generate for the whole song' },
      {
        value: 'selection',
        label: 'Selection',
        tip: 'Generate between the first and last selected note',
      },
      { value: 'ab', label: 'A-B', tip: 'Generate inside the A-B loop range' },
    ],
    value: settings.range,
    onChange: (v) => {
      settings.range = v;
      rangeChoice.set(v);
      renderRange();
      changed();
    },
  });
  const fillChoice = segmented<FillMode>(scope, {
    label: 'Fill mode',
    options: [
      { value: 'empty', label: 'Empty space', tip: 'Keep existing notes; add around them' },
      { value: 'replace', label: 'Replace', tip: 'Replace the existing notes in the range' },
    ],
    value: settings.fill,
    onChange: (v) => {
      settings.fill = v;
      fillChoice.set(v);
      changed();
    },
  });
  const liveToggle = toggle(scope, {
    label: 'Live preview',
    checked: settings.live,
    onChange: (v) => {
      settings.live = v;
      persist();
      if (v) scheduleLive(true);
    },
  });
  const overlayToggle = toggle(scope, {
    label: 'Show the density plan',
    checked: settings.overlay,
    onChange: (v) => {
      settings.overlay = v;
      persist();
      onVisualChange();
    },
  });

  const rangeOut = el('p', { className: 'editor-assist-note editor-range-note' });
  const clearRangeButton = button('Clear', 'Clear the A-B range', () => state.clearRange());

  /** The range to generate in, or a sentence saying what is missing. */
  const chosenRange = (): { startMs: number; endMs: number } | null | string => {
    if (settings.range === 'song') return null;
    if (settings.range === 'ab') {
      return state.range ?? 'Set A and B first (the A and B buttons, or the A and B keys).';
    }
    const selected = state.selectedNotes;
    const first = selected[0];
    if (!first) return 'Select some notes first: the suggestion fills the time they span.';
    let endMs = first.t;
    for (const n of selected) endMs = Math.max(endMs, noteEnd(n));
    return { startMs: first.t, endMs };
  };
  const renderRange = (): void => {
    const marks = state.rangeMarksSet;
    clearRangeButton.disabled = marks.aMs === null && marks.bMs === null;
    const r = chosenRange();
    rangeOut.textContent =
      r === null
        ? 'Suggesting for the whole song.'
        : typeof r === 'string'
          ? r
          : `Suggesting from ${formatTimestamp(r.startMs)} to ${formatTimestamp(r.endMs)}.`;
  };
  renderRange();

  const generateButton = button(
    'Generate',
    'Suggest notes with this seed as ghost notes (nothing changes until you accept)',
    () => void generate(),
    { primary: true, block: true },
  );
  const sameSeedButton = button(
    'Same seed',
    'Generate again with the same seed (after changing the settings)',
    () => void generate(),
  );

  // --- Results ----------------------------------------------------------------------------------
  const history: Entry[] = [];
  let shown: Entry | null = null;
  let accepting = false;

  const statsList = el('dl', { className: 'editor-suggest-stats tabular' });
  const sectionTable = el('table', { className: 'editor-suggest-table tabular' });
  const historyList = el('div', {
    className: 'editor-suggest-history',
    attrs: { role: 'group', 'aria-label': 'Recent generations' },
  });
  const acceptButton = button(
    'Accept',
    'Add the shown suggestion (one undo step). Also in the bar over the timeline: Enter.',
    () => accept(),
    { primary: true },
  );
  const discardButton = button(
    'Discard',
    'Drop the suggestions. Also in the bar over the timeline: Esc.',
    () => discard(),
  );
  const pendingBox = el('div', { className: 'card editor-assist-result' }, [
    statsList,
    el('span', { className: 'editor-caption', text: 'Per section (nps measured / planned)' }),
    sectionTable,
    el('span', { className: 'editor-caption', text: 'Recent generations' }),
    historyList,
    el('div', { className: 'editor-row' }, [acceptButton, discardButton]),
  ]);
  pendingBox.hidden = true;

  const summaryOf = (r: GenerateResult): string => {
    const s = r.stats;
    return `${plural(s.notes, 'note')} · ${s.avgNps.toFixed(1)} nps average · ${s.peakNps.toFixed(1)} peak · ${plural(s.holds, 'hold')}`;
  };

  const renderStats = (e: Entry): void => {
    const s = e.result.stats;
    const total = Object.values(s.sources).reduce((x, y) => x + (y ?? 0), 0);
    const sources = (Object.entries(s.sources) as [HitSource, number][])
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${sourceLabel(k).toLowerCase()} ${pct(v / Math.max(1, total))}`)
      .join(', ');
    const rows: [string, string][] = [
      [
        'Notes',
        `${s.notes}${e.replaced.size > 0 ? ` (replacing ${e.replaced.size})` : ''}, seed ${e.result.seed}`,
      ],
      [
        'Density',
        `${s.avgNps.toFixed(1)} nps average, ${s.peakNps.toFixed(1)} peak (4 beats), ${s.burstNps.toFixed(1)} burst (1 beat)`,
      ],
      ['Holds', `${pct(s.holdShare)} (${s.shortHolds} short, ${s.longHolds} long)`],
      ['Chords', `${pct(s.chordShare)} of hits`],
      [
        'Movement',
        `jacks ${pct(s.jackShare)}, trills ${pct(s.trillShare)}, stairs ${pct(s.stairShare)} (measured)`,
      ],
      [
        'Longest gap',
        `${(s.longestGapMs / 1000).toFixed(2)} s at ${formatTimestamp(s.longestGapAtMs)}; ${(s.longestIntenseGapMs / 1000).toFixed(2)} s in intense parts`,
      ],
      [
        'Repeats',
        s.repeatConsistency === null
          ? 'none in range'
          : `shared rhythm ${pct(s.spineConsistency ?? 0)} alike, all notes ${pct(s.repeatConsistency)}`,
      ],
      ['Rhythm from', sources || '-'],
    ];
    statsList.replaceChildren(
      ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]),
    );
    sectionTable.replaceChildren(
      ...s.sections.map((sec) =>
        el('tr', {}, [
          el('td', { text: formatTimestamp(sec.startMs).slice(0, 5) }),
          el('td', { text: sec.label }),
          el('td', { text: sec.nps.toFixed(1) }),
          el('td', { className: 'editor-dim', text: sec.targetNps.toFixed(1) }),
        ]),
      ),
    );
    historyList.replaceChildren(
      ...history.map((h, i) => {
        const b = el(
          'button',
          { className: 'chip chip--steel editor-seg', attrs: { type: 'button' } },
          [el('span', { className: 'chip-label', text: `${i + 1}` })],
        );
        b.setAttribute('aria-pressed', String(h === shown));
        tip(b, h.label, [], 'above');
        scope.listen(b, 'click', () => show(h));
        return b;
      }),
    );
  };

  const show = (e: Entry | null): void => {
    shown = e;
    pendingBox.hidden = e === null;
    if (e) renderStats(e);
    source.setRejections(e ? e.result.rejections : null);
    onPendingChange();
    onVisualChange();
  };

  let running = false;
  let again = false;
  const generate = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      say('');
      const range = chosenRange();
      if (typeof range === 'string') {
        say(range);
        return;
      }
      analysing = true;
      generateButton.disabled = true;
      let analysis: ChartAnalysis | null = null;
      try {
        analysis = await source.chartAnalysis();
      } finally {
        analysing = false;
        if (!scope.disposed) {
          progressRow.hidden = true;
          generateButton.disabled = false;
        }
      }
      if (scope.disposed) return;
      if (!analysis) {
        say(
          'The song could not be analysed, so nothing was suggested. Reopen the editor and try again.',
        );
        return;
      }
      if (analysis.candidates.length < 8) {
        say('No notes suggested: no clear note onsets were found in this audio.');
        return;
      }
      const result = generateChart(
        { analysis, existing: state.notes, durationMs: state.durationMs },
        {
          params: settings.params,
          seed: settings.seed,
          range,
          replaceExisting: settings.fill === 'replace',
        },
      );
      if (result.notes.length === 0) {
        say(
          settings.fill === 'replace'
            ? 'No notes suggested here. Check the BPM and offset, or raise the base density.'
            : 'No notes suggested: there is no room between the existing notes here. Try the Replace fill mode.',
        );
        return;
      }
      const entry: Entry = {
        result,
        replaced: new Set(result.removed),
        summary: summaryOf(result),
        label: `Seed ${result.seed}, ${settings.difficulty}: ${summaryOf(result)}`,
        bpm: state.meta.bpm,
        offsetMs: state.meta.offsetMs,
      };
      history.push(entry);
      while (history.length > HISTORY_SIZE) history.shift();
      show(entry);
      say(
        'Suggested notes are outlined on the timeline; hover one to see why it is there. Enter accepts, Esc discards.',
      );
      if (!settings.live) state.notify('Preview ready: Enter to accept, Esc to discard');
    } finally {
      running = false;
      if (again && !scope.disposed) {
        again = false;
        void generate();
      }
    }
  };

  function scheduleLive(now = false): void {
    if (!settings.live) return;
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = setTimeout(
      () => {
        liveTimer = null;
        void generate();
      },
      now ? 0 : LIVE_DELAY_MS,
    );
  }

  function refreshAll(): void {
    for (const r of refreshers) r();
    difficulty.set(settings.difficulty);
  }

  const clearAll = (): void => {
    history.length = 0;
    show(null);
  };

  const accept = (): void => {
    const e = shown;
    if (!e) return;
    accepting = true;
    const ok = state.insertSuggested(e.result.notes, e.result.removed);
    accepting = false;
    clearAll();
    say(
      ok
        ? `Added ${plural(e.result.notes.length, 'note')}${e.result.removed.length > 0 ? ` (replacing ${e.result.removed.length})` : ''}. They are selected: Delete removes them, Ctrl+Z undoes.`
        : 'The suggestion no longer fits the chart. Generate again.',
    );
  };

  const discard = (): void => {
    if (!shown) return;
    clearAll();
    say('Suggestions discarded.');
  };

  const regenerate = (): void => {
    if (!shown || running) return;
    showSeed(randomSeed());
    void generate();
  };

  const parts: HTMLElement[] = [
    host,
    el('p', {
      className: 'editor-help-text',
      text: 'A seeded first draft that follows the song: the most salient rhythm (the lead first) as one continuous chart, repeats sharing one rhythm, never empty where there is sound. It needs manual cleanup.',
    }),
    tip(
      fieldRow('Difficulty', difficulty.root),
      'Sets every setting below to its defaults; any setting can then be changed.',
      [],
      'left',
    ),
    fieldRow(
      'Seed',
      el('div', { className: 'editor-row editor-seed-row' }, [seedField.root, diceButton]),
    ),
    fieldRow('Range', rangeChoice.root),
    el('div', { className: 'editor-row' }, [
      button('Set A', 'Range start at the playhead (A)', () => state.setRangeMark('a')),
      button('Set B', 'Range end at the playhead (B)', () => state.setRangeMark('b')),
      clearRangeButton,
    ]),
    rangeOut,
    fieldRow('Fill', fillChoice.root),
    tip(
      el('div', { className: 'editor-row is-spread' }, [
        el('span', { className: 'editor-toggle-label', text: 'Live preview' }),
        liveToggle.root,
      ]),
      'Generate again about a quarter second after any change.',
      [],
      'left',
    ),
    tip(
      el('div', { className: 'editor-row is-spread' }, [
        el('span', { className: 'editor-toggle-label', text: 'Show the density plan' }),
        overlayToggle.root,
      ]),
      'The planned notes per second (after a generation) beside the waveform and on the minimap; build-ups shaded.',
      [],
      'left',
    ),
    el('div', { className: 'editor-row' }, [generateButton, sameSeedButton]),
    progressRow,
    status,
    pendingBox,
    ...groups,
    el('span', { className: 'editor-caption', text: 'My presets' }),
    presetSelectRoot,
    el('div', { className: 'editor-row editor-seed-row' }, [presetName.root]),
    el('div', { className: 'editor-row is-wrap' }, [
      savePreset,
      deletePreset,
      exportPresets,
      importButton,
    ]),
  ];

  // The density plan as an overlay: target nps per beat, 0-1 over the plan's maximum.
  let curveCache: { entry: Entry; notes: readonly Note[]; curve: NpsCurve } | null = null;
  let overlayFor: GenerateResult | null = null;
  let overlayData: AnalysisOverlay | null = null;
  const lastResult = (): GenerateResult | null =>
    shown?.result ?? history[history.length - 1]?.result ?? null;

  return {
    parts,
    update(change) {
      if (change === 'range' || change === 'selection') renderRange();
      const timingChanged =
        change === 'meta' &&
        shown !== null &&
        (shown.bpm !== state.meta.bpm || shown.offsetMs !== state.meta.offsetMs);
      if (shown && !accepting && (change === 'notes' || timingChanged)) {
        clearAll();
        say('The suggestions were discarded because the chart changed. Generate again.');
      }
    },
    suggestion: () =>
      shown
        ? {
            notes: shown.result.notes,
            replaced: shown.replaced,
            rangeMs: shown.result.rangeMs,
            summary: shown.summary,
          }
        : null,
    accept,
    discard,
    regenerate,
    overlay() {
      if (!settings.overlay) return null;
      const r = lastResult();
      if (!r) return null;
      if (r !== overlayFor) {
        overlayFor = r;
        const plan = r.plan;
        let peak = 0;
        for (const v of plan.targets) peak = Math.max(peak, v);
        const intensity = plan.targets.map((v) => (peak > 0 ? v / peak : 0));
        const buildUps: AnalysisOverlay['buildUps'] = [];
        plan.roles.forEach((role, i) => {
          if (role !== 'build-up') return;
          const startMs = plan.startMs + i * plan.beatMs;
          const last = buildUps[buildUps.length - 1];
          if (last && Math.abs(last.endMs - startMs) < 1) last.endMs = startMs + plan.beatMs;
          else buildUps.push({ startMs, endMs: startMs + plan.beatMs, rise: 1 });
        });
        overlayData = {
          frameMs: plan.beatMs,
          frameOffsetMs: plan.startMs + plan.beatMs / 2,
          frameCount: plan.targets.length,
          intensity,
          impacts: [],
          buildUps,
        };
      }
      return overlayData;
    },
    npsCurve() {
      if (!shown) return null;
      if (curveCache && curveCache.entry === shown && curveCache.notes === state.notes) {
        return curveCache.curve;
      }
      const windowMs = beatLengthMs(state.meta.bpm) * 4;
      const after = state.notes.filter((n) => !shown?.replaced.has(n)).concat(shown.result.notes);
      const curve: NpsCurve = {
        startMs: 0,
        windowMs,
        before: windowNps(hitTimes(state.notes), 0, state.durationMs, windowMs),
        after: windowNps(hitTimes(after), 0, state.durationMs, windowMs),
      };
      curveCache = { entry: shown, notes: state.notes, curve };
      return curve;
    },
    describeAt(ms, lane, toleranceMs) {
      if (!shown) return null;
      let found: Note | null = null;
      for (const n of shown.result.notes) {
        if (n.lane !== lane) continue;
        if (ms >= n.t - toleranceMs && ms <= noteEnd(n) + toleranceMs) {
          if (!found || Math.abs(n.t - ms) < Math.abs(found.t - ms)) found = n;
        }
      }
      if (!found) return null;
      const d: NoteDecision | undefined = shown.result.decisions.get(found);
      if (!d) return null;
      const rows: [string, string][] = [
        ['Note', `${formatTimestamp(found.t)}, lane ${found.lane + 1}`],
        ['Source', sourceLabel(d.source)],
        ['Reason', d.reason],
        ['Score', d.score.toFixed(2)],
        ['Repeat', d.group >= 0 ? `${groupLetter(d.group)}${d.instance + 1}` : 'none'],
        ['Grid', `1/${d.division * 4}`],
      ];
      if (d.chord > 1) rows.push(['Chord', `${d.chord} notes`]);
      if (found.type === 'hold') rows.push(['Hold', `${found.dur} ms, ${d.hold}`]);
      return rows;
    },
  };
}
