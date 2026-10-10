import { AudioAnalyzer } from '../audio/audioAnalysis';
import {
  activeEmitters,
  defaultBackgroundConfig,
  sanitizeBackgroundConfig,
  seedFromText,
  type BackgroundConfig,
} from '../core/background/config';
import {
  CUSTOM_SPRITE_PREFIX,
  defaultEmitter,
  emitterFromTemplate,
} from '../core/background/emitter';
import {
  resolveBackground,
  type PictureSource,
  type ResolvedBackground,
} from '../core/background/precedence';
import type { Settings } from '../core/settings';
import { pictureFor, type SongBackground } from '../library/songLibrary';
import type { ParticleSpriteRecord } from '../library/records';
import { BackgroundManager, type BackdropHost } from '../render/background/manager';
import { decodePicture, makeCanvas, type AnySource } from '../render/background/pictures';
import type { App } from '../ui/app';
import type { SceneScope } from '../ui/sceneManager';
import { RAMPS } from '../ui/theme';

/**
 * The gameplay background for one song: resolves which background to show (the player's choice,
 * then the song's own, then its cover), decodes the base picture and the custom sprites the
 * emitters use once, follows the player's Display settings, and runs the audio analysis in a
 * worker if the particles follow the music and the song doesn't have one cached yet (they follow
 * the beat grid until it is ready; the result is cached in IndexedDB for next time, also for songs
 * imported from packages in the player). Everything is cleaned up with the scene.
 */
export interface GameBackground {
  readonly manager: BackgroundManager;
  /** The chart's timing (the beat grid), once loaded. */
  setTiming(bpm: number, offsetMs: number): void;
  /** The decoded song: start (or load) its analysis if the background needs it. */
  setAudio(buffer: AudioBuffer): void;
}

const reducedMotionQuery = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Expected frame interval for the frame rate setting. */
function frameMsFor(limit: Settings['frameRateLimit']): number {
  return typeof limit === 'number' ? 1000 / limit : 1000 / 60;
}

// For `npm run screenshots`: build configs in the page (dev only).
if (import.meta.env.DEV) {
  Object.assign(window, {
    __ataraxiaBackgroundTools: { defaultBackgroundConfig, defaultEmitter, emitterFromTemplate },
  });
}

/** The manager with the game's defaults (skin layer while loading, theme ramps, pixel canvas). */
export function createBackgroundManager(app: App, host: BackdropHost | null): BackgroundManager {
  return new BackgroundManager({
    fallback: app.skin.createBackground(),
    ramps: RAMPS,
    overlay: RAMPS.steel[0],
    host,
    createCanvas: makeCanvas,
  });
}

/** Display settings -> manager options. */
export function backgroundOptions(s: Readonly<Settings>) {
  return {
    dim: s.backgroundDim,
    reduceMotion: s.backgroundReduceMotion || reducedMotionQuery(),
    quality: s.backgroundQuality,
    frameMs: frameMsFor(s.frameRateLimit),
  };
}

/** Do the particles follow the music (so the analysis is worth computing)? */
export function needsAnalysis(c: BackgroundConfig): boolean {
  return activeEmitters(c).some((e) => e.emission === 'impact' || e.reactivity > 0);
}

/** Decoded custom sprites used by a config's emitters (missing or broken ones are skipped). */
export async function decodeSprites(
  config: BackgroundConfig,
  sprites: readonly ParticleSpriteRecord[],
): Promise<Map<string, ImageBitmap>> {
  const used = new Set(
    activeEmitters(config)
      .map((e) => e.sprite)
      .filter((s) => s.startsWith(CUSTOM_SPRITE_PREFIX))
      .map((s) => s.slice(CUSTOM_SPRITE_PREFIX.length)),
  );
  const out = new Map<string, ImageBitmap>();
  for (const s of sprites) {
    if (!used.has(s.id)) continue;
    try {
      out.set(s.id, await decodePicture(s.blob));
    } catch (err) {
      console.warn(`The custom sprite "${s.name}" could not be decoded; it is not shown.`, err);
    }
  }
  return out;
}

