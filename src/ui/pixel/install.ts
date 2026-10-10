import '@fontsource/jersey-10/latin.css';
import '@fontsource-variable/inter/index.css';
import type { SettingsStore } from '../settingsStore';
import { applyThemeToCss } from '../theme';
import { bitmapToDataUrl } from './render';
import { windowedViewportHeight } from '../../render/windowedHeight';
import { chooseArtPixel, scaleVariables, type LayoutClass } from './scale';
import { skinStylesheet } from './skinCss';
import { buildUiSprites } from './sprites';

/** The live pixel grid of the menus. */
export interface PixelGrid {
  /** Device pixels per art pixel. */
  readonly artPixel: number;
  readonly layout: LayoutClass;
  /** Called after every change of the grid (resize, DPR change, UI scale setting). */
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

/**
 * Install the design system: theme CSS variables, the generated sprite stylesheet (built once,
 * from the palette), and the pixel grid (`--px` and the text sizes), which follows the window
 * size, devicePixelRatio and the "UI scale" setting.
 */
export function installPixelUi(settings: SettingsStore): PixelGrid {
  const root = document.documentElement;
  applyThemeToCss(root);

  const style = document.createElement('style');
  style.dataset.generated = 'ui-sprites';
  style.textContent = skinStylesheet(buildUiSprites(), (s) => bitmapToDataUrl(s.bitmap));
  document.head.appendChild(style);

  const listeners = new Set<() => void>();
  let artPixel = 1;
  let layout: LayoutClass = 'wide';
  let dprQuery: MediaQueryList | null = null;

  const update = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    artPixel = chooseArtPixel(w, h, dpr, settings.value.uiScale, windowedViewportHeight());
    const scaled = scaleVariables(artPixel, dpr, w);
    layout = scaled.layout;
    for (const [k, v] of Object.entries(scaled.vars)) root.style.setProperty(k, v);
    root.dataset.layout = layout;
    root.dataset.px = String(artPixel);
    watchDpr(dpr);
    for (const fn of listeners) fn();
  };

  // `resize` does not always fire when DPR changes (moving between monitors), so watch it.
  const watchDpr = (dpr: number): void => {
    dprQuery?.removeEventListener('change', update);
    dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    dprQuery.addEventListener('change', update);
  };

  let lastScale = settings.value.uiScale;
  const unsubscribe = settings.subscribe((s) => {
    if (s.uiScale !== lastScale) {
      lastScale = s.uiScale;
      update();
    }
  });
  window.addEventListener('resize', update);
  update();

  return {
    get artPixel() {
      return artPixel;
    },
    get layout() {
      return layout;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      unsubscribe();
      window.removeEventListener('resize', update);
      dprQuery?.removeEventListener('change', update);
      style.remove();
    },
  };
}
