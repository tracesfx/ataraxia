import type { Chart, Lane } from '../core/chart';
import { LANE_COUNT } from '../core/constants';
import { notesFromStart, runPlan, type RunPlan } from '../core/playRange';
import { PlaySession, type JudgementEvent } from '../core/playSession';
import {
  NO_LOOP,
  clampPracticeRate,
  loopRange,
  loopRestartMs,
  notesInLoop,
  setLoopMark,
  stepPracticeRate,
  type LoopMarks,
  type LoopRange,
} from '../core/practice';
import { buildPlayResult } from '../core/results';
import { RollingAverage } from '../core/rollingAverage';
import type { ScoreSummary } from '../core/scoring';
import { keyLabel, laneBindings, stepScrollSpeed, type LaneKeys } from '../core/settings';
import { formatSongTime } from '../core/time';
import { drawDebugOverlay } from '../render/debugOverlay';
import { HUD_MARGIN, computeFieldLayout, laneCenterX } from '../render/fieldLayout';
import {
  createGameRenderer,
  type GameFrame,
  type GamePhase,
  type JudgementPopup,
  type LoopHud,
} from '../render/gameFrame';
import { LaneGlow } from '../render/laneGlow';
import { TimingParticles, shouldSpawnParticle } from '../render/timingParticles';
import type { CoverRef } from '../library/songLibrary';
import type { App } from '../ui/app';
import type { Scene, SceneScope } from '../ui/sceneManager';
import type { GameParams, PlaytestReturn } from '../ui/scenes';
import { createSettingsPanel, type SettingsPanel } from '../ui/settingsPanel';
import { el } from '../ui/dom';
import { songCard, toaster } from '../ui/components';
import { LaneInput } from './laneInput';
import { Autoplay, autoplayMode } from './dev/autoplay';
import { stressChart } from './dev/stressChart';
import { createGameBackground } from './gameBackground';
import { createGameMessage, createPracticePanel, type MessageView } from './gameHud';
import { createPauseOverlay } from './pauseOverlay';
import { inputLatencyOffsetMs } from './settings';

/** Results appear this long after the last note can be judged (or when the audio ends). */
const RESULTS_DELAY_MS = 1000;
/** A finished playtest shows its results this long, then goes back to the editor. */
export const PLAYTEST_RETURN_MS = 3000;
const TOAST_MS = 1400;
const ERROR_AVERAGE_SIZE = 20;
/** The pointer hides after this long without movement while a song plays. */
const CURSOR_HIDE_MS = 2000;
/** Practice panel: logical pixels above the bottom edge (clear of the progress labels). */
const PRACTICE_PANEL_BOTTOM = 40;

type PauseAction = 'resume' | 'restart' | 'settings' | 'quit';
const PAUSE_ACTIONS: readonly PauseAction[] = ['resume', 'restart', 'settings', 'quit'];

interface Timed<T> {
  value: T;
  atMs: number;
}

interface ChartInfo {
  title: string;
  artist: string;
  difficulty: string;
  level: number;
}

function chartInfoOf(chart: Chart | null): ChartInfo {
  return {
    title: chart?.title ?? '',
    artist: chart?.artist ?? '',
    difficulty: chart?.difficulty ?? '',
    level: chart?.level ?? 1,
  };
}

/**
 * Gameplay: plays any chart from the song library with its song's audio, in one of three modes
 * (`params.mode`):
 * - play: loading -> ready ("Press Enter") -> playing <-> paused (menu) -> results scene. Only a
 *   full play of a stored chart saves a personal best.
 * - practice: slowed playback, an A-B loop that restarts after the run-in time, and no results or
 *   saved score; the run repeats until the player quits.
 * - playtest (Studio): `chart` may replace the stored chart, and Esc or the end of play go back
 *   to the editor or Studio home (`returnTo`) after a short in-game summary instead of the
 *   results screen.
 * There is no countdown. A play from the beginning starts at the chart's effective start: if
 * that is negative, notes scroll in silently and the audio begins at song time 0. With
 * `startTimeMs` set, play runs in for the "Run-in time" setting before it and earlier notes are
 * left out. Resuming from pause waits the "Resume delay" setting, shown as a shrinking bar.
 */
