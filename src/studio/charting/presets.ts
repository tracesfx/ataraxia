import {
  ACTIVITY_LABELS,
  ACTIVITY_PARTS,
  DEFAULT_ACTIVITY_WEIGHTS,
  LAYERS,
  LAYER_LABELS,
  SECTION_LABELS,
  type ActivityWeights,
  type LayerId,
  type SectionRole,
} from './analysis/types';

/**
 * Every setting of the Phase 18 note generator (`GeneratorParams`), the difficulty presets that
 * fill them in, sanitising (saved settings and imported presets), and the control definitions
 * the Suggest panel builds its groups from. Pure data: no DOM. See docs/charting.md.
 */

export const DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const ROLES = ['intro', 'verse', 'build-up', 'drop', 'breakdown', 'outro'] as const;

/** Finest grid (divisions per beat) the rhythm may be quantised to. */
export const FINEST_DIVISIONS = [2, 4, 8, 16] as const;
export type FinestDivision = (typeof FINEST_DIVISIONS)[number];

export interface GeneratorParams {
  // --- Density plan -------------------------------------------------------------------------
  /** Notes per second in the calmest parts that have sound (a floor, never zero). */
  baseNps: number;
  /** Sustained notes per second in the most active parts (bar-long windows). */
  peakNps: number;
  /** Notes per second allowed in windows of one beat or less (lead runs, fills). */
  burstNps: number;
  /** Hard ceiling: no two hits closer than 1000 / ceilingNps ms. */
  ceilingNps: number;
  /** Curve shape: activity^gamma (above 1 keeps density low longer, below 1 rises early). */
  gamma: number;
  /** 0-1: how far the curve is pushed apart (0 flat around the song's middle, 1 extreme). */
  contrast: number;
  /** Multiplies the whole plan. */
  multiplier: number;
  /** At least one note this often (beats) wherever there is sound. */
  floorBeats: number;
  /** In intense parts, no gap longer than this (beats). */
  maxGapBeats: number;
  /** 0-1 activity (relative to the song) above which a part counts as intense. */
  intenseThreshold: number;
  /** Also put beat notes in silent parts. */
  fillSilence: boolean;
  /** Density multiplier per section role. */
  roles: Record<SectionRole, number>;
  // --- Rhythm sources -----------------------------------------------------------------------
  /** Salience weight per onset layer (the lead also gets a priority bonus). */
  layerWeights: Record<LayerId, number>;
  /** 0-1: higher keeps weaker lead onsets in the spine. */
  leadSensitivity: number;
  /** 0-1: how strongly dense lead runs are charted one to one (and may reach the burst rate). */
  leadRunPriority: number;
  /** 0-1: how much the other layers add notes and chords around the spine. */
  secondaryAmount: number;
  /** 0-1: higher drops onsets far from the phrase grid instead of snapping them. */
  quantStrictness: number;
  /** 0-1: how readily a phrase uses a triplet grid (1/12, 1/6, 1/3). 0 = never. */
  oddGrids: number;
  finestDivision: FinestDivision;
  // --- Musical activity ---------------------------------------------------------------------
  activity: ActivityWeights;
  // --- Repetition ---------------------------------------------------------------------------
  /** 0-1: how strictly repeated phrases share one rhythm (1 = exactly the consensus). */
  repeatLock: number;
  /** 0-1: extra notes each repeat may add on top of the shared rhythm. */
  variation: number;
  /** 0-1: how often a repeat varies the shared lane sequence (mirrored bars). */
  laneVariation: number;
  // --- Holds --------------------------------------------------------------------------------
  /** 0-1: how readily sustained sounds become holds. */
  holdAmount: number;
  /** 0-1: preference for short holds (under a beat) over long ones. */
  shortHoldShare: number;
  /** Shortest hold, beats (never under 120 ms). */
  minHoldBeats: number;
  /** Longest hold, beats. */
  maxHoldBeats: number;
  /** Most holds down at once. */
  maxHolds: number;
  /** Snap hold ends to the phrase grid. */
  alignReleases: boolean;
  // --- Lane behaviour -----------------------------------------------------------------------
  /** Weight of hand and finger comfort (alternate hands at speed). */
  ergonomics: number;
  /** 0-1: same lane at short gaps. 0 = never faster than 1/8, 1 = free. */
  jack: number;
  /** 0-1: alternating two lanes. */
  trill: number;
  /** 0-1: moving one lane at a time in one direction. */
  stair: number;
  /** 0-1: higher lead pitch maps to a higher lane. */
  contour: number;
  /** 0-1: repeats reuse the lanes of the first occurrence. */
  repeatConsistency: number;
  /** 0-1: share of qualifying strong coincident onsets that become chords. */
  chordRate: number;
  /** 0-1: how strong (and coincident) an onset must be to qualify for a chord. */
  chordStrength: number;
  allowTriples: boolean;
  /** 0-1: penalty for long runs on one hand. */
  handBalance: number;
  /** Most notes in a row in one lane. */
  maxSameLane: number;
  /** Same lane: at least this long from a note (or hold end) to the next, ms. */
  minLaneGapMs: number;
  /** 0-1: seeded tie-breaking noise. */
  randomness: number;
}

