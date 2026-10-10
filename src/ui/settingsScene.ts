import type { App } from './app';
import { useBackdrop } from './backdrop';
import { el } from './dom';
import type { Scene, SceneScope } from './sceneManager';
import type { SceneParams, SettingsReturn } from './scenes';
import { createSettingsPanel } from './settingsPanel';

/** Go back to wherever the settings screen was opened from. */
export function leaveSettings(app: App, returnTo: SettingsReturn): void {
  if (returnTo.scene === 'menu') void app.scenes.goTo('menu');
  else if (returnTo.scene === 'studio') void app.scenes.goTo('studio', returnTo.select);
  else void app.scenes.goTo('songSelect', returnTo.select);
}

/** Settings screen (from the main menu, song select or Studio home): the panel over the backdrop. */
export class SettingsScene implements Scene<SceneParams['settings']> {
  constructor(private readonly app: App) {}

  enter(scope: SceneScope, params: SceneParams['settings']): void {
    const { app } = this;
    const panel = createSettingsPanel(scope, app, {
      onClose: () => leaveSettings(app, params.returnTo),
      onCalibrate: () => void app.scenes.goTo('calibration', { returnTo: params.returnTo }),
    });
    const root = el('div', { className: 'screen settings-screen' }, [panel.root]);
    app.ui.appendChild(root);
    scope.onDispose(() => root.remove());
    useBackdrop(scope, app, { kind: 'gradient' });
    panel.focus();
    // Esc pressed outside the panel (focus lost by clicking the backdrop) still goes back.
    scope.listen(window, 'keydown', (e) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      leaveSettings(app, params.returnTo);
    });
  }
}