export class GameScene implements Scene<GameParams> {
  constructor(private readonly app: App) {}

  enter(scope: SceneScope, params: GameParams): void {
    const { app } = this;
    const audio = app.audio;
    const cfg = (): GameSettingsView => app.settings.value;
    // The background (Phase 21): resolved per song, a canvas behind the playfield.
    const background = createGameBackground(scope, app, params.songId);
    const renderer = createGameRenderer(app.skin, background.manager);
    if (import.meta.env.DEV) {
      // For `npm run screenshots`: what the background is doing.
      const m = background.manager;
      Object.assign(window, {
        __ataraxiaBackground: () => ({
          costMs: m.lastCostMs,
          quality: m.quality,
          showing: m.showing,
          renderer: m.rendererKind,
          particles: m.lastParticleCount,
          baking: m.baking,
        }),
      });
    }
    const startTimeMs =
      params.startTimeMs === undefined ? undefined : Math.round(params.startTimeMs);
    const mode = params.mode;
    /** Playtest only: where the game goes back to (Studio home for the chart by default). */
    const returnTo: PlaytestReturn | null =
      mode === 'playtest'
        ? (params.returnTo ?? {
            scene: 'studio',
            params: { songId: params.songId, chartId: params.chartId },
          })
        : null;
    const practice = mode === 'practice';
    let practiceRate = clampPracticeRate(params.practice?.rate ?? 1);
    let marks: LoopMarks = NO_LOOP;
    /** The loop the current run was built for (null: a straight run). */
    let runLoop: LoopRange | null = null;
    /** Song time at which the current loop run restarts, for the marks as they are now. */
    let loopEndMs: number | null = null;
    /** Visual time the results appeared (playtest auto-return), or null. */
    let resultsAtVisualMs: number | null = null;
    let lastVisualMs = 0;

    let phase: GamePhase = 'loading';
    /** Loading text, or an error (the loading phase then shows it instead). */
    let message: { kind: 'loading' | 'error'; text: string } = {
      kind: 'loading',
      text: 'Loading song…',
    };
    let chart: Chart | null = null;
    let playNotes: Chart['notes'] = [];
    let buffer: AudioBuffer | null = null;
    let session = new PlaySession(playNotes);
    let popup: Timed<Omit<JudgementPopup, 'ageMs'>> | null = null;
    /** Lane glow on key presses (cosmetic, performance time). */
    const laneGlow = new LaneGlow();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    /** Dev builds only: `?combo=N` adds N to the shown combo (screenshots of the colour tiers). */
    const comboBoost = import.meta.env.DEV ? devComboBoost(window.location.search) : 0;
    let displaySongMs = startTimeMs ?? 0;
    let runId = 0;
    /** True from start() until the audio is actually running again. */
    let starting = false;
    let lastErrorMs: number | null = null;
    const errors = new RollingAverage(ERROR_AVERAGE_SIZE);
    let fps = 0;
    let fpsFrames = 0;
    let fpsSince = performance.now();
    // Combo animation triggers, in song time.
    let comboShown = 0;
    let comboBumpAtMs: number | null = null;
    let comboBreakAtMs: number | null = null;
    let brokenCombo = 0;
    // Pause menu.
    let pauseIndex = 0;
    /** While resuming: when Resume was chosen (visual ms) and how long the delay is. */
    let resuming: { atVisualMs: number; delayMs: number } | null = null;
    let overlay: { panel: SettingsPanel; host: HTMLElement } | null = null;
    const particles = new TimingParticles();
    /** Dev builds only: `?autoplay` plays perfect input (stripped from production builds). */
    const autoMode = import.meta.env.DEV ? autoplayMode(window.location.search) : null;
    const autoplay = autoMode ? new Autoplay(autoMode) : null;
    let field = computeFieldLayout(app.pixel.width, app.pixel.height);

    scope.onDispose(() => {
      audio.stop();
      if (practice) void audio.setPlaybackRate(1);
    });

    const toasts = toaster(scope, app.ui);
    const showToast = (text: string): void => toasts.show(text, 'accent', TOAST_MS);

    // Lane bindings and labels follow the settings (they can change from the pause menu).
    let bindingsFor: LaneKeys | null = null;
    let bindings: Record<string, Lane> = {};
    let labels: string[] = [];
    const currentBindings = (): Record<string, Lane> => {
      const keys = cfg().laneKeys;
      if (keys !== bindingsFor) {
        bindingsFor = keys;
        bindings = laneBindings(keys);
        labels = keys.map(keyLabel);
      }
      return bindings;
    };

    // The song card in the HUD: a DOM element (so the cover is scaled smoothly, never pixelated),
    // placed over the pixel canvas in logical pixels, left of the field.
    let songCover: CoverRef | null = null;
    let hudCard: HTMLElement | null = null;
    const practicePanel = practice ? createPracticePanel(scope, app) : null;
    const placeHud = (): void => {
      const at = app.pixel.toCss(HUD_MARGIN, HUD_MARGIN);
      if (hudCard) {
        hudCard.style.left = `${Math.round(at.left)}px`;
        hudCard.style.top = `${Math.round(at.top)}px`;
        // Scaled up from its top-left corner; the width limit is in unscaled pixels.
        const maxWidth = Math.max(
          0,
          Math.round(((field.fieldX - 2 * HUD_MARGIN) * at.px) / HUD_CARD_SCALE),
        );
        hudCard.style.maxWidth = `${maxWidth}px`;
        hudCard.style.transform = `scale(${HUD_CARD_SCALE})`;
      }
      practicePanel?.place(at.left, PRACTICE_PANEL_BOTTOM * at.px);
    };
    const showHudCard = (loadedChart: Chart): void => {
      hudCard?.remove();
      hudCard = songCard(
        { title: loadedChart.title, artist: loadedChart.artist, cover: songCover },
        { className: 'hud-song-card' },
      );
      hudCard.setAttribute('aria-hidden', 'true');
      app.ui.prepend(hudCard);
      placeHud();
    };
    scope.onDispose(
      app.pixel.onLayout((l) => {
        field = computeFieldLayout(l.width, l.height);
        placeHud();
      }),
    );
    scope.onDispose(() => hudCard?.remove());

    const given = params.chart;
    Promise.all([
      given
        ? Promise.resolve({ chart: given })
        : app.library.loadChart(params.songId, params.chartId),
      app.library.loadAudio(params.songId),
      app.library.coverOf(params.songId).catch(() => null),
    ]).then(
      ([loaded, b, cover]) => {
        if (scope.disposed) return;
        chart = loaded.chart;
        // Dev builds only: `?stress` swaps in a very dense chart to check the frame rate.
        if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('stress')) {
          chart = stressChart(chart, b.duration * 1000);
        }
        songCover = cover;
        background.setTiming(chart.bpm, chart.offsetMs);
        background.setAudio(b);
        showHudCard(chart);
        playNotes = notesFromStart(chart.notes, startTimeMs);
        session = new PlaySession(playNotes);
        // The notes wait where the run will start.
        displaySongMs = runPlan(chart, startTimeMs, cfg().runInMs).clockFromMs;
        buffer = b;
        phase = 'ready';
        // A playtest starts right away when audio is already allowed (it was in the editor).
        if (returnTo && audio.isUnlocked) void start();
      },
      (err: unknown) => {
        if (scope.disposed) return;
        console.error('Loading the chart failed:', err);
        const reason = err instanceof Error ? err.message : String(err);
        message = {
          kind: 'error',
          text: `This chart could not be loaded: ${reason} Press Esc to go back.`,
        };
      },
    );

