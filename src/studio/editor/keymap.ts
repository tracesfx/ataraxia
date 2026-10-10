import { SNAP_DIVISIONS, type SnapDivision } from '../../core/time';

/**
 * The editor's keyboard map: which command a key press runs. Pure (no DOM), so the documented
 * shortcuts are tested against it; the scene only dispatches the commands. Lane keys while
 * recording and text fields are handled before this map is consulted.
 */
export type EditorCommand =
  // Ctrl / Cmd
  | 'undo'
  | 'redo'
  | 'selectAll'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'save'
  // Alt
  | 'nudgeLater'
  | 'nudgeEarlier'
  | 'laneLeft'
  | 'laneRight'
  // Plain keys
  | 'togglePlay'
  | 'stepLater'
  | 'stepEarlier'
  | 'measureLater'
  | 'measureEarlier'
  | 'home'
  | 'end'
  | 'snapCoarser'
  | 'snapFiner'
  | 'tapTempo'
  | 'toggleMetronome'
  | 'toolNote'
  | 'toolSelect'
  | 'toggleRecord'
  | 'toggleHitSounds'
  | 'mirror'
  | 'playtestHere'
  | 'playtestStart'
  | 'rangeA'
  | 'rangeB'
  | 'help'
  | 'delete'
  | 'escape'
  | 'acceptSuggestion'
  | 'regenerateSuggestion'
  | 'toggleAnalysis'
  | 'toggleCompare'
  | 'setSnap';

export interface KeyAction {
  command: EditorCommand;
  /** For setSnap: the division. */
  snap?: SnapDivision;
  /** Auto-repeat runs it again (held arrows); otherwise only the first press counts. */
  repeats: boolean;
}

/** The parts of a KeyboardEvent the map reads. */
export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const act = (command: EditorCommand, repeats = false, snap?: SnapDivision): KeyAction =>
  snap === undefined ? { command, repeats } : { command, repeats, snap };

function commandKey(e: KeyPress): KeyAction | null {
  switch (e.code) {
    case 'KeyZ':
      return act(e.shiftKey ? 'redo' : 'undo', true);
    case 'KeyY':
      return act('redo', true);
    case 'KeyA':
      return act('selectAll');
    case 'KeyC':
      return act('copy');
    case 'KeyX':
      return act('cut');
    case 'KeyV':
      return act('paste');
    case 'KeyS':
      return act('save');
    default:
      return null;
  }
}

function altKey(e: KeyPress): KeyAction | null {
  switch (e.key) {
    case 'ArrowUp':
      return act('nudgeLater', true);
    case 'ArrowDown':
      return act('nudgeEarlier', true);
    case 'ArrowLeft':
      return act('laneLeft', true);
    case 'ArrowRight':
      return act('laneRight', true);
    default:
      return null;
  }
}

const PLAIN: Readonly<Record<string, KeyAction>> = {
  ' ': act('togglePlay'),
  ArrowUp: act('stepLater', true),
  ArrowDown: act('stepEarlier', true),
  PageUp: act('measureLater', true),
  PageDown: act('measureEarlier', true),
  Home: act('home', true),
  End: act('end', true),
  '[': act('snapCoarser', true),
  ']': act('snapFiner', true),
  t: act('tapTempo'),
  m: act('toggleMetronome'),
  n: act('toolNote', true),
  s: act('toolSelect', true),
  r: act('toggleRecord'),
  y: act('toggleHitSounds'),
  h: act('mirror'),
  v: act('toggleAnalysis'),
  c: act('toggleCompare'),
  a: act('rangeA'),
  b: act('rangeB'),
  '?': act('help', true),
  Delete: act('delete', true),
  Backspace: act('delete', true),
  Escape: act('escape', true),
  // Suggestion preview (the scene ignores them without one).
  Enter: act('acceptSuggestion'),
  g: act('regenerateSuggestion'),
};

function plainKey(e: KeyPress): KeyAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'p') return act(e.shiftKey ? 'playtestStart' : 'playtestHere');
  const mapped = PLAIN[key];
  if (mapped) return mapped;
  const n = Number(key);
  const division = Number.isInteger(n) && n >= 1 ? SNAP_DIVISIONS[n - 1] : undefined;
  return division === undefined ? null : act('setSnap', true, division);
}

/** The command for a key press, or null when the editor doesn't use it. */
export function resolveKey(e: KeyPress): KeyAction | null {
  if (e.ctrlKey || e.metaKey) return e.altKey ? null : commandKey(e);
  if (e.altKey) return altKey(e);
  return plainKey(e);
}
