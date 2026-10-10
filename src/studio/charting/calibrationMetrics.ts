import { noteEnd, type Lane, type Note } from '../../core/chart';
import { LAYERS, type ChartAnalysis, type LayerId, type SectionRole } from './analysis/types';
import {
  DEFAULT_COMPARE_TOLERANCE_MS,
  HIT_MERGE_MS,
  countsOf,
  matchSorted,
  mergeHits,
  type MatchCounts,
} from './compare';

/**
 * Phase 19 calibration metrics: a generated chart against a hand-made reference chart of the
 * same song (docs/charting-calibration.md). Used by scripts/calibrate.mjs only (dev); pure, no
 * DOM. Every metric can be restricted to a time range, so the tuning can fit on one half of the
 * song and validate on the other.
 *
 *   1. rhythm match           precision / recall / F1 of hit times (+/-35 ms, lanes ignored)
 *   2. layer attribution      which analysis layer explains each reference hit; misses
 *   3. density                2-beat nps curves: correlation, intense/calm ratio, floor, gaps
 *   4. holds                  per minute, short share, length, layered holds
 *   5. lanes                  chord / jack / trill / stair rates, hands, lanes, entropy
 *   6. repetition             identical rhythm across the instances of each repeat group
 *
 * and a composite score (0-1) for the parameter search.
 */

export const DENSITY_WINDOW_BEATS = 2;

export interface Range {
  startMs: number;
  endMs: number;
}

const inRange = (t: number, r: Range): boolean => t >= r.startMs && t < r.endMs;

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

const mean = (xs: readonly number[]): number =>
  xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;

