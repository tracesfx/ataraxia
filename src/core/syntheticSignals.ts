import { seededRandom } from './random';

/**
 * Synthetic audio for testing the analysis: click tracks with a known tempo and offset, noise
 * and silence. Mono Float32 samples.
 */

export interface ClickTrackOptions {
  bpm: number;
  /** Time of the first click (beat 0), ms. */
  offsetMs: number;
  durationMs: number;
  sampleRate?: number;
  /** Every Nth click (from the first) is louder, like a metronome's downbeat. 0 = none. */
  accentEvery?: number;
  /** Peak amplitude of normal clicks (accents are 1). */
  level?: number;
  /** Add white noise at this amplitude. */
  noise?: number;
  seed?: number;
}

/** Times (ms) of the clicks a click track contains. */
export function clickTimes(o: ClickTrackOptions): number[] {
  const out: number[] = [];
  const period = 60000 / o.bpm;
  for (let k = 0; ; k++) {
    const t = o.offsetMs + k * period;
    if (t >= o.durationMs - 50) break;
    out.push(t);
  }
  return out;
}

/** A click (short decaying 1.5 kHz burst) on every beat. */
export function clickTrack(o: ClickTrackOptions): Float32Array {
  const rate = o.sampleRate ?? 44100;
  const out = new Float32Array(Math.round((o.durationMs / 1000) * rate));
  const rand = seededRandom(o.seed ?? 1);
  if (o.noise) for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * o.noise;
  const clickLen = Math.round(0.03 * rate);
  clickTimes(o).forEach((t, k) => {
    const accent = o.accentEvery ? k % o.accentEvery === 0 : false;
    const amp = accent ? 1 : (o.level ?? 0.6);
    const start = (t / 1000) * rate;
    const first = Math.ceil(start);
    for (let i = 0; i < clickLen && first + i < out.length; i++) {
      const s = (first + i - start) / rate;
      const v = amp * Math.exp(-s / 0.006) * Math.sin(2 * Math.PI * 1500 * s);
      out[first + i] = (out[first + i] as number) + v;
    }
  });
  return out;
}

/** Uniform white noise. */
export function whiteNoise(
  durationMs: number,
  amplitude = 0.5,
  seed = 7,
  rate = 44100,
): Float32Array {
  const out = new Float32Array(Math.round((durationMs / 1000) * rate));
  const rand = seededRandom(seed);
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * amplitude;
  return out;
}

export function silence(durationMs: number, rate = 44100): Float32Array {
  return new Float32Array(Math.round((durationMs / 1000) * rate));
}

/** A sine tone of `durationMs` starting at `startMs`, mixed into `out` (fades 5 ms each end). */
export function addTone(
  out: Float32Array,
  startMs: number,
  durationMs: number,
  freq: number,
  amp: number,
  rate = 44100,
): void {
  const first = Math.round((startMs / 1000) * rate);
  const len = Math.round((durationMs / 1000) * rate);
  const fade = Math.round(0.005 * rate);
  for (let i = 0; i < len && first + i < out.length; i++) {
    const env = Math.min(1, i / fade, (len - i) / fade);
    out[first + i] =
      (out[first + i] as number) + amp * env * Math.sin((2 * Math.PI * freq * i) / rate);
  }
}

/** A kick drum: a 55 Hz sine with a fast pitch drop and decay, mixed into `out`. */
export function addKick(out: Float32Array, startMs: number, amp: number, rate = 44100): void {
  const first = Math.round((startMs / 1000) * rate);
  const len = Math.round(0.25 * rate);
  let phase = 0;
  for (let i = 0; i < len && first + i < out.length; i++) {
    if (first + i < 0) continue;
    const s = i / rate;
    const freq = 55 + 90 * Math.exp(-s / 0.02);
    phase += (2 * Math.PI * freq) / rate;
    out[first + i] = (out[first + i] as number) + amp * Math.exp(-s / 0.09) * Math.sin(phase);
  }
}

