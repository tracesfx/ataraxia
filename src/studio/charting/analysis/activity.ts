import { boxSmooth, clamp01, quantileOf, scaleByQuantile } from './dsp';
import {
  ACTIVITY_PARTS,
  type ActivityPart,
  type ActivityWeights,
  type Candidate,
  type ChartFeatures,
  type LeadNote,
} from './types';

/**
 * The musical activity curve: how much is happening, not how loud it is. A weighted blend of
 * lead onset density, snare/hat density, syncopation, harmony changes, pitch leaps, low-band
 * punch and loudness (weight 0.05 by default), each 0-1 relative to the song, smoothed over
 * half a beat. Cheap: re-evaluated whenever a weight slider moves.
 */

/** Beat length used when the chart has no usable BPM. */
const FALLBACK_BEAT_MS = 500;

/** Weight of a candidate's position in the beat: on the beat 0, offbeat 8th 0.5, 16ths 1. */
export function offbeatWeight(tMs: number, beatMs: number, offsetMs: number): number {
  const pos = ((((tMs - offsetMs) / beatMs) % 1) + 1) % 1;
  const sixteenth = pos * 4;
  const slot = Math.round(sixteenth);
  // Between sixteenths (triplets, swing, loose timing): clearly syncopated.
  if (Math.abs(sixteenth - slot) > 0.25) return 0.7;
  const s = slot % 4;
  return s === 0 ? 0 : s === 2 ? 0.5 : 1;
}

export function computeActivity(
  f: ChartFeatures,
  candidates: readonly Candidate[],
  leadNotes: readonly LeadNote[],
  bpm: number,
  offsetMs: number,
  weights: ActivityWeights,
): { activity: Float32Array; parts: Record<ActivityPart, Float32Array> } {
  const n = f.frameCount;
  const frameMs = f.frameMs;
  const beatMs = bpm > 0 && Number.isFinite(bpm) ? 60000 / bpm : FALLBACK_BEAT_MS;
  const halfBeat = beatMs / 2 / frameMs;
  const lead = new Float32Array(n);
  const drums = new Float32Array(n);
  const low = new Float32Array(n);
  const synNum = new Float32Array(n);
  const synDen = new Float32Array(n);
  const leaps = new Float32Array(n);
  const frameOf = (tMs: number): number => Math.round(tMs / frameMs);

  for (const c of candidates) {
    const k = frameOf(c.tMs);
    if (k < 0 || k >= n) continue;
    lead[k] = (lead[k] as number) + (c.layers.lead ?? 0);
    drums[k] = (drums[k] as number) + Math.max(c.layers.snare ?? 0, c.layers.hats ?? 0);
    low[k] = (low[k] as number) + (c.layers.kick ?? 0);
    const w = offbeatWeight(c.tMs, beatMs, offsetMs);
    synNum[k] = (synNum[k] as number) + c.strength * w;
    synDen[k] = (synDen[k] as number) + c.strength;
  }
  for (let i = 1; i < leadNotes.length; i++) {
    const a = leadNotes[i - 1] as LeadNote;
    const b = leadNotes[i] as LeadNote;
    const jump = Math.abs(b.midi - a.midi);
    if (jump < 3 || b.tMs - a.tMs > beatMs) continue;
    const k = frameOf(b.tMs);
    if (k >= 0 && k < n) leaps[k] = (leaps[k] as number) + Math.min(1, jump / 12);
  }

  // Densities per second over one beat (half a beat each side).
  const perSecond = (impulses: Float32Array): Float32Array => {
    const sm = boxSmooth(impulses, halfBeat);
    for (let i = 0; i < n; i++) sm[i] = ((sm[i] as number) * 1000) / frameMs;
    return scaleByQuantile(sm, 0.95);
  };
  const synN = boxSmooth(synNum, 2 * halfBeat);
  const synD = boxSmooth(synDen, 2 * halfBeat);
  const denTypical = Math.max(
    1e-6,
    quantileOf(synD, 0.5, 4, (v) => v > 0),
  );
  const syncopation = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = synD[i] as number;
    // Fades out where little happens, so a lone offbeat hit isn't "very syncopated".
    syncopation[i] = d > 1e-6 ? clamp01((synN[i] as number) / d) * clamp01(d / denTypical) : 0;
  }

  const parts: Record<ActivityPart, Float32Array> = {
    leadDensity: perSecond(lead),
    drumDensity: perSecond(drums),
    syncopation,
    harmonicChange: scaleByQuantile(boxSmooth(f.harmonicChange, halfBeat), 0.95),
    pitchLeaps: perSecond(leaps),
    lowPunch: perSecond(low),
    loudness: f.loudness,
  };

  let total = 0;
  for (const p of ACTIVITY_PARTS) total += Math.max(0, weights[p]);
  const blend = new Float32Array(n);
  if (total > 0) {
    for (const p of ACTIVITY_PARTS) {
      const w = Math.max(0, weights[p]) / total;
      if (w === 0) continue;
      const curve = parts[p];
      for (let i = 0; i < n; i++) blend[i] = (blend[i] as number) + w * (curve[i] as number);
    }
  }
  // Smoothed over half a beat (a quarter beat each side), then song-relative.
  const activity = scaleByQuantile(boxSmooth(blend, halfBeat / 2), 0.98);
  return { activity, parts };
}
