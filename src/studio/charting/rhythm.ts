import {
  LAYERS,
  type Bar,
  type Candidate,
  type ChartAnalysis,
  type LayerId,
  type LeadNote,
} from './analysis/types';
import {
  RANK_OF,
  TICKS_PER_BEAT,
  firstAtOrAfter,
  hash01,
  lerp,
  metricWeight,
  type Hit,
  type HitSource,
  type NoteReason,
  type RejectReason,
  type TickGrid,
} from './hits';
import { cellOf, type DensityPlan } from './plan';
import type { GeneratorParams } from './presets';

/**
 * Steps B, C and F: which moments get notes, before any lane is chosen.
 *
 * - Phrases come from the analysis's bars and repeat groups. Every repeat group (or a lone
 *   phrase) becomes one TEMPLATE whose instances share one rhythm: onsets of all instances are
 *   pooled on phrase-relative ticks.
 * - Per template, each layer's rhythmic salience (density, regularity, strength, times its
 *   weight and a priority: lead > snare > kick > other > bass > hats) picks the primary layer;
 *   its onsets are the spine. Lead runs join the spine one to one. One grid per template (the
 *   coarsest that fits the spine), kept for the whole phrase.
 * - Repeats keep the consensus: positions present in most instances (or strong on average).
 * - Caps: hard ceiling (minimum gap), burst (per beat) and the bar budget from the density plan
 *   (the smallest over the instances). Over a cap, notes are thinned musically: the finest
 *   metric level first, evenly spaced, accents kept.
 * - Then secondary layers, a top-up toward the plan and gap fills in intense bars, all on the
 *   template, so every repeat gets them too. Per instance, "variation" may add extras within
 *   the caps (dropped first). Last, a global pass across phrase edges and the floor rule.
 */

const PRIORITY: Readonly<Record<LayerId, number>> = {
  lead: 1.35,
  snare: 1.15,
  kick: 1.05,
  other: 1,
  bass: 0.9,
  hats: 0.75,
};
/** Grids in order of fineness, and the even grid each triplet grid competes with. */
const DIVISIONS = [1, 2, 3, 4, 6, 8, 12, 16] as const;
const ODD_RIVAL: Readonly<Record<number, number>> = { 3: 4, 6: 8, 12: 16 };
/** Strength at or above which a note counts as an accent (kept when thinning). */
const ACCENT = 0.85;
/** Drum layers for the floor rule. */
const DRUMS: readonly LayerId[] = ['snare', 'kick', 'hats'];

export interface RhythmInput {
  analysis: ChartAnalysis;
  plan: DensityPlan;
  grid: TickGrid;
  params: GeneratorParams;
  seed: number;
  range: { startMs: number; endMs: number };
  /** Times of existing notes that stay (sorted, distinct). */
  occupied: readonly number[];
}

export interface RhythmResult {
  hits: Hit[];
  /** Reasons recorded for candidates that were left out (merged candidates as keys). */
  rejected: Map<Candidate, RejectReason>;
}

interface Phrase {
  startMs: number;
  endMs: number;
  startTick: number;
  endTick: number;
  group: number;
  instance: number;
  bars: Bar[];
}

interface Onset {
  inst: number;
  tMs: number;
  strength: number;
  cand: Candidate;
}

interface Agg {
  insts: Set<number>;
  sum: number;
  max: number;
  cands: Candidate[];
}

interface Pos {
  relTick: number;
  strength: number;
  source: HitSource;
  reason: NoteReason;
  layers: Partial<Record<LayerId, number>>;
  pitch: number | null;
  count: number;
}

interface Template {
  id: number;
  group: number;
  phrases: Phrase[];
  lengthTicks: number;
  barTicks: number;
  division: number;
  positions: Pos[];
}

