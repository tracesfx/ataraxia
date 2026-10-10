import { describe, expect, it } from 'vitest';
import { resolveKey, type EditorCommand, type KeyPress } from './keymap';
import { editorShortcuts } from './shortcuts';

/** A key press from a short description: "Ctrl+Shift+KeyZ", "Alt+ArrowUp", "Shift+p", "?". */
function press(spec: string): KeyPress {
  const parts = spec.split('+');
  const last = parts[parts.length - 1] ?? '';
  const mods = new Set(parts.slice(0, -1));
  const isCode = /^(Key|Digit)/.test(last);
  const key = isCode
    ? last.replace(/^Key|^Digit/, '').toLowerCase()
    : last === 'Space'
      ? ' '
      : last;
  return {
    key: mods.has('Shift') && key.length === 1 ? key.toUpperCase() : key,
    code: isCode ? last : '',
    ctrlKey: mods.has('Ctrl'),
    metaKey: mods.has('Meta'),
    shiftKey: mods.has('Shift'),
    altKey: mods.has('Alt'),
  };
}

/**
 * Every shortcut documented before the Phase 12 revamp (docs/editor.md) and the command it ran.
 * The revamp changed how the view moves, not what the keys do.
 */
const DOCUMENTED: readonly (readonly [string, EditorCommand, number?])[] = [
  ['n', 'toolNote'],
  ['s', 'toolSelect'],
  ['r', 'toggleRecord'],
  ['y', 'toggleHitSounds'],
  ['m', 'toggleMetronome'],
  ['?', 'help'],
  ['Delete', 'delete'],
  ['Backspace', 'delete'],
  ['Alt+ArrowUp', 'nudgeLater'],
  ['Alt+ArrowDown', 'nudgeEarlier'],
  ['Alt+ArrowLeft', 'laneLeft'],
  ['Alt+ArrowRight', 'laneRight'],
  ['h', 'mirror'],
  ['Ctrl+KeyA', 'selectAll'],
  ['Escape', 'escape'],
  ['Ctrl+KeyZ', 'undo'],
  ['Ctrl+Shift+KeyZ', 'redo'],
  ['Ctrl+KeyY', 'redo'],
  ['Meta+KeyZ', 'undo'],
  ['Ctrl+KeyC', 'copy'],
  ['Ctrl+KeyX', 'cut'],
  ['Ctrl+KeyV', 'paste'],
  ['Ctrl+KeyS', 'save'],
  ['Space', 'togglePlay'],
  ['p', 'playtestHere'],
  ['Shift+p', 'playtestStart'],
  ['ArrowUp', 'stepLater'],
  ['ArrowDown', 'stepEarlier'],
  ['PageUp', 'measureLater'],
  ['PageDown', 'measureEarlier'],
  ['Home', 'home'],
  ['End', 'end'],
  ['[', 'snapCoarser'],
  [']', 'snapFiner'],
  ['t', 'tapTempo'],
  ['a', 'rangeA'],
  ['b', 'rangeB'],
  ['1', 'setSnap', 1],
  ['2', 'setSnap', 2],
  ['3', 'setSnap', 3],
  ['4', 'setSnap', 4],
  ['5', 'setSnap', 6],
  ['6', 'setSnap', 8],
  ['7', 'setSnap', 12],
  ['8', 'setSnap', 16],
];

describe('resolveKey', () => {
  for (const [spec, command, snap] of DOCUMENTED) {
    it(`${spec} runs ${command}`, () => {
      const action = resolveKey(press(spec));
      expect(action?.command).toBe(command);
      if (snap !== undefined) expect(action?.snap).toBe(snap);
    });
  }

  it('works with Caps Lock (upper-case letters)', () => {
    expect(resolveKey({ ...press('n'), key: 'N' })?.command).toBe('toolNote');
  });

  it('ignores keys the editor does not use', () => {
    expect(resolveKey(press('q'))).toBeNull();
    expect(resolveKey(press('9'))).toBeNull();
    expect(resolveKey(press('Ctrl+Alt+KeyZ'))).toBeNull();
    expect(resolveKey(press('Alt+n'))).toBeNull();
  });

  it('only repeats navigation and stepping keys', () => {
    expect(resolveKey(press('ArrowUp'))?.repeats).toBe(true);
    expect(resolveKey(press('Space'))?.repeats).toBe(false);
    expect(resolveKey(press('p'))?.repeats).toBe(false);
    expect(resolveKey(press('t'))?.repeats).toBe(false);
  });
});

describe('editorShortcuts', () => {
  it('documents every single-key command the map knows', () => {
    const listed = editorShortcuts('S D J K')
      .flatMap((g) => g.keys.map(([k]) => k))
      .join(' | ');
    for (const key of ['N', 'S', 'R', 'Y', 'M', 'H', 'P', 'T', 'Space', 'Ctrl+S', 'Ctrl+A']) {
      expect(listed).toContain(key);
    }
  });
});
