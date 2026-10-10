import { IconPen, mirrorX, registerIcons } from '../ui/pixel/icons';

/**
 * Studio-only pixel icons (16x16 masks, like the player set in src/ui/pixel/icons.ts). They live
 * here so the player bundle never contains them. Registered once by `installStudio`.
 */
const pen = (): IconPen => new IconPen();

/** A tray with an arrow: down into it (import) or up out of it (export). */
function tray(up: boolean): IconPen {
  const p = pen().rect(2, 10, 1, 4).rect(13, 10, 1, 4).rect(2, 13, 12, 1).rect(7, 1, 2, 9);
  return up
    ? p.line(4, 4, 7, 1).line(8, 1, 11, 4).line(3, 5, 7, 1).line(8, 1, 12, 5)
    : p.line(4, 6, 7, 9).line(8, 9, 11, 6).line(3, 5, 7, 9).line(8, 9, 12, 5);
}

/** A bar and a triangle pointing left at it (jump to the start). */
function skipStart(): IconPen {
  const p = pen().rect(2, 2, 2, 12);
  for (let k = 0; k < 6; k++) p.rect(5 + k, 7 - k, 8 - k, 1).rect(5 + k, 8 + k, 8 - k, 1);
  return p;
}

let registered = false;

export function registerStudioIcons(): void {
  if (registered) return;
  registered = true;
  registerIcons({
    edit: () =>
      pen().line(11, 2, 3, 10, 2).rect(12, 2, 2, 2).rect(13, 3, 1, 2).rect(2, 11, 3, 3).mask,
    import: () => tray(false).mask,
    export: () => tray(true).mask,
    undo: () =>
      pen()
        .ring(9, 9, 3.6, 4.7, (t) => t > -2.2 && t < 2.2)
        .line(2, 5, 5, 2)
        .line(2, 5, 5, 8)
        .rect(2, 5, 7, 1).mask,
    redo: () =>
      pen()
        .ring(7, 9, 3.6, 4.7, (t) => Math.abs(t) > 0.95)
        .line(13, 5, 10, 2)
        .line(13, 5, 10, 8)
        .rect(7, 5, 7, 1).mask,
    duplicate: () => pen().box(1, 1, 10, 10).box(5, 5, 10, 10).mask,
    'new-chart': () => pen().box(2, 1, 11, 14).rect(7, 4, 1, 7).rect(4, 7, 7, 1).mask,
    'edit-info': () =>
      pen().box(2, 1, 12, 14).rect(5, 4, 6, 1).rect(5, 7, 6, 1).rect(5, 10, 4, 1).mask,
    'tool-select': () =>
      pen()
        .line(3, 1, 3, 13)
        .line(3, 1, 12, 10)
        .line(3, 13, 6, 10)
        .line(6, 10, 12, 10)
        .line(7, 11, 9, 14).mask,
    /** Two crop corners: one from the top-left, one from the bottom-right. */
    crop: () =>
      pen().rect(4, 1, 1, 11).rect(4, 11, 11, 1).rect(1, 4, 11, 1).rect(11, 4, 1, 11).mask,
    'tool-note': () => pen().box(1, 5, 14, 6).rect(3, 7, 10, 2).mask,
    'tool-hold': () => pen().box(4, 1, 8, 14).rect(6, 3, 4, 10).mask,
    /** A filled pixel dot (record). */
    record: () => pen().rect(5, 3, 6, 10).rect(3, 5, 10, 6).rect(4, 4, 8, 8).mask,
    /** A metronome: tapered body, base and a tilted arm. */
    metronome: () =>
      pen()
        .line(6, 2, 3, 13)
        .line(9, 2, 12, 13)
        .rect(6, 2, 4, 1)
        .rect(2, 13, 12, 2)
        .line(8, 11, 12, 3)
        .rect(6, 9, 4, 1).mask,
    'skip-start': () => skipStart().mask,
    'skip-end': () => mirrorX(skipStart().mask),
    /** A die showing five. */
    dice: () =>
      pen()
        .box(1, 1, 14, 14)
        .rect(4, 4, 2, 2)
        .rect(10, 4, 2, 2)
        .rect(7, 7, 2, 2)
        .rect(4, 10, 2, 2)
        .rect(10, 10, 2, 2).mask,
    more: () => pen().rect(2, 7, 2, 2).rect(7, 7, 2, 2).rect(12, 7, 2, 2).mask,
    help: () =>
      pen()
        .rect(5, 3, 6, 1)
        .rect(4, 4, 2, 2)
        .rect(10, 4, 2, 3)
        .rect(8, 7, 3, 1)
        .rect(7, 8, 2, 2)
        .rect(7, 12, 2, 2).mask,
    /** A magnet: snap to the grid. */
    magnet: () =>
      pen()
        .rect(2, 2, 3, 7)
        .rect(11, 2, 3, 7)
        .ring(8, 8.5, 3.2, 6.1, (t) => t > 0)
        .clear(2, 2, 3, 2)
        .clear(11, 2, 3, 2)
        .rect(2, 1, 3, 1)
        .rect(11, 1, 3, 1).mask,
    flag: () => pen().rect(3, 1, 1, 14).rect(4, 2, 9, 1).rect(4, 3, 8, 3).rect(4, 6, 9, 1).mask,
    /** Mirror: two arrows pointing apart around a centre line. */
    mirror: () =>
      pen()
        .rect(7, 1, 2, 14)
        .line(1, 8, 4, 5)
        .line(1, 8, 4, 11)
        .rect(1, 8, 5, 1)
        .line(14, 8, 11, 5)
        .line(14, 8, 11, 11)
        .rect(10, 8, 5, 1).mask,
    copy: () => pen().box(4, 4, 10, 11).rect(2, 1, 8, 1).rect(1, 2, 1, 9).mask,
  });
}
