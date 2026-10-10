import type { Lane, Note } from '../core/chart';
import { LANE_COUNT } from '../core/constants';
import {
  CALIBRATION_BEATS,
  CALIBRATION_BPM,
  CALIBRATION_LEAD_IN_BEATS,
  CALIBRATION_MAX_DEVIATION_MS,
  CALIBRATION_MIN_TAPS,
  calibrationClicks,
  computeCalibration,
  type CalibrationResult,
} from '../core/calibration';
import { PlaySession, type JudgementEvent } from '../core/playSession';
import { RollingAverage } from '../core/rollingAverage';
import { clampAudioOffset, keyLabel, laneBindings } from '../core/settings';
import { LaneInput } from '../game/laneInput';
import { inputLatencyOffsetMs } from '../game/settings';
import { createGameRenderer, type GameFrame, type JudgementPopup } from '../render/gameFrame';
import { LaneGlow } from '../render/laneGlow';
import type { App } from './app';
import { useBackdrop } from './backdrop';
import { button as uiButton, icon, iconButton, keyCapElement } from './components';
import { el } from './dom';
import { laneKeyCaps } from './keyHints';
import type { Scene, SceneScope } from './sceneManager';
import type { SceneParams } from './scenes';

type Step = 'intro' | 'tapping' | 'result' | 'finetune';

const BEAT_MS = 60_000 / CALIBRATION_BPM;
/** Taps earlier than this before the first counted click belong to the lead-in: ignored. */
const TAP_WINDOW_BEFORE_MS = BEAT_MS / 2;
/** The test ends this long after the last click. */
const TAIL_MS = 600;
/** Fine-tune loop: one note per beat for this many beats, then it starts over. */
const FINETUNE_BEATS = 32;
const FINETUNE_LEAD_IN_MS = 1500;
const PULSE_MS = 180;
const STEPS = ['Tap along', 'Result', 'Fine-tune'] as const;

/** Fine-tune pattern: a simple stair across the lanes, one tap per beat. */
function finetuneNotes(): Note[] {
  const order: Lane[] = [0, 1, 2, 3, 2, 1];
  return Array.from({ length: FINETUNE_BEATS }, (_, i) => ({
    t: Math.round(i * BEAT_MS),
    lane: order[i % order.length] as Lane,
    type: 'tap' as const,
  }));
}

/**
 * Latency calibration, in three numbered steps. 1, tap along: tap any lane key with a 120 BPM
 * click track (4 lead-in clicks, then 20 counted beats) while a pulse lights on every click; the
 * offset is the median tap error (src/core/calibration.ts). 2, result: save it or retry.
 * 3, fine-tune: a looping run of falling notes (the gameplay canvas) judged with the current
 * offset, which the arrow keys nudge 1 ms at a time. Clicks are scheduled on the audio clock;
 * taps use `event.timeStamp` like gameplay.
 */
export class CalibrationScene implements Scene<SceneParams['calibration']> {
  constructor(private readonly app: App) {}

