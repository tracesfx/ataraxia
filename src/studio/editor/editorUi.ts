import { icon, keyHint } from '../../ui/components';
import { el } from '../../ui/dom';
import type { SceneScope } from '../../ui/sceneManager';

/**
 * Small widgets for the editor screen, built on the design system's sprites and classes: one
 * floating tooltip (with key caps) for every control, dropdown menus, segmented controls,
 * collapsible panel sections and icon buttons. Studio only.
 */

export type TipSide = 'below' | 'above' | 'right' | 'left';

/** Attach a tooltip: what the control does and its shortcut(s), e.g. ['Ctrl+Z']. */
export function tip<T extends HTMLElement>(
  node: T,
  text: string,
  keys: readonly string[] = [],
  side?: TipSide,
): T {
  node.dataset['tip'] = text;
  if (keys.length > 0) node.dataset['tipKeys'] = keys.join('|');
  else delete node.dataset['tipKeys'];
  if (side) node.dataset['tipSide'] = side;
  if (!node.hasAttribute('aria-label') && !node.textContent?.trim()) {
    node.setAttribute('aria-label', text);
  }
  return node;
}

/**
 * One tooltip element for a whole screen: shows the hovered (or keyboard-focused) control's
 * `data-tip` after a short delay, positioned in the viewport so panels with scrolling never clip
 * it. Hidden on press, scroll and Escape.
 */