const roles = (r: [number, number, number, number, number, number]): Record<SectionRole, number> =>
  Object.fromEntries(ROLES.map((role, i) => [role, r[i] as number])) as Record<SectionRole, number>;

/*
 * Phase 19 calibration (docs/charting-calibration.md, `npm run calibrate`): Hard was fitted
 * against a hand-made Hard chart (coordinate ascent on the composite score, fitted on one half
 * of the song and validated on the other, both ways; per setting the grid value nearest the mean
 * of the two fits, only changes both halves supported kept in the second round). The rhythm
 * priorities (section roles, layer weights, activity weights) are shared by every difficulty;
 * Expert, Normal and Easy are derived from Hard by scaling, not fitted.
 */

/**
 * Layer weights (all difficulties). Fitted: the hand chart follows snare / clap most (lift 1.46
 * over the 1/8 grid), then hats, vocals / pads and the lead (1.37); the lead onset track is
 * dense and irregular, so as the spine it over-charts (lead 1 -> 0.5 cost 4 points of F1 at 0.7
 * and above, no change from 0.2 to 0.5). Lead runs still join the spine one to one.
 */
const DEFAULT_LAYER_WEIGHTS: Readonly<Record<LayerId, number>> = {
  kick: 0.7,
  snare: 1,
  hats: 0.35,
  bass: 0.5,
  lead: 0.5,
  other: 0.6,
};

/** Hard, fitted (Phase 19). The other difficulties start from these. */
function base(): GeneratorParams {
  return {
    // Density: the reference averages 4.2 nps (2-beat windows) at 220 BPM; these give 4.4.
    baseNps: 2,
    peakNps: 5,
    burstNps: 9,
    // 16 nps: at 220 BPM no 1/16 streams (14.7 nps is allowed, 1/32 is not); slower songs
    // keep finer grids. Tempo-relative, unlike a fixed finest division.
    ceilingNps: 16,
    gamma: 1,
    contrast: 0.4,
    multiplier: 1,
    floorBeats: 1,
    maxGapBeats: 1,
    intenseThreshold: 0.55,
    fillSilence: false,
    // intro, verse, build-up, drop, breakdown, outro (all difficulties): drops were
    // over-charted relative to verses (fitted 1.15 -> 0.9, verse 0.95 -> 0.8).
    roles: roles([0.8, 0.8, 1.05, 0.9, 0.85, 0.8]),
    layerWeights: { ...DEFAULT_LAYER_WEIGHTS },
    leadSensitivity: 0.6,
    leadRunPriority: 0.6,
    secondaryAmount: 0.55,
    quantStrictness: 0.4,
    oddGrids: 0.4,
    finestDivision: 4,
    activity: { ...DEFAULT_ACTIVITY_WEIGHTS, loudness: 0.02 },
    repeatLock: 0.85,
    variation: 0.25,
    laneVariation: 0.2,
    // Holds: the reference has 85 per minute, 43 % under a beat, 410 ms on average; the old
    // defaults made 130 per minute, 80 % short. Fitted: fewer, longer holds.
    holdAmount: 0.5,
    shortHoldShare: 0.2,
    minHoldBeats: 0.5,
    maxHoldBeats: 8,
    maxHolds: 2,
    alignReleases: true,
    ergonomics: 0.6,
    // Measured on the reference: jacks 20 % of moves, trills 30 %, chords 39 % of hits.
    jack: 0.75,
    trill: 0.3,
    stair: 0.5,
    contour: 0.6,
    repeatConsistency: 0.8,
    chordRate: 0.6,
    chordStrength: 0.6,
    allowTriples: false,
    handBalance: 0.5,
    maxSameLane: 3,
    minLaneGapMs: 110,
    randomness: 0.15,
  };
}

