import type { App } from '../ui/app';
import { button, hintBar, progressBar, songCard, type CoverSource } from '../ui/components';
import { el } from '../ui/dom';
import type { SceneScope } from '../ui/sceneManager';

export interface PauseItem {
  label: string;
  icon: string;
}

export interface PauseView {
  /** Paused and not covered by the settings overlay. */
  visible: boolean;
  selected: number;
  /** While resuming: the part of the resume delay still left (1 -> 0), else null. */
  resumeLeft: number | null;
}

export interface PauseOverlay {
  /** Bring the DOM in line with the game's pause state (cheap when nothing changed). */
  update(view: PauseView): void;
}

/**
 * The pause menu: a dimmed backdrop with a glass panel and a vertical menu. The game scene owns
 * the selection (arrow keys, Enter, Esc, R, Q on its window listener), so the buttons are not
 * tab stops; the selected one wears the keyboard focus look. Clicking works too. While the
 * resume delay runs, the menu gives way to a shrinking bar.
 */
export function createPauseOverlay(
  scope: SceneScope,
  app: App,
  o: {
    title: string;
    subtitle: () => string;
    /** The song shown as a card at the top of the panel (null while loading). */
    song: () => (CoverSource & { artist: string }) | null;
    items: readonly PauseItem[];
    onChoose: (i: number) => void;
  },
): PauseOverlay {
  const buttons = o.items.map((item, i) => {
    const b = button(scope, {
      label: item.label,
      icon: item.icon,
      variant: i === 0 ? 'primary' : 'secondary',
      block: true,
      onClick: () => o.onChoose(i),
    });
    b.tabIndex = -1;
    return b;
  });
  const bar = progressBar('Resuming');
  const ready = el('div', { className: 'pause-ready' }, [
    el('p', { className: 't-title', text: 'Get ready' }),
    bar.root,
  ]);
  const subtitle = el('p', { className: 'pause-subtitle' });
  const songSlot = el('div', { className: 'pause-song' });
  const menu = el('div', { className: 'pause-menu', attrs: { role: 'menu' } }, buttons);
  const panel = el('div', { className: 'panel pause-panel' }, [
    el('h2', { className: 'pause-title t-title', text: o.title }),
    songSlot,
    subtitle,
    menu,
    ready,
    hintBar([
      ['Enter', 'Choose'],
      ['Escape', 'Resume'],
      ['R', 'Restart'],
    ]),
  ]);
  const root = el(
    'div',
    { className: 'pause-overlay', attrs: { role: 'dialog', 'aria-label': o.title } },
    [panel],
  );
  root.hidden = true;
  ready.hidden = true;
  app.ui.appendChild(root);
  scope.onDispose(() => root.remove());

  let last = { visible: false, selected: -1, resuming: false };
  return {
    update(view) {
      const resuming = view.resumeLeft !== null;
      if (view.visible !== last.visible) {
        root.hidden = !view.visible;
        if (view.visible) {
          subtitle.textContent = o.subtitle();
          const song = o.song();
          songSlot.replaceChildren(...(song ? [songCard(song)] : []));
        }
      }
      if (view.selected !== last.selected) {
        buttons.forEach((b, i) => b.classList.toggle('is-kbd', i === view.selected));
      }
      if (resuming !== last.resuming) {
        menu.hidden = resuming;
        ready.hidden = !resuming;
      }
      if (view.resumeLeft !== null) bar.set(view.resumeLeft);
      last = { visible: view.visible, selected: view.selected, resuming };
    },
  };
}
