import type { ChartAnalysis, SectionRole } from './analysis/types';
import { lerp } from './hits';
import type { GeneratorParams } from './presets';

/**
 * Step A, the density plan: target notes per second per beat, a smooth curve from the base
 * (calm floor) to the peak, driven by the musical-activity curve (relative to the song) and the
 * section role, never by loudness directly. Build-ups ramp up toward the drop, lead runs may
 * reach the burst rate, silent beats get nothing unless "fill silence" is on.
 */

/** Mean RMS (full scale) below which a beat counts as silent (about -52 dBFS). */
export const SILENT_RMS = 0.0025;

export interface DensityPlan {
  beatMs: number;
  /** Song time of cell 0 (a beat line); cell i covers [startMs + i * beatMs, ... + beatMs). */
  startMs: number;
  /** Target notes per second per beat. */
  targets: Float32Array;
  /** 0-1 activity relative to the song, smoothed, per beat. */
  activity: Float32Array;
  /** 1 where the beat has sound. */
  sound: Uint8Array;
  /** Section role per beat. */
  roles: SectionRole[];
}

export function cellOf(plan: DensityPlan, ms: number): number {
  return Math.min(
    plan.targets.length - 1,
    Math.max(0, Math.floor((ms - plan.startMs) / plan.beatMs)),
  );
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] as number;
}

export function densityPlan(a: ChartAnalysis, p: GeneratorParams): DensityPlan {
  const f = a.features;
  const beatMs = 60000 / a.bpm;
  const first = Math.floor((0 - a.offsetMs) / beatMs);
  const startMs = a.offsetMs + first * beatMs;
  const cells = Math.max(1, Math.ceil((a.durationMs - startMs) / beatMs));
  const raw = new Float64Array(cells);
  const sound = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const k0 = Math.max(0, Math.floor((startMs + i * beatMs) / f.frameMs));
    const k1 = Math.min(f.frameCount, Math.ceil((startMs + (i + 1) * beatMs) / f.frameMs));
    let act = 0;
    let rms = 0;
    for (let k = k0; k < k1; k++) {
      act += a.activity[k] ?? 0;
      rms += f.rms[k] ?? 0;
    }
    const n = Math.max(1, k1 - k0);
    raw[i] = act / n;
    sound[i] = k1 > k0 && rms / n >= SILENT_RMS ? 1 : 0;
  }
  // Smooth over +/-1 beat, then place relative to the song (10th to 95th percentile of beats
  // with sound).
  const smooth = new Float64Array(cells);
  for (let i = 0; i < cells; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(cells - 1, i + 1); j++) {
      s += (raw[j] as number) * (j === i ? 2 : 1);
      n += j === i ? 2 : 1;
    }
    smooth[i] = s / n;
  }
  const voiced: number[] = [];
  for (let i = 0; i < cells; i++) if (sound[i]) voiced.push(smooth[i] as number);
  const lo = quantile(voiced, 0.1);
  const hi = Math.max(lo + 1e-6, quantile(voiced, 0.95));
  const shaped = new Float64Array(cells);
  const activity = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    const x = Math.min(1, Math.max(0, ((smooth[i] as number) - lo) / (hi - lo)));
    activity[i] = x;
    shaped[i] = Math.pow(x, Math.max(0.05, p.gamma));
  }
  // Contrast: push the curve away from (or toward) its median.
  const shapedVoiced: number[] = [];
  for (let i = 0; i < cells; i++) if (sound[i]) shapedVoiced.push(shaped[i] as number);
  const mid = quantile(shapedVoiced, 0.5);
  const k = Math.pow(2, (p.contrast - 0.5) * 3);
  for (let i = 0; i < cells; i++) {
    shaped[i] = Math.min(1, Math.max(0, mid + ((shaped[i] as number) - mid) * k));
  }

  // Roles, with build-ups ramping toward their end.
  const roles: SectionRole[] = new Array<SectionRole>(cells).fill('verse');
  for (const s of a.structure.sections) {
    const c0 = Math.max(0, Math.floor((s.startMs - startMs) / beatMs));
    const c1 = Math.min(cells, Math.ceil((s.endMs - startMs) / beatMs));
    for (let i = c0; i < c1; i++) {
      roles[i] = s.role;
      if (s.role === 'build-up' && c1 > c0) {
        const progress = (i - c0 + 1) / (c1 - c0);
        shaped[i] = Math.max(shaped[i] as number, 0.2 + 0.8 * Math.pow(progress, 1.5));
      }
    }
  }

  const targets = new Float32Array(cells);
  const ceiling = p.ceilingNps;
  for (let i = 0; i < cells; i++) {
    if (!sound[i] && !p.fillSilence) continue;
    const role = p.roles[roles[i] ?? 'verse'];
    const above = (p.peakNps - p.baseNps) * (shaped[i] as number) * role;
    const t = Math.max(p.baseNps, p.baseNps + above) * p.multiplier;
    targets[i] = Math.min(ceiling, Math.max(0, t));
  }
  // Lead runs: the plan may rise toward the run's own rate, up to the burst cap.
  for (const r of a.leadRuns) {
    const c0 = Math.max(0, Math.floor((r.startMs - startMs) / beatMs));
    const c1 = Math.min(cells, Math.ceil((r.endMs - startMs) / beatMs));
    const runNps = Math.min(p.burstNps, ceiling, r.rateHz);
    for (let i = c0; i < c1; i++) {
      const t = targets[i] as number;
      if (t <= 0) continue;
      targets[i] = Math.max(t, lerp(t, runNps, p.leadRunPriority));
    }
  }
  return { beatMs, startMs, targets, activity, sound, roles };
}