/** The defaults of each difficulty. Every value can be overridden in the panel. */
export function presetParams(d: Difficulty): GeneratorParams {
  const p = base();
  switch (d) {
    // Easy: Hard's density x0.5 (calm parts x0.6), eighths at most, no jacks, few chords.
    case 'Easy':
      return {
        ...p,
        baseNps: 1.2,
        peakNps: 2.5,
        burstNps: 4,
        ceilingNps: 5,
        maxGapBeats: 2,
        floorBeats: 1.5,
        finestDivision: 2,
        oddGrids: 0,
        leadRunPriority: 0.3,
        secondaryAmount: 0.25,
        quantStrictness: 0.7,
        holdAmount: 0.5,
        shortHoldShare: 0.1,
        minHoldBeats: 1,
        maxHolds: 1,
        jack: 0,
        trill: 0.2,
        stair: 0.6,
        chordRate: 0.1,
        chordStrength: 0.8,
        maxSameLane: 2,
        minLaneGapMs: 300,
        ergonomics: 0.8,
      };
    // Normal: Hard's density x0.7 (calm parts x0.75), sixteenths only below about 150 BPM
    // (ceiling 10), half the chord and jack tendency.
    case 'Normal':
      return {
        ...p,
        baseNps: 1.5,
        peakNps: 3.5,
        burstNps: 6.5,
        ceilingNps: 10,
        maxGapBeats: 1.5,
        floorBeats: 1,
        finestDivision: 4,
        oddGrids: 0.2,
        leadRunPriority: 0.45,
        secondaryAmount: 0.4,
        quantStrictness: 0.5,
        holdAmount: 0.5,
        shortHoldShare: 0.15,
        minHoldBeats: 0.5,
        maxHolds: 1,
        jack: 0.3,
        trill: 0.3,
        stair: 0.55,
        chordRate: 0.3,
        chordStrength: 0.7,
        maxSameLane: 2,
        minLaneGapMs: 180,
        ergonomics: 0.7,
      };
    case 'Hard':
      return p;
    // Expert: the same rhythm priorities, scaled up rather than fitted. Peak x1.5 and burst x1.55
    // (measured on the reference song: mean 1.39x, 4-beat 90th percentile 1.33x, and outside
    // lead runs 4 notes per beat against Hard's 3), every
    // lead run at full resolution (priority 1, finer grid, ceiling 24 so 1/16 runs and fast
    // arpeggios fit), more secondary-layer notes and chords, shorter gaps.
    case 'Expert':
      return {
        ...p,
        baseNps: 3,
        peakNps: 7.5,
        // 14, not 13.5: the burst cap is whole notes per beat (4 at 220 BPM; 13.5 rounds to 3).
        burstNps: 14,
        ceilingNps: 24,
        maxGapBeats: 0.5,
        finestDivision: 8,
        oddGrids: 0.5,
        leadSensitivity: 0.7,
        leadRunPriority: 1,
        secondaryAmount: 0.75,
        quantStrictness: 0.4,
        shortHoldShare: 0.3,
        minHoldBeats: 0.25,
        chordRate: 0.7,
        chordStrength: 0.55,
        maxSameLane: 4,
        minLaneGapMs: 80,
      };
  }
}

