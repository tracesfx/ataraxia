import type { AudioEngine } from '../audio/audioEngine';
import type { SongLibrary } from '../library/songLibrary';
import type { PixelCanvas } from '../render/pixelCanvas';
import type { Skin } from '../render/skin';
import type { Backdrop } from './backdrop';
import type { PixelGrid } from './pixel/install';
import type { SceneManager } from './sceneManager';
import type { SceneParams } from './scenes';
import type { SettingsStore } from './settingsStore';

/** Shared services handed to every scene. */
export interface App {
  pixel: PixelCanvas;
  /** Container for DOM screens, layered above the canvas. Scenes must clear what they add. */
  ui: HTMLElement;
  scenes: SceneManager<SceneParams>;
  skin: Skin;
  /** Shared audio engine; its context is created on the first user gesture. */
  audio: AudioEngine;
  /** Player settings (keys, scroll speed, offset, volumes), persisted in localStorage. */
  settings: SettingsStore;
  /** Songs and charts: the built-in demo plus everything imported (IndexedDB). */
  library: SongLibrary;
  /** The menus' pixel grid (`--px`, text sizes), following the window and the UI scale setting. */
  grid: PixelGrid;
  /** Ambient background canvas behind the menu screens (see `useBackdrop`). */
  backdrop: Backdrop;
}
