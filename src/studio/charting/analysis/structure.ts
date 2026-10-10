import { clamp01, quantileOf } from './dsp';
import {
  LAYERS,
  type Bar,
  type Candidate,
  type ChartFeatures,
  type LeadNote,
  type Section,
  type SectionRole,
  type Structure,
} from './types';

/**
 * Song structure on the chart's bar grid (4 beats from `offsetMs` at `bpm`):
 *
 * 1. Per bar: a rhythm fingerprint (each layer's onset envelope, its maximum in each 1/16 slot)
 *    and a coarse timbre vector (band energies, brightness, loudness, chroma), both centred on
 *    the song's mean and normalised.
 * 2. A bar self-similarity matrix (0-1) from both.
 * 3. Repeated phrases: for phrase lengths of 2, 4 and 8 bars and every phase, phrases are
 *    greedily clustered by their mean diagonal similarity (tolerating small differences); the
 *    length and phase whose groups cover the most bars win. Every bar gets a group and the
 *    occurrence (repeat index) of its phrase.
 * 4. Sections from novelty (a checkerboard kernel on the matrix, plus changes in activity and in
 *    repeat group), at least 4 bars, snapped to phrase starts, labelled by rules on activity,
 *    density, brightness, pitch, low punch, rise, repeats and position (not loudness alone).
 */

const MAX_BARS = 2000;
const PHRASE_LENGTHS = [2, 4, 8] as const;
const KERNEL_BARS = 4;
const MIN_SECTION_BARS = 4;
const SILENT_RMS = 2e-4;

function normalize(v: Float64Array): void {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] as number) ** 2;
  const n = Math.sqrt(s);
  if (n > 1e-12) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / n;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** Subtract the mean vector of the given rows, then normalise each row. */
function centre(rows: Float64Array[], use: boolean[]): void {
  const dim = rows[0]?.length ?? 0;
  const mean = new Float64Array(dim);
  let count = 0;
  rows.forEach((r, i) => {
    if (!use[i]) return;
    count++;
    for (let d = 0; d < dim; d++) mean[d] = (mean[d] as number) + (r[d] as number);
  });
  if (count === 0) return;
  for (let d = 0; d < dim; d++) mean[d] = (mean[d] as number) / count;
  for (const r of rows) {
    for (let d = 0; d < dim; d++) r[d] = (r[d] as number) - (mean[d] as number);
    normalize(r);
  }
}

interface SectionInputs {
  activity: Float32Array;
  lowPunch: Float32Array;
  candidates: readonly Candidate[];
  leadNotes: readonly LeadNote[];
  buildUps: readonly { startMs: number; endMs: number }[];
}

