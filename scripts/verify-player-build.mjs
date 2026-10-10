// Checks that the player build (dist/, from `npm run build`) contains no Studio code.
// Run through `npm run verify:player-build`, which builds first. Exits non-zero on failure.
//
// It looks for:
// - the marker constants STUDIO_MARKER (src/studio/index.ts) and EDITOR_HELP_MARKER (the
//   editor's help text, src/studio/editor/shortcuts.ts), read from the sources so they can't
//   drift;
// - fingerprints of editor code (strings that only the editor and its workers use);
// - emitted files that look like editor workers (the audio analysis worker in src/audio and the
//   background bake worker in src/render/background are shared: the player's backgrounds use
//   them).
// Every fingerprint must also exist in src/studio, so a renamed string can't make the check pass
// by accident.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const studioDir = join(root, 'src', 'studio');

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

function constantValue(file, name) {
  const text = readFileSync(join(root, file), 'utf8');
  const match = text.match(new RegExp(`export const ${name} = '([^']+)'`));
  if (!match) throw new Error(`Could not find the ${name} constant in ${file}.`);
  return match[1];
}

const markers = [
  constantValue('src/studio/index.ts', 'STUDIO_MARKER'),
  constantValue('src/studio/editor/shortcuts.ts', 'EDITOR_HELP_MARKER'),
];

/** Strings only editor code contains (class names, UI text, storage keys). */
const editorFingerprints = [
  'editor-timeline',
  'editor-overview',
  'editor-help',
  'Editor shortcuts',
  'editor-prefs',
  'Suggest notes',
  'Detect BPM',
  'Duplicate chart',
  'Import audio',
  'Export package',
  // The background editor (Phase 21): the player can show backgrounds but never edit them.
  'Edit background',
  'Add pictures',
  'Add emitter',
  'Draw a sprite',
  'Save to this song',
  'bg-emitter-head',
  // The analysis viewer and ChartAnalysis (Phase 17).
  'Export analysis JSON',
  'editor-analysis-panel',
  'ataraxia-chart-analysis',
];

/** Worker entry files the player is allowed to ship (they must live outside src/studio). */
const sharedWorkerFiles = ['src/audio/analysisWorker.ts', 'src/render/background/bakeWorker.ts'];
const sharedWorkers = sharedWorkerFiles.map((f) => f.split('/').at(-1).replace(/\.ts$/, ''));
for (const file of sharedWorkerFiles) {
  if (!existsSync(join(root, file))) {
    console.error(`verify-player-build: the shared worker ${file} is missing; update this script.`);
    process.exit(2);
  }
}

const studioSources = filesUnder(studioDir)
  .filter((f) => /\.(ts|css)$/.test(f))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
for (const s of [...markers, ...editorFingerprints]) {
  if (!studioSources.includes(s)) {
    console.error(
      `verify-player-build: "${s}" no longer appears in src/studio; update this script.`,
    );
    process.exit(2);
  }
}

if (!existsSync(dist)) {
  console.error('verify-player-build: dist/ is missing. Run `npm run build` first.');
  process.exit(2);
}

const problems = [];
const files = filesUnder(dist);
for (const file of files) {
  const rel = relative(root, file).replaceAll('\\', '/');
  if (/worker/i.test(rel) && !sharedWorkers.some((w) => rel.includes(w))) {
    problems.push(`${rel}: looks like an editor worker file`);
  }
  if (!/\.(js|mjs|css|html|json|svg|map|txt)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const marker of markers) {
    if (text.includes(marker)) problems.push(`${rel}: contains the Studio marker "${marker}"`);
  }
  for (const s of editorFingerprints) {
    if (text.includes(s)) problems.push(`${rel}: contains editor code ("${s}")`);
  }
}

if (problems.length > 0) {
  console.error('verify-player-build: Studio code found in the player build:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `verify-player-build: OK. ${files.length} files in dist/ checked; no Studio markers or editor code.`,
);
