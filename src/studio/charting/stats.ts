import type { Note } from '../../core/chart';
import { noteEnd } from '../../core/chart';
import { SECTION_SHORT, type ChartAnalysis, type SectionRole } from './analysis/types';
import type { HitSource, NoteDecision } from './hits';
import { countIn, hitTimes, maxInWindow, windowNps } from './metrics';
import { cellOf, type DensityPlan } from './plan';

/**
 * What a generation produced, measured on the notes (not on any template): density, holds,
 * chords, how often jacks, trills and stairs occur, gaps, and how alike repeats came out.
 */

export interface SectionNps {
  role: SectionRole;
  label: string;
  startMs: number;
  endMs: number;
  /** Measured notes per second (hits; a chord counts once). */
  nps: number;
  /** The density plan's mean target there. */
  targetNps: number;
}

export interface GenerateStats {
  notes: number;
  hits: number;
  avgNps: number;
  /** Densest 4-beat window. */
  peakNps: number;
  /** Densest one-beat window. */
  burstNps: number;
  holds: number;
  shortHolds: number;
  longHolds: number;
  /** Shares (0-1). */
  holdShare: number;
  chordShare: number;
  jackShare: number;
  trillShare: number;
  stairShare: number;
  longestGapMs: number;
  longestGapAtMs: number;
  /** Longest gap whose middle lies in an intense part. */
  longestIntenseGapMs: number;
  /** 0-1: how alike repeated phrases' rhythms are (null without repeats in range). */
  repeatConsistency: number | null;
  /** The same over the shared rhythm (spine and lead runs) only. */
  spineConsistency: number | null;
  sections: SectionNps[];
  /** Generated notes by where their timing came from. */
  sources: Partial<Record<HitSource, number>>;
}

export function measureGeneration(
  generated: readonly Note[],
  decisions: ReadonlyMap<Note, NoteDecision>,
  /** Every note in the range after accepting (kept + generated). */
  inRange: readonly Note[],
  a: ChartAnalysis,
  plan: DensityPlan,
  range: { startMs: number; endMs: number },
  intenseThreshold: number,
): GenerateStats {
  const beatMs = 60000 / a.bpm;
  const spanMs = Math.max(1, range.endMs - range.startMs);
  const times = hitTimes(inRange);
  const nps = windowNps(times, range.startMs, range.endMs, Math.min(spanMs, beatMs * 4));
  const holds = generated.filter((n) => n.type === 'hold');
  const shortHolds = holds.filter((n) => n.type === 'hold' && n.dur < beatMs).length;

  // Chords and lane movement over distinct head times.
  const byTime = new Map<number, Note[]>();
  for (const n of inRange) {
    const arr = byTime.get(n.t) ?? [];
    arr.push(n);
    byTime.set(n.t, arr);
  }
  let chords = 0;
  let transitions = 0;
  let jacks = 0;
  let trills = 0;
  let stairs = 0;
  let prev = null as { t: number; lane: number } | null;
  let prev2 = null as { t: number; lane: number } | null;
  for (const t of times) {
    const group = byTime.get(t) ?? [];
    if (group.length > 1) {
      chords++;
      prev = null;
      prev2 = null;
      continue;
    }
    const lane = (group[0] as Note).lane;
    if (prev && t - prev.t <= beatMs) {
      transitions++;
      if (lane === prev.lane) jacks++;
      else if (prev2 && prev.t - prev2.t <= beatMs) {
        if (lane === prev2.lane) trills++;
        else if (
          Math.abs(lane - prev.lane) === 1 &&
          Math.sign(lane - prev.lane) === Math.sign(prev.lane - prev2.lane)
        ) {
          stairs++;
        }
      }
    }
    prev2 = prev;
    prev = { t, lane };
  }

  // Gaps: from the end of everything before to the next head.
  let longestGapMs = 0;
  let longestGapAtMs = range.startMs;
  let longestIntenseGapMs = 0;
  const sorted = [...inRange].sort((x, y) => x.t - y.t);
  let reach = -Infinity;
  for (const n of sorted) {
    if (reach > -Infinity) {
      const gap = n.t - reach;
      if (gap > longestGapMs) {
        longestGapMs = gap;
        longestGapAtMs = reach;
      }
      const mid = reach + gap / 2;
      if (
        gap > longestIntenseGapMs &&
        (plan.activity[cellOf(plan, mid)] ?? 0) >= intenseThreshold
      ) {
        longestIntenseGapMs = gap;
      }
    }
    reach = Math.max(reach, noteEnd(n));
  }

  // Repeat consistency: per template, each later occurrence against the first (Jaccard), over
  // all notes and over the shared rhythm (spine and lead runs) alone.
  const repeatConsistency = (onlySpine: boolean): number | null => {
    const positions = new Map<number, Map<number, Set<number>>>();
    for (const n of generated) {
      const d = decisions.get(n);
      if (!d || d.template < 0 || d.group < 0) continue;
      if (onlySpine && d.reason !== 'spine' && d.reason !== 'lead run') continue;
      let inst = positions.get(d.template);
      if (!inst) {
        inst = new Map();
        positions.set(d.template, inst);
      }
      const set = inst.get(d.instance) ?? new Set<number>();
      set.add(d.relTick);
      inst.set(d.instance, set);
    }
    let simSum = 0;
    let simCount = 0;
    for (const inst of positions.values()) {
      if (inst.size < 2) continue;
      const keys = [...inst.keys()].sort((x, y) => x - y);
      const first = inst.get(keys[0] as number) as Set<number>;
      for (const k of keys.slice(1)) {
        const other = inst.get(k) as Set<number>;
        let both = 0;
        for (const r of other) if (first.has(r)) both++;
        const union = first.size + other.size - both;
        if (union > 0) {
          simSum += both / union;
          simCount++;
        }
      }
    }
    return simCount > 0 ? simSum / simCount : null;
  };

  const sections: SectionNps[] = [];
  for (const s of a.structure.sections) {
    const s0 = Math.max(range.startMs, s.startMs);
    const s1 = Math.min(range.endMs, s.endMs);
    if (s1 - s0 < beatMs) continue;
    let target = 0;
    let cells = 0;
    for (let ms = s0; ms < s1; ms += beatMs) {
      target += plan.targets[cellOf(plan, ms)] ?? 0;
      cells++;
    }
    sections.push({
      role: s.role,
      label: SECTION_SHORT[s.role],
      startMs: s0,
      endMs: s1,
      nps: (countIn(times, s0, s1) * 1000) / (s1 - s0),
      targetNps: cells > 0 ? target / cells : 0,
    });
  }

  const sources: Partial<Record<HitSource, number>> = {};
  for (const n of generated) {
    const d = decisions.get(n);
    if (d) sources[d.source] = (sources[d.source] ?? 0) + 1;
  }
  const share = (x: number, of: number): number => (of > 0 ? x / of : 0);
  return {
    notes: generated.length,
    hits: hitTimes(generated).length,
    avgNps: (times.length * 1000) / spanMs,
    peakNps: Math.max(0, ...nps),
    burstNps: (maxInWindow(times, beatMs) * 1000) / beatMs,
    holds: holds.length,
    shortHolds,
    longHolds: holds.length - shortHolds,
    holdShare: share(holds.length, generated.length),
    chordShare: share(chords, times.length),
    jackShare: share(jacks, transitions),
    trillShare: share(trills, transitions),
    stairShare: share(stairs, transitions),
    longestGapMs,
    longestGapAtMs,
    longestIntenseGapMs,
    repeatConsistency: repeatConsistency(false),
    spineConsistency: repeatConsistency(true),
    sections,
    sources,
  };
}
