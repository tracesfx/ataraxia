import type { App } from '../ui/app';
import { EditorScene } from './editor/editorScene';
import { registerStudioIcons } from './studioIcons';
import { StudioHomeScene } from './studioHomeScene';
import { StudioLibrary } from './studioLibrary';

/**
 * Marker string that only the Studio build contains. scripts/verify-player-build.mjs fails the
 * player build if it appears in dist/. Keep it unique and keep it referenced below.
 */
export const STUDIO_MARKER = 'ataraxia-studio-build';

/**
 * Add the Studio to a booted app: Studio home (`studio`) and the chart editor (`editor`) scenes,
 * sharing one StudioLibrary. Loaded only through src/app/studio-entry.ts, behind `__STUDIO__`.
 */
export function installStudio(app: App): void {
  registerStudioIcons();
  const studioLibrary = new StudioLibrary(app.library);
  app.scenes.register('studio', () => new StudioHomeScene(app, studioLibrary));
  app.scenes.register('editor', () => new EditorScene(app, studioLibrary));
  document.documentElement.dataset.build = STUDIO_MARKER;
}