export function createGameBackground(scope: SceneScope, app: App, songId: string): GameBackground {
  const manager = createBackgroundManager(app, app.pixel);
  scope.onDispose(() => manager.dispose());
  manager.setSong(seedFromText(songId), { bpm: 120, offsetMs: 0 });

  let song: SongBackground = { config: null, images: [], sprites: [], cover: null };
  let playerImage: Blob | null = null;
  let loaded = false;
  let resolved: ResolvedBackground | null = null;
  let analyzer: AudioAnalyzer | null = null;
  let buffer: AudioBuffer | null = null;
  const pictures = new Map<string, Promise<ImageBitmap | null>>();
  const bitmaps: ImageBitmap[] = [];
  let spritesKey = '';
  let applying = 0;

  scope.onDispose(() => {
    analyzer?.dispose();
    for (const b of bitmaps) b.close();
  });

  const blobOf = (source: PictureSource, config: BackgroundConfig): Blob | null =>
    source === 'player'
      ? playerImage
      : source === 'song'
        ? (pictureFor(config, song.images)?.blob ?? null)
        : song.cover;

  const decoded = (key: string, blob: Blob | null): Promise<ImageBitmap | null> => {
    const have = pictures.get(key);
    if (have) return have;
    const job = blob
      ? decodePicture(blob).then(
          (bitmap) => {
            bitmaps.push(bitmap);
            return bitmap;
          },
          (err: unknown) => {
            console.warn('A background picture could not be decoded; using the default.', err);
            return null;
          },
        )
      : Promise.resolve(null);
    pictures.set(key, job);
    return job;
  };

  const startAnalysis = (): void => {
    if (analyzer || !buffer || !resolved || !needsAnalysis(resolved.config)) return;
    const a = new AudioAnalyzer(buffer, app.library.analysisCache(songId));
    analyzer = a;
    a.run().then(
      (analysis) => {
        if (!scope.disposed) manager.setAnalysis(analysis);
      },
      (err: unknown) => {
        if (scope.disposed) return;
        console.warn(
          'The audio analysis for the background failed; particles follow the beat grid only.',
          err,
        );
      },
    );
  };

  /** A dev-only override for `npm run screenshots` (a full config, base picture from the player). */
  const devOverride = (): BackgroundConfig | null => {
    if (!import.meta.env.DEV) return null;
    const raw = (window as unknown as { __ataraxiaBackgroundOverride?: unknown })
      .__ataraxiaBackgroundOverride;
    return raw ? sanitizeBackgroundConfig(raw) : null;
  };

  /** Resolve and show the background for the current settings. */
  const apply = async (): Promise<void> => {
    if (!loaded) return;
    const run = ++applying;
    const s = app.settings.value;
    manager.setOptions(backgroundOptions(s));
    const override = devOverride();
    const r: ResolvedBackground = override
      ? {
          config: override,
          source: 'player',
          picture:
            override.base.kind === 'image' || override.base.kind === 'cover'
              ? playerImage
                ? 'player'
                : null
              : null,
        }
      : resolveBackground(
          { mode: s.backgroundMode, hasImage: playerImage !== null },
          {
            config: song.config,
            hasImage: song.images.length > 0,
            hasCover: song.cover !== null,
          },
        );
    resolved = r;
    let picture: AnySource | null = null;
    if (r.picture) {
      const blob = blobOf(r.picture, r.config);
      const key =
        r.picture === 'song' ? `song:${pictureFor(r.config, song.images)?.id}` : r.picture;
      picture = await decoded(key, blob);
      if (run !== applying || scope.disposed) return;
    }
    const devSprites = import.meta.env.DEV
      ? (window as unknown as { __ataraxiaBackgroundSprites?: ParticleSpriteRecord[] })
          .__ataraxiaBackgroundSprites
      : undefined;
    const sprites = await decodeSprites(
      r.config,
      override && devSprites ? devSprites : song.sprites,
    );
    if (run !== applying || scope.disposed) {
      for (const b of sprites.values()) b.close();
      return;
    }
    bitmaps.push(...sprites.values());
    const key = [...sprites.keys()].join(',');
    if (key !== spritesKey) {
      spritesKey = key;
      manager.setCustomSprites(sprites, key);
    }
    const config =
      picture || r.config.base.kind === 'none' || r.config.base.kind === 'solid'
        ? r.config
        : { ...r.config, base: { ...r.config.base, kind: 'none' as const } };
    manager.setBackground(config, picture);
    startAnalysis();
  };

  // Follow the Display settings (the pause menu can change them mid-song).
  const modeOf = (): string => app.settings.value.backgroundMode;
  let lastMode = modeOf();
  scope.onDispose(
    app.settings.subscribe(() => {
      manager.setOptions(backgroundOptions(app.settings.value));
      if (modeOf() !== lastMode) {
        lastMode = modeOf();
        void apply();
      }
    }),
  );

  Promise.all([app.library.backgroundOf(songId), app.library.playerBackground()]).then(
    ([bg, mine]) => {
      if (scope.disposed) return;
      song = bg;
      playerImage = mine;
      loaded = true;
      void apply();
    },
    (err: unknown) => {
      console.warn('Loading the song background failed; using the default.', err);
      loaded = true;
      void apply();
    },
  );

  return {
    manager,
    setTiming(bpm, offsetMs) {
      manager.setSong(seedFromText(songId), { bpm, offsetMs });
    },
    setAudio(b) {
      buffer = b;
      startAnalysis();
    },
  };
}
