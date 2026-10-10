import type { CoverRef } from '../library/songLibrary';
import { coverFullUrl, coverThumbUrl } from './coverImages';
import { capText, keyCaps, type KeyCap } from './keyHints';
import { el } from './dom';
import { coverUrl, iconUrl, logoUrl } from './pixel/render';
import { logoBitmap, type LogoVariant } from './pixel/logo';
import type { SceneScope } from './sceneManager';
import { GAME_TITLE } from '../core/constants';
import type { Tone } from './theme';

/**
 * DOM components of the design system. Real elements (button, input, select, dialog) wear the
 * generated pixel art through CSS classes (see src/ui/pixel/skinCss.ts and src/style.css), so
 * focus, keyboard use, accessibility and text selection stay native. Listeners go through the
 * scene's scope.
 */

// --- Icons and key caps -----------------------------------------------------------------------

/** A 16x16 pixel icon painted in the current text colour. */
export function icon(name: string, className = ''): HTMLElement {
  const node = el('span', {
    className: `icon ${className}`.trim(),
    attrs: { 'aria-hidden': 'true', 'data-icon': name },
  });
  const url = iconUrl(name);
  if (url) node.style.setProperty('--icon', `url("${url}")`);
  return node;
}

export function keyCapElement(cap: KeyCap): HTMLElement {
  return 'icon' in cap
    ? el('kbd', { className: 'kbd is-icon', attrs: { 'aria-label': capText(cap) } }, [
        icon(cap.icon),
      ])
    : el('kbd', { className: 'kbd', text: cap.text });
}

/**
 * Key caps for one or more keys ("Enter", "Ctrl+O", lane codes), optionally followed by what
 * they do: [enter] Play.
 */
export function keyHint(keys: string | readonly string[], action?: string): HTMLElement {
  const list = typeof keys === 'string' ? [keys] : keys;
  const caps: Node[] = [];
  list.forEach((combo, i) => {
    if (i > 0) caps.push(el('span', { className: 'keyhint-sep', text: '/' }));
    caps.push(...keyCaps(combo).map(keyCapElement));
  });
  return el('span', { className: 'keyhint' }, [
    el('span', { className: 'keyhint-caps' }, caps),
    ...(action ? [el('span', { className: 'keyhint-action', text: action })] : []),
  ]);
}

/** A row of key hints for a screen footer. */
export function hintBar(hints: readonly (readonly [keys: string | string[], action: string])[]) {
  return el(
    'footer',
    { className: 'hint-bar', attrs: { 'aria-label': 'Keyboard shortcuts' } },
    hints.map(([k, a]) => keyHint(k, a)),
  );
}

// --- Buttons -----------------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonOptions {
  label: string;
  variant?: ButtonVariant;
  icon?: string;
  /** Key shown as a cap at the end of the button ("Enter", "R"). Purely a hint. */
  hint?: string;
  size?: 'md' | 'lg';
  /** Fill the width of the container (labels stay left-aligned). */
  block?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}

export function button(scope: SceneScope, o: ButtonOptions): HTMLButtonElement {
  const classes = ['btn', `btn--${o.variant ?? 'secondary'}`];
  if (o.size === 'lg') classes.push('btn--lg');
  if (o.block) classes.push('btn--block');
  const b = el('button', { className: classes.join(' '), attrs: { type: 'button' } }, [
    ...(o.icon ? [icon(o.icon)] : []),
    el('span', { className: 'btn-label', text: o.label }),
    ...(o.hint ? [el('span', { className: 'btn-hint' }, keyCaps(o.hint).map(keyCapElement))] : []),
  ]);
  if (o.title) b.title = o.title;
  b.disabled = o.disabled ?? false;
  const onClick = o.onClick;
  if (onClick) scope.listen(b, 'click', () => onClick());
  return b;
}

/** Square icon-only button; `label` is its accessible name and tooltip. */
export function iconButton(
  scope: SceneScope,
  o: { icon: string; label: string; variant?: ButtonVariant; onClick: () => void },
): HTMLButtonElement {
  const b = el(
    'button',
    {
      className: `btn btn--${o.variant ?? 'ghost'} btn--icon has-tip`,
      attrs: { type: 'button', 'aria-label': o.label },
    },
    [icon(o.icon), el('span', { className: 'tooltip', text: o.label, attrs: { role: 'tooltip' } })],
  );
  scope.listen(b, 'click', () => o.onClick());
  return b;
}

// --- Form controls -----------------------------------------------------------------------------

export interface Toggle {
  root: HTMLElement;
  input: HTMLInputElement;
  set(checked: boolean): void;
}

