import { keyLabel, type LaneKeys } from '../core/settings';

/**
 * Key cap contents for key hints. Pure, so the mapping from key codes and the lane binding
 * config is tested. Words are lowercase (matching the lowercase brand); single letters keep
 * their keyboard capitals; arrows are icons.
 */
export type KeyCap = { text: string } | { icon: string };

const NAMED: Record<string, KeyCap> = {
  ArrowUp: { icon: 'chevron-up' },
  ArrowDown: { icon: 'chevron-down' },
  ArrowLeft: { icon: 'chevron-left' },
  ArrowRight: { icon: 'chevron-right' },
  Enter: { text: 'enter' },
  NumpadEnter: { text: 'enter' },
  Escape: { text: 'esc' },
  Delete: { text: 'del' },
  Backspace: { text: 'bksp' },
  Space: { text: 'space' },
  Tab: { text: 'tab' },
  Ctrl: { text: 'ctrl' },
  Shift: { text: 'shift' },
  Alt: { text: 'alt' },
};

/**
 * The cap for one key, given as a `KeyboardEvent.code` ("KeyS", "ArrowUp"), a modifier name
 * ("Ctrl") or a literal character ("/", "[").
 */
export function keyCap(key: string): KeyCap {
  const named = NAMED[key];
  if (named) return named;
  if (/^(Key|Digit|Numpad)/.test(key) || key.length > 1) {
    const label = keyLabel(key);
    return { text: label.length === 1 ? label : label.toLowerCase() };
  }
  return { text: key.length === 1 ? key.toUpperCase() : key };
}

/** "Ctrl+O" -> [ctrl] [O]. */
export function keyCaps(combo: string): KeyCap[] {
  return combo.split('+').map((k) => keyCap(k === '' ? '+' : k));
}

/** One cap per lane, from the player's bindings (never hardcoded). */
export function laneKeyCaps(keys: LaneKeys): KeyCap[] {
  return keys.map(keyCap);
}

/** Plain text for a cap (aria labels, tests). */
export function capText(cap: KeyCap): string {
  if ('text' in cap) return cap.text;
  return (
    {
      'chevron-up': 'up',
      'chevron-down': 'down',
      'chevron-left': 'left',
      'chevron-right': 'right',
    }[cap.icon] ?? cap.icon
  );
}