    const handle = (events: JudgementEvent[]): void => {
      if (events.length === 0) return;
      const settings = cfg();
      for (const e of events) {
        if (e.kind === 'tap' || e.kind === 'holdHead') {
          comboBumpAtMs = e.songTimeMs;
          if (settings.hitSounds) audio.playClickNow('hit', settings.hitSoundVolume);
        }
        if ((e.kind === 'miss' || e.kind === 'holdDrop') && comboShown >= 2) {
          comboBreakAtMs = e.songTimeMs;
          brokenCombo = comboShown;
          comboShown = 0;
        }
        if (e.errorMs !== null) {
          lastErrorMs = e.errorMs;
          errors.push(e.errorMs);
          // Hold heads count like taps; notes never pressed have no error and no particle.
          if (
            shouldSpawnParticle(
              e.errorMs,
              settings.timingParticles,
              settings.timingParticleThresholdMs,
            )
          ) {
            particles.spawn(e.errorMs, laneCenterX(field, e.lane), field.hitLineY, e.songTimeMs);
          }
        }
        popup = {
          value: {
            judgement: e.judgement,
            errorMs: e.errorMs,
            dropped: e.kind === 'holdDrop',
          },
          atMs: e.songTimeMs,
        };
      }
      comboShown = session.score.combo;
    };