function lowerBound(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// --- 1. Rhythm match ---------------------------------------------------------------------------

export function rhythmMatch(
  reference: readonly Note[],
  generated: readonly Note[],
  range: Range,
  toleranceMs = DEFAULT_COMPARE_TOLERANCE_MS,
): MatchCounts {
  const ref = mergeHits(reference.filter((n) => inRange(n.t, range)).map((n) => n.t));
  const gen = mergeHits(generated.filter((n) => inRange(n.t, range)).map((n) => n.t));
  return countsOf(matchSorted(ref, gen, toleranceMs).pairs.length, ref.length, gen.length);
}

// --- 2. Layer attribution ------------------------------------------------------------------------

export type MissContext =
  | 'inside a lead run'
  | 'held lead note (no new onset)'
  | 'lead note, onset not picked'
  | 'drums or percussion only'
  | 'bass / low end'
  | 'quiet passage'
  | 'dense mix, no onset found';

export interface MissGroup {
  startMs: number;
  endMs: number;
  count: number;
  role: SectionRole | 'none';
  /** The most common context of the misses in the group. */
  context: MissContext;
  /** The loudest band around the misses. */
  band: string;
}

/** Attribution looks for a clear onset (strength >= CLEAR_STRENGTH) this close to a hit. */
export const ATTRIBUTION_TOLERANCE_MS = 25;
export const CLEAR_STRENGTH = 0.5;

export interface LayerAttribution {
  /** Reference hits in range. */
  hits: number;
  /** Share of hits with a clear candidate within ATTRIBUTION_TOLERANCE_MS (analyzer recall). */
  explained: number;
  /**
   * The same for the reference shifted by 3/8 of a beat both ways (off the grid): what chance
   * alone explains with this many candidates. `explained` means little unless it is well above.
   */
  explainedByChance: number;
  /** Share explained by any candidate (any strength) within the 35 ms match tolerance. */
  explainedLoose: number;
  /** Share per layer: the explaining candidate's strongest layer (sums to `explained`). */
  primaryShare: Record<LayerId, number>;
  /** Share per layer: hits that layer has a clear onset for (multi-label). */
  anyShare: Record<LayerId, number>;
  /** Share of all eighth-note grid positions with a clear onset of the layer (the baseline). */
  gridShare: Record<LayerId, number>;
  /** anyShare / gridShare: above 1, the charter follows the layer more than the grid does. */
  lift: Record<LayerId, number>;
  /** Detected lead runs: reference hits inside them, and the share lead onsets explain. */
  leadRuns: {
    runs: number;
    refHits: number;
    leadRecall: number;
    anyRecall: number;
    generatedRecall: number;
    /** Lead onsets inside the runs, and the share the reference / generated chart has a hit for. */
    runOnsets: number;
    refChartsOnsets: number;
    genChartsOnsets: number;
  };
  /**
   * Fast passages of the reference itself (4+ hits, gaps at most a third of a beat): the share
   * lead onsets, any onsets and the generated chart explain. Independent of the run detector.
   */
  fastPassages: {
    passages: number;
    refHits: number;
    leadRecall: number;
    anyRecall: number;
    generatedRecall: number;
  };
  /** Unexplained reference hits, grouped (gap under 2 beats) with what happens there. */
  misses: MissGroup[];
  missCount: number;
}

export function layerAttribution(
  a: ChartAnalysis,
  reference: readonly Note[],
  generated: readonly Note[],
  range: Range,
  toleranceMs = DEFAULT_COMPARE_TOLERANCE_MS,
): LayerAttribution {
  const ref = mergeHits(reference.filter((n) => inRange(n.t, range)).map((n) => n.t));
  const gen = mergeHits(generated.map((n) => n.t));
  const beatMs = a.bpm > 0 ? 60000 / a.bpm : 500;
  const tol = ATTRIBUTION_TOLERANCE_MS;
  const cands = a.candidates.filter((c) => c.strength >= CLEAR_STRENGTH);
  const candTimes = cands.map((c) => c.tMs);
  const allTimes = a.candidates.map((c) => c.tMs);
  const layerTimes = {} as Record<LayerId, number[]>;
  for (const l of LAYERS) {
    layerTimes[l] = a.layerOnsets[l].filter((o) => o.strength >= CLEAR_STRENGTH).map((o) => o.tMs);
  }
  const near = (times: readonly number[], t: number, within = tol): number => {
    const i = lowerBound(times, t - within);
    let best = -1;
    for (let k = i; k < times.length && (times[k] as number) <= t + within; k++) {
      if (best < 0 || Math.abs((times[k] as number) - t) < Math.abs((times[best] as number) - t))
        best = k;
    }
    return best;
  };
  const has = (times: readonly number[], t: number, within = tol): boolean =>
    near(times, t, within) >= 0;

  const zero = (): Record<LayerId, number> =>
    Object.fromEntries(LAYERS.map((l) => [l, 0])) as Record<LayerId, number>;
  const primary = zero();
  const any = zero();
  const gridShare = zero();
  const lift = zero();
  let explained = 0;
  let loose = 0;
  const missTimes: number[] = [];
  for (const t of ref) {
    const k = near(candTimes, t);
    if (k >= 0) {
      explained += 1;
      const c = cands[k];
      if (c) primary[c.layer] += 1;
    } else {
      missTimes.push(t);
    }
    if (has(allTimes, t, toleranceMs)) loose += 1;
    for (const l of LAYERS) if (has(layerTimes[l], t)) any[l] += 1;
  }
  const shift = (beatMs * 3) / 8;
  let chance = 0;
  for (const t of ref) {
    if (has(candTimes, t - shift)) chance += 0.5;
    if (has(candTimes, t + shift)) chance += 0.5;
  }
  const n = Math.max(1, ref.length);
  // Eighth-note grid positions over the reference's span.
  const grid: number[] = [];
  if (ref.length > 0) {
    const step = beatMs / 2;
    const k0 = Math.ceil(((ref[0] as number) - a.offsetMs) / step);
    for (let k = k0; a.offsetMs + k * step <= (ref[ref.length - 1] as number); k++) {
      grid.push(a.offsetMs + k * step);
    }
  }
  for (const l of LAYERS) {
    primary[l] /= n;
    any[l] /= n;
    gridShare[l] = grid.filter((t) => has(layerTimes[l], t)).length / Math.max(1, grid.length);
    lift[l] = gridShare[l] > 0 ? any[l] / gridShare[l] : 0;
  }

  // Generated hits matched one to one (so a single generated note never explains two).
  const genMatch = matchSorted(ref, gen, toleranceMs).refMatched;
  const runs = a.leadRuns;
  const inRun = (t: number): boolean => runs.some((r) => t >= r.startMs - 20 && t <= r.endMs + 20);
  const subset = (idx: number[]): { lead: number; any: number; gen: number } => {
    const m = Math.max(1, idx.length);
    let lead = 0;
    let anyHit = 0;
    let g = 0;
    for (const i of idx) {
      const t = ref[i] as number;
      if (has(layerTimes.lead, t)) lead += 1;
      if (has(candTimes, t)) anyHit += 1;
      if (genMatch[i]) g += 1;
    }
    return { lead: lead / m, any: anyHit / m, gen: g / m };
  };
  const runIdx = ref.map((t, i) => (inRun(t) ? i : -1)).filter((i) => i >= 0);
  const r = subset(runIdx);
  let runOnsets = 0;
  let refCharts = 0;
  let genCharts = 0;
  for (const o of a.layerOnsets.lead) {
    if (!inRun(o.tMs) || !inRange(o.tMs, range)) continue;
    runOnsets += 1;
    if (has(ref, o.tMs, toleranceMs)) refCharts += 1;
    if (has(gen, o.tMs, toleranceMs)) genCharts += 1;
  }

  // The reference's own fast passages.
  const maxGap = beatMs / 3 + 2;
  const fastIdx: number[] = [];
  let passages = 0;
  for (let i = 0; i < ref.length;) {
    let j = i;
    while (j + 1 < ref.length && (ref[j + 1] as number) - (ref[j] as number) <= maxGap) j++;
    if (j - i + 1 >= 4) {
      passages += 1;
      for (let k = i; k <= j; k++) fastIdx.push(k);
    }
    i = j + 1;
  }
  const fp = subset(fastIdx);

  // Misses, grouped, with context.
  const f = a.features;
  const frameAt = (t: number): number =>
    Math.max(0, Math.min(f.frameCount - 1, Math.round(t / f.frameMs)));
  const leadNotes = a.leadNotes;
  const leadStarts = leadNotes.map((x) => x.tMs);
  const contextOf = (t: number): { context: MissContext; band: string } => {
    const k = frameAt(t);
    let band = 'sub';
    let top = -1;
    for (const [id, curve] of Object.entries(f.bands)) {
      const v = curve[k] ?? 0;
      if (v > top) {
        top = v;
        band = id;
      }
    }
    const loud = f.loudness[k] ?? 0;
    if (inRun(t)) return { context: 'inside a lead run', band };
    if (loud < 0.25) return { context: 'quiet passage', band };
    const li = lowerBound(leadStarts, t + 1) - 1;
    const held = li >= 0 ? leadNotes[li] : undefined;
    if (held && t > held.tMs + toleranceMs && t <= held.tMs + held.durMs)
      return { context: 'held lead note (no new onset)', band };
    if (has(leadStarts, t)) return { context: 'lead note, onset not picked', band };
    if (band === 'sub' || band === 'low') return { context: 'bass / low end', band };
    if (band === 'high' || band === 'highMid') return { context: 'drums or percussion only', band };
    return { context: 'dense mix, no onset found', band };
  };
  const roleAt = (t: number): SectionRole | 'none' =>
    a.structure.sections.find((s) => t >= s.startMs && t < s.endMs)?.role ?? 'none';
  const misses: MissGroup[] = [];
  let cur: { times: number[] } | null = null;
  const flush = (): void => {
    if (!cur || cur.times.length === 0) return;
    const ctx = cur.times.map(contextOf);
    const tally = new Map<string, number>();
    const bands = new Map<string, number>();
    for (const c of ctx) {
      tally.set(c.context, (tally.get(c.context) ?? 0) + 1);
      bands.set(c.band, (bands.get(c.band) ?? 0) + 1);
    }
    const top = <K>(m: Map<K, number>): K =>
      [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] as K;
    const s = cur.times[0] as number;
    const e = cur.times[cur.times.length - 1] as number;
    misses.push({
      startMs: s,
      endMs: e,
      count: cur.times.length,
      role: roleAt((s + e) / 2),
      context: top(tally) as MissContext,
      band: top(bands),
    });
  };
  for (const t of missTimes) {
    const last = cur?.times[cur.times.length - 1];
    if (cur && last !== undefined && t - last <= beatMs * 2) cur.times.push(t);
    else {
      flush();
      cur = { times: [t] };
    }
  }
  flush();

  return {
    hits: ref.length,
    explained: explained / n,
    explainedByChance: chance / n,
    explainedLoose: loose / n,
    primaryShare: primary,
    anyShare: any,
    gridShare,
    lift,
    leadRuns: {
      runs: runs.filter((x) => x.endMs > range.startMs && x.startMs < range.endMs).length,
      runOnsets,
      refChartsOnsets: runOnsets > 0 ? refCharts / runOnsets : 0,
      genChartsOnsets: runOnsets > 0 ? genCharts / runOnsets : 0,
      refHits: runIdx.length,
      leadRecall: r.lead,
      anyRecall: r.any,
      generatedRecall: r.gen,
    },
    fastPassages: {
      passages,
      refHits: fastIdx.length,
      leadRecall: fp.lead,
      anyRecall: fp.any,
      generatedRecall: fp.gen,
    },
    misses,
    missCount: missTimes.length,
  };
}

// --- 3. Density -------------------------------------------------------------------------------------

export interface DensityMetrics {
  windowMs: number;
  windows: number;
  correlation: number;
  refMeanNps: number;
  genMeanNps: number;
  /** Mean nps of the most active third of windows over the calmest third. */
  refIntenseCalmRatio: number;
  genIntenseCalmRatio: number;
  /** Calm windows where the reference has notes: the lowest generated nps, and the 10th pct. */
  genCalmMinNps: number;
  genCalmP10Nps: number;
  refCalmMinNps: number;
  /** Share of windows with reference notes where the generated chart has none. */
  emptyWhereRefHasNotes: number;
  /** Longest gap between hits whose middle lies in an intense window, ms. */
  refLongestIntenseGapMs: number;
  genLongestIntenseGapMs: number;
  /** Per window, for plots. */
  series: { startMs: number; activity: number; ref: number; gen: number }[];
}

export function densityMetrics(
  a: ChartAnalysis,
  reference: readonly Note[],
  generated: readonly Note[],
  range: Range,
): DensityMetrics {
  const beatMs = 60000 / a.bpm;
  const windowMs = beatMs * DENSITY_WINDOW_BEATS;
  const ref = mergeHits(reference.filter((n) => inRange(n.t, range)).map((n) => n.t));
  const gen = mergeHits(generated.filter((n) => inRange(n.t, range)).map((n) => n.t));
  // Windows on the beat grid, over the reference's span inside the range.
  const first = ref[0] ?? range.startMs;
  const last = ref[ref.length - 1] ?? range.endMs;
  const k0 = Math.floor((first - a.offsetMs) / windowMs);
  const k1 = Math.floor((last - a.offsetMs) / windowMs);
  const series: DensityMetrics['series'] = [];
  const f = a.features;
  for (let k = k0; k <= k1; k++) {
    const s = a.offsetMs + k * windowMs;
    const e = s + windowMs;
    const c = (xs: number[]): number => lowerBound(xs, e) - lowerBound(xs, s);
    let act = 0;
    let cnt = 0;
    for (
      let q = Math.max(0, Math.floor(s / f.frameMs));
      q < Math.min(f.frameCount, e / f.frameMs);
      q++
    ) {
      act += a.activity[q] ?? 0;
      cnt += 1;
    }
    series.push({
      startMs: s,
      activity: cnt > 0 ? act / cnt : 0,
      ref: (c(ref) * 1000) / windowMs,
      gen: (c(gen) * 1000) / windowMs,
    });
  }
  const order = series
    .map((_, i) => i)
    .sort((x, y) => (series[x]?.activity ?? 0) - (series[y]?.activity ?? 0));
  const third = Math.max(1, Math.floor(order.length / 3));
  const calm = order.slice(0, third);
  const intense = new Set(order.slice(order.length - third));
  const ratio = (key: 'ref' | 'gen'): number => {
    const hi = mean([...intense].map((i) => series[i]?.[key] ?? 0));
    const lo = mean(calm.map((i) => series[i]?.[key] ?? 0));
    return lo > 0 ? hi / lo : hi > 0 ? 10 : 1;
  };
  const calmWithNotes = calm.filter((i) => (series[i]?.ref ?? 0) > 0);
  const genCalm = calmWithNotes.map((i) => series[i]?.gen ?? 0).sort((x, y) => x - y);
  const refCalm = calmWithNotes.map((i) => series[i]?.ref ?? 0).sort((x, y) => x - y);
  const withNotes = series.filter((w) => w.ref > 0);
  const longestGap = (hits: number[]): number => {
    let best = 0;
    for (let i = 1; i < hits.length; i++) {
      const g = (hits[i] as number) - (hits[i - 1] as number);
      const mid = ((hits[i] as number) + (hits[i - 1] as number)) / 2;
      const w = Math.floor((mid - a.offsetMs) / windowMs) - k0;
      if (intense.has(w) && g > best) best = g;
    }
    return best;
  };
  return {
    windowMs,
    windows: series.length,
    correlation: pearson(
      series.map((w) => w.ref),
      series.map((w) => w.gen),
    ),
    refMeanNps: mean(series.map((w) => w.ref)),
    genMeanNps: mean(series.map((w) => w.gen)),
    refIntenseCalmRatio: ratio('ref'),
    genIntenseCalmRatio: ratio('gen'),
    genCalmMinNps: genCalm[0] ?? 0,
    genCalmP10Nps: genCalm[Math.floor(genCalm.length * 0.1)] ?? 0,
    refCalmMinNps: refCalm[0] ?? 0,
    emptyWhereRefHasNotes:
      withNotes.length > 0 ? withNotes.filter((w) => w.gen === 0).length / withNotes.length : 0,
    refLongestIntenseGapMs: longestGap(ref),
    genLongestIntenseGapMs: longestGap(gen),
    series,
  };
}

// --- 4. Holds -----------------------------------------------------------------------------------------

export interface HoldMetrics {
  perMinute: number;
  /** Share of all notes that are holds. */
  share: number;
  /** Share of holds shorter than a beat. */
  shortShare: number;
  avgMs: number;
  /** Share of holds with another note's head inside them (taps during a hold). */
  layeredShare: number;
}

export function holdMetrics(notes: readonly Note[], range: Range, beatMs: number): HoldMetrics {
  const list = notes.filter((n) => inRange(n.t, range));
  const holds = list.filter((n) => n.type === 'hold');
  const minutes = Math.max(1e-6, (range.endMs - range.startMs) / 60000);
  const heads = list.map((n) => n.t).sort((x, y) => x - y);
  let layered = 0;
  for (const h of holds) {
    const end = noteEnd(h);
    const i = lowerBound(heads, h.t + HIT_MERGE_MS);
    if (i < heads.length && (heads[i] as number) < end - HIT_MERGE_MS) layered += 1;
  }
  return {
    perMinute: holds.length / minutes,
    share: list.length > 0 ? holds.length / list.length : 0,
    shortShare:
      holds.length > 0 ? holds.filter((h) => noteEnd(h) - h.t < beatMs).length / holds.length : 0,
    avgMs: mean(holds.map((h) => noteEnd(h) - h.t)),
    layeredShare: holds.length > 0 ? layered / holds.length : 0,
  };
}

// --- 5. Lanes -----------------------------------------------------------------------------------------

export interface LaneMetrics {
  /** Share of hits with two or more notes. */
  chordRate: number;
  /** Share of consecutive hits (at most a beat apart) that reuse a lane. */
  jackRate: number;
  /** Share of single-note triples a-b-a (a != b), at most a beat apart. */
  trillRate: number;
  /** Share of single-note triples moving one lane at a time in one direction. */
  stairRate: number;
  /** Share of notes on the left hand (lanes 1-2). */
  leftShare: number;
  /** Share of notes per lane. */
  lanes: [number, number, number, number];
  /** Entropy of single-note lane transitions, bits (4 = uniform over 16). */
  transitionEntropy: number;
}

export function laneMetrics(notes: readonly Note[], range: Range, beatMs: number): LaneMetrics {
  const list = notes
    .filter((n) => inRange(n.t, range))
    .sort((x, y) => x.t - y.t || x.lane - y.lane);
  const hits: { t: number; lanes: Lane[] }[] = [];
  for (const n of list) {
    const last = hits[hits.length - 1];
    if (last && n.t - last.t < HIT_MERGE_MS) last.lanes.push(n.lane);
    else hits.push({ t: n.t, lanes: [n.lane] });
  }
  let chords = 0;
  for (const h of hits) if (h.lanes.length >= 2) chords += 1;
  let pairs = 0;
  let jacks = 0;
  for (let i = 1; i < hits.length; i++) {
    const p = hits[i - 1] as { t: number; lanes: Lane[] };
    const c = hits[i] as { t: number; lanes: Lane[] };
    if (c.t - p.t > beatMs) continue;
    pairs += 1;
    if (c.lanes.some((l) => p.lanes.includes(l))) jacks += 1;
  }
  let triples = 0;
  let trills = 0;
  let stairs = 0;
  const trans = new Map<number, number>();
  let transCount = 0;
  for (let i = 1; i < hits.length; i++) {
    const b = hits[i - 1] as { t: number; lanes: Lane[] };
    const c = hits[i] as { t: number; lanes: Lane[] };
    if (b.lanes.length === 1 && c.lanes.length === 1 && c.t - b.t <= beatMs) {
      const key = (b.lanes[0] as number) * 4 + (c.lanes[0] as number);
      trans.set(key, (trans.get(key) ?? 0) + 1);
      transCount += 1;
    }
    if (i < 2) continue;
    const a0 = hits[i - 2] as { t: number; lanes: Lane[] };
    if (a0.lanes.length !== 1 || b.lanes.length !== 1 || c.lanes.length !== 1) continue;
    if (c.t - a0.t > 2 * beatMs) continue;
    triples += 1;
    const x = a0.lanes[0] as number;
    const y = b.lanes[0] as number;
    const z = c.lanes[0] as number;
    if (x === z && x !== y) trills += 1;
    if (y - x === z - y && Math.abs(y - x) === 1) stairs += 1;
  }
  let entropy = 0;
  for (const v of trans.values()) {
    const pr = v / Math.max(1, transCount);
    entropy -= pr * Math.log2(pr);
  }
  const lanes: [number, number, number, number] = [0, 0, 0, 0];
  for (const n of list) lanes[n.lane] += 1;
  const total = Math.max(1, list.length);
  return {
    chordRate: hits.length > 0 ? chords / hits.length : 0,
    jackRate: pairs > 0 ? jacks / pairs : 0,
    trillRate: triples > 0 ? trills / triples : 0,
    stairRate: triples > 0 ? stairs / triples : 0,
    leftShare: (lanes[0] + lanes[1]) / total,
    lanes: lanes.map((v) => v / total) as [number, number, number, number],
    transitionEntropy: entropy,
  };
}

// --- 6. Repetition ------------------------------------------------------------------------------------

export interface RepetitionMetrics {
  /** Per repeated group: mean pairwise identical-rhythm share across its instances. */
  groups: { group: number; instances: number; consistency: number }[];
  /** Weighted by instance count; null without repeats in range. */
  overall: number | null;
}

/**
 * Rhythm of each instance of each repeat group on a sixteenth grid relative to the phrase start;
 * consistency is the mean Jaccard similarity (shared positions over all positions) of all pairs.
 */
export function repetitionMetrics(
  a: ChartAnalysis,
  notes: readonly Note[],
  range: Range,
): RepetitionMetrics {
  const step = 60000 / a.bpm / 4;
  const hits = mergeHits(notes.map((n) => n.t));
  const instances = new Map<string, { group: number; startMs: number; endMs: number }>();
  for (const bar of a.structure.bars) {
    if (bar.group < 0) continue;
    const key = `${bar.group}:${bar.repeatIndex}`;
    const cur = instances.get(key);
    if (cur) cur.endMs = Math.max(cur.endMs, bar.endMs);
    else instances.set(key, { group: bar.group, startMs: bar.startMs, endMs: bar.endMs });
  }
  const byGroup = new Map<number, Set<number>[]>();
  for (const inst of instances.values()) {
    if (inst.startMs < range.startMs || inst.endMs > range.endMs) continue;
    const set = new Set<number>();
    for (let i = lowerBound(hits, inst.startMs - step / 2); i < hits.length; i++) {
      const t = hits[i] as number;
      if (t >= inst.endMs - step / 2) break;
      set.add(Math.round((t - inst.startMs) / step));
    }
    const arr = byGroup.get(inst.group) ?? [];
    arr.push(set);
    byGroup.set(inst.group, arr);
  }
  const groups: RepetitionMetrics['groups'] = [];
  for (const [group, sets] of byGroup) {
    if (sets.length < 2) continue;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const x = sets[i] as Set<number>;
        const y = sets[j] as Set<number>;
        let both = 0;
        for (const v of x) if (y.has(v)) both += 1;
        const union = x.size + y.size - both;
        sum += union > 0 ? both / union : 1;
        count += 1;
      }
    }
    groups.push({ group, instances: sets.length, consistency: sum / Math.max(1, count) });
  }
  groups.sort((x, y) => x.group - y.group);
  const w = groups.reduce((s, g) => s + g.instances, 0);
  return {
    groups,
    overall: w > 0 ? groups.reduce((s, g) => s + g.consistency * g.instances, 0) / w : null,
  };
}

