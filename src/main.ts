import './style.css';
import { AudioEngine } from './audio/audioEngine';
import { GAME_TITLE, STUDIO_TITLE } from './core/constants';
import { GameScene } from './game/gameScene';
import { openLibraryDb } from './library/db';
import { LibraryRepository } from './library/repository';
import { SongLibrary } from './library/songLibrary';
import { PixelCanvas } from './render/pixelCanvas';
import { createDefaultSkin } from './skins/default';
import type { App } from './ui/app';
import { MainMenuScene } from './ui/mainMenuScene';
import { Backdrop } from './ui/backdrop';
import { installFpsMeter } from './ui/fpsMeter';
import { installPixelUi } from './ui/pixel/install';
import { SceneManager } from './ui/sceneManager';
import { SettingsStore } from './ui/settingsStore';
import type { SceneParams } from './ui/scenes';
import { SongSelectScene } from './ui/songSelectScene';
import { CalibrationScene } from './ui/calibrationScene';
import { ResultsScene } from './ui/resultsScene';
import { SettingsScene } from './ui/settingsScene';

/**
 * Open the song library. If IndexedDB is unavailable (some private-browsing modes), the game
 * still runs with the built-in demo and the song select screen explains why imports fail.
 */
async function openLibrary(audio: AudioEngine): Promise<SongLibrary> {
  // Ask the browser not to evict the library when storage runs low. It may say no (or ask the
  // user); the library still works, it just isn't guaranteed to survive storage pressure.
  if (navigator.storage?.persist) {
    navigator.storage.persist().then(
      (granted) => {
        if (!granted)
          console.info(
            'Persistent storage was not granted; the browser may evict songs under storage pressure.',
          );
      },
      (err: unknown) => console.warn('navigator.storage.persist() failed:', err),
    );
  }
  try {
    return new SongLibrary(new LibraryRepository(await openLibraryDb()), audio);
  } catch (err) {
    console.error('Opening the song library failed:', err);
    return new SongLibrary(
      null,
      audio,
      'The song library could not be opened, so songs cannot be imported or saved. Your browser may be blocking storage (for example in a private window). Allow site data and reload the page.',
    );
  }
}

async function boot(): Promise<void> {
  document.title = __STUDIO__ ? STUDIO_TITLE : GAME_TITLE;
  const root = document.getElementById('app');
  if (!root) throw new Error('#app element missing from index.html');

  const stage = document.createElement('div');
  stage.className = 'stage';
  const ui = document.createElement('div');
  ui.className = 'ui-layer';
  root.append(stage, ui);
  const audio = new AudioEngine();
  const settings = new SettingsStore();
  // The menus' pixel UI loads the Jersey 10 font the skin's glyph atlases are rasterised from.
  const grid = installPixelUi(settings);
  const [skin, library] = await Promise.all([createDefaultSkin(), openLibrary(audio)]);
  const backdrop = new Backdrop(ui, grid);
  const removeFps = installFpsMeter(root, settings);
  // Master and music volume apply everywhere (the editor mixes music its own way while open and
  // restores this on exit); the hit sound volume is applied by the game per click.
  const applyVolumes = (): void => {
    audio.setVolume(settings.value.masterVolume);
    audio.setMusicVolume(settings.value.musicVolume);
  };
  applyVolumes();
  settings.subscribe(applyVolumes);

  const pixel = new PixelCanvas(stage);
  pixel.edgeColor = skin.colors.background;
  const app: App = {
    pixel,
    ui,
    scenes: new SceneManager<SceneParams>(),
    skin,
    audio,
    settings,
    library,
    grid,
    backdrop,
  };
  app.scenes.register('menu', () => new MainMenuScene(app));
  app.scenes.register('songSelect', () => new SongSelectScene(app));
  app.scenes.register('game', () => new GameScene(app));
  app.scenes.register('settings', () => new SettingsScene(app));
  app.scenes.register('calibration', () => new CalibrationScene(app));
  app.scenes.register('results', () => new ResultsScene(app));
  if (__STUDIO__) {
    // Studio build only: the editor and creation tools. Dead code in the player build, so the
    // dynamic import (and everything in src/studio) is left out of its bundle.
    const { installStudio } = await import('./app/studio-entry');
    installStudio(app);
  }
  void app.scenes.goTo('menu');
  // Dev server only: lets `npm run screenshots` open any screen directly.
  if (import.meta.env.DEV) Object.assign(window, { __ataraxia: app });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      app.scenes.shutdown();
      void app.audio.close();
      app.pixel.destroy();
      removeFps();
      grid.dispose();
      stage.remove();
      ui.remove();
    });
  }
}

void boot();
