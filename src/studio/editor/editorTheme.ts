import { FONTS, RAMPS } from '../../ui/theme';

/**
 * Colours for the editor canvases (timeline and minimap), in the design system's language: flat
 * colours from the theme ramps, no gradients. Grid line colours carry meaning (which subdivision
 * a line belongs to), so they keep their hues, muted to sit quietly under the notes; the snap
 * control shows the same colours.
 */
export interface EditorTheme {
  background: string;
  /** Lane fills, flat (outer lanes azure, inner lanes iris, like the gameplay notes). */
  laneBg: readonly [string, string, string, string];
  laneDivider: string;
  /** Overlay on time after the audio ends. */
  outside: string;
  /** Tint over time before the audio starts ("before song"). */
  beforeSong: string;
  /** Waveform: outer envelope and inner core (two flat tones). */
  waveOuter: string;
  waveInner: string;
  measure: string;
  /** Subdivision colour by tier (1 = beat, 2 = half beat, 4 = quarter beat, ...). */
  tiers: Readonly<Record<number, string>>;
  label: string;
  labelDim: string;
  labelBg: string;
  playhead: string;
  playheadEdge: string;
  /** The "game starts here" flag: pole, cloth bands (light to dark) and line. */
  flagPole: string;
  flagCloth: readonly string[];
  flagEdge: string;
  startLine: string;
  /** Outline of selected notes and the box selection. */
  selection: string;
  /** Previews of edits that would be rejected. */
  invalid: string;
  boxFill: string;
  /** Record-mode indicator. */
  record: string;
  /** A-B range: fill over the band, and the A/B lines and labels. */
  rangeFill: string;
  rangeEdge: string;
  /** Minimap. */
  overviewBg: string;
  overviewWindow: string;
  overviewWindowEdge: string;
  /** Note density bands, level 0 (no notes) to 4. */
  density: readonly string[];
  /** Analysis overlay: intensity area and edge, impacts, build-ups. */
  intensityFill: string;
  intensityLine: string;
  impact: string;
  buildUp: string;
  /** Outline of suggested (ghost) notes waiting for Accept or Discard. */
  suggestion: string;
  /** Minimap: the range a pending suggestion covers (fill and edges). */
  suggestionRangeFill: string;
  suggestionRangeEdge: string;
  /** Compare overlay (Phase 19): matched, missing (compare chart only), extra (mine only). */
  compareMatched: string;
  compareMissing: string;
  compareExtra: string;
  /** Analysis viewer (Phase 17). */
  analysis: AnalysisColors;
  font: string;
}

/** Colours of the analysis viewer: tracks, layers, section roles and repeat groups. */
export interface AnalysisColors {
  trackBg: readonly [string, string];
  header: string;
  headerText: string;
  separator: string;
  barLine: string;
  /** Onset layers, in LAYERS order (kick, snare, hats, bass, lead, other). */
  layers: readonly string[];
  /** Five display bands, sub to high. */
  bands: readonly string[];
  loudness: string;
  activity: string;
  intensity: string;
  rollKey: string;
  rollOctave: string;
  rollNote: string;
  rollNoteWeak: string;
  contour: string;
  run: string;
  /** Section roles: intro, verse, build-up, drop, breakdown, outro. */
  roles: Readonly<Record<string, string>>;
  /** Repeat groups cycle through these. */
  groups: readonly string[];
  silentGroup: string;
  cursor: string;
}

/**
 * Grid colour per tier, muted: beats red, 1/2 blue, 1/4 yellow, 1/3 and 1/6 purple, 1/8 orange,
 * 1/12 pink, 1/16 teal.
 */
export const TIER_COLORS: Readonly<Record<number, string>> = {
  1: '#c4616b',
  2: '#5a8fcc',
  3: '#9a7fd0',
  4: '#c7ad5c',
  6: '#9a7fd0',
  8: '#c98456',
  12: '#c274ab',
  16: '#5eb2a0',
};

export function editorTheme(): EditorTheme {
  const { steel, accent, iris, success, warning, danger } = RAMPS;
  return {
    background: steel[0],
    laneBg: [
      mix(steel[0], accent[0], 0.55),
      mix(steel[0], iris[0], 0.6),
      mix(steel[0], iris[0], 0.6),
      mix(steel[0], accent[0], 0.55),
    ],
    laneDivider: steel[2],
    outside: withAlpha(steel[0], 0.6),
    beforeSong: withAlpha(accent[2], 0.16),
    waveOuter: withAlpha(steel[6], 0.2),
    waveInner: withAlpha(steel[7], 0.3),
    measure: withAlpha(steel[8], 0.5),
    tiers: TIER_COLORS,
    label: steel[7],
    labelDim: steel[6],
    labelBg: withAlpha(steel[1], 0.92),
    playhead: accent[5],
    playheadEdge: accent[3],
    flagPole: steel[7],
    flagCloth: [steel[8], steel[7], steel[7], steel[6], steel[5]],
    flagEdge: steel[4],
    startLine: success[3],
    selection: accent[6],
    invalid: danger[3],
    boxFill: withAlpha(accent[5], 0.12),
    record: danger[3],
    rangeFill: withAlpha(warning[2], 0.08),
    rangeEdge: warning[3],
    overviewBg: steel[1],
    overviewWindow: withAlpha(accent[5], 0.2),
    overviewWindowEdge: accent[5],
    density: [steel[2], accent[2], accent[4], warning[2], danger[2]],
    intensityFill: withAlpha(warning[2], 0.6),
    intensityLine: warning[3],
    impact: danger[3],
    buildUp: withAlpha(iris[3], 0.22),
    suggestion: success[3],
    suggestionRangeFill: withAlpha(success[2], 0.22),
    suggestionRangeEdge: success[3],
    compareMatched: withAlpha(steel[7], 0.55),
    compareMissing: warning[3],
    compareExtra: iris[5],
    analysis: {
      trackBg: [mix(steel[0], steel[1], 0.55), mix(steel[0], steel[1], 0.85)],
      header: steel[1],
      headerText: steel[7],
      separator: steel[2],
      barLine: withAlpha(steel[6], 0.18),
      layers: [danger[3], warning[3], steel[7], iris[5], accent[6], success[3]],
      bands: [iris[4], accent[4], success[2], warning[2], danger[2]],
      loudness: steel[6],
      activity: warning[3],
      intensity: withAlpha(warning[2], 0.8),
      rollKey: withAlpha(steel[2], 0.55),
      rollOctave: steel[3],
      rollNote: accent[5],
      rollNoteWeak: withAlpha(accent[4], 0.6),
      contour: accent[6],
      run: withAlpha(accent[4], 0.16),
      roles: {
        intro: steel[4],
        verse: accent[3],
        'build-up': warning[1],
        drop: danger[1],
        breakdown: iris[3],
        outro: steel[3],
      },
      groups: [
        accent[3],
        warning[1],
        success[1],
        iris[3],
        danger[1],
        accent[5],
        success[2],
        iris[5],
      ],
      silentGroup: steel[2],
      cursor: withAlpha(steel[8], 0.5),
    },
    font: `${FONTS.text}`,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix two "#rrggbb" colours: t = 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const out = ca.map((v, i) => Math.round(v + ((cb[i] as number) - v) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** "#rrggbb" plus alpha as rgba(); other colour strings are returned unchanged. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
