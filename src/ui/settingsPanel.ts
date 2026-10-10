import { DIM_MAX } from '../core/background/readability';
import { BACKGROUND_MODES, type BackgroundMode } from '../core/background/precedence';
import { QUALITY_LABELS, QUALITY_PRESETS, type QualityPreset } from '../core/background/quality';
import type { Lane } from '../core/chart';
import { FRAME_RATE_CHOICES, frameRateLabel } from '../core/framePacing';
import { LANE_COUNT } from '../core/constants';
import {
  AUDIO_OFFSET_MAX_MS,
  AUDIO_OFFSET_MIN_MS,
  DEFAULT_LANE_KEYS,
  EFFECTS_LEVELS,
  PARTICLE_SIZES,
  PARTICLE_THRESHOLD_MAX_MS,
  PARTICLE_THRESHOLD_MIN_MS,
  PARTICLE_THRESHOLD_PRESETS,
  RESUME_DELAYS_MS,
  RUN_IN_TIMES_MS,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  SCROLL_SPEED_STEP,
  HUD_SIZES,
  JUDGEMENT_STYLES,
  UI_SCALES,
  LANE_GLOW_MAX,
  LANE_GLOW_MIN,
  LANE_GLOW_STEP,
  clampAudioOffset,
  clampLaneGlow,
  keyLabel,
  particleThreshold,
  rebindLane,
  type EffectsLevel,
  type HudSize,
  type JudgementStyle,
  type ParticleSize,
  type Settings,
  type UiScale,
} from '../core/settings';
import type { App } from './app';
import {
  button,
  icon,
  iconButton,
  keyCapElement,
  select,
  slider,
  tabs,
  toggle,
} from './components';
import { el } from './dom';
import { createFilePicker } from './files';
import { COVER_ACCEPT } from '../library/cover';
import { LibraryError } from '../library/repository';
import { keyCap } from './keyHints';
import type { SceneScope } from './sceneManager';

export interface SettingsPanelOptions {
  /** Close requested (Back button or Esc when no key capture is running). */
  onClose(): void;
  /**
   * Open the calibration screen. Omitted in-game: calibration needs its own scene, so the pause
   * menu's settings show a note instead.
   */
  onCalibrate?: () => void;
  /** Category to open first. */
  category?: Category;
}

export interface SettingsPanel {
  root: HTMLElement;
  /** Focus the selected category tab (call after the panel is in the document). */
  focus(): void;
  /** Remove the panel and stop following settings changes. */
  dispose(): void;
}

type Category = 'gameplay' | 'controls' | 'audio' | 'display' | 'calibration';
const CATEGORIES: readonly { id: Category; label: string; icon: string }[] = [
  { id: 'gameplay', label: 'Gameplay', icon: 'sliders' },
  { id: 'controls', label: 'Controls', icon: 'keyboard' },
  { id: 'audio', label: 'Audio', icon: 'volume' },
  { id: 'display', label: 'Display', icon: 'display' },
  { id: 'calibration', label: 'Calibration', icon: 'target' },
];

type VolumeKey = 'masterVolume' | 'musicVolume' | 'hitSoundVolume';
type ToggleKey =
  | 'hitSounds'
  | 'debugOverlay'
  | 'earlyLateIndicator'
  | 'showFps'
  | 'timingParticles'
  | 'comboColors'
  | 'backgroundReduceMotion';
type ChoiceKey = 'resumeDelayMs' | 'runInMs';

const formatSeconds = (ms: number): string => (ms === 0 ? 'Off' : `${ms / 1000} s`);
const formatOffset = (ms: number): string => `${ms > 0 ? '+' : ''}${ms} ms`;

/** Remembered while the page is open, so the screen reopens where the player left it. */
let lastCategory: Category = 'gameplay';

/**
 * Every player setting in a two-pane glass panel: categories on the left (Gameplay, Controls,
 * Audio, Display, Calibration), the selected category's settings on the right, each with a label
 * and a short description. Every change is saved and applied immediately through
 * `app.settings`. Used by the settings screen and, in-game, by the pause menu's overlay.
 *
 * Key events inside the panel never reach the scene's window listeners (stopPropagation), so a
 * game behind it can't react to them.
 */
