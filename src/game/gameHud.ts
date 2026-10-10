import type { ScoreSummary } from '../core/scoring';
import { formatSongTime } from '../core/time';
import type { App } from '../ui/app';
import { chip, hintBar, keyHint } from '../ui/components';
import { el } from '../ui/dom';
import type { SceneScope } from '../ui/sceneManager';

/**
 * The DOM parts of the gameplay screen, built from the Phase 9 components so they match the
 * menus: the centred message panel (loading, errors, "press enter", the playtest summary) and
 * the practice panel (speed and loop range). The canvas draws only the playfield and HUD.
 */

export type MessageView =
  | { kind: 'loading'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'ready'; laneKeys: readonly string[] }
  | { kind: 'summary'; score: ScoreSummary; hint: string };

export interface GameMessage {
  /** Show a view, or hide the panel with null. Cheap when nothing changed. */
  update(view: MessageView | null): void;
}

export function createGameMessage(scope: SceneScope, app: App): GameMessage {
  const panel = el('div', { className: 'panel game-message', attrs: { role: 'status' } });
  const root = el('div', { className: 'game-message-layer' }, [panel]);
  root.hidden = true;
  app.ui.appendChild(root);
  scope.onDispose(() => root.remove());
  let lastKey = '';

  const keyOf = (v: MessageView | null): string => {
    if (!v) return '';
    switch (v.kind) {
      case 'loading':
      case 'error':
        return `${v.kind}:${v.text}`;
      case 'ready':
        return `ready:${v.laneKeys.join(',')}`;
      case 'summary':
        return `summary:${v.score.score}:${v.score.judged}:${v.hint}`;
    }
  };

  const render = (v: MessageView): Node[] => {
    switch (v.kind) {
      case 'loading':
        return [el('p', { className: 't-title', text: v.text })];
      case 'error':
        return [
          el('h2', { className: 't-title', text: 'Something went wrong' }),
          el('p', { className: 'game-message-text', text: v.text }),
          hintBar([['Escape', 'Back']]),
        ];
      case 'ready':
        return [
          el('h2', { className: 't-title', text: 'Ready' }),
          el('p', { className: 'game-message-text', text: 'Press enter to start the song.' }),
          el('div', { className: 'game-message-keys' }, [keyHint([...v.laneKeys], 'Hit notes')]),
          hintBar([
            ['Enter', 'Start'],
            ['Escape', 'Pause'],
            [['F2', 'F4'], 'Scroll speed'],
          ]),
        ];
      case 'summary': {
        const s = v.score;
        const row = (label: string, value: string, cls = ''): HTMLElement =>
          el('div', { className: `game-summary-row ${cls}`.trim() }, [
            el('span', { text: label }),
            el('span', { className: 'tabular', text: value }),
          ]);
        return [
          el('h2', { className: 't-title', text: 'Playtest' }),
          el('p', { className: 'game-summary-score t-display tabular', text: String(s.score) }),
          row('Accuracy', `${s.accuracy.toFixed(2)}%`),
          row('Max combo', `${s.maxCombo} / ${s.totalNotes}`),
          row('Perfect', String(s.counts.perfect), 'is-perfect'),
          row('Great', String(s.counts.great), 'is-great'),
          row('Good', String(s.counts.good), 'is-good'),
          row('Miss', String(s.counts.miss), 'is-miss'),
          el('p', { className: 'game-message-text', text: v.hint }),
        ];
      }
    }
  };

  return {
    update(view) {
      const key = keyOf(view);
      if (key === lastKey) return;
      lastKey = key;
      root.hidden = view === null;
      panel.dataset.kind = view?.kind ?? '';
      panel.replaceChildren(...(view ? render(view) : []));
    },
  };
}

export interface PracticeView {
  rate: number;
  aMs: number | null;
  bMs: number | null;
  looping: boolean;
}

export interface PracticePanel {
  update(view: PracticeView): void;
  /** Place the panel's top-left at CSS pixels. */
  place(left: number, top: number): void;
}

/** The practice panel: a glass card with the speed and the loop marks, plus its keys. */
export function createPracticePanel(scope: SceneScope, app: App): PracticePanel {
  const speed = el('span', { className: 'tabular' });
  const loop = el('span', { className: 'tabular' });
  const root = el('div', { className: 'panel hud-practice', attrs: { 'aria-live': 'polite' } }, [
    chip({ label: 'practice', tone: 'accent' }),
    el('div', { className: 'hud-practice-row' }, [el('span', { text: 'Speed' }), speed]),
    el('div', { className: 'hud-practice-row' }, [el('span', { text: 'Loop' }), loop]),
    el('div', { className: 'hud-practice-keys' }, [
      keyHint(['[', ']'], 'Set A / B'),
      keyHint('\\', 'Clear'),
      keyHint(['-', '='], 'Speed'),
    ]),
  ]);
  app.ui.appendChild(root);
  scope.onDispose(() => root.remove());
  let last = '';
  const mark = (ms: number | null): string => (ms === null ? '–' : formatSongTime(ms));
  return {
    update(v) {
      const s = `${Math.round(v.rate * 100)}%`;
      const l = v.aMs === null && v.bMs === null ? 'Off' : `${mark(v.aMs)} – ${mark(v.bMs)}`;
      const key = `${s}|${l}|${v.looping}`;
      if (key === last) return;
      last = key;
      speed.textContent = s;
      loop.textContent = l;
      root.classList.toggle('is-looping', v.looping);
    },
    place(left, top) {
      root.style.left = `${Math.round(left)}px`;
      root.style.top = `${Math.round(top)}px`;
    },
  };
}
