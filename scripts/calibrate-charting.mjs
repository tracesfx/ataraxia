// Dev-only: compare generated charts (Phase 18 generator) with the local reference chart
// (reference/, never committed or shipped) and print density numbers for
// docs/charting-calibration.md. Full recalibration is Phase 19.
//
//   node scripts/calibrate-charting.mjs            Expert report, seeds 1-3, every difficulty
//   node scripts/calibrate-charting.mjs --sweep    also sweep Expert peak nps
//
// Decodes the MP3 with the mpg123-decoder dev dependency and loads the TypeScript sources
// through Vite's module runner.

import { readFileSync } from 'node:fs';
import { runnerImport } from 'vite';
import { decodeMp3Mono, findReference } from './lib/reference.mjs';

const ref = findReference('reference');
if (!ref) {
  console.error('No reference found: put an .mp3 and its chart .json in reference/.');
  process.exit(1);
}
const sweep = process.argv.includes('--sweep');
const { samples, sampleRate } = await decodeMp3Mono(ref.audio);
const { module: L } = await runnerImport('/src/core/analysis/index.ts');
const { module: A } = await runnerImport('/src/studio/charting/analysis/index.ts');
const { module: G } = await runnerImport('/src/studio/charting/generate.ts');
const { module: C } = await runnerImport('/src/studio/charting/calibration.ts');
const { module: P } = await runnerImport('/src/studio/charting/presets.ts');

const legacy = L.analyzeAudio(samples, sampleRate);
const chart = JSON.parse(readFileSync(ref.chart, 'utf8'));
const bpm = chart.bpm ?? legacy.tempo.bpm;
const offsetMs = chart.offsetMs ?? legacy.tempo.offsetMs;
const features = A.computeChartFeatures(samples, sampleRate);
const analysis = A.evaluateChartAnalysis(
  features,
  { bpm, offsetMs },
  A.DEFAULT_CHART_ANALYSIS_PARAMS,
  A.legacyCurves(legacy),
);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

console.log(`Reference: ${ref.audio} + ${ref.chart} (${bpm} BPM, offset ${offsetMs} ms)`);

function run(params, seed) {
  const t0 = performance.now();
  const result = G.generateChart(
    { analysis, existing: [], durationMs: analysis.durationMs },
    { params, seed, range: null, replaceExisting: false },
  );
  const ms = performance.now() - t0;
  const report = C.compareCharts(legacy, chart.notes, result.notes, bpm, offsetMs);
  return { result, report, ms };
}

for (const d of P.DIFFICULTIES) {
  for (const seed of d === 'Expert' ? [1, 2, 3] : [1]) {
    const { result, report: r, ms } = run(P.presetParams(d), seed);
    const s = result.stats;
    console.log(
      `${d} seed ${seed}: ${s.notes} notes, ${f(s.avgNps)} nps avg, peak ${f(s.peakNps)}, ` +
        `holds ${f(s.holdShare * 100, 0)}%, chords ${f(s.chordShare * 100, 0)}%, ` +
        `longest gap ${f(s.longestGapMs / 1000)} s; r = ${f(r.correlation)} vs reference ` +
        `(reference ${f(r.reference.meanNps)} nps); ${f(ms, 0)} ms`,
    );
  }
}

if (sweep) {
  console.log('\nExpert peak nps sweep (seed 1):');
  for (const peakNps of [9, 11, 13, 16, 20]) {
    const params = { ...P.presetParams('Expert'), peakNps };
    const { result, report: r } = run(params, 1);
    console.log(
      `  peak ${peakNps}: ${f(result.stats.avgNps)} nps avg, peak ${f(result.stats.peakNps)}, r = ${f(r.correlation)}`,
    );
  }
}
