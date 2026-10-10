import type { AudioAnalyzer } from '../../audio/audioAnalysis';
import { formatMeasureBeat, formatTimestamp } from '../../core/beatGrid';
import { button, progressBar, slider, toggle } from '../../ui/components';
import { el } from '../../ui/dom';
import { downloadBlob } from '../../ui/files';
import type { SceneScope } from '../../ui/sceneManager';
import { ChartAnalyzer } from '../charting/analysis/chartAnalyzer';
import {
  analysisCounts,
  chartAnalysisToJson,
  evaluateChartAnalysis,
  groupLetter,
  legacyCurves,
  midiName,
  reweightChartAnalysis,
} from '../charting/analysis/evaluate';
import {
  ACTIVITY_LABELS,
  ACTIVITY_PARTS,
  BANDS,
  BAND_LABELS,
  CHART_ANALYSIS_VERSION,
  DEFAULT_CHART_ANALYSIS_PARAMS,
  LAYERS,
  LAYER_LABELS,
  MIN_LEAD_INTERVAL_RANGE,
  SECTION_LABELS,
  type ActivityPart,
  type ChartAnalysis,
  type ChartAnalysisParams,
  type ChartFeatures,
  type LegacyCurves,
} from '../charting/analysis/types';
import type { StudioLibrary } from '../studioLibrary';
import type { Rejection } from '../charting/hits';
import {
  HEADER_PX,
  TRACKS,
  TRACK_BY_ID,
  TRACK_GAP_PX,
  prepareTrackData,
  type TrackColumn,
  type TrackData,
  type TrackId,
} from './analysisTracks';
import type { EditorTheme } from './editorTheme';
import type { EditorState } from './editorState';
import { collapsible, iconTool, tip } from './editorUi';
import type { TimelineLayout } from './timelineLayout';

/**
 * The analysis viewer (Phase 17): everything ChartAnalysis sees, in the editor. Owns the
 * analyzer (features in a worker, cached per song), re-evaluates live when the timing or a
 * slider changes (at most once per frame), lays out the tracks beside the lanes, and runs the
 * floating Analysis panel and the hover inspector. Drawing lives in analysisTracks.ts.
 */

/** Viewer preferences (a new key, so the "ataraxia." prefix). */
const PREFS_KEY = 'ataraxia.editor-analysis';

interface TrackPref {
  on: boolean;
  width: number;
}

interface ViewerPrefs {
  on: boolean;
  ticks: boolean;
  inspect: boolean;
  tracks: Record<string, TrackPref>;
  params: ChartAnalysisParams;
}

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

function defaultPrefs(): ViewerPrefs {
  const tracks: Record<string, TrackPref> = {};
  for (const t of TRACKS) tracks[t.id] = { on: true, width: t.width };
  return {
    on: false,
    ticks: true,
    inspect: true,
    tracks,
    params: {
      ...DEFAULT_CHART_ANALYSIS_PARAMS,
      weights: { ...DEFAULT_CHART_ANALYSIS_PARAMS.weights },
    },
  };
}

function loadPrefs(): ViewerPrefs {
  const prefs = defaultPrefs();
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return prefs;
    const data = JSON.parse(raw) as Partial<Record<keyof ViewerPrefs, unknown>>;
    if (typeof data.on === 'boolean') prefs.on = data.on;
    if (typeof data.ticks === 'boolean') prefs.ticks = data.ticks;
    if (typeof data.inspect === 'boolean') prefs.inspect = data.inspect;
    const tracks = data.tracks as Record<string, Partial<TrackPref>> | undefined;
    if (tracks && typeof tracks === 'object') {
      for (const t of TRACKS) {
        const p = tracks[t.id];
        if (!p) continue;
        prefs.tracks[t.id] = {
          on: typeof p.on === 'boolean' ? p.on : true,
          width: Math.round(num(p.width, t.minWidth, t.maxWidth, t.width)),
        };
      }
    }
    const params = data.params as Partial<ChartAnalysisParams> | undefined;
    if (params && typeof params === 'object') {
      const d = DEFAULT_CHART_ANALYSIS_PARAMS;
      prefs.params.leadSensitivity = num(params.leadSensitivity, 0, 1, d.leadSensitivity);
      prefs.params.layerSensitivity = num(params.layerSensitivity, 0, 1, d.layerSensitivity);
      prefs.params.minLeadIntervalMs = num(
        params.minLeadIntervalMs,
        MIN_LEAD_INTERVAL_RANGE[0],
        MIN_LEAD_INTERVAL_RANGE[1],
        d.minLeadIntervalMs,
      );
      const w = params.weights as Partial<Record<ActivityPart, unknown>> | undefined;
      if (w && typeof w === 'object') {
        for (const p of ACTIVITY_PARTS) prefs.params.weights[p] = num(w[p], 0, 1, d.weights[p]);
      }
    }
  } catch {
    // Unreadable: defaults.
  }
  return prefs;
}

