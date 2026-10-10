import { scrollY } from '../core/clock';
import { LANE_COUNT } from '../core/constants';
import type { Judgement } from '../core/judgement';
import type { NoteRuntime } from '../core/playSession';
import type { HudSize } from '../core/settings';
import {
  COMBO_ALPHA,
  DIMMED_NOTE_ALPHA,
  TIER_FADE_MS,
  comboBreakAlpha,
  comboBumpOffsetY,
  comboShakeOffsetX,
  missJitterX,
  popupAlpha,
  popupOffsetY,
  tierFadeAlpha,
} from './animation';
import {
  FIELD_W,
  HOLD_CAP_H,
  HOLD_W,
  HUD_MARGIN,
  JUDGE_LINE_H,
  LANE_W,
  NOTE_H,
  NOTE_W,
  PROGRESS_H,
  RAIL_W,
  computeFieldLayout,
  laneCenterX,
  laneX,
  noteX,
  progressFillWidth,
  progressMarkerX,
  scrollPxPerMs,
  type FieldLayout,
} from './fieldLayout';
import type { GameFrame, GameRenderer } from './gameFrame';
import {
  codeBuffer,
  writeClock,
  writeFraction,
  writeInt,
  writePadded,
  writePercent,
} from './glyphMask';
import { glyphStyle, type GlyphFont, type GlyphStyle } from './glyphAtlas';
import {
  laneHue,
  type BackgroundLayer,
  type BackgroundView,
  type Skin,
  type SpriteImage,
} from './skin';
import { particleAlpha, particleDx, particleDy } from './timingParticles';

const JUDGEMENT_TEXT: Readonly<Record<Judgement, string>> = {
  perfect: 'perfect',
  great: 'great',
  good: 'good',
  miss: 'miss',
};
const DROPPED_TEXT = 'dropped';

/** Lowest combo of each colour tier (the last tier is the rainbow). */
const COMBO_TIERS = [0, 25, 50, 100, 200, 300, 500] as const;
const RAINBOW_TIER = COMBO_TIERS.length - 1;
/** 1000+ adds sparkle pixels around the digits. */
const SPARKLE_COMBO = 1000;
const COMBO_SCALE = 3;
/**
 * The combo's shine: a band leaning at 45 degrees that sweeps slowly across the digits now and
 * then, from a 50 combo. It runs on frame time with pauses of random length between sweeps, so it
 * never follows the hits. Its opacity and width step up with the combo.
 */
const SHINE_FROM = 50;
const SHINE_SWEEP_MS = 900;
const SHINE_GAP_MIN_MS = 1500;
const SHINE_GAP_SPREAD_MS = 3000;
const SHINE_LEVELS = [
  { from: 50, alpha: 0.35, width: 2 },
  { from: 100, alpha: 0.5, width: 2 },
  { from: 200, alpha: 0.65, width: 3 },
  { from: 300, alpha: 0.8, width: 3 },
  { from: 500, alpha: 0.9, width: 4 },
  { from: 1000, alpha: 1, width: 4 },
] as const;
/** The rainbow's hue step (constant: it never depends on hits). */
const RAINBOW_STEP_MS = 90;

/** Score and accuracy font-pixel scales per HUD size. */
const HUD_SCALES: Readonly<Record<HudSize, { score: number; row: number }>> = {
  large: { score: 4, row: 2 },
  medium: { score: 3, row: 2 },
  small: { score: 2, row: 1 },
};
/** Character codes of the HUD's anchor glyphs. */
const DIGIT_0 = 48;
const PERCENT = 37;
/** Least space between the note count and the accuracy on the second row. */
const ROW_MIN_GAP = 6;
const SCORE_DIGITS = 7;
const SCORE_ROLL_MS = 150;
/** Padding inside the score's glass panel. */
const PANEL_PAD_X = 7;
const PANEL_PAD_Y = 6;
const PANEL_ALPHA = 0.55;

/** Small integer hash (sparkle positions), no allocation. */
function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

function tierOf(combo: number): number {
  let t = 0;
  for (let i = 0; i < COMBO_TIERS.length; i++) if (combo >= (COMBO_TIERS[i] ?? Infinity)) t = i;
  return t;
}