export function selectRhythm(input: RhythmInput): RhythmResult {
  const { analysis: a, plan, grid, params: p, range } = input;
  const beatMs = grid.beatMs;
  const rejected = new Map<Candidate, RejectReason>();
  const reject = (c: Candidate, reason: RejectReason): void => {
    if (!rejected.has(c)) rejected.set(c, reason);
  };
  const tickMs = beatMs / TICKS_PER_BEAT;
  const minGapMs = 1000 / Math.max(1, p.ceilingNps);
  const perBeat = Math.max(1, Math.floor(p.burstNps * (beatMs / 1000) + 0.25));
  const leadThr = lerp(0.5, 0.05, p.leadSensitivity);
  const layerThr = (l: LayerId): number => (l === 'lead' ? leadThr : 0.25);
  const runs = a.leadRuns;
  const inRun = (ms: number): boolean => {
    const i = firstAtOrAfter(runs, ms + 1, (r) => r.startMs) - 1;
    const r = i >= 0 ? runs[i] : undefined;
    return r !== undefined && ms <= r.endMs + 1;
  };
  const runThr = leadThr * (1 - p.leadRunPriority);
  /**
   * At full lead-run priority (Expert) lead runs are charted at full resolution: their notes are
   * exempt from the burst and bar caps (the hard ceiling still applies). Phase 19.
   */
  const fullRuns = p.leadRunPriority >= 0.999;

  // --- Phrases and templates ------------------------------------------------------------------
  const phrases: Phrase[] = [];
  for (const bar of a.structure.bars) {
    if (bar.endMs <= range.startMs || bar.startMs >= range.endMs) continue;
    const last = phrases[phrases.length - 1];
    const sameRun =
      last &&
      bar.barInPhrase !== 0 &&
      bar.group === last.group &&
      last.bars.length < a.structure.phraseBars;
    if (sameRun) {
      last.bars.push(bar);
      last.endMs = bar.endMs;
      last.endTick = Math.round(grid.at(bar.endMs));
    } else {
      phrases.push({
        startMs: bar.startMs,
        endMs: bar.endMs,
        startTick: Math.round(grid.at(bar.startMs)),
        endTick: Math.round(grid.at(bar.endMs)),
        group: bar.group,
        instance: bar.repeatIndex,
        bars: [bar],
      });
    }
  }
  const templates: Template[] = [];
  const byGroup = new Map<number, Template>();
  const independent = p.repeatLock < 0.05;
  for (const ph of phrases) {
    const barTicks = Math.max(
      TICKS_PER_BEAT,
      Math.round(((ph.bars[0]?.endMs ?? 0) - (ph.bars[0]?.startMs ?? 0)) / tickMs),
    );
    const key = ph.group;
    const existing = !independent && key >= 0 ? byGroup.get(key) : undefined;
    if (existing) {
      existing.phrases.push(ph);
      existing.lengthTicks = Math.max(existing.lengthTicks, ph.endTick - ph.startTick);
      continue;
    }
    const t: Template = {
      id: templates.length,
      group: independent ? -1 : key,
      phrases: [ph],
      lengthTicks: ph.endTick - ph.startTick,
      barTicks,
      division: 4,
      positions: [],
    };
    templates.push(t);
    if (!independent && key >= 0) byGroup.set(key, t);
  }

  // --- Helpers ----------------------------------------------------------------------------------
  const cands = a.candidates;
  const candidatesIn = (fromMs: number, toMs: number): Candidate[] => {
    const out: Candidate[] = [];
    const lo = Math.max(fromMs, range.startMs);
    const hi = Math.min(toMs, range.endMs);
    for (let i = firstAtOrAfter(cands, lo, (c) => c.tMs); i < cands.length; i++) {
      const c = cands[i] as Candidate;
      if (c.tMs >= hi) break;
      out.push(c);
    }
    return out;
  };
  const leadNotes = a.leadNotes;
  const pitchAt = (ms: number): number | null => {
    const i = firstAtOrAfter(leadNotes, ms - 40, (n) => n.tMs);
    let best: LeadNote | null = null;
    for (let j = i; j < leadNotes.length; j++) {
      const n = leadNotes[j] as LeadNote;
      if (n.tMs > ms + 40) break;
      if (!best || Math.abs(n.tMs - ms) < Math.abs(best.tMs - ms)) best = n;
    }
    if (best) return best.midi;
    // Inside a held lead note: its pitch.
    const k = firstAtOrAfter(leadNotes, ms + 1, (n) => n.tMs) - 1;
    const held = k >= 0 ? leadNotes[k] : undefined;
    return held && ms <= held.tMs + held.durMs ? held.midi : null;
  };
  const f = a.features;
  /** The layer whose onset envelope is most active at `ms`, weighted, and how active (0-1+). */
  const envAt = (ms: number): { layer: LayerId; score: number } => {
    const i = Math.max(0, Math.min(f.onsetFrames - 1, Math.round(ms / f.onsetHopMs)));
    let layer: LayerId = 'lead';
    let score = -1;
    for (const l of LAYERS) {
      const v = ((f.envelopes[l][i] ?? 0) / Math.max(1e-9, f.envelopeScale[l])) * p.layerWeights[l];
      if (v > score) {
        score = v;
        layer = l;
      }
    }
    return { layer, score: Math.max(0, score) };
  };
  const budgetMs = (fromMs: number, toMs: number): number => {
    let notes = 0;
    for (let ms = fromMs; ms < toMs - 1e-6;) {
      const c = cellOf(plan, ms);
      const cellEnd = plan.startMs + (c + 1) * beatMs;
      const end = Math.min(toMs, cellEnd > ms ? cellEnd : ms + beatMs);
      notes += ((plan.targets[c] ?? 0) * (end - ms)) / 1000;
      ms = end;
    }
    return notes;
  };
  const activityAt = (ms: number): number => plan.activity[cellOf(plan, ms)] ?? 0;
  const soundAt = (ms: number): boolean => (plan.sound[cellOf(plan, ms)] ?? 0) === 1;

  // --- Per template ------------------------------------------------------------------------------
  for (const t of templates) {
    const n = t.phrases.length;
    const onsets: Record<LayerId, Onset[]> = {
      kick: [],
      snare: [],
      hats: [],
      bass: [],
      lead: [],
      other: [],
    };
    t.phrases.forEach((ph, inst) => {
      for (const c of candidatesIn(ph.startMs, ph.endMs)) {
        for (const l of LAYERS) {
          const s = c.layers[l];
          if (s !== undefined) onsets[l].push({ inst, tMs: c.tMs, strength: s, cand: c });
        }
      }
    });
    const lengthBeats = t.lengthTicks / TICKS_PER_BEAT;
    const keep = (l: LayerId, o: Onset): boolean =>
      o.strength >= layerThr(l) || (l === 'lead' && inRun(o.tMs) && o.strength >= runThr);

    // Primary layer by rhythmic salience.
    let primary: LayerId | null = null;
    let best = 0.02;
    for (const l of LAYERS) {
      const used = onsets[l].filter((o) => keep(l, o));
      if (used.length === 0) continue;
      const d = used.length / n / Math.max(0.25, lengthBeats);
      const density = 1 - Math.exp(-d / 1.2);
      let str = 0;
      for (const o of used) str += o.strength;
      str /= used.length;
      const fit = chooseDivision(used, grid, p);
      let runBonus = 1;
      if (l === 'lead' && used.some((o) => inRun(o.tMs))) runBonus = 1 + 0.6 * p.leadRunPriority;
      const s =
        p.layerWeights[l] *
        PRIORITY[l] *
        runBonus *
        density *
        (0.4 + 0.6 * fit.fit) *
        (0.5 + 0.5 * str);
      if (s > best) {
        best = s;
        primary = l;
      }
    }
    // The grid: the primary's (with lead-run onsets, which join the spine).
    if (primary) {
      const spineOnsets = onsets[primary].filter((o) => keep(primary as LayerId, o));
      if (primary !== 'lead') {
        for (const o of onsets.lead) if (inRun(o.tMs) && keep('lead', o)) spineOnsets.push(o);
      }
      t.division = chooseDivision(spineOnsets, grid, p).division;
    } else {
      t.division = Math.min(2, p.finestDivision);
    }
    const D = t.division;
    const stepMs = beatMs / D;
    const keepTol = lerp(0.5, 0.2, p.quantStrictness) * stepMs + 1;

    /** Pool a layer's onsets on phrase-relative ticks of the template grid. */
    const aggregate = (l: LayerId, filter: (o: Onset) => boolean, div = D): Map<number, Agg> => {
      const out = new Map<number, Agg>();
      // A finer grid of its own (full-resolution lead runs) keeps every onset: half a step.
      const tol = div === D ? keepTol : beatMs / div / 2 + 1;
      for (const o of onsets[l]) {
        if (!filter(o)) continue;
        const ph = t.phrases[o.inst] as Phrase;
        const tick = grid.snap(o.tMs, div);
        if (Math.abs(grid.ms(tick) - o.tMs) > tol) {
          reject(o.cand, 'off grid');
          continue;
        }
        const rel = tick - ph.startTick;
        if (rel < 0 || rel >= t.lengthTicks) continue;
        let g = out.get(rel);
        if (!g) {
          g = { insts: new Set(), sum: 0, max: 0, cands: [] };
          out.set(rel, g);
        }
        if (!g.insts.has(o.inst)) {
          g.insts.add(o.inst);
          g.sum += o.strength;
        }
        g.max = Math.max(g.max, o.strength);
        g.cands.push(o.cand);
      }
      return out;
    };
    const consensus = (g: Agg): boolean => {
      if (n === 1) return true;
      return g.insts.size >= n * 0.5 || g.sum / n >= 0.45;
    };
    const posMap = new Map<number, Pos>();
    const layerAggs = new Map<LayerId, Map<number, Agg>>();
    for (const l of LAYERS)
      layerAggs.set(
        l,
        aggregate(l, () => true),
      );
    const layersAt = (rel: number): Partial<Record<LayerId, number>> => {
      const out: Partial<Record<LayerId, number>> = {};
      for (const l of LAYERS) {
        const g = layerAggs.get(l)?.get(rel);
        if (g && consensus(g)) out[l] = g.sum / g.insts.size;
      }
      return out;
    };
    const pitchOf = (rel: number): number | null => {
      for (const ph of t.phrases) {
        const pitch = pitchAt(grid.ms(ph.startTick + rel));
        if (pitch !== null) return pitch;
      }
      return null;
    };
    const addPos = (rel: number, strength: number, source: HitSource, reason: NoteReason): Pos => {
      const pos: Pos = {
        relTick: rel,
        strength,
        source,
        reason,
        layers: layersAt(rel),
        pitch: pitchOf(rel),
        count: 1,
      };
      posMap.set(rel, pos);
      return pos;
    };

    // Spine: the primary layer's consensus positions, plus lead runs one to one.
    const own: { inst: number; rel: number; g: Agg; layer: LayerId }[] = [];
    const spineFrom = (
      l: LayerId,
      reason: NoteReason,
      filter: (o: Onset) => boolean,
      div = D,
    ): void => {
      const agg = aggregate(l, filter, div);
      for (const [rel, g] of agg) {
        if (posMap.has(rel)) continue;
        if (consensus(g)) addPos(rel, g.sum / g.insts.size, l, reason);
        else for (const inst of g.insts) own.push({ inst, rel, g, layer: l });
      }
    };
    if (primary) {
      const pl = primary;
      for (const o of onsets[pl]) if (!keep(pl, o)) reject(o.cand, 'below threshold');
      spineFrom(pl, 'spine', (o) => keep(pl, o) && !(pl === 'lead' && inRun(o.tMs)));
      const isRun = (o: Onset): boolean => inRun(o.tMs) && keep('lead', o);
      // Full resolution: the runs get their own (finer) grid instead of the phrase's.
      const runDiv = fullRuns ? Math.max(D, p.finestDivision) : D;
      spineFrom('lead', 'lead run', isRun, runDiv);
    }

    // Caps on the template: the smallest bar budget over its instances.
    const barCount = Math.ceil(t.lengthTicks / t.barTicks);
    const barCaps: number[] = [];
    for (let b = 0; b < barCount; b++) {
      let cap = Infinity;
      for (const ph of t.phrases) {
        const s = grid.ms(ph.startTick + b * t.barTicks);
        const e = Math.min(grid.ms(ph.startTick + (b + 1) * t.barTicks), ph.endMs);
        if (e <= s) continue;
        cap = Math.min(cap, budgetMs(s, e));
      }
      barCaps.push(Number.isFinite(cap) ? Math.max(1, Math.round(cap * 1.08)) : 0);
    }
    const set = new TickSet(tickMs);
    const prio = (q: Pos): number =>
      q.strength + metricWeight(q.relTick) + (q.strength >= ACCENT ? 1 : 0);
    // Thin the spine to the caps.
    const spine = [...posMap.values()].sort((x, y) => x.relTick - y.relTick);
    const kept = thin(spine, {
      tickMs,
      minGapMs,
      perBeat,
      barTicks: t.barTicks,
      barCaps,
      prio,
      exempt: (q) => fullRuns && q.reason === 'lead run',
      drop: (q, reason) => {
        posMap.delete(q.relTick);
        for (const l of LAYERS) {
          const g = layerAggs.get(l)?.get(q.relTick);
          if (g) for (const c of g.cands) reject(c, reason);
        }
      },
    });
    for (const q of kept) set.add(q.relTick);

    const fits = (rel: number, capScale = 1): boolean =>
      rel >= 0 &&
      rel < t.lengthTicks &&
      !set.has(rel) &&
      set.gapOk(rel, minGapMs) &&
      set.worstBeatWith(rel) <= perBeat &&
      set.countIn(
        Math.floor(rel / t.barTicks) * t.barTicks,
        (Math.floor(rel / t.barTicks) + 1) * t.barTicks,
      ) +
        1 <=
        Math.floor((barCaps[Math.floor(rel / t.barTicks)] ?? 0) * capScale);
    const why = (rel: number): RejectReason => (!set.gapOk(rel, minGapMs) ? 'min gap' : 'over cap');

    // Secondary layers: notes between spine positions (chords come below).
    const secThr = lerp(0.65, 0.15, p.secondaryAmount);
    const secondary: { rel: number; score: number; strength: number; layer: LayerId; g: Agg }[] =
      [];
    for (const l of LAYERS) {
      if (l === primary) continue;
      for (const [rel, g] of layerAggs.get(l) ?? []) {
        if (posMap.has(rel) || !consensus(g)) continue;
        const strength = g.sum / g.insts.size;
        if (strength < secThr) continue;
        secondary.push({ rel, score: strength * p.layerWeights[l], strength, layer: l, g });
      }
    }
    secondary.sort((x, y) => y.score - x.score || x.rel - y.rel);
    const secScale = lerp(0.55, 1, p.secondaryAmount);
    for (const s of secondary) {
      if (posMap.has(s.rel)) continue;
      if (p.secondaryAmount > 0 && fits(s.rel, secScale)) {
        addPos(s.rel, s.strength, s.layer, 'secondary');
        set.add(s.rel);
      } else {
        for (const c of s.g.cands)
          reject(c, p.secondaryAmount > 0 ? why(s.rel) : 'below threshold');
      }
    }

    // Top-up toward the plan: other candidates, then grid positions where a layer is active.
    const meanActivity = (rel: number): number => {
      let s = 0;
      for (const ph of t.phrases) s += activityAt(grid.ms(ph.startTick + rel));
      return s / n;
    };
    const anySound = (rel: number): boolean =>
      t.phrases.some((ph) => soundAt(grid.ms(ph.startTick + rel)));
    const envScore = (rel: number): { layer: LayerId; score: number } => {
      let bestL: LayerId = 'lead';
      let sum = 0;
      const per = new Map<LayerId, number>();
      for (const ph of t.phrases) {
        const e = envAt(grid.ms(ph.startTick + rel));
        per.set(e.layer, (per.get(e.layer) ?? 0) + e.score);
        sum += e.score;
      }
      let top = -1;
      for (const [l, v] of per) {
        if (v > top) {
          top = v;
          bestL = l;
        }
      }
      return { layer: bestL, score: sum / n };
    };
    for (let b = 0; b < barCount; b++) {
      const b0 = b * t.barTicks;
      const b1 = Math.min(t.lengthTicks, b0 + t.barTicks);
      const want = Math.round((barCaps[b] ?? 0) / 1.08);
      if (set.countIn(b0, b1) >= want) continue;
      // Remaining candidates of any layer, strongest first (weak ones only where it is active).
      const calm = meanActivity(b0 + (b1 - b0) / 2) < 0.3;
      const pool: { rel: number; score: number; strength: number; layer: LayerId }[] = [];
      for (const l of LAYERS) {
        for (const [rel, g] of layerAggs.get(l) ?? []) {
          if (rel < b0 || rel >= b1 || posMap.has(rel)) continue;
          const strength = g.sum / g.insts.size;
          if (strength < (calm ? 0.3 : 0.08)) continue;
          pool.push({
            rel,
            strength,
            layer: l,
            score: strength * p.layerWeights[l] + 0.3 * metricWeight(rel),
          });
        }
      }
      pool.sort((x, y) => y.score - x.score || x.rel - y.rel);
      for (const c of pool) {
        if (set.countIn(b0, b1) >= want) break;
        if (posMap.has(c.rel) || !fits(c.rel)) continue;
        addPos(c.rel, c.strength, c.layer, 'top-up');
        set.add(c.rel);
      }
      // Still short: grid positions (calm bars: no finer than eighths) where a layer is active.
      if (set.countIn(b0, b1) < want && anySound(b0)) {
        const div = calm ? Math.min(D, 2) : D;
        const step = TICKS_PER_BEAT / div;
        const grid0: { rel: number; layer: LayerId; score: number }[] = [];
        for (let rel = b0; rel < b1; rel += step) {
          if (posMap.has(rel)) continue;
          const e = envScore(rel);
          grid0.push({ rel, layer: e.layer, score: e.score + 0.25 * metricWeight(rel) });
        }
        grid0.sort((x, y) => y.score - x.score || x.rel - y.rel);
        for (const g of grid0) {
          if (set.countIn(b0, b1) >= want) break;
          if (!fits(g.rel)) continue;
          const pos = addPos(g.rel, Math.min(1, g.score) * 0.5, 'grid', 'top-up');
          pos.source = 'grid';
          set.add(g.rel);
        }
      }
    }

    // Gap fill in intense parts: no gap longer than maxGapBeats.
    const maxGapTicks = Math.max(1, Math.round(p.maxGapBeats * TICKS_PER_BEAT));
    for (let guard = 0; guard < 4; guard++) {
      let changed = false;
      const ticks = [...set.ticks];
      const bounds = [-1, ...ticks, t.lengthTicks];
      for (let i = 0; i + 1 < bounds.length; i++) {
        const g0 = bounds[i] as number;
        const g1 = bounds[i + 1] as number;
        if (g1 - g0 <= maxGapTicks) continue;
        const from = Math.max(0, g0 + 1);
        // Walk the gap one maximum-gap step at a time.
        for (let target = g0 + maxGapTicks; target < g1; target += maxGapTicks) {
          const mid = Math.max(from, target);
          if (meanActivity(mid) < p.intenseThreshold || !anySound(mid)) continue;
          // The best candidate within half a step, else the grid line.
          let pick = null as { rel: number; strength: number; layer: HitSource } | null;
          for (const l of LAYERS) {
            for (const [rel, g] of layerAggs.get(l) ?? []) {
              if (rel <= g0 || rel >= g1 || Math.abs(rel - target) > maxGapTicks / 2) continue;
              const s = (g.sum / g.insts.size) * p.layerWeights[l];
              if (!pick || s > pick.strength) pick = { rel, strength: s, layer: l };
            }
          }
          const step = TICKS_PER_BEAT / D;
          const rel = pick ? pick.rel : Math.round(target / step) * step;
          if (rel <= g0 || rel >= g1 || posMap.has(rel) || !fits(rel, 1.25)) continue;
          const source = pick ? pick.layer : envScore(rel).layer;
          const pos = addPos(rel, pick ? Math.min(1, pick.strength) : 0.3, source, 'gap fill');
          pos.source = source;
          set.add(rel);
          changed = true;
        }
      }
      if (!changed) break;
    }

    // Chords at strong coincident onsets (same positions in every repeat).
    const positions = [...posMap.values()].sort((x, y) => x.relTick - y.relTick);
    const gapNeed = Math.max((1000 / Math.max(1, p.burstNps)) * 1.5, p.minLaneGapMs * 0.75);
    positions.forEach((q, i) => {
      const ls = LAYERS.filter((l) => l !== 'hats' && (q.layers[l] ?? 0) >= 0.3);
      if (ls.length < 2) return;
      const prev = positions[i - 1];
      const next = positions[i + 1];
      if (prev && (q.relTick - prev.relTick) * tickMs < gapNeed) return;
      if (next && (next.relTick - q.relTick) * tickMs < gapNeed) return;
      let maxS = 0;
      for (const l of ls) maxS = Math.max(maxS, q.layers[l] ?? 0);
      const score = 0.6 * maxS + 0.4 * Math.min(1, (ls.length - 1) / 2);
      if (score < p.chordStrength) return;
      const rate = Math.min(1, p.chordRate * (0.6 + 0.8 * p.secondaryAmount));
      if (hash01(input.seed, t.id, q.relTick, 1) >= rate) return;
      q.count = 2;
      if (
        p.allowTriples &&
        ls.length >= 3 &&
        score >= Math.min(0.98, p.chordStrength + 0.2) &&
        hash01(input.seed, t.id, q.relTick, 2) < p.chordRate
      ) {
        q.count = 3;
      }
    });
    t.positions = positions;

    // Repeats: what an instance has on its own (not in the consensus) is a variation candidate.
    if (n > 1) {
      for (const o of own) for (const c of o.g.cands) reject(c, 'repeat consensus');
    }
  }

  // --- Instances --------------------------------------------------------------------------------
  const hits: Hit[] = [];
  const instanceHits: Hit[][] = [];
  for (const t of templates) {
    t.phrases.forEach((ph, inst) => {
      const list: Hit[] = [];
      for (const q of t.positions) {
        const tick = ph.startTick + q.relTick;
        const tMs = grid.ms(tick);
        if (tick >= ph.endTick || tMs < range.startMs || tMs >= range.endMs || tMs < 0) continue;
        list.push({
          tick,
          tMs,
          strength: q.strength,
          source: q.source,
          reason: q.reason,
          pitch: pitchAt(tMs) ?? q.pitch,
          layers: q.layers,
          group: t.group,
          instance: t.phrases.length > 1 ? inst : 0,
          relTick: q.relTick,
          template: t.id,
          division: t.division,
          count: q.count,
          holdMs: 0,
          holdSource: '',
          layerHoldMs: 0,
        });
      }
      // Variation: this instance's own strong onsets, within its own caps (dropped first).
      const tickSet = new TickSet(tickMs);
      for (const h of list) tickSet.add(h.tick);
      const barCapAt = (b0: number): number =>
        Math.max(1, Math.round(budgetMs(grid.ms(b0), grid.ms(b0 + t.barTicks)) * 1.08));
      const hitAt = (
        tick: number,
        strength: number,
        source: HitSource,
        reason: NoteReason,
        layers: Partial<Record<LayerId, number>>,
      ): Hit => {
        const tMs = grid.ms(tick);
        return {
          tick,
          tMs,
          strength,
          source,
          reason,
          pitch: pitchAt(tMs),
          layers,
          group: t.group,
          instance: t.phrases.length > 1 ? inst : 0,
          relTick: tick - ph.startTick,
          template: t.id,
          division: t.division,
          count: 1,
          holdMs: 0,
          holdSource: '',
          layerHoldMs: 0,
        };
      };
      // Full-resolution lead runs: this instance's own run onsets too (the shared rhythm only
      // keeps those most instances have), within the hard ceiling only.
      if (fullRuns) {
        const runDiv = Math.max(t.division, p.finestDivision);
        for (const c of candidatesIn(ph.startMs, ph.endMs)) {
          if (c.layers.lead === undefined || !inRun(c.tMs)) continue;
          const tick = grid.snap(c.tMs, runDiv);
          const tMs = grid.ms(tick);
          if (tick >= ph.endTick || tMs < range.startMs || tMs >= range.endMs || tMs < 0) continue;
          if (tickSet.has(tick) || !tickSet.gapOk(tick, minGapMs)) continue;
          tickSet.add(tick);
          list.push(hitAt(tick, c.layers.lead, 'lead', 'lead run', c.layers));
          rejected.delete(c);
        }
      }
      if (p.variation > 0) {
        const vThr = lerp(0.9, 0.3, p.variation);
        const extras = candidatesIn(ph.startMs, ph.endMs)
          .filter((c) => c.strength >= vThr)
          .sort((x, y) => y.strength - x.strength || x.tMs - y.tMs);
        const limit = Math.floor(p.variation * 0.3 * list.length + p.variation * 2);
        let added = 0;
        for (const c of extras) {
          const tick = grid.snap(c.tMs, t.division);
          if (tickSet.has(tick)) continue;
          if (added >= limit) {
            reject(c, 'over cap');
            continue;
          }
          const bar = Math.floor((tick - ph.startTick) / t.barTicks);
          const b0 = ph.startTick + bar * t.barTicks;
          const cap = Math.max(
            1,
            Math.round(budgetMs(grid.ms(b0), grid.ms(b0 + t.barTicks)) * 1.08),
          );
          if (
            !tickSet.gapOk(tick, minGapMs) ||
            tickSet.worstBeatWith(tick) > perBeat ||
            tickSet.countIn(b0, b0 + t.barTicks) + 1 > cap
          ) {
            reject(c, !tickSet.gapOk(tick, minGapMs) ? 'min gap' : 'over cap');
            continue;
          }
          const tMs = grid.ms(tick);
          if (tMs < range.startMs || tMs >= range.endMs || tick >= ph.endTick) continue;
          tickSet.add(tick);
          added++;
          list.push({
            tick,
            tMs,
            strength: c.strength,
            source: c.layer,
            reason: 'variation',
            pitch: pitchAt(tMs),
            layers: c.layers,
            group: t.group,
            instance: t.phrases.length > 1 ? inst : 0,
            relTick: tick - ph.startTick,
            template: t.id,
            division: t.division,
            count: 1,
            holdMs: 0,
            holdSource: '',
            layerHoldMs: 0,
          });
        }
      }
      // This instance's own density plan: an intense repeat may need more than the shared rhythm
      // (sized for the calmest repeat). Own candidates first, then active grid positions.
      if (t.phrases.length > 1) {
        for (let b0 = ph.startTick; b0 < ph.endTick; b0 += t.barTicks) {
          const b1 = Math.min(ph.endTick, b0 + t.barTicks);
          const want = Math.round(barCapAt(b0) / 1.08);
          if (tickSet.countIn(b0, b1) >= want) continue;
          const calm = activityAt(grid.ms(b0 + (b1 - b0) / 2)) < 0.3;
          const fitsHere = (tick: number): boolean => {
            const ms = grid.ms(tick);
            return (
              !tickSet.has(tick) &&
              ms >= range.startMs &&
              ms < range.endMs &&
              tickSet.gapOk(tick, minGapMs) &&
              tickSet.worstBeatWith(tick) <= perBeat
            );
          };
          const own = candidatesIn(grid.ms(b0), grid.ms(b1))
            .filter((c) => c.strength >= (calm ? 0.3 : 0.08))
            .map((c) => ({ c, tick: grid.snap(c.tMs, t.division) }))
            .sort(
              (x, y) =>
                y.c.strength +
                  0.3 * metricWeight(y.tick) -
                  (x.c.strength + 0.3 * metricWeight(x.tick)) || x.tick - y.tick,
            );
          for (const o of own) {
            if (tickSet.countIn(b0, b1) >= want) break;
            if (o.tick < b0 || o.tick >= b1 || !fitsHere(o.tick)) continue;
            tickSet.add(o.tick);
            list.push(hitAt(o.tick, o.c.strength, o.c.layer, 'top-up', o.c.layers));
          }
          if (tickSet.countIn(b0, b1) >= want || !soundAt(grid.ms(b0))) continue;
          const step = TICKS_PER_BEAT / (calm ? Math.min(t.division, 2) : t.division);
          const spots: { tick: number; layer: LayerId; score: number }[] = [];
          for (let tick = b0; tick < b1; tick += step) {
            const e = envAt(grid.ms(tick));
            spots.push({ tick, layer: e.layer, score: e.score + 0.25 * metricWeight(tick) });
          }
          spots.sort((x, y) => y.score - x.score || x.tick - y.tick);
          for (const sp of spots) {
            if (tickSet.countIn(b0, b1) >= want) break;
            if (!fitsHere(sp.tick)) continue;
            tickSet.add(sp.tick);
            list.push(hitAt(sp.tick, Math.min(1, sp.score) * 0.5, sp.layer, 'top-up', {}));
          }
        }
      }
      instanceHits.push(list);
    });
  }
  for (const list of instanceHits) hits.push(...list);
  hits.sort((x, y) => x.tick - y.tick || RANK_OF[y.reason] - RANK_OF[x.reason]);

  // --- Global pass: phrase edges, existing notes, burst windows -----------------------------
  const final: Hit[] = [];
  const occ = input.occupied;
  for (const h of hits) {
    const k = firstAtOrAfter(occ, h.tMs - minGapMs + 1e-6, (x) => x);
    const near = occ[k];
    if (near !== undefined && near < h.tMs + minGapMs) {
      for (const c of candidatesIn(h.tMs - 15, h.tMs + 15)) reject(c, 'existing note');
      continue;
    }
    const last = final[final.length - 1];
    if (last && (last.tick === h.tick || h.tMs - last.tMs < minGapMs)) {
      if (
        RANK_OF[h.reason] > RANK_OF[last.reason] ||
        (RANK_OF[h.reason] === RANK_OF[last.reason] && h.strength > last.strength + 0.2)
      ) {
        final[final.length - 1] = h;
      }
      continue;
    }
    final.push(h);
  }
  const windowed = thinWindows(
    final,
    grid.beatMs,
    perBeat,
    (h) => fullRuns && h.reason === 'lead run',
  );

  // --- Floor: at least one note per floor interval wherever there is sound -------------------
  const floorMs = Math.max(0.25, p.floorBeats) * beatMs;
  const firstBeat = Math.ceil((range.startMs - grid.offsetMs) / beatMs);
  const times = windowed.map((h) => h.tMs);
  const added: Hit[] = [];
  const floorDiv = Math.min(4, p.finestDivision);
  for (let w0 = grid.offsetMs + firstBeat * beatMs; w0 < range.endMs; w0 += floorMs) {
    const w1 = Math.min(range.endMs, w0 + floorMs);
    const i = firstAtOrAfter(times, w0, (x) => x);
    if ((times[i] ?? Infinity) < w1) continue;
    let sound = false;
    for (let ms = w0; ms < w1; ms += beatMs / 2) if (soundAt(ms)) sound = true;
    if (!sound && !p.fillSilence) continue;
    if (w0 < 0) continue;
    // Lead, else drums, else bass, else anything; else the beat.
    const inWin = candidatesIn(w0, w1);
    let pick = null as { c: Candidate; layer: LayerId } | null;
    for (const group of [['lead'], DRUMS, ['bass'], ['other']] as readonly (readonly LayerId[])[]) {
      let bestS = 0;
      for (const c of inWin) {
        for (const l of group) {
          const s = c.layers[l];
          if (s !== undefined && s > bestS) {
            bestS = s;
            pick = { c, layer: l };
          }
        }
      }
      if (pick) break;
    }
    const tick = pick ? grid.snap(pick.c.tMs, floorDiv) : grid.snap(w0, 1);
    const tMs = grid.ms(tick);
    if (tMs < range.startMs || tMs >= range.endMs || tMs < 0) continue;
    const j = firstAtOrAfter(times, tMs - minGapMs + 1e-6, (x) => x);
    if ((times[j] ?? Infinity) < tMs + minGapMs) continue;
    const k = firstAtOrAfter(occ, tMs - minGapMs + 1e-6, (x) => x);
    if ((occ[k] ?? Infinity) < tMs + minGapMs) continue;
    times.splice(j, 0, tMs);
    added.push({
      tick,
      tMs,
      strength: pick ? (pick.c.layers[pick.layer] ?? 0.3) : 0.3,
      source: pick ? pick.layer : 'grid',
      reason: sound ? 'floor' : 'silence fill',
      pitch: pitchAt(tMs),
      layers: pick ? pick.c.layers : {},
      group: -1,
      instance: 0,
      relTick: 0,
      template: -1,
      division: floorDiv,
      count: 1,
      holdMs: 0,
      holdSource: '',
      layerHoldMs: 0,
    });
  }
  const out = windowed.concat(added).sort((x, y) => x.tick - y.tick);
  return { hits: out, rejected };
}

