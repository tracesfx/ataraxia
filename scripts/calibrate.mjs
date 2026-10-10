// Dev-only (Phase 19): compare the note generator with a hand-made reference chart.
//
//   npm run calibrate -- --audio "<song>" --chart "<chart.json>" --difficulty hard
//       ChartAnalysis + the generator with 5 seeds, metrics against the reference, a table, and
//       the generated part of docs/charting-calibration.md plus a JSON of the metrics.
//   ... --tune            also search the preset's parameters (fit one half, validate the other)
//   ... --all             also report every other difficulty (Easy, Normal, Expert)
//   ... --sanity "<song>" "<chart>"   metrics on a second song (reported only, never fitted)
//   ... --seeds N         seeds 1..N (default 5)   --no-doc   don't touch the docs
//   ... --json <path>     metrics JSON (default docs/charting-calibration.json)
//
// Decodes audio with the audio-decode dev dependency and loads the TypeScript sources through
// Vite's module runner. Nothing from reference/ is written outside reference/ except numbers.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { runnerImport } from 'vite';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

/** Without --audio / --chart: the only audio file and the only .json in reference/. */
const onlyIn = (exts) => {
  if (!existsSync('reference')) return undefined;
  const found = readdirSync('reference').filter(
    (n) => !n.startsWith('.') && exts.some((e) => n.toLowerCase().endsWith(e)),
  );
  return found.length === 1 ? `reference/${found[0]}` : undefined;
};
const audioPath = option('audio') ?? onlyIn(['.mp3', '.ogg', '.wav', '.flac']) ?? '';
const chartPath = option('chart') ?? onlyIn(['.json']) ?? '';
const difficultyArg = (option('difficulty') ?? 'hard').toLowerCase();
const seedCount = Math.max(1, Number(option('seeds') ?? 5));
const jsonPath = option('json') ?? 'docs/charting-calibration.json';
const docPath = 'docs/charting-calibration.md';
const writeDoc = !flag('no-doc');

if (!audioPath || !chartPath || !existsSync(audioPath) || !existsSync(chartPath)) {
  const missing =
    !audioPath || !existsSync(audioPath) ? audioPath || 'the audio' : chartPath || 'the chart';
  console.error(
    `Reference not found: ${missing}. Pass --audio and --chart, or put exactly one audio file ` +
      'and one chart .json in reference/.',
  );
  process.exit(1);
}

const { module: L } = await runnerImport('/src/core/analysis/index.ts');
const { module: A } = await runnerImport('/src/studio/charting/analysis/index.ts');
const { module: G } = await runnerImport('/src/studio/charting/generate.ts');
const { module: P } = await runnerImport('/src/studio/charting/presets.ts');
const { module: M } = await runnerImport('/src/studio/charting/calibrationMetrics.ts');
const { module: X } = await runnerImport('/src/studio/charting/metrics.ts');
const { module: PC } = await runnerImport('/src/core/parseChart.ts');
const { module: BG } = await runnerImport('/src/core/beatGrid.ts');
const { default: decode } = await import('audio-decode');

const difficulty = P.DIFFICULTIES.find((d) => d.toLowerCase() === difficultyArg);
if (!difficulty) {
  console.error(`Unknown difficulty "${difficultyArg}": use ${P.DIFFICULTIES.join(', ')}.`);
  process.exit(1);
}

