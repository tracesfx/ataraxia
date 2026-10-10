/**
 * ChartAnalysis (Phase 17): what the Studio's charting tools know about a song. Two halves:
 *
 * - `ChartFeatures`: the heavy part, computed once per song in a worker from the audio (STFTs,
 *   harmonic/percussive separation, per-layer onset envelopes, pitch track, band energies) and
 *   cached in IndexedDB under CHART_ANALYSIS_VERSION. Pure data (typed arrays).
 * - `ChartAnalysis`: everything derived from the features, the chart's BPM/offset and the
 *   tunable `ChartAnalysisParams` (peak picking, lead notes and runs, activity, structure). It is
 *   cheap to re-evaluate, so sensitivity and weight sliders are live.
 *
 * Times are song milliseconds (0 = first audio sample). See docs/charting.md, "Song analysis".
 */

/** Bump when the features change meaning, so cached features are recomputed. */
export const CHART_ANALYSIS_VERSION = 1;

/** Onset layers, each with its own onset envelope and candidates. */
export const LAYERS = ['kick', 'snare', 'hats', 'bass', 'lead', 'other'] as const;
export type LayerId = (typeof LAYERS)[number];

export const LAYER_LABELS: Readonly<Record<LayerId, string>> = {
  kick: 'Kick',
  snare: 'Snare / clap',
  hats: 'Hats / air',
  bass: 'Bass',
  lead: 'Lead',
  other: 'Other / vocal',
};

/** Display bands (energy tracks). */
export const BANDS = ['sub', 'low', 'lowMid', 'highMid', 'high'] as const;
export type BandId = (typeof BANDS)[number];

/** Band edges in Hz: sub < 60 <= low < 250 <= low-mid < 2000 <= high-mid < 6000 <= high. */
export const BAND_EDGES_HZ: Readonly<Record<BandId, readonly [number, number]>> = {
  sub: [20, 60],
  low: [60, 250],
  lowMid: [250, 2000],
  highMid: [2000, 6000],
  high: [6000, 20000],
};

export const BAND_LABELS: Readonly<Record<BandId, string>> = {
  sub: 'Sub',
  low: 'Low',
  lowMid: 'Low-mid',
  highMid: 'High-mid',
  high: 'High',
};

/** The coarse feature grid: one frame every 20 ms (50 Hz). */
export const CURVE_FRAME_MS = 20;

export interface ChartFeatures {
  version: number;
  durationMs: number;
  /** Rate the features were computed at (the song's rate divided by a whole factor). */
  analysisRate: number;
  /** FFT size and hop (samples at `analysisRate`) of the onset STFT. */
  onsetFftSize: number;
  onsetHop: number;
  /** Onset grid: frame n is centred on n * onsetHopMs. */
  onsetHopMs: number;
  onsetFrames: number;
  /**
   * Onset envelope per layer on the onset grid: log-compressed, per-band adaptively whitened,
   * half-wave rectified spectral flux of the layer's part of the harmonic or percussive
   * spectrogram. Raw scale (compare within a layer).
   */
  envelopes: Record<LayerId, Float32Array>;
  /** 99th percentile of each envelope (for display and fingerprints). */
  envelopeScale: Record<LayerId, number>;
  /** Pitch grid (FFT twice the onset size, hop twice the onset hop): frame m at m * pitchHopMs. */
  pitchFftSize: number;
  pitchHopMs: number;
  pitchFrames: number;
  /** Dominant pitch per frame as a float MIDI number (0 = no pitch found). */
  pitchMidi: Float32Array;
  /** Harmonic-summation salience of that pitch (raw scale). */
  pitchSalience: Float32Array;
  /** 0-1: the share of the whitened spectrum (to 6 kHz) the pitch's harmonics explain. */
  pitchConfidence: Float32Array;
  /** Coarse grid: frame k at k * CURVE_FRAME_MS. */
  frameMs: number;
  frameCount: number;
  /** RMS per frame (0-1 full scale). */
  rms: Float32Array;
  /** 0-1: RMS in dB between the song's 5th and 95th percentiles. */
  loudness: Float32Array;
  /** Band energies, 0-1 per band (dB between the band's 5th and 99th percentiles). */
  bands: Record<BandId, Float32Array>;
  /** 0-1: spectral centroid between the song's 5th and 95th percentiles. */
  brightness: Float32Array;
  /** Chroma, 12 values per frame (frame-major), each frame summing to 1 (0 when silent). */
  chroma: Float32Array;
  /** 0-1: how much the chroma changes around each frame (chord / harmony changes). */
  harmonicChange: Float32Array;
}

