// Dev-only: run the Studio's chart analysis (Phase 17) on an audio file and print a summary.
//
//   npm run analyze -- "<audio file>"                      detected BPM and offset
//   npm run analyze -- "<audio file>" --bpm 174 --offset 120
//   npm run analyze -- "<audio file>" --json out.json      also write the whole analysis
//
// Decodes with the audio-decode dev dependency (wav, mp3, flac, ogg, ...) and loads the
// TypeScript sources through Vite's module runner.

import { readFileSync, writeFileSync } from 'node:fs';
import { runnerImport } from 'vite';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
if (!file) {
  console.error(
    'Usage: npm run analyze -- "<audio file>" [--bpm N] [--offset MS] [--json out.json]',
  );
  process.exit(1);
}
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const { default: decode } = await import('audio-decode');
const t0 = performance.now();
const decoded = await decode(readFileSync(file));
const channels = decoded.channelData;
const n = channels[0]?.length ?? 0;
const mono = new Float32Array(n);
for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
const sampleRate = decoded.sampleRate;
const tDecoded = performance.now();

const { module: A } = await runnerImport('/src/studio/charting/analysis/index.ts');
const { module: L } = await runnerImport('/src/core/analysis/index.ts');

const legacy = L.analyzeAudio(mono, sampleRate);
const tLegacy = performance.now();
const features = A.computeChartFeatures(mono, sampleRate);
const tFeatures = performance.now();
const bpm = option('bpm') !== undefined ? Number(option('bpm')) : (legacy.tempo.bpm ?? 120);
const offsetMs =
  option('offset') !== undefined ? Number(option('offset')) : (legacy.tempo.offsetMs ?? 0);
const analysis = A.evaluateChartAnalysis(
  features,
  { bpm, offsetMs },
  A.DEFAULT_CHART_ANALYSIS_PARAMS,
  A.legacyCurves(legacy),
);
const tEval = performance.now();

const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
console.log(`${file}: ${sampleRate} Hz, ${channels.length} channel(s).`);
console.log(
  `Timing: decode ${s(tDecoded - t0)}, older analysis ${s(tLegacy - tDecoded)}, ` +
    `features ${s(tFeatures - tLegacy)}, evaluation ${s(tEval - tFeatures)}.`,
);
console.log(
  option('bpm') === undefined
    ? `Tempo detected: ${bpm} BPM, offset ${offsetMs} ms (pass --bpm and --offset to use the chart's).`
    : `Tempo given: ${bpm} BPM, offset ${offsetMs} ms.`,
);
for (const line of A.describeChartAnalysis(analysis)) console.log(line);
const out = option('json');
if (out) {
  writeFileSync(out, A.chartAnalysisToJson(analysis));
  console.log(`Wrote ${out}.`);
}