export function analyzeStructure(
  f: ChartFeatures,
  bpm: number,
  offsetMs: number,
  inputs: SectionInputs,
): Structure {
  const usable = bpm > 0 && Number.isFinite(bpm);
  const beatMs = usable ? 60000 / bpm : 500;
  let barMs = beatMs * 4;
  // Very fast tempos would give thousands of bars: group them.
  while (f.durationMs / barMs > MAX_BARS) barMs *= 2;
  const origin = usable ? offsetMs : 0;
  const kStart = Math.floor((0 - origin) / barMs);
  const bars: Bar[] = [];
  for (let k = kStart; origin + k * barMs < f.durationMs && bars.length < MAX_BARS; k++) {
    const startMs = origin + k * barMs;
    bars.push({
      index: bars.length,
      measure: Math.round((k * barMs) / (beatMs * 4)) + 1,
      startMs,
      endMs: startMs + barMs,
      group: -1,
      repeatIndex: 0,
      barInPhrase: 0,
    });
  }
  const nb = bars.length;

  // --- Bar features --------------------------------------------------------------------------
  const SLOTS = 16;
  const rhythm = bars.map(() => new Float64Array(LAYERS.length * SLOTS));
  const timbre = bars.map(() => new Float64Array(5 + 2 + 12));
  const silent = bars.map(() => true);
  const hop = f.onsetHopMs;
  LAYERS.forEach((layer, li) => {
    const env = f.envelopes[layer];
    const scale = f.envelopeScale[layer];
    bars.forEach((bar, bi) => {
      const v = rhythm[bi] as Float64Array;
      for (let s = 0; s < SLOTS; s++) {
        const a = Math.max(0, Math.floor((bar.startMs + (s * barMs) / SLOTS) / hop));
        const b = Math.min(env.length, Math.floor((bar.startMs + ((s + 1) * barMs) / SLOTS) / hop));
        let m = 0;
        for (let i = a; i < b; i++) m = Math.max(m, env[i] as number);
        v[li * SLOTS + s] = Math.min(1, m / scale);
      }
    });
  });
  const fm = f.frameMs;
  const bandList = [f.bands.sub, f.bands.low, f.bands.lowMid, f.bands.highMid, f.bands.high];
  bars.forEach((bar, bi) => {
    const a = Math.max(0, Math.floor(bar.startMs / fm));
    const b = Math.min(f.frameCount, Math.floor(bar.endMs / fm));
    const v = timbre[bi] as Float64Array;
    let count = 0;
    let rmsSum = 0;
    for (let k = a; k < b; k++) {
      count++;
      rmsSum += f.rms[k] as number;
      bandList.forEach((band, i) => (v[i] = (v[i] as number) + (band[k] as number)));
      v[5] = (v[5] as number) + (f.brightness[k] as number);
      v[6] = (v[6] as number) + (f.loudness[k] as number);
      for (let c = 0; c < 12; c++)
        v[7 + c] = (v[7 + c] as number) + (f.chroma[k * 12 + c] as number);
    }
    if (count > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / count;
    silent[bi] = count === 0 || rmsSum / count < SILENT_RMS;
  });
  const use = silent.map((s) => !s);
  centre(rhythm, use);
  centre(timbre, use);

  const similarity = new Float32Array(nb * nb);
  for (let i = 0; i < nb; i++) {
    for (let j = i; j < nb; j++) {
      let s: number;
      if (silent[i] || silent[j]) s = silent[i] && silent[j] ? 1 : 0;
      else {
        const c =
          0.6 * dot(rhythm[i] as Float64Array, rhythm[j] as Float64Array) +
          0.4 * dot(timbre[i] as Float64Array, timbre[j] as Float64Array);
        s = clamp01((c + 1) / 2);
      }
      similarity[i * nb + j] = s;
      similarity[j * nb + i] = s;
    }
  }
  const S = (i: number, j: number): number => similarity[i * nb + j] as number;

  // --- Repeated phrases ----------------------------------------------------------------------
  const offDiag: number[] = [];
  for (let i = 0; i < nb; i++) {
    for (let j = i + 1; j < nb; j += Math.max(1, Math.floor(nb / 200))) {
      if (!silent[i] && !silent[j]) offDiag.push(S(i, j));
    }
  }
  const tau = Math.min(0.92, Math.max(0.62, quantileOf(offDiag, 0.75)));

  interface Plan {
    length: number;
    phase: number;
    /** Phrase starts, their group (-1 = silent) and occurrence index. */
    starts: number[];
    groups: number[];
    score: number;
  }
  const phraseSim = (a: number, b: number, len: number): number => {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < len && a + k < nb && b + k < nb; k++) {
      sum += S(a + k, b + k);
      n++;
    }
    return n > 0 ? sum / n : 0;
  };
  let bestPlan: Plan | null = null;
  for (const len of PHRASE_LENGTHS) {
    if (len > nb) continue;
    for (let phase = 0; phase < len; phase++) {
      const starts: number[] = [];
      for (let s = phase; s < nb; s += len) starts.push(s);
      const groups: number[] = [];
      const members: number[][] = [];
      for (const s of starts) {
        let allSilent = true;
        for (let k = 0; k < len && s + k < nb; k++) if (!silent[s + k]) allSilent = false;
        if (allSilent) {
          groups.push(-1);
          continue;
        }
        let best = -1;
        let bestSim = tau;
        members.forEach((m, gi) => {
          let sum = 0;
          const look = m.slice(0, 4);
          for (const other of look) sum += phraseSim(s, other, len);
          const sim = sum / look.length;
          if (sim >= bestSim) {
            bestSim = sim;
            best = gi;
          }
        });
        if (best < 0) {
          best = members.length;
          members.push([]);
        }
        (members[best] as number[]).push(s);
        groups.push(best);
      }
      let covered = 0;
      starts.forEach((s, i) => {
        const g = groups[i] as number;
        if (g >= 0 && (members[g] as number[]).length >= 2) covered += Math.min(len, nb - s);
      });
      const score = covered / nb + 0.05 * Math.log2(len);
      if (!bestPlan || score > bestPlan.score)
        bestPlan = { length: len, phase, starts, groups, score };
    }
  }
  const groupSizes: number[] = [];
  let phraseBars = 1;
  const plan = bestPlan as Plan | null;
  if (plan) {
    phraseBars = plan.length;
    // Renumber groups by first appearance and count occurrences.
    const remap = new Map<number, number>();
    const seen: number[] = [];
    plan.starts.forEach((s, i) => {
      const g = plan.groups[i] as number;
      if (g < 0) return;
      let id = remap.get(g);
      if (id === undefined) {
        id = remap.size;
        remap.set(g, id);
        seen.push(0);
        groupSizes.push(0);
      }
      const occurrence = seen[id] as number;
      seen[id] = occurrence + 1;
      groupSizes[id] = occurrence + 1;
      for (let k = 0; k < plan.length && s + k < nb; k++) {
        const bar = bars[s + k] as Bar;
        bar.group = id;
        bar.repeatIndex = occurrence;
        bar.barInPhrase = k;
      }
    });
  }

  // --- Novelty and sections ------------------------------------------------------------------
  const barMean = (curve: Float32Array, bar: Bar): number => {
    const a = Math.max(0, Math.floor(bar.startMs / fm));
    const b = Math.min(curve.length, Math.floor(bar.endMs / fm));
    let s = 0;
    for (let k = a; k < b; k++) s += curve[k] as number;
    return b > a ? s / (b - a) : 0;
  };
  const barAct = bars.map((b) => barMean(inputs.activity, b));
  const foote = new Float32Array(nb);
  const actDiff = new Float32Array(nb);
  for (let i = 1; i < nb; i++) {
    let sum = 0;
    let n = 0;
    for (let a = 0; a < KERNEL_BARS; a++) {
      for (let b = 0; b < KERNEL_BARS; b++) {
        const p = i - 1 - a;
        const q = i + b;
        const p2 = i - 1 - b;
        const q2 = i + a;
        if (p < 0 || q >= nb || p2 < 0 || q2 >= nb) continue;
        sum += S(p, p2) + S(q2, q) - S(p, q) - S(q2, p2);
        n++;
      }
    }
    foote[i] = n > 0 ? Math.max(0, sum / (2 * n)) : 0;
    let before = 0;
    let after = 0;
    let nbf = 0;
    let naf = 0;
    for (let k = 1; k <= KERNEL_BARS; k++) {
      if (i - k >= 0) {
        before += barAct[i - k] as number;
        nbf++;
      }
      if (i + k - 1 < nb) {
        after += barAct[i + k - 1] as number;
        naf++;
      }
    }
    actDiff[i] = nbf > 0 && naf > 0 ? Math.abs(after / naf - before / nbf) : 0;
  }
  const maxOf = (a: Float32Array): number => a.reduce((m, v) => Math.max(m, v), 1e-9);
  const fMax = maxOf(foote);
  const aMax = maxOf(actDiff);
  const novelty = new Float32Array(nb);
  for (let i = 1; i < nb; i++) {
    let v = 0.6 * ((foote[i] as number) / fMax) + 0.4 * ((actDiff[i] as number) / aMax);
    const bar = bars[i] as Bar;
    const prev = bars[i - 1] as Bar;
    if (bar.barInPhrase === 0 && bar.group !== prev.group) v += 0.15;
    novelty[i] = clamp01(v);
  }

  let mean = 0;
  for (let i = 1; i < nb; i++) mean += novelty[i] as number;
  mean /= Math.max(1, nb - 1);
  let varSum = 0;
  for (let i = 1; i < nb; i++) varSum += ((novelty[i] as number) - mean) ** 2;
  const threshold = mean + 0.5 * Math.sqrt(varSum / Math.max(1, nb - 1));
  const peaks: number[] = [];
  for (let i = 2; i < nb - 1; i++) {
    const v = novelty[i] as number;
    if (v < threshold) continue;
    let isPeak = true;
    for (let k = Math.max(1, i - 2); k <= Math.min(nb - 1, i + 2); k++) {
      if ((novelty[k] as number) > v) isPeak = false;
    }
    if (isPeak) peaks.push(i);
  }
  peaks.sort((a, b) => (novelty[b] as number) - (novelty[a] as number));
  const phase = plan?.phase ?? 0;
  const snap = (i: number): number => {
    if (phraseBars <= 1) return i;
    const r = (((i - phase) % phraseBars) + phraseBars) % phraseBars;
    if (r === 0) return i;
    if (r <= 1) return i - r;
    if (phraseBars - r <= 1) return i + (phraseBars - r);
    return i;
  };
  const cuts: number[] = [];
  for (const p of peaks) {
    const c = snap(p);
    if (c <= 0 || c >= nb) continue;
    if (c < 2 || nb - c < 2) continue;
    if (cuts.some((x) => Math.abs(x - c) < MIN_SECTION_BARS)) continue;
    cuts.push(c);
  }
  cuts.sort((a, b) => a - b);
  const edges = [0, ...cuts, nb];
  const sections: Section[] = [];
  const cands = inputs.candidates;
  for (let s = 0; s + 1 < edges.length; s++) {
    const firstBar = edges[s] as number;
    const endBar = edges[s + 1] as number;
    if (endBar <= firstBar) continue;
    const startMs = Math.max(0, (bars[firstBar] as Bar).startMs);
    const endMs = Math.min(f.durationMs, (bars[endBar - 1] as Bar).endMs);
    const a = Math.max(0, Math.floor(startMs / fm));
    const b = Math.max(a + 1, Math.min(f.frameCount, Math.floor(endMs / fm)));
    const avg = (curve: Float32Array, from = a, to = b): number => {
      let sum = 0;
      for (let k = from; k < to; k++) sum += curve[k] as number;
      return to > from ? sum / (to - from) : 0;
    };
    const third = Math.max(1, Math.floor((b - a) / 3));
    let count = 0;
    for (const c of cands) if (c.tMs >= startMs && c.tMs < endMs) count++;
    let pitchSum = 0;
    let pitchW = 0;
    for (const n of inputs.leadNotes) {
      if (n.tMs < startMs || n.tMs >= endMs) continue;
      pitchSum += n.midi * n.durMs;
      pitchW += n.durMs;
    }
    sections.push({
      startMs,
      endMs,
      firstBar,
      endBar,
      role: 'verse',
      activity: avg(inputs.activity),
      density: count / Math.max(0.001, (endMs - startMs) / 1000),
      brightness: avg(f.brightness),
      pitch: pitchW > 0 ? Math.round((pitchSum / pitchW) * 10) / 10 : null,
      lowPunch: avg(inputs.lowPunch),
      loudness: avg(f.loudness),
      rise: avg(inputs.activity, b - third, b) - avg(inputs.activity, a, a + third),
    });
  }
  labelSections(sections, bars, inputs.buildUps);

  return {
    beatMs,
    barMs,
    bars,
    phraseBars,
    groupCount: groupSizes.length,
    groupSizes,
    similarity,
    novelty,
    sections,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

/** The repeat group most of a section's bars belong to (-1 if none). */
function dominantGroup(section: Section, bars: readonly Bar[]): number {
  const counts = new Map<number, number>();
  for (let i = section.firstBar; i < section.endBar; i++) {
    const g = (bars[i] as Bar).group;
    if (g >= 0) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = -1;
  let bestN = 0;
  for (const [g, n] of counts) {
    if (n > bestN) {
      best = g;
      bestN = n;
    }
  }
  return best;
}

function overlapFraction(
  s: { startMs: number; endMs: number },
  spans: readonly { startMs: number; endMs: number }[],
): number {
  let o = 0;
  for (const b of spans)
    o += Math.max(0, Math.min(s.endMs, b.endMs) - Math.max(s.startMs, b.startMs));
  return o / Math.max(1, s.endMs - s.startMs);
}

/**
 * Roles by rules: drops are the most active sections with low punch (and the sections that
 * repeat their material); build-ups rise into a drop (or match a detected build-up); the first
 * and last calmer sections are intro and outro; calm sections without punch in between are
 * breakdowns; everything else is a verse.
 */
function labelSections(
  sections: Section[],
  bars: readonly Bar[],
  buildUps: readonly { startMs: number; endMs: number }[],
): void {
  const n = sections.length;
  if (n === 0) return;
  const acts = sections.map((s) => s.activity);
  const rank = (v: number): number =>
    n <= 1 ? 1 : acts.filter((a) => a < v).length / Math.max(1, n - 1);
  const medAct = median(acts);
  const medPunch = median(sections.map((s) => s.lowPunch));
  const medDensity = median(sections.map((s) => s.density));
  const roles: SectionRole[] = sections.map(() => 'verse');

  sections.forEach((s, i) => {
    if (rank(s.activity) >= 0.6 && s.lowPunch >= 0.8 * medPunch && s.activity >= medAct) {
      roles[i] = 'drop';
    }
  });
  if (n >= 2 && !roles.includes('drop')) {
    const top = acts.indexOf(Math.max(...acts));
    roles[top] = 'drop';
  }
  // Sections that repeat a drop's material (a second chorus) are drops too.
  const dropGroups = new Set(
    sections.filter((_, i) => roles[i] === 'drop').map((s) => dominantGroup(s, bars)),
  );
  dropGroups.delete(-1);
  sections.forEach((s, i) => {
    if (roles[i] !== 'drop' && dropGroups.has(dominantGroup(s, bars)) && s.activity >= medAct) {
      roles[i] = 'drop';
    }
  });

  sections.forEach((s, i) => {
    if (roles[i] === 'drop') return;
    const next = sections[i + 1];
    const intoDrop = next !== undefined && roles[i + 1] === 'drop';
    const rising = s.rise > 0.08;
    const detected = overlapFraction(s, buildUps) >= 0.4;
    const sparseLow = next !== undefined && s.lowPunch < 0.6 * next.lowPunch;
    if ((intoDrop && (rising || detected || sparseLow)) || (detected && rising)) {
      roles[i] = 'build-up';
    }
  });

  const first = sections[0] as Section;
  if (roles[0] !== 'drop' && !(roles[0] === 'build-up' && first.rise > 0.15)) {
    if (rank(first.activity) <= 0.5 || first.lowPunch < medPunch || n === 1) roles[0] = 'intro';
  }
  const last = sections[n - 1] as Section;
  if (n > 1 && roles[n - 1] !== 'drop') {
    if (rank(last.activity) <= 0.5 || last.rise < -0.1) roles[n - 1] = 'outro';
  }
  for (let i = 1; i < n - 1; i++) {
    if (roles[i] !== 'verse') continue;
    const s = sections[i] as Section;
    const calm = rank(s.activity) <= 0.35 || s.activity < 0.75 * medAct;
    if (
      (calm && s.lowPunch < medPunch) ||
      s.lowPunch < 0.5 * medPunch ||
      s.density < 0.5 * medDensity
    ) {
      roles[i] = 'breakdown';
    }
  }
  sections.forEach((s, i) => (s.role = roles[i] as SectionRole));
}