    const canJudge = (): boolean => phase === 'playing' && !starting && audio.state === 'playing';
    /** Song time of a key event, with the player's latency offset taken off. */
    const inputSongMs = (timeStamp: number): number =>
      audio.eventTimeToSongMs(timeStamp) - inputLatencyOffsetMs(cfg());

    const input = new LaneInput(scope, () => (overlay ? {} : currentBindings()), {
      press: (lane, timeStamp) => {
        if (phase === 'playing' || phase === 'ready')
          laneGlow.press(lane, timeStamp, cfg().effects);
        if (canJudge()) handle(session.press(lane, inputSongMs(timeStamp)));
      },
      release: (lane, timeStamp) => {
        if (canJudge()) handle(session.release(lane, inputSongMs(timeStamp)));
      },
    });

    /** Replace the session (new run or changed loop) and clear per-run effects. */
    const resetRun = (notes: Chart['notes']): void => {
      playNotes = notes;
      session = new PlaySession(playNotes);
      popup = null;
      laneGlow.clear();
      lastErrorMs = null;
      errors.clear();
      comboShown = 0;
      comboBumpAtMs = null;
      comboBreakAtMs = null;
      particles.clear();
      autoplay?.reset();
    };

    const start = async (): Promise<void> => {
      if (!buffer || !chart) return;
      // unlock() must run synchronously inside the key handler (autoplay policy).
      const unlocking = audio.unlock();
      const run = ++runId;
      const loop = practice ? loopRange(marks) : null;
      runLoop = loop;
      const runInMs = cfg().runInMs;
      // A loop runs in for the run-in time as heard (song time is slower at a lower speed).
      const plan: RunPlan = loop
        ? {
            clockFromMs: loop.startMs - Math.round(runInMs * practiceRate),
            judgeFromMs: loop.startMs,
          }
        : runPlan(chart, startTimeMs, runInMs);
      resetRun(
        loop
          ? notesInLoop(chart.notes, loop)
          : notesFromStart(chart.notes, plan.judgeFromMs ?? undefined),
      );
      displaySongMs = plan.clockFromMs;
      resultsAtVisualMs = null;
      resuming = null;
      phase = 'playing';
      starting = true;
      try {
        await unlocking;
        if (run !== runId || scope.disposed) return;
        audio.setBuffer(buffer);
        await audio.setPlaybackRate(practice ? practiceRate : 1);
        // The clock may start in negative time: the engine starts the audio exactly at song
        // time 0 on the audio clock, so the notes scroll in silently until then.
        await audio.play(plan.clockFromMs);
      } catch (err) {
        console.error('Audio start failed:', err);
        if (run !== runId) return;
        starting = false;
        phase = 'loading';
        message = {
          kind: 'error',
          text: 'The audio could not start. Click the page, then press Esc and try again.',
        };
        return;
      }
      if (run !== runId || scope.disposed) return;
      starting = false;
    };

    const pause = (): void => {
      if (phase !== 'playing') return;
      phase = 'paused';
      pauseIndex = 0;
      resuming = null;
      void audio.pause();
    };

    /** Resume after the "Resume delay" setting (the clock stays frozen until it ends). */
    const beginResume = (): void => {
      if (phase !== 'paused' || resuming !== null) return;
      const delayMs = cfg().resumeDelayMs;
      if (delayMs <= 0) finishResume();
      else resuming = { atVisualMs: lastVisualMs, delayMs };
    };

    const finishResume = (): void => {
      resuming = null;
      if (phase !== 'paused') return;
      phase = 'playing';
      void audio.resume().then(() => {
        // A practice speed changed while paused applies now.
        if (practice && phase === 'playing') void audio.setPlaybackRate(practiceRate);
      });
    };