/**
 * The grid for a set of onsets: the division (up to the finest allowed) with the lowest mean
 * timing error (capped at 40 ms, weighted by strength) plus a complexity cost per division, so
 * a finer grid wins only when it explains the onsets clearly better. Triplet grids pay extra
 * (less as "Triplets" rises) and are off at 0. `fit` is the weighted share of onsets within
 * 25 ms (and a quarter step) of the chosen grid: the rhythm's regularity.
 */
export function chooseDivision(
  onsets: readonly { tMs: number; strength: number }[],
  grid: TickGrid,
  p: GeneratorParams,
): { division: number; fit: number } {
  // Grids finer than the hard ceiling allows are never chosen (their notes could not all exist).
  const minStepMs = (1000 / Math.max(1, p.ceilingNps)) * 0.9;
  const allowed = DIVISIONS.filter(
    (d) =>
      (d <= 2 || grid.beatMs / d >= minStepMs) &&
      (d % 3 === 0
        ? p.oddGrids > 0 && (ODD_RIVAL[d] ?? 99) <= p.finestDivision
        : d <= p.finestDivision),
  );
  if (onsets.length === 0) return { division: Math.min(2, p.finestDivision), fit: 0 };
  let bestD = Math.min(2, p.finestDivision);
  let bestCost = Infinity;
  for (const d of allowed) {
    let err = 0;
    let all = 0;
    for (const o of onsets) {
      const w = 0.25 + o.strength;
      all += w;
      err += w * Math.min(40, Math.abs(grid.ms(grid.snap(o.tMs, d)) - o.tMs));
    }
    const odd = d % 3 === 0 ? 2 + 8 * (1 - p.oddGrids) : 0;
    const cost = err / all + 2 * d + odd;
    if (cost < bestCost) {
      bestCost = cost;
      bestD = d;
    }
  }
  const tol = Math.min(25, grid.beatMs / bestD / 4);
  let hit = 0;
  let all = 0;
  for (const o of onsets) {
    const w = 0.25 + o.strength;
    all += w;
    if (Math.abs(grid.ms(grid.snap(o.tMs, bestD)) - o.tMs) <= tol) hit += w;
  }
  return { division: bestD, fit: all > 0 ? hit / all : 0 };
}

