import { FONTS } from '../theme';

/**
 * The UI's pixel grid: one art pixel is a whole number of device pixels (`n`), chosen from the
 * window size and devicePixelRatio (or fixed by the "UI scale" setting). Text sizes follow from
 * `n` so that every glyph pixel of the pixel font is a whole number of device pixels too.
 */

export type UiScaleSetting = 'auto' | 1 | 2 | 3;
export const UI_SCALE_CHOICES: readonly UiScaleSetting[] = ['auto', 1, 2, 3];

/** The layout needs at least this many art pixels across before the scale is lowered. */
export const MIN_ART_WIDTH = 320;

/**
 * Device pixels per art pixel. Auto: 1 below 600 device pixels of height, 2 up to 1300 (1080p
 * gets 2), 3 up to 1800, 4 above, measured on the windowed height when it is given (so
 * fullscreen keeps the windowed size), else on the window; then lowered while the window would
 * be narrower than `MIN_ART_WIDTH` art pixels. A fixed setting
 * is used as is (never below 1).
 */
export function chooseArtPixel(
  viewportCssWidth: number,
  viewportCssHeight: number,
  devicePixelRatio: number,
  setting: UiScaleSetting = 'auto',
  windowedCssHeight: number | null = null,
): number {
  if (setting !== 'auto') return Math.max(1, Math.round(setting));
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const h = Math.max(0, viewportCssHeight * dpr);
  const w = Math.max(0, viewportCssWidth * dpr);
  const ref =
    windowedCssHeight !== null && windowedCssHeight > 0 ? Math.min(h, windowedCssHeight * dpr) : h;
  let n = ref < 600 ? 1 : ref < 1300 ? 2 : ref < 1800 ? 3 : 4;
  while (n > 1 && w / n < MIN_ART_WIDTH) n -= 1;
  return n;
}

/** Glyph pixel sizes (device pixels per font pixel) for the three pixel-font sizes. */
export interface TextLadder {
  label: number;
  title: number;
  display: number;
}

export function textLadder(n: number): TextLadder {
  switch (Math.max(1, Math.min(4, Math.round(n)))) {
    case 1:
      return { label: 1, title: 2, display: 3 };
    case 2:
      return { label: 1, title: 2, display: 4 };
    case 3:
      return { label: 2, title: 3, display: 6 };
    default:
      return { label: 2, title: 4, display: 8 };
  }
}

/** Layout class by width in art pixels (CSS reads `data-layout` on the root). */
export type LayoutClass = 'narrow' | 'medium' | 'wide';

export function layoutClass(artWidth: number): LayoutClass {
  return artWidth < 560 ? 'narrow' : artWidth < 820 ? 'medium' : 'wide';
}

/** All the CSS custom properties the pixel grid sets, in CSS pixels. */
export function scaleVariables(
  n: number,
  devicePixelRatio: number,
  viewportCssWidth: number,
): { vars: Record<string, string>; layout: LayoutClass } {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const css = (devicePx: number): string => `${+(devicePx / dpr).toFixed(4)}px`;
  const ladder = textLadder(n);
  const font = (gp: number): string => css(gp * FONTS.pixelEm);
  const line = (gp: number): string => css(gp * FONTS.pixelLine);
  const body = Math.max(13 * dpr, 7 * n);
  return {
    vars: {
      '--px': css(n),
      '--gp': css(ladder.label),
      '--fs-label': font(ladder.label),
      '--lh-label': line(ladder.label),
      '--fs-title': font(ladder.title),
      '--lh-title': line(ladder.title),
      '--fs-display': font(ladder.display),
      '--lh-display': line(ladder.display),
      '--fs-body': css(Math.round(body)),
      '--lh-body': css(Math.round(body * 1.45)),
      '--fs-small': css(Math.round(body * 0.86)),
      '--lh-small': css(Math.round(body * 0.86 * 1.45)),
    },
    layout: layoutClass((viewportCssWidth * dpr) / n),
  };
}
