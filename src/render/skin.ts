import type { Judgement } from '../core/judgement';
import type { ParticleSize } from '../core/settings';
import type { FieldLayout } from './fieldLayout';
import type { GlyphFont } from './glyphAtlas';

/**
 * A skin supplies every visual the gameplay renderer uses: colours, fixed-size sprites (in
 * logical pixels, sizes in `fieldLayout.ts`), glyph fonts, the static field art and the
 * fallback background layer. The renderer only blits what the skin provides. Only the built-in
 * default skin exists (procedural, src/skins/default); loadable skins are deferred, see
 * docs/skinning.md.
 */

/** Anything drawImage accepts that also knows its size. */
export type SpriteImage = HTMLCanvasElement | HTMLImageElement | ImageBitmap;

/** Note colour family: outer lanes (0 and 3) and inner lanes (1 and 2). */
export type NoteHue = 'outer' | 'inner';
export const NOTE_HUES: readonly NoteHue[] = ['outer', 'inner'];

export function laneHue(lane: number): NoteHue {
  return lane === 0 || lane === 3 ? 'outer' : 'inner';
}

export interface SkinColors {
  /** Clear colour and the colour of the window edges outside the logical image. */
  background: string;
  text: string;
  textMuted: string;
  textFaint: string;
  /** 1-pixel text shadow. */
  shadow: string;
  accentText: string;
  /** 1-pixel outline around the large gameplay text (judgements, combo, score). */
  outline: string;
  /** Judgement text: metallic vertical ramps, top row first (4-5 tones). */
  judgementRamps: Readonly<Record<Judgement, readonly string[]>>;
  /** The faint glow around a Perfect. */
  judgementGlow: string;
  early: string;
  late: string;
  /** Combo colour tiers (see `COMBO_TIERS` in the renderer): a ramp per tier, top row first. */
  comboTiers: readonly (readonly string[])[];
  /** Desaturated ramp of a broken combo. */
  comboBroken: readonly string[];
  /** The rainbow tier's hues (about 12), swept across the digits in steps. */
  rainbow: readonly string[];
  /** The combo's shine band (50+) and the sparkle pixels of a 1000+ combo. */
  comboShine: string;
  /** Lane glow on key press: a light, flat tint of the lane's note hue. */
  laneGlow: Readonly<Record<NoteHue, string>>;
  /** Glass panel behind the score and its 1-pixel top edge. */
  hudPanel: string;
  hudPanelEdge: string;
  /** Practice loop markers on the progress bar. */
  loopMarker: string;
  /** Debug overlay panel. */
  panel: string;
}

export interface SkinSprites {
  /** Tap note and hold head, NOTE_W x NOTE_H. */
  note: Readonly<Record<NoteHue, SpriteImage>>;
  /** One row of the hold body (HOLD_W x 1), stretched vertically. Idle and held. */
  holdBody: Readonly<Record<NoteHue, SpriteImage>>;
  holdBodyHeld: Readonly<Record<NoteHue, SpriteImage>>;
  /** Hold end cap at the top of the body, HOLD_W x HOLD_CAP_H. */
  holdCap: Readonly<Record<NoteHue, SpriteImage>>;
  /** One column of the progress bar (1 x PROGRESS_H), stretched horizontally. */
  progressTrack: SpriteImage;
  progressFill: SpriteImage;
}

export interface SkinFonts {
  /**
   * Labels (times, key labels) at 1x; also the source of every larger gameplay text (score,
   * accuracy, combo, judgements), drawn at whole multiples of its font pixel (`drawStyled`).
   */
  label: GlyphFont;
  /** 2x text (large timing particles, the test pattern). */
  title: GlyphFont;
  /** Timing particles, three sizes. */
  particle: Readonly<Record<ParticleSize, GlyphFont>>;
}

/** What a background layer is told each frame. */
export interface BackgroundView {
  /** Song time (may be negative; frozen while paused). Animated backgrounds follow this. */
  songTimeMs: number;
  /** rAF time, for pacing redraws only (never for motion). */
  visualTimeMs: number;
}

/**
 * Everything behind the playfield. The skin's own layer is a static gradient; the animated
 * backgrounds (src/render/background, `BackgroundManager`) implement the same interface and use
 * the skin's layer as their fallback.
 */
export interface BackgroundLayer {
  /** The logical size (or the field layout) changed: rebuild cached art. */
  resize(width: number, height: number, layout: FieldLayout): void;
  /** Draw the full logical area. */
  draw(ctx: CanvasRenderingContext2D, view: BackgroundView): void;
}

export interface Skin {
  id: string;
  name: string;
  colors: SkinColors;
  sprites: SkinSprites;
  fonts: SkinFonts;
  /** The static fallback background (the animated ones fall back to it). */
  createBackground(): BackgroundLayer;
  /**
   * Static field art for a layout: the glass panel (translucent below the hit line), lane
   * dividers, side rails, the bands toward the hit line and the judgement line. Drawn at (fieldX - RAIL_W, 0); width
   * FIELD_W + 2 * RAIL_W, height layout.height.
   */
  buildField(layout: FieldLayout): SpriteImage;
}