// --- Everything and the composite ----------------------------------------------------------------

export interface CalibrationMetrics {
  range: Range;
  rhythm: MatchCounts;
  layers: LayerAttribution;
  density: DensityMetrics;
  holds: { ref: HoldMetrics; gen: HoldMetrics };
  lanes: { ref: LaneMetrics; gen: LaneMetrics };
  repetition: { ref: RepetitionMetrics; gen: RepetitionMetrics };
  /** Sub-scores (0-1) and their weighted mean. */
  scores: Record<ScorePart, number>;
  composite: number;
}

export const SCORE_WEIGHTS = {
  rhythmF1: 0.3,
  densityCorrelation: 0.12,
  meanDensity: 0.08,
  intenseCalm: 0.08,
  calmFloor: 0.08,
  intenseGap: 0.04,
  leadRuns: 0.08,
  holds: 0.08,
  lanes: 0.08,
  repetition: 0.06,
} as const;
export type ScorePart = keyof typeof SCORE_WEIGHTS;

/** 1 when x equals target, 0 at a factor of two either way (log scale). */
export function ratioCloseness(x: number, target: number): number {
  if (!(target > 0)) return x > 0 ? 0.5 : 1;
  if (!(x > 0)) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(x / target)) / Math.LN2);
}
const diffCloseness = (x: number, target: number, scale: number): number =>
  Math.max(0, 1 - Math.abs(x - target) / scale);

