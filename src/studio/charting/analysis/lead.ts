import { clamp01, prefixSums, quantileOf, slidingMax, windowMean } from './dsp';
import { LOCAL_WINDOW_MS, pickPeaks } from './onsets';
import type { ChartFeatures, LayerOnset, LeadNote, LeadRun } from './types';

/**
 * The lead melody from the cached pitch track and lead onset envelope:
 *
 * - Voiced frames: a pitch with enough confidence whose salience beats a LOCAL threshold (the
 *   salience's mean over about +/-200 ms) and a low song-wide floor.
 * - Notes split at pitch changes of 0.7 semitone or more (confirmed by the next frame or an
 *   onset), at harmonic-flux onsets on the same pitch (re-attacks) and at salience re-attacks;
 *   a note ends when its salience decays below a quarter of its peak or the pitch goes away.
 * - Splits closer than the minimum lead interval are ignored, nothing else smooths, so fast
 *   runs (1/16 at 200+ BPM is 75 ms) stay separate notes. Onset times are refined to the nearest
 *   flux peak (the pitch window is long, so pitch alone is late or early).
 */

const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);
/** Pitch changes this large (semitones) start a new note. */
const PITCH_SPLIT = 0.7;
/** A note ends when its salience falls under this fraction of its peak. */
const DECAY_OFF = 0.25;
/** Onset strength (0-1, local) a same-pitch re-attack needs. */
const REATTACK_STRENGTH = 0.45;