/**
 * Draws gameplay from the active skin into the logical-resolution buffer. Layout follows the
 * buffer size (recomputed, and the static field art rebuilt, only when it changes). Effects sit
 * under the notes so they never hide them. The frame path does no allocation: numbers are
 * written into reusable code buffers, text styles are mutated in place, loops are indexed, and
 * every sprite and glyph tint is prebuilt.
 */
export class SkinGameRenderer implements GameRenderer {
  private readonly bg: BackgroundLayer;
  private layout: FieldLayout = computeFieldLayout(1, 1);
  private field: SpriteImage | null = null;

  /** First note that may still be visible; notes before it have scrolled off for good. */
  private cursor = 0;
  private cursorNotes: readonly NoteRuntime[] | null = null;
  private cursorSongMs = Number.NEGATIVE_INFINITY;
  private cursorSpeed = 0;

  private readonly scoreBuf = codeBuffer(12);
  private readonly scoreLeadBuf = codeBuffer(12);
  private readonly accBuf = codeBuffer(12);
  private readonly comboBuf = codeBuffer(10);
  private readonly elapsedBuf = codeBuffer(10);
  private readonly remainBuf = codeBuffer(10);
  private shownScore = -1;
  private accValue = -1;
  private comboValue = -1;
  private elapsedValue = Number.NaN;
  private remainValue = Number.NaN;

  // Score roll: from, to, and when it started (visual ms).
  private scoreFrom = 0;
  private scoreTo = 0;
  private scoreAtMs = Number.NEGATIVE_INFINITY;

  // Combo shine schedule (visual ms): the current sweep's start and when the next may start.
  private shineStartMs = Number.NEGATIVE_INFINITY;
  private nextShineMs = Number.NaN;
  private shineCount = 0;

  // Combo state, in song ms.
  private lastSongMs = Number.NEGATIVE_INFINITY;
  private tier = 0;
  private prevTier = 0;
  private tierAtMs = Number.NEGATIVE_INFINITY;

  private readonly scoreStyle: GlyphStyle;
  private readonly leadStyle: GlyphStyle;
  private readonly accStyle: GlyphStyle;
  private readonly comboStyle: GlyphStyle;
  private readonly judgeStyle: GlyphStyle;
  private readonly countBuf = codeBuffer(16);
  /** The widest the second row gets: "total/total" and "100.00%" (sized once per chart). */
  private readonly countWidestBuf = codeBuffer(16);
  private readonly accWidestBuf = writePercent(codeBuffer(12), 10000);
  private countJudged = -1;
  private countTotal = -1;
  private readonly countStyle: GlyphStyle;

  private readonly bgView: BackgroundView = { songTimeMs: 0, visualTimeMs: 0 };

  /** `background` replaces the skin's static layer (e.g. a `BackgroundManager`). */
  constructor(
    private readonly skin: Skin,
    background?: BackgroundLayer,
  ) {
    this.bg = background ?? skin.createBackground();
    const c = skin.colors;
    const f = skin.fonts;
    // Recolour every atlas now so drawing never creates a tint canvas mid-song.
    f.label.prepare(c.shadow, c.outline, c.text, c.textMuted, c.textFaint, c.early, c.late);
    f.label.prepare(c.judgementGlow, c.comboShine, ...c.comboBroken, ...c.rainbow);
    for (const j of ['perfect', 'great', 'good', 'miss'] as const)
      f.label.prepare(...c.judgementRamps[j]);
    for (const ramp of c.comboTiers) f.label.prepare(...ramp);
    f.title.prepare(c.shadow, c.text);
    for (const size of ['small', 'medium', 'large'] as const) {
      f.particle[size].prepare(c.shadow, c.early, c.late);
    }

    const outlined = (ramp: readonly string[], scale: number): GlyphStyle => {
      const st = glyphStyle(ramp, scale);
      st.outline = c.outline;
      st.shadow = c.outline;
      return st;
    };
    this.scoreStyle = outlined(c.comboTiers[0] ?? [c.text], 3);
    this.leadStyle = outlined([c.textFaint], 3);
    this.accStyle = outlined([c.textMuted], 2);
    this.comboStyle = outlined(c.comboTiers[0] ?? [c.text], COMBO_SCALE);
    this.judgeStyle = outlined(c.judgementRamps.perfect, 2);
    this.judgeStyle.rampFrom = 'x';
    this.countStyle = outlined([c.textFaint], 2);
    this.judgeStyle.shadowAlpha = 0.4;
    this.judgeStyle.glowAlpha = 0.16;
  }

