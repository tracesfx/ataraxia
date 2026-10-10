/**
 * The viewport height (CSS px) the page would have outside fullscreen, used to pick the pixel
 * scales (`computePixelLayout`, the menus' `chooseArtPixel`) so that going fullscreen keeps every
 * size the player sees in a window. In a window it is simply the viewport height (and the height
 * of the browser's bars is remembered); in fullscreen (the Fullscreen API or the browser's own,
 * F11) it is the screen's available height minus those bars.
 */
const DEFAULT_CHROME_CSS = 110;
let chromeCss = DEFAULT_CHROME_CSS;

export function windowedViewportHeight(): number {
  const inner = window.innerHeight;
  const screenH = window.screen.height;
  const fullscreen = document.fullscreenElement !== null || inner >= screenH - 1;
  if (!fullscreen) {
    const bars = window.outerHeight - inner;
    // Sanity range: ignore zero (some embedded views) and odd values from docked dev tools.
    if (bars > 20 && bars < 300) chromeCss = bars;
    return inner;
  }
  const avail = window.screen.availHeight > 0 ? window.screen.availHeight : screenH;
  return Math.max(1, Math.min(inner, avail - chromeCss));
}