/** On/off switch (a real checkbox underneath). */
export function toggle(
  scope: SceneScope,
  o: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean },
): Toggle {
  const input = el('input', {
    attrs: { type: 'checkbox', role: 'switch', 'aria-label': o.label },
  });
  input.checked = o.checked;
  input.disabled = o.disabled ?? false;
  scope.listen(input, 'change', () => o.onChange(input.checked));
  const root = el('label', { className: 'toggle' }, [
    input,
    el('span', { className: 'toggle-visual', attrs: { 'aria-hidden': 'true' } }),
  ]);
  return {
    root,
    input,
    set(checked) {
      input.checked = checked;
    },
  };
}

export interface Slider {
  root: HTMLElement;
  input: HTMLInputElement;
  set(value: number): void;
}

/**
 * Range slider with its value shown next to it. A native range input (transparent, on top)
 * does the work; the track, fill and thumb are pixel art that follow its value.
 */
export function slider(
  scope: SceneScope,
  o: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format: (v: number) => string;
    onInput: (v: number) => void;
  },
): Slider {
  const input = el('input', {
    attrs: {
      type: 'range',
      min: String(o.min),
      max: String(o.max),
      step: String(o.step),
      'aria-label': o.label,
    },
  });
  const value = el('output', { className: 'slider-value t-label tabular' });
  const root = el('div', { className: 'slider' }, [
    el('div', { className: 'slider-rail' }, [
      el('span', { className: 'slider-track', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'slider-fill', attrs: { 'aria-hidden': 'true' } }),
      input,
      el('span', { className: 'slider-thumb', attrs: { 'aria-hidden': 'true' } }),
    ]),
    value,
  ]);
  const show = (v: number): void => {
    const f = o.max === o.min ? 0 : (v - o.min) / (o.max - o.min);
    root.style.setProperty('--fraction', String(Math.min(1, Math.max(0, f))));
    value.textContent = o.format(v);
    input.setAttribute('aria-valuetext', o.format(v));
  };
  scope.listen(input, 'input', () => {
    const v = Number(input.value);
    show(v);
    o.onInput(v);
  });
  const set = (v: number): void => {
    input.value = String(v);
    show(v);
  };
  set(o.value);
  return { root, input, set };
}

/** A styled native select. */
export function select<T extends string | number>(
  scope: SceneScope,
  o: {
    label: string;
    options: readonly { value: T; label: string }[];
    value: T;
    onChange: (v: T) => void;
  },
): { root: HTMLElement; select: HTMLSelectElement; set(v: T): void } {
  const node = el(
    'select',
    { className: 'select-input', attrs: { 'aria-label': o.label } },
    o.options.map((opt) => el('option', { text: opt.label, attrs: { value: String(opt.value) } })),
  );
  const set = (v: T): void => {
    node.value = String(v);
  };
  set(o.value);
  scope.listen(node, 'change', () => {
    const found = o.options.find((opt) => String(opt.value) === node.value);
    if (found) o.onChange(found.value);
  });
  const root = el('span', { className: 'field select' }, [
    node,
    icon('chevron-down', 'select-chevron'),
  ]);
  return { root, select: node, set };
}

/** Text input in a field frame, with an optional leading icon. */
export function textField(
  scope: SceneScope,
  o: {
    label: string;
    value?: string;
    placeholder?: string;
    icon?: string;
    onInput?: (v: string) => void;
    attrs?: Record<string, string>;
  },
): { root: HTMLElement; input: HTMLInputElement } {
  const input = el('input', {
    className: 'field-input',
    attrs: {
      type: 'text',
      'aria-label': o.label,
      spellcheck: 'false',
      autocomplete: 'off',
      ...(o.placeholder ? { placeholder: o.placeholder } : {}),
      ...(o.attrs ?? {}),
    },
  });
  input.value = o.value ?? '';
  const onInput = o.onInput;
  if (onInput) scope.listen(input, 'input', () => onInput(input.value));
  const root = el('span', { className: 'field field--text' }, [
    ...(o.icon ? [icon(o.icon, 'field-icon')] : []),
    input,
  ]);
  return { root, input };
}

// --- Tabs, chips, rows, cards ------------------------------------------------------------------

export interface TabItem {
  id: string;
  label: string;
  icon?: string;
}

/**
 * Tab list with a roving tab index: arrows move between tabs and select them, Home/End jump.
 * `onSelect` runs for every change (also from the keyboard).
 */
