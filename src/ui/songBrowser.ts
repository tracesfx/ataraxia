import { PreviewPlayer } from '../audio/previewPlayer';
import { previewWindow } from '../core/playRange';
import type { ScoreRecord } from '../library/records';
import { LibraryError } from '../library/repository';
import type { Catalog, CatalogChart, CatalogSong } from '../library/songLibrary';
import { levelTier } from '../render/levelTier';
import type { App } from './app';
import { useBackdrop } from './backdrop';
import {
  button,
  chip,
  coverArt,
  hintBar,
  icon,
  iconButton,
  textField,
  toaster,
  type ButtonVariant,
  type ToastTone,
} from './components';
import { el } from './dom';
import { createFilePicker } from './files';
import { showErrors } from './modal';
import type { SceneScope } from './sceneManager';
import type { SongSelectParams } from './scenes';
import { filterIndices } from './songSearch';
import { TIER_TONES } from './theme';

/** Length of the looping song preview. */
const PREVIEW_LENGTH_MS = 10_000;
/** Wait this long after the selection settles before decoding/playing a preview. */
const PREVIEW_DELAY_MS = 250;

/** User-facing messages for any error a library operation threw. */
export function errorsOf(err: unknown): string[] {
  if (err instanceof LibraryError) return err.errors;
  console.error(err);
  const reason = err instanceof Error ? err.message : String(err);
  return [`Something unexpected went wrong: ${reason}`];
}