  enter(scope: SceneScope, params: SceneParams['calibration']): void {
    const { app } = this;
    const audio = app.audio;
    const clicks = calibrationClicks();
    const lastClickMs = clicks.counted[clicks.counted.length - 1] ?? 0;

    let step: Step = 'intro';
    let runId = 0;
    let taps: number[] = [];
    let result: CalibrationResult | null = null;
    let lastTapAtMs: number | null = null;
    let session = new PlaySession(finetuneNotes());
    const recent = new RollingAverage(16);
    let lastErrorMs: number | null = null;
    let popup: { value: Omit<JudgementPopup, 'ageMs'>; atMs: number } | null = null;

    scope.onDispose(() => audio.stop());

    const back = (): void => {
      runId += 1;
      void app.scenes.goTo('settings', { returnTo: params.returnTo });
    };

    // --- DOM ---------------------------------------------------------------------------

    const stepItems = STEPS.map((label, i) =>
      el('li', { className: 'cal-step' }, [
        el('span', { className: 'cal-step-num t-label tabular', text: String(i + 1) }),
        el('span', { className: 'cal-step-label t-label', text: label }),
      ]),
    );
    const setStep = (index: number): void => {
      stepItems.forEach((li, i) => {
        li.classList.toggle('is-current', i === index);
        li.classList.toggle('is-done', i < index);
        if (i === index) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      });
    };

    const title = el('h2', { className: 'cal-title t-title' });
    const body = el('div', { className: 'cal-body' });
    const buttons = el('div', { className: 'cal-actions' });
    const card = el('section', { className: 'panel cal-card' }, [
      el('ol', { className: 'cal-steps', attrs: { 'aria-label': 'Steps' } }, stepItems),
      title,
      body,
      buttons,
    ]);
    const root = el('div', { className: 'screen calibration-screen' }, [
      el('header', { className: 'screen-header' }, [
        iconButton(scope, { icon: 'back', label: 'Back (Esc)', onClick: () => back() }),
        el('h1', { className: 'screen-title t-title', text: 'Latency calibration' }),
      ]),
      el('main', { className: 'screen-body cal-main' }, [card]),
    ]);
    app.ui.appendChild(root);
    scope.onDispose(() => root.remove());
    const backdrop = useBackdrop(scope, app, { kind: 'gradient' });

    // The pulse: a gem that lights on every click, a dot per beat and the tap count.
    const pulse = el('div', { className: 'cal-pulse', attrs: { 'aria-hidden': 'true' } }, [
      el('span', { className: 'cal-pulse-ring' }),
      el('span', { className: 'cal-pulse-core' }),
    ]);
    const beatDots = [...clicks.leadIn, ...clicks.counted].map((_, i) =>
      el('span', { className: `cal-dot${i < CALIBRATION_LEAD_IN_BEATS ? ' is-lead' : ''}` }),
    );
    const beatLabel = el('p', { className: 'cal-beat t-label' });
    const tapCount = el('p', { className: 'cal-taps tabular' });
    const pulseView = el('div', { className: 'cal-pulse-view' }, [
      pulse,
      beatLabel,
      el('div', { className: 'cal-dots' }, beatDots),
      tapCount,
    ]);

    const button = (text: string, onClick: () => void, primary = false): HTMLButtonElement =>
      uiButton(scope, { label: text, variant: primary ? 'primary' : 'secondary', onClick });
    const para = (text: string, className = 'cal-text'): HTMLElement =>
      el('p', { className, text });
    const infoRow = (label: string, value: Node): HTMLElement =>
      el('div', { className: 'cal-row' }, [
        el('span', { className: 'cal-row-label', text: label }),
        value,
      ]);
    const keysCaps = (): HTMLElement =>
      el(
        'span',
        { className: 'cal-keys' },
        laneKeyCaps(app.settings.value.laneKeys).map(keyCapElement),
      );
    const fmt = (ms: number): string => `${ms > 0 ? '+' : ''}${ms} ms`;

    const show = (heading: string, parts: Node[], actions: HTMLButtonElement[]): void => {
      title.textContent = heading;
      body.replaceChildren(...parts);
      buttons.replaceChildren(...actions);
      actions.find((a) => a.classList.contains('btn--primary'))?.focus();
    };

    /** Leave the fine-tune layout (card at the side over the playfield). */
    const leaveSide = (): void => {
      root.classList.remove('is-side');
      backdrop.show({ kind: 'gradient' });
    };

    const showIntro = (): void => {
      step = 'intro';
      leaveSide();
      setStep(0);
      show(
        'Measure your offset',
        [
          para(
            `You will hear ${CALIBRATION_LEAD_IN_BEATS} lead-in clicks, then ${CALIBRATION_BEATS} more. Tap any lane key exactly on each of the ${CALIBRATION_BEATS} counted clicks. Use the headphones or speakers you play with.`,
          ),
          infoRow('Lane keys', keysCaps()),
          infoRow(
            'Current offset',
            el('span', {
              className: 't-label tabular',
              text: fmt(app.settings.value.audioOffsetMs),
            }),
          ),
        ],
        [
          button('Start', () => startTapping(), true),
          button('Fine-tune', startFinetune),
          button('Back', back),
        ],
      );
    };

    const showResult = (): void => {
      step = 'result';
      leaveSide();
      setStep(1);
      const r = result;
      if (!r || !r.ok) {
        show(
          'Try again',
          [
            el('p', { className: 'cal-warning' }, [
              icon('alert'),
              el('span', {
                text: `Not enough steady taps. ${r ? r.validTaps : 0} of your taps were within ${CALIBRATION_MAX_DEVIATION_MS} ms of a click; at least ${CALIBRATION_MIN_TAPS} are needed.`,
              }),
            ]),
          ],
          [button('Retry', () => startTapping(), true), button('Back', back)],
        );
        return;
      }
      const saved = el('p', { className: 'cal-saved', attrs: { 'aria-live': 'polite' } });
      const save = (): void => {
        app.settings.update({ audioOffsetMs: clampAudioOffset(r.offsetMs) });
        saved.replaceChildren(
          icon('check'),
          el('span', {
            text: `Saved. Your offset is now ${fmt(app.settings.value.audioOffsetMs)}.`,
          }),
        );
      };
      show(
        'Your offset',
        [
          el('p', { className: 'cal-number t-display tabular', text: fmt(r.offsetMs) }),
          para(
            r.offsetMs > 0
              ? 'You tap after the click: presses will be moved earlier by this much.'
              : r.offsetMs < 0
                ? 'You tap before the click: presses will be moved later by this much.'
                : 'You tap right on the click.',
          ),
          para(
            `Spread ${r.spreadMs.toFixed(1)} ms (lower is steadier). ${r.validTaps} taps used, ${r.discardedTaps} ignored.`,
            'cal-text is-muted',
          ),
          saved,
        ],
        [
          button('Save', save, true),
          button('Retry', () => startTapping()),
          button('Fine-tune', startFinetune),
          button('Back', back),
        ],
      );
    };

    const finetuneOffset = el('p', { className: 'cal-number t-display tabular' });
    const finetuneStats = el('p', { className: 'cal-text is-muted' });
    const refreshFinetune = (): void => {
      finetuneOffset.textContent = fmt(app.settings.value.audioOffsetMs);
      const avg = recent.average;
      finetuneStats.textContent =
        avg === null
          ? 'Tap the notes to see your timing.'
          : `Last ${lastErrorMs === null ? '--' : fmt(Math.round(lastErrorMs))}, average ${fmt(Math.round(avg))} over ${recent.count} taps. Aim for an average near 0.`;
    };
    const nudge = (deltaMs: number): void => {
      app.settings.update({
        audioOffsetMs: clampAudioOffset(app.settings.value.audioOffsetMs + deltaMs),
      });
      recent.clear();
      lastErrorMs = null;
      refreshFinetune();
    };

    // --- Audio runs ----------------------------------------------------------------------

    const startTapping = (): void => {
      const unlocking = audio.unlock();
      const run = ++runId;
      step = 'tapping';
      taps = [];
      result = null;
      lastTapAtMs = null;
      setStep(0);
      beatDots.forEach((d) => d.classList.remove('is-past'));
      show(
        'Tap along',
        [
          pulseView,
          para(
            `Tap any lane key on every click after the ${CALIBRATION_LEAD_IN_BEATS} lead-in clicks.`,
            'cal-text is-center',
          ),
        ],
        [button('Cancel', cancelRun)],
      );
      void (async () => {
        await unlocking;
        if (run !== runId || scope.disposed) return;
        audio.setBuffer(null);
        await audio.setPlaybackRate(1);
        await audio.play((clicks.leadIn[0] ?? 0) - BEAT_MS);
        if (run !== runId || scope.disposed) return;
        clicks.leadIn.forEach((ms, i) => audio.scheduleClick(ms, i === 0));
        clicks.counted.forEach((ms) => audio.scheduleClick(ms, false));
      })().catch((err: unknown) => {
        console.error('Calibration audio failed:', err);
        if (run === runId) showIntro();
      });
    };

    /** True while a fine-tune loop (re)start is under way, so frames don't start another. */
    let restarting = false;
    const playFinetuneLoop = async (run: number): Promise<void> => {
      restarting = true;
      try {
        audio.setBuffer(null);
        await audio.setPlaybackRate(1);
        await audio.play(-FINETUNE_LEAD_IN_MS);
        if (run !== runId || scope.disposed) return;
        session = new PlaySession(finetuneNotes());
        popup = null;
        for (const rt of session.notes) audio.scheduleClick(rt.note.t, rt.index % 4 === 0);
      } finally {
        restarting = false;
      }
    };

    /** Stop a running test or fine-tune and go back to the first page. */
    const cancelRun = (): void => {
      runId += 1;
      audio.stop();
      showIntro();
    };

    function startFinetune(): void {
      const unlocking = audio.unlock();
      const run = ++runId;
      step = 'finetune';
      root.classList.add('is-side');
      // The playfield is drawn on the gameplay canvas behind the card.
      backdrop.hide();
      setStep(2);
      recent.clear();
      lastErrorMs = null;
      refreshFinetune();
      show(
        'Fine-tune',
        [
          para(
            'Play the falling notes. Left / Right (or - / +) moves the offset by 1 ms; it is saved right away.',
          ),
          infoRow('Lane keys', keysCaps()),
          finetuneOffset,
          finetuneStats,
        ],
        [
          button('-1 ms', () => nudge(-1)),
          button('+1 ms', () => nudge(1)),
          button('Done', back, true),
        ],
      );
      void unlocking.then(() => {
        if (run === runId && !scope.disposed) return playFinetuneLoop(run);
      });
    }

    // --- Input ---------------------------------------------------------------------------

    const bindings = (): Record<string, Lane> => laneBindings(app.settings.value.laneKeys);
    const laneGlow = new LaneGlow();
    const handle = (events: JudgementEvent[]): void => {
      for (const e of events) {
        if (e.errorMs !== null) {
          lastErrorMs = e.errorMs;
          recent.push(e.errorMs);
        }
        popup = {
          value: {
            judgement: e.judgement,
            errorMs: e.errorMs,
            dropped: false,
          },
          atMs: e.songTimeMs,
        };
      }
      if (events.length > 0) refreshFinetune();
    };
    const input = new LaneInput(scope, bindings, {
      press: (lane, timeStamp) => {
        if (audio.state !== 'playing') return;
        const songMs = audio.eventTimeToSongMs(timeStamp);
        if (step === 'tapping') {
          lastTapAtMs = songMs;
          if (songMs >= (clicks.counted[0] ?? 0) - TAP_WINDOW_BEFORE_MS) taps.push(songMs);
        } else if (step === 'finetune') {
          laneGlow.press(lane, timeStamp, app.settings.value.effects);
          handle(session.press(lane, songMs - inputLatencyOffsetMs(app.settings.value)));
        }
      },
      release: () => undefined,
    });

    scope.listen(window, 'keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (bindings()[e.code] !== undefined) return; // lane keys belong to LaneInput
      const onButton = e.target instanceof HTMLButtonElement;
      switch (e.code) {
        case 'Escape':
          if (step === 'tapping' || step === 'finetune') cancelRun();
          else back();
          break;
        case 'ArrowLeft':
        case 'Minus':
        case 'NumpadSubtract':
          if (step !== 'finetune') return;
          nudge(-1);
          break;
        case 'ArrowRight':
        case 'Equal':
        case 'NumpadAdd':
          if (step !== 'finetune') return;
          nudge(1);
          break;
        case 'Enter':
        case 'NumpadEnter':
          if (onButton) return; // the focused button handles it
          if (step === 'intro') startTapping();
          else return;
          break;
        default:
          return;
      }
      e.preventDefault();
    });
    scope.listen(window, 'blur', () => input.releaseAll(performance.now()));

