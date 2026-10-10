import { button } from '../../ui/components';
import { el } from '../../ui/dom';
import type { SceneScope } from '../../ui/sceneManager';
import { tip } from './editorUi';

/**
 * The floating bar over the timeline while suggested notes are previewed: Accept (Enter),
 * Discard (Esc), Regenerate with a new seed (G) and a one-line summary. It sits in the timeline
 * view (not the side panel), centred over the lanes, so it stays in sight however the panel is
 * scrolled or collapsed. It slides in and out (no motion with reduced motion, style.css).
 */
export interface AcceptBar {
  readonly element: HTMLElement;
  /** Show the bar with this summary, or hide it (null). */
  render(summary: string | null): void;
  /** Centre the bar on this x (CSS px from the view's left edge, the centre of the lanes). */
  centreOn(x: number): void;
}

export function createAcceptBar(
  scope: SceneScope,
  actions: { accept(): void; discard(): void; regenerate(): void },
): AcceptBar {
  const summary = el('span', { className: 'editor-accept-summary tabular' });
  const accept = tip(
    button(scope, {
      label: 'Accept',
      variant: 'primary',
      hint: 'Enter',
      onClick: () => actions.accept(),
    }),
    'Add the suggested notes (one undo step)',
    ['Enter'],
  );
  const discard = tip(
    button(scope, {
      label: 'Discard',
      variant: 'ghost',
      hint: 'Escape',
      onClick: () => actions.discard(),
    }),
    'Drop the suggested notes',
    ['Esc'],
  );
  const regenerate = tip(
    button(scope, {
      label: 'New seed',
      variant: 'ghost',
      icon: 'dice',
      hint: 'G',
      onClick: () => actions.regenerate(),
    }),
    'Generate again with a new random seed and the same settings',
    ['G'],
  );
  const element = el(
    'div',
    {
      className: 'panel editor-solid editor-accept-bar',
      attrs: { role: 'toolbar', 'aria-label': 'Suggested notes', 'aria-hidden': 'true' },
    },
    [
      el('span', { className: 'editor-accept-title t-label', text: 'Preview' }),
      summary,
      el('div', { className: 'editor-accept-actions' }, [accept, discard, regenerate]),
    ],
  );
  // Out of the tab order while hidden (it stays in the DOM so it can slide out).
  element.inert = true;

  let lastX = Number.NaN;
  return {
    element,
    render(text) {
      const open = text !== null;
      if (open) summary.textContent = text;
      element.classList.toggle('is-open', open);
      element.inert = !open;
      element.setAttribute('aria-hidden', String(!open));
    },
    centreOn(x) {
      if (x === lastX) return;
      lastX = x;
      element.style.left = `${x}px`;
    },
  };
}