export function tabs(
  scope: SceneScope,
  o: {
    label: string;
    orientation: 'h' | 'v';
    items: readonly TabItem[];
    selected: string;
    onSelect: (id: string) => void;
  },
): { root: HTMLElement; select(id: string, focus?: boolean): void; buttons: HTMLButtonElement[] } {
  const buttons = o.items.map((item) =>
    el(
      'button',
      {
        className: 'tab ring',
        attrs: {
          type: 'button',
          role: 'tab',
          id: `tab-${item.id}`,
          'aria-controls': `panel-${item.id}`,
        },
      },
      [...(item.icon ? [icon(item.icon)] : []), el('span', { text: item.label })],
    ),
  );
  const root = el(
    'div',
    {
      className: `tabs tabs--${o.orientation}`,
      attrs: {
        role: 'tablist',
        'aria-label': o.label,
        'aria-orientation': o.orientation === 'h' ? 'horizontal' : 'vertical',
      },
    },
    buttons,
  );
  let current = o.selected;
  const select = (id: string, focus = false): void => {
    current = id;
    buttons.forEach((b, i) => {
      const on = o.items[i]?.id === id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
  };
  buttons.forEach((b, i) => {
    scope.listen(b, 'click', () => {
      const id = o.items[i]?.id;
      if (id && id !== current) {
        select(id);
        o.onSelect(id);
      }
    });
  });
  scope.listen(root, 'keydown', (e) => {
    const back = o.orientation === 'h' ? 'ArrowLeft' : 'ArrowUp';
    const next = o.orientation === 'h' ? 'ArrowRight' : 'ArrowDown';
    const i = o.items.findIndex((t) => t.id === current);
    let j = -1;
    if (e.key === back) j = (i - 1 + o.items.length) % o.items.length;
    else if (e.key === next) j = (i + 1) % o.items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = o.items.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const id = o.items[j]?.id;
    if (!id) return;
    select(id, true);
    o.onSelect(id);
  });
  select(o.selected);
  return { root, select, buttons };
}

/** A small label in a tone. `level` chips show a number in front. */
export function chip(o: {
  label: string;
  tone?: Tone;
  lead?: string;
  className?: string;
}): HTMLElement {
  return el('span', { className: `chip chip--${o.tone ?? 'steel'} ${o.className ?? ''}`.trim() }, [
    ...(o.lead ? [el('span', { className: 'chip-lead tabular', text: o.lead })] : []),
    el('span', { className: 'chip-label', text: o.label }),
  ]);
}

export function card(children: Node[], className = ''): HTMLElement {
  return el('div', { className: `card ${className}`.trim() }, children);
}

export function divider(): HTMLElement {
  return el('div', { className: 'divider', attrs: { role: 'separator' } });
}

// --- Feedback ----------------------------------------------------------------------------------

export interface ProgressBar {
  root: HTMLElement;
  set(fraction: number): void;
}

export function progressBar(label: string): ProgressBar {
  const fill = el('span', { className: 'progress-fill' });
  const root = el(
    'div',
    {
      className: 'progress',
      attrs: {
        role: 'progressbar',
        'aria-label': label,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
      },
    },
    [fill],
  );
  return {
    root,
    set(fraction) {
      const f = Math.min(1, Math.max(0, fraction));
      root.style.setProperty('--fraction', String(f));
      root.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    },
  };
}

export type ToastTone = 'accent' | 'success' | 'warning' | 'danger';

export interface Toaster {
  show(text: string, tone?: ToastTone, durationMs?: number): void;
  clear(): void;
}

/**
 * Toast notifications for a scene: short messages that stack at the bottom centre and leave on
 * their own. Screen readers hear them through a polite live region.
 */
export function toaster(scope: SceneScope, host: HTMLElement): Toaster {
  const region = el('div', {
    className: 'toasts',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  host.appendChild(region);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  scope.onDispose(() => {
    for (const t of timers) clearTimeout(t);
    region.remove();
  });
  const dismiss = (node: HTMLElement): void => {
    node.classList.add('is-leaving');
    const t = setTimeout(() => {
      timers.delete(t);
      node.remove();
    }, 160);
    timers.add(t);
  };
  return {
    show(text, tone = 'accent', durationMs) {
      if (!text) return;
      const node = el('div', { className: `toast toast--${tone}` }, [
        icon(
          tone === 'danger' || tone === 'warning' ? 'alert' : tone === 'success' ? 'check' : 'info',
        ),
        el('span', { className: 'toast-text', text }),
      ]);
      region.appendChild(node);
      while (region.children.length > 3) region.firstElementChild?.remove();
      const ms = durationMs ?? Math.min(9000, 2600 + text.length * 45);
      const t = setTimeout(() => {
        timers.delete(t);
        dismiss(node);
      }, ms);
      timers.add(t);
    },
    clear() {
      region.replaceChildren();
    },
  };
}

// --- Covers and logo ---------------------------------------------------------------------------

export type CoverSize = 'thumb' | 'medium' | 'large';
const COVER_PX: Record<CoverSize, number> = { thumb: 24, medium: 48, large: 96 };

/** What a cover is drawn from: a song's title (placeholder) and its custom cover, if any. */
export interface CoverSource {
  title: string;
  cover?: CoverRef | null;
}

/** The generated placeholder's parts: ramp-banded pixel tile plus the title's first letter. */
function placeholderParts(title: string, size: CoverSize): HTMLElement[] {
  const letter = [...title.trim()][0]?.toUpperCase() ?? '?';
  return [
    el('img', {
      className: 'cover-img',
      attrs: { src: coverUrl(title, COVER_PX[size]), alt: '', draggable: 'false' },
    }),
    el('span', { className: 'cover-letter', text: letter }),
  ];
}

/**
 * Square cover art inside the pixel cover frame (cut corners, steel border). A custom cover is a
 * smoothly scaled picture (never pixelated): the 128 px thumbnail at thumb size, the 512 px image
 * otherwise. Without one (or if it fails to load) it shows the generated placeholder: ramp bands
 * from the title's hash and the title's first letter.
 */
export function coverArt(source: CoverSource, size: CoverSize): HTMLElement {
  const node = el('div', { className: `cover cover--${size}`, attrs: { 'aria-hidden': 'true' } });
  const cover = source.cover;
  if (!cover) {
    node.append(...placeholderParts(source.title, size));
    return node;
  }
  const img = el('img', {
    className: 'cover-img cover-photo',
    attrs: {
      src: size === 'thumb' ? coverThumbUrl(cover) : coverFullUrl(cover),
      alt: '',
      draggable: 'false',
      decoding: 'async',
    },
  });
  // A property handler, not a listener: it lives and dies with this element.
  img.onerror = () => {
    img.onerror = null;
    node.classList.remove('has-photo');
    node.replaceChildren(...placeholderParts(source.title, size));
  };
  node.classList.add('has-photo');
  node.append(img);
  return node;
}

/**
 * A compact song card: cover thumbnail, title and artist (pause menu, results, gameplay HUD).
 */
export function songCard(
  song: CoverSource & { artist: string },
  o: { className?: string; extra?: Node[] } = {},
): HTMLElement {
  return el('div', { className: `song-card ${o.className ?? ''}`.trim() }, [
    coverArt(song, 'thumb'),
    el('span', { className: 'song-card-text' }, [
      el('span', { className: 'song-card-title t-label', text: song.title }),
      el('span', { className: 'song-card-artist', text: song.artist || 'Unknown artist' }),
    ]),
    ...(o.extra ?? []),
  ]);
}

/** The logo image (art-pixel sized). `shine` plays one stepped sweep across it. */
export function logo(variant: LogoVariant, o: { shine?: boolean } = {}): HTMLElement {
  const bmp = logoBitmap(variant);
  const url = logoUrl(variant);
  const node = el(
    'span',
    {
      className: `logo logo--${variant}${o.shine ? ' has-shine' : ''}`,
      attrs: { role: 'img', 'aria-label': GAME_TITLE },
    },
    [el('img', { attrs: { src: url, alt: '', draggable: 'false' } })],
  );
  node.style.setProperty('--logo-w', String(bmp.w));
  node.style.setProperty('--logo-h', String(bmp.h));
  node.style.setProperty('--logo-mask', `url("${url}")`);
  return node;
}

// --- Screen frame ------------------------------------------------------------------------------

/**
 * The common screen layout: a header (back button, title, extra controls), a body and a footer
 * of key hints. Returns the parts so scenes can fill them.
 */
export function screenFrame(o: {
  className: string;
  title: string;
  headerLead?: Node[];
  headerEnd?: Node[];
  body: Node[];
  hints?: readonly (readonly [string | string[], string])[];
}): HTMLElement {
  return el('div', { className: `screen ${o.className}` }, [
    el('header', { className: 'screen-header' }, [
      ...(o.headerLead ?? []),
      el('h1', { className: 'screen-title t-title', text: o.title }),
      el('div', { className: 'screen-header-end' }, o.headerEnd ?? []),
    ]),
    el('main', { className: 'screen-body' }, o.body),
    ...(o.hints ? [hintBar(o.hints)] : []),
  ]);
}

/** Up/Down arrow focus movement through a list of elements (wraps around). */
export function moveFocus(e: KeyboardEvent, items: readonly HTMLElement[]): boolean {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const step = e.key === 'ArrowDown' ? 1 : -1;
  const next = i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length;
  items[next]?.focus();
  return true;
}
