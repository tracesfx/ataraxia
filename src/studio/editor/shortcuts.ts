import { icon, keyCapElement } from '../../ui/components';
import { el } from '../../ui/dom';
import { keyCaps } from '../../ui/keyHints';
import type { SceneScope } from '../../ui/sceneManager';

/**
 * Every editor shortcut, in one place: the "?" overlay reads this list, and docs/editor.md
 * mirrors it. Keep them in sync when adding keys (keymap.ts maps the keys to commands; its test
 * checks the documented ones). Lane keys come from the player's bindings.
 */
export interface ShortcutGroup {
  title: string;
  keys: readonly (readonly [keys: string, action: string])[];
}

/** Marker string that only the Studio build contains; scripts/verify-player-build.mjs looks for it. */
export const EDITOR_HELP_MARKER = 'ataraxia-studio-editor-help';

/** The shortcut list for the given lane keys label (e.g. "S D J K"). */
export function editorShortcuts(laneKeys: string): readonly ShortcutGroup[] {
  return [
    {
      title: 'Tools',
      keys: [
        ['N', 'Place tool'],
        ['S', 'Select tool'],
        ['R', 'Record mode on/off'],
        ['Y', 'Hit sounds on/off'],
        ['M', 'Metronome on/off'],
        ['V', 'Analysis view on/off (tracks, panel, inspector)'],
        ['C', 'Compare markers on/off (Suggest > Compare chart)'],
        ['?', 'Show / hide this help'],
      ],
    },
    {
      title: 'Place tool',
      keys: [
        ['Click', 'Place a tap note'],
        ['Drag along a lane', 'Place a hold note'],
        ['Click a note', 'Select it (no delete)'],
        ['Right click', 'Delete the note under the pointer'],
        ['Delete / Backspace', 'Delete the note under the pointer (or the selection)'],
      ],
    },
    {
      title: 'Select tool',
      keys: [
        ['Click', 'Select a note'],
        ['Shift+Click', 'Add / remove a note'],
        ['Drag on empty space', 'Box select (Shift: add)'],
        ['Drag selected notes', 'Move in time (snapped) and between lanes'],
        ['Alt+Up / Alt+Down', 'Move selection one snap later / earlier'],
        ['Alt+Left / Alt+Right', 'Move selection one lane'],
        ['H', 'Mirror selection (lane -> 3 - lane)'],
        ['Delete / Backspace', 'Delete selection'],
        ['Ctrl+A', 'Select all'],
        ['Esc', 'Clear selection (then: back to Studio)'],
      ],
    },
    {
      title: 'Edit',
      keys: [
        ['Ctrl+Z', 'Undo'],
        ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
        ['Ctrl+C', 'Copy selection'],
        ['Ctrl+X', 'Cut selection'],
        ['Ctrl+V', 'Paste at the playhead'],
        ['Ctrl+S', 'Save now'],
      ],
    },
    {
      title: 'Suggested notes (preview)',
      keys: [
        ['Enter', 'Accept the generated notes (one undo step)'],
        ['Esc', 'Discard them'],
        ['G', 'Generate again with a new seed'],
        ['Not in text fields', 'Enter and Esc keep their usual meaning there'],
      ],
    },
    {
      title: 'Record mode',
      keys: [
        [`Lane keys (${laneKeys})`, 'Place notes at the song time while playing'],
        ['While Rec is on', 'Lane keys record notes instead of running their shortcuts'],
        ['1 2 3 4', 'Also lanes 1-4 while recording'],
        ['Hold > 1/4 beat', 'Records a hold'],
      ],
    },
    {
      title: 'Playback and navigation',
      keys: [
        ['Space', 'Play / pause'],
        ['P', 'Playtest from the playhead (after the run-in time)'],
        ['Shift+P', 'Playtest from the game start'],
        ['Up / Down', 'Glide one snap later / earlier'],
        ['PgUp / PgDn', 'Glide one measure later / earlier'],
        ['Home / End', 'Game start (or first note) / end of the audio'],
        ['Wheel', 'Smooth scroll (Shift: fine, a quarter as far)'],
        ['Ctrl+Wheel', 'Zoom around the pointer (the playhead while playing)'],
        ['[ / ]  or  1-8', 'Snap division (1-8 not while recording)'],
        ['T', 'Tap tempo'],
        ['A / B', 'Set range start / end at the playhead (for Suggest)'],
        ['Esc', 'Back to Studio'],
      ],
    },
  ];
}