export function createSettingsPanel(
  scope: SceneScope,
  app: App,
  options: SettingsPanelOptions,
): SettingsPanel {
  const store = app.settings;
  const s = (): Readonly<Settings> => store.value;
  const refreshers: (() => void)[] = [];
  const refresh = (): void => {
    for (const fn of refreshers) fn();
  };
  const patch = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    const p: Partial<Settings> = {};
    p[key] = value;
    store.update(p);
  };

  /** One setting: label and description on the left, the control on the right. */
  const row = (label: string, description: string, control: Node, wide = false): HTMLElement =>
    el('div', { className: `setting-row${wide ? ' is-wide' : ''}` }, [
      el('div', { className: 'setting-text' }, [
        el('span', { className: 'setting-label t-label', text: label }),
        el('span', { className: 'setting-desc', text: description }),
      ]),
      el('div', { className: 'setting-control' }, [control]),
    ]);

  const volume = (label: string, description: string, key: VolumeKey): HTMLElement => {
    const c = slider(scope, {
      label,
      min: 0,
      max: 100,
      step: 1,
      value: Math.round(s()[key] * 100),
      format: (v) => `${v}%`,
      onInput: (v) => patch(key, v / 100),
    });
    refreshers.push(() => c.set(Math.round(s()[key] * 100)));
    return row(label, description, c.root);
  };

  const switchRow = (label: string, description: string, key: ToggleKey): HTMLElement => {
    const t = toggle(scope, { label, checked: s()[key], onChange: (v) => patch(key, v) });
    refreshers.push(() => t.set(s()[key]));
    return row(label, description, t.root);
  };

  const choiceRow = (
    label: string,
    description: string,
    key: ChoiceKey,
    choices: readonly number[],
  ): HTMLElement => {
    const c = select(scope, {
      label,
      options: choices.map((ms) => ({ value: ms, label: formatSeconds(ms) })),
      value: s()[key],
      onChange: (v) => patch(key, v),
    });
    refreshers.push(() => c.set(s()[key]));
    return row(label, description, c.root);
  };

  // --- Gameplay ------------------------------------------------------------------------------

  const speed = slider(scope, {
    label: 'Scroll speed',
    min: SCROLL_SPEED_MIN,
    max: SCROLL_SPEED_MAX,
    step: SCROLL_SPEED_STEP,
    value: s().scrollSpeed,
    format: (v) => v.toFixed(1),
    onInput: (v) => store.update({ scrollSpeed: v }),
  });
  refreshers.push(() => speed.set(s().scrollSpeed));
  const HUD_SIZE_LABELS: Record<HudSize, string> = {
    small: 'Small',
    medium: 'Medium',
    large: 'Large',
  };
  const hudSize = select<string>(scope, {
    label: 'HUD size',
    options: HUD_SIZES.map((v) => ({ value: v as string, label: HUD_SIZE_LABELS[v] })),
    value: s().hudSize,
    onChange: (v) => store.update({ hudSize: v as HudSize }),
  });
  refreshers.push(() => hudSize.set(s().hudSize));
  const JUDGEMENT_STYLE_LABELS: Record<JudgementStyle, string> = {
    full: 'Full',
    simple: 'Simple',
  };
  const judgementStyle = select<string>(scope, {
    label: 'Judgement style',
    options: JUDGEMENT_STYLES.map((v) => ({
      value: v as string,
      label: JUDGEMENT_STYLE_LABELS[v],
    })),
    value: s().judgementStyle,
    onChange: (v) => store.update({ judgementStyle: v as JudgementStyle }),
  });
  refreshers.push(() => judgementStyle.set(s().judgementStyle));
  const gameplay = [
    row('Scroll speed', 'How fast notes fall. In a song, F2 and F4 change it too.', speed.root),
    choiceRow(
      'Resume delay',
      'Time to get ready after choosing Resume in the pause menu.',
      'resumeDelayMs',
      RESUME_DELAYS_MS,
    ),
    choiceRow(
      'Run-in time',
      'How long play runs before a practice loop or a playtest start point.',
      'runInMs',
      RUN_IN_TIMES_MS,
    ),
    switchRow(
      'Early / late indicator',
      'Shows whether a non-perfect hit was early or late.',
      'earlyLateIndicator',
    ),
    row('HUD size', 'Size of the score and accuracy in the top-right corner.', hudSize.root),
    row(
      'Judgement style',
      'Full lets each judgement rise into place and a miss shake. Simple only fades them in and out.',
      judgementStyle.root,
    ),
    switchRow(
      'Combo colors',
      'The combo changes color as it grows: cyan from 25, green from 50, gold from 100, up to a rainbow from 500.',
      'comboColors',
    ),
    // The timing overlay is a Studio tool (no F3 in the player build).
    ...(__STUDIO__
      ? [switchRow('Debug overlay', 'Timing numbers during play (F3 in a song).', 'debugOverlay')]
      : []),
  ];

  // Timing particles: on/off, a threshold (presets or a custom value) and the text size.
  const CUSTOM = 'custom';
  const presetOf = (ms: number): string =>
    PARTICLE_THRESHOLD_PRESETS.find((p) => p.ms === ms)?.id ?? CUSTOM;
  let customThreshold = presetOf(s().timingParticleThresholdMs) === CUSTOM;
  const thresholdSlider = slider(scope, {
    label: 'Custom threshold in milliseconds',
    min: PARTICLE_THRESHOLD_MIN_MS,
    max: PARTICLE_THRESHOLD_MAX_MS,
    step: 1,
    value: s().timingParticleThresholdMs,
    format: (v) => `${v} ms`,
    onInput: (v) => {
      customThreshold = true;
      store.update({ timingParticleThresholdMs: particleThreshold(v) });
    },
  });
  const thresholdSelect = select<string>(scope, {
    label: 'Timing particle threshold',
    options: [
      ...PARTICLE_THRESHOLD_PRESETS.map((p) => ({
        value: p.id as string,
        label: p.ms === 0 ? p.label : `${p.label} (over ${p.ms} ms)`,
      })),
      { value: CUSTOM, label: 'Custom' },
    ],
    value: customThreshold ? CUSTOM : presetOf(s().timingParticleThresholdMs),
    onChange: (id) => {
      const preset = PARTICLE_THRESHOLD_PRESETS.find((p) => p.id === id);
      customThreshold = preset === undefined;
      if (preset) store.update({ timingParticleThresholdMs: preset.ms });
      refresh();
    },
  });
  const thresholdRow = row(
    'Threshold',
    'Only hits at least this far off show a particle.',
    thresholdSelect.root,
  );
  const customRow = row('Custom threshold', 'Any value from 0 to 120 ms.', thresholdSlider.root);
  refreshers.push(() => {
    const ms = s().timingParticleThresholdMs;
    thresholdSelect.set(customThreshold ? CUSTOM : presetOf(ms));
    thresholdSlider.set(ms);
    customRow.hidden = !customThreshold;
    const off = !s().timingParticles;
    thresholdRow.classList.toggle('is-disabled', off);
    customRow.classList.toggle('is-disabled', off);
    sizeRow.classList.toggle('is-disabled', off);
  });
  const SIZE_LABELS: Record<ParticleSize, string> = {
    small: 'Small',
    medium: 'Medium',
    large: 'Large',
  };
  const particleSize = select<string>(scope, {
    label: 'Timing particle size',
    options: PARTICLE_SIZES.map((v) => ({ value: v as string, label: SIZE_LABELS[v] })),
    value: s().timingParticleSize,
    onChange: (v) => store.update({ timingParticleSize: v as ParticleSize }),
  });
  refreshers.push(() => particleSize.set(s().timingParticleSize));
  const sizeRow = row('Particle size', 'Size of the timing numbers.', particleSize.root);
  gameplay.push(
    switchRow(
      'Show timing particles',
      'A number at the hit line shows how many ms early (-) or late (+) each hit was.',
      'timingParticles',
    ),
    thresholdRow,
    customRow,
    sizeRow,
  );

  // --- Controls ------------------------------------------------------------------------------

  let capturing: Lane | null = null;
  const keyError = el('p', { className: 'setting-error', attrs: { 'aria-live': 'polite' } });
  const showKeyError = (text: string): void => {
    keyError.replaceChildren(...(text ? [icon('alert'), el('span', { text })] : []));
  };
  const keyButtons = Array.from({ length: LANE_COUNT }, (_, lane) => {
    const b = el('button', { className: 'field keybind', attrs: { type: 'button' } });
    scope.listen(b, 'click', () => {
      capturing = capturing === lane ? null : (lane as Lane);
      showKeyError('');
      refresh();
    });
    return b;
  });
  refreshers.push(() => {
    keyButtons.forEach((b, lane) => {
      const active = capturing === lane;
      const code = s().laneKeys[lane] ?? '';
      b.classList.toggle('is-capturing', active);
      b.replaceChildren(
        el('span', { className: 'keybind-lane', text: `Lane ${lane + 1}` }),
        active
          ? el('span', { className: 'keybind-wait t-label', text: 'Press a key' })
          : keyCapElement(keyCap(code)),
      );
      b.setAttribute(
        'aria-label',
        active
          ? `Lane ${lane + 1}: press the new key, or Esc to cancel`
          : `Lane ${lane + 1}: ${keyLabel(code)}. Press to rebind.`,
      );
    });
  });
  const controls = [
    row(
      'Lane keys',
      'Choose a lane, then press its new key. Esc cancels. A key can only belong to one lane.',
      el('div', { className: 'keybinds' }, keyButtons),
      true,
    ),
    keyError,
    row(
      'Reset keys',
      'Back to the default keys.',
      button(scope, {
        label: 'Reset keys',
        icon: 'retry',
        onClick: () => {
          capturing = null;
          showKeyError('');
          store.update({ laneKeys: DEFAULT_LANE_KEYS });
        },
      }),
    ),
  ];

  // --- Audio ---------------------------------------------------------------------------------

  const audio = [
    volume('Master volume', 'Everything the game plays.', 'masterVolume'),
    volume('Music volume', 'The song.', 'musicVolume'),
    volume('Hit sound volume', 'The click on each hit, when hit sounds are on.', 'hitSoundVolume'),
    switchRow('Hit sounds', 'A short click on every judged hit during play.', 'hitSounds'),
  ];

  // --- Display -------------------------------------------------------------------------------

  const fullscreen = toggle(scope, {
    label: 'Fullscreen',
    checked: document.fullscreenElement !== null,
    onChange: (on) => {
      const done = on
        ? document.documentElement.requestFullscreen()
        : document.fullscreenElement
          ? document.exitFullscreen()
          : Promise.resolve();
      done.catch(() => fullscreen.set(document.fullscreenElement !== null));
    },
    disabled: !document.fullscreenEnabled,
  });
  scope.listen(document, 'fullscreenchange', () =>
    fullscreen.set(document.fullscreenElement !== null),
  );
  const scaleLabel = (v: UiScale): string =>
    v === 'auto' ? `Auto (now ${app.grid.artPixel}x)` : `${v}x`;
  const uiScale = select<string>(scope, {
    label: 'UI scale',
    options: UI_SCALES.map((v) => ({ value: String(v), label: scaleLabel(v) })),
    value: String(s().uiScale),
    onChange: (v) => store.update({ uiScale: v === 'auto' ? 'auto' : (Number(v) as UiScale) }),
  });
  refreshers.push(() => uiScale.set(String(s().uiScale)));
  const autoOption = uiScale.select.options[0];
  const unsubscribeGrid = app.grid.subscribe(() => {
    if (autoOption) autoOption.text = scaleLabel('auto');
  });
  scope.onDispose(unsubscribeGrid);
  const EFFECT_LABELS: Record<EffectsLevel, string> = { full: 'Full', minimal: 'Minimal' };
  const effects = select<string>(scope, {
    label: 'Effects',
    options: EFFECTS_LEVELS.map((v) => ({ value: v as string, label: EFFECT_LABELS[v] })),
    value: s().effects,
    onChange: (v) => store.update({ effects: v as EffectsLevel }),
  });
  refreshers.push(() => effects.set(s().effects));
  const laneGlow = slider(scope, {
    label: 'Lane glow',
    min: LANE_GLOW_MIN,
    max: LANE_GLOW_MAX,
    step: LANE_GLOW_STEP,
    value: s().laneGlow,
    format: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`),
    onInput: (v) => store.update({ laneGlow: clampLaneGlow(v) }),
  });
  refreshers.push(() => laneGlow.set(s().laneGlow));
  const frameRate = select<string>(scope, {
    label: 'Frame rate',
    options: FRAME_RATE_CHOICES.map((v) => ({ value: String(v), label: frameRateLabel(v) })),
    value: String(s().frameRateLimit),
    onChange: (v) => {
      const limit = FRAME_RATE_CHOICES.find((c) => String(c) === v);
      if (limit !== undefined) store.update({ frameRateLimit: limit });
    },
  });
  refreshers.push(() => frameRate.set(String(s().frameRateLimit)));
  // Background (Phase 21): what plays behind the lanes. The player can only choose and tune
  // here; making a song's own background is a Studio tool.
  const MODE_LABELS: Record<BackgroundMode, string> = {
    song: "Use the song's background",
    cover: 'Cover only',
    image: 'Custom image',
    off: 'Off',
  };
  const bgMode = select<string>(scope, {
    label: 'Background',
    options: BACKGROUND_MODES.map((m) => ({ value: m as string, label: MODE_LABELS[m] })),
    value: s().backgroundMode,
    onChange: (v) => store.update({ backgroundMode: v as BackgroundMode }),
  });
  // Custom picture: stored in this browser (IndexedDB), shrunk like a Studio upload.
  const imageStatus = el('span', { className: 'setting-desc' });
  const imageError = el('p', { className: 'setting-error', attrs: { 'aria-live': 'polite' } });
  let hasImage = false;
  let imageBusy = false;
  const showImage = (): void => {
    imageStatus.textContent = imageBusy
      ? 'Saving the picture...'
      : hasImage
        ? 'A picture is saved.'
        : 'No picture yet: songs use their own background.';
    removeImage.disabled = !hasImage || imageBusy;
  };
  const setImageError = (text: string): void => {
    imageError.replaceChildren(...(text ? [icon('alert'), el('span', { text })] : []));
  };
  const picker = createFilePicker(scope, app.ui, (files) => {
    const [file] = files;
    if (!file) return;
    imageBusy = true;
    setImageError('');
    showImage();
    app.library.setPlayerBackground(file, file.name).then(
      () => {
        imageBusy = false;
        hasImage = true;
        showImage();
        // Picking a picture means wanting to see it.
        store.update({ backgroundMode: 'image' });
      },
      (err: unknown) => {
        imageBusy = false;
        showImage();
        setImageError(
          err instanceof LibraryError
            ? err.errors.join(' ')
            : 'The picture could not be saved. Try another picture.',
        );
      },
    );
  });
  const removeImage = button(scope, {
    label: 'Remove',
    icon: 'trash',
    variant: 'ghost',
    onClick: () => {
      setImageError('');
      app.library.setPlayerBackground(null).then(
        () => {
          hasImage = false;
          showImage();
        },
        (err: unknown) =>
          setImageError(err instanceof LibraryError ? err.errors.join(' ') : String(err)),
      );
    },
  });
  void app.library.playerBackground().then((blob) => {
    hasImage = blob !== null;
    showImage();
  });
  showImage();
  const imageRow = row(
    'Custom image',
    'A picture of your own behind every song (at most 25 MB; it is shrunk to 1920x1080).',
    el('div', { className: 'setting-buttons' }, [
      button(scope, {
        label: 'Choose picture',
        icon: 'import',
        onClick: () => picker.open(COVER_ACCEPT, 'background'),
      }),
      removeImage,
      imageStatus,
    ]),
  );
  const dim = slider(scope, {
    label: 'Background dim',
    min: 0,
    max: Math.round(DIM_MAX * 100),
    step: 5,
    value: Math.round(s().backgroundDim * 100),
    format: (v) => `${v}%`,
    onInput: (v) => store.update({ backgroundDim: v / 100 }),
  });
  const quality = select<string>(scope, {
    label: 'Background quality',
    options: QUALITY_PRESETS.map((q) => ({ value: q as string, label: QUALITY_LABELS[q] })),
    value: s().backgroundQuality,
    onChange: (v) => store.update({ backgroundQuality: v as QualityPreset }),
  });
  refreshers.push(() => {
    const v = s();
    bgMode.set(v.backgroundMode);
    dim.set(Math.round(v.backgroundDim * 100));
    quality.set(v.backgroundQuality);
    imageRow.hidden = v.backgroundMode !== 'image';
    imageError.hidden = v.backgroundMode !== 'image';
    const off = v.backgroundMode === 'off';
    for (const r of [dimRow, motionRow, qualityRow]) r.classList.toggle('is-disabled', off);
  });
  const dimRow = row(
    'Dim',
    "Darkens the background so the notes stand out. 55% keeps each song's own dim; more or less shifts every song. The lanes always get extra shade on bright backgrounds.",
    dim.root,
  );
  const motionRow = switchRow(
    'Reduce motion',
    'Hides background particles, the only part of a background that moves. Also on when your system asks for reduced motion.',
    'backgroundReduceMotion',
  );
  const qualityRow = row(
    'Background quality',
    'The resolution the background is drawn at and how many particles it shows at once. It lowers itself if play gets slow.',
    quality.root,
  );
  const background = [
    row(
      'Background',
      "What plays behind the lanes. The song's background is the one its creator chose (or its cover); Cover only shows the song's cover instead of its picture.",
      bgMode.root,
    ),
    imageRow,
    imageError,
    dimRow,
    motionRow,
    qualityRow,
  ];

  const display = [
    ...background,
    row(
      'Frame rate',
      'Frames drawn per second during play. Match display follows your screen; a lower cap saves power. Caps above your screen and Unlimited draw from a timer: your screen still shows one frame per refresh, but the newest one is fresher. Timing is judged from the audio clock either way.',
      frameRate.root,
    ),
    row(
      'Effects',
      'Minimal softens the lane glow, keeps the combo colors still (no shine or rainbow animation) and shows judgements in the simple style.',
      effects.root,
    ),
    row(
      'Lane glow',
      'How brightly a lane lights up while its key is pressed. 100% is the default; Off turns it off.',
      laneGlow.root,
    ),
    row(
      'Fullscreen',
      document.fullscreenEnabled
        ? 'Fill the whole screen. F11 works too.'
        : 'This browser does not allow fullscreen here.',
      fullscreen.root,
    ),
    switchRow('Show FPS', 'Frames per second in the top-right corner.', 'showFps'),
    row(
      'UI scale',
      'Size of the menu pixels, in screen pixels. Auto picks from the window size.',
      uiScale.root,
    ),
  ];

  // --- Calibration ---------------------------------------------------------------------------

  const setOffset = (ms: number): void => {
    store.update({ audioOffsetMs: clampAudioOffset(ms) });
  };
  const offset = slider(scope, {
    label: 'Audio offset in milliseconds',
    min: AUDIO_OFFSET_MIN_MS,
    max: AUDIO_OFFSET_MAX_MS,
    step: 1,
    value: s().audioOffsetMs,
    format: formatOffset,
    onInput: setOffset,
  });
  refreshers.push(() => offset.set(s().audioOffsetMs));
  const calibration = [
    row(
      'Audio offset',
      'Subtracted from your key presses before judging. If you hit late, raise it (late by 30 ms: +30).',
      el('div', { className: 'offset-control' }, [
        iconButton(scope, {
          icon: 'minus',
          label: '1 ms earlier',
          onClick: () => setOffset(s().audioOffsetMs - 1),
        }),
        offset.root,
        iconButton(scope, {
          icon: 'plus',
          label: '1 ms later',
          onClick: () => setOffset(s().audioOffsetMs + 1),
        }),
      ]),
      true,
    ),
    row(
      'Reset offset',
      'Set the offset back to 0 ms.',
      button(scope, { label: 'Reset', icon: 'retry', onClick: () => setOffset(0) }),
    ),
    options.onCalibrate
      ? row(
          'Calibration test',
          'Tap along with a click track to measure your offset, then fine-tune it on falling notes.',
          button(scope, {
            label: 'Start calibration',
            icon: 'target',
            variant: 'primary',
            onClick: options.onCalibrate,
          }),
        )
      : el('p', {
          className: 'setting-note',
          text: 'The calibration test is in Settings from the main menu or song select.',
        }),
  ];

  // --- Layout --------------------------------------------------------------------------------

  const pages: Record<Category, Node[]> = { gameplay, controls, audio, display, calibration };
  const content = el('div', { className: 'settings-content', attrs: { role: 'tabpanel' } });
  const heading = el('h2', { className: 'settings-heading t-title' });
  const show = (id: Category): void => {
    lastCategory = id;
    capturing = null;
    showKeyError('');
    const cat = CATEGORIES.find((c) => c.id === id);
    heading.textContent = cat?.label ?? '';
    content.setAttribute('aria-labelledby', `tab-${id}`);
    content.id = `panel-${id}`;
    content.replaceChildren(heading, ...pages[id]);
    content.scrollTop = 0;
    refresh();
  };
  const start = options.category ?? lastCategory;
  const nav = tabs(scope, {
    label: 'Settings categories',
    orientation: app.grid.layout === 'narrow' ? 'h' : 'v',
    items: CATEGORIES,
    selected: start,
    onSelect: (id) => show(id as Category),
  });

  const back = button(scope, {
    label: 'Done',
    variant: 'primary',
    icon: 'check',
    hint: 'Escape',
    onClick: () => options.onClose(),
  });
  const root = el(
    'div',
    { className: 'panel settings-panel', attrs: { role: 'dialog', 'aria-label': 'Settings' } },
    [
      el('div', { className: 'settings-side' }, [
        el('h1', { className: 'settings-title t-title', text: 'Settings' }),
        nav.root,
      ]),
      content,
      el('div', { className: 'settings-footer' }, [
        el('span', { className: 'settings-saved' }, [
          icon('check'),
          el('span', { text: 'Changes are saved right away.' }),
        ]),
        back,
      ]),
    ],
  );

  scope.listen(root, 'keydown', (e) => {
    e.stopPropagation();
    if (capturing !== null) {
      e.preventDefault();
      const lane = capturing;
      if (e.code === 'Escape') {
        capturing = null;
        showKeyError('');
      } else {
        const result = rebindLane(s().laneKeys, lane, e.code);
        if (result.ok) {
          capturing = null;
          showKeyError('');
          store.update({ laneKeys: result.keys });
          keyButtons[lane]?.focus();
        } else {
          showKeyError(result.error);
        }
      }
      refresh();
      return;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      options.onClose();
    }
  });
  scope.listen(root, 'keyup', (e) => e.stopPropagation());
  const unsubscribe = store.subscribe(refresh);
  scope.onDispose(unsubscribe);
  show(start);

  return {
    root,
    focus: () => nav.select(lastCategory, true),
    dispose: () => {
      unsubscribe();
      unsubscribeGrid();
      root.remove();
    },
  };
}
