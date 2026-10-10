import { MIN_HOLD_MS, compareNotes, type Lane, type Note } from '../../core/chart';
import { findOverlap } from '../../core/noteEdit';
import { reweightChartAnalysis } from './analysis/evaluate';
import { ACTIVITY_PARTS, type Candidate, type ChartAnalysis } from './analysis/types';
import { assignHolds } from './holds';
import {
  TICKS_PER_BEAT,
  TickGrid,
  firstAtOrAfter,
  hash01,
  type Hit,
  type NoteDecision,
  type Rejection,
} from './hits';
import { assignLanes, type LaneEvent } from './lanes';
import { densityPlan, type DensityPlan } from './plan';
import type { GeneratorParams } from './presets';
import { selectRhythm } from './rhythm';
import { measureGeneration, type GenerateStats } from './stats';

/**
 * Phase 18 note generation: rhythm first, continuous, section aware (docs/charting.md).
 *
 *   A. density plan (plan.ts)          target nps per beat from activity and section role
 *   B. rhythm selection (rhythm.ts)    the spine per phrase from the most salient layer,
 *   C. repetition lock (rhythm.ts)     one shared rhythm per repeat group,
 *   F. gaps and floor (rhythm.ts)      secondary layers, top-up, gap fill, the floor rule
 *   D. holds (holds.ts)                sustained notes, legato, layered bass holds
 *   E. lanes (lanes.ts)                one beam search over the whole range
 *   G. validation (here)               no overlaps, no short holds, inside the range
 *
 * Pure and seeded: the same analysis, notes, settings and seed give the same result. Every
 * note carries a decision (why it exists); candidates left out carry a rejection reason.
 */

export interface GenerateInput {
  /** The song's ChartAnalysis, evaluated at the chart's BPM and offset. */
  analysis: ChartAnalysis;
  /** The chart's notes now. */
  existing: readonly Note[];
  durationMs: number;
}

export interface GenerateOptions {
  params: GeneratorParams;
  seed: number;
  /** Only place notes with heads in this range; null = the whole song. */
  range: { startMs: number; endMs: number } | null;
  /** Remove the existing notes in the range first (one undo step with the new ones). */
  replaceExisting: boolean;
}

export interface GenerateResult {
  /** New notes, sorted; valid together with the existing notes minus `removed`. */
  notes: Note[];
  removed: Note[];
  /** Why each new note exists. */
  decisions: Map<Note, NoteDecision>;
  /** Candidate onsets in the range that got no note, with the reason. */
  rejections: Rejection[];
  plan: DensityPlan;
  rangeMs: { startMs: number; endMs: number };
  stats: GenerateStats;
  seed: number;
}

/** Analysis with the generator's own activity weights (cheap: activity and sections only). */
export function analysisForParams(a: ChartAnalysis, p: GeneratorParams): ChartAnalysis {
  const same = ACTIVITY_PARTS.every((k) => Math.abs(a.params.weights[k] - p.activity[k]) < 1e-9);
  return same ? a : reweightChartAnalysis(a, p.activity);
}