/** Weights of the musical activity blend (any non-negative scale; normalised by their sum). */
export interface ActivityWeights {
  leadDensity: number;
  drumDensity: number;
  syncopation: number;
  harmonicChange: number;
  pitchLeaps: number;
  lowPunch: number;
  loudness: number;
}

export const ACTIVITY_PARTS = [
  'leadDensity',
  'drumDensity',
  'syncopation',
  'harmonicChange',
  'pitchLeaps',
  'lowPunch',
  'loudness',
] as const satisfies readonly (keyof ActivityWeights)[];
export type ActivityPart = (typeof ACTIVITY_PARTS)[number];

export const ACTIVITY_LABELS: Readonly<Record<ActivityPart, string>> = {
  leadDensity: 'Lead onsets',
  drumDensity: 'Snare and hats',
  syncopation: 'Syncopation',
  harmonicChange: 'Harmony changes',
  pitchLeaps: 'Pitch leaps',
  lowPunch: 'Low punch',
  loudness: 'Loudness',
};

/**
 * Loudness stays a minor ingredient: activity is about what happens, not how loud it is.
 * Calibrated in Phase 19 against a hand-made chart (docs/charting-calibration.md): the charted
 * density follows snare / hat activity and melodic leaps more than raw lead onset density.
 */
export const DEFAULT_ACTIVITY_WEIGHTS: Readonly<ActivityWeights> = {
  leadDensity: 0.18,
  drumDensity: 0.3,
  syncopation: 0.1,
  harmonicChange: 0.1,
  pitchLeaps: 0.18,
  lowPunch: 0.18,
  loudness: 0.05,
};

/** The tunable part of the analysis (re-evaluated from the cached features). */
export interface ChartAnalysisParams {
  /** 0-1: higher finds quieter lead notes (lower local thresholds). */
  leadSensitivity: number;
  /** Shortest gap between two lead onsets, ms (fast leads need about 40). */
  minLeadIntervalMs: number;
  /** 0-1: the same for the other layers. */
  layerSensitivity: number;
  weights: ActivityWeights;
}

export const DEFAULT_CHART_ANALYSIS_PARAMS: Readonly<ChartAnalysisParams> = {
  leadSensitivity: 0.6,
  minLeadIntervalMs: 40,
  /** Phase 19: 0.5 -> 0.4 (fewer weak drum and bass onsets; better fit on the reference). */
  layerSensitivity: 0.4,
  weights: DEFAULT_ACTIVITY_WEIGHTS,
};

export const MIN_LEAD_INTERVAL_RANGE = [25, 150] as const;

/** One onset found in one layer. */
export interface LayerOnset {
  tMs: number;
  /** 0-1, relative to the layer's own onsets nearby (about +/-1.5 s). */
  strength: number;
}

/**
 * A candidate onset for charting: onsets of different layers within COINCIDENCE_MS merged into
 * one, remembering each layer's strength.
 */
export interface Candidate {
  tMs: number;
  /** 0-1: the strongest contributing layer. */
  strength: number;
  /** The strongest contributing layer. */
  layer: LayerId;
  /** Strength per contributing layer. */
  layers: Partial<Record<LayerId, number>>;
  /** Pitch of the lead note starting here (float MIDI), if any. */
  pitch: number | null;
}

/** Onsets of different layers this close (ms) are one candidate. */
export const COINCIDENCE_MS = 20;

