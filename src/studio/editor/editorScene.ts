import './editor.css';
import { formatMeasureBeat, formatTimestamp } from '../../core/beatGrid';
import type { Lane, Note } from '../../core/chart';
import {
  GLIDE_TAU_MS,
  SCROLL_TAU_MS,
  SmoothView,
  anchoredTimeMs,
  normalizeWheel,
  scrollStopped,
  wheelScrollMs,
  wheelZoomTarget,
} from '../../core/editorScroll';
import { validatedChart } from '../../core/noteEdit';
import type { PeakPyramid } from '../../core/peaks';
import { laneBindings, laneKeysLabel } from '../../core/settings';
import { SNAP_DIVISIONS, type SnapDivision } from '../../core/time';
import {
  DEFAULT_PX_PER_MS,
  overviewXToTime,
  visibleRange,
  yToTime,
  type TimelineView,
} from '../../core/timeline';
import { LaneInput } from '../../game/laneInput';
import { inputLatencyOffsetMs } from '../../game/settings';
import type { App } from '../../ui/app';
import { button, coverArt, icon, keyHint, slider, toaster } from '../../ui/components';
import { el } from '../../ui/dom';
import { createFilePicker } from '../../ui/files';
import { openModal, showErrors } from '../../ui/modal';
import type { Scene, SceneScope } from '../../ui/sceneManager';
import type { EditorParams } from '../../ui/scenes';
import type { StudioLibrary } from '../studioLibrary';
import { createAcceptBar } from './acceptBar';
import { drawLaneOverlay, drawTracks } from './analysisTracks';
import { createAnalysisView } from './analysisView';
import { createAssistPanel } from './assistPanel';
import { createComparePanel } from './comparePanel';
import { AudioAnalyzer } from '../../audio/audioAnalysis';
import { AutoSaver, type SaveStatus } from './autosave';
import { exportChartFile, exportSongPackage, importChartFile } from './chartIO';
import { sampleChartNotes } from './devSampleChart';
import { createEditorPanel } from './editorPanel';
import {
  CHART_FIELDS,
  EditorState,
  PLAYBACK_RATES,
  SONG_FIELDS,
  sanitizePrefs,
  type EditorChange,
  type EditorMeta,
  type EditorPrefs,
  type PlaybackRate,
} from './editorState';
import { TIER_COLORS, editorTheme } from './editorTheme';
import {
  MenuGroup,
  createMenu,
  iconTool,
  installTooltips,
  segmented,
  setPressed,
  tip,
} from './editorUi';
import { resolveKey, type KeyAction } from './keymap';
import { HitSounds, Metronome } from './metronome';
import { NativeCanvas } from './nativeCanvas';
import { drawNoteLayer, longestHoldMs } from './noteRenderer';
import { OverviewRenderer } from './overviewRenderer';
import { createHelpOverlay } from './shortcuts';
import { COMMON_SNAPS, MORE_SNAPS, snapLabel, snapSegments } from './snapControl';
import { PLAYHEAD_FRACTION, laneAt, timelineLayout } from './timelineLayout';
import { TimelineTools, type TimelineGeometry } from './timelineTools';
import { drawTimeline, peakScaleOf } from './timelineRenderer';
import { loadPeaks } from './waveform';

const PREFS_KEY = 'pixel-beat:editor-prefs';
/** The quick-start card was dismissed (a new key, so the "ataraxia." prefix). */
const QUICKSTART_KEY = 'ataraxia.editor-quickstart-dismissed';
/** Wheel idle time after which "Snap on scroll stop" eases onto the grid. */
const SCROLL_STOP_MS = 140;
const NO_NOTES: readonly Note[] = [];
const NO_REPLACED: ReadonlySet<Note> = new Set();
/** While recording, number keys 1-4 are lanes too (in addition to the gameplay keys). */
const DIGIT_LANES: Readonly<Record<string, Lane>> = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };

/** What the autosaver writes: changed metadata fields, and whether the notes or start changed. */
type SavePatch = Partial<EditorMeta> & { notes?: true; startMs?: true };

function loadPrefs(): Partial<EditorPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? sanitizePrefs(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function savePrefs(prefs: Readonly<EditorPrefs>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: preferences just aren't remembered.
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Not remembered: fine.
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'range', 'button'].includes(target.type);
  }
  return target.isContentEditable;
}

/** Dev only (`?editorChart=sample|empty`): replace the notes for screenshots. */
function devNotes(bpm: number, offsetMs: number, durationMs: number): Note[] | null {
  if (!import.meta.env.DEV) return null;
  const which = new URLSearchParams(window.location.search).get('editorChart');
  if (which === 'empty') return [];
  if (which === 'sample') return sampleChartNotes(bpm, offsetMs, durationMs);
  return null;
}

/**
 * Chart editor: a waveform timeline with the beat grid and the notes, a slim tool rail, a side
 * panel of collapsible sections, a transport bar and a wide minimap. All editing state lives in
 * EditorState; this scene wires it to the DOM, the canvases, audio and storage. The timeline
 * shows a smoothed view of the editor's playhead and zoom (SmoothView), so scrolling and zooming
 * are continuous.
 */
export class EditorScene implements Scene<EditorParams> {
  constructor(
    private readonly app: App,
    private readonly studioLibrary: StudioLibrary,
  ) {}

  enter(scope: SceneScope, params: EditorParams): void {
    const { app } = this;
    const root = el('div', { className: 'editor' });
    const loading = el('p', { className: 'editor-message', text: 'Loading chart and audio...' });
    root.appendChild(loading);
    app.ui.appendChild(root);
    scope.onDispose(() => root.remove());

    const goBack = (): void => {
      void app.scenes.goTo('studio', { songId: params.songId, chartId: params.chartId });
    };
    // Until the editor is built, Esc just goes back.
    let built = false;
    scope.listen(window, 'keydown', (e) => {
      if (built || e.key !== 'Escape') return;
      e.preventDefault();
      goBack();
    });

    Promise.all([
      app.library.loadChart(params.songId, params.chartId),
      app.library.loadAudio(params.songId),
    ]).then(
      ([{ song, chart }, buffer]) => {
        if (scope.disposed) return;
        built = true;
        loading.remove();
        // Back from a playtest: keep the in-memory state (unsaved edits, undo, view).
        const resumed = params.resume instanceof EditorState ? params.resume : null;
        const durationMs = buffer.duration * 1000;
        const state =
          resumed ??
          new EditorState({
            meta: {
              title: chart.title,
              artist: chart.artist,
              bpm: chart.bpm,
              offsetMs: chart.offsetMs,
              difficulty: chart.difficulty,
              level: chart.level,
              charter: chart.charter,
            },
            notes: devNotes(chart.bpm, chart.offsetMs, durationMs) ?? chart.notes,
            durationMs,
            prefs: loadPrefs(),
            audioFileName: chart.audio,
            previewStartMs: chart.previewStartMs,
            startMs: chart.startMs ?? null,
          });
        this.build(scope, root, params, state, buffer, song.builtIn, resumed !== null);
      },
      (err: unknown) => {
        if (scope.disposed) return;
        console.error('Opening the editor failed:', err);
        const reason = err instanceof Error ? err.message : String(err);
        loading.textContent = `This chart could not be opened. ${reason} Press Esc to go back.`;
      },
    );
  }