function savePrefs(prefs: ViewerPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered: fine.
  }
}

/** Minimap bands: section roles and repeat groups. */
export interface OverviewBands {
  sections: { startMs: number; endMs: number; color: string }[];
  repeats: { startMs: number; endMs: number; color: string }[];
}

export interface AnalysisView {
  readonly on: boolean;
  toggle(force?: boolean): void;
  /** Width the tracks would like (CSS px; 0 when off). */
  tracksWidth(): number;
  /**
   * CSS px the docked panel covers on the right of the timeline (the layout keeps clear of it);
   * 0 when it is off or was dragged elsewhere.
   */
  reservedRight(): number;
  /** Track columns that fit in the layout's track area. */
  columns(layout: TimelineLayout): TrackColumn[];
  /** Prepared data to draw, or null (off or not ready). */
  data(): TrackData | null;
  /** Draw candidate ticks and runs over the lanes. */
  ticksOn(): boolean;
  overviewBands(): OverviewBands | null;
  /** Once per frame: apply pending re-evaluations. */
  frame(playheadMs: number): void;
  /** BPM or offset changed. */
  timingChanged(): void;
  /** Pointer on the timeline (CSS px). True when the viewer took the press. */
  pointerDown(x: number, y: number): boolean;
  pointerMove(x: number, y: number): void;
  pointerUp(): void;
  pointerLeave(): void;
  /** The view moved under a still pointer: refresh the inspector. */
  refreshInspect(): void;
  /** True while a header edge is hovered or dragged (resize cursor). */
  readonly resizeCursor: boolean;
  /**
   * The analysis at the chart's current timing (computing the features first if needed, even
   * with the viewer off), or null when it failed or the editor closed.
   */
  chartAnalysis(): Promise<ChartAnalysis | null>;
  /** Feature computation progress (0-1). */
  onProgress(fn: (fraction: number) => void): () => void;
  /** The last generation's rejected candidates (drawn on the lanes and in the inspector). */
  setRejections(rejections: readonly Rejection[] | null): void;
}

