import { formatTimestamp } from '../../../core/beatGrid';
import type { AudioAnalysis } from '../../../core/analysis';
import { computeActivity } from './activity';
import { detectLead, findLeadRuns, nearestNote } from './lead';
import { mergeCandidates, pickLayerOnsets } from './onsets';
import { analyzeStructure } from './structure';
import {
  CHART_ANALYSIS_VERSION,
  COINCIDENCE_MS,
  LAYERS,
  LAYER_LABELS,
  SECTION_LABELS,
  type ActivityWeights,
  type ChartAnalysis,
  type ChartAnalysisParams,
  type ChartFeatures,
  type LegacyCurves,
} from './types';

/** The parts of the older analysis that ChartAnalysis keeps (intensity, impacts, build-ups). */
export function legacyCurves(a: AudioAnalysis): LegacyCurves {
  return {
    frameMs: a.frameMs,
    frameOffsetMs: a.frameOffsetMs,
    frameCount: a.frameCount,
    intensity: a.intensity,
    impacts: a.impacts.map((i) => ({ t: i.t, strength: i.strength, kind: i.kind })),
    buildUps: a.buildUps.map((b) => ({ startMs: b.startMs, endMs: b.endMs, rise: b.rise })),
  };
}

/**
 * Everything derived from the cached features for this BPM/offset and these parameters: layer
 * onsets, lead notes and runs, merged candidates, activity and structure. Fast (no STFT), so the
 * viewer re-runs it whenever a slider moves or the timing changes.
 */
export function evaluateChartAnalysis(
  features: ChartFeatures,
  timing: { bpm: number; offsetMs: number },
  params: ChartAnalysisParams,
  legacy: LegacyCurves | null,
): ChartAnalysis {
  const { bpm, offsetMs } = timing;
  const layerOnsets = pickLayerOnsets(features, params.layerSensitivity);
  const lead = detectLead(features, params.leadSensitivity, params.minLeadIntervalMs);
  layerOnsets.lead = lead.onsets;
  const candidates = mergeCandidates(
    layerOnsets,
    (tMs) => nearestNote(lead.notes, tMs, COINCIDENCE_MS)?.midi ?? null,
  );
  const beatMs = bpm > 0 && Number.isFinite(bpm) ? 60000 / bpm : 0;
  const leadRuns = findLeadRuns(lead.onsets, lead.notes, beatMs);
  const { activity, parts } = computeActivity(
    features,
    candidates,
    lead.notes,
    bpm,
    offsetMs,
    params.weights,
  );
  const structure = analyzeStructure(features, bpm, offsetMs, {
    activity,
    lowPunch: parts.lowPunch,
    candidates,
    leadNotes: lead.notes,
    buildUps: legacy?.buildUps ?? [],
  });
  return {
    version: CHART_ANALYSIS_VERSION,
    durationMs: features.durationMs,
    bpm,
    offsetMs,
    params: { ...params, weights: { ...params.weights } },
    features,
    layerOnsets,
    candidates,
    leadNotes: lead.notes,
    leadRuns,
    activity,
    activityParts: parts,
    structure,
    legacy,
  };
}

/**
 * The same analysis with other activity weights: only the activity curve and the structure
 * (whose sections read it) are recomputed; onsets, lead notes and runs are kept.
 */
export function reweightChartAnalysis(
  prev: ChartAnalysis,
  weights: ActivityWeights,
): ChartAnalysis {
  const { activity, parts } = computeActivity(
    prev.features,
    prev.candidates,
    prev.leadNotes,
    prev.bpm,
    prev.offsetMs,
    weights,
  );
  const structure = analyzeStructure(prev.features, prev.bpm, prev.offsetMs, {
    activity,
    lowPunch: parts.lowPunch,
    candidates: prev.candidates,
    leadNotes: prev.leadNotes,
    buildUps: prev.legacy?.buildUps ?? [],
  });
  return {
    ...prev,
    params: { ...prev.params, weights: { ...weights } },
    activity,
    activityParts: parts,
    structure,
  };
}

/** Typed arrays become plain arrays rounded to 4 decimals; everything else is kept. */
function jsonValue(_key: string, value: unknown): unknown {
  if (value instanceof Float32Array || value instanceof Float64Array) {
    return Array.from(value, (v) => Math.round(v * 1e4) / 1e4);
  }
  if (value instanceof Int32Array || value instanceof Uint8Array || value instanceof Int16Array) {
    return Array.from(value);
  }
  return value;
}