/** Every setting the panel shows, with its range, in display groups. */
export type ParamControl =
  | {
      kind: 'num';
      id: string;
      label: string;
      help: string;
      min: number;
      max: number;
      step: number;
      /** How the value reads: '%' shows 0-1 as a percentage. */
      unit: 'nps' | '%' | 'x' | 'beats' | 'ms' | 'int' | 'gamma';
      get: (p: GeneratorParams) => number;
      set: (p: GeneratorParams, v: number) => void;
    }
  | {
      kind: 'bool';
      id: string;
      label: string;
      help: string;
      get: (p: GeneratorParams) => boolean;
      set: (p: GeneratorParams, v: boolean) => void;
    }
  | {
      kind: 'choice';
      id: string;
      label: string;
      help: string;
      options: readonly { value: number; label: string }[];
      get: (p: GeneratorParams) => number;
      set: (p: GeneratorParams, v: number) => void;
    };

export interface ParamGroup {
  id: string;
  title: string;
  help: string;
  controls: readonly ParamControl[];
}

type NumKey = {
  [K in keyof GeneratorParams]: number extends GeneratorParams[K] ? K : never;
}[keyof GeneratorParams];
type BoolKey = {
  [K in keyof GeneratorParams]: GeneratorParams[K] extends boolean ? K : never;
}[keyof GeneratorParams];

const num = (
  key: NumKey,
  label: string,
  help: string,
  min: number,
  max: number,
  step: number,
  unit: Extract<ParamControl, { kind: 'num' }>['unit'],
): ParamControl => ({
  kind: 'num',
  id: key,
  label,
  help,
  min,
  max,
  step,
  unit,
  get: (p) => p[key],
  set: (p, v) => {
    p[key] = v;
  },
});
const pct = (key: NumKey, label: string, help: string): ParamControl =>
  num(key, label, help, 0, 1, 0.05, '%');
const bool = (key: BoolKey, label: string, help: string): ParamControl => ({
  kind: 'bool',
  id: key,
  label,
  help,
  get: (p) => p[key],
  set: (p, v) => {
    p[key] = v;
  },
});