    /** Leave the game: back to Studio after a playtest, otherwise to song select. */
    const toSongSelect = (): void => {
      runId += 1;
      if (returnTo?.scene === 'editor') void app.scenes.goTo('editor', returnTo.params);
      else if (returnTo?.scene === 'studio') void app.scenes.goTo('studio', returnTo.params);
      else void app.scenes.goTo('songSelect', { songId: params.songId, chartId: params.chartId });
    };

    const finish = (): void => {
      if (returnTo) {
        phase = 'results';
        resultsAtVisualMs = lastVisualMs;
        audio.stop();
        return;
      }
      runId += 1;
      audio.stop();
      const summary = session.summary();
      const result = buildPlayResult(session.notes, summary);
      const info = chartInfoOf(chart);
      void app.scenes.goTo('results', {
        game: params,
        result,
        chartInfo: {
          title: info.title,
          artist: info.artist,
          difficulty: info.difficulty,
          level: info.level,
          cover: songCover,
        },
        // Only full plays of a stored chart in play mode count as personal bests.
        save: mode === 'play' && !given && startTimeMs === undefined && summary.totalNotes > 0,
      });
    };

    // --- Settings overlay (pause menu) -----------------------------------------------------

    const closeSettings = (): void => {
      if (!overlay) return;
      overlay.panel.dispose();
      overlay.host.remove();
      overlay = null;
    };
    const openSettings = (): void => {
      if (overlay) return;
      const panel = createSettingsPanel(scope, app, { onClose: closeSettings });
      const host = el('div', { className: 'screen settings-screen is-overlay' }, [panel.root]);
      app.ui.appendChild(host);
      overlay = { panel, host };
      panel.focus();
    };
    scope.onDispose(closeSettings);

    const runPauseAction = (action: PauseAction): void => {
      switch (action) {
        case 'resume':
          beginResume();
          break;
        case 'restart':
          void start();
          break;
        case 'settings':
          openSettings();
          break;
        case 'quit':
          toSongSelect();
          break;
      }
    };

    // --- Practice --------------------------------------------------------------------------

    const updateLoop = (): void => {
      const loop = loopRange(marks);
      loopEndMs = loop && chart ? loopRestartMs(notesInLoop(chart.notes, loop), loop) : null;
      // Loop cleared mid-run: carry on with every note still ahead.
      if (!loop && runLoop && chart) {
        runLoop = null;
        const now = displaySongMs;
        resetRun(chart.notes.filter((n) => n.t > now));
      }
    };

    const markSongMs = (timeStamp: number): number =>
      phase === 'playing' && !starting ? audio.eventTimeToSongMs(timeStamp) : displaySongMs;

    const practiceKey = (e: KeyboardEvent): boolean => {
      if (!practice || !chart) return false;
      const inRun = phase === 'playing' || phase === 'paused';
      switch (e.code) {
        case 'BracketLeft':
        case 'BracketRight': {
          if (!inRun) return true;
          const which = e.code === 'BracketLeft' ? 'a' : 'b';
          marks = setLoopMark(marks, which, markSongMs(e.timeStamp));
          updateLoop();
          const ms = which === 'a' ? marks.aMs : marks.bMs;
          showToast(`Loop ${which.toUpperCase()} at ${formatSongTime(ms ?? 0)}`);
          return true;
        }
        case 'Backslash':
        case 'IntlBackslash':
          marks = NO_LOOP;
          updateLoop();
          showToast('Loop cleared');
          return true;
        case 'Minus':
        case 'NumpadSubtract':
        case 'Equal':
        case 'NumpadAdd': {
          const dir = e.code === 'Minus' || e.code === 'NumpadSubtract' ? -1 : 1;
          const next = stepPracticeRate(practiceRate, dir);
          if (next !== practiceRate) {
            practiceRate = next;
            if (phase === 'playing' && !starting) void audio.setPlaybackRate(practiceRate);
          }
          showToast(`Speed ${Math.round(practiceRate * 100)}%`);
          return true;
        }
        default:
          return false;
      }
    };

    // --- Keyboard --------------------------------------------------------------------------