    // --- Drawing -------------------------------------------------------------------------

    const renderer = createGameRenderer(app.skin);
    const popupSlot: JudgementPopup = {
      judgement: 'perfect',
      errorMs: null,
      dropped: false,
      ageMs: 0,
    };
    const frame: GameFrame = {
      phase: 'playing',
      songTimeMs: 0,
      songDurationMs: 0,
      scrollSetting: app.settings.value.scrollSpeed,
      notes: session.notes,
      heldLanes: new Array<boolean>(LANE_COUNT).fill(false),
      laneGlow: laneGlow.levels,
      laneGlowStrength: app.settings.value.laneGlow,
      score: session.summary(),
      popup: null,
      comboFx: { bumpAgeMs: null, breakAgeMs: null, brokenCombo: 0 },
      keyLabels: [],
      visualTimeMs: 0,
      showEarlyLate: true,
      effects: app.settings.value.effects,
      comboColors: app.settings.value.comboColors,
      hudSize: app.settings.value.hudSize,
      judgementStyle: app.settings.value.judgementStyle,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      particles: null,
      particleSize: app.settings.value.timingParticleSize,
      loop: null,
      showHud: false,
    };
    const held = frame.heldLanes as boolean[];

    /** Update the pulse view from the song clock (stepped fade, like the rest of the art). */
    const updateTapping = (now: number): void => {
      const all = [...clicks.leadIn, ...clicks.counted];
      let lastClick: number | null = null;
      let index = -1;
      all.forEach((ms, i) => {
        if (ms <= now) {
          lastClick = ms;
          index = i;
        }
      });
      const age = lastClick === null ? Infinity : now - lastClick;
      const level = age < PULSE_MS ? Math.ceil(((PULSE_MS - age) / PULSE_MS) * 3) : 0;
      pulse.dataset.level = String(level);
      pulse.classList.toggle('is-lead', index < CALIBRATION_LEAD_IN_BEATS);
      const tapAge = lastTapAtMs === null ? Infinity : now - lastTapAtMs;
      pulse.classList.toggle('is-tap', tapAge >= 0 && tapAge < PULSE_MS);
      beatDots.forEach((d, i) => d.classList.toggle('is-past', i <= index));
      const label =
        index < 0
          ? 'Listen…'
          : index < CALIBRATION_LEAD_IN_BEATS
            ? `Lead-in ${index + 1} of ${CALIBRATION_LEAD_IN_BEATS}`
            : `Beat ${index - CALIBRATION_LEAD_IN_BEATS + 1} of ${CALIBRATION_BEATS}`;
      if (beatLabel.textContent !== label) beatLabel.textContent = label;
      const count = `${taps.length} ${taps.length === 1 ? 'tap' : 'taps'}`;
      if (tapCount.textContent !== count) tapCount.textContent = count;
    };

    scope.everyFrame((ts) => {
      const now = audio.getSongTimeMs();
      if (step === 'finetune') {
        if (audio.state === 'playing' && !restarting) {
          handle(session.update(now));
          if (now > session.lastJudgeableMs + 500) void playFinetuneLoop(runId);
        }
        frame.songTimeMs = now;
        frame.notes = session.notes;
        frame.scrollSetting = app.settings.value.scrollSpeed;
        frame.keyLabels = app.settings.value.laneKeys.map(keyLabel);
        frame.score = session.summary();
        frame.visualTimeMs = ts;
        laneGlow.update(ts, frame.effects, held);
        input.fillHeldLanes(held);
        if (popup) {
          Object.assign(popupSlot, popup.value);
          popupSlot.ageMs = now - popup.atMs;
          frame.popup = popupSlot;
        } else {
          frame.popup = null;
        }
        renderer.draw(app.pixel.ctx, frame);
        app.pixel.present();
      } else if (step === 'tapping') {
        updateTapping(now);
        if (audio.state === 'playing' && now > lastClickMs + TAIL_MS) {
          audio.stop();
          result = computeCalibration(taps, clicks.counted);
          showResult();
        }
      }
    });

    showIntro();
  }
}