export const PARAM_GROUPS: readonly ParamGroup[] = [
  {
    id: 'density',
    title: 'Density',
    help: 'How many notes per second, over time. Driven by musical activity and section role, not loudness.',
    controls: [
      num(
        'baseNps',
        'Base',
        'Notes per second in the calmest parts with sound: a floor, so calm parts are never empty.',
        0.5,
        12,
        0.1,
        'nps',
      ),
      num(
        'peakNps',
        'Peak',
        'Sustained notes per second in the most active parts.',
        1,
        30,
        0.5,
        'nps',
      ),
      num(
        'burstNps',
        'Burst',
        'Notes per second allowed in windows of a beat or less (lead runs, fills).',
        1,
        30,
        0.5,
        'nps',
      ),
      num(
        'ceilingNps',
        'Ceiling',
        'Hard limit: no two hits closer than 1 / ceiling seconds.',
        2,
        30,
        0.5,
        'nps',
      ),
      num(
        'gamma',
        'Curve',
        'Shape of the activity curve: above 1 stays low longer, below 1 rises early.',
        0.3,
        3,
        0.05,
        'gamma',
      ),
      pct(
        'contrast',
        'Contrast',
        'How far apart calm and intense parts are pushed (0 = flat, 1 = extreme). Intense parts get harder; the base floor stays.',
      ),
      num('multiplier', 'Multiplier', 'Multiplies the whole density plan.', 0.25, 2.5, 0.05, 'x'),
      num(
        'floorBeats',
        'Floor every',
        'At least one note this often wherever there is sound.',
        0.5,
        8,
        0.25,
        'beats',
      ),
      num(
        'maxGapBeats',
        'Max gap',
        'In intense parts, gaps longer than this are filled.',
        0.25,
        4,
        0.25,
        'beats',
      ),
      pct(
        'intenseThreshold',
        'Intense above',
        'Activity (relative to the song) above which a part counts as intense for the gap rule.',
      ),
      bool('fillSilence', 'Fill silence', 'Also place beat notes where the audio is silent.'),
    ],
  },
  {
    id: 'roles',
    title: 'Section roles',
    help: 'Density multiplier per section type from the analysis.',
    controls: ROLES.map((role): ParamControl => ({
      kind: 'num',
      id: `roles.${role}`,
      label: SECTION_LABELS[role],
      help: `Density multiplier inside ${SECTION_LABELS[role].toLowerCase()} sections.`,
      min: 0.3,
      max: 2,
      step: 0.05,
      unit: 'x',
      get: (p) => p.roles[role],
      set: (p, v) => {
        p.roles[role] = v;
      },
    })),
  },
  {
    id: 'rhythm',
    title: 'Rhythm sources',
    help: 'Which layer each phrase follows (the spine), and how the rest adds to it.',
    controls: [
      ...LAYERS.map((layer): ParamControl => ({
        kind: 'num',
        id: `layer.${layer}`,
        label: LAYER_LABELS[layer],
        help: `Weight of the ${LAYER_LABELS[layer].toLowerCase()} layer when a phrase picks the rhythm it follows.${layer === 'lead' ? ' The lead also gets a priority bonus.' : ''}`,
        min: 0,
        max: 1.5,
        step: 0.05,
        unit: 'x',
        get: (p) => p.layerWeights[layer],
        set: (p, v) => {
          p.layerWeights[layer] = v;
        },
      })),
      pct('leadSensitivity', 'Lead sensitivity', 'Higher keeps weaker lead onsets in the spine.'),
      pct(
        'leadRunPriority',
        'Lead runs',
        'How strongly dense lead runs are charted note for note (up to the burst rate).',
      ),
      pct(
        'secondaryAmount',
        'Secondary',
        'How much the other layers add notes and chords around the spine.',
      ),
      pct(
        'quantStrictness',
        'Strict grid',
        'Higher drops onsets far from the phrase grid instead of snapping them.',
      ),
      pct('oddGrids', 'Triplets', 'How readily a phrase uses a triplet grid. 0 = never.'),
      {
        kind: 'choice',
        id: 'finestDivision',
        label: 'Finest grid',
        help: 'The finest grid a phrase may use.',
        options: FINEST_DIVISIONS.map((d) => ({ value: d, label: `1/${d * 4}` })),
        get: (p) => p.finestDivision,
        set: (p, v) => {
          p.finestDivision = isFinest(v) ? v : 16;
        },
      },
    ],
  },
  {
    id: 'activity',
    title: 'Musical activity',
    help: 'What the activity curve (which drives density) is made of. Loudness stays near zero by default.',
    controls: ACTIVITY_PARTS.map((part): ParamControl => ({
      kind: 'num',
      id: `activity.${part}`,
      label: ACTIVITY_LABELS[part],
      help: `Weight of ${ACTIVITY_LABELS[part].toLowerCase()} in the activity curve.`,
      min: 0,
      max: 1,
      step: 0.01,
      unit: 'x',
      get: (p) => p.activity[part],
      set: (p, v) => {
        p.activity[part] = v;
      },
    })),
  },
  {
    id: 'repetition',
    title: 'Repetition',
    help: 'Repeated phrases (choruses) share one rhythm and lane sequence.',
    controls: [
      pct('repeatLock', 'Lock', 'How strictly repeats share the consensus rhythm (1 = exactly).'),
      pct(
        'variation',
        'Variation',
        'Extra notes each repeat may add on top of the shared rhythm (dropped first when over the cap).',
      ),
      pct(
        'laneVariation',
        'Lane variation',
        'How often a repeat varies the shared lanes (a mirrored bar).',
      ),
    ],
  },
  {
    id: 'holds',
    title: 'Holds',
    help: 'Holds on sustained notes (lead, bass, pads) and legato phrases.',
    controls: [
      pct('holdAmount', 'Amount', 'How readily sustained sounds become holds.'),
      pct(
        'shortHoldShare',
        'Short holds',
        'Preference for short holds (under a beat) over long ones.',
      ),
      num(
        'minHoldBeats',
        'Shortest',
        'Shortest hold (never under 120 ms).',
        0.125,
        4,
        0.125,
        'beats',
      ),
      num('maxHoldBeats', 'Longest', 'Longest hold.', 0.5, 32, 0.5, 'beats'),
      num('maxHolds', 'At once', 'Most holds down at the same time.', 1, 3, 1, 'int'),
      bool('alignReleases', 'Align releases', 'Snap hold ends to the phrase grid.'),
    ],
  },
  {
    id: 'lanes',
    title: 'Lane behaviour',
    help: 'One continuous optimisation over the whole range: jacks, trills, stairs and chords emerge from these weights and the melody.',
    controls: [
      pct(
        'ergonomics',
        'Ergonomics',
        'Hand comfort: alternate hands at speed (lanes 1-2 left, 3-4 right).',
      ),
      pct('jack', 'Jacks', 'Same lane at short gaps. 0 = never faster than 1/8, 1 = free.'),
      pct('trill', 'Trills', 'Alternating two lanes.'),
      pct('stair', 'Stairs', 'Moving one lane at a time in one direction.'),
      pct(
        'contour',
        'Melody contour',
        'Higher lead pitch goes to a higher lane; a repeated pitch repeats or alternates.',
      ),
      pct('repeatConsistency', 'Repeat lanes', 'Repeats reuse the lanes of the first occurrence.'),
      pct('chordRate', 'Chord rate', 'Share of strong coincident onsets that become chords.'),
      pct(
        'chordStrength',
        'Chord strength',
        'How strong and coincident an onset must be to become a chord.',
      ),
      bool('allowTriples', 'Allow triples', 'Three-note chords on the strongest hits.'),
      pct('handBalance', 'Hand balance', 'Avoid long runs on one hand.'),
      num('maxSameLane', 'Max same lane', 'Most notes in a row in one lane.', 1, 8, 1, 'int'),
      num(
        'minLaneGapMs',
        'Min lane gap',
        'Same lane: at least this long between notes (and after a hold).',
        40,
        500,
        5,
        'ms',
      ),
      pct('randomness', 'Randomness', 'Seeded tie-breaking noise.'),
    ],
  },
];

