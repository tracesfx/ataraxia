import { JUDGEMENTS, JUDGEMENT_WINDOWS_MS, type Judgement } from '../core/judgement';
import type { PlayResult, Rank } from '../core/results';
import { LibraryError } from '../library/repository';
import { DEMO_SONG_ID } from '../library/songLibrary';
import { levelTier } from '../render/levelTier';
import type { App } from './app';
import { useBackdrop } from './backdrop';
import { button, chip, coverArt, icon, toaster } from './components';
import { el } from './dom';
import { rankUrl } from './pixel/render';
import { RANK_H, RANK_W } from './pixel/rank';
import type { Scene, SceneScope } from './sceneManager';
import type { ResultsParams } from './scenes';
import { formatScore } from './songBrowser';
import { TIER_TONES } from './theme';

const JUDGEMENT_LABEL: Record<Judgement, string> = {
  perfect: 'Perfect',
  great: 'Great',
  good: 'Good',
  miss: 'Miss',
};

/** The rank as a large metallic pixel-art letter. */
function rankLetter(rank: Rank): HTMLElement {
  const node = el(
    'div',
    { className: `rank-art rank-${rank}`, attrs: { role: 'img', 'aria-label': `Rank ${rank}` } },
    [el('img', { attrs: { src: rankUrl(rank), alt: '', draggable: 'false' } })],
  );
  node.style.setProperty('--rank-w', String(RANK_W + 3));
  node.style.setProperty('--rank-h', String(RANK_H + 3));
  return node;
}

/** Judgement counts as pixel bars, scaled to the largest count. */
function judgementBars(r: PlayResult): HTMLElement {
  const max = Math.max(1, ...JUDGEMENTS.map((j) => r.counts[j]));
  return el(
    'div',
    { className: 'jbars' },
    JUDGEMENTS.map((j) => {
      const bar = el('span', { className: 'jbar' }, [el('span', { className: 'jbar-fill' })]);
      bar.style.setProperty('--fraction', String(r.counts[j] / max));
      return el('div', { className: `jrow j-${j}` }, [
        el('span', { className: 'jrow-label t-label', text: JUDGEMENT_LABEL[j] }),
        bar,
        el('span', { className: 'jrow-count t-label tabular', text: String(r.counts[j]) }),
      ]);
    }),
  );
}

/** The timing histogram: early bars left of 0, late bars right, the perfect window shaded. */
function histogram(r: PlayResult): HTMLElement {
  const h = r.histogram;
  const max = Math.max(1, ...h.bins);
  const span = h.maxMs - h.minMs;
  const at = (ms: number): string => String((ms - h.minMs) / span);
  const plot = el('div', { className: 'hist-plot' }, [
    el('span', { className: 'hist-window' }),
    ...h.bins.map((count, i) => {
      const centre = h.minMs + (i + 0.5) * h.binMs;
      const bar = el('span', { className: `hist-bar ${centre < 0 ? 'is-early' : 'is-late'}` });
      bar.style.setProperty('--fraction', String(count / max));
      bar.style.setProperty('--i', String(i));
      return bar;
    }),
    el('span', { className: 'hist-zero' }),
  ]);
  plot.style.setProperty('--bins', String(h.bins.length));
  plot.style.setProperty('--win-from', at(-JUDGEMENT_WINDOWS_MS.perfect));
  plot.style.setProperty('--win-to', at(JUDGEMENT_WINDOWS_MS.perfect));
  plot.style.setProperty('--zero', at(0));
  if (h.averageMs !== null) {
    const avg = el('span', { className: 'hist-avg' });
    avg.style.setProperty('--at', at(Math.max(h.minMs, Math.min(h.maxMs, h.averageMs))));
    plot.appendChild(avg);
  }
  const avg = h.averageMs === null ? null : Math.round(h.averageMs * 10) / 10;
  const side = avg === null ? '' : Math.abs(avg) < 5 ? 'on time' : avg < 0 ? 'early' : 'late';
  return el('div', { className: 'hist' }, [
    el('div', { className: 'hist-head' }, [
      el('span', { className: 't-label', text: 'Timing' }),
      el('span', {
        className: 'hist-avg-text tabular',
        text:
          avg === null ? 'No hits' : `Average ${avg > 0 ? '+' : ''}${avg.toFixed(1)} ms, ${side}`,
      }),
    ]),
    plot,
    el('div', { className: 'hist-axis tabular' }, [
      el('span', { text: `${h.minMs} ms` }),
      el('span', { text: '0' }),
      el('span', { text: `+${h.maxMs} ms` }),
    ]),
  ]);
}

