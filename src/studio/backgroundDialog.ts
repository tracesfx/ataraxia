import { AudioAnalyzer } from '../audio/audioAnalysis';
import type { AudioAnalysis } from '../core/analysis';
import {
  BASE_KINDS,
  CHROMATIC_MODES,
  COVER_MIN_BLUR,
  MAX_BACKGROUND_IMAGES,
  defaultBackgroundConfig,
  defaultEffects,
  seedFromText,
  type BackgroundConfig,
  type BaseKind,
  type ImageEffects,
} from '../core/background/config';
import {
  COLOR_MODES,
  COLOR_MODE_LABELS,
  CUSTOM_SPRITE_PREFIX,
  DIRECTIONS,
  DIRECTION_LABELS,
  EMISSION_LABELS,
  EMISSION_MODES,
  LIMITS,
  MAX_CUSTOM_SPRITES,
  MAX_EMITTERS,
  OPACITY_CURVES,
  OPACITY_CURVE_LABELS,
  ROTATION_LABELS,
  ROTATION_MODES,
  SCALE_MODES,
  SIZE_CURVES,
  SIZE_CURVE_LABELS,
  SPAWN_AREAS,
  SPAWN_LABELS,
  TEMPLATE_IDS,
  TEMPLATE_LABELS,
  defaultEmitter,
  emitterFromTemplate,
  nextEmitterId,
  type EmitterConfig,
  type TemplateId,
} from '../core/background/emitter';
import { DIM_MAX } from '../core/background/readability';
import { LIBRARY_SPRITE_IDS, SPRITE_LABELS } from '../core/background/sprites';
import { createBackgroundManager } from '../game/gameBackground';
import { COVER_ACCEPT } from '../library/cover';
import type { BackgroundImageRecord, ParticleSpriteRecord } from '../library/records';
import { LibraryError } from '../library/repository';
import { pictureFor, type CatalogSong } from '../library/songLibrary';
import { decodePicture } from '../render/background/pictures';
import { RAIL_W, computeFieldLayout } from '../render/fieldLayout';
import type { App } from '../ui/app';
import {
  button,
  chip,
  iconButton,
  progressBar,
  select,
  slider,
  textField,
  toggle,
} from '../ui/components';
import { el } from '../ui/dom';
import { createFilePicker } from '../ui/files';
import { openModal } from '../ui/modal';
import type { SceneScope } from '../ui/sceneManager';
import { errorsOf } from '../ui/songBrowser';
import { openSpriteEditor } from './spriteEditor';
import type { StudioLibrary } from './studioLibrary';

/** Logical size of the preview (the gameplay grid is ~960x540; this keeps the field in view). */
const PREVIEW_W = 640;
const PREVIEW_H = 360;
/** The silent preview loops this much of the song from the position slider. */
const PREVIEW_LOOP_MS = 8000;