    const pauseMenuKey = (e: KeyboardEvent): boolean => {
      switch (e.code) {
        case 'ArrowUp':
        case 'ArrowDown': {
          const step = e.code === 'ArrowDown' ? 1 : -1;
          pauseIndex = (pauseIndex + step + PAUSE_ACTIONS.length) % PAUSE_ACTIONS.length;
          return true;
        }
        case 'Enter':
        case 'NumpadEnter':
        case 'Space':
          runPauseAction(PAUSE_ACTIONS[pauseIndex] ?? 'resume');
          return true;
        case 'Escape':
          beginResume();
          return true;
        case 'KeyR':
          void start();
          return true;
        case 'KeyQ':
          toSongSelect();
          return true;
        default:
          return false;
      }
    };

    scope.listen(window, 'keydown', (e) => {
      if (overlay || e.ctrlKey || e.metaKey || e.altKey) return;
      const navigable = e.code === 'ArrowUp' || e.code === 'ArrowDown';
      if (e.repeat && !(navigable && phase === 'paused')) return;
      // The pause menu gets its keys even if they are also lane keys.
      if (phase === 'paused' && resuming === null && pauseMenuKey(e)) {
        e.preventDefault();
        return;
      }
      if (currentBindings()[e.code] !== undefined) return; // lane keys belong to LaneInput
      if (practiceKey(e)) {
        e.preventDefault();
        return;
      }
      switch (e.code) {
        case 'Enter':
        case 'NumpadEnter':
          if (phase === 'ready' || phase === 'results') void start();
          break;
        case 'Escape':
          if (returnTo) toSongSelect();
          else if (phase === 'playing') pause();
          else if (phase === 'paused')
            resuming = null; // cancel the resume, back to the menu
          else toSongSelect();
          break;
        case 'KeyR':
          if (phase === 'playing' || phase === 'results') void start();
          break;
        case 'F2':
        case 'F4': {
          const next = stepScrollSpeed(cfg().scrollSpeed, e.code === 'F4' ? 1 : -1);
          app.settings.update({ scrollSpeed: next });
          showToast(`Scroll speed ${next.toFixed(1)}`);
          break;
        }
        case 'F3':
          // The timing overlay is a Studio tool; the player build has no F3.
          if (!__STUDIO__) return;
          app.settings.update({ debugOverlay: !cfg().debugOverlay });
          break;
        default:
          return;
      }
      e.preventDefault();
    });

    // Losing focus means keyup events will never arrive: pause and forget held keys.
    const onFocusLost = (): void => {
      pause();
      input.releaseAll(performance.now());
    };
    scope.listen(window, 'blur', onFocusLost);
    scope.listen(document, 'visibilitychange', () => {
      if (document.hidden) onFocusLost();
    });