/** Sorted, distinct ticks with neighbourhood queries. */
class TickSet {
  readonly ticks: number[] = [];
  constructor(private readonly tickMs: number) {}
  add(t: number): void {
    const i = firstAtOrAfter(this.ticks, t, (x) => x);
    if (this.ticks[i] !== t) this.ticks.splice(i, 0, t);
  }
  has(t: number): boolean {
    return this.ticks[firstAtOrAfter(this.ticks, t, (x) => x)] === t;
  }
  countIn(from: number, to: number): number {
    return firstAtOrAfter(this.ticks, to, (x) => x) - firstAtOrAfter(this.ticks, from, (x) => x);
  }
  /** No other tick closer than `gapMs`. */
  gapOk(t: number, gapMs: number): boolean {
    const i = firstAtOrAfter(this.ticks, t, (x) => x);
    const next = this.ticks[i] === t ? this.ticks[i + 1] : this.ticks[i];
    const prev = this.ticks[i - 1];
    if (next !== undefined && (next - t) * this.tickMs < gapMs) return false;
    if (prev !== undefined && (t - prev) * this.tickMs < gapMs) return false;
    return true;
  }
  /** Most ticks in any one-beat window containing `t`, if `t` were added. */
  worstBeatWith(t: number): number {
    const extra = this.has(t) ? 0 : 1;
    let worst = this.countIn(t, t + TICKS_PER_BEAT) + extra;
    for (
      let i = firstAtOrAfter(this.ticks, t - TICKS_PER_BEAT + 1, (x) => x);
      i < this.ticks.length && (this.ticks[i] as number) <= t;
      i++
    ) {
      const u = this.ticks[i] as number;
      worst = Math.max(worst, this.countIn(u, u + TICKS_PER_BEAT) + extra);
    }
    return worst;
  }
}