export function calibrationMetrics(
  a: ChartAnalysis,
  reference: readonly Note[],
  generated: readonly Note[],
  range: Range,
  toleranceMs = DEFAULT_COMPARE_TOLERANCE_MS,
): CalibrationMetrics {
  const beatMs = 60000 / a.bpm;
  const rhythm = rhythmMatch(reference, generated, range, toleranceMs);
  const layers = layerAttribution(a, reference, generated, range, toleranceMs);
  const density = densityMetrics(a, reference, generated, range);
  const holds = {
    ref: holdMetrics(reference, range, beatMs),
    gen: holdMetrics(generated, range, beatMs),
  };
  const lanes = {
    ref: laneMetrics(reference, range, beatMs),
    gen: laneMetrics(generated, range, beatMs),
  };
  const repetition = {
    ref: repetitionMetrics(a, reference, range),
    gen: repetitionMetrics(a, generated, range),
  };
  const lr = layers.fastPassages.refHits > 0 ? layers.fastPassages.generatedRecall : 1;
  const runs = layers.leadRuns.refHits > 0 ? layers.leadRuns.generatedRecall : lr;
  const scores: Record<ScorePart, number> = {
    rhythmF1: rhythm.f1,
    densityCorrelation: Math.max(0, density.correlation),
    meanDensity: ratioCloseness(density.genMeanNps, density.refMeanNps),
    intenseCalm: ratioCloseness(density.genIntenseCalmRatio, density.refIntenseCalmRatio),
    calmFloor: 1 - density.emptyWhereRefHasNotes,
    intenseGap:
      density.genLongestIntenseGapMs <= density.refLongestIntenseGapMs
        ? 1
        : ratioCloseness(density.genLongestIntenseGapMs, density.refLongestIntenseGapMs),
    leadRuns: 0.5 * lr + 0.5 * runs,
    holds: mean([
      ratioCloseness(holds.gen.perMinute, holds.ref.perMinute),
      diffCloseness(holds.gen.shortShare, holds.ref.shortShare, 0.5),
      ratioCloseness(holds.gen.avgMs, holds.ref.avgMs),
      diffCloseness(holds.gen.layeredShare, holds.ref.layeredShare, 0.5),
    ]),
    lanes: mean([
      diffCloseness(lanes.gen.chordRate, lanes.ref.chordRate, 0.3),
      diffCloseness(lanes.gen.jackRate, lanes.ref.jackRate, 0.3),
      diffCloseness(lanes.gen.trillRate, lanes.ref.trillRate, 0.3),
      diffCloseness(lanes.gen.stairRate, lanes.ref.stairRate, 0.3),
      diffCloseness(lanes.gen.leftShare, lanes.ref.leftShare, 0.2),
      diffCloseness(lanes.gen.transitionEntropy, lanes.ref.transitionEntropy, 1.5),
    ]),
    repetition:
      repetition.ref.overall !== null && repetition.gen.overall !== null
        ? diffCloseness(repetition.gen.overall, repetition.ref.overall, 0.5)
        : 1,
  };
  let composite = 0;
  for (const k of Object.keys(SCORE_WEIGHTS) as ScorePart[])
    composite += SCORE_WEIGHTS[k] * scores[k];
  return { range, rhythm, layers, density, holds, lanes, repetition, scores, composite };
}
