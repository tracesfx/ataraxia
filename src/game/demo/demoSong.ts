import type { Chart } from '../../core/chart';
import {
  DEMO_BARS,
  DEMO_BEATS_PER_BAR,
  DEMO_BEAT_MS,
  DEMO_DURATION_MS,
  DEMO_SECTIONS,
  demoTimeMs,
} from './demoChart';

/**
 * Renders the demo song with an OfflineAudioContext: no audio files are shipped.
 * Kick on every beat, hi-hat on the off-beats, snare on 2 and 4, an 8th-note bass, and a lead
 * line generated from the chart itself (one pluck per note, sustained for holds), so every
 * note has a sound to follow. Original composition: Am - F - C - G.
 */

const SAMPLE_RATE = 44100;
const MASTER_GAIN = 0.6;

/** Chord per bar (4-bar loop): bass root and the four chord tones lanes 0-3 play. MIDI notes. */
const PROGRESSION: readonly { root: number; tones: readonly [number, number, number, number] }[] = [
  { root: 45, tones: [69, 72, 76, 81] }, // Am: A4 C5 E5 A5
  { root: 41, tones: [65, 69, 72, 77] }, // F:  F4 A4 C5 F5
  { root: 48, tones: [67, 72, 76, 79] }, // C:  G4 C5 E5 G5
  { root: 43, tones: [67, 71, 74, 79] }, // G:  G4 B4 D5 G5
];

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function chordAt(timeMs: number): (typeof PROGRESSION)[number] {
  const bar = Math.floor(timeMs / (DEMO_BEAT_MS * DEMO_BEATS_PER_BAR));
  return PROGRESSION[bar % PROGRESSION.length] as (typeof PROGRESSION)[number];
}

let cached: Promise<AudioBuffer> | null = null;

/** Render once per page load; later calls reuse the buffer. */
export function getDemoSong(chart: Chart): Promise<AudioBuffer> {
  cached ??= renderDemoSong(chart).catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}

export async function renderDemoSong(chart: Chart): Promise<AudioBuffer> {
  const length = Math.ceil((DEMO_DURATION_MS / 1000) * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);

  // No compressor: Chrome's DynamicsCompressor delays its output by a 6 ms look-ahead, which
  // would put every sound late against the chart. A fixed gain keeps peaks below 1 instead.
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);

  const noise = makeNoise(ctx);
  // One filter per instrument, shared by all its notes. (A filter per note keeps hundreds of
  // filters alive for the whole render and makes it many times slower.)
  const bus: Buses = {
    hat: filterBus(ctx, master, 'highpass', 7000),
    snare: filterBus(ctx, master, 'bandpass', 1800),
    bass: filterBus(ctx, master, 'lowpass', 900),
    lead: filterBus(ctx, master, 'lowpass', 2600),
  };
  const s = (ms: number): number => ms / 1000;
  // Voices are created just in time (see scheduleVoices) rather than all up front.
  const voices: Voice[] = [];
  const at = (timeSec: number, create: () => void): void => {
    voices.push({ timeSec, create });
  };
  const totalBeats = DEMO_BARS * DEMO_BEATS_PER_BAR;
  const musicStartMs = demoTimeMs(DEMO_SECTIONS.singles[0]);

  for (let beat = 0; beat < totalBeats; beat++) {
    const t = s(beat * DEMO_BEAT_MS);
    at(t, () => kick(ctx, master, t));
    const ht = t + s(DEMO_BEAT_MS / 2);
    at(ht, () => hat(ctx, bus.hat, noise, ht));
    if (beat * DEMO_BEAT_MS >= musicStartMs && beat % 2 === 1) {
      at(t, () => snare(ctx, bus.snare, master, noise, t));
    }
  }
  // Final downbeat so the song ends on a hit, not mid-bar.
  const endT = s(totalBeats * DEMO_BEAT_MS);
  at(endT, () => kick(ctx, master, endT));

  for (let eighth = 0; eighth < totalBeats * 2; eighth++) {
    const ms = (eighth * DEMO_BEAT_MS) / 2;
    if (ms < musicStartMs) continue;
    const root = chordAt(ms).root;
    const hz = midiToHz(eighth % 2 === 0 ? root : root + 12);
    at(s(ms), () => bass(ctx, bus.bass, s(ms), hz));
  }

  for (const note of chart.notes) {
    const chord = chordAt(note.t);
    const durMs = note.type === 'hold' ? note.dur : 180;
    const hz = midiToHz(chord.tones[note.lane]);
    at(s(note.t), () => lead(ctx, bus.lead, s(note.t), s(durMs), hz));
  }

  scheduleVoices(ctx, voices);
  return ctx.startRendering();
}