export function generateChart(input: GenerateInput, o: GenerateOptions): GenerateResult {
  const p = o.params;
  const a = analysisForParams(input.analysis, p);
  const range = {
    startMs: Math.max(0, Math.round(o.range?.startMs ?? 0)),
    endMs: Math.min(Math.floor(input.durationMs), Math.round(o.range?.endMs ?? input.durationMs)),
  };
  const plan = densityPlan(a, p);
  const removed = o.replaceExisting
    ? input.existing.filter((n) => n.t >= range.startMs && n.t <= range.endMs)
    : [];
  const gone = new Set(removed);
  const kept = input.existing.filter((n) => !gone.has(n));
  const empty = (): GenerateResult => ({
    notes: [],
    removed,
    decisions: new Map(),
    rejections: [],
    plan,
    rangeMs: range,
    stats: measureGeneration([], new Map(), [], a, plan, range, p.intenseThreshold),
    seed: o.seed,
  });
  if (!(a.bpm > 0) || !Number.isFinite(a.bpm) || range.endMs <= range.startMs) return empty();

  const grid = new TickGrid(a.bpm, a.offsetMs);
  const occupied = [...new Set(kept.map((n) => n.t))].sort((x, y) => x - y);
  const { hits, rejected } = selectRhythm({
    analysis: a,
    plan,
    grid,
    params: p,
    seed: o.seed,
    range,
    occupied,
  });
  assignHolds(hits, a, grid, p, o.seed, range.endMs);

  // Events for the lane optimiser: main note, chord taps, a layered hold.
  const maxNotes = p.allowTriples ? 3 : 2;
  const eventOf = (h: Hit, ref: Lane[] | null): LaneEvent => {
    const notes = [h.holdMs];
    for (let i = 1; i < h.count; i++) notes.push(0);
    if (h.layerHoldMs > 0 && notes.length < maxNotes) notes.push(h.layerHoldMs);
    return {
      tMs: h.tMs,
      notes: notes.slice(0, Math.max(1, Math.min(3, notes.length))),
      pitch: h.pitch,
      ref,
    };
  };
  let events = hits.map((h) => eventOf(h, null));
  let { choices } = assignLanes(events, kept, grid.beatMs, p, o.seed);

  // Repeats: a second pass where later occurrences follow the first one's lanes (with seeded
  // mirrored bars for lane variation).
  const repeated = new Set<number>();
  {
    const firstInst = new Map<number, number>();
    for (const h of hits) {
      if (h.template < 0 || h.group < 0) continue;
      const f = firstInst.get(h.template);
      if (f === undefined) firstInst.set(h.template, h.instance);
      else if (f !== h.instance) repeated.add(h.template);
    }
  }
  if (repeated.size > 0 && p.repeatConsistency > 0) {
    const refOf = new Map<string, { instance: number; lanes: Lane[] }>();
    hits.forEach((h, i) => {
      const c = choices[i];
      if (!c || !repeated.has(h.template)) return;
      const key = `${h.template}:${h.relTick}`;
      const prev = refOf.get(key);
      if (!prev || h.instance < prev.instance)
        refOf.set(key, { instance: h.instance, lanes: c.lanes });
    });
    events = hits.map((h) => {
      const r = refOf.get(`${h.template}:${h.relTick}`);
      if (!r || r.instance === h.instance) return eventOf(h, null);
      const bar = Math.floor(h.relTick / (TICKS_PER_BEAT * 4));
      const mirror =
        hash01(o.seed, h.template * 1000 + h.instance, bar, 11) < p.laneVariation * 0.5;
      return eventOf(
        h,
        r.lanes.map((l) => (mirror ? ((3 - l) as Lane) : l)),
      );
    });
    choices = assignLanes(events, kept, grid.beatMs, p, o.seed).choices;
  }

  // Notes, decisions, validation.
  const decisions = new Map<Note, NoteDecision>();
  let notes: Note[] = [];
  const dropped: Hit[] = [];
  hits.forEach((h, i) => {
    const c = choices[i];
    if (!c) {
      dropped.push(h);
      return;
    }
    c.lanes.forEach((lane, j) => {
      const hold = Math.round(c.holds[j] ?? 0);
      const t = Math.round(h.tMs);
      if (t < range.startMs || t > range.endMs) return;
      const note: Note =
        hold >= MIN_HOLD_MS ? { t, lane, type: 'hold', dur: hold } : { t, lane, type: 'tap' };
      notes.push(note);
      const layered = note.type === 'hold' && hold !== h.holdMs && h.layerHoldMs > 0;
      decisions.set(note, {
        source: layered ? 'bass' : h.source,
        reason: h.reason,
        score: Math.round(h.strength * 100) / 100,
        group: h.group,
        instance: h.instance,
        template: h.template,
        relTick: h.relTick,
        division: h.division,
        chord: c.lanes.length,
        hold: note.type === 'hold' ? (layered ? 'layered bass' : h.holdSource || 'sustain') : '',
      });
    });
  });
  notes.sort(compareNotes);
  // Safety net: nothing may overlap a kept note or another new note.
  for (let guard = 0; guard < 1000; guard++) {
    const hit = findOverlap(kept, notes);
    if (!hit) break;
    notes = notes.filter((n) => n !== hit.candidate);
    decisions.delete(hit.candidate);
  }

  // Rejections: candidates in the range with no note head nearby.
  const heads = [...new Set(notes.map((n) => n.t))].sort((x, y) => x - y);
  const droppedTimes = dropped.map((h) => h.tMs);
  const rejections: Rejection[] = [];
  const cands = a.candidates;
  for (let i = firstAtOrAfter(cands, range.startMs, (c) => c.tMs); i < cands.length; i++) {
    const c = cands[i] as Candidate;
    if (c.tMs > range.endMs) break;
    const k = firstAtOrAfter(heads, c.tMs - 20, (x) => x);
    if ((heads[k] ?? Infinity) <= c.tMs + 20) continue;
    const d = firstAtOrAfter(droppedTimes, c.tMs - 20, (x) => x);
    const reason =
      (droppedTimes[d] ?? Infinity) <= c.tMs + 20
        ? 'no free lane'
        : (rejected.get(c) ?? 'below threshold');
    rejections.push({ tMs: c.tMs, layer: c.layer, strength: c.strength, reason });
  }

  const inRange = kept.filter((n) => n.t >= range.startMs && n.t <= range.endMs).concat(notes);
  return {
    notes,
    removed,
    decisions,
    rejections,
    plan,
    rangeMs: range,
    stats: measureGeneration(notes, decisions, inRange, a, plan, range, p.intenseThreshold),
    seed: o.seed,
  };
}
