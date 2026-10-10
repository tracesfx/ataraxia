/**
 * Design tokens for the menus and the gameplay canvas: colour ramps, semantic colours, spacing,
 * corner cuts, motion and fonts. Every colour the UI art uses comes from these ramps;
 * `src/ui/pixel` builds the sprites from them and `applyThemeToCss` exposes them to CSS as custom
 * properties. See docs/design.md.
 *
 * Rules: long luminance ramps instead of flat colours, one accent hue (azure; its iris sibling
 * only colours gameplay notes), no pure black or white and no saturated primaries.
 */

/** Neutral cool steel, near-black to near-white with a slight blue tint (9 steps). */
const STEEL = [
  '#0b0e14',
  '#121721',
  '#1a2130',
  '#252e40',
  '#343f55',
  '#4b5870',
  '#6d7b94',
  '#9aa7bd',
  '#dce3ee',
] as const;

/** The one accent hue: a quiet azure (7 steps, dark to light). */
const ACCENT = [
  '#0c2238',
  '#123354',
  '#1a4673',
  '#245c94',
  '#3779b8',
  '#62a0d8',
  '#a6cdef',
] as const;

/**
 * The accent's quieter sibling, a soft iris (7 steps). Gameplay only: notes in the inner lanes
 * (the outer lanes use the accent), so the two note colours stay one harmonious cool family.
 */
const IRIS = ['#16173a', '#212459', '#2f3379', '#41479a', '#5a61bb', '#848ad6', '#bcc0f0'] as const;

const SUCCESS = ['#123a2e', '#1d6650', '#3a9b7a', '#86d2b3'] as const;
const WARNING = ['#43300f', '#7a5718', '#b98a34', '#ecc77c'] as const;
const DANGER = ['#451821', '#7a2836', '#b84a5c', '#ee9aa6'] as const;

/**
 * Gameplay-only ramps for the combo colour tiers and the metallic judgement text (Phase 22):
 * cyan, ember (orange) and orchid (magenta), as muted as the semantic ramps. Menus never use them.
 */
const CYAN = ['#0e3440', '#16566a', '#2a8aa3', '#7fd3e6'] as const;
const EMBER = ['#47230f', '#80401a', '#c46a2f', '#f2a774'] as const;
const ORCHID = ['#3f1538', '#70245f', '#b0479a', '#e79ad6'] as const;
/** The late timing colour: a light purple, between the iris and orchid ramps. */
const LATE_PURPLE = '#b593ea';

export const RAMPS = {
  steel: STEEL,
  accent: ACCENT,
  iris: IRIS,
  success: SUCCESS,
  warning: WARNING,
  danger: DANGER,
  cyan: CYAN,
  ember: EMBER,
  orchid: ORCHID,
} as const;

/**
 * The combo's rainbow (500+): twelve saturated hues at an even, light value, swept across the
 * digits in discrete steps. Gameplay only.
 */
export const RAINBOW: readonly string[] = [
  '#f86a6a',
  '#fa8a4a',
  '#f8b840',
  '#ecdc48',
  '#a8e44c',
  '#52dc84',
  '#3fd8c8',
  '#4cb8f4',
  '#6a8cf8',
  '#9a78f6',
  '#cc6cec',
  '#f46cb8',
];

/**
 * Metallic text ramps for gameplay (judgements, combo tiers, score), five close tones from the
 * lit top to the darker foot, so the bands read as polished metal rather than stripes. Each ends
 * on (or next to) a step of the ramps above. Gameplay only.
 */
export const METAL_RAMPS = {
  white: ['#f2f5fa', '#dce3ee', '#c4cddc', '#aeb9cb', '#9aa7bd'],
  steel: ['#e6ebf3', '#c8d1df', '#aab5c8', '#8e9bb2', '#6d7b94'],
  cyan: ['#e0f6fa', '#ade6f1', '#7fd3e6', '#52b4cb', '#2a8aa3'],
  green: ['#d8f3e8', '#ade3cd', '#86d2b3', '#5cb595', '#3a9b7a'],
  /** Teal at the top to green at the foot (Great). */
  tealGreen: ['#d6f6f1', '#9fe6db', '#72d2c2', '#5cbc96', '#3a9b7a'],
  gold: ['#fbf1d5', '#f4dca0', '#ecc77c', '#d4a650', '#b98a34'],
  ember: ['#fde0cc', '#f7c09c', '#f2a774', '#d9864f', '#c46a2f'],
  orchid: ['#f7d8f0', '#efb9e3', '#e79ad6', '#cd72ba', '#b0479a'],
  red: ['#f6c3ca', '#ee9aa6', '#d97585', '#c45a6c', '#a3475a'],
} as const satisfies Record<string, readonly string[]>;

export type RampName = keyof typeof RAMPS;
export type Ramp = readonly string[];

/** Every colour the UI may draw with (sprites are tested against this set). */
export const PALETTE: readonly string[] = [
  ...Object.values(RAMPS).flat(),
  LATE_PURPLE,
  ...RAINBOW,
  ...Object.values(METAL_RAMPS).flat(),
];

/** Tones for chips, badges and level tiers: a ramp of 4+ steps, dark to light. */
export type Tone = 'steel' | 'accent' | 'success' | 'warning' | 'danger';

/** Chart level tiers (see `levelTier`): 1-5, 6-10, 11-15, 16-20. */
export const TIER_TONES: readonly Tone[] = ['success', 'accent', 'warning', 'danger'];

/**
 * Ramps for the metallic rank letters, darkest first. Each is built from the palette ramps, so the
 * letters add no colours of their own.
 */