interface Voice {
  timeSec: number;
  create: () => void;
}

/** Seconds of song per batch of voices. */
const CHUNK_SEC = 2;

/**
 * Creating every note's nodes before rendering keeps ~1000 nodes in the graph for the whole
 * minute and makes rendering several times slower. Instead, suspend the offline render shortly
 * before each chunk and create only that chunk's voices; finished voices drop out of the graph.
 */
function scheduleVoices(ctx: OfflineAudioContext, voices: Voice[]): void {
  const chunks = new Map<number, Voice[]>();
  for (const v of voices) {
    const k = Math.floor(v.timeSec / CHUNK_SEC);
    let list = chunks.get(k);
    if (!list) chunks.set(k, (list = []));
    list.push(v);
  }
  for (const [k, list] of chunks) {
    const run = (): void => list.forEach((v) => v.create());
    if (k === 0) {
      run();
      continue;
    }
    // Suspend half a second before the chunk so every voice still starts in the future.
    void ctx.suspend(k * CHUNK_SEC - 0.5).then(() => {
      run();
      return ctx.resume();
    });
  }
}

interface Buses {
  hat: BiquadFilterNode;
  snare: BiquadFilterNode;
  bass: BiquadFilterNode;
  lead: BiquadFilterNode;
}

function filterBus(
  ctx: BaseAudioContext,
  out: AudioNode,
  type: BiquadFilterType,
  hz: number,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.connect(out);
  return f;
}

function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function envGain(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  peak: number,
  decaySec: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decaySec);
  g.connect(out);
  return g;
}

function kick(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(160, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  osc.connect(envGain(ctx, out, t, 1.0, 0.35));
  osc.start(t);
  osc.stop(t + 0.4);
}

function hat(ctx: BaseAudioContext, bus: AudioNode, noise: AudioBuffer, t: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.connect(envGain(ctx, bus, t, 0.18, 0.05));
  src.start(t, Math.random() * 0.5);
  src.stop(t + 0.06);
}

function snare(
  ctx: BaseAudioContext,
  bus: AudioNode,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.connect(envGain(ctx, bus, t, 0.35, 0.15));
  src.start(t, Math.random() * 0.5);
  src.stop(t + 0.16);

  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(190, t);
  body.connect(envGain(ctx, out, t, 0.25, 0.08));
  body.start(t);
  body.stop(t + 0.1);
}

/** Bass notes never overlap, so the shared filter's cutoff can be swept per note. */
function bass(ctx: BaseAudioContext, bus: BiquadFilterNode, t: number, hz: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = hz;
  bus.frequency.setValueAtTime(900, t);
  bus.frequency.exponentialRampToValueAtTime(250, t + 0.2);
  osc.connect(envGain(ctx, bus, t, 0.22, 0.22));
  osc.start(t);
  osc.stop(t + 0.24);
}

function lead(ctx: BaseAudioContext, bus: AudioNode, t: number, durSec: number, hz: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = hz;
  const g = ctx.createGain();
  const peak = 0.11;
  const sustain = 0.06;
  const release = 0.08;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.004);
  g.gain.exponentialRampToValueAtTime(sustain, t + Math.min(0.1, durSec));
  g.gain.setValueAtTime(sustain, t + durSec);
  g.gain.exponentialRampToValueAtTime(0.0001, t + durSec + release);
  osc.connect(g).connect(bus);
  osc.start(t);
  osc.stop(t + durSec + release + 0.01);
}