/** Words that are keys (shown as key caps); anything else is shown as text (Click, Wheel...). */
const KEY_WORDS = new Set([
  'Ctrl',
  'Shift',
  'Alt',
  'Space',
  'Esc',
  'Enter',
  'Delete',
  'Backspace',
  'Home',
  'End',
  'PgUp',
  'PgDn',
  'Up',
  'Down',
  'Left',
  'Right',
]);
const ARROWS: Record<string, string> = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Esc: 'Escape',
};

/** Key caps for "Ctrl+Shift+Z / Ctrl+Y", or null when the text isn't a key combination. */
function keyNodes(text: string): Node[] | null {
  const alternatives = text.split(/\s+(?:\/|or)\s+/);
  const out: Node[] = [];
  for (const [i, alt] of alternatives.entries()) {
    const parts = alt.trim().split('+');
    const isKeys = parts.every((p) => KEY_WORDS.has(p) || /^[A-Z0-9?[\]]$/.test(p));
    if (!isKeys) return null;
    if (i > 0) out.push(el('span', { className: 'keyhint-sep', text: '/' }));
    out.push(...keyCaps(parts.map((p) => ARROWS[p] ?? p).join('+')).map(keyCapElement));
  }
  return out;
}

export interface HelpOverlay {
  readonly open: boolean;
  toggle(force?: boolean): void;
}

/** The "?" cheat sheet listing every shortcut. Click outside the card or press Esc/? to close. */
export function createHelpOverlay(
  scope: SceneScope,
  host: HTMLElement,
  laneKeys: string,
): HelpOverlay {
  const close = el(
    'button',
    {
      className: 'btn btn--ghost btn--icon editor-help-close',
      attrs: { type: 'button', 'aria-label': 'Close (Esc)' },
    },
    [icon('close')],
  );
  const card = el('div', { className: 'modal editor-solid editor-help-card' }, [
    el('header', { className: 'editor-help-head' }, [
      el('h2', { className: 't-title', text: 'Editor shortcuts' }),
      close,
    ]),
    el(
      'div',
      { className: 'editor-help-groups' },
      editorShortcuts(laneKeys).map((g) =>
        el('section', { className: 'editor-help-group' }, [
          el('h3', { className: 'editor-help-group-title t-label', text: g.title }),
          el(
            'dl',
            { className: 'editor-keys' },
            g.keys.flatMap(([k, v]) => {
              const caps = keyNodes(k);
              return [
                el('dt', caps ? { className: 'keyhint-caps' } : { text: k }, caps ?? []),
                el('dd', { text: v }),
              ];
            }),
          ),
        ]),
      ),
    ),
    el('p', { className: 'editor-help-footer', text: EDITOR_HELP_MARKER }),
  ]);
  const overlay = el(
    'div',
    { className: 'editor-help', attrs: { role: 'dialog', 'aria-label': 'Editor shortcuts' } },
    [card],
  );
  overlay.hidden = true;
  host.appendChild(overlay);
  scope.onDispose(() => overlay.remove());

  const api: HelpOverlay = {
    get open() {
      return !overlay.hidden;
    },
    toggle(force?: boolean) {
      overlay.hidden = !(force ?? overlay.hidden);
    },
  };
  scope.listen(close, 'click', () => api.toggle(false));
  scope.listen(overlay, 'pointerdown', (e) => {
    if (e.target === overlay) api.toggle(false);
  });
  return api;
}