  private build(
    scope: SceneScope,
    root: HTMLElement,
    params: EditorParams,
    state: EditorState,
    buffer: AudioBuffer,
    readOnly: boolean,
    resumed: boolean,
  ): void {
    const { app } = this;
    const audio = app.audio;
    const theme = editorTheme();
    const ids = { songId: params.songId, chartId: params.chartId };
    const laneKeys = laneKeysLabel(app.settings.value.laneKeys);

    // --- Audio ---------------------------------------------------------------------------

    audio.setBuffer(buffer);
    audio.setMusicVolume(state.prefs.musicVolume);
    audio.setClickVolume(state.prefs.clickVolume);
    void audio.setPlaybackRate(state.prefs.playbackRate);
    const metronome = new Metronome(audio, () => state.meta);
    metronome.setEnabled(state.prefs.metronome);
    const hitSounds = new HitSounds(audio, () => state.notes);
    hitSounds.setEnabled(state.prefs.hitSounds);
    scope.onDispose(() => {
      metronome.dispose();
      hitSounds.dispose();
      audio.stop();
      audio.setBuffer(null);
      void audio.setPlaybackRate(1);
      audio.setMusicVolume(app.settings.value.musicVolume);
      audio.setClickVolume(1);
    });

    /** Song time playback last started from; the playhead never shows earlier while playing. */
    let playFromMs = 0;
    /** Bumped on every start/stop so a slow start can't resurrect stopped playback. */
    let playToken = 0;

    const startAt = async (fromMs: number): Promise<void> => {
      const token = ++playToken;
      playFromMs = fromMs;
      metronome.resync(null);
      hitSounds.resync(null);
      await audio.play(fromMs);
      if (token !== playToken || scope.disposed) return;
      metronome.resync(fromMs);
      hitSounds.resync(fromMs);
    };

    const play = (): void => {
      if (state.playing) return;
      // unlock() must run synchronously inside the input handler (autoplay policy).
      void audio.unlock();
      if (state.playheadMs >= state.durationMs - 1) state.seek(state.homeMs);
      // Start from where the view is going, not from somewhere mid-glide.
      smooth.jump(state.playheadMs, smooth.pxPerMs);
      state.setPlaying(true);
      startAt(state.playheadMs).catch((err: unknown) => {
        console.error('Playback failed:', err);
        stop();
      });
    };

    const stop = (): void => {
      if (!state.playing) return;
      playToken += 1;
      const t = Math.max(playFromMs, audio.getSongTimeMs());
      audio.stop();
      state.setPlaying(false);
      // A recording session ends with playback: everything recorded is one undo step.
      state.endRecordingSession();
      seekTau = 0;
      state.seek(Math.min(t, state.durationMs));
    };

    const togglePlay = (): void => (state.playing ? stop() : play());

    // --- Saving --------------------------------------------------------------------------

    const saveText = el('span', { className: 'editor-save-text' });
    const saveStatus = el('span', { className: 'editor-save', attrs: { role: 'status' } }, [
      el('span', { className: 'editor-save-dot', attrs: { 'aria-hidden': 'true' } }),
      saveText,
    ]);
    const showSave = (s: SaveStatus): void => {
      if (readOnly) {
        saveStatus.dataset['state'] = 'readonly';
        saveText.textContent = 'Read-only demo';
        tip(saveStatus, 'Edits to the built-in demo are not saved. Export the chart to keep them.');
        return;
      }
      saveStatus.dataset['state'] = s.kind;
      saveText.textContent =
        s.kind === 'saved'
          ? 'Saved'
          : s.kind === 'saving'
            ? 'Saving...'
            : s.kind === 'pending'
              ? 'Unsaved changes'
              : 'Not saved';
      tip(
        saveStatus,
        s.kind === 'error' ? `Not saved: ${s.message}` : 'Changes save automatically. Save now:',
        s.kind === 'error' ? [] : ['Ctrl+S'],
      );
    };
    /**
     * Writes the chart as it is now, normalised and validated as a whole. If validation fails
     * nothing is written, so the last good save stays in the library; the error is shown and
     * the changes stay pending.
     */
    const saver = new AutoSaver<SavePatch>(async (patch) => {
      const checked = validatedChart(state.toChart());
      if (!checked.ok) {
        const message = `the chart failed validation, so the last good save was kept. ${checked.errors[0] ?? ''}`;
        state.notify(`Not saved: ${message}`);
        throw new Error(message);
      }
      const chart = checked.chart;
      const songPatch: Partial<EditorMeta> = {};
      const chartPatch: Partial<EditorMeta> & { notes?: Note[]; startMs?: number | null } = {};
      for (const k of SONG_FIELDS)
        if (patch[k] !== undefined) Object.assign(songPatch, { [k]: chart[k] });
      for (const k of CHART_FIELDS)
        if (patch[k] !== undefined) Object.assign(chartPatch, { [k]: chart[k] });
      if (patch.notes) chartPatch.notes = chart.notes;
      // null = automatic start.
      if (patch.startMs) chartPatch.startMs = chart.startMs ?? null;
      if (Object.keys(songPatch).length > 0)
        await this.studioLibrary.updateSong(params.songId, songPatch);
      if (Object.keys(chartPatch).length > 0) {
        await this.studioLibrary.updateChart(params.chartId, chartPatch);
      }
    }, showSave);
    showSave(saver.status);
    // Leaving by any route (scene change, playtest, hot reload) still writes pending changes.
    scope.onDispose(() => void saver.flush());
    scope.listen(window, 'beforeunload', (e) => {
      if (!saver.hasUnsaved) return;
      void saver.flush();
      e.preventDefault();
      // Older browsers need returnValue set to show the "leave site?" prompt.
      e.returnValue = '';
    });
    // Back from a playtest: make sure everything edited before it is stored (a no-op if the
    // save on the way out already succeeded).
    if (resumed && !readOnly) saver.schedule({ ...state.meta, notes: true, startMs: true });

    const saveNow = (): void => {
      if (readOnly) {
        state.notify('The built-in demo is read-only. Use Export chart to keep your edits.');
        return;
      }
      void saver.flush().then((ok) => {
        if (ok) state.notify('Saved.');
      });
    };

    let leaving = false;
    const leave = async (): Promise<void> => {
      if (leaving) return;
      leaving = true;
      stop();
      if (readOnly && state.history.canUndo) {
        const choice = await openModal(scope, app.ui, {
          title: 'Edits will be lost',
          body: [
            'The built-in demo is read-only, so your edits are not saved.',
            'Export the chart first if you want to keep them.',
          ],
          buttons: [
            { label: 'Stay', value: 'stay' as const, primary: true },
            { label: 'Leave anyway', value: 'leave' as const, danger: true },
          ],
          cancelValue: 'stay' as const,
        });
        if (choice === 'stay') {
          leaving = false;
          return;
        }
      }
      if (saver.hasUnsaved && !(await saver.flush())) {
        const status = saver.status;
        const choice = await openModal(scope, app.ui, {
          title: 'Changes not saved',
          body: [
            `Your latest changes could not be saved${status.kind === 'error' ? `: ${status.message}` : '.'}`,
            'Stay to try again, or leave and lose those changes.',
          ],
          buttons: [
            { label: 'Stay', value: 'stay' as const, primary: true },
            { label: 'Leave anyway', value: 'leave' as const, danger: true },
          ],
          cancelValue: 'stay' as const,
        });
        if (choice === 'stay') {
          leaving = false;
          return;
        }
      }
      void app.scenes.goTo('studio', ids);
    };

    // --- View model ----------------------------------------------------------------------

    const timeline = new NativeCanvas('editor-timeline');
    const overview = new NativeCanvas('editor-overview');
    scope.onDispose(() => {
      timeline.dispose();
      overview.dispose();
    });
    const overviewRenderer = new OverviewRenderer();
    /** The displayed (smoothed) playhead time and zoom; the state holds the targets. */
    const smooth = new SmoothView(state.playheadMs, state.pxPerMs);
    /** Time constant for the current glide: wheel, keys or jumps (0) set it before seeking. */
    let seekTau = GLIDE_TAU_MS;
    /** Time of the last wheel scroll (for "Snap on scroll stop"). */
    let lastScrollAt: number | null = null;
    const glide = (tau: number, run: () => void): void => {
      seekTau = tau;
      run();
    };

    const tips = installTooltips(scope, root);
    const menus = new MenuGroup();
    const tooltipped = (
      b: HTMLButtonElement,
      text: string,
      keys: string[] = [],
      side?: 'above' | 'below' | 'right' | 'left',
    ): HTMLButtonElement => tip(b, text, keys, side);

    // --- Top bar -------------------------------------------------------------------------

    const backButton = iconTool(scope, {
      icon: 'back',
      label: 'Back to Studio home',
      keys: ['Esc'],
      onClick: () => void leave(),
    });
    const titleText = el('span', { className: 'editor-title t-label' });
    const subText = el('span', { className: 'editor-subtitle' });
    const renderHeading = (): void => {
      const m = state.meta;
      titleText.textContent = m.title;
      subText.textContent = `${m.difficulty} · level ${m.level}${m.charter ? ` · ${m.charter}` : ''}`;
    };
    renderHeading();

    // The song's cover next to the title (placeholder until the custom cover, if any, is known).
    const coverSlot = el('span', { className: 'editor-cover' }, [
      coverArt({ title: state.meta.title }, 'thumb'),
    ]);
    app.library.coverOf(params.songId).then(
      (cover) => {
        if (!scope.disposed && cover) {
          coverSlot.replaceChildren(coverArt({ title: state.meta.title, cover }, 'thumb'));
        }
      },
      (err: unknown) => console.warn('The cover could not be loaded:', err),
    );

    const undoButton = iconTool(scope, {
      icon: 'undo',
      label: 'Undo',
      keys: ['Ctrl+Z'],
      onClick: () => state.undo(),
    });
    const redoButton = iconTool(scope, {
      icon: 'redo',
      label: 'Redo',
      keys: ['Ctrl+Shift+Z', 'Ctrl+Y'],
      onClick: () => state.redo(),
    });
    const playtestButton = tooltipped(
      button(scope, {
        label: 'Playtest',
        variant: 'primary',
        icon: 'play',
        hint: 'P',
        onClick: () => startPlaytest(false),
      }),
      'Play the chart from the playhead, after the run-in time. Shift+P plays from the game start.',
      ['P', 'Shift+P'],
    );
    const picker = createFilePicker(scope, root, (files) => {
      const file = files[0];
      if (file) void importChartFile(scope, app, state, file);
    });
    const exportTrigger = tooltipped(
      el('button', { className: 'btn btn--ghost editor-menu-trigger', attrs: { type: 'button' } }, [
        icon('export'),
        el('span', { className: 'btn-label', text: 'Export' }),
        icon('chevron-down'),
      ]),
      'Export the chart or the song package, or replace the chart from a file',
    );
    const exportMenu = createMenu(scope, menus, {
      trigger: exportTrigger,
      label: 'Export',
      align: 'right',
      items: [
        {
          kind: 'action',
          label: 'Export chart (.json)',
          icon: 'export',
          run: () => void exportChartFile(scope, app, state),
        },
        {
          kind: 'action',
          label: 'Export package (.zip)',
          icon: 'package',
          disabled: () => readOnly,
          run: () =>
            void exportSongPackage(scope, app, this.studioLibrary, params.songId, state, () =>
              saver.flush(),
            ),
        },
        { kind: 'separator' },
        {
          kind: 'action',
          label: 'Replace from chart file...',
          icon: 'import',
          disabled: () => readOnly,
          run: () => picker.open('.json,application/json', 'chart'),
        },
        {
          kind: 'action',
          label: 'Save now',
          keys: ['Ctrl+S'],
          disabled: () => readOnly,
          run: saveNow,
        },
      ],
    });
    const helpButton = iconTool(scope, {
      icon: 'help',
      label: 'Keyboard shortcuts',
      keys: ['?'],
      onClick: () => help.toggle(),
    });

    const analysisButton = tooltipped(
      button(scope, {
        label: 'Analysis',
        variant: 'ghost',
        icon: 'pulse',
        hint: 'V',
        onClick: () => analysisView.toggle(),
      }),
      'Analysis view: data tracks beside the lanes, onset ticks, the hover inspector and the Analysis panel',
      ['V'],
    );

    const topBar = el('header', { className: 'editor-top' }, [
      backButton,
      coverSlot,
      el('div', { className: 'editor-heading' }, [titleText, subText]),
      saveStatus,
      el('span', { className: 'editor-spacer' }),
      el('div', { className: 'editor-group' }, [undoButton, redoButton]),
      analysisButton,
      playtestButton,
      exportMenu.root,
      helpButton,
    ]);

    // --- Tool rail -----------------------------------------------------------------------

    const railTool = (
      iconName: string,
      label: string,
      key: string,
      onClick: () => void,
    ): HTMLButtonElement => {
      const b = iconTool(scope, { icon: iconName, label, keys: [key], side: 'right', onClick });
      b.classList.add('editor-rail-tool');
      b.append(
        el('span', { className: 'editor-rail-key', text: key, attrs: { 'aria-hidden': 'true' } }),
      );
      return b;
    };
    const placeTool = railTool(
      'tool-note',
      'Place: click a lane for a tap, drag for a hold',
      'N',
      () => state.setTool('note'),
    );
    const selectTool = railTool(
      'tool-select',
      'Select: click, Shift+click or drag a box; drag notes to move them',
      'S',
      () => state.setTool('select'),
    );
    const recordTool = railTool(
      'record',
      `Record: while playing, the lane keys (${laneKeys}) place notes at the song time`,
      'R',
      () => state.setRecordArmed(!state.recordArmed),
    );
    const rail = el('nav', { className: 'editor-rail', attrs: { 'aria-label': 'Tools' } }, [
      placeTool,
      selectTool,
      el('span', { className: 'editor-rail-sep', attrs: { 'aria-hidden': 'true' } }),
      recordTool,
    ]);

    // --- Transport -----------------------------------------------------------------------

    const startButton = iconTool(scope, {
      icon: 'skip-start',
      label: 'Jump to the start: the game start, the first note or 0, whichever is earliest',
      keys: ['Home'],
      side: 'above',
      onClick: () => glide(GLIDE_TAU_MS, () => state.seek(state.homeMs)),
    });
    const endButton = iconTool(scope, {
      icon: 'skip-end',
      label: 'Jump to the end of the audio',
      keys: ['End'],
      side: 'above',
      onClick: () => glide(GLIDE_TAU_MS, () => state.seek(state.durationMs)),
    });
    const playIcon = icon('play');
    const pauseIcon = icon('pause');
    const playButton = tooltipped(
      el(
        'button',
        {
          className: 'btn btn--primary btn--icon editor-play',
          attrs: { type: 'button', 'aria-label': 'Play / pause' },
        },
        [playIcon, pauseIcon],
      ),
      'Play / pause',
      ['Space'],
      'above',
    );
    scope.listen(playButton, 'click', togglePlay);
    const timeOut = el('output', { className: 'editor-time t-label tabular' });
    const beatOut = el('output', { className: 'editor-beat tabular' });

    const speed = segmented<PlaybackRate>(scope, {
      label: 'Playback speed',
      options: PLAYBACK_RATES.map((r) => ({
        value: r,
        label: `${Math.round(r * 100)}%`,
        tip:
          r === 1
            ? 'Normal speed'
            : `Play at ${Math.round(r * 100)} % (slower audio also sounds lower)`,
      })),
      value: state.prefs.playbackRate,
      onChange: (r) => state.setPlaybackRate(r),
    });

    const snapKey = (d: SnapDivision): string => String(SNAP_DIVISIONS.indexOf(d) + 1);
    const snapControl = segmented<SnapDivision>(scope, {
      label: 'Snap',
      options: COMMON_SNAPS.map((d) => ({
        value: d,
        label: snapLabel(d),
        tip: `Snap to 1/${d} beat. [ and ] step through every division.`,
        keys: [snapKey(d), '[', ']'],
        color: TIER_COLORS[d] ?? theme.labelDim,
      })),
      value: state.snap,
      onChange: (d) => state.setSnap(d),
    });
    const moreSnapLabel = el('span', { className: 'chip-label' });
    const moreSnapTrigger = tooltipped(
      el(
        'button',
        { className: 'chip chip--steel editor-seg editor-seg-more', attrs: { type: 'button' } },
        [moreSnapLabel, icon('chevron-down')],
      ),
      'More snap divisions: 1/3, 1/6, 1/12, 1/2, 1/1',
      [],
      'above',
    );
    const moreSnapMenu = createMenu(scope, menus, {
      trigger: moreSnapTrigger,
      label: 'More snap divisions',
      up: true,
      items: MORE_SNAPS.map((d) => ({
        kind: 'action' as const,
        label: `${snapLabel(d)} beat`,
        keys: [snapKey(d)],
        run: () => state.setSnap(d),
      })),
    });
    const renderSnap = (): void => {
      const s = snapSegments(state.snap);
      snapControl.set(s.common);
      moreSnapLabel.textContent = s.moreLabel;
      moreSnapTrigger.setAttribute('aria-pressed', String(s.moreActive));
      const color = TIER_COLORS[state.snap];
      if (s.moreActive && color) moreSnapTrigger.style.setProperty('--mark', color);
      moreSnapTrigger.classList.toggle('has-mark', s.moreActive);
    };
    renderSnap();
    const snapStopButton = iconTool(scope, {
      icon: 'magnet',
      label:
        'Snap on scroll stop: ease the playhead onto the nearest snap line when scrolling ends',
      side: 'above',
      onClick: () => state.setOptions({ snapOnScrollStop: !state.prefs.snapOnScrollStop }),
    });

    const volume = (
      iconName: string,
      label: string,
      value: number,
      onInput: (v: number) => void,
    ): HTMLElement => {
      const s = slider(scope, {
        label,
        min: 0,
        max: 100,
        step: 1,
        value: Math.round(value * 100),
        format: (v) => `${Math.round(v)}`,
        onInput: (v) => onInput(v / 100),
      });
      const node = el('div', { className: 'editor-volume' }, [icon(iconName), s.root]);
      tip(node, label, [], 'above');
      return node;
    };
    const musicVolume = volume('music', 'Music volume', state.prefs.musicVolume, (v) =>
      state.setVolumes({ music: v }),
    );
    const clickVolume = volume(
      'metronome',
      'Click volume (metronome and hit sounds)',
      state.prefs.clickVolume,
      (v) => state.setVolumes({ click: v }),
    );

    const laneSize = segmented<number>(scope, {
      label: 'Lane size',
      options: [1, 2, 3, 4].map((n) => ({
        value: n,
        label: `${n}x`,
        tip: `Lanes ${n}x the skin's lane width (notes stay pixel-sharp)`,
      })),
      value: state.prefs.laneSize,
      onChange: (n) => state.setOptions({ laneSize: n }),
    });
    const moreTrigger = tooltipped(
      el(
        'button',
        {
          className: 'btn btn--ghost btn--icon',
          attrs: { type: 'button', 'aria-label': 'More options' },
        },
        [icon('more')],
      ),
      'More options: hit sounds, scrolling, lane size, zoom',
      [],
      'above',
    );
    const moreMenu = createMenu(scope, menus, {
      trigger: moreTrigger,
      label: 'More options',
      align: 'right',
      up: true,
      items: [
        {
          kind: 'toggle',
          label: 'Hit sounds',
          keys: ['Y'],
          get: () => state.prefs.hitSounds,
          set: (on) => state.setHitSounds(on),
        },
        {
          kind: 'toggle',
          label: 'Invert scroll',
          get: () => state.prefs.invertScroll,
          set: (on) => state.setOptions({ invertScroll: on }),
        },
        {
          kind: 'toggle',
          label: 'Snap on scroll stop',
          get: () => state.prefs.snapOnScrollStop,
          set: (on) => state.setOptions({ snapOnScrollStop: on }),
        },
        { kind: 'separator' },
        { kind: 'heading', label: 'Lane size' },
        { kind: 'custom', node: el('div', { className: 'editor-menu-custom' }, [laneSize.root]) },
        { kind: 'separator' },
        {
          kind: 'action',
          label: 'Reset zoom',
          run: () => state.zoomBy(DEFAULT_PX_PER_MS / state.pxPerMs),
        },
      ],
    });

    const transport = el('footer', { className: 'editor-transport' }, [
      el('div', { className: 'editor-group' }, [startButton, playButton, endButton]),
      el('div', { className: 'editor-readouts' }, [timeOut, beatOut]),
      el('span', { className: 'editor-divider', attrs: { 'aria-hidden': 'true' } }),
      el('div', { className: 'editor-labelled' }, [
        el('span', { className: 'editor-caption', text: 'Speed' }),
        speed.root,
      ]),
      el('div', { className: 'editor-labelled' }, [
        el('span', { className: 'editor-caption', text: 'Snap' }),
        snapControl.root,
        moreSnapMenu.root,
        snapStopButton,
      ]),
      el('span', { className: 'editor-spacer' }),
      musicVolume,
      clickVolume,
      moreMenu.root,
    ]);

    // --- Center and side -----------------------------------------------------------------

    const analyzer = new AudioAnalyzer(buffer, app.library.analysisCache(params.songId));
    scope.onDispose(() => analyzer.dispose());
    /** Something on the canvases changed: redraw on the next frame. */
    let dirty = true;
    /** Set once the quick-start card exists (it hides while suggested notes are shown). */
    let refreshQuickStart = (): void => undefined;
    /** Set once the accept bar exists: shows or hides it for the pending suggestion. */
    let refreshAcceptBar = (): void => undefined;
    // The generator reads the ChartAnalysis the analysis viewer owns (created below).
    const chartProgress = new Set<(fraction: number) => void>();
    const assist = createAssistPanel(
      scope,
      state,
      analyzer,
      {
        chartAnalysis: () => analysisView.chartAnalysis(),
        onProgress: (fn) => {
          chartProgress.add(fn);
          return () => chartProgress.delete(fn);
        },
        setRejections: (r) => analysisView.setRejections(r),
      },
      () => {
        dirty = true;
        refreshQuickStart();
      },
      () => {
        dirty = true;
        refreshAcceptBar();
      },
    );
    // Compare chart (Phase 19): another chart of this song as read-only markers.
    const compare = createComparePanel(
      scope,
      state,
      {
        listCharts: async () => {
          const { charts } = await app.library.catalog();
          return charts
            .filter((c) => c.songId === params.songId && c.id !== params.chartId)
            .map((c) => ({
              id: c.id,
              label: `${c.difficulty} (level ${c.level})${c.charter ? ` by ${c.charter}` : ''}, ${c.noteCount} notes`,
            }));
        },
        loadChart: async (id) => (await app.library.loadChart(params.songId, id)).chart,
        pending: () => assist.suggestion(),
      },
      () => {
        dirty = true;
      },
    );
    const panel = createEditorPanel(scope, state, {
      tapTimeMs: (ts) => (state.playing ? audio.eventTimeToSongMs(ts) : ts),
      assist: { ...assist, suggest: [...assist.suggest, ...compare.parts] },
    });

    const waveStatus = el('p', {
      className: 'editor-wave-status',
      text: 'Reading the waveform...',
    });

    // First-use help: shown while the chart has no notes, until dismissed.
    let quickStartDismissed = readFlag(QUICKSTART_KEY);
    const step = (n: string, text: string, keys: string[]): HTMLElement =>
      el('li', { className: 'editor-qs-step' }, [
        el('span', { className: 'editor-qs-num t-label', text: n }),
        el('span', { className: 'editor-qs-text', text }),
        keyHint(keys),
      ]);
    const quickStart = el(
      'div',
      { className: 'panel editor-solid editor-quickstart', attrs: { role: 'note' } },
      [
        el('header', { className: 'editor-qs-head' }, [
          el('h2', { className: 't-label', text: 'Quick start' }),
          iconTool(scope, {
            icon: 'close',
            label: 'Dismiss the quick start',
            onClick: () => {
              quickStartDismissed = true;
              writeFlag(QUICKSTART_KEY);
              renderQuickStart();
            },
          }),
        ]),
        el('ol', { className: 'editor-qs-steps' }, [
          step(
            '1',
            'Tune the BPM and offset under Timing until the metronome clicks on the beat.',
            ['M', 'T'],
          ),
          step('2', 'Place notes: click a lane for a tap, drag along it for a hold.', ['N']),
          step('3', 'Playtest from the playhead, then refine.', ['P']),
        ]),
      ],
    );
    const renderQuickStart = (): void => {
      quickStart.hidden =
        quickStartDismissed || state.notes.length > 0 || assist.suggestion() !== null;
    };
    refreshQuickStart = renderQuickStart;
    renderQuickStart();

    const view = el('div', { className: 'editor-view' }, [
      timeline.element,
      waveStatus,
      quickStart,
    ]);
    // Accept / Discard / New seed for generated notes, floating over the lanes.
    const acceptBar = createAcceptBar(scope, {
      accept: () => assist.accept(),
      discard: () => assist.discard(),
      regenerate: () => assist.regenerate(),
    });
    view.appendChild(acceptBar.element);
    refreshAcceptBar = (): void => acceptBar.render(assist.suggestion()?.summary ?? null);
    refreshAcceptBar();
    const toasts = toaster(scope, view);
    // Everything the chart analysis sees (Phase 17): tracks, panel and inspector.
    const analysisView = createAnalysisView(scope, {
      host: view,
      state,
      buffer,
      legacy: analyzer,
      studioLibrary: this.studioLibrary,
      songId: params.songId,
      theme,
      timeAt: (y) => yToTime(y, smooth.timeMs, viewOf()),
      seek: (ms) => glide(GLIDE_TAU_MS, () => state.seek(ms)),
      changed: () => {
        dirty = true;
      },
      toggled: (on) => setPressed(analysisButton, on),
    });
    setPressed(analysisButton, analysisView.on);
    scope.onDispose(
      analysisView.onProgress((f) => {
        for (const fn of chartProgress) fn(f);
      }),
    );
    // Hovering a suggested (ghost) note shows why the generator placed it.
    const decisionTip = el('div', {
      className: 'panel editor-solid editor-inspect',
      attrs: { role: 'status', 'aria-live': 'off' },
    });
    decisionTip.hidden = true;
    view.appendChild(decisionTip);
    const showDecision = (x: number, y: number): void => {
      const lane = laneAt(x, layoutOf());
      const rows =
        lane === null
          ? null
          : assist.describeAt(yToTime(y, smooth.timeMs, viewOf()), lane, 6 / smooth.pxPerMs);
      if (!rows) {
        decisionTip.hidden = true;
        return;
      }
      decisionTip.replaceChildren(
        el(
          'dl',
          { className: 'editor-inspect-list tabular' },
          rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]),
        ),
      );
      decisionTip.hidden = false;
      const left = Math.min(view.clientWidth - decisionTip.offsetWidth - 4, x + 16);
      const top = Math.min(view.clientHeight - decisionTip.offsetHeight - 4, Math.max(4, y + 12));
      decisionTip.style.transform = `translate(${Math.round(Math.max(4, left))}px, ${Math.round(top)}px)`;
    };
    const minimap = el('div', { className: 'editor-minimap' }, [overview.element]);
    tip(
      overview.element,
      'Overview: click or drag to jump. The strip shows notes per second.',
      [],
      'above',
    );
    root.append(topBar, rail, view, panel.element, transport, minimap);
    const help = createHelpOverlay(scope, root, laneKeys);

    // Buttons and sliders give focus back after use, so Space/arrows keep driving the editor
    // instead of pressing a button again or changing a slider.
    scope.listen(root, 'click', (e) => {
      const t = e.target as HTMLElement | null;
      const b = t?.closest('button');
      if (b instanceof HTMLButtonElement && !b.closest('.editor-menu')) b.blur();
    });
    scope.listen(root, 'pointerup', (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && (t.type === 'range' || t.type === 'checkbox')) t.blur();
    });

    const refreshButtons = (): void => {
      setPressed(placeTool, state.tool === 'note');
      setPressed(selectTool, state.tool === 'select');
      setPressed(recordTool, state.recordArmed, 'danger');
      setPressed(snapStopButton, state.prefs.snapOnScrollStop);
      const h = state.history;
      undoButton.disabled = !h.canUndo;
      redoButton.disabled = !h.canRedo;
      tip(undoButton, h.undoLabel ? `Undo: ${h.undoLabel}` : 'Nothing to undo', ['Ctrl+Z']);
      tip(redoButton, h.redoLabel ? `Redo: ${h.redoLabel}` : 'Nothing to redo', [
        'Ctrl+Shift+Z',
        'Ctrl+Y',
      ]);
      timeline.element.classList.toggle('is-select', state.tool === 'select');
      moreMenu.refresh();
    };
    refreshButtons();

    // --- Waveform ------------------------------------------------------------------------

    let peaks: PeakPyramid | null = null;
    let peakScale = 1;
    loadPeaks(buffer).then(
      (p) => {
        if (scope.disposed) return;
        peaks = p;
        peakScale = peakScaleOf(p);
        waveStatus.remove();
        dirty = true;
      },
      (err: unknown) => {
        console.error('Computing the waveform failed:', err);
        waveStatus.textContent = 'The waveform could not be drawn. Timing tools still work.';
      },
    );

    // --- Timeline geometry and tools -----------------------------------------------------

    /** The view as displayed (smoothed zoom). */
    const viewOf = (): TimelineView => ({
      pxPerMs: smooth.pxPerMs,
      playheadY: Math.round(timeline.heightPx * PLAYHEAD_FRACTION),
      heightPx: timeline.heightPx,
    });
    const layoutOf = (): ReturnType<typeof timelineLayout> =>
      timelineLayout(
        timeline.widthPx - analysisView.reservedRight(),
        state.prefs.laneSize,
        timeline.dpr,
        analysisView.tracksWidth(),
      );
    const geometry = (): TimelineGeometry => ({
      layout: layoutOf(),
      view: viewOf(),
      playheadMs: smooth.timeMs,
    });
    const tools = new TimelineTools(state, geometry, (ms) =>
      glide(GLIDE_TAU_MS, () => state.seekSnapped(ms)),
    );

    // --- Playtest ------------------------------------------------------------------------

    /**
     * Run the real game scene on the in-memory chart. From the playhead: play runs in for the
     * player's "Run-in time" setting first and only notes from the playhead on are judged. From
     * the start: play begins at the effective game start, every note judged. The game comes back
     * here with this same state (playhead, zoom, selection, undo history).
     */
    function startPlaytest(fromStart: boolean): void {
      const checked = validatedChart(state.toChart());
      if (!checked.ok) {
        void showErrors(scope, app.ui, 'The chart cannot be playtested yet', checked.errors);
        return;
      }
      // Still inside the key/click handler: lets the game start its audio right away.
      void audio.unlock();
      stop();
      state.setRecordArmed(false);
      tools.cancel();
      const base = {
        ...ids,
        mode: 'playtest' as const,
        chart: checked.chart,
        returnTo: { scene: 'editor' as const, params: { ...ids, resume: state } },
      };
      if (fromStart) {
        void app.scenes.goTo('game', base);
        return;
      }
      void app.scenes.goTo('game', { ...base, startTimeMs: Math.round(state.playheadMs) });
    }

    // --- State -> audio, saving, controls -------------------------------------------------

    let savedMeta: EditorMeta = { ...state.meta };
    let prefsTimer: ReturnType<typeof setTimeout> | null = null;
    scope.onDispose(() => {
      if (prefsTimer !== null) clearTimeout(prefsTimer);
      savePrefs(state.prefs);
    });
    const schedulePrefsSave = (): void => {
      if (prefsTimer !== null) clearTimeout(prefsTimer);
      prefsTimer = setTimeout(() => {
        prefsTimer = null;
        savePrefs(state.prefs);
      }, 300);
    };

    const onChange = (change: EditorChange): void => {
      dirty = true;
      panel.update(change);
      assist.update(change);
      compare.update(change);
      switch (change) {
        case 'meta': {
          const now = state.meta;
          const patch: SavePatch = {};
          for (const k of [...SONG_FIELDS, ...CHART_FIELDS]) {
            if (now[k] !== savedMeta[k]) Object.assign(patch, { [k]: now[k] });
          }
          savedMeta = { ...now };
          analysisView.timingChanged();
          if (!readOnly && Object.keys(patch).length > 0) saver.schedule(patch);
          renderHeading();
          break;
        }
        case 'notes':
          if (!readOnly) saver.schedule({ notes: true });
          renderQuickStart();
          break;
        case 'start':
          if (!readOnly) saver.schedule({ startMs: true });
          break;
        case 'seek':
          if (state.playing) {
            startAt(state.playheadMs).catch((err: unknown) => console.error('Seek failed:', err));
          }
          break;
        case 'rate': {
          const rate = state.prefs.playbackRate;
          speed.set(rate);
          schedulePrefsSave();
          if (state.playing) {
            const t = Math.max(playFromMs, audio.getSongTimeMs());
            audio.stop();
            void audio.setPlaybackRate(rate).then(() => {
              if (state.playing && !scope.disposed) return startAt(t);
            });
          } else {
            void audio.setPlaybackRate(rate);
          }
          break;
        }
        case 'metronome':
          metronome.setEnabled(state.prefs.metronome);
          schedulePrefsSave();
          break;
        case 'hitSounds':
          hitSounds.setEnabled(state.prefs.hitSounds);
          if (state.playing) hitSounds.resync(Math.max(playFromMs, audio.getSongTimeMs()));
          schedulePrefsSave();
          refreshButtons();
          break;
        case 'mix':
          audio.setMusicVolume(state.prefs.musicVolume);
          audio.setClickVolume(state.prefs.clickVolume);
          schedulePrefsSave();
          break;
        case 'snap':
          renderSnap();
          schedulePrefsSave();
          break;
        case 'view':
        case 'options':
          laneSize.set(state.prefs.laneSize);
          schedulePrefsSave();
          refreshButtons();
          break;
        case 'tool':
        case 'record':
        case 'history':
          refreshButtons();
          break;
        case 'message':
          toasts.show(state.message, state.message.startsWith('Not saved') ? 'danger' : 'accent');
          break;
        default:
          break;
      }
    };
    scope.onDispose(state.subscribe(onChange));

    // --- Live recording ------------------------------------------------------------------

    /** Lane keys while recording: the gameplay bindings plus 1-4 (none while typing). */
    const recordKeys = (): Record<string, Lane> =>
      state.recordArmed && !isTextEntry(document.activeElement) && !help.open
        ? { ...laneBindings(app.settings.value.laneKeys), ...DIGIT_LANES }
        : {};
    const recordTimeMs = (timeStamp: number): number =>
      audio.eventTimeToSongMs(timeStamp) - inputLatencyOffsetMs(app.settings.value);
    const recorder = new LaneInput(scope, recordKeys, {
      press: (lane, timeStamp) => {
        if (!state.playing || audio.state !== 'playing') {
          state.notify(`Recording needs playback: press Space, then play along with ${laneKeys}.`);
          return;
        }
        state.recordPress(lane, recordTimeMs(timeStamp));
      },
      release: (lane, timeStamp) => {
        if (state.playing && audio.state === 'playing') {
          state.recordRelease(lane, recordTimeMs(timeStamp));
        }
      },
    });
    scope.listen(window, 'blur', () => {
      recorder.releaseAll(performance.now());
      if (tools.cancel()) dirty = true;
    });

    // --- Keyboard ------------------------------------------------------------------------

    const onEscape = (): void => {
      if (menus.closeAll()) return;
      if (tools.cancel()) {
        dirty = true;
        return;
      }
      if (assist.suggestion()) {
        assist.discard();
        return;
      }
      if (state.selection.size > 0) {
        state.clearSelection();
        return;
      }
      void leave();
    };

    const deleteKey = (): void => {
      const hovered = state.tool === 'note' ? tools.hoveredNote() : null;
      if (hovered) state.deleteNote(hovered);
      else if (state.selection.size > 0) state.deleteSelection();
    };

    /** Alt+arrows move the selection; without one they say how to get one. */
    const needSelection = (): boolean => {
      if (state.selection.size > 0) return true;
      state.notify('Select notes first (S for the select tool).');
      return false;
    };

    const run = (a: KeyAction, e: KeyboardEvent): void => {
      switch (a.command) {
        case 'undo':
          state.undo();
          break;
        case 'redo':
          state.redo();
          break;
        case 'selectAll':
          state.selectAll();
          break;
        case 'copy':
          state.copySelection();
          break;
        case 'cut':
          state.cutSelection();
          break;
        case 'paste':
          state.paste();
          break;
        case 'save':
          saveNow();
          break;
        case 'nudgeLater':
          if (needSelection()) state.nudgeSelection(1);
          break;
        case 'nudgeEarlier':
          if (needSelection()) state.nudgeSelection(-1);
          break;
        case 'laneLeft':
          if (needSelection()) state.moveSelection(0, -1);
          break;
        case 'laneRight':
          if (needSelection()) state.moveSelection(0, 1);
          break;
        case 'togglePlay':
          togglePlay();
          break;
        case 'stepLater':
          glide(GLIDE_TAU_MS, () => state.stepSnap(1));
          break;
        case 'stepEarlier':
          glide(GLIDE_TAU_MS, () => state.stepSnap(-1));
          break;
        case 'measureLater':
          glide(GLIDE_TAU_MS, () => state.stepMeasure(1));
          break;
        case 'measureEarlier':
          glide(GLIDE_TAU_MS, () => state.stepMeasure(-1));
          break;
        case 'home':
          glide(GLIDE_TAU_MS, () => state.seek(state.homeMs));
          break;
        case 'end':
          glide(GLIDE_TAU_MS, () => state.seek(state.durationMs));
          break;
        case 'snapCoarser':
          state.cycleSnap(-1);
          break;
        case 'snapFiner':
          state.cycleSnap(1);
          break;
        case 'setSnap':
          if (a.snap !== undefined) state.setSnap(a.snap);
          break;
        case 'tapTempo':
          panel.tap(e.timeStamp);
          break;
        case 'toggleMetronome':
          state.setMetronome(!state.prefs.metronome);
          break;
        case 'toolNote':
          state.setTool('note');
          break;
        case 'toolSelect':
          state.setTool('select');
          break;
        case 'toggleRecord':
          state.setRecordArmed(!state.recordArmed);
          break;
        case 'toggleHitSounds':
          state.setHitSounds(!state.prefs.hitSounds);
          break;
        case 'mirror':
          state.mirrorSelection();
          break;
        case 'playtestHere':
          startPlaytest(false);
          break;
        case 'playtestStart':
          startPlaytest(true);
          break;
        case 'rangeA':
        case 'rangeB': {
          const which = a.command === 'rangeA' ? 'a' : 'b';
          state.setRangeMark(which);
          state.notify(`${which.toUpperCase()} set at ${formatTimestamp(state.playheadMs)}.`);
          break;
        }
        case 'help':
          menus.closeAll();
          help.toggle(true);
          break;
        case 'delete':
          deleteKey();
          break;
        case 'escape':
          onEscape();
          break;
        case 'acceptSuggestion':
          assist.accept();
          break;
        case 'toggleAnalysis':
          analysisView.toggle();
          break;
        case 'toggleCompare':
          compare.toggleShown();
          break;
        case 'regenerateSuggestion':
          if (assist.suggestion()) assist.regenerate();
          else state.notify('Generate notes in the Suggest panel first; G then tries a new seed.');
          break;
      }
    };

    scope.listen(window, 'keydown', (e) => {
      if (isTextEntry(e.target)) {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        }
        return;
      }
      if (help.open) {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault();
          help.toggle(false);
        }
        return;
      }
      // Lane keys while recording belong to the recorder.
      if (recordKeys()[e.code] !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      const action = resolveKey(e);
      if (!action) return;
      // Enter accepts a suggestion only: otherwise it keeps its normal meaning (a focused
      // button, link or menu item).
      if (
        action.command === 'acceptSuggestion' &&
        (!assist.suggestion() ||
          (e.target instanceof Element &&
            e.target.closest('button, a, summary, [role="menuitem"]')))
      ) {
        return;
      }
      e.preventDefault();
      if (e.repeat && !action.repeats) return;
      tips.hide();
      run(action, e);
    });

    // --- Pointer ---------------------------------------------------------------------------

    /** Ctrl+wheel: zoom around the pointer (paused) or the playhead (playing). */
    const zoomWheel = (px: number, pointerY: number): void => {
      const target = wheelZoomTarget(state.pxPerMs, px);
      if (target === state.pxPerMs) return;
      const factor = target / state.pxPerMs;
      if (state.playing) {
        state.zoomBy(factor);
        return;
      }
      const v = viewOf();
      const offsetPx = v.playheadY - pointerY;
      const anchorMs = yToTime(pointerY, smooth.timeMs, v);
      state.zoomBy(factor);
      smooth.anchorZoom(anchorMs, offsetPx);
      seekTau = SCROLL_TAU_MS;
      state.seek(anchoredTimeMs(anchorMs, offsetPx, state.pxPerMs));
    };

    scope.listen(
      timeline.element,
      'wheel',
      (e) => {
        e.preventDefault();
        const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        const px = normalizeWheel(raw, e.deltaMode, timeline.heightPx);
        if (px === 0) return;
        if (e.ctrlKey || e.metaKey) {
          zoomWheel(px, timeline.pointerPos(e).y);
          return;
        }
        // Pause to scroll: while playing the playhead follows the audio.
        if (state.playing) return;
        const deltaMs = wheelScrollMs(px, state.pxPerMs, {
          fine: e.shiftKey,
          invert: state.prefs.invertScroll,
        });
        seekTau = SCROLL_TAU_MS;
        state.seek(state.playheadMs + deltaMs);
        lastScrollAt = e.timeStamp;
      },
      { passive: false },
    );

    // Lanes: the active tool. Waveform margin: seek (select tool: box select).
    scope.listen(timeline.element, 'pointerdown', (e) => {
      menus.closeAll();
      const { x, y } = timeline.pointerPos(e);
      // Analysis tracks: resize from a header edge, or click to seek (the start marker first).
      if (e.button === 0 && !tools.overStartMarker() && analysisView.pointerDown(x, y)) {
        timeline.element.setPointerCapture(e.pointerId);
        e.preventDefault();
        dirty = true;
        return;
      }
      if (tools.down(x, y, e.button, e.shiftKey)) {
        timeline.element.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
      dirty = true;
    });
    scope.listen(timeline.element, 'pointermove', (e) => {
      const { x, y } = timeline.pointerPos(e);
      tools.move(x, y);
      analysisView.pointerMove(x, y);
      showDecision(x, y);
      timeline.element.classList.toggle('is-start-grab', tools.overStartMarker());
      timeline.element.classList.toggle('is-col-resize', analysisView.resizeCursor);
      dirty = true;
    });
    const endPointer = (e: PointerEvent): void => {
      const { x, y } = timeline.pointerPos(e);
      analysisView.pointerUp();
      tools.up(x, y);
      dirty = true;
    };
    scope.listen(timeline.element, 'pointerup', endPointer);
    scope.listen(timeline.element, 'pointercancel', () => {
      tools.cancel();
      dirty = true;
    });
    scope.listen(timeline.element, 'pointerleave', () => {
      analysisView.pointerLeave();
      decisionTip.hidden = true;
      tools.leave();
      dirty = true;
    });
    scope.listen(timeline.element, 'contextmenu', (e) => {
      e.preventDefault();
      const { x, y } = timeline.pointerPos(e);
      tools.contextMenu(x, y);
    });

    // Minimap: click or drag to seek (instantly). Playback pauses while dragging and resumes.
    let scrubbing = false;
    let resumeAfterScrub = false;
    const scrubTo = (e: PointerEvent): void => {
      const { x } = overview.pointerPos(e);
      seekTau = 0;
      state.seek(Math.round(overviewXToTime(x, state.span, overview.widthPx)));
    };
    scope.listen(overview.element, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      scrubbing = true;
      resumeAfterScrub = state.playing;
      stop();
      overview.element.setPointerCapture(e.pointerId);
      scrubTo(e);
    });
    scope.listen(overview.element, 'pointermove', (e) => {
      if (scrubbing) scrubTo(e);
    });
    const endScrub = (): void => {
      if (!scrubbing) return;
      scrubbing = false;
      if (resumeAfterScrub) play();
    };
    scope.listen(overview.element, 'pointerup', endScrub);
    scope.listen(overview.element, 'pointercancel', endScrub);

    // --- Frame loop ----------------------------------------------------------------------

    let lastReadout = '';
    let longestFor: readonly Note[] | null = null;
    let longest = 0;
    let lastFrameMs: number | null = null;
    scope.everyFrame((nowMs) => {
      const dtMs = lastFrameMs === null ? 0 : nowMs - lastFrameMs;
      lastFrameMs = nowMs;
      if (state.playing && audio.state === 'playing') {
        const t = audio.getSongTimeMs();
        if (t >= state.durationMs) {
          stop();
          state.seek(state.durationMs);
        } else {
          state.followAudio(Math.max(playFromMs, t));
        }
      }
      if (
        state.prefs.snapOnScrollStop &&
        !state.playing &&
        scrollStopped(nowMs, lastScrollAt, SCROLL_STOP_MS)
      ) {
        lastScrollAt = null;
        seekTau = SCROLL_TAU_MS;
        state.seekSnapped(state.playheadMs);
      }
      // While playing the view follows the audio exactly; zoom still animates.
      const moving = smooth.step(
        dtMs,
        state.playheadMs,
        state.pxPerMs,
        state.playing ? 0 : seekTau,
      );
      if (moving) {
        dirty = true;
        analysisView.refreshInspect();
      } else seekTau = GLIDE_TAU_MS;
      analysisView.frame(state.playheadMs);
      if (timeline.sync()) dirty = true;
      if (overview.sync()) dirty = true;
      if (!dirty) return;
      dirty = false;

      const { bpm, offsetMs } = state.meta;
      const v = viewOf();
      const shownMs = smooth.timeMs;
      const startPreview = tools.startPreviewMs();
      const layout = layoutOf();
      const suggestion = assist.suggestion();
      if (longestFor !== state.notes) {
        longestFor = state.notes;
        longest = longestHoldMs(state.notes);
      }
      drawTimeline(
        timeline.ctx,
        {
          widthPx: timeline.widthPx,
          heightPx: timeline.heightPx,
          dpr: timeline.dpr,
          layout,
          view: v,
          playheadMs: shownMs,
          bpm,
          offsetMs,
          snap: state.snap,
          durationMs: state.durationMs,
          peaks,
          peakScale,
          rangeMarks: state.rangeMarksSet,
          start: {
            ms: startPreview ?? state.effectiveStartMs,
            auto: startPreview === null && state.startIsAuto,
            dragging: startPreview !== null,
          },
          overlay: assist.overlay(),
        },
        theme,
        () => {
          const tracks = analysisView.data();
          if (tracks && analysisView.ticksOn()) {
            drawLaneOverlay(
              timeline.ctx,
              {
                dpr: timeline.dpr,
                heightPx: timeline.heightPx,
                view: v,
                playheadMs: shownMs,
                lanesX: layout.lanesX,
                lanesWidth: layout.lanesWidth,
              },
              tracks,
              theme,
            );
          }
          drawNoteLayer(
            timeline.ctx,
            {
              dpr: timeline.dpr,
              widthPx: timeline.widthPx,
              heightPx: timeline.heightPx,
              layout,
              view: v,
              playheadMs: shownMs,
              notes: state.notes,
              longestHoldMs: longest,
              selection: state.selection,
              playing: state.playing,
              recording: state.recordArmed,
              ...tools.overlay(),
              suggestions: suggestion?.notes ?? NO_NOTES,
              replaced: suggestion?.replaced ?? NO_REPLACED,
              compare: compare.layer(),
            },
            app.skin,
            theme,
          );
        },
      );
      const trackData = analysisView.data();
      const columns = analysisView.columns(layout);
      if (trackData && columns.length > 0) {
        drawTracks(
          timeline.ctx,
          {
            dpr: timeline.dpr,
            heightPx: timeline.heightPx,
            view: v,
            playheadMs: shownMs,
            durationMs: state.durationMs,
            bpm,
            offsetMs,
            columns,
            peaks,
            peakScale,
            font: theme.font,
          },
          trackData,
          theme,
        );
      }
      acceptBar.centreOn(layout.lanesX + layout.lanesWidth / 2);
      const range = visibleRange(shownMs, v);
      overviewRenderer.draw(
        overview.ctx,
        {
          widthPx: overview.widthPx,
          heightPx: overview.heightPx,
          dpr: overview.dpr,
          durationMs: state.durationMs,
          span: state.span,
          startMs: startPreview ?? state.effectiveStartMs,
          peaks,
          peakScale,
          viewStartMs: range.startMs,
          viewEndMs: range.endMs,
          playheadMs: shownMs,
          notes: state.notes,
          overlay: assist.overlay(),
          suggestionRange: suggestion?.rangeMs ?? null,
          bands: analysisView.overviewBands(),
          npsCurve: assist.npsCurve(),
        },
        theme,
      );
      const visible = {
        startMs: Math.max(state.span.startMs, range.startMs),
        endMs: Math.min(state.durationMs, range.endMs),
      };
      panel.updateVisible(visible);
      compare.updateVisible(visible);

      // DOM readouts only when their text changes.
      const readout = `${formatTimestamp(state.playheadMs)}|${formatMeasureBeat(state.playheadMs, bpm, offsetMs)}|${state.playing}`;
      if (readout !== lastReadout) {
        lastReadout = readout;
        timeOut.textContent = formatTimestamp(state.playheadMs);
        const [measure, beat] = formatMeasureBeat(state.playheadMs, bpm, offsetMs).split(':');
        beatOut.textContent = `measure ${measure ?? ''} · beat ${beat ?? ''}`;
        playIcon.hidden = state.playing;
        pauseIcon.hidden = !state.playing;
      }
    });
  }
}
