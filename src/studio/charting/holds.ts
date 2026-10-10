import type { BandId, ChartAnalysis, LayerId, LayerOnset, LeadNote } from './analysis/types';
import { TICKS_PER_BEAT, firstAtOrAfter, hash01, type Hit, type TickGrid } from './hits';
import type { GeneratorParams } from './presets';

/**
 * Step D, holds. Sources, best first: the lead note starting at the hit (its analysed duration),
 * a sustained bass or pad/vocal note (its band energy staying up until the layer's next onset),
 * and legato (a long gap to the next hit while the sound carries on). Short holds (down to the
 * minimum length) and long ones both occur; a long sustain that is not taken whole may still
 * become a short hold. A sustained bass under a lead tap may become a second, held note
 * ("layering"). Decisions per repeated position are seeded by position, so repeats match.
 * Lanes, simultaneous holds and hand use are the lane optimiser's job (lanes.ts).
 */

/** Absolute minimum hold, ms (the chart format allows 50; shorter than this reads as a tap). */
export const MIN_HOLD_FLOOR_MS = 120;

interface Sustain {
  durMs: number;
  /** 0-1. */
  confidence: number;
  source: string;
}

export function assignHolds(
  hits: Hit[],
  a: ChartAnalysis,
  grid: TickGrid,
  p: GeneratorParams,
  seed: number,
  rangeEndMs: number,
): void {
  if (p.holdAmount <= 0 || hits.length === 0) return;
  const beatMs = grid.beatMs;
  const f = a.features;
  const minLen = Math.max(MIN_HOLD_FLOOR_MS, p.minHoldBeats * beatMs);
  const maxLen = Math.max(minLen, p.maxHoldBeats * beatMs);
  const leadNotes = a.leadNotes;

  const leadAt = (ms: number): LeadNote | null => {
    let best: LeadNote | null = null;
    for (let i = firstAtOrAfter(leadNotes, ms - 45, (n) => n.tMs); i < leadNotes.length; i++) {
      const n = leadNotes[i] as LeadNote;
      if (n.tMs > ms + 45) break;
      if (!best || Math.abs(n.tMs - ms) < Math.abs(best.tMs - ms)) best = n;
    }
    return best;
  };
  const nextOnset = (layer: LayerId, afterMs: number): number => {
    const list = a.layerOnsets[layer];
    const o = list[firstAtOrAfter(list, afterMs, (x: LayerOnset) => x.tMs)];
    return o ? o.tMs : Infinity;
  };
  /** How long a band's energy stays up after `ms`, until `untilMs` at most. */
  const bandSustain = (band: BandId, ms: number, untilMs: number): Sustain | null => {
    const curve = f.bands[band];
    const k0 = Math.max(0, Math.round(ms / f.frameMs));
    let v0 = 0;
    for (let k = k0; k < Math.min(curve.length, k0 + 4); k++) v0 = Math.max(v0, curve[k] ?? 0);
    if (v0 < 0.35) return null;
    let k = k0 + 1;
    const kEnd = Math.min(curve.length, Math.floor(untilMs / f.frameMs));
    while (k < kEnd && (curve[k] ?? 0) >= 0.7 * v0) k++;
    return { durMs: k * f.frameMs - ms, confidence: v0, source: '' };
  };
  const loudAt = (ms: number): number =>
    f.loudness[Math.max(0, Math.min(f.frameCount - 1, Math.round(ms / f.frameMs)))] ?? 0;

  const sustainsOf = (h: Hit, nextHitMs: number): Sustain[] => {
    const out: Sustain[] = [];
    const lead = leadAt(h.tMs);
    if (lead) {
      out.push({
        durMs: lead.durMs - (h.tMs - lead.tMs),
        confidence: lead.confidence * (0.6 + 0.4 * lead.strength),
        source: 'lead note',
      });
    }
    if ((h.layers.bass ?? 0) >= 0.3 || h.source === 'bass') {
      const s = bandSustain('low', h.tMs, nextOnset('bass', h.tMs + 60));
      if (s) out.push({ ...s, source: 'bass' });
    }
    if ((h.layers.other ?? 0) >= 0.3 || h.source === 'other') {
      const s = bandSustain('lowMid', h.tMs, nextOnset('other', h.tMs + 60));
      if (s) out.push({ ...s, confidence: s.confidence * 0.9, source: 'pad / vocal' });
    }
    const gap = nextHitMs - h.tMs;
    if (gap >= beatMs) {
      const l0 = loudAt(h.tMs + 40);
      const l1 = loudAt(h.tMs + gap * 0.6);
      if (l0 > 0.15 && l1 >= 0.7 * l0) {
        out.push({ durMs: gap - beatMs / 4, confidence: 0.45, source: 'legato' });
      }
    }
    return out;
  };
  const align = (h: Hit, durMs: number): number => {
    let d = durMs;
    if (p.alignReleases) {
      const div = Math.min(h.division, 4);
      const end = grid.ms(grid.snap(h.tMs + d, div));
      d = end - h.tMs;
      if (d < minLen) d = grid.ms(grid.snap(h.tMs + minLen, div) + TICKS_PER_BEAT / div) - h.tMs;
    }
    return Math.round(d);
  };
  const keyOf = (h: Hit): [number, number] =>
    h.template >= 0 ? [h.template, h.relTick] : [-7, h.tick];

  /** Best candidate per hit, kept for the per-phrase guarantee. */
  const bestOf = new Map<Hit, { durMs: number; source: string; score: number }>();
  hits.forEach((h, i) => {
    const nextMs = hits[i + 1]?.tMs ?? rangeEndMs;
    const options = sustainsOf(h, nextMs)
      .map((s) => ({ ...s, durMs: Math.min(maxLen, s.durMs, rangeEndMs - h.tMs - 1) }))
      .filter((s) => s.durMs >= minLen)
      .sort((x, y) => y.durMs * y.confidence - x.durMs * x.confidence);
    const s = options[0];
    if (!s) return;
    const [k1, k2] = keyOf(h);
    const short = s.durMs < beatMs;
    const pref = short ? p.shortHoldShare : 1 - p.shortHoldShare;
    const take = Math.min(1, p.holdAmount * (0.55 + 0.9 * s.confidence) * (0.4 + 1.2 * pref));
    bestOf.set(h, { durMs: s.durMs, source: s.source, score: take });
    if (hash01(seed, k1, k2, 3) < take) {
      h.holdMs = align(h, s.durMs);
      h.holdSource = s.source;
    } else if (!short) {
      // A long sustain not taken whole may still give a short hold.
      const pShort = p.holdAmount * p.shortHoldShare * (0.5 + s.confidence);
      if (hash01(seed, k1, k2, 4) < pShort) {
        h.holdMs = align(h, Math.max(minLen, Math.min(s.durMs, beatMs / 2)));
        h.holdSource = `${s.source} (short)`;
      }
    }
    // Layering: a sustained bass held under a lead-driven tap.
    if (
      h.holdMs === 0 &&
      (h.count === 1 || (h.count === 2 && p.allowTriples)) &&
      p.secondaryAmount > 0 &&
      h.source !== 'bass'
    ) {
      const bass =
        (h.layers.bass ?? 0) >= 0.3
          ? bandSustain('low', h.tMs, nextOnset('bass', h.tMs + 60))
          : null;
      if (bass && bass.durMs >= beatMs) {
        const pLayer = p.holdAmount * p.secondaryAmount * 0.8 * bass.confidence;
        if (hash01(seed, k1, k2, 5) < pLayer) {
          h.layerHoldMs = align(h, Math.min(maxLen, bass.durMs, rangeEndMs - h.tMs - 1));
        }
      }
    }
  });

  // Every phrase (template instance, or bar for loose hits) with sustained content gets a hold.
  if (p.holdAmount < 0.15) return;
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const key =
      h.template >= 0
        ? `${h.template}:${h.instance}`
        : `b${Math.floor(h.tick / (TICKS_PER_BEAT * 4))}`;
    const arr = groups.get(key) ?? [];
    arr.push(h);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) {
    if (arr.some((h) => h.holdMs > 0 || h.layerHoldMs > 0)) continue;
    let pick: Hit | null = null;
    let score = 0;
    for (const h of arr) {
      const b = bestOf.get(h);
      if (b && b.score > score) {
        score = b.score;
        pick = h;
      }
    }
    const b = pick ? bestOf.get(pick) : undefined;
    if (pick && b) {
      pick.holdMs = align(pick, b.durMs);
      pick.holdSource = b.source;
    }
  }
  for (const h of hits) {
    if (h.holdMs > 0 && h.holdMs < minLen) h.holdMs = 0;
    if (h.layerHoldMs > 0 && h.layerHoldMs < minLen) h.layerHoldMs = 0;
    if (h.holdMs > 0)
      h.holdMs = Math.min(h.holdMs, Math.max(0, Math.floor(rangeEndMs - h.tMs - 1)));
    if (h.layerHoldMs > 0) {
      h.layerHoldMs = Math.min(h.layerHoldMs, Math.max(0, Math.floor(rangeEndMs - h.tMs - 1)));
    }
    if (h.holdMs > 0 && h.holdMs < minLen) h.holdMs = 0;
    if (h.layerHoldMs > 0 && h.layerHoldMs < minLen) h.layerHoldMs = 0;
  }
}