    // One frame object, mutated in place every frame (no per-frame allocation).
    currentBindings();
    const heldLanes = new Array<boolean>(LANE_COUNT).fill(false);
    const popupSlot: JudgementPopup = {
      judgement: 'perfect',
      errorMs: null,
      dropped: false,
      ageMs: 0,
    };
    const backLabel = returnTo?.scene === 'editor' ? 'the editor' : 'Studio';
    const PAUSE_ICONS: Record<PauseAction, string> = {
      resume: 'play',
      restart: 'retry',
      settings: 'settings',
      quit: 'back',
    };
    const autoInput = {
      press: (lane: Lane, songMs: number) => {
        laneGlow.press(lane, lastVisualMs, cfg().effects);
        handle(session.press(lane, songMs));
      },
      release: (lane: Lane, songMs: number) => handle(session.release(lane, songMs)),
    };
    const gameMessage = createGameMessage(scope, app);
    let resultsHint = '';
    const messageView = (): MessageView | null => {
      if (overlay) return null;
      if (phase === 'loading') return message;
      if (phase === 'ready') return { kind: 'ready', laneKeys: cfg().laneKeys };
      if (phase === 'results') return { kind: 'summary', score: frame.score, hint: resultsHint };
      return null;
    };
    const loopSlot: LoopHud = { aMs: null, bMs: null, looping: false };
    const PAUSE_LABELS: Record<PauseAction, string> = {
      resume: 'Resume',
      restart: 'Restart',
      settings: 'Settings',
      quit: returnTo
        ? `Back to ${returnTo.scene === 'editor' ? 'the editor' : 'Studio'}`
        : 'Quit to song select',
    };
    const pauseOverlay = createPauseOverlay(scope, app, {
      title: 'Paused',
      subtitle: () => (chart ? `${chart.difficulty} ${chart.level}` : ''),
      song: () => (chart ? { title: chart.title, artist: chart.artist, cover: songCover } : null),
      items: PAUSE_ACTIONS.map((a) => ({ label: PAUSE_LABELS[a], icon: PAUSE_ICONS[a] })),
      onChoose: (i) => {
        if (phase !== 'paused' || resuming !== null || overlay) return;
        pauseIndex = i;
        runPauseAction(PAUSE_ACTIONS[i] ?? 'resume');
      },
    });
    const frame: GameFrame = {
      phase,
      songTimeMs: displaySongMs,
      songDurationMs: 0,
      scrollSetting: cfg().scrollSpeed,
      notes: session.notes,
      heldLanes,
      laneGlow: laneGlow.levels,
      laneGlowStrength: cfg().laneGlow,
      score: session.summary(),
      popup: null,
      comboFx: { bumpAgeMs: null, breakAgeMs: null, brokenCombo: 0 },
      keyLabels: labels,
      visualTimeMs: 0,
      showEarlyLate: cfg().earlyLateIndicator,
      effects: cfg().effects,
      comboColors: cfg().comboColors,
      hudSize: cfg().hudSize,
      judgementStyle: cfg().judgementStyle,
      reducedMotion: reducedMotion.matches,
      particles,
      particleSize: cfg().timingParticleSize,
      loop: practice ? loopSlot : null,
      showHud: true,
    };

    // Hide the pointer after a while without movement during play.
    const rootEl = document.documentElement;
    let pointerAtMs = performance.now();
    let cursorHidden = false;
    const setCursorHidden = (hidden: boolean): void => {
      if (hidden === cursorHidden) return;
      cursorHidden = hidden;
      rootEl.classList.toggle('is-cursor-hidden', hidden);
    };
    scope.listen(window, 'pointermove', () => {
      pointerAtMs = performance.now();
      setCursorHidden(false);
    });
    scope.onDispose(() => setCursorHidden(false));