  draw(ctx: CanvasRenderingContext2D, f: GameFrame): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    if (w !== this.layout.width || h !== this.layout.height || !this.field) {
      this.layout = computeFieldLayout(w, h);
      this.field = this.skin.buildField(this.layout);
      this.bg.resize(w, h, this.layout);
    }
    const l = this.layout;
    const full = f.effects === 'full';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    this.bgView.songTimeMs = f.songTimeMs;
    this.bgView.visualTimeMs = f.visualTimeMs;
    this.bg.draw(ctx, this.bgView);
    ctx.drawImage(this.field, l.fieldX - RAIL_W, 0);

    this.drawLaneGlow(ctx, f);
    this.trackCombo(f);
    if (f.phase !== 'results') {
      this.drawCombo(ctx, f, full);
      this.drawJudgement(ctx, f, full);
    }
    this.drawKeyLabels(ctx, f);
    // Feedback is drawn under the notes: it never hides what is coming.
    this.drawNotes(ctx, f);
    this.drawParticles(ctx, f);
    if (f.showHud) {
      this.drawScore(ctx, f);
      this.drawProgress(ctx, f);
    }
    ctx.globalAlpha = 1;
  }

  // --- Field --------------------------------------------------------------------------------

  /** Flat translucent columns over the pressed lanes, from the top to the bottom edge. */
  private drawLaneGlow(ctx: CanvasRenderingContext2D, f: GameFrame): void {
    const l = this.layout;
    const glow = this.skin.colors.laneGlow;
    // From the top of the field down to the judgement line (never into the area below it).
    const bottom = l.hitLineY - (JUDGE_LINE_H - 1);
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const level = Math.min(1, (f.laneGlow[lane] ?? 0) * f.laneGlowStrength);
      if (level < 0.005) continue;
      // Stepped to 1/64 so a decaying glow changes in small flat steps.
      ctx.globalAlpha = Math.ceil(level * 64) / 64;
      ctx.fillStyle = glow[laneHue(lane)];
      ctx.fillRect(laneX(l, lane) + 1, 0, LANE_W - 2, bottom);
    }
    ctx.globalAlpha = 1;
  }

  /** Key labels under the judgement line, before the song starts. */
  private drawKeyLabels(ctx: CanvasRenderingContext2D, f: GameFrame): void {
    if (f.phase !== 'ready' && f.phase !== 'loading') return;
    const l = this.layout;
    const c = this.skin.colors;
    const label = this.skin.fonts.label;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const key = f.keyLabels[lane];
      if (key === undefined) continue;
      const held = f.heldLanes[lane] === true;
      label.draw(
        ctx,
        key,
        laneCenterX(l, lane),
        l.hitLineY + 10,
        held ? c.text : c.textMuted,
        c.shadow,
        'center',
      );
    }
  }

  private drawNotes(ctx: CanvasRenderingContext2D, f: GameFrame): void {
    const l = this.layout;
    const notes = f.notes;
    const speed = scrollPxPerMs(f.scrollSetting, l.hitLineY);
    if (
      notes !== this.cursorNotes ||
      f.songTimeMs < this.cursorSongMs ||
      speed !== this.cursorSpeed
    ) {
      this.cursor = 0;
      this.cursorNotes = notes;
      this.cursorSpeed = speed;
    }
    this.cursorSongMs = f.songTimeMs;
    const now = f.songTimeMs;
    const bottom = l.noteClipBottom;

    // Skip the prefix of notes whose end has scrolled below the field; time only moves forward.
    while (this.cursor < notes.length) {
      const n = (notes[this.cursor] as NoteRuntime).note;
      const endT = n.type === 'hold' ? n.t + n.dur : n.t;
      if (scrollY(endT, now, l.hitLineY, speed) - NOTE_H > bottom) this.cursor += 1;
      else break;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(l.fieldX, 0, FIELD_W, bottom);
    ctx.clip();
    for (let i = this.cursor; i < notes.length; i++) {
      const rt = notes[i] as NoteRuntime;
      const headY = Math.round(scrollY(rt.note.t, now, l.hitLineY, speed));
      if (headY + NOTE_H / 2 < 0) break; // sorted by time: everything after is higher still
      if (rt.status === 'hit' || rt.status === 'completed') continue;
      if (rt.note.type === 'hold') this.drawHold(ctx, rt, headY, now, speed);
      else if (headY - NOTE_H / 2 <= bottom) {
        ctx.globalAlpha = rt.status === 'missed' ? DIMMED_NOTE_ALPHA : 1;
        ctx.drawImage(
          this.skin.sprites.note[laneHue(rt.note.lane)],
          noteX(l, rt.note.lane),
          headY - NOTE_H / 2,
        );
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawHold(
    ctx: CanvasRenderingContext2D,
    rt: NoteRuntime,
    headY: number,
    now: number,
    speed: number,
  ): void {
    const note = rt.note;
    if (note.type !== 'hold') return;
    const l = this.layout;
    const s = this.skin.sprites;
    const hue = laneHue(note.lane);
    const x = noteX(l, note.lane);
    const bodyX = x + (NOTE_W - HOLD_W) / 2;
    const tailY = Math.round(scrollY(note.t + note.dur, now, l.hitLineY, speed));
    if (tailY - HOLD_CAP_H > l.noteClipBottom) return;

    const holding = rt.status === 'holding';
    const dropped = rt.status === 'dropped';
    let bodyBottom = headY;
    let drawHead = true;
    if (holding) {
      // The head has been hit: only the body is left, ending at the judgement line.
      bodyBottom = Math.min(headY, l.hitLineY);
      drawHead = false;
    } else if (dropped) {
      // Only the part that was never held keeps scrolling, dimmed and headless.
      bodyBottom = Math.round(scrollY(rt.changedAtMs, now, l.hitLineY, speed));
      drawHead = false;
    }
    ctx.globalAlpha = dropped || rt.status === 'missed' ? DIMMED_NOTE_ALPHA : 1;
    const top = Math.max(-1, tailY);
    const end = Math.min(bodyBottom, l.noteClipBottom);
    if (end > top)
      ctx.drawImage(holding ? s.holdBodyHeld[hue] : s.holdBody[hue], bodyX, top, HOLD_W, end - top);
    ctx.drawImage(s.holdCap[hue], bodyX, tailY - HOLD_CAP_H);
    if (drawHead) {
      const headTop = bodyBottom - NOTE_H / 2;
      ctx.drawImage(s.note[hue], x, headTop);
    }
  }

  // --- Feedback ------------------------------------------------------------------------------

  private drawJudgement(ctx: CanvasRenderingContext2D, f: GameFrame, full: boolean): void {
    const pop = f.popup;
    if (!pop) return;
    const age = pop.ageMs;
    const j: Judgement = pop.dropped ? 'miss' : pop.judgement;
    const fancy = full && f.judgementStyle === 'full' && !f.reducedMotion;
    const alpha = popupAlpha(age, !fancy || j === 'good');
    if (alpha <= 0) return;
    const l = this.layout;
    const c = this.skin.colors;
    const font = this.skin.fonts.label;
    const text = pop.dropped ? DROPPED_TEXT : JUDGEMENT_TEXT[j];
    // Every judgement keeps the label size; Perfect and Great rise into place by whole pixels.
    const scale = 1;
    const rises = fancy && (j === 'perfect' || j === 'great');
    const baseline = l.judgementY + (rises ? popupOffsetY(age) : 0);
    const capTopY = baseline - font.capHeight * scale;
    const cx = l.fieldX + FIELD_W / 2 + (f.reducedMotion ? 0 : j === 'miss' ? missJitterX(age) : 0);

    const st = this.judgeStyle;
    st.scale = scale;
    st.ramp = c.judgementRamps[j];
    st.shine = null;
    // A Perfect gets a faint, barely there glow in its own gold.
    st.glow = j === 'perfect' && !pop.dropped ? c.judgementGlow : null;
    ctx.globalAlpha = alpha;
    font.drawStyledText(ctx, text, cx, capTopY, 'center', st);

    if (
      f.showEarlyLate &&
      pop.errorMs !== null &&
      pop.judgement !== 'perfect' &&
      pop.judgement !== 'miss'
    ) {
      // Small and low contrast, just above the word.
      const early = pop.errorMs < 0;
      ctx.globalAlpha = alpha * 0.7;
      font.draw(
        ctx,
        early ? 'early' : 'late',
        cx,
        baseline - font.capHeight * scale - font.capHeight - 4,
        early ? c.early : c.late,
        c.shadow,
        'center',
      );
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Where the current shine sweep is (0-1), or -1 between sweeps. Sweeps start after pauses of
   * random length (hashed from a counter, so no allocation and no Math.random in the frame loop).
   */
  private shineProgress(nowMs: number): number {
    if (Number.isNaN(this.nextShineMs) || nowMs < this.shineStartMs) {
      this.nextShineMs = nowMs + SHINE_GAP_MIN_MS / 2;
    }
    if (nowMs - this.shineStartMs >= SHINE_SWEEP_MS && nowMs >= this.nextShineMs) {
      this.shineStartMs = nowMs;
      this.shineCount += 1;
      const gap = SHINE_GAP_MIN_MS + (hash(this.shineCount) % SHINE_GAP_SPREAD_MS);
      this.nextShineMs = nowMs + SHINE_SWEEP_MS + gap;
    }
    const p = (nowMs - this.shineStartMs) / SHINE_SWEEP_MS;
    return p >= 0 && p < 1 ? p : -1;
  }

  /** Combo bookkeeping each frame: colour tier changes (song ms). */
  private trackCombo(f: GameFrame): void {
    const now = f.songTimeMs;
    const combo = f.score.combo;
    if (now < this.lastSongMs) {
      this.tier = 0;
      this.prevTier = 0;
      this.tierAtMs = Number.NEGATIVE_INFINITY;
    }
    this.lastSongMs = now;
    const tier = f.comboColors ? tierOf(combo) : 0;
    if (tier !== this.tier) {
      // Only climbing tiers cross-fade; a break drops straight back.
      this.prevTier = tier > this.tier ? this.tier : tier;
      this.tierAtMs = tier > this.tier ? now : Number.NEGATIVE_INFINITY;
      this.tier = tier;
    }
  }

  /** Point the combo style at a tier (the rainbow animates only when `animated`). */
  private setTier(tier: number, animated: boolean, songMs: number): void {
    const c = this.skin.colors;
    const st = this.comboStyle;
    st.ramp = c.comboTiers[tier] ?? c.comboTiers[0] ?? [c.text];
    st.glyphColours = null;
    if (tier === RAINBOW_TIER && animated) {
      // A stepped hue sweep flowing left to right at a constant pace.
      st.glyphColours = c.rainbow;
      st.glyphPhase = -Math.floor(songMs / RAINBOW_STEP_MS);
      st.glyphStep = 2;
    }
  }

  private drawCombo(ctx: CanvasRenderingContext2D, f: GameFrame, full: boolean): void {
    const l = this.layout;
    const c = this.skin.colors;
    const font = this.skin.fonts.label;
    const cx = l.fieldX + FIELD_W / 2;
    const now = f.songTimeMs;
    const combo = f.score.combo;
    const fx = f.comboFx;
    const st = this.comboStyle;
    const animated = full && !f.reducedMotion;
    const baseH = font.capHeight * COMBO_SCALE;
    if (combo >= 2) {
      if (combo !== this.comboValue) {
        this.comboValue = combo;
        writeInt(this.comboBuf, combo);
      }
      // Always the same size; the bump only nudges it up by a pixel or two.
      const bump = animated && fx.bumpAgeMs !== null ? comboBumpOffsetY(fx.bumpAgeMs) : 0;
      const y = l.comboY + bump;
      const n = this.comboBuf.length;
      const textW = font.measureScaled(this.comboBuf.codes, n, COMBO_SCALE);
      st.scale = COMBO_SCALE;
      st.shine = null;
      const tierAge = now - this.tierAtMs;
      if (tierAge < TIER_FADE_MS) {
        ctx.globalAlpha = COMBO_ALPHA;
        this.setTier(this.prevTier, animated, now);
        font.drawStyled(ctx, this.comboBuf.codes, n, cx, y, 'center', st);
        ctx.globalAlpha = COMBO_ALPHA * tierFadeAlpha(tierAge);
      } else {
        ctx.globalAlpha = COMBO_ALPHA;
      }
      this.setTier(this.tier, animated, now);
      if (animated && combo >= SHINE_FROM) {
        let level: (typeof SHINE_LEVELS)[number] = SHINE_LEVELS[0];
        for (let i = 0; i < SHINE_LEVELS.length; i++) {
          const lv = SHINE_LEVELS[i];
          if (lv && combo >= lv.from) level = lv;
        }
        const p = this.shineProgress(f.visualTimeMs);
        if (p >= 0) {
          // Travel from fully left of the digits to fully right, the lean included.
          const lean = font.cellHeight * COMBO_SCALE;
          const travel = textW + lean + 2 * level.width;
          st.shine = c.comboShine;
          st.shineAlpha = level.alpha;
          st.shineW = level.width;
          st.shineX = Math.floor(p * travel) - lean - level.width;
        }
      }
      font.drawStyled(ctx, this.comboBuf.codes, n, cx, y, 'center', st);
      st.shine = null;
      ctx.globalAlpha = COMBO_ALPHA;
      if (animated && combo >= SPARKLE_COMBO) this.drawComboSparkles(ctx, now, cx, y, textW, baseH);
      ctx.globalAlpha = 1;
      return;
    }
    if (fx.breakAgeMs === null || fx.brokenCombo < 2) return;
    const alpha = comboBreakAlpha(fx.breakAgeMs);
    if (alpha <= 0) return;
    if (fx.brokenCombo !== this.comboValue) {
      this.comboValue = fx.brokenCombo;
      writeInt(this.comboBuf, fx.brokenCombo);
    }
    // Desaturated to steel, shaking, then gone.
    st.scale = COMBO_SCALE;
    st.ramp = c.comboBroken;
    st.glyphColours = null;
    st.shine = null;
    ctx.globalAlpha = alpha * COMBO_ALPHA;
    const x = cx + (f.reducedMotion ? 0 : comboShakeOffsetX(fx.breakAgeMs));
    font.drawStyled(ctx, this.comboBuf.codes, this.comboBuf.length, x, l.comboY, 'center', st);
    ctx.globalAlpha = 1;
  }

  /** 1000+: a few sparkle pixels twinkling around the digits. */
  private drawComboSparkles(
    ctx: CanvasRenderingContext2D,
    now: number,
    cx: number,
    top: number,
    textW: number,
    textH: number,
  ): void {
    const period = 420;
    ctx.fillStyle = this.skin.colors.comboShine;
    for (let i = 0; i < 6; i++) {
      const t = now + i * 70;
      const cycle = Math.floor(t / period);
      const a = t - cycle * period;
      if (a >= 260) continue;
      const r = hash(cycle * 13 + i);
      const sx = Math.round(cx - textW / 2 - 6 + (r % (Math.round(textW) + 12)));
      const sy = Math.round(top - 5 + ((r >>> 12) % (textH + 10)));
      ctx.fillRect(sx, sy, 1, 1);
      if (a < 160) {
        ctx.fillRect(sx - 1, sy, 1, 1);
        ctx.fillRect(sx + 1, sy, 1, 1);
        ctx.fillRect(sx, sy - 1, 1, 1);
        ctx.fillRect(sx, sy + 1, 1, 1);
      }
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, f: GameFrame): void {
    const pool = f.particles;
    if (!pool) return;
    const font: GlyphFont = this.skin.fonts.particle[f.particleSize];
    const c = this.skin.colors;
    const slots = pool.slots;
    for (let i = 0; i < slots.length; i++) {
      const p = slots[i];
      if (!p?.active) continue;
      const age = f.songTimeMs - p.bornMs;
      const alpha = particleAlpha(age);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      font.drawCodes(
        ctx,
        p.text,
        p.x0 + particleDx(p, age),
        p.y0 + particleDy(age) - Math.floor(font.capHeight / 2),
        p.timing === 'early' ? c.early : c.late,
        c.shadow,
        'center',
      );
    }
    ctx.globalAlpha = 1;
  }

  // --- HUD -----------------------------------------------------------------------------------

  /** The score's displayed value: rolls up to a new score over SCORE_ROLL_MS (visual time). */
  private rolledScore(score: number, visualMs: number): number {
    if (score !== this.scoreTo) {
      if (score < this.scoreTo || !Number.isFinite(this.scoreAtMs)) {
        this.scoreFrom = score; // a restart (or the first frame) snaps
      } else {
        this.scoreFrom = this.rolledAt(visualMs);
      }
      this.scoreTo = score;
      this.scoreAtMs = visualMs;
    }
    return this.rolledAt(visualMs);
  }

  private rolledAt(visualMs: number): number {
    const t = (visualMs - this.scoreAtMs) / SCORE_ROLL_MS;
    if (!(t < 1)) return this.scoreTo;
    if (t <= 0) return this.scoreFrom;
    const eased = 1 - (1 - t) * (1 - t);
    return Math.round(this.scoreFrom + (this.scoreTo - this.scoreFrom) * eased);
  }

  private drawScore(ctx: CanvasRenderingContext2D, f: GameFrame): void {
    const l = this.layout;
    const c = this.skin.colors;
    const s = f.score;
    const font = this.skin.fonts.label;
    const shown = this.rolledScore(s.score, f.visualTimeMs);
    if (shown !== this.shownScore) {
      this.shownScore = shown;
      writePadded(this.scoreBuf, shown, SCORE_DIGITS);
      // The significant digits (drawn over the dim leading zeros).
      writeInt(this.scoreLeadBuf, shown);
    }
    const acc = Math.round(s.accuracy * 100);
    if (acc !== this.accValue) {
      this.accValue = acc;
      writePercent(this.accBuf, acc);
    }

    if (s.judged !== this.countJudged || s.totalNotes !== this.countTotal) {
      if (s.totalNotes !== this.countTotal)
        writeFraction(this.countWidestBuf, s.totalNotes, s.totalNotes);
      this.countJudged = s.judged;
      this.countTotal = s.totalNotes;
      writeFraction(this.countBuf, s.judged, s.totalNotes);
    }

    // The largest score scale up to the setting that fits right of the field.
    const want = HUD_SCALES[f.hudSize];
    const room = l.width - (l.fieldX + FIELD_W + RAIL_W) - 2 * HUD_MARGIN - 2 * PANEL_PAD_X;
    const sb = this.scoreBuf;
    const n = sb.length;
    let scale = want.score;
    while (scale > 1 && font.measureScaled(sb.codes, n, scale) > room) scale -= 1;
    const scoreW = font.measureScaled(sb.codes, n, scale);
    // The score's inked edges, measured on "0" (the widest digit) rather than on whichever
    // digits are showing, so the anchors never move as the numbers change.
    const scoreInkL = font.inkLeft(DIGIT_0) * scale;
    const scoreInkR = font.inkRightGap(DIGIT_0) * scale;
    const scoreInkW = scoreW - scoreInkL - scoreInkR;

    // Second row: the note count starts where the score's ink starts and the accuracy ends
    // where it ends; its size is the largest whose widest form still fits between them.
    let rowScale = Math.min(want.row, Math.max(1, scale - 1));
    while (rowScale > 1 && this.rowInkWidth(font, rowScale) > scoreInkW) rowScale -= 1;
    const scoreH = font.capHeight * scale;
    const rowH = font.capHeight * rowScale;
    const gap = 3 + 2 * rowScale;

    // Glass backing panel with cut corners and a lit top edge, sized by the score.
    const panelW = scoreW + 2 * PANEL_PAD_X;
    const panelH = scoreH + gap + rowH + 2 * PANEL_PAD_Y + 2;
    const px = l.width - HUD_MARGIN - panelW;
    const py = HUD_MARGIN;
    ctx.globalAlpha = PANEL_ALPHA;
    ctx.fillStyle = c.hudPanel;
    ctx.fillRect(px + 1, py, panelW - 2, panelH);
    ctx.fillRect(px, py + 1, 1, panelH - 2);
    ctx.fillRect(px + panelW - 1, py + 1, 1, panelH - 2);
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = c.hudPanelEdge;
    ctx.fillRect(px + 1, py, panelW - 2, 1);
    ctx.globalAlpha = 1;

    const right = px + panelW - PANEL_PAD_X;
    const left = right - scoreW;
    const top = py + PANEL_PAD_Y + 1;
    this.leadStyle.scale = scale;
    font.drawStyled(ctx, sb.codes, n, right, top, 'right', this.leadStyle);
    if (shown > 0) {
      this.scoreStyle.scale = scale;
      font.drawStyled(
        ctx,
        this.scoreLeadBuf.codes,
        this.scoreLeadBuf.length,
        right,
        top,
        'right',
        this.scoreStyle,
      );
    }
    const rowY = top + scoreH + gap;
    const ab = this.accBuf;
    const accRight = right - scoreInkR + font.inkRightGap(PERCENT) * rowScale;
    this.accStyle.scale = rowScale;
    font.drawStyled(ctx, ab.codes, ab.length, accRight, rowY, 'right', this.accStyle);
    const cb = this.countBuf;
    const countLeft = left + scoreInkL - font.inkLeft(DIGIT_0) * rowScale;
    this.countStyle.scale = rowScale;
    font.drawStyled(ctx, cb.codes, cb.length, countLeft, rowY, 'left', this.countStyle);
  }

  /** Inked width of the second row at its widest ("total/total", the gap, "100.00%"). */
  private rowInkWidth(font: GlyphFont, k: number): number {
    const cw = this.countWidestBuf;
    const aw = this.accWidestBuf;
    return (
      font.measureScaled(cw.codes, cw.length, k) -
      font.inkLeft(DIGIT_0) * k +
      ROW_MIN_GAP +
      font.measureScaled(aw.codes, aw.length, k) -
      font.inkRightGap(PERCENT) * k
    );
  }

  private drawProgress(ctx: CanvasRenderingContext2D, f: GameFrame): void {
    const l = this.layout;
    const s = this.skin.sprites;
    const c = this.skin.colors;
    const y = l.progressY;
    const w = l.width;
    ctx.globalAlpha = f.phase === 'paused' ? 0.45 : 1;
    ctx.drawImage(s.progressTrack, 0, 0, 1, PROGRESS_H, 0, y, w, PROGRESS_H);
    const dur = f.songDurationMs;
    const fill = progressFillWidth(f.songTimeMs, dur, w);
    if (fill > 0) ctx.drawImage(s.progressFill, 0, 0, 1, PROGRESS_H, 0, y, fill, PROGRESS_H);

    const loop = f.loop;
    if (loop && dur > 0) {
      ctx.fillStyle = c.loopMarker;
      if (loop.aMs !== null && loop.bMs !== null && loop.looping) {
        const a = progressMarkerX(loop.aMs, dur, w);
        const b = progressMarkerX(loop.bMs, dur, w);
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = prev * 0.35;
        ctx.fillRect(Math.min(a, b), y, Math.abs(b - a) + 1, PROGRESS_H);
        ctx.globalAlpha = prev;
      }
      if (loop.aMs !== null)
        ctx.fillRect(progressMarkerX(loop.aMs, dur, w), y - 4, 1, PROGRESS_H + 4);
      if (loop.bMs !== null)
        ctx.fillRect(progressMarkerX(loop.bMs, dur, w), y - 4, 1, PROGRESS_H + 4);
    }

    // Elapsed and remaining time above the ends of the bar.
    if (dur > 0) {
      const elapsed = Math.floor(Math.max(0, f.songTimeMs) / 1000);
      const remain = Math.ceil(Math.max(0, dur - Math.max(0, f.songTimeMs)) / 1000);
      if (elapsed !== this.elapsedValue) {
        this.elapsedValue = elapsed;
        writeClock(this.elapsedBuf, elapsed);
      }
      if (remain !== this.remainValue) {
        this.remainValue = remain;
        writeClock(this.remainBuf, -remain);
      }
      const font = this.skin.fonts.label;
      const ty = y - 4 - font.capHeight - 3;
      font.drawCodes(ctx, this.elapsedBuf, 6, ty, c.textMuted, c.shadow, 'left');
      font.drawCodes(ctx, this.remainBuf, w - 6, ty, c.textMuted, c.shadow, 'right');
    }
    ctx.globalAlpha = 1;
  }
}