export interface LeadResult {
  notes: LeadNote[];
  /** Lead-layer onsets: note starts plus strong pitchless flux onsets. */
  onsets: LayerOnset[];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function detectLead(
  f: ChartFeatures,
  sensitivity: number,
  minIntervalMs: number,
): LeadResult {
  const flux = pickPeaks(f.envelopes.lead, f.onsetHopMs, f.envelopeScale.lead, {
    sensitivity,
    minIntervalMs,
  });
  const M = f.pitchFrames;
  const hop = f.pitchHopMs;
  const sal = f.pitchSalience;
  const conf = f.pitchConfidence;
  const midi = f.pitchMidi;
  const salPrefix = prefixSums(sal);
  const w = Math.max(2, Math.round(LOCAL_WINDOW_MS / hop));
  const salTop = slidingMax(sal, Math.round(1500 / hop));
  const globalFloor = quantileOf(sal, 0.95, 2) * lerp(0.14, 0.025, sensitivity);
  const confMin = lerp(0.36, 0.1, sensitivity);
  const localFactor = lerp(0.9, 0.45, sensitivity);

  const voiced = new Uint8Array(M);
  for (let q = 0; q < M; q++) {
    const s = sal[q] as number;
    voiced[q] =
      (midi[q] as number) > 0 &&
      (conf[q] as number) >= confMin &&
      s >= globalFloor &&
      s >= localFactor * windowMean(salPrefix, q - w, q + w)
        ? 1
        : 0;
  }

  // Flux peaks per pitch frame (nearest), for re-attacks and onset refinement.
  const fluxAt = new Int32Array(M).fill(-1);
  flux.forEach((p, i) => {
    const q = Math.round(p.tMs / hop);
    if (q >= 0 && q < M) {
      const prev = fluxAt[q] as number;
      if (prev < 0 || (flux[prev] as LayerOnset).strength < p.strength) fluxAt[q] = i;
    }
  });
  const nearestFlux = (tMs: number, before: number, after: number): LayerOnset | null => {
    let best: LayerOnset | null = null;
    let bestD = Infinity;
    // Flux peaks are sorted: binary search for the first at or after tMs - before.
    let lo = 0;
    let hi = flux.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((flux[mid] as LayerOnset).tMs < tMs - before) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < flux.length; i++) {
      const p = flux[i] as LayerOnset;
      if (p.tMs > tMs + after) break;
      const d = Math.abs(p.tMs - tMs);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  const notes: LeadNote[] = [];
  const usedFlux = new Set<LayerOnset>();
  interface Open {
    startMs: number;
    startQ: number;
    midis: number[];
    peakSal: number;
    peakQ: number;
    confSum: number;
    flux: LayerOnset | null;
  }
  let note = null as Open | null;
  let waitForRise = false;

  const close = (endMs: number): void => {
    const n = note;
    note = null;
    if (!n) return;
    const frames = n.midis.length;
    if (frames < 2 && !n.flux) return;
    const top = Math.max(salTop[n.peakQ] as number, globalFloor * 2, 1e-9);
    const salStrength = clamp01(n.peakSal / top) ** 0.75;
    const strength = n.flux ? 0.5 * (salStrength + n.flux.strength) : 0.85 * salStrength;
    notes.push({
      tMs: Math.round(n.startMs * 10) / 10,
      durMs: Math.max(Math.round(hop), Math.round(endMs - n.startMs)),
      midi: Math.round(median(n.midis) * 100) / 100,
      strength: Math.round(clamp01(strength) * 1000) / 1000,
      confidence: Math.round((n.confSum / frames) * 1000) / 1000,
    });
    if (n.flux) usedFlux.add(n.flux);
  };

  const open = (q: number): void => {
    const tq = q * hop;
    const prevStart = notes.length > 0 ? (notes[notes.length - 1] as LeadNote).tMs : -Infinity;
    const p = nearestFlux(tq, 45, 30);
    const useFlux = p && !usedFlux.has(p) && p.tMs - prevStart >= minIntervalMs * 0.75 ? p : null;
    note = {
      startMs: useFlux ? useFlux.tMs : tq,
      startQ: q,
      midis: [midi[q] as number],
      peakSal: sal[q] as number,
      peakQ: q,
      confSum: conf[q] as number,
      flux: useFlux,
    };
  };

  for (let q = 0; q < M; q++) {
    const tq = q * hop;
    if (!voiced[q]) {
      if (note) close(tq);
      waitForRise = false;
      continue;
    }
    const s = sal[q] as number;
    const m = midi[q] as number;
    if (!note) {
      // After a decay, only a rise (or a new pitch) starts the next note.
      if (waitForRise && !(s > 1.2 * (sal[q - 1] ?? 0) || (fluxAt[q] as number) >= 0)) continue;
      waitForRise = false;
      open(q);
      continue;
    }
    const n: Open = note;
    const elapsed = tq - n.startMs;
    const ref = median(n.midis.slice(-7));
    const jump = Math.abs(m - ref) >= PITCH_SPLIT;
    const fluxIndex = fluxAt[q] as number;
    const fluxStrength = fluxIndex >= 0 ? (flux[fluxIndex] as LayerOnset).strength : 0;
    const hasFlux = fluxStrength > 0;
    // A new pitch must hold for three more frames, unless an onset confirms it (in dense mixes
    // the strongest pitch flickers between chord tones).
    const steady = (k: number): boolean =>
      k < M && voiced[k] === 1 && Math.abs((midi[k] as number) - m) < PITCH_SPLIT;
    const confirmed = hasFlux || (steady(q + 1) && steady(q + 2) && steady(q + 3));
    const prevMin = Math.min(sal[q - 1] ?? s, sal[q - 2] ?? s);
    const salReattack = s >= 1.6 * prevMin && prevMin <= 0.55 * n.peakSal && s >= 0.5 * n.peakSal;
    if (s < DECAY_OFF * n.peakSal) {
      close(tq);
      waitForRise = true;
      continue;
    }
    const canSplit = elapsed >= minIntervalMs;
    // Same-pitch re-attacks need a clear onset (drum leakage makes weak ones).
    const reattack = !jump && fluxStrength >= REATTACK_STRENGTH;
    if (canSplit && ((jump && confirmed) || reattack || salReattack)) {
      close(tq);
      open(q);
      continue;
    }
    n.midis.push(m);
    n.confSum += conf[q] as number;
    if (s > n.peakSal) {
      n.peakSal = s;
      n.peakQ = q;
    }
  }
  if (note) close(M * hop);

  const onsets: LayerOnset[] = notes.map((n) => ({ tMs: n.tMs, strength: n.strength }));
  // Strong flux onsets without a pitched note (noisy or chordal leads) still count.
  for (const p of flux) {
    if (usedFlux.has(p) || p.strength < 0.6) continue;
    const near = nearestNote(notes, p.tMs, minIntervalMs / 2);
    if (!near) onsets.push(p);
  }
  onsets.sort((a, b) => a.tMs - b.tMs);
  return { notes, onsets };
}

/** The note starting within `toleranceMs` of tMs (notes sorted by start). */
export function nearestNote(
  notes: readonly LeadNote[],
  tMs: number,
  toleranceMs: number,
): LeadNote | null {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((notes[mid] as LeadNote).tMs < tMs - toleranceMs) lo = mid + 1;
    else hi = mid;
  }
  let best: LeadNote | null = null;
  for (let i = lo; i < notes.length; i++) {
    const n = notes[i] as LeadNote;
    if (n.tMs > tMs + toleranceMs) break;
    if (!best || Math.abs(n.tMs - tMs) < Math.abs(best.tMs - tMs)) best = n;
  }
  return best;
}

/**
 * Lead runs: chains of 5 or more lead onsets whose gaps are short (at most about a third of a
 * beat, so sixteenths, triplets and faster) and consistent (each within 30 % of the chain's
 * running gap).
 */
export function findLeadRuns(
  onsets: readonly LayerOnset[],
  notes: readonly LeadNote[],
  beatMs: number,
): LeadRun[] {
  const maxGap = beatMs > 0 ? beatMs * 0.36 : 160;
  const runs: LeadRun[] = [];
  const n = onsets.length;
  let i = 0;
  while (i < n - 1) {
    let j = i;
    let ref: number | null = null;
    const gaps: number[] = [];
    while (j + 1 < n) {
      const gap = (onsets[j + 1] as LayerOnset).tMs - (onsets[j] as LayerOnset).tMs;
      if (gap > maxGap || gap < 20) break;
      if (ref !== null && Math.abs(gap - ref) > 0.3 * ref) break;
      ref = ref === null ? gap : 0.7 * ref + 0.3 * gap;
      gaps.push(gap);
      j++;
    }
    const count = j - i + 1;
    if (count >= 5) {
      const g = median(gaps);
      const members = onsets.slice(i, j + 1);
      runs.push({
        startMs: (onsets[i] as LayerOnset).tMs,
        endMs: Math.round((onsets[j] as LayerOnset).tMs + g),
        count,
        rateHz: Math.round((1000 / g) * 100) / 100,
        perBeat: beatMs > 0 ? Math.round((beatMs / g) * 100) / 100 : 0,
        contour: members.map((o) => nearestNote(notes, o.tMs, 1)?.midi ?? null),
      });
      i = j + 1;
    } else {
      i++;
    }
  }
  return runs;
}