interface ThinOptions<T> {
  tickMs: number;
  minGapMs: number;
  perBeat: number;
  barTicks: number;
  barCaps: readonly number[];
  prio: (x: T) => number;
  /** Items that never count toward (or get dropped by) the burst and bar caps. */
  exempt: (x: T) => boolean;
  drop: (x: T, reason: RejectReason) => void;
}

/**
 * Musical thinning: minimum gap first (the weaker of a pair goes), then every one-beat window
 * over the burst cap and every bar over its budget lose notes from the finest metric level
 * first, evenly spaced across the window, accents last.
 */
function thin<T extends { relTick: number; strength: number }>(items: T[], o: ThinOptions<T>): T[] {
  let list: T[] = [];
  for (const it of items) {
    const last = list[list.length - 1];
    if (last && (it.relTick - last.relTick) * o.tickMs < o.minGapMs) {
      if (o.prio(it) > o.prio(last)) {
        o.drop(last, 'min gap');
        list[list.length - 1] = it;
      } else {
        o.drop(it, 'min gap');
      }
      continue;
    }
    list.push(it);
  }
  const removeEvenly = (window: T[], r: number): Set<T> => {
    const gone = new Set<T>();
    // Finest metric level first; accents only when nothing else is left.
    const levels = [...new Set(window.map((x) => metricWeight(x.relTick)))].sort((a, b) => a - b);
    for (const pass of [false, true]) {
      for (const level of levels) {
        if (gone.size >= r) return gone;
        const group = window.filter(
          (x) => !gone.has(x) && metricWeight(x.relTick) === level && (pass || x.strength < ACCENT),
        );
        const need = Math.min(group.length, r - gone.size);
        for (let j = 0; j < need; j++) {
          gone.add(group[Math.floor(((j + 0.5) * group.length) / need)] as T);
        }
      }
    }
    return gone;
  };
  // Burst: one-beat windows.
  for (let i = 0; i < list.length;) {
    const start = (list[i] as T).relTick;
    let j = i;
    while (j < list.length && (list[j] as T).relTick < start + TICKS_PER_BEAT) j++;
    const counted = list.slice(i, j).filter((x) => !o.exempt(x));
    if (counted.length <= o.perBeat) {
      i++;
      continue;
    }
    const gone = removeEvenly(counted, counted.length - o.perBeat);
    for (const g of gone) o.drop(g, 'thinning');
    list = list.filter((x) => !gone.has(x));
  }
  // Bars over budget.
  const bars = new Map<number, T[]>();
  for (const x of list) {
    if (o.exempt(x)) continue;
    const b = Math.floor(x.relTick / o.barTicks);
    const arr = bars.get(b) ?? [];
    arr.push(x);
    bars.set(b, arr);
  }
  const gone = new Set<T>();
  for (const [b, arr] of bars) {
    const cap = o.barCaps[b] ?? 0;
    if (arr.length <= cap) continue;
    for (const g of removeEvenly(arr, arr.length - cap)) {
      gone.add(g);
      o.drop(g, 'thinning');
    }
  }
  return list.filter((x) => !gone.has(x));
}

/** Global burst check across phrase edges: one-beat windows, lowest rank first. */
function thinWindows(
  hits: readonly Hit[],
  beatMs: number,
  perBeat: number,
  exempt: (h: Hit) => boolean,
): Hit[] {
  const list = [...hits];
  for (let i = 0; i < list.length;) {
    const start = (list[i] as Hit).tMs;
    let j = i;
    while (j < list.length && (list[j] as Hit).tMs < start + beatMs - 0.5) j++;
    let counted = 0;
    for (let k = i; k < j; k++) if (!exempt(list[k] as Hit)) counted++;
    if (counted <= perBeat) {
      i++;
      continue;
    }
    let low = 4;
    for (let k = i; k < j; k++) {
      const h = list[k] as Hit;
      if (!exempt(h)) low = Math.min(low, RANK_OF[h.reason]);
    }
    let victim = -1;
    let victimScore = Infinity;
    for (let k = i; k < j; k++) {
      const h = list[k] as Hit;
      if (exempt(h) || RANK_OF[h.reason] !== low) continue;
      const score = metricWeight(h.tick) + h.strength;
      if (score < victimScore) {
        victimScore = score;
        victim = k;
      }
    }
    list.splice(victim, 1);
  }
  return list;
}