function isFinest(v: unknown): v is FinestDivision {
  return FINEST_DIVISIONS.includes(v as FinestDivision);
}

export function cloneParams(p: GeneratorParams): GeneratorParams {
  return {
    ...p,
    roles: { ...p.roles },
    layerWeights: { ...p.layerWeights },
    activity: { ...p.activity },
  };
}

/**
 * Saved or imported settings over the `fallback`: every known control whose value has the
 * right type is clamped into its range; anything else keeps the fallback's value.
 */
export function sanitizeParams(raw: unknown, fallback: GeneratorParams): GeneratorParams {
  const out = cloneParams(fallback);
  if (!raw || typeof raw !== 'object') return out;
  const src = cloneParams(fallback);
  // Read the raw values through the same accessors, on an object shaped like the params.
  const r = raw as Record<string, unknown>;
  const nested = (k: string): Record<string, unknown> =>
    r[k] && typeof r[k] === 'object' ? (r[k] as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(r)) {
    if (k in src && typeof v === typeof (src as unknown as Record<string, unknown>)[k]) {
      (src as unknown as Record<string, unknown>)[k] = v;
    }
  }
  src.roles = { ...fallback.roles, ...pickNumbers(nested('roles'), ROLES) };
  src.layerWeights = { ...fallback.layerWeights, ...pickNumbers(nested('layerWeights'), LAYERS) };
  src.activity = { ...fallback.activity, ...pickNumbers(nested('activity'), ACTIVITY_PARTS) };
  for (const g of PARAM_GROUPS) {
    for (const c of g.controls) {
      if (c.kind === 'bool') {
        const v = c.get(src);
        c.set(out, typeof v === 'boolean' ? v : c.get(fallback));
      } else if (c.kind === 'num') {
        const v = c.get(src);
        c.set(
          out,
          typeof v === 'number' && Number.isFinite(v)
            ? Math.min(c.max, Math.max(c.min, v))
            : c.get(fallback),
        );
      } else {
        const v = c.get(src);
        c.set(out, c.options.some((o) => o.value === v) ? v : c.get(fallback));
      }
    }
  }
  return out;
}

function pickNumbers<K extends string>(
  o: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