export const RANK_RAMPS: Readonly<Record<'S' | 'A' | 'B' | 'C' | 'D', Ramp>> = {
  S: [WARNING[0], WARNING[1], WARNING[2], WARNING[3], STEEL[8]],
  A: [ACCENT[1], ACCENT[2], ACCENT[3], ACCENT[4], ACCENT[5], ACCENT[6]],
  B: [SUCCESS[0], SUCCESS[1], SUCCESS[2], SUCCESS[3], STEEL[8]],
  C: [STEEL[2], STEEL[3], STEEL[4], STEEL[5], STEEL[6], STEEL[7], STEEL[8]],
  D: [DANGER[0], DANGER[1], DANGER[2], DANGER[3], STEEL[8]],
};

/** Semantic colours. Text colours are checked for WCAG AA against `bg` and `surface`. */
export const COLORS = {
  /** Page background (behind the ambient backdrop). */
  bg: STEEL[0],
  /** Opaque equivalent of a glass panel over the background, for contrast checks. */
  surface: STEEL[1],
  /** Raised controls (steel button face around the label). */
  control: STEEL[4],
  text: STEEL[8],
  textMuted: STEEL[7],
  /** Disabled text and decorative marks only (not for information). */
  textFaint: STEEL[6],
  /** Text on the primary (accent) button face. */
  textOnAccent: STEEL[8],
  /** Face colour behind the primary button label. */
  accentFace: ACCENT[3],
  accentText: ACCENT[6],
  successText: SUCCESS[3],
  warningText: WARNING[3],
  dangerText: DANGER[3],
  focus: ACCENT[5],
  /** Dim layer behind modals and the pause menu (alpha in `ALPHA.scrim`). */
  scrim: STEEL[0],
} as const;

/** Judgement colours (results breakdown and histogram). */
export const JUDGEMENT_COLORS = {
  perfect: ACCENT[5],
  great: SUCCESS[3],
  good: WARNING[3],
  miss: DANGER[3],
} as const;

/**
 * Timing colours (early / late hints and timing particles): orange and purple, far apart in
 * lightness and hue, so the pair stays distinct for the common colour-vision deficiencies.
 */
export const TIMING_COLORS = {
  early: EMBER[3],
  late: LATE_PURPLE,
} as const;

/** Translucency used by materials and overlays. */
export const ALPHA = {
  glass: 0.82,
  glassStrong: 0.94,
  scrim: 0.62,
} as const;

/** Spacing scale in art pixels (4/8 grid). */
export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 12: 48 } as const;

/**
 * Corner cuts (pixel-art rounding): pixels left out at each row from the corner. One scale for
 * everything: small controls `sm`, buttons and fields `md`, panels and modals `lg`.
 */
export const CUTS = {
  none: [],
  sm: [1],
  md: [2, 1],
  lg: [3, 1, 1],
} as const satisfies Record<string, readonly number[]>;

export type Cut = keyof typeof CUTS;

/** Motion durations in ms. Hover sheen 180-240, screen transitions 120-200. */
export const MOTION = {
  fast: 120,
  base: 160,
  screen: 180,
  sheen: 220,
  shine: 900,
} as const;

/**
 * Fonts. Jersey 10 (pixel font, display text and UI labels) sits on a 75/1400 em grid: one glyph
 * pixel is 18.667 px of font size, and its line box is 20 glyph pixels. Inter is for descriptions
 * and dense text. The gameplay canvas rasterises Jersey 10 into glyph atlases
 * (src/render/glyphAtlas.ts).
 */
export const FONTS = {
  pixel: "'Jersey 10', 'Inter Variable', system-ui, sans-serif",
  text: "'Inter Variable', system-ui, 'Segoe UI', sans-serif",
  /** Font size (px) at which one Jersey 10 glyph pixel is exactly one device pixel. */
  pixelEm: 1400 / 75,
  /** Line box of Jersey 10 in glyph pixels (ascent 15 + descent 5). */
  pixelLine: 20,
} as const;

/** Everything above as one typed object (the gameplay skin reads this). */
export const TOKENS = {
  ramps: RAMPS,
  colors: COLORS,
  judgement: JUDGEMENT_COLORS,
  timing: TIMING_COLORS,
  tierTones: TIER_TONES,
  rankRamps: RANK_RAMPS,
  alpha: ALPHA,
  space: SPACE,
  cuts: CUTS,
  motion: MOTION,
  fonts: FONTS,
} as const;

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * The tokens as CSS custom properties: `--steel-0`..`--steel-8`, `--accent-0`.., `--success-0`..,
 * `--c-text`, `--c-accent-text`.., `--j-perfect`.., `--space-4` (in art pixels, multiplied by
 * `--px` in CSS), `--motion-fast` (ms) and `--font-pixel` / `--font-text`.
 */
export function cssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, ramp] of Object.entries(RAMPS)) {
    ramp.forEach((hex, i) => {
      vars[`--${name}-${i}`] = hex;
    });
  }
  for (const [name, hex] of Object.entries(COLORS)) vars[`--c-${kebab(name)}`] = hex;
  for (const [name, hex] of Object.entries(JUDGEMENT_COLORS)) vars[`--j-${name}`] = hex;
  for (const [name, a] of Object.entries(ALPHA)) vars[`--alpha-${name}`] = String(a);
  for (const [name, n] of Object.entries(SPACE)) vars[`--space-${name}`] = String(n);
  for (const [name, ms] of Object.entries(MOTION)) vars[`--motion-${name}`] = `${ms}ms`;
  vars['--font-pixel'] = FONTS.pixel;
  vars['--font-text'] = FONTS.text;
  return vars;
}

/** Write the CSS custom properties onto an element (the document root at boot). */
export function applyThemeToCss(root: HTMLElement): void {
  for (const [k, v] of Object.entries(cssVariables())) root.style.setProperty(k, v);
}