export function createAnalysisView(
  scope: SceneScope,
  o: {
    host: HTMLElement;
    state: EditorState;
    buffer: AudioBuffer;
    legacy: AudioAnalyzer;
    studioLibrary: StudioLibrary;
    songId: string;
    theme: EditorTheme;
    /** Song time at a timeline y (CSS px), as displayed. */
    timeAt: (y: number) => number;
    seek: (ms: number) => void;
    /** Something to redraw. */
    changed: () => void;
    /** On/off changed (toolbar button). */
    toggled: (on: boolean) => void;
  },
): AnalysisView {
  const { state, theme } = o;
  const prefs = loadPrefs();
  const analyzer = new ChartAnalyzer(
    o.buffer,
    o.studioLibrary.chartAnalysisStore(o.songId, CHART_ANALYSIS_VERSION),
  );
  scope.onDispose(() => {
    analyzer.dispose();
    savePrefs(prefs);
  });

  let features: ChartFeatures | null = null;
  let legacy: LegacyCurves | null = null;
  let analysis: ChartAnalysis | null = null;
  let trackData: TrackData | null = null;
  let bands: OverviewBands | null = null;
  let rejections: readonly Rejection[] | null = null;
  /** What the next frame must recompute. */
  let pending: 'none' | 'weights' | 'all' = 'none';
  let started = false;
  let failed: string | null = null;
  let layout: TimelineLayout | null = null;
  let prefsTimer: ReturnType<typeof setTimeout> | null = null;
  scope.onDispose(() => {
    if (prefsTimer !== null) clearTimeout(prefsTimer);
  });
  const persist = (): void => {
    if (prefsTimer !== null) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      prefsTimer = null;
      savePrefs(prefs);
    }, 300);
  };

  // --- Panel -----------------------------------------------------------------------------------

  const progress = progressBar('Song analysis');
  const statusText = el('p', { className: 'editor-dim editor-analysis-status' });
  const progressRow = el('div', { className: 'editor-analysis-progress' }, [
    progress.root,
    statusText,
  ]);
  analyzer.onProgress((fraction) => {
    progress.set(fraction);
    statusText.textContent = `Analysing the song... ${Math.round(fraction * 100)} %`;
  });

  const summary = el('dl', { className: 'editor-analysis-summary' });
  const ssmCanvas = el('canvas', { className: 'editor-analysis-ssm' });
  tip(
    ssmCanvas,
    'Bar self-similarity: bar i (down) against bar j (across); bright = alike. Click a cell to jump to that bar.',
    [],
    'left',
  );
  const ssmCtx = ssmCanvas.getContext('2d');
  let ssmBars = 0;
  let ssmCursorBar = -1;
  const ssmBase = document.createElement('canvas');

  const sliderRow = (label: string, help: string, control: { root: HTMLElement }): HTMLElement =>
    tip(
      el('label', { className: 'editor-field' }, [
        el('span', { className: 'editor-field-label', text: label }),
        control.root,
      ]),
      help,
      [],
      'left',
    );
  const toggleRow = (label: string, control: HTMLElement, help: string): HTMLElement =>
    tip(
      el('div', { className: 'editor-row is-spread' }, [
        el('span', { className: 'editor-toggle-label', text: label }),
        control,
      ]),
      help,
      [],
      'left',
    );

  const weightSliders = ACTIVITY_PARTS.map((part) => {
    const s = slider(scope, {
      label: `${ACTIVITY_LABELS[part]} weight`,
      min: 0,
      max: 100,
      step: 1,
      value: Math.round(prefs.params.weights[part] * 100),
      format: (v) => (v / 100).toFixed(2),
      onInput: (v) => {
        prefs.params.weights[part] = v / 100;
        if (pending !== 'all') pending = 'weights';
        persist();
      },
    });
    return { part, s };
  });
  const resetWeights = button(scope, {
    label: 'Reset weights',
    variant: 'ghost',
    onClick: () => {
      for (const { part, s } of weightSliders) {
        prefs.params.weights[part] = DEFAULT_CHART_ANALYSIS_PARAMS.weights[part];
        s.set(Math.round(prefs.params.weights[part] * 100));
      }
      if (pending !== 'all') pending = 'weights';
      persist();
    },
  });

  const leadSens = slider(scope, {
    label: 'Lead sensitivity',
    min: 0,
    max: 100,
    step: 1,
    value: Math.round(prefs.params.leadSensitivity * 100),
    format: (v) => `${Math.round(v)}%`,
    onInput: (v) => {
      prefs.params.leadSensitivity = v / 100;
      pending = 'all';
      persist();
    },
  });
  const leadInterval = slider(scope, {
    label: 'Minimum lead interval',
    min: MIN_LEAD_INTERVAL_RANGE[0],
    max: MIN_LEAD_INTERVAL_RANGE[1],
    step: 1,
    value: prefs.params.minLeadIntervalMs,
    format: (v) => `${Math.round(v)} ms`,
    onInput: (v) => {
      prefs.params.minLeadIntervalMs = v;
      pending = 'all';
      persist();
    },
  });
  const layerSens = slider(scope, {
    label: 'Drum and bass sensitivity',
    min: 0,
    max: 100,
    step: 1,
    value: Math.round(prefs.params.layerSensitivity * 100),
    format: (v) => `${Math.round(v)}%`,
    onInput: (v) => {
      prefs.params.layerSensitivity = v / 100;
      pending = 'all';
      persist();
    },
  });

  const ticksToggle = toggle(scope, {
    label: 'Onset ticks on the lanes',
    checked: prefs.ticks,
    onChange: (on) => {
      prefs.ticks = on;
      persist();
      o.changed();
    },
  });
  const inspectToggle = toggle(scope, {
    label: 'Inspect on hover',
    checked: prefs.inspect,
    onChange: (on) => {
      prefs.inspect = on;
      persist();
      if (!on) hideInspect();
    },
  });

  const trackRows = TRACKS.map((t) => {
    const tg = toggle(scope, {
      label: t.label,
      checked: prefs.tracks[t.id]?.on ?? true,
      onChange: (on) => {
        const p = prefs.tracks[t.id];
        if (p) p.on = on;
        persist();
        o.changed();
      },
    });
    return toggleRow(t.label, tg.root, t.description);
  });
  const resetWidths = button(scope, {
    label: 'Reset widths',
    variant: 'ghost',
    onClick: () => {
      for (const t of TRACKS) {
        const p = prefs.tracks[t.id];
        if (p) p.width = t.width;
      }
      persist();
      o.changed();
    },
  });
  const hiddenNote = el('p', { className: 'editor-help-text' });

  const exportButton = button(scope, {
    label: 'Export analysis JSON',
    variant: 'secondary',
    icon: 'export',
    block: true,
    onClick: () => {
      if (!analysis) return;
      const json = chartAnalysisToJson(analysis);
      const name = state.meta.title.replace(/[^\w\- ]+/g, '').trim() || 'song';
      downloadBlob(new Blob([json], { type: 'application/json' }), `${name} analysis.json`);
    },
  });
  tip(
    exportButton,
    'Download everything the analyzer computed (curves, onsets, lead notes, runs, bars, sections) as JSON.',
    [],
    'left',
  );

  const section = (id: string, title: string, body: Node[], open = true): HTMLElement => {
    const s = collapsible(scope, { id: `analysis-${id}`, title, open });
    s.body.append(...body);
    return s.root;
  };

  const closeButton = iconTool(scope, {
    icon: 'close',
    label: 'Hide this panel (the tracks stay; the Analysis button shows it again)',
    side: 'left',
    onClick: () => {
      panel.hidden = true;
      o.changed();
    },
  });
  const head = el('header', { className: 'editor-analysis-head' }, [
    el('h2', { className: 't-label', text: 'Analysis' }),
    closeButton,
  ]);
  const panel = el(
    'aside',
    {
      className: 'panel editor-solid editor-analysis-panel',
      attrs: { 'aria-label': 'Song analysis' },
    },
    [
      head,
      progressRow,
      el('div', { className: 'editor-analysis-body' }, [
        section('summary', 'Summary', [summary]),
        section('ssm', 'Similarity', [ssmCanvas]),
        section(
          'weights',
          'Activity weights',
          [
            el('p', {
              className: 'editor-help-text',
              text: 'What "musical activity" is made of. Changes apply live; loudness stays a minor part by default.',
            }),
            ...weightSliders.map(({ part, s }) =>
              sliderRow(
                ACTIVITY_LABELS[part],
                `Weight of ${ACTIVITY_LABELS[part].toLowerCase()} in the activity curve.`,
                s,
              ),
            ),
            resetWeights,
          ],
          false,
        ),
        section(
          'detect',
          'Onset detection',
          [
            sliderRow(
              'Lead sensitivity',
              'Higher finds quieter lead notes (lower local thresholds). Re-runs peak picking only.',
              leadSens,
            ),
            sliderRow(
              'Min. lead interval',
              'Shortest gap between two lead onsets. Fast leads need about 40 ms.',
              leadInterval,
            ),
            sliderRow(
              'Other layers',
              'Sensitivity of the kick, snare, hats, bass and other layers.',
              layerSens,
            ),
          ],
          false,
        ),
        section(
          'display',
          'Display',
          [
            toggleRow(
              'Onset ticks on lanes',
              ticksToggle.root,
              'Candidate onsets over the lanes: a tick per layer (kick left to other right), longer = stronger; lead runs shaded.',
            ),
            toggleRow(
              'Inspect on hover',
              inspectToggle.root,
              'Hovering the timeline shows every analysis value at that time.',
            ),
          ],
          false,
        ),
        section('tracks', 'Tracks', [...trackRows, hiddenNote, resetWidths], false),
        exportButton,
      ]),
    ],
  );
  panel.hidden = true;
  o.host.appendChild(panel);
  scope.onDispose(() => panel.remove());

  // Docked: top right, with the timeline laid out beside it. Dragging the header undocks it.
  let docked = true;
  let panelWidth = 0;
  const observer = new ResizeObserver(() => {
    const w = panel.offsetWidth;
    if (w !== panelWidth) {
      panelWidth = w;
      o.changed();
    }
  });
  observer.observe(panel);
  scope.onDispose(() => observer.disconnect());
  const dock = (): void => {
    docked = true;
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    o.changed();
  };

  // Drag the panel by its header.
  let drag: { dx: number; dy: number } | null = null;
  scope.listen(head, 'pointerdown', (e) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button'))) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  scope.listen(head, 'pointermove', (e) => {
    if (!drag) return;
    const hr = o.host.getBoundingClientRect();
    const x = Math.min(hr.width - 80, Math.max(0, e.clientX - hr.left - drag.dx));
    const y = Math.min(hr.height - 40, Math.max(0, e.clientY - hr.top - drag.dy));
    panel.style.left = `${Math.round(x)}px`;
    panel.style.top = `${Math.round(y)}px`;
    panel.style.right = 'auto';
    if (docked) {
      docked = false;
      o.changed();
    }
  });
  // Double-click the header to dock the panel again.
  scope.listen(head, 'dblclick', () => dock());
  const endDrag = (): void => {
    drag = null;
  };
  scope.listen(head, 'pointerup', endDrag);
  scope.listen(head, 'pointercancel', endDrag);

  // Similarity matrix: click a cell to jump to that bar.
  scope.listen(ssmCanvas, 'click', (e) => {
    if (!analysis || ssmBars === 0) return;
    const r = ssmCanvas.getBoundingClientRect();
    const j = Math.floor(((e.clientX - r.left) / r.width) * ssmBars);
    const bar = analysis.structure.bars[Math.min(ssmBars - 1, Math.max(0, j))];
    if (bar) o.seek(Math.max(0, bar.startMs));
  });

  const inspect = el('div', {
    className: 'panel editor-solid editor-inspect',
    attrs: { role: 'status', 'aria-live': 'off' },
  });
  inspect.hidden = true;
  o.host.appendChild(inspect);
  scope.onDispose(() => inspect.remove());
  function hideInspect(): void {
    inspect.hidden = true;
  }

  // --- Analysis lifecycle ------------------------------------------------------------------------

  let job: Promise<boolean> | null = null;
  const start = (): Promise<boolean> => {
    if (started && job) return job;
    started = true;
    failed = null;
    progressRow.hidden = false;
    statusText.textContent = 'Analysing the song...';
    progress.set(0);
    const legacyJob = o.legacy.run().then(
      (a) => legacyCurves(a),
      (err: unknown) => {
        console.warn('The older audio analysis failed; intensity and impacts are not shown.', err);
        return null;
      },
    );
    job = Promise.all([analyzer.run(), legacyJob]).then(
      ([f, l]) => {
        if (scope.disposed) return false;
        features = f;
        legacy = l;
        progressRow.hidden = true;
        pending = 'all';
        o.changed();
        return true;
      },
      (err: unknown) => {
        if (scope.disposed) return false;
        started = false;
        job = null;
        failed = err instanceof Error ? err.message : String(err);
        console.error('The song analysis failed:', err);
        statusText.textContent = `The analysis failed: ${failed} Turn Analysis off and on to try again.`;
        return false;
      },
    );
    return job;
  };

  const evaluate = (): void => {
    if (!features) return;
    const { bpm, offsetMs } = state.meta;
    if (pending === 'weights' && analysis) {
      analysis = reweightChartAnalysis(analysis, prefs.params.weights);
    } else {
      analysis = evaluateChartAnalysis(features, { bpm, offsetMs }, prefs.params, legacy);
    }
    pending = 'none';
    trackData = prepareTrackData(analysis);
    trackData.rejections = rejections;
    bands = buildBands(analysis);
    renderSummary(analysis);
    renderSsm(analysis);
    o.changed();
  };

  function buildBands(a: ChartAnalysis): OverviewBands {
    const t = theme.analysis;
    const repeats: OverviewBands['repeats'] = [];
    for (const b of a.structure.bars) {
      const color = b.group < 0 ? t.silentGroup : (t.groups[b.group % t.groups.length] as string);
      const last = repeats[repeats.length - 1];
      if (last && last.color === color && b.barInPhrase !== 0) last.endMs = b.endMs;
      else repeats.push({ startMs: b.startMs, endMs: b.endMs, color });
    }
    return {
      sections: a.structure.sections.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        color: t.roles[s.role] ?? t.silentGroup,
      })),
      repeats,
    };
  }

  function renderSummary(a: ChartAnalysis): void {
    const c = analysisCounts(a);
    const s = a.structure;
    const row = (k: string, v: string | Node[]): Node[] => [
      el('dt', { text: k }),
      typeof v === 'string' ? el('dd', { text: v }) : el('dd', {}, v),
    ];
    const layerList = LAYERS.map((l, i) =>
      el('span', { className: 'editor-analysis-layer' }, [
        swatch(theme.analysis.layers[i] as string),
        el('span', { text: `${LAYER_LABELS[l]} ${c.perLayer[l]}` }),
      ]),
    );
    const roles = s.sections.map((sec) =>
      el('span', { className: 'editor-analysis-layer' }, [
        swatch(theme.analysis.roles[sec.role] ?? theme.analysis.silentGroup),
        el('span', {
          text: `${formatTimestamp(sec.startMs).slice(0, 5)} ${SECTION_LABELS[sec.role]}`,
        }),
      ]),
    );
    const repeated = s.groupSizes
      .map((n, g) => (n >= 2 ? `${groupLetter(g)}x${n}` : null))
      .filter((v): v is string => v !== null);
    const midis = a.leadNotes.map((n) => n.midi);
    summary.replaceChildren(
      ...row('Timing', `${a.bpm} BPM, offset ${a.offsetMs} ms`),
      ...row('Candidates', `${c.candidates} (layers merged within 20 ms)`),
      ...row('Per layer', layerList),
      ...row(
        'Lead notes',
        midis.length > 0
          ? `${c.leadNotes}, ${midiName(Math.min(...midis))} to ${midiName(Math.max(...midis))}`
          : 'none found',
      ),
      ...row('Lead runs', String(c.leadRuns)),
      ...row('Sections', roles),
      ...row(
        'Repeats',
        `${s.phraseBars}-bar phrases, ${c.groups} groups${repeated.length > 0 ? ` (${repeated.join(' ')})` : ''}`,
      ),
    );
  }

  function swatch(color: string): HTMLElement {
    const node = el('span', {
      className: 'editor-analysis-swatch',
      attrs: { 'aria-hidden': 'true' },
    });
    node.style.background = color;
    return node;
  }

  function renderSsm(a: ChartAnalysis): void {
    const n = a.structure.bars.length;
    ssmBars = n;
    ssmCursorBar = -1;
    if (!ssmCtx || n === 0) return;
    // Large matrices are shown at most 360 cells across (each cell the maximum of its block).
    const cells = Math.min(n, 360);
    ssmBase.width = cells;
    ssmBase.height = cells;
    const bctx = ssmBase.getContext('2d');
    if (!bctx) return;
    const img = bctx.createImageData(cells, cells);
    const sim = a.structure.similarity;
    const lo = hexRgb(theme.analysis.trackBg[0]);
    const hi = hexRgb(theme.analysis.contour);
    const per = n / cells;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        let v = 0;
        const i0 = Math.floor(i * per);
        const i1 = Math.max(i0 + 1, Math.floor((i + 1) * per));
        const j0 = Math.floor(j * per);
        const j1 = Math.max(j0 + 1, Math.floor((j + 1) * per));
        for (let a2 = i0; a2 < i1; a2++)
          for (let b2 = j0; b2 < j1; b2++) v = Math.max(v, sim[a2 * n + b2] ?? 0);
        // Contrast: most pairs sit around the middle; stretch the upper half.
        const t = Math.max(0, Math.min(1, (v - 0.45) / 0.5)) ** 1.5;
        const p = (i * cells + j) * 4;
        img.data[p] = lo[0] + (hi[0] - lo[0]) * t;
        img.data[p + 1] = lo[1] + (hi[1] - lo[1]) * t;
        img.data[p + 2] = lo[2] + (hi[2] - lo[2]) * t;
        img.data[p + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
    ssmCanvas.width = cells;
    ssmCanvas.height = cells;
    drawSsmCursor(-1);
  }

  function drawSsmCursor(bar: number): void {
    if (!ssmCtx || ssmBars === 0) return;
    ssmCursorBar = bar;
    ssmCtx.drawImage(ssmBase, 0, 0);
    if (bar < 0) return;
    const cells = ssmBase.width;
    const c = Math.floor((bar / ssmBars) * cells);
    ssmCtx.fillStyle = theme.analysis.cursor;
    ssmCtx.fillRect(c, 0, 1, cells);
    ssmCtx.fillRect(0, c, cells, 1);
  }

  // --- Layout and pointer ----------------------------------------------------------------------

  const enabledTracks = (): { id: TrackId; w: number }[] =>
    TRACKS.filter((t) => prefs.tracks[t.id]?.on ?? true).map((t) => ({
      id: t.id,
      w: prefs.tracks[t.id]?.width ?? t.width,
    }));

  let lastColumns: TrackColumn[] = [];
  const columnsFor = (l: TimelineLayout): TrackColumn[] => {
    const out: TrackColumn[] = [];
    let x = l.tracksX;
    const end = l.tracksX + l.tracksWidth;
    let hidden = 0;
    for (const t of enabledTracks()) {
      if (x + t.w > end + 0.5) {
        hidden++;
        continue;
      }
      out.push({ id: t.id, x, w: t.w });
      x += t.w + TRACK_GAP_PX;
    }
    const note =
      hidden > 0
        ? `${hidden} track${hidden === 1 ? '' : 's'} do not fit: widen the window, collapse the side panel or narrow other tracks.`
        : '';
    if (hiddenNote.textContent !== note) hiddenNote.textContent = note;
    return out;
  };

  let pointer: { x: number; y: number } | null = null;
  let resize: { id: TrackId; startX: number; startW: number } | null = null;
  let hoverEdge = false;

  const edgeAt = (x: number, y: number): TrackColumn | null => {
    if (y > HEADER_PX) return null;
    for (const c of lastColumns) if (Math.abs(x - (c.x + c.w)) <= 4) return c;
    return null;
  };
  const columnAt = (x: number): TrackColumn | null =>
    lastColumns.find((c) => x >= c.x && x < c.x + c.w + TRACK_GAP_PX) ?? null;

  function showInspect(x: number, y: number): void {
    if (!prefs.inspect || !analysis || !layout || resize) {
      hideInspect();
      return;
    }
    const ms = o.timeAt(y);
    if (ms < 0 || ms > analysis.durationMs) {
      hideInspect();
      return;
    }
    const col = columnAt(x);
    inspect.replaceChildren(
      ...inspectRows(analysis, ms, state.meta.bpm, state.meta.offsetMs, col, rejections),
    );
    inspect.hidden = false;
    const hostW = o.host.clientWidth;
    const hostH = o.host.clientHeight;
    const w = inspect.offsetWidth;
    const h = inspect.offsetHeight;
    let left = x + 16;
    if (left + w > hostW - 4) left = x - w - 16;
    const top = Math.min(hostH - h - 4, Math.max(4, y + 12));
    inspect.style.transform = `translate(${Math.round(Math.max(4, left))}px, ${Math.round(top)}px)`;
  }

  const api: AnalysisView = {
    get on() {
      return prefs.on;
    },
    get resizeCursor() {
      return hoverEdge || resize !== null;
    },
    toggle(force) {
      // On with the panel hidden: the button brings the panel back first.
      if (force === undefined && prefs.on && panel.hidden) {
        panel.hidden = false;
        dock();
        return;
      }
      const on = force ?? !prefs.on;
      if (on === prefs.on && (on ? !panel.hidden : panel.hidden)) return;
      prefs.on = on;
      panel.hidden = !on;
      if (on) dock();
      if (!on) hideInspect();
      if (on) void start();
      persist();
      o.toggled(on);
      o.changed();
    },
    reservedRight() {
      // The panel's width plus its margin.
      return prefs.on && docked && !panel.hidden && panelWidth > 0 ? panelWidth + 12 : 0;
    },
    tracksWidth() {
      if (!prefs.on) return 0;
      const list = enabledTracks();
      if (list.length === 0) return 0;
      return list.reduce((s, t) => s + t.w, 0) + TRACK_GAP_PX * (list.length - 1);
    },
    columns(l) {
      layout = l;
      lastColumns = prefs.on && trackData ? columnsFor(l) : [];
      return lastColumns;
    },
    data() {
      return prefs.on ? trackData : null;
    },
    ticksOn() {
      return prefs.on && prefs.ticks && trackData !== null;
    },
    overviewBands() {
      return prefs.on ? bands : null;
    },
    frame(playheadMs) {
      if (pending !== 'none' && features && prefs.on) evaluate();
      if (prefs.on && analysis && !panel.hidden) {
        const bars = analysis.structure.bars;
        const first = bars[0];
        const bar = first
          ? Math.floor((playheadMs - first.startMs) / analysis.structure.barMs)
          : -1;
        const clamped = bar >= 0 && bar < bars.length ? bar : -1;
        if (clamped !== ssmCursorBar) drawSsmCursor(clamped);
      }
    },
    timingChanged() {
      if (features) pending = 'all';
    },
    pointerDown(x, y) {
      if (!prefs.on || lastColumns.length === 0) return false;
      const edge = edgeAt(x, y);
      if (edge) {
        resize = { id: edge.id, startX: x, startW: edge.w };
        hideInspect();
        return true;
      }
      if (columnAt(x)) {
        o.seek(o.timeAt(y));
        return true;
      }
      return false;
    },
    pointerMove(x, y) {
      pointer = { x, y };
      if (!prefs.on) return;
      if (resize) {
        const def = TRACK_BY_ID.get(resize.id);
        const p = prefs.tracks[resize.id];
        if (def && p) {
          p.width = Math.round(
            Math.min(def.maxWidth, Math.max(def.minWidth, resize.startW + x - resize.startX)),
          );
          persist();
          o.changed();
        }
        return;
      }
      hoverEdge = edgeAt(x, y) !== null;
      showInspect(x, y);
    },
    pointerUp() {
      resize = null;
    },
    pointerLeave() {
      pointer = null;
      hoverEdge = false;
      if (!resize) hideInspect();
    },
    refreshInspect() {
      if (pointer && prefs.on && !inspect.hidden) showInspect(pointer.x, pointer.y);
    },
    async chartAnalysis() {
      const ok = await start();
      if (!ok || scope.disposed || !features) return null;
      if (pending !== 'none' || !analysis) evaluate();
      return analysis;
    },
    onProgress(fn) {
      return analyzer.onProgress(fn);
    },
    setRejections(r) {
      rejections = r;
      if (trackData) trackData.rejections = r;
      o.changed();
    },
  };

  if (prefs.on) {
    panel.hidden = false;
    void start();
  }
  return api;
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1] as string, 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const pct = (v: number): string => v.toFixed(2);