    // Paced by the player's "Frame rate" setting (read every frame, so changes apply at once).
    scope.everyFramePaced(
      () => app.settings.value.frameRateLimit,
      (visualTimeMs) => {
        lastVisualMs = visualTimeMs;
        fpsFrames += 1;
        if (visualTimeMs - fpsSince >= 500) {
          fps = (fpsFrames * 1000) / (visualTimeMs - fpsSince);
          fpsFrames = 0;
          fpsSince = visualTimeMs;
        }

        if (resuming !== null && visualTimeMs - resuming.atVisualMs >= resuming.delayMs) {
          finishResume();
        }
        if ((phase === 'playing' && !starting) || phase === 'paused') {
          displaySongMs = audio.getSongTimeMs();
        }
        const now = displaySongMs;

        if (canJudge()) {
          if (autoplay) {
            autoplay.step(session.notes, now, autoInput);
          } else {
            // A release we never saw (e.g. during a pause) still ends the hold.
            for (let lane = 0 as Lane; lane < LANE_COUNT; lane = (lane + 1) as Lane) {
              if (session.isHolding(lane) && !input.isHeld(lane))
                handle(session.release(lane, now));
            }
          }
          handle(session.update(now));
          // A playtest ends with its last note; normal play also waits for the song to end.
          const notesEndMs = session.lastJudgeableMs + RESULTS_DELAY_MS;
          const endMs =
            returnTo && playNotes.length > 0 ? notesEndMs : Math.max(audio.durationMs, notesEndMs);
          if (practice) {
            // Practice never ends: the loop (or the whole song) starts over.
            const loop = loopRange(marks);
            if (loop && loopEndMs !== null) {
              if (now >= loopEndMs) void start();
            } else if (session.finished && now >= endMs) {
              void start();
            }
          } else if (session.finished && now >= endMs) {
            finish();
          }
        }

        if (returnTo && phase === 'results' && resultsAtVisualMs !== null) {
          const leftMs = PLAYTEST_RETURN_MS - (visualTimeMs - resultsAtVisualMs);
          if (leftMs <= 0) {
            resultsAtVisualMs = null;
            toSongSelect();
          }
          const left = Math.max(1, Math.ceil(leftMs / 1000));
          resultsHint = `Back to ${backLabel} in ${left} s. Enter plays again, Esc goes back now.`;
        }

        const settings = cfg();
        const ctx = app.pixel.ctx;
        currentBindings();
        frame.phase = phase;
        frame.songTimeMs = now;
        frame.songDurationMs = audio.durationMs || (buffer ? buffer.duration * 1000 : 0);
        frame.scrollSetting = settings.scrollSpeed;
        frame.notes = session.notes;
        frame.keyLabels = labels;
        frame.showEarlyLate = settings.earlyLateIndicator;
        frame.effects = settings.effects;
        frame.comboColors = settings.comboColors;
        frame.hudSize = settings.hudSize;
        frame.judgementStyle = settings.judgementStyle;
        frame.reducedMotion = reducedMotion.matches;
        frame.particleSize = settings.timingParticleSize;
        particles.update(now);
        if (autoplay) autoplay.fillHeld(heldLanes, now);
        else input.fillHeldLanes(heldLanes);
        // A lane stays lit while its key is down (autoplay: while it presses), notes or not.
        laneGlow.update(visualTimeMs, settings.effects, heldLanes);
        frame.laneGlowStrength = settings.laneGlow;
        fillSummary(session.score, frame.score);
        if (comboBoost > 0 && phase !== 'ready') frame.score.combo += comboBoost;
        if (popup) {
          Object.assign(popupSlot, popup.value);
          popupSlot.ageMs = now - popup.atMs;
          frame.popup = popupSlot;
        } else {
          frame.popup = null;
        }
        frame.comboFx.bumpAgeMs = comboBumpAtMs === null ? null : now - comboBumpAtMs;
        frame.comboFx.breakAgeMs = comboBreakAtMs === null ? null : now - comboBreakAtMs;
        frame.comboFx.brokenCombo = brokenCombo;
        frame.visualTimeMs = visualTimeMs;
        setCursorHidden(phase === 'playing' && visualTimeMs - pointerAtMs > CURSOR_HIDE_MS);
        gameMessage.update(messageView());
        pauseOverlay.update({
          visible: phase === 'paused' && !overlay,
          selected: pauseIndex,
          resumeLeft:
            resuming === null
              ? null
              : Math.min(
                  1,
                  Math.max(0, 1 - (visualTimeMs - resuming.atVisualMs) / resuming.delayMs),
                ),
        });
        if (practicePanel) {
          loopSlot.aMs = marks.aMs;
          loopSlot.bMs = marks.bMs;
          loopSlot.looping = loopRange(marks) !== null;
          practicePanel.update({ rate: practiceRate, ...loopSlot });
        }
        renderer.draw(ctx, frame);
        if (__STUDIO__ && settings.debugOverlay) {
          drawDebugOverlay(ctx, app.skin, {
            songTimeMs: now,
            lastErrorMs,
            averageErrorMs: errors.average,
            averageCount: errors.count,
            fps,
            latencyMs: audio.latencyMs,
            offsetMs: settings.audioOffsetMs,
          });
        }
        app.pixel.present();
      },
    );
  }
}

/** The song card in the top-left corner is drawn 30 % larger than a menu song card. */
const HUD_CARD_SCALE = 1.3;

/** Dev only: the `?combo=N` boost (0 when absent or invalid). */
function devComboBoost(search: string): number {
  const n = Number(new URLSearchParams(search).get('combo'));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** The settings the game reads every frame. */
type GameSettingsView = App['settings']['value'];

/** Copy the tracker's live numbers into a reused summary object. */
function fillSummary(t: PlaySession['score'], out: ScoreSummary): void {
  out.score = t.score;
  out.accuracy = t.accuracy;
  out.combo = t.combo;
  out.maxCombo = t.maxCombo;
  out.counts.perfect = t.counts.perfect;
  out.counts.great = t.counts.great;
  out.counts.good = t.counts.good;
  out.counts.miss = t.counts.miss;
  out.judged = t.judged;
  out.totalNotes = t.totalNotes;
}