/**
 * The whole analysis as JSON: features (every curve and envelope), onsets per layer,
 * candidates, lead notes and runs, activity and its parts, bars, the similarity matrix and
 * sections. `indent` 0 keeps it compact.
 */
export function chartAnalysisToJson(a: ChartAnalysis, indent = 0): string {
  const out = { format: 'ataraxia-chart-analysis', ...a };
  return JSON.stringify(out, jsonValue, indent > 0 ? indent : undefined);
}

/** Counts for summaries. */
export function analysisCounts(a: ChartAnalysis): {
  candidates: number;
  perLayer: Record<(typeof LAYERS)[number], number>;
  leadNotes: number;
  leadRuns: number;
  sections: number;
  groups: number;
  repeatedGroups: number;
} {
  const perLayer = {} as Record<(typeof LAYERS)[number], number>;
  for (const l of LAYERS)
    perLayer[l] = a.candidates.filter((c) => c.layers[l] !== undefined).length;
  return {
    candidates: a.candidates.length,
    perLayer,
    leadNotes: a.leadNotes.length,
    leadRuns: a.leadRuns.length,
    sections: a.structure.sections.length,
    groups: a.structure.groupCount,
    repeatedGroups: a.structure.groupSizes.filter((n) => n >= 2).length,
  };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "A4" for MIDI 69 (nearest semitone). */
export function midiName(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12] ?? '?'}${Math.floor(m / 12) - 1}`;
}

/** Repeat group letter: A, B, ... Z, AA, AB ... */
export function groupLetter(g: number): string {
  if (g < 0) return '-';
  let s = '';
  let n = g;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** A plain-text summary (the terminal script and the panel's export use it). */
export function describeChartAnalysis(a: ChartAnalysis): string[] {
  const c = analysisCounts(a);
  const lines: string[] = [];
  lines.push(
    `Duration ${formatTimestamp(a.durationMs)}, ${a.bpm} BPM, offset ${a.offsetMs} ms ` +
      `(onset hop ${a.features.onsetHopMs.toFixed(2)} ms, pitch hop ${a.features.pitchHopMs.toFixed(2)} ms).`,
  );
  lines.push(`Candidates: ${c.candidates} (after merging layers within 20 ms).`);
  lines.push('  ' + LAYERS.map((l) => `${LAYER_LABELS[l]} ${c.perLayer[l]}`).join(', ') + '.');
  if (a.leadNotes.length > 0) {
    const midis = a.leadNotes.map((n) => n.midi);
    lines.push(
      `Lead notes: ${c.leadNotes}, ${midiName(Math.min(...midis))} to ${midiName(Math.max(...midis))}.`,
    );
  } else {
    lines.push('Lead notes: none found.');
  }
  lines.push(`Lead runs: ${c.leadRuns}.`);
  for (const r of a.leadRuns.slice(0, 12)) {
    lines.push(
      `  ${formatTimestamp(r.startMs)}-${formatTimestamp(r.endMs)}: ${r.count} onsets, ` +
        `${r.rateHz.toFixed(1)}/s (${r.perBeat.toFixed(2)} per beat)`,
    );
  }
  if (a.leadRuns.length > 12) lines.push(`  ... and ${a.leadRuns.length - 12} more.`);
  const s = a.structure;
  lines.push(
    `Bars: ${s.bars.length}, phrases of ${s.phraseBars} bars, ${s.groupCount} repeat groups ` +
      `(${c.repeatedGroups} repeated: ${s.groupSizes
        .map((n, g) => `${groupLetter(g)}x${n}`)
        .filter((_, g) => (s.groupSizes[g] ?? 0) >= 2)
        .join(' ')}).`,
  );
  lines.push(`Sections: ${c.sections}.`);
  for (const sec of s.sections) {
    lines.push(
      `  ${formatTimestamp(sec.startMs)}-${formatTimestamp(sec.endMs)} ${SECTION_LABELS[sec.role]}: ` +
        `activity ${sec.activity.toFixed(2)}, ${sec.density.toFixed(1)} onsets/s, ` +
        `punch ${sec.lowPunch.toFixed(2)}, rise ${sec.rise.toFixed(2)}` +
        (sec.pitch !== null ? `, lead around ${midiName(sec.pitch)}` : ''),
    );
  }
  let act = 0;
  for (const v of a.activity) act += v;
  lines.push(`Mean activity ${(act / Math.max(1, a.activity.length)).toFixed(2)}.`);
  return lines;
}