const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)} %` : '-');
const ts = (ms) => BG.formatTimestamp(ms);

/** Decode, analyse and load one song + chart. */
async function loadSong(audio, chartFile) {
  const decoded = await decode(readFileSync(audio));
  const channels = decoded.channelData;
  const n = channels[0]?.length ?? 0;
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  const parsed = PC.parseChart(JSON.parse(readFileSync(chartFile, 'utf8')));
  if (!parsed.ok) {
    console.error(`${chartFile} is not a valid ataraxia chart: ${parsed.errors.join(' ')}`);
    process.exit(1);
  }
  const chart = parsed.chart;
  const legacy = L.analyzeAudio(mono, decoded.sampleRate);
  const features = A.computeChartFeatures(mono, decoded.sampleRate);
  const cache = new Map();
  const analysisFor = (params) => {
    const key = JSON.stringify(params);
    let a = cache.get(key);
    if (!a) {
      a = A.evaluateChartAnalysis(
        features,
        { bpm: chart.bpm, offsetMs: chart.offsetMs },
        params,
        A.legacyCurves(legacy),
      );
      cache.set(key, a);
    }
    return a;
  };
  return { audio, chartFile, chart, features, analysisFor };
}

const song = await loadSong(audioPath, chartPath);
const ref = song.chart.notes;
const baseAnalysisParams = {
  ...A.DEFAULT_CHART_ANALYSIS_PARAMS,
  weights: { ...A.DEFAULT_CHART_ANALYSIS_PARAMS.weights },
};
const fullRange = (s) => ({ startMs: 0, endMs: s.features.durationMs });

/** Generate over `range` and measure against the reference over the same range. */
function evaluate(s, setup, seed, range) {
  const a = s.analysisFor(setup.analysis);
  const result = G.generateChart(
    { analysis: a, existing: [], durationMs: a.durationMs },
    { params: setup.gen, seed, range, replaceExisting: false },
  );
  const metrics = M.calibrationMetrics(a, s.chart.notes, result.notes, range);
  return { result, metrics, analysis: a };
}

function evaluateSeeds(s, setup, range, seeds) {
  return seeds.map((seed) => ({ seed, ...evaluate(s, setup, seed, range) }));
}

const meanOf = (xs) => xs.reduce((t, v) => t + v, 0) / Math.max(1, xs.length);
const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);

/** Peak (densest 4-beat window) and burst (densest beat) nps of a note list. */
function peaks(notes, bpm) {
  const beatMs = 60000 / bpm;
  const times = X.hitTimes(notes);
  // 90th percentile of 4-beat windows on the beat grid (sustained density, robust to one run).
  const w = X.windowNps(times, song.chart.offsetMs, times[times.length - 1] ?? 0, 4 * beatMs)
    .filter((v) => v > 0)
    .sort((x, y) => x - y);
  return {
    p90Nps: w[Math.floor(w.length * 0.9)] ?? 0,
    peakNps: (X.maxInWindow(times, 4 * beatMs) * 1000) / (4 * beatMs),
    burstNps: (X.maxInWindow(times, beatMs) * 1000) / beatMs,
  };
}

// --- Tuning ----------------------------------------------------------------------------------

/** The search space: generator and analysis parameters, each with a few round values. */
function dims() {
  const g = (path, values) => ({
    name: path,
    values,
    get: (s) => path.split('.').reduce((o, k) => o[k], s.gen),
    set: (s, v) => {
      const keys = path.split('.');
      const last = keys.pop();
      keys.reduce((o, k) => o[k], s.gen)[last] = v;
    },
  });
  const an = (key, values) => ({
    name: `analysis.${key}`,
    values,
    get: (s) => s.analysis[key],
    set: (s, v) => {
      s.analysis[key] = v;
    },
  });
  const aw = (key, values) => ({
    name: `activity.${key}`,
    values,
    get: (s) => s.gen.activity[key],
    set: (s, v) => {
      s.gen.activity[key] = v;
      s.analysis.weights[key] = v;
    },
  });
  return [
    // Density first: everything else is judged at the right density.
    g('peakNps', [4, 5, 6, 7, 8, 9, 10, 11, 12]),
    g('baseNps', [1.5, 2, 2.5, 3, 3.5, 4, 5]),
    g('burstNps', [9, 11, 13, 15, 18]),
    g('ceilingNps', [10, 12, 14, 16, 18, 24]),
    g('gamma', [0.6, 0.8, 1, 1.25, 1.5]),
    g('contrast', [0.3, 0.4, 0.5, 0.6, 0.7]),
    g('intenseThreshold', [0.4, 0.5, 0.55, 0.6, 0.7]),
    g('floorBeats', [0.5, 1, 1.5, 2]),
    g('maxGapBeats', [0.5, 1, 1.5, 2]),
    // Rhythm sources.
    ...['kick', 'snare', 'hats', 'bass', 'lead', 'other'].map((l) =>
      g(`layerWeights.${l}`, [0.1, 0.2, 0.35, 0.5, 0.7, 0.85, 1, 1.2, 1.4]),
    ),
    g('leadSensitivity', [0.4, 0.5, 0.6, 0.7, 0.8]),
    g('leadRunPriority', [0.5, 0.6, 0.7, 0.8, 0.9, 1]),
    g('secondaryAmount', [0.25, 0.35, 0.45, 0.55, 0.65]),
    g('quantStrictness', [0.3, 0.4, 0.5, 0.6, 0.7]),
    g('finestDivision', [2, 4, 8, 16]),
    g('oddGrids', [0, 0.2, 0.4, 0.6]),
    an('leadSensitivity', [0.5, 0.6, 0.7, 0.8]),
    an('minLeadIntervalMs', [30, 35, 40, 50, 60]),
    an('layerSensitivity', [0.4, 0.5, 0.6, 0.7]),
    // Activity.
    ...[
      'leadDensity',
      'drumDensity',
      'syncopation',
      'harmonicChange',
      'pitchLeaps',
      'lowPunch',
    ].map((k) => aw(k, [0, 0.05, 0.1, 0.18, 0.3, 0.4])),
    // Section roles.
    ...['intro', 'verse', 'build-up', 'drop', 'breakdown', 'outro'].map((r) =>
      g(`roles.${r}`, [0.7, 0.8, 0.9, 1, 1.1, 1.2]),
    ),
    // Holds.
    g('holdAmount', [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    g('shortHoldShare', [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
    g('minHoldBeats', [0.25, 0.5, 0.75, 1]),
    g('maxHoldBeats', [4, 8]),
    // Lanes (the score's lane part).
    g('chordRate', [0.3, 0.45, 0.6, 0.75, 0.9]),
    g('chordStrength', [0.4, 0.5, 0.6, 0.7]),
    g('jack', [0.15, 0.3, 0.45, 0.6, 0.75]),
    g('trill', [0.1, 0.2, 0.3, 0.5, 0.7]),
    g('stair', [0.3, 0.5, 0.7]),
    g('repeatLock', [0.6, 0.75, 0.85, 0.95]),
    g('variation', [0, 0.15, 0.25, 0.4]),
  ];
}

const cloneSetup = (s) => ({
  gen: P.cloneParams(s.gen),
  analysis: { ...s.analysis, weights: { ...s.analysis.weights } },
});

function score(s, setup, range, tuneSeeds) {
  return meanOf(evaluateSeeds(s, setup, range, tuneSeeds).map((r) => r.metrics.composite));
}

/** Coordinate ascent over the dimensions (two passes); improvements under 0.002 don't count. */
function coordinateAscent(s, start, range, label) {
  const tuneSeeds = [1, 2];
  let best = cloneSetup(start);
  let bestScore = score(s, best, range, tuneSeeds);
  console.log(`  ${label}: start ${f2(bestScore, 4)}`);
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (const d of dims()) {
      const current = d.get(best);
      let pick = current;
      let pickScore = bestScore;
      for (const v of d.values) {
        if (v === current) continue;
        const trial = cloneSetup(best);
        d.set(trial, v);
        const sc = score(s, trial, range, tuneSeeds);
        if (sc > pickScore + 0.002) {
          pick = v;
          pickScore = sc;
        }
      }
      if (pick !== current) {
        d.set(best, pick);
        bestScore = pickScore;
        improved = true;
        console.log(`    ${d.name} ${current} -> ${pick}: ${f2(bestScore, 4)}`);
      }
    }
    if (!improved) break;
  }
  return { setup: best, score: bestScore };
}

/** Halves on a bar line. */
function halves(s) {
  const barMs = (60000 / s.chart.bpm) * 4;
  const mid =
    s.chart.offsetMs + Math.round((s.features.durationMs / 2 - s.chart.offsetMs) / barMs) * barMs;
  return [
    { startMs: 0, endMs: Math.round(mid) },
    { startMs: Math.round(mid), endMs: s.features.durationMs },
  ];
}

// --- Report ------------------------------------------------------------------------------------

function summarize(runs) {
  const m = runs.map((r) => r.metrics);
  const avg = (fn) => meanOf(m.map(fn));
  const pk = runs.map((r) => peaks(r.result.notes, song.chart.bpm));
  return {
    composite: avg((x) => x.composite),
    f1: avg((x) => x.rhythm.f1),
    precision: avg((x) => x.rhythm.precision),
    recall: avg((x) => x.rhythm.recall),
    meanNps: avg((x) => x.density.genMeanNps),
    correlation: avg((x) => x.density.correlation),
    intenseCalm: avg((x) => x.density.genIntenseCalmRatio),
    calmMin: avg((x) => x.density.genCalmMinNps),
    calmP10: avg((x) => x.density.genCalmP10Nps),
    empty: avg((x) => x.density.emptyWhereRefHasNotes),
    gap: avg((x) => x.density.genLongestIntenseGapMs),
    peakNps: meanOf(pk.map((p) => p.peakNps)),
    p90Nps: meanOf(pk.map((p) => p.p90Nps)),
    burstNps: meanOf(pk.map((p) => p.burstNps)),
    leadRunRecall: avg((x) => x.layers.leadRuns.generatedRecall),
    fastRecall: avg((x) => x.layers.fastPassages.generatedRecall),
    holdsPerMin: avg((x) => x.holds.gen.perMinute),
    shortHolds: avg((x) => x.holds.gen.shortShare),
    holdMs: avg((x) => x.holds.gen.avgMs),
    layered: avg((x) => x.holds.gen.layeredShare),
    chord: avg((x) => x.lanes.gen.chordRate),
    jack: avg((x) => x.lanes.gen.jackRate),
    trill: avg((x) => x.lanes.gen.trillRate),
    stair: avg((x) => x.lanes.gen.stairRate),
    left: avg((x) => x.lanes.gen.leftShare),
    entropy: avg((x) => x.lanes.gen.transitionEntropy),
    repetition: avg((x) => x.repetition.gen.overall ?? NaN),
    scores: Object.fromEntries(
      Object.keys(M.SCORE_WEIGHTS).map((k) => [k, avg((x) => x.scores[k])]),
    ),
  };
}

function referenceSummary(metrics) {
  const pk = peaks(ref, song.chart.bpm);
  return {
    meanNps: metrics.density.refMeanNps,
    intenseCalm: metrics.density.refIntenseCalmRatio,
    calmMin: metrics.density.refCalmMinNps,
    gap: metrics.density.refLongestIntenseGapMs,
    peakNps: pk.peakNps,
    p90Nps: pk.p90Nps,
    burstNps: pk.burstNps,
    holdsPerMin: metrics.holds.ref.perMinute,
    shortHolds: metrics.holds.ref.shortShare,
    holdMs: metrics.holds.ref.avgMs,
    layered: metrics.holds.ref.layeredShare,
    chord: metrics.lanes.ref.chordRate,
    jack: metrics.lanes.ref.jackRate,
    trill: metrics.lanes.ref.trillRate,
    stair: metrics.lanes.ref.stairRate,
    left: metrics.lanes.ref.leftShare,
    entropy: metrics.lanes.ref.transitionEntropy,
    repetition: metrics.repetition.ref.overall ?? NaN,
  };
}

const ROWS = [
  ['Composite score', 'composite', (x) => f2(x, 3)],
  ['Rhythm F1 (+/-35 ms)', 'f1', pct],
  ['Precision', 'precision', pct],
  ['Recall', 'recall', pct],
  ['Mean nps (2-beat windows)', 'meanNps', f2],
  ['Peak nps (densest 4 beats)', 'peakNps', f2],
  ['90th pct of 4-beat windows, nps', 'p90Nps', f2],
  ['Burst nps (densest beat)', 'burstNps', f2],
  ['Density correlation', 'correlation', f2],
  ['Intense / calm density', 'intenseCalm', f2],
  ['Calm minimum nps', 'calmMin', f2],
  ['Calm 10th pct nps', 'calmP10', f2],
  ['Empty where reference has notes', 'empty', pct],
  ['Longest gap in intense parts, ms', 'gap', (x) => f2(x, 0)],
  ['Recall in lead runs', 'leadRunRecall', pct],
  ['Recall in fast passages', 'fastRecall', pct],
  ['Holds per minute', 'holdsPerMin', (x) => f2(x, 1)],
  ['Short holds (< 1 beat)', 'shortHolds', pct],
  ['Average hold, ms', 'holdMs', (x) => f2(x, 0)],
  ['Layered holds', 'layered', pct],
  ['Chord rate', 'chord', pct],
  ['Jack rate', 'jack', pct],
  ['Trill rate', 'trill', pct],
  ['Stair rate', 'stair', pct],
  ['Left hand', 'left', pct],
  ['Transition entropy, bits', 'entropy', f2],
  ['Repeat consistency', 'repetition', pct],
];

function table(columns) {
  const head = `| Metric | ${columns.map((c) => c.title).join(' | ')} |`;
  const sep = `| --- | ${columns.map(() => '---').join(' | ')} |`;
  const lines = [head, sep];
  for (const [label, key, fmt] of ROWS) {
    lines.push(
      `| ${label} | ${columns.map((c) => (c.values[key] === undefined ? '-' : fmt(c.values[key]))).join(' | ')} |`,
    );
  }
  return lines;
}

function layerLines(m) {
  const L2 = m.layers;
  const lines = [];
  lines.push(
    `Reference hits (notes within 20 ms merged): ${L2.hits}. A clear candidate (strength 0.5+) ` +
      `within 25 ms explains ${pct(L2.explained)}; chance level (the reference shifted 3/8 of a ` +
      `beat) is ${pct(L2.explainedByChance)}. Any candidate within 35 ms: ${pct(L2.explainedLoose)}. ` +
      `Unexplained: ${L2.missCount} hits.`,
  );
  lines.push('');
  lines.push(
    '| Layer | Explains (strongest layer) | Clear onset at reference hits | Clear onset on the 1/8 grid | Lift |',
  );
  lines.push('| --- | --- | --- | --- | --- |');
  for (const l of ['lead', 'snare', 'kick', 'bass', 'hats', 'other']) {
    lines.push(
      `| ${l} | ${pct(L2.primaryShare[l])} | ${pct(L2.anyShare[l])} | ${pct(L2.gridShare[l])} | ${f2(L2.lift[l])} |`,
    );
  }
  lines.push('');
  const lr = L2.leadRuns;
  lines.push(
    `Detected lead runs: ${lr.runs} runs with ${lr.runOnsets} lead onsets; the reference charts ` +
      `${pct(lr.refChartsOnsets)} of those onsets, the generated chart ${pct(lr.genChartsOnsets)}. ` +
      `Reference hits inside runs: ${lr.refHits}; lead onsets explain ${pct(lr.leadRecall)}, any ` +
      `clear onset ${pct(lr.anyRecall)}, generated notes ${pct(lr.generatedRecall)}.`,
  );
  lines.push(
    `Reference fast passages (4+ hits at most a third of a beat apart): ` +
      `${L2.fastPassages.passages} passages, ${L2.fastPassages.refHits} hits; lead onsets explain ` +
      `${pct(L2.fastPassages.leadRecall)}, any clear onset ${pct(L2.fastPassages.anyRecall)}, ` +
      `generated notes ${pct(L2.fastPassages.generatedRecall)}.`,
  );
  return lines;
}

function missLines(m, limit = 40) {
  const byContext = new Map();
  for (const g of m.layers.misses)
    byContext.set(g.context, (byContext.get(g.context) ?? 0) + g.count);
  const lines = ['| Context | Missed hits |', '| --- | --- |'];
  for (const [c, n] of [...byContext.entries()].sort((x, y) => y[1] - x[1]))
    lines.push(`| ${c} | ${n} |`);
  lines.push('');
  lines.push('| Where | Hits | Section | Context | Loudest band |');
  lines.push('| --- | --- | --- | --- | --- |');
  const groups = [...m.layers.misses].sort((x, y) => y.count - x.count).slice(0, limit);
  groups.sort((x, y) => x.startMs - y.startMs);
  for (const g of groups) {
    const where = g.count > 1 ? `${ts(g.startMs)}-${ts(g.endMs)}` : ts(g.startMs);
    lines.push(`| ${where} | ${g.count} | ${g.role} | ${g.context} | ${g.band} |`);
  }
  if (m.layers.misses.length > limit) {
    lines.push('');
    lines.push(`(${m.layers.misses.length - limit} smaller groups not listed.)`);
  }
  return lines;
}

// --- Run ---------------------------------------------------------------------------------------

const fromSetup = option('from') ? JSON.parse(readFileSync(option('from'), 'utf8')).merged : null;
const setupOf = (d) =>
  fromSetup && d === difficulty
    ? cloneSetup(fromSetup)
    : {
        gen: P.presetParams(d),
        analysis: cloneSetup({ gen: P.presetParams(d), analysis: baseAnalysisParams }).analysis,
      };

console.log(
  `Reference: ${basename(song.chartFile)} (${song.chart.difficulty}, ${ref.length} notes, ` +
    `${song.chart.bpm} BPM, offset ${song.chart.offsetMs} ms) on ${basename(song.audio)}.`,
);
const out = {
  reference: `${song.chart.difficulty} chart, ${song.chart.bpm} BPM, ${ref.length} notes`,
  seeds,
  difficulties: {},
};
const doc = [];

if (flag('tune')) {
  console.log(`\nTuning ${difficulty} (coordinate ascent, seeds 1-2 per evaluation):`);
  const [h1, h2] = halves(song);
  const start = setupOf(difficulty);
  const fitA = coordinateAscent(song, start, h1, 'fit on the first half');
  const fitB = coordinateAscent(song, start, h2, 'fit on the second half');
  const valA = score(song, fitA.setup, h2, [1, 2, 3]);
  const valB = score(song, fitB.setup, h1, [1, 2, 3]);
  const baseH2 = score(song, start, h2, [1, 2, 3]);
  const baseH1 = score(song, start, h1, [1, 2, 3]);
  // Conservative merge: per dimension, the grid value nearest the mean of the two fits.
  const merged = cloneSetup(start);
  const changes = [];
  for (const d of dims()) {
    const a = d.get(fitA.setup);
    const b = d.get(fitB.setup);
    const target = (a + b) / 2;
    const v = d.values.reduce(
      (best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best),
      d.values[0],
    );
    const now = d.get(start);
    const pick = a === now && b === now ? now : v;
    if (pick !== now) changes.push({ name: d.name, from: now, fitA: a, fitB: b, merged: pick });
    d.set(merged, pick);
  }
  const fullBase = score(song, start, fullRange(song), seeds);
  const fullMerged = score(song, merged, fullRange(song), seeds);
  const tuneLines = [
    `| Fit on | Score on fit half | Validation half: before | Validation half: after |`,
    `| --- | --- | --- | --- |`,
    `| First half | ${f2(fitA.score, 3)} | ${f2(baseH2, 3)} | ${f2(valA, 3)} |`,
    `| Second half | ${f2(fitB.score, 3)} | ${f2(baseH1, 3)} | ${f2(valB, 3)} |`,
    '',
    `Whole song, seeds 1-${seedCount}: ${f2(fullBase, 3)} before, ${f2(fullMerged, 3)} with the merged values.`,
    '',
    '| Parameter | Before | Fit (first half) | Fit (second half) | Merged |',
    '| --- | --- | --- | --- | --- |',
    ...changes.map((c) => `| ${c.name} | ${c.from} | ${c.fitA} | ${c.fitB} | ${c.merged} |`),
  ];
  console.log('\n' + tuneLines.join('\n'));
  writeFileSync(
    option('tune-out') ?? 'reference/.tuned-setup.json',
    JSON.stringify({ changes, merged }, null, 2),
  );
  console.log(`Wrote ${option('tune-out') ?? 'reference/.tuned-setup.json'} (local only).`);
  out.tuning = {
    fitA: fitA.score,
    fitB: fitB.score,
    valA,
    valB,
    baseH1,
    baseH2,
    fullBase,
    fullMerged,
    changes,
  };
  doc.push('### Parameter search', '', ...tuneLines, '');
}

const difficulties = flag('all') ? P.DIFFICULTIES : [difficulty];
const columns = [];
let refColumn = null;
let mainMetrics = null;
for (const d of difficulties) {
  const runs = evaluateSeeds(song, setupOf(d), fullRange(song), seeds);
  const sum = summarize(runs);
  out.difficulties[d] = {
    summary: sum,
    seeds: runs.map((r) => ({
      seed: r.seed,
      composite: r.metrics.composite,
      f1: r.metrics.rhythm.f1,
    })),
  };
  columns.push({ title: `${d} (mean of ${seeds.length} seeds)`, values: sum });
  if (d === difficulty) {
    mainMetrics = runs[0].metrics;
    refColumn = {
      title: `Reference (${song.chart.difficulty})`,
      values: {
        ...referenceSummary(mainMetrics),
        f1: 1,
        precision: 1,
        recall: 1,
        correlation: 1,
        composite: undefined,
        empty: 0,
        calmP10: undefined,
        leadRunRecall: mainMetrics.layers.leadRuns.leadRecall,
        fastRecall: mainMetrics.layers.fastPassages.leadRecall,
      },
    };
  }
  console.log(
    `${d}: composite ${f2(sum.composite, 3)}, F1 ${pct(sum.f1)} (P ${pct(sum.precision)}, R ${pct(sum.recall)}), ` +
      `${f2(sum.meanNps)} nps, peak ${f2(sum.peakNps)}, burst ${f2(sum.burstNps)}, r ${f2(sum.correlation)}`,
  );
}
const ordered = refColumn ? [refColumn, ...columns] : columns;
const mainTable = table(ordered);
const hardSum = out.difficulties.Hard?.summary;
const expertSum = out.difficulties.Expert?.summary;
if (hardSum && expertSum) {
  const ratioLine =
    `Expert over Hard (measured): mean ${f2(expertSum.meanNps / hardSum.meanNps)}x, ` +
    `4-beat peak ${f2(expertSum.peakNps / hardSum.peakNps)}x, 4-beat 90th percentile ` +
    `${f2(expertSum.p90Nps / hardSum.p90Nps)}x, one-beat burst ` +
    `${f2(expertSum.burstNps / hardSum.burstNps)}x, chords ${pct(hardSum.chord)} -> ${pct(expertSum.chord)}, ` +
    `longest intense gap ${f2(hardSum.gap, 0)} -> ${f2(expertSum.gap, 0)} ms, lead-run recall ` +
    `${pct(hardSum.leadRunRecall)} -> ${pct(expertSum.leadRunRecall)}.`;
  mainTable.push('', ratioLine);
}
console.log('\n' + mainTable.join('\n'));
console.log(
  '\n(Reference column: lead-run and fast-passage rows show the share lead onsets explain, i.e. the analyzer recall.)',
);
const scoreLines = [
  '| Score part | Weight | ' + columns.map((c) => c.title).join(' | ') + ' |',
  '| --- | --- | ' + columns.map(() => '---').join(' | ') + ' |',
  ...Object.entries(M.SCORE_WEIGHTS).map(
    ([k, w]) => `| ${k} | ${w} | ${columns.map((c) => f2(c.values.scores[k], 3)).join(' | ')} |`,
  ),
];
console.log('\n' + scoreLines.join('\n'));
const layers = layerLines(mainMetrics);
const misses = missLines(mainMetrics);
console.log('\n' + layers.join('\n'));
console.log('\n' + misses.join('\n'));
out.layers = mainMetrics.layers;
out.repetition = { reference: mainMetrics.repetition.ref, generated: mainMetrics.repetition.gen };

// Sanity check on a second song (never fitted).
const sanityAt = args.indexOf('--sanity');
if (sanityAt >= 0 && args[sanityAt + 1] && args[sanityAt + 2]) {
  const s2 = await loadSong(args[sanityAt + 1], args[sanityAt + 2]);
  const d2 = P.DIFFICULTIES.find((d) => d === s2.chart.difficulty) ?? 'Normal';
  const runs = evaluateSeeds(s2, setupOf(d2), fullRange(s2), seeds);
  const sum = summarize(runs);
  const lines = [
    `Sanity check: ${basename(s2.chartFile)} (${s2.chart.difficulty}) with the ${d2} preset: ` +
      `composite ${f2(sum.composite, 3)}, F1 ${pct(sum.f1)}, ${f2(sum.meanNps)} nps ` +
      `(reference ${f2(runs[0].metrics.density.refMeanNps)}), r ${f2(sum.correlation)}.`,
  ];
  console.log('\n' + lines.join('\n'));
  out.sanity = sum;
  doc.push('### Sanity check (not fitted)', '', ...lines, '');
}

writeFileSync(jsonPath, JSON.stringify(out, null, 2) + '\n');
console.log(`\nWrote ${jsonPath}.`);

if (writeDoc) {
  const generated = [
    '<!-- calibration:begin (generated by npm run calibrate; edit outside these markers) -->',
    '',
    `Reference: **${song.chart.difficulty}** chart of a ${Math.round(song.features.durationMs / 1000)} s ` +
      `song at ${song.chart.bpm} BPM, ${ref.length} notes. Seeds 1-${seedCount}, tolerance 35 ms.`,
    '',
    '### Results',
    '',
    ...mainTable,
    '',
    'Reference column: the lead-run and fast-passage rows show the share that lead onsets ' +
      'explain (the analyzer recall), not a generated recall.',
    '',
    '### Composite score parts',
    '',
    ...scoreLines,
    '',
    '### Layer attribution',
    '',
    ...layers,
    '',
    '### What the analyzer misses',
    '',
    ...misses,
    '',
    ...doc,
    '<!-- calibration:end -->',
  ].join('\n');
  const current = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '# Charting calibration\n';
  const re = /<!-- calibration:begin[\s\S]*?<!-- calibration:end -->/;
  const next = re.test(current)
    ? current.replace(re, generated)
    : `${current.trimEnd()}\n\n${generated}\n`;
  writeFileSync(docPath, next);
  console.log(`Updated ${docPath}.`);
}
