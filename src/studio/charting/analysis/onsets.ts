import { clamp01, prefixSums, slidingMax, windowMean } from './dsp';
import {
  COINCIDENCE_MS,
  LAYERS,
  type Candidate,
  type ChartFeatures,
  type LayerId,
  type LayerOnset,
} from './types';

/**
 * Peak picking on the cached onset envelopes (cheap: re-run whenever a sensitivity slider moves)
 * and merging coincident onsets of different layers into candidates.
 *
 * Thresholds are ADAPTIVE and LOCAL: a peak must beat the envelope's mean over about +/-200 ms
 * by a factor set by the sensitivity, plus a small floor tied to the layer's own scale. So a
 * quiet arpeggio next to loud drums is judged against its own surroundings, not the song's
 * loudest moments. Strengths are normalised locally too (against the envelope's maximum over
 * about +/-1.5 s).
 */

/** Window of the local threshold, each side. */
export const LOCAL_WINDOW_MS = 200;
/** Window of the local strength normalisation, each side. */
const STRENGTH_WINDOW_MS = 1500;

export interface PickOptions {
  /** 0-1: higher finds quieter peaks. */
  sensitivity: number;
  /** Shortest gap between two onsets. */
  minIntervalMs: number;
}

/** Minimum interval per layer (the lead's comes from the parameters). */
export const LAYER_MIN_INTERVAL_MS: Readonly<Record<LayerId, number>> = {
  kick: 70,
  snare: 60,
  hats: 45,
  bass: 70,
  lead: 40,
  other: 60,
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);

/** Peaks of an onset envelope (frame n at n * hopMs) as onsets with local strengths. */
export function pickPeaks(
  env: Float32Array,
  hopMs: number,
  scale: number,
  o: PickOptions,
): LayerOnset[] {
  const n = env.length;
  if (n < 3) return [];
  const prefix = prefixSums(env);
  const w = Math.max(2, Math.round(LOCAL_WINDOW_MS / hopMs));
  const factor = lerp(2.4, 1.15, o.sensitivity);
  const floor = scale * lerp(0.16, 0.025, o.sensitivity);
  const reach = Math.max(1, Math.round(o.minIntervalMs / 2 / hopMs));
  const localMax = slidingMax(env, Math.round(STRENGTH_WINDOW_MS / hopMs));
  // The flux of a rise peaks about half the lag after the attack.
  const shiftMs = -hopMs;

  const found: { i: number; v: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = env[i] as number;
    if (v < floor) continue;
    if (v < factor * windowMean(prefix, i - w, i + w)) continue;
    let isPeak = true;
    for (let k = Math.max(0, i - reach); k <= Math.min(n - 1, i + reach); k++) {
      const u = env[k] as number;
      if (u > v || (u === v && k < i)) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) found.push({ i, v });
  }

  // Enforce the minimum interval: of two peaks too close, keep the stronger.
  const kept: { i: number; v: number }[] = [];
  const minFrames = o.minIntervalMs / hopMs;
  for (const p of found) {
    const last = kept[kept.length - 1];
    if (last && p.i - last.i < minFrames) {
      if (p.v > last.v) kept[kept.length - 1] = p;
      continue;
    }
    kept.push(p);
  }

  return kept.map(({ i, v }) => {
    // Parabolic interpolation for sub-frame timing.
    const l = env[i - 1] as number;
    const r = env[i + 1] as number;
    const den = l - 2 * v + r;
    const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
    const top = Math.max(localMax[i] as number, floor * 2);
    return {
      tMs: Math.round(((i + d) * hopMs + shiftMs) * 10) / 10,
      strength: Math.round(clamp01(v / top) ** 0.75 * 1000) / 1000,
    };
  });
}

/** Onsets of every layer (the lead's are replaced by its notes, see lead.ts). */
export function pickLayerOnsets(
  f: ChartFeatures,
  sensitivity: number,
): Record<LayerId, LayerOnset[]> {
  const out = {} as Record<LayerId, LayerOnset[]>;
  for (const layer of LAYERS) {
    out[layer] = pickPeaks(f.envelopes[layer], f.onsetHopMs, f.envelopeScale[layer], {
      sensitivity,
      minIntervalMs: LAYER_MIN_INTERVAL_MS[layer],
    });
  }
  return out;
}

/**
 * Merge onsets of all layers: onsets within COINCIDENCE_MS of a candidate's first onset join it
 * (one per layer, the strongest). The candidate's time is its strongest onset's time.
 */
export function mergeCandidates(
  layerOnsets: Record<LayerId, LayerOnset[]>,
  leadPitch: (tMs: number) => number | null,
): Candidate[] {
  const all: { tMs: number; strength: number; layer: LayerId }[] = [];
  for (const layer of LAYERS) {
    for (const o of layerOnsets[layer]) all.push({ tMs: o.tMs, strength: o.strength, layer });
  }
  all.sort((a, b) => a.tMs - b.tMs);
  const out: Candidate[] = [];
  let i = 0;
  while (i < all.length) {
    const first = all[i] as (typeof all)[number];
    const layers: Partial<Record<LayerId, number>> = {};
    let best = first;
    let j = i;
    while (j < all.length && (all[j] as (typeof all)[number]).tMs - first.tMs <= COINCIDENCE_MS) {
      const o = all[j] as (typeof all)[number];
      layers[o.layer] = Math.max(layers[o.layer] ?? 0, o.strength);
      if (o.strength > best.strength) best = o;
      j++;
    }
    out.push({
      tMs: best.tMs,
      strength: best.strength,
      layer: best.layer,
      layers,
      pitch: layers.lead !== undefined ? leadPitch(best.tMs) : null,
    });
    i = j;
  }
  return out;
}