/**
 * After a song: the rank as a large metallic letter, score, accuracy, max combo, badges, the
 * judgement breakdown as bars, early/late counts and the timing histogram, with Retry (R /
 * Enter) and Song select (Esc). The Studio build adds Edit chart (E); the player build has no
 * way into the editor. Saves the play as the chart's personal best when `save` is set and it
 * beats the stored one.
 */
export class ResultsScene implements Scene<ResultsParams> {
  constructor(private readonly app: App) {}

  enter(scope: SceneScope, params: ResultsParams): void {
    const { app } = this;
    const { game, result: r, chartInfo: info } = params;
    const toasts = toaster(scope, app.ui);
    const bestSlot = el('div', { className: 'results-best' });
    const showBest = (node: Node | null): void => {
      bestSlot.replaceChildren(...(node ? [node] : []));
    };
    showBest(
      params.save
        ? null
        : el('p', { className: 'results-note', text: 'Partial play: the score was not saved.' }),
    );

    if (params.save) {
      app.library
        .recordScore({
          chartId: game.chartId,
          songId: game.songId,
          score: r.score,
          accuracy: r.accuracy,
          rank: r.rank,
          maxCombo: r.maxCombo,
          fullCombo: r.badges.fullCombo,
          allPerfect: r.badges.allPerfect,
        })
        .then(
          (saved) => {
            if (scope.disposed) return;
            if (!saved) {
              showBest(el('p', { className: 'results-note', text: 'Not saved: no storage.' }));
              return;
            }
            const prev = saved.previous;
            showBest(
              el('div', { className: 'results-best-row' }, [
                ...(saved.isNewBest
                  ? [
                      el('span', { className: 'new-best t-label' }, [
                        icon('star'),
                        el('span', { text: 'New best' }),
                      ]),
                    ]
                  : []),
                el('span', {
                  className: 'results-note tabular',
                  text: prev
                    ? `Previous best ${formatScore(prev.score)} (${prev.rank})`
                    : 'First play of this chart',
                }),
              ]),
            );
          },
          (err: unknown) => {
            if (scope.disposed) return;
            console.error('Saving the score failed:', err);
            const reason =
              err instanceof LibraryError
                ? err.errors.join(' ')
                : 'The browser refused to write to its storage. Check that site data is allowed.';
            showBest(el('p', { className: 'results-note', text: 'Score not saved.' }));
            toasts.show(`Your score could not be saved. ${reason}`, 'danger');
          },
        );
    }

    const retry = (): void => void app.scenes.goTo('game', game);
    const back = (): void =>
      void app.scenes.goTo('songSelect', { songId: game.songId, chartId: game.chartId });
    const edit = (): void => {
      if (!__STUDIO__) return;
      if (game.songId === DEMO_SONG_ID) {
        toasts.show(
          'The demo song is read-only. Import your own audio in Studio to make charts.',
          'danger',
        );
        return;
      }
      void app.scenes.goTo('editor', { songId: game.songId, chartId: game.chartId });
    };

    const badges = [
      ...(r.badges.allPerfect
        ? [chip({ label: 'All perfect', tone: 'accent', className: 'badge' })]
        : []),
      ...(r.badges.fullCombo
        ? [chip({ label: 'Full combo', tone: 'success', className: 'badge' })]
        : []),
    ];

    const stat = (label: string, value: string, className = ''): HTMLElement =>
      el('div', { className: `results-stat ${className}`.trim() }, [
        el('span', { className: 'results-stat-label', text: label }),
        el('span', { className: 'results-stat-value t-title tabular', text: value }),
      ]);

    const retryButton = button(scope, {
      label: 'Retry',
      icon: 'retry',
      variant: 'primary',
      hint: 'R',
      onClick: retry,
    });
    const root = el('div', { className: 'screen results-screen' }, [
      el('header', { className: 'screen-header' }, [
        el('h1', { className: 'screen-title t-title', text: 'Results' }),
        el('div', { className: 'screen-header-end results-song' }, [
          coverArt(info, 'thumb'),
          el('span', { className: 'results-song-text' }, [
            el('span', { className: 't-label', text: info.title }),
            el('span', { className: 'results-song-sub', text: info.artist }),
          ]),
          chip({
            lead: String(info.level),
            label: info.difficulty,
            tone: TIER_TONES[levelTier(info.level)] ?? 'steel',
          }),
        ]),
      ]),
      el('main', { className: 'screen-body results-body' }, [
        el('section', { className: 'panel results-main' }, [
          rankLetter(r.rank),
          el('div', { className: 'results-score' }, [
            el('span', { className: 'results-stat-label', text: 'Score' }),
            el('span', {
              className: 'results-score-value t-display tabular',
              text: formatScore(r.score),
            }),
            el('div', { className: 'results-stats' }, [
              stat('Accuracy', `${r.accuracy.toFixed(2)}%`),
              stat('Max combo', `${r.maxCombo} / ${r.totalNotes}`),
            ]),
            ...(badges.length ? [el('div', { className: 'results-badges' }, badges)] : []),
            bestSlot,
          ]),
        ]),
        el('section', { className: 'panel results-detail' }, [
          el('h2', { className: 'results-section t-label', text: 'Judgements' }),
          judgementBars(r),
          el('div', { className: 'results-early-late' }, [
            el('span', { className: 'el-early' }, [
              el('span', { className: 'results-stat-label', text: 'Early' }),
              el('span', { className: 't-label tabular', text: String(r.early) }),
            ]),
            el('span', { className: 'el-late' }, [
              el('span', { className: 'results-stat-label', text: 'Late' }),
              el('span', { className: 't-label tabular', text: String(r.late) }),
            ]),
            ...(r.drops > 0
              ? [
                  el('span', {}, [
                    el('span', { className: 'results-stat-label', text: 'Dropped holds' }),
                    el('span', { className: 't-label tabular', text: String(r.drops) }),
                  ]),
                ]
              : []),
          ]),
          histogram(r),
        ]),
      ]),
      el('footer', { className: 'results-actions' }, [
        retryButton,
        button(scope, { label: 'Song select', icon: 'back', hint: 'Escape', onClick: back }),
        ...(__STUDIO__
          ? [
              button(scope, {
                label: 'Edit chart',
                icon: 'edit',
                variant: 'ghost',
                hint: 'E',
                onClick: edit,
              }),
            ]
          : []),
      ]),
    ]);
    app.ui.appendChild(root);
    scope.onDispose(() => root.remove());
    useBackdrop(scope, app, { kind: 'cover', title: info.title, cover: info.cover });
    retryButton.focus();

    scope.listen(window, 'keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.code) {
        case 'KeyR':
          retry();
          break;
        case 'Enter':
        case 'NumpadEnter':
          if (e.target instanceof HTMLButtonElement) return; // the focused button handles it
          retry();
          break;
        case 'Escape':
          back();
          break;
        case 'KeyE':
          if (!__STUDIO__) return;
          edit();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          const buttons = [...root.querySelectorAll<HTMLButtonElement>('.results-actions .btn')];
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const step = e.code === 'ArrowRight' ? 1 : -1;
          buttons[(i + step + buttons.length) % buttons.length]?.focus();
          break;
        }
        default:
          return;
      }
      e.preventDefault();
    });
  }
}