export function installTooltips(scope: SceneScope, root: HTMLElement): { hide(): void } {
  const text = el('span', { className: 'editor-tip-text' });
  const keys = el('span', { className: 'editor-tip-keys' });
  const node = el('div', { className: 'tooltip editor-tip', attrs: { role: 'tooltip' } }, [
    text,
    keys,
  ]);
  root.appendChild(node);
  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  scope.onDispose(() => {
    clear();
    node.remove();
  });

  const hide = (): void => {
    clear();
    target = null;
    node.classList.remove('is-shown');
  };

  const show = (t: HTMLElement): void => {
    text.textContent = t.dataset['tip'] ?? '';
    const list = t.dataset['tipKeys']?.split('|').filter((k) => k !== '') ?? [];
    keys.replaceChildren(...(list.length > 0 ? [keyHint(list)] : []));
    keys.hidden = list.length === 0;
    node.classList.add('is-shown');
    const r = t.getBoundingClientRect();
    const tw = node.offsetWidth;
    const th = node.offsetHeight;
    const gap = 8;
    const side = (t.dataset['tipSide'] as TipSide | undefined) ?? 'below';
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.bottom + gap;
    if (side === 'above') y = r.top - th - gap;
    if (side === 'right' || side === 'left') {
      x = side === 'right' ? r.right + gap : r.left - tw - gap;
      y = r.top + r.height / 2 - th / 2;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (side === 'below' && y + th > vh - 4) y = r.top - th - gap;
    x = Math.round(Math.min(vw - tw - 6, Math.max(6, x)));
    y = Math.round(Math.min(vh - th - 6, Math.max(6, y)));
    node.style.transform = `translate(${x}px, ${y}px)`;
  };

  const enter = (from: EventTarget | null, delayMs: number): void => {
    const t = from instanceof Element ? from.closest<HTMLElement>('[data-tip]') : null;
    if (t === target) return;
    hide();
    if (!t || !root.contains(t)) return;
    target = t;
    timer = setTimeout(() => {
      timer = null;
      if (target === t && t.isConnected) show(t);
    }, delayMs);
  };
  scope.listen(root, 'pointerover', (e) => enter(e.target, 380));
  scope.listen(root, 'focusin', (e) => {
    if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) enter(e.target, 0);
  });
  scope.listen(root, 'focusout', hide);
  scope.listen(root, 'pointerdown', hide);
  scope.listen(root, 'pointerleave', hide);
  scope.listen(window, 'keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  return { hide };
}

/** A square icon-only ghost button (accessible name = the tooltip). */
export function iconTool(
  scope: SceneScope,
  o: {
    icon: string;
    label: string;
    keys?: readonly string[];
    side?: TipSide;
    onClick: () => void;
    className?: string;
  },
): HTMLButtonElement {
  const b = el(
    'button',
    {
      className: `btn btn--ghost btn--icon ${o.className ?? ''}`.trim(),
      attrs: { type: 'button', 'aria-label': o.label },
    },
    [icon(o.icon)],
  );
  tip(b, o.label, o.keys ?? [], o.side);
  scope.listen(b, 'click', () => o.onClick());
  return b;
}

/** Set a toggle button's pressed state and swap its sprite (ghost when off). */
export function setPressed(
  b: HTMLButtonElement,
  on: boolean,
  onVariant: 'primary' | 'secondary' | 'danger' = 'secondary',
): void {
  b.setAttribute('aria-pressed', String(on));
  for (const v of ['ghost', 'primary', 'secondary', 'danger']) b.classList.remove(`btn--${v}`);
  b.classList.add(on ? `btn--${onVariant}` : 'btn--ghost');
}

// --- Menus -------------------------------------------------------------------------------------

export type MenuItem =
  | {
      kind: 'action';
      label: string;
      icon?: string;
      keys?: readonly string[];
      run: () => void;
      disabled?: () => boolean;
    }
  | {
      kind: 'toggle';
      label: string;
      keys?: readonly string[];
      get: () => boolean;
      set: (on: boolean) => void;
    }
  | { kind: 'heading'; label: string }
  | { kind: 'separator' }
  | { kind: 'custom'; node: HTMLElement };

export interface Menu {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  readonly open: boolean;
  setOpen(open: boolean): void;
  /** Re-read toggles and disabled states. */
  refresh(): void;
}

/** Every menu of one screen, so opening one closes the others and Escape closes them. */
export class MenuGroup {
  private readonly menus: Menu[] = [];

  add(menu: Menu): void {
    this.menus.push(menu);
  }

  closeOthers(menu: Menu): void {
    for (const m of this.menus) if (m !== menu && m.open) m.setOpen(false);
  }

  /** Close every open menu; true if one was open. */
  closeAll(): boolean {
    let closed = false;
    for (const m of this.menus) {
      if (m.open) {
        m.setOpen(false);
        closed = true;
      }
    }
    return closed;
  }

  get anyOpen(): boolean {
    return this.menus.some((m) => m.open);
  }
}

/**
 * A dropdown menu: a trigger button and a glass panel of rows. Action rows close the menu;
 * toggle rows and custom content keep it open. Closes on outside press and Escape.
 */
export function createMenu(
  scope: SceneScope,
  group: MenuGroup,
  o: {
    trigger: HTMLButtonElement;
    items: readonly MenuItem[];
    /** Which edge of the trigger the panel lines up with, and whether it opens upward. */
    align?: 'left' | 'right';
    up?: boolean;
    label: string;
  },
): Menu {
  const refreshers: (() => void)[] = [];
  const rows = o.items.map((item): HTMLElement => {
    if (item.kind === 'separator') return el('div', { className: 'divider editor-menu-sep' });
    if (item.kind === 'heading')
      return el('div', { className: 'editor-menu-heading', text: item.label });
    if (item.kind === 'custom') return item.node;
    const trailing = item.keys && item.keys.length > 0 ? [keyHint(item.keys)] : [];
    if (item.kind === 'action') {
      const b = el(
        'button',
        { className: 'row editor-menu-row', attrs: { type: 'button', role: 'menuitem' } },
        [
          item.icon ? icon(item.icon) : el('span', { className: 'editor-menu-icon-space' }),
          el('span', { className: 'editor-menu-label', text: item.label }),
          ...trailing,
        ],
      );
      scope.listen(b, 'click', () => {
        menu.setOpen(false);
        item.run();
      });
      const disabled = item.disabled;
      if (disabled) refreshers.push(() => (b.disabled = disabled()));
      return b;
    }
    const check = icon('check');
    const b = el(
      'button',
      { className: 'row editor-menu-row', attrs: { type: 'button', role: 'menuitemcheckbox' } },
      [check, el('span', { className: 'editor-menu-label', text: item.label }), ...trailing],
    );
    const sync = (): void => {
      const on = item.get();
      b.setAttribute('aria-checked', String(on));
      check.style.visibility = on ? 'visible' : 'hidden';
    };
    sync();
    refreshers.push(sync);
    scope.listen(b, 'click', () => {
      item.set(!item.get());
      sync();
    });
    return b;
  });
  const panel = el(
    'div',
    {
      className: `panel editor-solid editor-menu${o.align === 'right' ? ' is-right' : ''}${o.up ? ' is-up' : ''}`,
      attrs: { role: 'menu', 'aria-label': o.label },
    },
    rows,
  );
  panel.hidden = true;
  const root = el('div', { className: 'editor-menu-wrap' }, [o.trigger, panel]);
  o.trigger.setAttribute('aria-haspopup', 'menu');
  o.trigger.setAttribute('aria-expanded', 'false');

  const menu: Menu = {
    root,
    trigger: o.trigger,
    get open() {
      return !panel.hidden;
    },
    setOpen(open) {
      if (open) {
        group.closeOthers(menu);
        menu.refresh();
      }
      panel.hidden = !open;
      o.trigger.setAttribute('aria-expanded', String(open));
      o.trigger.classList.toggle('is-open', open);
    },
    refresh() {
      for (const r of refreshers) r();
    },
  };
  group.add(menu);
  scope.listen(o.trigger, 'click', () => menu.setOpen(!menu.open));
  scope.listen(window, 'pointerdown', (e) => {
    if (menu.open && e.target instanceof Node && !root.contains(e.target)) menu.setOpen(false);
  });
  return menu;
}

// --- Segmented control -------------------------------------------------------------------------

export interface SegmentOption<T> {
  value: T;
  label: string;
  tip: string;
  keys?: readonly string[];
  /** A small colour mark under the label (snap divisions show their grid colour). */
  color?: string;
}

export interface Segmented<T> {
  root: HTMLElement;
  set(value: T | null): void;
}

/** A row of chip buttons where one is pressed. */
export function segmented<T>(
  scope: SceneScope,
  o: {
    label: string;
    options: readonly SegmentOption<T>[];
    value: T | null;
    onChange: (v: T) => void;
  },
): Segmented<T> {
  const buttons = o.options.map((opt) => {
    const b = el(
      'button',
      { className: 'chip chip--steel editor-seg', attrs: { type: 'button' } },
      [el('span', { className: 'chip-label', text: opt.label })],
    );
    if (opt.color) {
      const mark = el('span', { className: 'editor-seg-mark', attrs: { 'aria-hidden': 'true' } });
      mark.style.setProperty('--mark', opt.color);
      b.appendChild(mark);
    }
    tip(b, opt.tip, opt.keys ?? [], 'above');
    scope.listen(b, 'click', () => o.onChange(opt.value));
    return b;
  });
  const root = el(
    'div',
    { className: 'editor-segmented', attrs: { role: 'group', 'aria-label': o.label } },
    buttons,
  );
  const set = (value: T | null): void => {
    o.options.forEach((opt, i) =>
      buttons[i]?.setAttribute('aria-pressed', String(opt.value === value)),
    );
  };
  set(o.value);
  return { root, set };
}

// --- Collapsible sections ----------------------------------------------------------------------

export interface PanelSection {
  root: HTMLElement;
  body: HTMLElement;
  /** Extra controls on the right of the header (kept outside the toggle button). */
  headerEnd: HTMLElement;
  readonly open: boolean;
  setOpen(open: boolean): void;
}

/** A panel section whose header (pixel-font title and chevron) collapses its body. */
export function collapsible(
  scope: SceneScope,
  o: {
    id: string;
    title: string;
    icon?: string;
    open: boolean;
    onToggle?: (open: boolean) => void;
  },
): PanelSection {
  const chevron = icon('chevron-down', 'editor-section-chevron');
  const toggle = el(
    'button',
    {
      className: 'editor-section-toggle ring t-label',
      attrs: { type: 'button', 'aria-controls': `editor-section-${o.id}` },
    },
    [...(o.icon ? [icon(o.icon)] : []), el('span', { text: o.title }), chevron],
  );
  const headerEnd = el('div', { className: 'editor-section-end' });
  const body = el('div', {
    className: 'editor-section-body',
    attrs: { id: `editor-section-${o.id}` },
  });
  const root = el('section', { className: 'editor-section' }, [
    el('header', { className: 'editor-section-head' }, [toggle, headerEnd]),
    body,
  ]);
  let isOpen = o.open;
  const apply = (): void => {
    body.hidden = !isOpen;
    toggle.setAttribute('aria-expanded', String(isOpen));
    root.classList.toggle('is-open', isOpen);
  };
  apply();
  const section: PanelSection = {
    root,
    body,
    headerEnd,
    get open() {
      return isOpen;
    },
    setOpen(open) {
      if (open === isOpen) return;
      isOpen = open;
      apply();
      o.onToggle?.(open);
    },
  };
  scope.listen(toggle, 'click', () => section.setOpen(!isOpen));
  return section;
}

/** A "More" disclosure: a small ghost button that shows and hides advanced controls below it. */
export function disclosure(
  scope: SceneScope,
  label: string,
  content: Node[],
): { button: HTMLButtonElement; body: HTMLElement } {
  const chevron = icon('chevron-down');
  const button = el(
    'button',
    {
      className: 'btn btn--ghost editor-more',
      attrs: { type: 'button', 'aria-expanded': 'false' },
    },
    [el('span', { className: 'btn-label', text: label }), chevron],
  );
  const body = el('div', { className: 'editor-more-body' }, content);
  body.hidden = true;
  scope.listen(button, 'click', () => {
    body.hidden = !body.hidden;
    button.setAttribute('aria-expanded', String(!body.hidden));
    button.classList.toggle('is-open', !body.hidden);
  });
  return { button, body };
}

/** A label + control row in the side panel. */
export function fieldRow(label: string, control: HTMLElement, forId?: string): HTMLElement {
  return el('label', { className: 'editor-field', attrs: forId ? { for: forId } : {} }, [
    el('span', { className: 'editor-field-label', text: label }),
    control,
  ]);
}