/** A good place to preview: a few seconds before the strongest drop, else 30% in. */
function previewStartMs(a: AudioAnalysis | null, durationMs: number): number {
  if (!a) return Math.min(30000, durationMs * 0.3);
  const drop = [...a.impacts].sort((x, y) => y.strength - x.strength)[0];
  return drop ? Math.max(0, drop.t - 3000) : Math.min(30000, durationMs * 0.3);
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const px = (v: number): string => `${Math.round(v * 10) / 10} px`;
const sec = (v: number): string => `${v.toFixed(1)} s`;
const randomSeed = (): number => Math.floor(Math.random() * 0x7fffffff);
const newAssetId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/**
 * The Studio's background editor for one song (Studio only): a live preview that loops a short
 * part of the song from its analysis (silent, with a position slider), the base (one of up to
 * eight pictures, the cover, a solid colour or nothing) with fit, pixel match and dim, the
 * picture adjustments baked into it (blur, exposure, saturation, chromatic aberration, bloom),
 * up to four particle emitters with collapsible parameter groups, and the song's custom sprites
 * (imported PNGs or drawn in the sprite editor). Save stores the config, pictures and sprites
 * with the song; Reset goes back to the default. Resolves true when saved.
 */
export async function openBackgroundDialog(
  scope: SceneScope,
  app: App,
  studio: StudioLibrary,
  song: CatalogSong,
): Promise<boolean> {
  const stored = await app.library.backgroundOf(song.id);
  let config: BackgroundConfig = stored.config
    ? structuredClone(stored.config)
    : defaultBackgroundConfig(stored.cover ? 'cover' : 'none');
  let customised = stored.config !== null;
  let images: BackgroundImageRecord[] = [...stored.images];
  let sprites: ParticleSpriteRecord[] = [...stored.sprites];
  let imagesChanged = false;
  let spritesChanged = false;
  let alive = true;
  const cleanups: (() => void)[] = [];
  const setLabel = (b: HTMLButtonElement, text: string): void => {
    const label = b.querySelector('.btn-label');
    if (label) label.textContent = text;
  };

  // --- Decoded pictures and sprites ------------------------------------------------------------

  const bitmaps = new Map<Blob, Promise<ImageBitmap | null>>();
  const decode = (blob: Blob): Promise<ImageBitmap | null> => {
    let job = bitmaps.get(blob);
    if (!job) {
      job = decodePicture(blob).catch(() => null);
      bitmaps.set(blob, job);
    }
    return job;
  };
  cleanups.push(() => {
    for (const job of bitmaps.values()) void job.then((b) => b?.close());
  });

  // --- Preview ---------------------------------------------------------------------------------

  const layout = computeFieldLayout(PREVIEW_W, PREVIEW_H);
  const fieldArt = app.skin.buildField(layout);
  const canvas = el('canvas', { className: 'bg-preview' });
  canvas.width = PREVIEW_W;
  canvas.height = PREVIEW_H;
  const manager = createBackgroundManager(app, null);
  cleanups.push(() => manager.dispose());
  manager.setSong(seedFromText(song.id), { bpm: song.bpm, offsetMs: song.offsetMs });
  manager.setOptions({ dim: app.settings.value.backgroundDim, quality: 'high' });
  manager.resize(PREVIEW_W, PREVIEW_H, layout);
  const bakeStatus = el('span', { className: 'setting-desc bg-bake-status' });
  manager.onBaked = () => {
    bakeStatus.textContent = '';
  };

  let shown = 0;
  let spriteVersion = 0;
  const showPreview = (): void => {
    const run = ++shown;
    const c = structuredClone(config);
    const kind = c.base.kind;
    const blob =
      kind === 'image'
        ? (pictureFor(c, images)?.blob ?? null)
        : kind === 'cover'
          ? stored.cover
          : null;
    const used = new Set(
      c.emitters
        .map((e) => e.sprite)
        .filter((s) => s.startsWith(CUSTOM_SPRITE_PREFIX))
        .map((s) => s.slice(CUSTOM_SPRITE_PREFIX.length)),
    );
    const wanted = sprites.filter((s) => used.has(s.id));
    void Promise.all([
      blob ? decode(blob) : Promise.resolve(null),
      Promise.all(wanted.map((s) => decode(s.blob).then((b) => [s.id, b] as const))),
    ]).then(([picture, decoded]) => {
      if (run !== shown || !alive) return;
      const map = new Map<string, ImageBitmap>();
      for (const [id, b] of decoded) if (b) map.set(id, b);
      manager.setCustomSprites(map, `${spriteVersion}:${[...map.keys()].join(',')}`);
      const base =
        picture || kind === 'none' || kind === 'solid'
          ? c
          : { ...c, base: { ...c.base, kind: 'none' as const } };
      manager.setBackground(base, picture);
      bakeStatus.textContent = manager.baking ? 'Updating the picture...' : '';
    });
  };

  let loopStart = previewStartMs(null, song.durationMs);
  let startedAt = performance.now();
  const stopFrames = scope.everyFrame((ts) => {
    if (!alive) return;
    const songMs = loopStart + ((ts - startedAt) % PREVIEW_LOOP_MS);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    manager.draw(ctx, { songTimeMs: songMs, visualTimeMs: ts });
    ctx.drawImage(fieldArt, layout.fieldX - RAIL_W, 0);
  });
  const formatTime = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const position = slider(scope, {
    label: 'Preview position',
    min: 0,
    max: Math.max(1000, song.durationMs - PREVIEW_LOOP_MS),
    step: 500,
    value: loopStart,
    format: formatTime,
    onInput: (v) => {
      loopStart = v;
      startedAt = performance.now();
    },
  });

  const progress = progressBar('Analysing the song');
  void app.library.loadAudio(song.id).then(
    (b) => {
      if (!alive) return;
      const analyzer = new AudioAnalyzer(b, app.library.analysisCache(song.id));
      cleanups.push(() => analyzer.dispose());
      analyzer.onProgress((f) => progress.set(f));
      return analyzer.run().then((a) => {
        if (!alive) return;
        loopStart = previewStartMs(a, song.durationMs);
        position.set(loopStart);
        startedAt = performance.now();
        manager.setAnalysis(a);
        progress.root.hidden = true;
      });
    },
    (err: unknown) => {
      if (!alive) return;
      progress.root.hidden = true;
      bakeStatus.textContent = `The song could not be analysed, so impact bursts and activity stay off in the preview. ${errorsOf(err).join(' ')}`;
    },
  );

  // --- Control helpers -------------------------------------------------------------------------

  const refreshers: (() => void)[] = [];
  const changed = (): void => {
    customised = true;
    refresh();
  };
  const fieldRow = (label: string, control: Node, help = ''): HTMLElement => {
    const row = el('div', { className: 'setting-row' }, [
      el('div', { className: 'setting-text' }, [
        el('span', { className: 'setting-label t-label', text: label }),
      ]),
      el('div', { className: 'setting-control' }, [control]),
    ]);
    if (help) row.title = help;
    return row;
  };
  const choice = <T extends string>(
    label: string,
    values: readonly T[],
    labels: (v: T) => string,
    get: () => T,
    set: (v: T) => void,
  ): HTMLElement => {
    const s = select<string>(scope, {
      label,
      options: values.map((v) => ({ value: v as string, label: labels(v) })),
      value: get(),
      onChange: (v) => {
        const found = values.find((x) => x === v);
        if (found !== undefined) set(found);
        changed();
      },
    });
    refreshers.push(() => s.set(get()));
    return s.root;
  };
  const range = (
    label: string,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    get: () => number,
    set: (v: number) => void,
  ): HTMLElement => {
    const s = slider(scope, {
      label,
      min,
      max,
      step,
      value: get(),
      format,
      onInput: (v) => {
        set(v);
        changed();
      },
    });
    refreshers.push(() => s.set(get()));
    return s.root;
  };
  const flag = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => {
    const t = toggle(scope, {
      label,
      checked: get(),
      onChange: (v) => {
        set(v);
        changed();
      },
    });
    refreshers.push(() => t.set(get()));
    return t.root;
  };
  const colorInput = (label: string, get: () => string, set: (v: string) => void): HTMLElement => {
    const input = el('input', {
      className: 'bg-color',
      attrs: { type: 'color', 'aria-label': label },
    });
    input.value = get();
    scope.listen(input, 'input', () => {
      set(input.value.toLowerCase());
      changed();
    });
    refreshers.push(() => {
      input.value = get();
    });
    return el('span', { className: 'field bg-color-field' }, [input]);
  };
  /** A collapsible group with a reset button. */
  const group = (
    title: string,
    rows: HTMLElement[],
    reset: () => void,
    open = false,
  ): HTMLElement => {
    const body = el('div', { className: 'bg-fx-body' }, rows);
    body.hidden = !open;
    const expand = button(scope, {
      label: title,
      icon: 'chevron-down',
      variant: 'ghost',
      onClick: () => {
        body.hidden = !body.hidden;
        expand.classList.toggle('is-open', !body.hidden);
        expand.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
      },
    });
    expand.classList.toggle('is-open', open);
    expand.setAttribute('aria-expanded', open ? 'true' : 'false');
    const resetButton = iconButton(scope, {
      icon: 'retry',
      label: `Reset ${title.toLowerCase()}`,
      onClick: () => {
        reset();
        changed();
      },
    });
    return el('div', { className: 'bg-group-box' }, [
      el('div', { className: 'bg-group-head' }, [expand, resetButton]),
      body,
    ]);
  };

  // --- Base ------------------------------------------------------------------------------------

  const imageError = el('p', { className: 'setting-error', attrs: { 'aria-live': 'polite' } });
  let busy = false;
  const gallery = el('div', { className: 'bg-gallery' });
  const thumbUrls = new Map<Blob, string>();
  cleanups.push(() => {
    for (const u of thumbUrls.values()) URL.revokeObjectURL(u);
  });
  const urlOf = (b: Blob): string => {
    let u = thumbUrls.get(b);
    if (!u) {
      u = URL.createObjectURL(b);
      thumbUrls.set(b, u);
    }
    return u;
  };
  const renderGallery = (): void => {
    const current = pictureFor(config, images)?.id;
    gallery.replaceChildren(
      ...images.map((img, i) => {
        const pick = el(
          'button',
          {
            className: `bg-thumb${config.base.kind === 'image' && img.id === current ? ' is-on' : ''}`,
            attrs: {
              type: 'button',
              'aria-label': `Use picture ${i + 1}`,
              title: `Picture ${i + 1}`,
            },
          },
          [el('img', { attrs: { src: urlOf(img.blob), alt: '' } })],
        );
        scope.listen(pick, 'click', () => {
          config.base.kind = 'image';
          config.base.imageId = img.id;
          changed();
        });
        const remove = iconButton(scope, {
          icon: 'trash',
          label: `Remove picture ${i + 1}`,
          onClick: () => {
            images = images.filter((x) => x !== img);
            imagesChanged = true;
            if (config.base.imageId === img.id) config.base.imageId = images[0]?.id ?? null;
            if (config.base.kind === 'image' && images.length === 0) {
              config.base.kind = stored.cover ? 'cover' : 'none';
            }
            changed();
          },
        });
        return el('div', { className: 'bg-thumb-cell' }, [pick, remove]);
      }),
    );
  };
  const picker = createFilePicker(scope, app.ui, (files, purpose) => {
    if (purpose === 'sprite') {
      void addSpriteFiles(files);
      return;
    }
    const room = MAX_BACKGROUND_IMAGES - images.length;
    const chosen = files.slice(0, Math.max(0, room));
    if (chosen.length === 0) return;
    busy = true;
    imageError.replaceChildren();
    refresh();
    void (async () => {
      const problems: string[] = [];
      for (const file of chosen) {
        try {
          const blob = await studio.prepareBackgroundImage(file, file.name);
          const id = newAssetId('image');
          images.push({ id, blob });
          imagesChanged = true;
          config.base.kind = 'image';
          config.base.imageId = id;
        } catch (err) {
          problems.push(
            ...(err instanceof LibraryError ? err.errors : ['The picture could not be used.']),
          );
        }
      }
      if (files.length > chosen.length) {
        problems.push(
          `A song keeps at most ${MAX_BACKGROUND_IMAGES} pictures; the rest were skipped.`,
        );
      }
      busy = false;
      imageError.textContent = problems.join(' ');
      changed();
    })();
  });
  const uploadButton = button(scope, {
    label: 'Add pictures',
    icon: 'import',
    onClick: () => picker.open(COVER_ACCEPT, 'background', true),
  });
  const baseKindLabel = (k: BaseKind): string =>
    k === 'image'
      ? images.length > 0
        ? 'Image'
        : 'Image (add one)'
      : k === 'cover'
        ? stored.cover
          ? 'Cover (blurred)'
          : 'Cover (the song has none)'
        : k === 'solid'
          ? 'Solid colour'
          : 'None (plain dark)';
  const solidRow = fieldRow(
    'Colour',
    colorInput(
      'Base colour',
      () => config.base.color,
      (v) => {
        config.base.color = v;
      },
    ),
  );
  const fitRow = fieldRow(
    'Fit',
    choice(
      'Fit',
      ['cover', 'contain'] as const,
      (v) => (v === 'cover' ? 'Fill the screen' : 'Show it whole'),
      () => config.base.fit,
      (v) => {
        config.base.fit = v;
      },
    ),
  );
  const imageRow = fieldRow(
    'Pictures',
    el('div', { className: 'bg-pictures' }, [gallery, uploadButton]),
    `Up to ${MAX_BACKGROUND_IMAGES} pictures per song (PNG, JPEG, WebP, GIF or AVIF up to 25 MB, stored as WebP at most 1920x1080). Click one to show it.`,
  );
  refreshers.push(() => {
    renderGallery();
    solidRow.hidden = config.base.kind !== 'solid';
    fitRow.hidden = config.base.kind !== 'image' && config.base.kind !== 'cover';
    uploadButton.disabled = busy || images.length >= MAX_BACKGROUND_IMAGES;
    setLabel(uploadButton, busy ? 'Processing...' : 'Add pictures');
  });
  const baseSection = el('div', { className: 'bg-group' }, [
    fieldRow(
      'Base',
      choice(
        'Base',
        BASE_KINDS,
        baseKindLabel,
        () => config.base.kind,
        (v) => {
          config.base.kind = v;
          if (v === 'image' && !config.base.imageId) config.base.imageId = images[0]?.id ?? null;
        },
      ),
      'What fills the screen behind the lanes. It never moves; particles are the only motion.',
    ),
    imageRow,
    imageError,
    solidRow,
    fitRow,
    fieldRow(
      'Dim',
      range(
        'Dim',
        0,
        DIM_MAX,
        0.05,
        pct,
        () => config.base.dim,
        (v) => {
          config.base.dim = v;
        },
      ),
      'A dark layer over the background. Players can shift it in their settings; the lanes always get extra shade on bright pictures.',
    ),
    fieldRow(
      'Pixel match',
      flag(
        'Pixel match',
        () => config.base.pixelMatch,
        (v) => {
          config.base.pixelMatch = v;
        },
      ),
      'Draw at the game pixel grid; off draws at full screen resolution.',
    ),
  ]);

  // --- Picture adjustments ---------------------------------------------------------------------

  const fx = (): ImageEffects => config.effects;
  const fxRow = (
    label: string,
    key:
      'blur' | 'exposure' | 'saturation' | 'chromatic' | 'bloom' | 'bloomThreshold' | 'bloomRadius',
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    help: string,
  ): HTMLElement =>
    fieldRow(
      label,
      range(
        label,
        min,
        max,
        step,
        format,
        () => fx()[key],
        (v) => {
          fx()[key] = v;
        },
      ),
      help,
    );
  const stops = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(2)} stops`;
  const effectsBox = el('div', { className: 'bg-group' }, [
    fxRow(
      'Blur',
      'blur',
      0,
      40,
      1,
      px,
      'Blur radius at 1080p. The cover base is always blurred at least a little.',
    ),
    fxRow('Exposure', 'exposure', -1, 1, 0.05, stops, 'Darker or brighter, in photographic stops.'),
    fxRow('Saturation', 'saturation', 0, 2, 0.05, pct, '0% grey, 100% unchanged, 200% vivid.'),
    fxRow(
      'Chromatic',
      'chromatic',
      0,
      12,
      0.5,
      px,
      'Splits red and blue apart, like a cheap lens (pixels at 1080p).',
    ),
    fieldRow(
      'Split',
      choice(
        'Chromatic direction',
        CHROMATIC_MODES,
        (v) => (v === 'radial' ? 'Radial from the centre' : 'Horizontal'),
        () => fx().chromaticMode,
        (v) => {
          fx().chromaticMode = v;
        },
      ),
    ),
    fxRow('Bloom', 'bloom', 0, 2, 0.05, pct, 'A soft glow around the bright parts. 0% is off.'),
    fxRow(
      'Bloom threshold',
      'bloomThreshold',
      0,
      1,
      0.05,
      pct,
      'Only parts brighter than this glow.',
    ),
    fxRow('Bloom radius', 'bloomRadius', 0, 1, 0.05, pct, 'How far the glow spreads.'),
  ]);
  const effectsNote = el('p', {
    className: 'setting-desc',
    text: `Baked into the picture once, so they cost nothing while playing. The cover is blurred at least ${COVER_MIN_BLUR} px.`,
  });
  const effectsGroup = group(
    'Picture adjustments',
    [effectsNote, effectsBox],
    () => {
      config.effects = defaultEffects();
    },
    true,
  );
  refreshers.push(() => {
    effectsGroup.classList.toggle('is-disabled', config.base.kind === 'none');
  });

  // --- Custom sprites --------------------------------------------------------------------------

  const spriteError = el('p', { className: 'setting-error', attrs: { 'aria-live': 'polite' } });
  const spriteList = el('div', { className: 'bg-sprites' });
  async function addSpriteFiles(files: File[]): Promise<void> {
    const problems: string[] = [];
    for (const file of files) {
      if (sprites.length >= MAX_CUSTOM_SPRITES) {
        problems.push(`A song keeps at most ${MAX_CUSTOM_SPRITES} custom sprites.`);
        break;
      }
      try {
        const blob = await studio.prepareSprite(file, file.name);
        sprites.push({
          id: newAssetId('sprite'),
          name: file.name.replace(/\.png$/i, '').slice(0, 40),
          blob,
        });
        spritesChanged = true;
      } catch (err) {
        problems.push(...errorsOf(err));
      }
    }
    spriteError.textContent = problems.join(' ');
    spriteVersion++;
    changed();
    renderEmitters();
  }
  const editSprite = async (existing: ParticleSpriteRecord | null): Promise<void> => {
    const draft = await openSpriteEditor(scope, app, existing);
    if (!draft || !alive) return;
    if (existing) {
      sprites = sprites.map((s) =>
        s === existing ? { ...s, name: draft.name, blob: draft.blob } : s,
      );
    } else {
      if (sprites.length >= MAX_CUSTOM_SPRITES) {
        spriteError.textContent = `A song keeps at most ${MAX_CUSTOM_SPRITES} custom sprites. Remove one first.`;
        return;
      }
      sprites.push({ id: newAssetId('sprite'), name: draft.name, blob: draft.blob });
    }
    spritesChanged = true;
    spriteVersion++;
    changed();
    renderEmitters();
  };
  const renderSprites = (): void => {
    spriteList.replaceChildren(
      ...sprites.map((s) =>
        el('div', { className: 'bg-sprite-cell' }, [
          el('img', { className: 'bg-sprite-img', attrs: { src: urlOf(s.blob), alt: '' } }),
          el('span', { className: 'setting-desc', text: s.name }),
          iconButton(scope, {
            icon: 'edit',
            label: `Edit ${s.name}`,
            onClick: () => void editSprite(s),
          }),
          iconButton(scope, {
            icon: 'trash',
            label: `Remove ${s.name}`,
            onClick: () => {
              sprites = sprites.filter((x) => x !== s);
              spritesChanged = true;
              const ref = CUSTOM_SPRITE_PREFIX + s.id;
              for (const e of config.emitters) if (e.sprite === ref) e.sprite = 'dust';
              spriteVersion++;
              changed();
              renderEmitters();
            },
          }),
        ]),
      ),
    );
  };
  const addSpriteButton = button(scope, {
    label: 'Import PNG',
    icon: 'import',
    onClick: () => picker.open('image/png', 'sprite', true),
  });
  const drawSpriteButton = button(scope, {
    label: 'Draw a sprite',
    icon: 'edit',
    onClick: () => void editSprite(null),
  });
  refreshers.push(() => {
    renderSprites();
    addSpriteButton.disabled = sprites.length >= MAX_CUSTOM_SPRITES;
    drawSpriteButton.disabled = sprites.length >= MAX_CUSTOM_SPRITES;
  });
  const spritesSection = el('div', { className: 'bg-group' }, [
    el('p', {
      className: 'setting-desc',
      text: `Your own particle sprites for this song: PNG, at most 64x64 and 256 KB, up to ${MAX_CUSTOM_SPRITES}. White and grey sprites take the emitter colour best.`,
    }),
    spriteList,
    el('div', { className: 'setting-buttons' }, [addSpriteButton, drawSpriteButton]),
    spriteError,
  ]);

  // --- Emitters --------------------------------------------------------------------------------

  const emitterList = el('div', { className: 'bg-fx-list' });
  const openCards = new Set<string>();

  const emitterCard = (e: EmitterConfig, index: number): HTMLElement => {
    const get = (): EmitterConfig => config.emitters.find((x) => x.id === e.id) ?? e;
    const num = (
      label: string,
      key: {
        [K in keyof EmitterConfig]: EmitterConfig[K] extends number ? K : never;
      }[keyof EmitterConfig],
      min: number,
      max: number,
      step: number,
      format: (v: number) => string,
      help = '',
      after?: (v: number) => void,
    ): HTMLElement =>
      fieldRow(
        label,
        range(
          `${label}`,
          min,
          max,
          step,
          format,
          () => get()[key],
          (v) => {
            get()[key] = v;
            after?.(v);
          },
        ),
        help,
      );
    const pick = <
      K extends
        | 'scaleMode'
        | 'colorMode'
        | 'opacityCurve'
        | 'sizeCurve'
        | 'rotation'
        | 'spawn'
        | 'direction'
        | 'emission',
    >(
      label: string,
      key: K,
      values: readonly EmitterConfig[K][],
      labels: (v: EmitterConfig[K]) => string,
      help = '',
    ): HTMLElement =>
      fieldRow(
        label,
        choice(
          label,
          values,
          labels,
          () => get()[key],
          (v) => {
            get()[key] = v;
          },
        ),
        help,
      );
    /** Reset the given fields to the plain emitter's defaults. */
    const resetKeys = (keys: readonly (keyof EmitterConfig)[]) => (): void => {
      const d = defaultEmitter(e.id, get().seed) as unknown as Record<string, unknown>;
      const target = get() as unknown as Record<string, unknown>;
      for (const k of keys) target[k] = structuredClone(d[k]);
    };
    const minMax = (
      minKey: 'sizeMin' | 'lifeMin' | 'speedMin',
      maxKey: 'sizeMax' | 'lifeMax' | 'speedMax',
    ) => ({
      min: (v: number): void => {
        if (get()[maxKey] < v) get()[maxKey] = v;
      },
      max: (v: number): void => {
        if (get()[minKey] > v) get()[minKey] = v;
      },
    });
    const size = minMax('sizeMin', 'sizeMax');
    const life = minMax('lifeMin', 'lifeMax');
    const speed = minMax('speedMin', 'speedMax');

    const spriteOptions = [
      ...LIBRARY_SPRITE_IDS.map((id) => ({ value: id as string, label: SPRITE_LABELS[id] })),
      ...sprites.map((s) => ({ value: CUSTOM_SPRITE_PREFIX + s.id, label: `Custom: ${s.name}` })),
    ];
    const spriteSelect = select<string>(scope, {
      label: 'Sprite',
      options: spriteOptions,
      value: get().sprite,
      onChange: (v) => {
        get().sprite = v;
        changed();
      },
    });
    refreshers.push(() => spriteSelect.set(get().sprite));

    const bandRows = [
      num('Band centre', 'bandY', 0, 1, 0.05, pct, '0% is the top of the screen, 100% the bottom.'),
      num('Band height', 'bandHeight', 0.02, 1, 0.02, pct),
    ];
    const ringRows = [
      num('Ring radius', 'ringRadius', 0.05, 1.5, 0.05, pct, 'Of half the screen height.'),
    ];
    const gradientRow = fieldRow(
      'End colour',
      colorInput(
        'End colour',
        () => get().color2,
        (v) => {
          get().color2 = v;
        },
      ),
    );
    const colorRow = fieldRow(
      'Colour',
      colorInput(
        'Colour',
        () => get().color,
        (v) => {
          get().color = v;
        },
      ),
    );
    const paletteBox = el('div', { className: 'bg-palette' });
    const renderPalette = (): void => {
      const p = get().palette;
      paletteBox.replaceChildren(
        ...p.map((c, i) => {
          const input = el('input', {
            className: 'bg-color',
            attrs: { type: 'color', 'aria-label': `Palette colour ${i + 1}` },
          });
          input.value = c;
          scope.listen(input, 'input', () => {
            get().palette[i] = input.value.toLowerCase();
            changed();
          });
          return el('span', { className: 'field bg-color-field' }, [input]);
        }),
        iconButton(scope, {
          icon: 'plus',
          label: 'Add a colour',
          onClick: () => {
            if (get().palette.length < 5) get().palette.push(get().palette.at(-1) ?? '#ffffff');
            renderPalette();
            changed();
          },
        }),
        iconButton(scope, {
          icon: 'minus',
          label: 'Remove the last colour',
          onClick: () => {
            if (get().palette.length > 1) get().palette.pop();
            renderPalette();
            changed();
          },
        }),
      );
    };
    renderPalette();
    const paletteRow = fieldRow(
      'Palette',
      paletteBox,
      'Each particle picks one of these at random.',
    );
    const angleRow = num(
      'Angle',
      'angle',
      LIMITS.angle[0],
      LIMITS.angle[1],
      5,
      (v) => `${Math.round(v)}°`,
    );
    const spinRow = num(
      'Spin',
      'spin',
      LIMITS.spin[0],
      LIMITS.spin[1],
      10,
      (v) => `${Math.round(v)}°/s`,
    );
    const layerRows = [
      num(
        'Deeper size',
        'layerScale',
        0.2,
        1,
        0.05,
        pct,
        'Each deeper layer is this much smaller.',
      ),
      num(
        'Deeper speed',
        'layerSpeed',
        0.2,
        1,
        0.05,
        pct,
        'Each deeper layer moves this much slower.',
      ),
      num(
        'Deeper opacity',
        'layerOpacity',
        0.2,
        1,
        0.05,
        pct,
        'Each deeper layer is this much fainter.',
      ),
    ];
    const trailSpacingRow = num(
      'Trail spacing',
      'trailSpacingMs',
      10,
      200,
      5,
      (v) => `${Math.round(v)} ms`,
    );
    refreshers.push(() => {
      const x = get();
      for (const r of bandRows) r.hidden = x.spawn !== 'band';
      for (const r of ringRows) r.hidden = x.spawn !== 'ring';
      colorRow.hidden = x.colorMode !== 'single' && x.colorMode !== 'gradient';
      gradientRow.hidden = x.colorMode !== 'gradient';
      paletteRow.hidden = x.colorMode !== 'palette';
      angleRow.hidden = x.rotation !== 'fixed' && x.rotation !== 'velocity';
      spinRow.hidden = x.rotation !== 'fixed' && x.rotation !== 'random';
      for (const r of layerRows) r.hidden = x.layers < 2;
      trailSpacingRow.hidden = x.trail === 0;
    });

    const groups = [
      group(
        'Sprite',
        [
          fieldRow(
            'Sprite',
            spriteSelect.root,
            'A library sprite, or one of this song’s custom sprites.',
          ),
          pick(
            'Scaling',
            'scaleMode',
            SCALE_MODES,
            (v) => (v === 'pixel' ? 'Whole pixels (crisp)' : 'Any size (smooth)'),
            'Whole pixels keeps pixel art sharp by scaling in whole steps.',
          ),
          num(
            'Smallest',
            'sizeMin',
            LIMITS.size[0],
            LIMITS.size[1],
            1,
            px,
            'Size of the longer side in game pixels.',
            size.min,
          ),
          num('Largest', 'sizeMax', LIMITS.size[0], LIMITS.size[1], 1, px, '', size.max),
        ],
        resetKeys(['sprite', 'scaleMode', 'sizeMin', 'sizeMax']),
        true,
      ),
      group(
        'Emission',
        [
          pick(
            'Emission',
            'emission',
            EMISSION_MODES,
            (v) => EMISSION_LABELS[v],
            'Bursts follow the beat grid or the impacts and drops found in the song; they are automatic.',
          ),
          num(
            'Count',
            'count',
            LIMITS.count[0],
            300,
            1,
            (v) => String(Math.round(v)),
            'Particles alive at once (continuous) or per burst. The whole background shows at most 600.',
          ),
          num('Shortest life', 'lifeMin', LIMITS.life[0], LIMITS.life[1], 0.1, sec, '', life.min),
          num('Longest life', 'lifeMax', LIMITS.life[0], LIMITS.life[1], 0.1, sec, '', life.max),
          num(
            'Reacts to music',
            'reactivity',
            0,
            1,
            0.05,
            pct,
            'How much the song’s activity raises the count, speed and size. 0% keeps them steady.',
          ),
          fieldRow(
            'Seed',
            button(scope, {
              label: 'Randomize',
              icon: 'dice',
              title: 'A new random layout with the same settings',
              onClick: () => {
                get().seed = randomSeed();
                changed();
              },
            }),
          ),
        ],
        resetKeys(['emission', 'count', 'lifeMin', 'lifeMax', 'reactivity']),
      ),
      group(
        'Spawn and motion',
        [
          pick(
            'Spawn area',
            'spawn',
            SPAWN_AREAS,
            (v) => SPAWN_LABELS[v],
            'Where particles appear. Edges: they enter from the side they move away from.',
          ),
          ...bandRows,
          ...ringRows,
          pick('Direction', 'direction', DIRECTIONS, (v) => DIRECTION_LABELS[v]),
          num(
            'Slowest',
            'speedMin',
            LIMITS.speed[0],
            LIMITS.speed[1],
            1,
            (v) => `${Math.round(v)} px/s`,
            '',
            speed.min,
          ),
          num(
            'Fastest',
            'speedMax',
            LIMITS.speed[0],
            LIMITS.speed[1],
            1,
            (v) => `${Math.round(v)} px/s`,
            '',
            speed.max,
          ),
          num(
            'Gravity',
            'gravity',
            LIMITS.gravity[0],
            LIMITS.gravity[1],
            5,
            (v) => `${Math.round(v)}`,
            'Positive pulls down, negative lifts up (game pixels per second squared).',
          ),
          num('Sway', 'swayAmp', LIMITS.swayAmp[0], LIMITS.swayAmp[1], 1, px, 'Sideways wobble.'),
          num(
            'Sway speed',
            'swayFreq',
            LIMITS.swayFreq[0],
            LIMITS.swayFreq[1],
            0.05,
            (v) => `${v.toFixed(2)} Hz`,
          ),
        ],
        resetKeys([
          'spawn',
          'bandY',
          'bandHeight',
          'ringRadius',
          'direction',
          'speedMin',
          'speedMax',
          'gravity',
          'swayAmp',
          'swayFreq',
        ]),
      ),
      group(
        'Colour and fade',
        [
          pick('Colour', 'colorMode', COLOR_MODES, (v) => COLOR_MODE_LABELS[v]),
          colorRow,
          gradientRow,
          paletteRow,
          num('Opacity', 'opacity', 0, 1, 0.05, pct),
          pick('Opacity over life', 'opacityCurve', OPACITY_CURVES, (v) => OPACITY_CURVE_LABELS[v]),
          pick('Size over life', 'sizeCurve', SIZE_CURVES, (v) => SIZE_CURVE_LABELS[v]),
          num('Flicker', 'flicker', 0, 1, 0.05, pct, 'Random quick dimming, like embers or stars.'),
        ],
        resetKeys([
          'colorMode',
          'color',
          'color2',
          'palette',
          'opacity',
          'opacityCurve',
          'sizeCurve',
          'flicker',
        ]),
      ),
      group(
        'Rotation',
        [
          pick('Rotation', 'rotation', ROTATION_MODES, (v) => ROTATION_LABELS[v]),
          angleRow,
          spinRow,
        ],
        resetKeys(['rotation', 'angle', 'spin']),
      ),
      group(
        'Depth',
        [
          num(
            'Layers',
            'layers',
            1,
            3,
            1,
            (v) => String(Math.round(v)),
            'Parallax: deeper layers are smaller, slower and fainter.',
          ),
          ...layerRows,
        ],
        resetKeys(['layers', 'layerScale', 'layerSpeed', 'layerOpacity']),
      ),
      group(
        'Glow and trail',
        [
          num(
            'Glow',
            'glow',
            0,
            1,
            0.05,
            pct,
            'A soft pre-rendered halo added behind each sprite.',
          ),
          num(
            'Trail',
            'trail',
            LIMITS.trail[0],
            LIMITS.trail[1],
            1,
            (v) => String(Math.round(v)),
            'Stepped afterimages behind each particle.',
          ),
          trailSpacingRow,
          fieldRow(
            'Snap to pixels',
            flag(
              'Snap to pixels',
              () => get().snap,
              (v) => {
                get().snap = v;
              },
            ),
            'Positions land on whole game pixels.',
          ),
        ],
        resetKeys(['glow', 'trail', 'trailSpacingMs', 'snap']),
      ),
    ];

    const body = el('div', { className: 'bg-emitter-body' }, groups);
    body.hidden = !openCards.has(e.id);
    const nameField = textField(scope, {
      label: 'Emitter name',
      value: e.name,
      onInput: (v) => {
        get().name = v.slice(0, 40) || 'Emitter';
        customised = true;
      },
    });
    const expand = iconButton(scope, {
      icon: 'chevron-down',
      label: 'Show or hide the settings',
      onClick: () => {
        body.hidden = !body.hidden;
        if (body.hidden) openCards.delete(e.id);
        else openCards.add(e.id);
        expand.classList.toggle('is-open', !body.hidden);
      },
    });
    expand.classList.toggle('is-open', !body.hidden);
    const head = el('div', { className: 'bg-emitter-head' }, [
      flag(
        `Emitter ${index + 1} on`,
        () => get().enabled,
        (v) => {
          get().enabled = v;
        },
      ),
      nameField.root,
      iconButton(scope, {
        icon: 'duplicate',
        label: 'Duplicate',
        onClick: () => {
          if (config.emitters.length >= MAX_EMITTERS) return;
          const copy = {
            ...structuredClone(get()),
            id: nextEmitterId(config.emitters),
            seed: randomSeed(),
          };
          copy.name = `${get().name} copy`.slice(0, 40);
          config.emitters.splice(index + 1, 0, copy);
          openCards.add(copy.id);
          changed();
          renderEmitters();
        },
      }),
      iconButton(scope, {
        icon: 'trash',
        label: 'Remove',
        onClick: () => {
          config.emitters = config.emitters.filter((x) => x.id !== e.id);
          changed();
          renderEmitters();
        },
      }),
      expand,
    ]);
    const card = el('div', { className: 'bg-emitter card' }, [head, body]);
    refreshers.push(() => card.classList.toggle('is-on', get().enabled));
    return card;
  };

  let template: TemplateId | 'blank' = 'dust';
  const templateSelect = select<string>(scope, {
    label: 'Start from',
    options: [
      ...TEMPLATE_IDS.map((t) => ({ value: t as string, label: TEMPLATE_LABELS[t] })),
      { value: 'blank', label: 'Blank emitter' },
    ],
    value: template,
    onChange: (v) => {
      template = v === 'blank' ? 'blank' : (TEMPLATE_IDS.find((t) => t === v) ?? 'dust');
    },
  });
  const addEmitter = button(scope, {
    label: 'Add emitter',
    icon: 'plus',
    onClick: () => {
      if (config.emitters.length >= MAX_EMITTERS) return;
      const id = nextEmitterId(config.emitters);
      const e =
        template === 'blank'
          ? defaultEmitter(id, randomSeed())
          : emitterFromTemplate(template, id, randomSeed());
      config.emitters.push(e);
      openCards.add(id);
      changed();
      renderEmitters();
    },
  });
  const emitterCount = el('span', { className: 'setting-desc' });
  refreshers.push(() => {
    addEmitter.disabled = config.emitters.length >= MAX_EMITTERS;
    emitterCount.textContent =
      config.emitters.length === 0
        ? 'No particles yet.'
        : `${config.emitters.length} of ${MAX_EMITTERS} emitters.`;
  });
  function renderEmitters(): void {
    // Rebuilt cards register fresh refreshers; drop the old cards' ones.
    refreshers.length = baseRefreshers;
    emitterList.replaceChildren(...config.emitters.map((e, i) => emitterCard(e, i)));
    refresh();
  }

  const resetButton = button(scope, {
    label: 'Reset',
    icon: 'retry',
    variant: 'ghost',
    title: 'Back to the default: the cover with no adjustments and no particles',
    onClick: () => {
      config = defaultBackgroundConfig(stored.cover ? 'cover' : 'none');
      customised = false;
      renderEmitters();
    },
  });
  const sourceChip = el('span', { className: 'bg-source' });

  const refresh = (): void => {
    for (const fn of refreshers) fn();
    sourceChip.replaceChildren(
      chip({ label: customised ? 'Custom' : 'Default', tone: customised ? 'accent' : 'steel' }),
    );
    showPreview();
  };
  const baseRefreshers = refreshers.length;
  renderEmitters();

  const body: Node[] = [
    el('div', { className: 'bg-editor' }, [
      el('div', { className: 'bg-main' }, [
        canvas,
        fieldRow('Position', position.root, 'The preview loops 8 seconds from here, silently.'),
        progress.root,
        el('div', { className: 'setting-buttons' }, [sourceChip, resetButton, bakeStatus]),
      ]),
      el('div', { className: 'bg-controls' }, [
        el('h3', { className: 'modal-section t-label', text: 'Base' }),
        baseSection,
        effectsGroup,
        el('h3', { className: 'modal-section t-label', text: 'Particles' }),
        el('div', { className: 'setting-buttons' }, [
          templateSelect.root,
          addEmitter,
          emitterCount,
        ]),
        emitterList,
        el('h3', { className: 'modal-section t-label', text: 'Custom sprites' }),
        spritesSection,
      ]),
    ]),
  ];

  const saved = await openModal(scope, app.ui, {
    title: `Background: ${song.title}`,
    className: 'background-dialog',
    body,
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Save', value: true, primary: true },
    ],
    cancelValue: false,
    validate: async () => {
      if (busy) return ['The pictures are still being processed. Wait a moment, then save.'];
      if (config.base.kind === 'image' && images.length === 0) {
        return ['The image base needs a picture. Add one, or choose the cover, a colour or none.'];
      }
      const ids = new Set(sprites.map((s) => CUSTOM_SPRITE_PREFIX + s.id));
      for (const e of config.emitters) {
        if (e.sprite.startsWith(CUSTOM_SPRITE_PREFIX) && !ids.has(e.sprite)) e.sprite = 'dust';
      }
      try {
        await studio.setBackground(song.id, customised ? config : null, {
          ...(imagesChanged ? { images } : {}),
          ...(spritesChanged ? { sprites } : {}),
        });
      } catch (err) {
        return errorsOf(err);
      }
      return [];
    },
  });

  alive = false;
  stopFrames();
  for (const fn of cleanups) fn();
  return saved;
}