/** A note of the lead melody. */
export interface LeadNote {
  tMs: number;
  durMs: number;
  /** Float MIDI number (69 = A4). */
  midi: number;
  /** 0-1, locally normalised. */
  strength: number;
  /** 0-1: mean pitch confidence over the note. */
  confidence: number;
}

/** A dense, regular chain of lead onsets (an arpeggio, a run, a trill). */
export interface LeadRun {
  startMs: number;
  endMs: number;
  count: number;
  /** Onsets per second. */
  rateHz: number;
  /** Onsets per beat at the chart's BPM (4 = sixteenths, 3 = triplet eighths). */
  perBeat: number;
  /** Pitch of each onset (null when it had none). */
  contour: (number | null)[];
}

export type SectionRole = 'intro' | 'verse' | 'build-up' | 'drop' | 'breakdown' | 'outro';

export const SECTION_LABELS: Readonly<Record<SectionRole, string>> = {
  intro: 'Intro',
  verse: 'Verse',
  'build-up': 'Build-up',
  drop: 'Drop / chorus',
  breakdown: 'Breakdown / bridge',
  outro: 'Outro',
};

/** Short labels for narrow ribbons. */
export const SECTION_SHORT: Readonly<Record<SectionRole, string>> = {
  intro: 'Intro',
  verse: 'Verse',
  'build-up': 'Build',
  drop: 'Drop',
  breakdown: 'Break',
  outro: 'Outro',
};

/** One bar of the chart's grid (4 beats). */
export interface Bar {
  index: number;
  /** 1-based measure number as the editor shows it. */
  measure: number;
  startMs: number;
  endMs: number;
  /** Repeat group (0, 1, ... in order of first appearance), or -1 for silence / lead-in. */
  group: number;
  /** Which occurrence of its group's phrase this bar belongs to (0 = first). */
  repeatIndex: number;
  /** Position inside its phrase (0-based). */
  barInPhrase: number;
}

export interface Section {
  startMs: number;
  endMs: number;
  firstBar: number;
  /** Exclusive. */
  endBar: number;
  role: SectionRole;
  /** Section descriptors (0-1 unless noted) that led to the role. */
  activity: number;
  /** Candidates per second. */
  density: number;
  brightness: number;
  /** Mean lead pitch (MIDI), or null. */
  pitch: number | null;
  lowPunch: number;
  loudness: number;
  /** Activity rise across the section (last third minus first third). */
  rise: number;
}

export interface Structure {
  beatMs: number;
  barMs: number;
  bars: Bar[];
  /** Phrase length (bars) that explained the most repetition. */
  phraseBars: number;
  /** Number of repeat groups. */
  groupCount: number;
  /** How many phrases each group has. */
  groupSizes: number[];
  /** Bar self-similarity, bars.length squared, row-major, 0-1. */
  similarity: Float32Array;
  /** Novelty per bar boundary (0-1), used for sections. */
  novelty: Float32Array;
  sections: Section[];
}

/** The parts of the older analysis (src/core/analysis) kept alongside. */
export interface LegacyCurves {
  frameMs: number;
  frameOffsetMs: number;
  frameCount: number;
  intensity: Float32Array;
  impacts: { t: number; strength: number; kind: 'drop' | 'hit' }[];
  buildUps: { startMs: number; endMs: number; rise: number }[];
}

export interface ChartAnalysis {
  version: number;
  durationMs: number;
  bpm: number;
  offsetMs: number;
  params: ChartAnalysisParams;
  features: ChartFeatures;
  /** Onsets per layer (before merging). */
  layerOnsets: Record<LayerId, LayerOnset[]>;
  /** Merged candidates, sorted by time. */
  candidates: Candidate[];
  leadNotes: LeadNote[];
  leadRuns: LeadRun[];
  /** Musical activity 0-1 on the coarse grid (CURVE_FRAME_MS). */
  activity: Float32Array;
  /** Each activity ingredient, 0-1, on the same grid. */
  activityParts: Record<ActivityPart, Float32Array>;
  structure: Structure;
  /** Intensity, impacts and build-ups of the older analysis, when available. */
  legacy: LegacyCurves | null;
}