export function formatLength(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBpm(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(2).replace(/0+$/, '');
}

/** Score as seven digits ("0987654"), shown with equal-width digits. */
export function formatScore(score: number): string {
  return String(Math.round(score)).padStart(7, '0');
}

/** Does a key event match a combo like "Ctrl+O", "Delete" or "E"? */
export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const ctrl = parts.includes('Ctrl');
  if (ctrl !== (e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (key.length === 1) return e.key.toLowerCase() === key.toLowerCase();
  return e.key === key || e.code === key;
}

/** A button for a library action, with its keyboard shortcut. */
export interface BrowserAction {
  /** Shortcut combo: "Ctrl+O", "Delete", "E". Shown as key caps on the button. */
  key: string;
  label: string;
  icon?: string;
  variant?: ButtonVariant;
  /** In the screen header, or in the detail panel (default). */
  placement?: 'header' | 'panel';
  run: () => void;
  /** Disabled when this returns false; the shortcut still runs and explains why. */
  enabled: () => boolean;
}

export interface SongBrowserOptions {
  className: string;
  title: string;
  /** `list`: song rows with covers (player). `table`: columns of metadata (Studio home). */
  layout: 'list' | 'table';
  /** Type-to-search: printable keys go to the search field. */
  search: boolean;
  hints: readonly (readonly [string | string[], string])[];
  /** Text of the overlay shown while files are dragged over the screen. */
  dropText: { title: string; detail: string };
  /** Shown under the list while the player has no songs of their own. */
  empty: { title: string; text: string; action: BrowserAction };
  /** Text for a song without charts. */
  noChartsText: (song: CatalogSong) => string;
  /** Extra panel content between the chart list and the actions (e.g. practice). */
  panelExtras?: Node[];
  /**
   * Controls shown under the selected song's heading (Studio: cover upload, crop, remove). Called
   * whenever the selected song or its cover changes; `coverSlot` is the cover's container (e.g.
   * to accept dropped pictures).
   */
  coverTools?: (song: CatalogSong, coverSlot: HTMLElement) => Node[];
  /**
   * An extra titled section in the detail panel after the charts (Studio: the song's
   * background). Rendered again when the selected song, its cover or its background changes.
   */
  detailSection?: { title: string; render: (song: CatalogSong) => Node[] };
  /** Enter, or a double click on a song row. */
  activate: () => void;
  /** Files dropped anywhere on the screen. */
  drop: (files: File[]) => void;
  /** Files chosen with `picker.open`, with the purpose given there. */
  pick: (files: File[], purpose: string) => void;
  /** Keys beyond navigation and the action shortcuts. Return true when handled. */
  key?: (e: KeyboardEvent) => boolean;
  back: () => void;
}

export interface SongBrowser {
  readonly root: HTMLElement;
  readonly picker: { open(accept: string, purpose: string, multiple?: boolean): void };
  readonly busy: boolean;
  /** True once the first catalog load finished. */
  readonly loaded: boolean;
  selectedSong(): CatalogSong | null;
  selectedChart(): CatalogChart | null;
  chartsOf(songId: string): CatalogChart[];
  /** The song next to the selected one (to select after deleting it), or null. */
  neighbourSong(): CatalogSong | null;
  /** Forget the remembered chart choice for a song (after deleting that chart). */
  forgetChart(songId: string): void;
  /** A short message as a toast. */
  setStatus(text: string, tone?: ToastTone): void;
  /** Install the action buttons (once, after the actions can refer to the browser). */
  setActions(actions: BrowserAction[]): void;
  /** Run one library operation at a time; failures are shown in a dialog. */
  perform(failTitle: string, work: () => Promise<void>): Promise<void>;
  /** Reload the catalog and select a song/chart (by id), keeping the selection otherwise. */
  refresh(select?: SongSelectParams): Promise<void>;
  /** Re-render the selection (after outside state such as practice changed). */
  render(): void;
}

/**
 * The library browser shared by the player's song select and Studio home: the songs on the left
 * (rows with covers, or a table), details and charts of the selected song in a glass panel on
 * the right, a looping audio preview, the selected cover as a blurred ambient backdrop, keyboard
 * navigation, type-to-search and file drag and drop. Each screen supplies its own actions, so
 * the player's screen contains no editing actions at all.
 */
export function createSongBrowser(
  scope: SceneScope,
  app: App,
  options: SongBrowserOptions,
): SongBrowser {
  const library = app.library;
  const preview = new PreviewPlayer(app.audio);
  scope.onDispose(() => preview.stop());
  const backdrop = useBackdrop(scope, app, { kind: 'gradient' });

  let catalog: Catalog = { songs: [], charts: [] };
  let bests = new Map<string, ScoreRecord>();
  let songIndex = 0;
  let query = '';
  /** Catalog indices of the songs shown (after the search filter). */
  let visible: number[] = [];
  /** Remembered chart per song, so Left/Right choices survive moving between songs. */
  const chartChoice = new Map<string, string>();
  let busy = false;
  let loaded = false;
  let actions: BrowserAction[] = [];
  let actionButtons: HTMLButtonElement[] = [];

  const selectedSong = (): CatalogSong | null =>
    visible.includes(songIndex) ? (catalog.songs[songIndex] ?? null) : null;
  const chartsOf = (songId: string): CatalogChart[] =>
    catalog.charts.filter((c) => c.songId === songId);
  const selectedChart = (): CatalogChart | null => {
    const song = selectedSong();
    if (!song) return null;
    const charts = chartsOf(song.id);
    return charts.find((c) => c.id === chartChoice.get(song.id)) ?? charts[0] ?? null;
  };

  const toasts = toaster(scope, app.ui);
  const setStatus = (text: string, tone: ToastTone = 'accent'): void => toasts.show(text, tone);
  const picker = createFilePicker(scope, app.ui, options.pick);

  // --- Elements --------------------------------------------------------------------------

  const search = options.search
    ? textField(scope, {
        label: 'Search songs',
        placeholder: 'Type to search',
        icon: 'search',
        onInput: (v) => {
          query = v;
          applyFilter();
        },
      })
    : null;
  const headerActions = el('div', { className: 'browser-header-actions' });

  const songList = el('div', {
    className: `song-list song-list--${options.layout}`,
    attrs: { role: 'listbox', 'aria-label': 'Songs' },
  });
  const tableHead =
    options.layout === 'table'
      ? el('div', { className: 'song-table-head t-label', attrs: { 'aria-hidden': 'true' } }, [
          el('span'),
          el('span', { text: 'Song' }),
          el('span', { className: 'num', text: 'BPM' }),
          el('span', { className: 'num', text: 'Length' }),
          el('span', { text: 'Charts' }),
        ])
      : null;
  const listNote = el('div', { className: 'list-note' });
  const listColumn = el('section', { className: 'song-list-column' }, [
    ...(tableHead ? [tableHead] : []),
    songList,
    listNote,
  ]);

  const coverSlot = el('div', { className: 'detail-cover' });
  const songTitle = el('h2', { className: 'detail-title t-title' });
  const songArtist = el('p', { className: 'detail-artist' });
  const lengthValue = el('span', { className: 'tabular' });
  const bpmValue = el('span', { className: 'tabular' });
  const stats = el('div', { className: 'detail-stats t-label' }, [
    el('span', { className: 'stat', attrs: { title: 'Length' } }, [icon('clock'), lengthValue]),
    el('span', { className: 'stat', attrs: { title: 'Tempo' } }, [
      icon('pulse'),
      bpmValue,
      el('span', { className: 'stat-unit', text: 'bpm' }),
    ]),
  ]);
  const chartList = el('div', {
    className: 'chart-list',
    attrs: { role: 'radiogroup', 'aria-label': 'Charts' },
  });
  const panelActions = el('div', { className: 'detail-actions' });
  const coverTools = el('div', { className: 'detail-cover-tools' });
  const extraSection = el('div', { className: 'detail-extra' });
  coverTools.hidden = !options.coverTools;
  const detail = el('aside', { className: 'panel song-detail', attrs: { 'aria-label': 'Song' } }, [
    el('div', { className: 'detail-head' }, [
      coverSlot,
      el('div', { className: 'detail-heading' }, [songTitle, songArtist, stats]),
    ]),
    coverTools,
    el('h3', { className: 'detail-section t-label', text: 'Charts' }),
    chartList,
    ...(options.detailSection
      ? [
          el('h3', { className: 'detail-section t-label', text: options.detailSection.title }),
          extraSection,
        ]
      : []),
    ...(options.panelExtras ?? []),
    panelActions,
  ]);

  const dropOverlay = el('div', { className: 'drop-overlay', attrs: { 'aria-hidden': 'true' } }, [
    el('div', { className: 'panel drop-overlay-card' }, [
      icon('package'),
      el('p', { className: 't-title', text: options.dropText.title }),
      el('p', { className: 'drop-overlay-sub', text: options.dropText.detail }),
    ]),
  ]);
  dropOverlay.hidden = true;

  const perform = async (failTitle: string, work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    root.classList.add('is-busy');
    try {
      await work();
    } catch (err) {
      if (!scope.disposed) await showErrors(scope, app.ui, failTitle, errorsOf(err));
    } finally {
      busy = false;
      root.classList.remove('is-busy');
    }
  };

  // --- Rendering -------------------------------------------------------------------------

  let songRows: HTMLButtonElement[] = [];

  const levelChip = (level: number, label?: string): HTMLElement =>
    chip({
      lead: String(level),
      label: label ?? '',
      tone: TIER_TONES[levelTier(level)] ?? 'steel',
      className: label ? '' : 'chip--lead-only',
    });

  const songRow = (song: CatalogSong, i: number): HTMLButtonElement => {
    const charts = chartsOf(song.id);
    const sub = song.artist || song.audioFileName;
    let cells: Node[];
    if (options.layout === 'table') {
      cells = [
        coverArt(song, 'thumb'),
        el('span', { className: 'row-text' }, [
          el('span', { className: 'row-title t-label', text: song.title }),
          el('span', { className: 'row-sub', text: sub }),
        ]),
        el('span', { className: 'num t-label tabular', text: formatBpm(song.bpm) }),
        el('span', { className: 'num t-label tabular', text: formatLength(song.durationMs) }),
        el(
          'span',
          { className: 'row-chips' },
          charts.length === 0
            ? [el('span', { className: 'row-sub', text: song.builtIn ? 'demo' : 'no charts' })]
            : charts.slice(0, 4).map((c) => levelChip(c.level)),
        ),
      ];
    } else {
      const top = charts.reduce((max, c) => Math.max(max, c.level), 0);
      cells = [
        coverArt(song, 'thumb'),
        el('span', { className: 'row-text' }, [
          el('span', { className: 'row-title t-label', text: song.title }),
          el('span', { className: 'row-sub', text: sub }),
        ]),
        el('span', { className: 'row-chips' }, [
          ...(song.builtIn ? [chip({ label: 'demo' })] : []),
          ...(top > 0 ? [levelChip(top)] : []),
        ]),
      ];
    }
    const row = el(
      'button',
      {
        className: `row ring song-row song-row--${options.layout}`,
        attrs: { type: 'button', role: 'option', tabindex: '-1' },
      },
      cells,
    );
    scope.listen(row, 'click', () => selectSong(i));
    scope.listen(row, 'dblclick', () => options.activate());
    return row;
  };

  const renderList = (): void => {
    songRows = catalog.songs.map(songRow);
    songList.replaceChildren(...songRows);
    applyFilter(false);
  };

  /** Show only the rows matching the search; keep a visible selection. */
  const applyFilter = (render = true): void => {
    visible = filterIndices(
      catalog.songs.map((s) => ({
        title: s.title,
        artist: s.artist,
        extra: chartsOf(s.id).map((c) => c.difficulty),
      })),
      query,
    );
    songRows.forEach((row, i) => {
      row.hidden = !visible.includes(i);
    });
    if (visible.length > 0 && !visible.includes(songIndex)) songIndex = visible[0] as number;
    renderNote();
    if (render) {
      renderSelection();
      updatePreview();
    }
  };

  const renderNote = (): void => {
    const own = catalog.songs.filter((s) => !s.builtIn).length;
    if (!loaded) {
      listNote.replaceChildren(el('p', { className: 'list-note-text', text: 'Loading songs…' }));
    } else if (library.storageError) {
      listNote.replaceChildren(
        el('div', { className: 'card empty-card is-danger' }, [
          icon('alert'),
          el('p', { text: library.storageError }),
        ]),
      );
    } else if (visible.length === 0 && query) {
      const clear = button(scope, {
        label: 'Clear search',
        variant: 'ghost',
        icon: 'close',
        onClick: () => clearSearch(),
      });
      listNote.replaceChildren(
        el('div', { className: 'card empty-card' }, [
          icon('search'),
          el('div', {}, [
            el('p', { className: 't-label', text: `No songs match “${query.trim()}”` }),
            el('p', { className: 'empty-text', text: 'Try fewer or different words.' }),
          ]),
          clear,
        ]),
      );
    } else if (own === 0 && !query) {
      const a = options.empty.action;
      listNote.replaceChildren(
        el('div', { className: 'card empty-card' }, [
          icon('music', 'empty-icon'),
          el('div', { className: 'empty-copy' }, [
            el('p', { className: 't-label', text: options.empty.title }),
            el('p', { className: 'empty-text', text: options.empty.text }),
          ]),
          button(scope, {
            label: a.label,
            icon: a.icon ?? 'package',
            variant: 'secondary',
            hint: a.key,
            onClick: () => {
              if (!busy) a.run();
            },
          }),
        ]),
      );
    } else {
      listNote.replaceChildren();
    }
  };

  const bestLine = (best: ScoreRecord | undefined): HTMLElement => {
    if (!best) return el('span', { className: 'chart-best is-empty', text: 'Not played' });
    const marks = best.allPerfect ? 'All perfect' : best.fullCombo ? 'Full combo' : '';
    return el(
      'span',
      {
        className: 'chart-best',
        attrs: { title: `Best ${best.score} (${best.accuracy.toFixed(2)}%)` },
      },
      [
        el('span', { className: `rank-letter rank-${best.rank} t-label`, text: best.rank }),
        el('span', { className: 'tabular t-label', text: formatScore(best.score) }),
        ...(marks ? [el('span', { className: 'chart-mark', text: marks })] : []),
      ],
    );
  };

  let detailFor = '';
  const renderSelection = (): void => {
    const song = selectedSong();
    songRows.forEach((row, i) => {
      const selected = i === songIndex && visible.includes(i);
      row.classList.toggle('is-selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
      row.tabIndex = selected ? 0 : -1;
    });
    const row = songRows[songIndex];
    if (row && song) {
      // Keep DOM focus on the selected row (unless typing a search or a dialog is open).
      const active = document.activeElement;
      const typing = active instanceof HTMLInputElement || active instanceof HTMLSelectElement;
      const inPanel = active instanceof HTMLElement && detail.contains(active);
      if (!typing && !inPanel && !document.querySelector('dialog[open]')) {
        row.focus({ preventScroll: true });
      }
      row.scrollIntoView({ block: 'nearest' });
    }
    detail.hidden = !song;
    if (song) {
      const detailKey = JSON.stringify([
        song.id,
        song.title,
        song.cover?.key ?? '',
        song.background,
        song.backgroundImageCount,
      ]);
      if (detailFor !== detailKey) {
        detailFor = detailKey;
        coverSlot.replaceChildren(coverArt(song, 'large'));
        backdrop.show({ kind: 'cover', title: song.title, cover: song.cover });
        if (options.coverTools) coverTools.replaceChildren(...options.coverTools(song, coverSlot));
        if (options.detailSection)
          extraSection.replaceChildren(...options.detailSection.render(song));
      }
      songTitle.textContent = song.title;
      songArtist.textContent = song.artist || 'Unknown artist';
      lengthValue.textContent = formatLength(song.durationMs);
      bpmValue.textContent = formatBpm(song.bpm);

      const charts = chartsOf(song.id);
      const current = selectedChart();
      chartList.replaceChildren(
        ...(charts.length === 0
          ? [el('p', { className: 'chart-empty', text: options.noChartsText(song) })]
          : charts.map((chart) => {
              const on = chart.id === current?.id;
              const card = el(
                'button',
                {
                  className: `card is-interactive ring chart-card${on ? ' is-selected' : ''}`,
                  attrs: { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false' },
                },
                [
                  levelChip(chart.level),
                  el('span', { className: 'chart-name' }, [
                    el('span', { className: 't-label', text: chart.difficulty }),
                    el('span', { className: 'chart-notes', text: `${chart.noteCount} notes` }),
                  ]),
                  bestLine(bests.get(chart.id)),
                ],
              );
              scope.listen(card, 'click', () => {
                chartChoice.set(song.id, chart.id);
                renderSelection();
              });
              scope.listen(card, 'dblclick', () => options.activate());
              return card;
            })),
      );
    }
    actions.forEach((action, i) => {
      const b = actionButtons[i];
      if (b) b.disabled = !action.enabled();
    });
  };

  // --- Preview ---------------------------------------------------------------------------

  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewGeneration = 0;
  /** Song id + preview start of the preview playing (or about to). */
  let previewKey: string | null = null;
  scope.onDispose(() => {
    previewGeneration += 1;
    clearTimeout(previewTimer);
  });

  /** Stop the current preview and start the selected song's after a short settle delay. */
  const updatePreview = (): void => {
    const song = selectedSong();
    const key = song ? `${song.id}@${song.previewStartMs}` : null;
    if (key === previewKey) return;
    previewKey = key;
    const gen = ++previewGeneration;
    clearTimeout(previewTimer);
    preview.stop();
    if (!song) return;
    previewTimer = setTimeout(() => {
      library.loadAudio(song.id).then(
        (buffer) => {
          if (gen !== previewGeneration || scope.disposed) return;
          const w = previewWindow(song.previewStartMs, buffer.duration * 1000, PREVIEW_LENGTH_MS);
          preview.play(buffer, w.startMs, w.lengthMs);
        },
        (err: unknown) => {
          if (gen !== previewGeneration || scope.disposed) return;
          setStatus(`No preview: ${errorsOf(err).join(' ')}`, 'danger');
        },
      );
    }, PREVIEW_DELAY_MS);
  };

  // --- Selection -------------------------------------------------------------------------

  const selectSong = (i: number): void => {
    if (!visible.includes(i)) return;
    songIndex = i;
    renderSelection();
    updatePreview();
  };

  /** Move the selection within the visible songs (wraps around). */
  const stepSong = (step: number): void => {
    if (visible.length === 0) return;
    const at = visible.indexOf(songIndex);
    const next = at < 0 ? 0 : (at + step + visible.length) % visible.length;
    selectSong(visible[next] as number);
  };

  const stepChart = (step: number): void => {
    const song = selectedSong();
    if (!song) return;
    const charts = chartsOf(song.id);
    if (charts.length === 0) return;
    const i = charts.findIndex((c) => c.id === selectedChart()?.id);
    const next = charts[(i + step + charts.length) % charts.length] as CatalogChart;
    chartChoice.set(song.id, next.id);
    renderSelection();
  };

  const clearSearch = (): void => {
    if (!search) return;
    search.input.value = '';
    query = '';
    applyFilter();
  };

  const refresh = async (select: SongSelectParams = {}): Promise<void> => {
    const keepId = select.songId ?? catalog.songs[songIndex]?.id;
    const [next, scores] = await Promise.all([
      library.catalog(),
      library.bestScores().catch((err: unknown) => {
        console.warn('Best scores could not be loaded:', err);
        return new Map<string, ScoreRecord>();
      }),
    ]);
    if (scope.disposed) return;
    catalog = next;
    bests = scores;
    const found = catalog.songs.findIndex((s) => s.id === keepId);
    songIndex = found >= 0 ? found : Math.min(songIndex, Math.max(0, catalog.songs.length - 1));
    if (select.songId && select.chartId) chartChoice.set(select.songId, select.chartId);
    // A requested song stays visible: clear a search that would hide it.
    if (select.songId && search && query) {
      search.input.value = '';
      query = '';
    }
    loaded = true;
    detailFor = '';
    renderList();
    renderSelection();
    updatePreview();
  };

  // --- Layout and input ------------------------------------------------------------------

  const back = iconButton(scope, {
    icon: 'back',
    label: 'Back (Esc)',
    onClick: () => options.back(),
  });
  const root = el('div', { className: `screen browser ${options.className}` }, [
    el('header', { className: 'screen-header' }, [
      back,
      el('h1', { className: 'screen-title t-title', text: options.title }),
      el('div', { className: 'screen-header-end' }, [
        ...(search ? [search.root] : []),
        headerActions,
      ]),
    ]),
    el('main', { className: 'screen-body browser-body' }, [listColumn, detail]),
    hintBar(options.hints),
    dropOverlay,
  ]);
  app.ui.appendChild(root);
  scope.onDispose(() => root.remove());
  renderNote();

  const isTextTarget = (t: EventTarget | null): boolean =>
    t instanceof HTMLInputElement ||
    t instanceof HTMLSelectElement ||
    t instanceof HTMLTextAreaElement;

  scope.listen(window, 'keydown', (e) => {
    // Any key counts as a user gesture: let the preview be heard.
    void app.audio.unlock();
    if (document.querySelector('dialog[open]')) return;
    const target = e.target;
    const inSearch = search !== null && target === search.input;
    const inText = isTextTarget(target);
    if (busy && e.key !== 'Escape') return;

    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (search && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        search.input.focus();
        search.input.select();
        return;
      }
      const action = e.repeat ? undefined : actions.find((a) => matchesCombo(e, a.key));
      if (action) {
        e.preventDefault();
        action.run();
      } else if (options.key?.(e)) {
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        if (inText && !inSearch) return;
        stepSong(e.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'PageUp':
      case 'PageDown':
        if (inText && !inSearch) return;
        stepSong(e.key === 'PageDown' ? 8 : -8);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (inText) return;
        stepChart(e.key === 'ArrowRight' ? 1 : -1);
        break;
      case 'Enter': {
        // Buttons other than song rows (actions, charts) handle Enter themselves.
        const onButton = target instanceof HTMLButtonElement && !songRows.includes(target);
        if (onButton || (inText && !inSearch)) return;
        if (!e.repeat) options.activate();
        break;
      }
      case 'Escape':
        if (inSearch || query) {
          if (query) clearSearch();
          songRows[songIndex]?.focus();
        } else {
          options.back();
        }
        break;
      default: {
        if (inText) return;
        const action = e.repeat ? undefined : actions.find((a) => matchesCombo(e, a.key));
        if (action) {
          action.run();
          break;
        }
        if (options.key?.(e)) break;
        // Type-to-search: the key lands in the search field once it has focus.
        if (search && (e.key.length === 1 || (e.key === 'Backspace' && query))) {
          if (e.key === ' ' && !query) return;
          search.input.focus();
          return;
        }
        return;
      }
    }
    e.preventDefault();
  });
  scope.listen(window, 'pointerdown', () => void app.audio.unlock());

  // Drag and drop anywhere on the screen.
  let dragDepth = 0;
  const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') ?? false;
  scope.listen(window, 'dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
  });
  scope.listen(window, 'dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  });
  scope.listen(window, 'dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  scope.listen(window, 'drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    void app.audio.unlock();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 0 && !busy) options.drop(files);
  });

  return {
    root,
    picker,
    get busy() {
      return busy;
    },
    get loaded() {
      return loaded;
    },
    selectedSong,
    selectedChart,
    chartsOf,
    neighbourSong: () => {
      const at = visible.indexOf(songIndex);
      const i = visible[at + 1] ?? visible[at - 1];
      return i === undefined ? null : (catalog.songs[i] ?? null);
    },
    forgetChart: (songId) => chartChoice.delete(songId),
    setStatus,
    setActions(next) {
      actions = next;
      actionButtons = next.map((action) =>
        button(scope, {
          label: action.label,
          variant: action.variant ?? 'secondary',
          ...(action.icon ? { icon: action.icon } : {}),
          hint: action.key,
          block: (action.placement ?? 'panel') === 'panel',
          onClick: () => {
            if (!busy) action.run();
          },
        }),
      );
      headerActions.replaceChildren(
        ...actionButtons.filter((_, i) => next[i]?.placement === 'header'),
      );
      panelActions.replaceChildren(
        ...actionButtons.filter((_, i) => (next[i]?.placement ?? 'panel') === 'panel'),
      );
      renderSelection();
    },
    perform,
    refresh,
    render: renderSelection,
  };
}

/** Load the catalog for a browser (the list shows "Loading songs…" until then). */
export function loadBrowser(browser: SongBrowser, select: SongSelectParams): void {
  void browser.refresh(select).catch((err: unknown) => {
    browser.setStatus(errorsOf(err).join(' '), 'danger');
  });
}