/**
 * A noise burst (hat, snare, crash): white noise with an exponential decay. `bright` 0-1 mixes
 * from plain noise towards its high-passed version (first difference).
 */
export function addNoiseBurst(
  out: Float32Array,
  startMs: number,
  decayMs: number,
  amp: number,
  bright: number,
  seed: number,
  rate = 44100,
): void {
  const rand = seededRandom(seed);
  const first = Math.round((startMs / 1000) * rate);
  const len = Math.round(((decayMs * 5) / 1000) * rate);
  let prev = 0;
  for (let i = 0; i < len && first + i < out.length; i++) {
    const n = rand() * 2 - 1;
    const v = (1 - bright) * n + bright * (n - prev) * 0.5;
    prev = n;
    if (first + i < 0) continue;
    const env = Math.exp(-((i / rate) * 1000) / decayMs);
    out[first + i] = (out[first + i] as number) + amp * env * v;
  }
}

/**
 * A pad of noise whose level and brightness ramp linearly from (amp0, bright0) to (amp1, bright1)
 * over [startMs, endMs): a riser, the classic build-up sound.
 */
export function addRiser(
  out: Float32Array,
  startMs: number,
  endMs: number,
  amp0: number,
  amp1: number,
  seed: number,
  rate = 44100,
): void {
  const rand = seededRandom(seed);
  const first = Math.round((startMs / 1000) * rate);
  const last = Math.min(out.length, Math.round((endMs / 1000) * rate));
  let low = 0;
  let prev = 0;
  for (let i = first; i < last; i++) {
    const f = (i - first) / Math.max(1, last - first);
    const n = rand() * 2 - 1;
    // One-pole low-pass for the dark start, first difference for the bright end.
    low += 0.05 * (n - low);
    const high = (n - prev) * 0.5;
    prev = n;
    const v = (1 - f) * low * 3 + f * high;
    if (i >= 0) out[i] = (out[i] as number) + (amp0 + (amp1 - amp0) * f) * v;
  }
}

/** Layout of `buildUpDropSong` (120 BPM, beat 0 at 0 ms). */
export const BUILD_DROP = {
  bpm: 120,
  offsetMs: 0,
  rate: 22050,
  /** Quiet build-up: a rising riser with a soft tick on every beat, no drums. */
  buildUpStartMs: 2000,
  buildUpEndMs: 18000,
  /** The drop: a kick and a crash at dropMs, then kicks, snares and 16th hats until dropEndMs. */
  dropMs: 18000,
  dropEndMs: 34000,
  durationMs: 38000,
} as const;

/**
 * A synthetic song with a quiet build-up followed by a loud drop (see BUILD_DROP): the shape the
 * chart generator must chart sparse-then-dense, with a standalone impact on the drop.
 */
export function buildUpDropSong(): Float32Array {
  const L = BUILD_DROP;
  const rate = L.rate;
  const out = new Float32Array(Math.round((L.durationMs / 1000) * rate));
  const beat = 60000 / L.bpm;
  addRiser(out, L.buildUpStartMs, L.buildUpEndMs, 0.02, 0.3, 11, rate);
  for (let t = L.buildUpStartMs; t < L.buildUpEndMs; t += beat) {
    addNoiseBurst(out, t, 15, 0.05, 1, Math.round(t), rate);
  }
  addKick(out, L.dropMs, 1, rate);
  addNoiseBurst(out, L.dropMs, 350, 0.7, 0.5, 99, rate);
  let k = 0;
  for (let t = L.dropMs; t < L.dropEndMs; t += beat / 4, k++) {
    if (k % 4 === 0 && t > L.dropMs) addKick(out, t, 0.8, rate);
    if (k % 8 === 4) addNoiseBurst(out, t, 70, 0.45, 0.4, 1000 + k, rate);
    addNoiseBurst(out, t, 18, 0.16, 1, 5000 + k, rate);
  }
  for (let t = L.dropEndMs; t < L.durationMs - 1000; t += beat) {
    addNoiseBurst(out, t, 15, 0.03, 1, 9000 + Math.round(t), rate);
  }
  return out;
}
