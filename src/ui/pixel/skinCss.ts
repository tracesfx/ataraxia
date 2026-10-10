import type { UiSprite } from './sprites';

/**
 * Which sprite each component state wears. The CSS (border-image 9-slice, or a fixed background
 * image) is generated from the sprite catalog, so slice values live in one place. Order matters:
 * later rules win (idle, hover, focus, pressed, disabled).
 */
export const SKIN_RULES: readonly (readonly [selector: string, sprite: string])[] = [
  ...(['primary', 'secondary', 'ghost', 'danger'] as const).flatMap(
    (v) =>
      [
        [`.btn--${v}`, `button.${v}.idle`],
        [`.btn--${v}:hover`, `button.${v}.hover`],
        [`.btn--${v}:focus-visible, .btn--${v}.is-kbd`, `button.${v}.focus`],
        [`.btn--${v}:active, .btn--${v}.is-pressed`, `button.${v}.pressed`],
        [`.btn--${v}:disabled, .btn--${v}[aria-disabled="true"]`, `button.${v}.disabled`],
      ] as const,
  ),
  ['.panel', 'glass'],
  ['.modal', 'modal'],
  ['.tooltip', 'tooltip'],
  ['.card', 'card.idle'],
  ['.card.is-interactive:hover', 'card.hover'],
  ['.card.is-selected', 'card.selected'],
  ['.toast', 'toast.accent'],
  ['.toast--success', 'toast.success'],
  ['.toast--danger', 'toast.danger'],
  ['.field', 'field.idle'],
  ['.field:hover', 'field.hover'],
  ['.field:focus, .field:focus-within, .field.is-capturing', 'field.focus'],
  ['.field:disabled, .field.is-disabled', 'field.disabled'],
  ['.toggle-visual', 'toggle.off.idle'],
  ['.toggle:hover .toggle-visual', 'toggle.off.hover'],
  ['.toggle input:focus-visible + .toggle-visual', 'toggle.off.focus'],
  ['.toggle input:checked + .toggle-visual', 'toggle.on.idle'],
  ['.toggle:hover input:checked + .toggle-visual', 'toggle.on.hover'],
  ['.toggle input:checked:focus-visible + .toggle-visual', 'toggle.on.focus'],
  ['.toggle input:disabled + .toggle-visual', 'toggle.off.disabled'],
  ['.toggle input:disabled:checked + .toggle-visual', 'toggle.on.disabled'],
  ['.slider-track', 'slider.track'],
  ['.slider-fill', 'slider.fill'],
  ['.slider-thumb', 'slider.thumb.idle'],
  ['.slider:hover .slider-thumb', 'slider.thumb.hover'],
  ['.slider input:focus-visible ~ .slider-thumb', 'slider.thumb.focus'],
  ['.slider input:active ~ .slider-thumb', 'slider.thumb.active'],
  ['.slider input:disabled ~ .slider-thumb', 'slider.thumb.disabled'],
  ['.progress', 'progress.track'],
  ['.progress-fill', 'progress.fill'],
  ['.tabs--h .tab:hover', 'tab.h.hover'],
  ['.tabs--h .tab[aria-selected="true"]', 'tab.h.selected'],
  ['.tabs--v .tab:hover', 'tab.v.hover'],
  ['.tabs--v .tab[aria-selected="true"]', 'tab.v.selected'],
  ...(['steel', 'accent', 'success', 'warning', 'danger'] as const).flatMap(
    (t) =>
      [
        [`.chip--${t}`, `chip.${t}`],
        [`.chip--${t}.is-selected, .chip--${t}[aria-pressed="true"]`, `chip.${t}.selected`],
      ] as const,
  ),
  ['.row:hover', 'row.hover'],
  ['.row.is-selected, .row[aria-selected="true"]', 'row.selected'],
  ['.kbd', 'keycap'],
  ['.divider', 'divider'],
  ['.ring:focus-visible::before, .ring.is-kbd::before, .ring:has(:focus-visible)::before', 'focus'],
  ['.cover::after', 'cover.frame'],
  ['::-webkit-scrollbar-thumb', 'scrollbar.idle'],
  ['::-webkit-scrollbar-thumb:hover', 'scrollbar.hover'],
];

const px = (n: number): string => (n === 0 ? '0' : `calc(var(--px) * ${n})`);

/** The CSS declarations that make an element wear `sprite`. */
export function spriteDeclarations(sprite: UiSprite, url: string): string {
  if (!sprite.slice) {
    return [
      `background-image:url("${url}")`,
      'background-repeat:no-repeat',
      `background-size:${px(sprite.bitmap.w)} ${px(sprite.bitmap.h)}`,
    ].join(';');
  }
  const [t, r, b, l] = sprite.slice;
  return [
    `border-image-source:url("${url}")`,
    `border-image-slice:${t} ${r} ${b} ${l} fill`,
    `border-image-width:${px(t)} ${px(r)} ${px(b)} ${px(l)}`,
    `border-image-outset:${px(sprite.outset)}`,
    'border-image-repeat:stretch',
  ].join(';');
}

/** The full generated stylesheet. `urlOf` turns a sprite into a (data) URL. */
export function skinStylesheet(
  sprites: ReadonlyMap<string, UiSprite>,
  urlOf: (sprite: UiSprite) => string,
): string {
  const urls = new Map<string, string>();
  const out: string[] = [];
  for (const [selector, name] of SKIN_RULES) {
    const sprite = sprites.get(name);
    if (!sprite) throw new Error(`Unknown UI sprite "${name}" for ${selector}.`);
    let url = urls.get(name);
    if (url === undefined) {
      url = urlOf(sprite);
      urls.set(name, url);
    }
    out.push(`${selector}{${spriteDeclarations(sprite, url)}}`);
  }
  const sheen = sprites.get('sheen');
  if (sheen) {
    out.push(
      `:root{--sheen:url("${urlOf(sheen)}");--sheen-w:${sheen.bitmap.w};--sheen-h:${sheen.bitmap.h}}`,
    );
  }
  return out.join('\n');
}