/** The inspector's rows: every analysis value at song time `ms`. */
function inspectRows(
  a: ChartAnalysis,
  ms: number,
  bpm: number,
  offsetMs: number,
  column: TrackColumn | null,
  rejections: readonly Rejection[] | null,
): Node[] {
  const f = a.features;
  const k = Math.max(0, Math.min(f.frameCount - 1, Math.round(ms / f.frameMs)));
  const q = Math.max(0, Math.min(f.pitchFrames - 1, Math.round(ms / f.pitchHopMs)));
  const s = a.structure;
  const bars = s.bars;
  const first = bars[0];
  const barIndex = first ? Math.floor((ms - first.startMs) / s.barMs) : -1;
  const bar = barIndex >= 0 ? bars[barIndex] : undefined;
  const section = s.sections.find((x) => ms >= x.startMs && ms < x.endMs);
  const run = a.leadRuns.find((r) => ms >= r.startMs && ms <= r.endMs);
  const note = a.leadNotes.find((n) => ms >= n.tMs && ms <= n.tMs + n.durMs);
  const near = a.candidates.filter((c) => Math.abs(c.tMs - ms) <= 60).slice(0, 4);
  const lines: [string, string][] = [];
  lines.push(['Time', `${formatTimestamp(ms)} (${formatMeasureBeat(ms, bpm, offsetMs)})`]);
  if (column) {
    const def = TRACK_BY_ID.get(column.id);
    if (def) lines.push(['Track', def.label]);
  }
  lines.push(['Section', section ? SECTION_LABELS[section.role] : '-']);
  if (bar) {
    lines.push([
      'Repeat',
      bar.group < 0
        ? 'silence'
        : `${groupLetter(bar.group)}${bar.repeatIndex + 1}, bar ${bar.barInPhrase + 1} of ${s.phraseBars}`,
    ]);
  }
  lines.push(['Activity', pct(a.activity[k] ?? 0)]);
  lines.push([
    '  made of',
    ACTIVITY_PARTS.map(
      (p) =>
        `${ACTIVITY_LABELS[p].split(' ')[0]?.toLowerCase()} ${pct(a.activityParts[p][k] ?? 0)}`,
    ).join(', '),
  ]);
  if (a.legacy) {
    const lk = Math.max(
      0,
      Math.min(
        a.legacy.frameCount - 1,
        Math.round((ms - a.legacy.frameOffsetMs) / a.legacy.frameMs),
      ),
    );
    lines.push(['Intensity (old)', pct(a.legacy.intensity[lk] ?? 0)]);
  }
  lines.push(['Loudness', pct(f.loudness[k] ?? 0)]);
  lines.push([
    'Bands',
    BANDS.map((b) => `${BAND_LABELS[b].toLowerCase()} ${pct(f.bands[b][k] ?? 0)}`).join(', '),
  ]);
  lines.push(['Brightness', pct(f.brightness[k] ?? 0)]);
  lines.push(['Harmony change', pct(f.harmonicChange[k] ?? 0)]);
  const m = f.pitchMidi[q] ?? 0;
  lines.push([
    'Pitch track',
    m > 0
      ? `${midiName(m)} (${m.toFixed(2)}), confidence ${pct(f.pitchConfidence[q] ?? 0)}`
      : 'none',
  ]);
  lines.push([
    'Lead note',
    note
      ? `${midiName(note.midi)} at ${formatTimestamp(note.tMs)}, ${Math.round(note.durMs)} ms, strength ${pct(note.strength)}`
      : '-',
  ]);
  if (run) {
    lines.push([
      'Lead run',
      `${run.count} onsets, ${run.rateHz.toFixed(1)}/s (${run.perBeat.toFixed(2)} per beat)`,
    ]);
  }
  const envs = LAYERS.map((l) => {
    const i = Math.max(0, Math.min(f.onsetFrames - 1, Math.round(ms / f.onsetHopMs)));
    return `${l} ${pct(Math.min(9.99, (f.envelopes[l][i] ?? 0) / f.envelopeScale[l]))}`;
  });
  lines.push(['Envelopes', envs.join(', ')]);
  if (near.length === 0) lines.push(['Candidates', 'none within 60 ms']);
  for (const c of near) {
    const parts = LAYERS.filter((l) => c.layers[l] !== undefined).map(
      (l) => `${l} ${pct(c.layers[l] ?? 0)}`,
    );
    const dt = Math.round(c.tMs - ms);
    lines.push([
      `Onset ${dt >= 0 ? '+' : ''}${dt} ms`,
      `${parts.join(', ')}${c.pitch !== null ? `, ${midiName(c.pitch)}` : ''}`,
    ]);
  }
  if (rejections) {
    for (const r of rejections) {
      if (Math.abs(r.tMs - ms) > 60) continue;
      const dt = Math.round(r.tMs - ms);
      lines.push([
        `Skipped ${dt >= 0 ? '+' : ''}${dt} ms`,
        `${r.layer ?? 'onset'} ${pct(r.strength)}: ${r.reason}`,
      ]);
    }
  }
  return [
    el(
      'dl',
      { className: 'editor-inspect-list tabular' },
      lines.flatMap(([key, value]) => [el('dt', { text: key }), el('dd', { text: value })]),
    ),
  ];
}
