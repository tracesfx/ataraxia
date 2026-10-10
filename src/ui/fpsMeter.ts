import type { SettingsStore } from './settingsStore';

/** Frames drawn by paced frame loops (gameplay) since the meter last read them. */
let renderedFrames = 0;

/**
 * A paced frame loop drew a frame. While these arrive the meter shows them (the frames actually
 * drawn, which a frame-rate limit can make fewer or more than the display refreshes).
 */
export function countRenderedFrame(): void {
  renderedFrames += 1;
}

/**
 * The "Show FPS" counter: a small label in the top-right corner, on every screen, while the
 * setting is on. An app-level service (like the pixel canvas), so it runs its own frame loop,
 * only while enabled.
 */
export function installFpsMeter(host: HTMLElement, settings: SettingsStore): () => void {
  const label = document.createElement('div');
  label.className = 'fps-meter t-label';
  label.setAttribute('aria-hidden', 'true');
  host.appendChild(label);
  let handle = 0;
  let frames = 0;
  let since = 0;

  const tick = (ts: number): void => {
    frames += 1;
    if (since === 0) {
      since = ts;
      renderedFrames = 0;
    }
    if (ts - since >= 500) {
      const count = renderedFrames > 0 ? renderedFrames : frames;
      label.textContent = `${Math.round((count * 1000) / (ts - since))} fps`;
      frames = 0;
      renderedFrames = 0;
      since = ts;
    }
    handle = requestAnimationFrame(tick);
  };

  const apply = (): void => {
    const on = settings.value.showFps;
    label.hidden = !on;
    if (on && handle === 0) {
      frames = 0;
      since = 0;
      label.textContent = '-- fps';
      handle = requestAnimationFrame(tick);
    } else if (!on && handle !== 0) {
      cancelAnimationFrame(handle);
      handle = 0;
    }
  };
  const unsubscribe = settings.subscribe(apply);
  apply();
  return () => {
    unsubscribe();
    cancelAnimationFrame(handle);
    label.remove();
  };
}
