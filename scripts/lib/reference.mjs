// Dev-only helpers for the charting calibration (scripts/calibrate-charting.mjs and the
// calibration tests): find the local reference song and chart in reference/ (never committed)
// and decode MP3 audio with the mpg123-decoder dev dependency.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The reference audio and chart in `dir`: the documented names
 * (montagem-alquimia-slowed.mp3 / .chart.json) when present, else the only .mp3 and the only
 * .json there. Null when either is missing.
 */
export function findReference(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir);
  const pick = (preferred, ext) => {
    if (names.includes(preferred)) return join(dir, preferred);
    const found = names.filter((n) => n.toLowerCase().endsWith(ext)).sort();
    return found.length > 0 ? join(dir, found[0]) : null;
  };
  const audio = pick('montagem-alquimia-slowed.mp3', '.mp3');
  const chart = pick('montagem-alquimia-slowed.chart.json', '.json');
  return audio && chart ? { audio, chart } : null;
}

/** Decode an MP3 file to mono Float32 samples. */
export async function decodeMp3Mono(path) {
  const { MPEGDecoder } = await import('mpg123-decoder');
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const r = decoder.decode(new Uint8Array(readFileSync(path)));
    const channels = r.channelData;
    const n = r.samplesDecoded;
    const mono = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
    return { samples: mono, sampleRate: r.sampleRate };
  } finally {
    decoder.free();
  }
}

/** Read and parse a JSON file. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
