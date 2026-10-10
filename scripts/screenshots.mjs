// Captures every menu screen (player and Studio) at 1280x720, 1920x1080 and a narrow window into
// docs/screenshots/ (gitignored), plus button state close-ups, for visual review; then gameplay
// (dev `?autoplay`, so the input is deterministic) at 1920x1080, 3840x2160 and 1366x768 with the
// pause overlay, practice HUD, timing particles at each threshold, minimal effects, the results
// screen and a frame-rate check on the dense `?stress` chart; then the chart editor (Studio, dev
// `?editorChart=sample|empty`) at 1920x1080 and 1366x768 with menus, tooltips, the cheat sheet,
// the quick-start card, the pre-song region and a frame-rate check while wheel scrolling.
// Then the gameplay backgrounds (Phase 21) behind the playfield on the demo song at 1920x1080 over
// a bright picture: each baked adjustment alone, all of them together, the particle templates and
// a custom drawn sprite, the cover (blurred) and its fallback, the song default, Off, the Display
// settings, the Studio background editor and sprite editor, and the timing at 4K.
// Gameplay feel (Phase 22, dev `?autoplay`, `?combo=N` adds N to the shown combo) at 1920x1080
// and 1366x768: a normal moment, the combo in each colour tier, a perfect popup, the lane glow
// mid-decay, the simple judgement style and the three HUD sizes.
// Usage: npm run screenshots              (needs `npx playwright install chromium` once)
//        npm run screenshots -- --gameplay   (gameplay only)
//        npm run screenshots -- --feel       (gameplay feel only)
//        npm run screenshots -- --editor     (editor only)
//        npm run screenshots -- --backgrounds (backgrounds only)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'docs', 'screenshots');
const SIZES = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: 'narrow-480x860', width: 480, height: 860 },
];

/** A plausible finished play for the results screen. */
const RESULT = {
  score: 912_480,
  accuracy: 96.42,
  rank: 'S',
  maxCombo: 412,
  totalNotes: 436,
  counts: { perfect: 371, great: 49, good: 12, miss: 4 },
  drops: 1,
  early: 31,
  late: 34,
  histogram: {
    minMs: -120,
    maxMs: 120,
    binMs: 10,
    bins: [0, 0, 1, 2, 3, 6, 11, 19, 33, 58, 81, 92, 88, 64, 40, 21, 11, 4, 2, 1, 0, 0, 0, 0],
    outside: 4,
    averageMs: 3.4,
    count: 432,
  },
  badges: { fullCombo: false, allPerfect: false },
};

const server = await createServer({
  root,
  server: { port: 5199, strictPort: false },
  logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls?.local[0] ?? 'http://localhost:5199/';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const gameplayOnly = process.argv.includes('--gameplay');
const editorOnly = process.argv.includes('--editor');
const backgroundsOnly = process.argv.includes('--backgrounds');
const feelOnly = process.argv.includes('--feel');
const EDITOR_SIZES = [
  { name: 'editor-1920x1080', width: 1920, height: 1080 },
  { name: 'editor-1366x768', width: 1366, height: 768 },
];
const DEMO = { songId: 'builtin:demo', chartId: 'builtin:demo:normal' };
const GAME_SIZES = [
  { name: 'game-1920x1080', width: 1920, height: 1080 },
  { name: 'game-3840x2160', width: 3840, height: 2160 },
  { name: 'game-1366x768', width: 1366, height: 768 },
];

async function shoot(page, dir, name) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

const go = (page, scene, params) =>
  page.evaluate(([s, p]) => window.__ataraxia.scenes.goTo(s, p), [scene, params]);

/** Open the dev server with a query, wait for the app, apply settings. */
async function openApp(context, query, settings = {}) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('page error:', err.message));
  await page.goto(`${url}${query}`);
  await page.waitForFunction(() => window.__ataraxia !== undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((s) => window.__ataraxia.settings.update(s), {
    earlyLateIndicator: true,
    timingParticles: true,
    timingParticleThresholdMs: 40,
    effects: 'full',
    ...settings,
  });
  return page;
}

/** Start a song at `startTimeMs` (after the run-in) and let it play for `playMs`. */
async function playFrom(page, startTimeMs, playMs, mode = 'play') {
  await go(page, 'game', { mode, ...DEMO, startTimeMs });
  await page.waitForTimeout(900);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500 + playMs);
}

async function gameplay() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  for (const size of GAME_SIZES.filter((g) => !only || g.name.includes(only))) {
    const dir = join(outDir, size.name);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
    });
    let page = await openApp(context, '?autoplay');
    await playFrom(page, 30_000, 2600);
    await page.screenshot({ path: join(dir, '20-gameplay-holds.png') });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: join(dir, '21-gameplay-stream.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(dir, '22-pause.png') });
    await page.close();

    // Timing particles at each threshold (fixed jitter pattern).
    for (const [name, ms] of [
      ['all', 0],
      ['beyond-perfect', 40],
      ['beyond-great', 80],
    ]) {
      page = await openApp(context, '?autoplay=jitter', { timingParticleThresholdMs: ms });
      await playFrom(page, 36_000, 2200);
      await page.screenshot({ path: join(dir, `23-particles-${name}.png`) });
      await page.close();
    }
    page = await openApp(context, '?autoplay=jitter', {
      timingParticleThresholdMs: 0,
      timingParticleSize: 'large',
      effects: 'minimal',
    });
    await playFrom(page, 20_000, 2000);
    await page.screenshot({ path: join(dir, '24-minimal-large-particles.png') });
    await page.close();

    // Practice: loop markers on the progress bar and the practice panel.
    page = await openApp(context, '?autoplay');
    await playFrom(page, 12_000, 600, 'practice');
    await page.keyboard.press('BracketLeft');
    await page.waitForTimeout(1200);
    await page.keyboard.press('BracketRight');
    await page.keyboard.press('Minus');
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(dir, '25-practice.png') });
    await page.close();

    page = await openApp(context, '');
    await go(page, 'results', {
      game: { mode: 'play', ...DEMO },
      result: RESULT,
      chartInfo: { title: 'Still Water', artist: 'ataraxia', difficulty: 'Hard', level: 12 },
      save: false,
    });
    await shoot(page, dir, '26-results');
    await page.close();

    // Frame rate on the dense stress chart.
    page = await openApp(context, '?autoplay&stress');
    await playFrom(page, 20_000, 500);
    const fps = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const times = [];
          const tick = (t) => {
            times.push(t);
            if (times.length < 240) requestAnimationFrame(tick);
            else {
              const gaps = times.slice(1).map((v, i) => v - times[i]);
              const avg = (times.at(-1) - times[0]) / gaps.length;
              resolve({ fps: 1000 / avg, worstMs: Math.max(...gaps) });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.screenshot({ path: join(dir, '27-stress.png') });
    console.log(
      `[${size.name}] stress chart: ${fps.fps.toFixed(1)} fps, worst frame ${fps.worstMs.toFixed(1)} ms`,
    );
    await page.close();
    await context.close();
  }
}

/** Combo tiers to capture: the forced boost (the run adds a few hits on top). */
const COMBO_SHOTS = [
  ['0-steel', 0],
  ['1-cyan', 26],
  ['2-green', 52],
  ['3-gold', 110],
  ['4-orange', 210],
  ['5-magenta', 320],
  ['6-rainbow', 520],
  ['7-rainbow-sparkle', 1020],
];

/** Phase 22: lane glow, judgement text, combo tiers and the score at two window sizes. */
async function feel() {
  for (const size of GAME_SIZES.filter((g) => !g.name.includes('3840'))) {
    const dir = join(outDir, size.name);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
    });
    let page = await openApp(context, '?autoplay');
    await playFrom(page, 30_000, 1800);
    await page.screenshot({ path: join(dir, '30-feel-normal.png') });
    // A burst of frames: one of them catches a perfect mid-pop (and the shine sweep).
    for (let i = 0; i < 4; i++) {
      await page.screenshot({ path: join(dir, `31-feel-perfect-${i}.png`) });
      await page.waitForTimeout(37);
    }
    // Lane glow: a real key press on top of autoplay, captured during its decay.
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(60);
    await page.screenshot({ path: join(dir, '32-feel-lane-glow.png') });
    await page.keyboard.up('KeyS');
    await page.close();

    for (const [name, boost] of COMBO_SHOTS) {
      page = await openApp(context, `?autoplay&combo=${boost}`);
      await playFrom(page, 30_000, 1400);
      await page.screenshot({ path: join(dir, `33-combo-${name}.png`) });
      await page.close();
    }
    // A dense chart at a rainbow combo: the shine and the sweep stay steady whatever is hit.
    page = await openApp(context, '?autoplay&stress&combo=520');
    await playFrom(page, 20_000, 2600);
    await page.screenshot({ path: join(dir, '37-combo-hot.png') });
    await page.close();
    // Minimal effects: the rainbow is still gold; the simple judgement style.
    page = await openApp(context, '?autoplay&combo=520', { effects: 'minimal' });
    await playFrom(page, 30_000, 1400);
    await page.screenshot({ path: join(dir, '34-minimal-rainbow.png') });
    await page.close();
    page = await openApp(context, '?autoplay', { judgementStyle: 'simple' });
    await playFrom(page, 30_000, 1400);
    await page.screenshot({ path: join(dir, '35-judgement-simple.png') });
    await page.close();
    for (const hud of ['medium', 'small']) {
      page = await openApp(context, '?autoplay', { hudSize: hud });
      await playFrom(page, 30_000, 1200);
      await page.screenshot({ path: join(dir, `36-hud-${hud}.png`) });
      await page.close();
    }
    await context.close();
  }
}

/** Frames per second (and the worst frame) over `count` animation frames while `during` runs. */
async function measureFrames(page, count, during) {
  const result = page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const times = [];
        const tick = (t) => {
          times.push(t);
          if (times.length < n) requestAnimationFrame(tick);
          else {
            const gaps = times.slice(1).map((v, i) => v - times[i]);
            resolve({
              fps: (1000 * gaps.length) / (times.at(-1) - times[0]),
              worstMs: Math.max(...gaps),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    count,
  );
  await during();
  return result;
}

async function editor() {
  for (const size of EDITOR_SIZES) {
    const dir = join(outDir, size.name);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
    });
    const open = async (chart) => {
      const page = await openApp(context, `?editorChart=${chart}`);
      await page.evaluate(() => localStorage.removeItem('ataraxia.editor-quickstart-dismissed'));
      await go(page, 'editor', DEMO);
      await page.waitForSelector('.editor-timeline');
      await page.waitForTimeout(900);
      return page;
    };
    let page = await open('sample');
    const timeline = await page.locator('.editor-timeline').boundingBox();
    const centre = { x: timeline.x + timeline.width / 2, y: timeline.y + timeline.height / 2 };
    // Measure 9 in, a hold and a stream on screen.
    for (let i = 0; i < 8; i++) await page.keyboard.press('PageUp');
    await page.mouse.move(5, timeline.y + 40);
    await shoot(page, dir, '30-editor');

    await page.hover('.editor-rail-tool >> nth=0');
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(dir, '31-editor-tooltip.png') });
    await page.mouse.move(centre.x, centre.y);

    await page.click('.editor-transport .editor-menu-wrap:last-child > button');
    await shoot(page, dir, '32-editor-more-menu');
    await page.keyboard.press('Escape');
    await page.click('.editor-top .editor-menu-trigger');
    await shoot(page, dir, '33-editor-export-menu');
    await page.keyboard.press('Escape');

    // A box of selected notes: the Selection section appears.
    await page.keyboard.press('KeyS');
    await page.mouse.move(centre.x - 200, centre.y - 160);
    await page.mouse.down();
    await page.mouse.move(centre.x + 200, centre.y + 40, { steps: 6 });
    await page.mouse.up();
    await page.mouse.move(5, centre.y);
    await shoot(page, dir, '34-editor-selection');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Shift+Slash');
    await shoot(page, dir, '35-editor-help');
    await page.keyboard.press('Escape');

    // Zoomed in with Ctrl+wheel, then the region before the song.
    await page.mouse.move(centre.x, centre.y);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
    }
    await shoot(page, dir, '36-editor-zoomed');
    await page.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 100);
    await shoot(page, dir, '37-editor-before-song');

    // Frame rate while wheel scrolling continuously.
    const fps = await measureFrames(page, 180, async () => {
      for (let i = 0; i < 90; i++) {
        await page.mouse.wheel(0, i < 45 ? -100 : 100);
        await page.waitForTimeout(16);
      }
    });
    console.log(
      `[${size.name}] editor wheel scroll: ${fps.fps.toFixed(1)} fps, worst frame ${fps.worstMs.toFixed(1)} ms`,
    );
    await page.close();

    page = await open('empty');
    await shoot(page, dir, '38-editor-quickstart');
    await page.close();
    await context.close();
  }
}

/** A bright test picture (sky and sun), made in the page and stored as the custom background. */
async function setBrightPicture(page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 900;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 900);
    sky.addColorStop(0, '#fff8e0');
    sky.addColorStop(0.6, '#ffd27a');
    sky.addColorStop(1, '#ff9a5a');
    g.fillStyle = sky;
    g.fillRect(0, 0, 1600, 900);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(800, 380, 200, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#7ac4ff';
    for (let i = 0; i < 9; i++) g.fillRect(i * 190, 700 - (i % 3) * 60, 120, 400);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await window.__ataraxia.library.setPlayerBackground(blob, 'bright.png');
  });
}

/** Store the demo song's audio as a WAV song in the library (for Studio screens); its id. */
async function addTestSong(page) {
  return page.evaluate(async () => {
    const app = window.__ataraxia;
    const buffer = await app.library.loadAudio('builtin:demo');
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    const bytes = new ArrayBuffer(44 + data.length * 2);
    const v = new DataView(bytes);
    const text = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    v.setUint32(4, 36 + data.length * 2, true);
    text(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    text(36, 'data');
    v.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) {
      v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 32767, true);
    }
    const song = await app.library.requireRepo().createSong({
      title: 'Still Water',
      artist: 'ataraxia',
      audio: new Blob([bytes], { type: 'audio/wav' }),
      audioFileName: 'still-water.wav',
      durationMs: Math.round(buffer.duration * 1000),
      bpm: 120,
      offsetMs: 0,
      previewStartMs: 20000,
    });
    return song.id;
  });
}

/** Average time per frame and the background's quality while a song plays. */
async function backgroundTiming(page, frames = 240) {
  return page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const times = [];
        const tick = (t) => {
          times.push(t);
          if (times.length < n) requestAnimationFrame(tick);
          else {
            const gaps = times.slice(1).map((v, i) => v - times[i]);
            resolve({
              fps: (1000 * gaps.length) / (times.at(-1) - times[0]),
              worstMs: Math.max(...gaps),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

/**
 * Show a background built in the page (dev only), over the bright custom picture as the base:
 * `spec.base` (image, cover, solid, none), `spec.effects` (baked adjustments), `spec.emitters`
 * (template ids, or [template, overrides] pairs) and `spec.sprite` (a custom sprite drawn in the
 * page, used by emitters with sprite 'custom:drawn').
 */
async function setBackgroundOverride(page, spec) {
  await page.evaluate(async (sp) => {
    const t = window.__ataraxiaBackgroundTools;
    const c = t.defaultBackgroundConfig(sp.base ?? 'image');
    c.base.pixelMatch = sp.pixelMatch ?? true;
    if (sp.dim !== undefined) c.base.dim = sp.dim;
    Object.assign(c.effects, sp.effects ?? {});
    c.emitters = (sp.emitters ?? []).map((e, i) => {
      const [id, extra] = Array.isArray(e) ? e : [e, {}];
      return { ...t.emitterFromTemplate(id, `e${i + 1}`, 7 + i * 13), ...extra };
    });
    window.__ataraxiaBackgroundOverride = c;
    if (sp.sprite) {
      // A small original pixel sprite: a four-leaf clover, white with two shades.
      const rows = [
        '..2222..2222..',
        '.233332233332.',
        '.233333333332.',
        '.233333333332.',
        '..2333333332..',
        '22223333332222',
        '23333311333332',
        '23333311333332',
        '22223333332222',
        '..2333333332..',
        '.233333333332.',
        '.233332233332.',
        '..2222.12222..',
        '.......1......',
      ];
      const cv = document.createElement('canvas');
      cv.width = 14;
      cv.height = 14;
      const g = cv.getContext('2d');
      rows.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          if (ch === '.') return;
          g.fillStyle = ch === '3' ? '#ffffff' : ch === '2' ? '#c8c8c8' : '#808080';
          g.fillRect(x, y, 1, 1);
        }),
      );
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      window.__ataraxiaBackgroundSprites = [{ id: 'drawn', name: 'Clover', blob }];
    }
  }, spec);
}

/** Wait until the background has baked its picture. */
async function waitForBake(page, label = '') {
  await page
    .waitForFunction(() => window.__ataraxiaBackground?.()?.baking === false, null, {
      timeout: 20_000,
    })
    .catch(() => console.warn(`the background bake did not finish in time ${label}`));
}

/** Each baked adjustment alone (strong, to judge it), then all of them together. */
const EFFECT_SHOTS = [
  ['blur', { blur: 24 }],
  ['exposure-up', { exposure: 0.8 }],
  ['exposure-down', { exposure: -0.8 }],
  ['saturation', { saturation: 1.8 }],
  ['chromatic-radial', { chromatic: 12 }],
  ['chromatic-horizontal', { chromatic: 10, chromaticMode: 'horizontal' }],
  ['bloom', { bloom: 1.4, bloomThreshold: 0.55, bloomRadius: 0.7 }],
  [
    'all',
    {
      blur: 6,
      exposure: 0.3,
      saturation: 1.4,
      chromatic: 5,
      bloom: 1,
      bloomThreshold: 0.6,
      bloomRadius: 0.6,
    },
  ],
];

const EMITTER_SHOTS = [
  ['dust', ['dust']],
  ['embers', ['embers']],
  ['petals', ['petals']],
  ['sparks', ['sparks']],
  ['custom-sprite', [['dust', { sprite: 'custom:drawn', sizeMin: 10, sizeMax: 16, count: 50 }]]],
  ['three-emitters', ['dust', 'embers', 'sparks']],
];

async function backgrounds() {
  const dir = join(outDir, 'backgrounds-1920x1080');
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // A bright custom picture is the base of every shot: notes must stay readable on it.
  let page = await openApp(context, '?autoplay', { backgroundMode: 'song' });
  await setBrightPicture(page);
  await page.close();
  // Demo song: bars 18-21 are the dense stream (the drop of the demo).
  const shot = async (name, spec, at = 37_000) => {
    const p = await openApp(context, '?autoplay', { backgroundMode: 'song' });
    await setBackgroundOverride(p, spec);
    await playFrom(p, at, 1800);
    await waitForBake(p, name);
    await p.waitForTimeout(200);
    await p.screenshot({ path: join(dir, `${name}.png`) });
    await p.close();
  };
  await shot('50-image-plain', {});
  let n = 51;
  for (const [name, effects] of EFFECT_SHOTS) await shot(`${n++}-effect-${name}`, { effects });
  n = 60;
  for (const [name, emitters] of EMITTER_SHOTS) {
    await shot(`${n++}-particles-${name}`, { emitters, sprite: name === 'custom-sprite' });
  }
  await shot('66-cover-blurred', { base: 'cover', emitters: ['dust'] });
  await shot('67-solid', { base: 'solid', emitters: ['petals'] });
  // The cover fallback: the demo has no cover, so "Cover only" shows the neutral base.
  page = await openApp(context, '?autoplay', { backgroundMode: 'cover' });
  await playFrom(page, 37_000, 2000);
  await page.screenshot({ path: join(dir, '68-cover-fallback.png') });
  await page.close();
  // The song's own background (the demo's built-in dust and sparks), Off, the picture undimmed.
  page = await openApp(context, '?autoplay', { backgroundMode: 'song' });
  await playFrom(page, 37_000, 2000);
  await page.screenshot({ path: join(dir, '69-song-default.png') });
  await page.close();
  page = await openApp(context, '?autoplay', { backgroundMode: 'off' });
  await playFrom(page, 37_000, 1500);
  await page.screenshot({ path: join(dir, '70-off.png') });
  await page.close();
  page = await openApp(context, '?autoplay', { backgroundMode: 'image', backgroundDim: 0 });
  await playFrom(page, 37_000, 1800);
  await waitForBake(page, '71');
  await page.screenshot({ path: join(dir, '71-bright-image-no-dim.png') });
  await page.close();
  // Player settings, Display category (background controls).
  page = await openApp(context, '', { backgroundMode: 'song', backgroundDim: 0.55 });
  await go(page, 'settings', { returnTo: { scene: 'menu' } });
  await page.click('#tab-display');
  await shoot(page, dir, '72-settings-display-background');
  await page.close();

  // Studio: a stored song (the demo audio as WAV), its Background section, editor and sprite
  // editor.
  page = await openApp(context, '');
  const songId = await addTestSong(page);
  await go(page, 'studio', { songId });
  await shoot(page, dir, '73-studio-background-section');
  await page.keyboard.press('KeyB');
  await page.waitForSelector('.background-dialog .bg-preview', { timeout: 60_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(dir, '74-studio-background-editor.png') });
  // Add the Rising embers template and open its first groups.
  await page
    .selectOption('.background-dialog .bg-controls select >> nth=-1', 'embers')
    .catch(() => {});
  await page.click('.background-dialog button:has-text("Add emitter")');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(dir, '75-studio-background-emitter.png') });
  await page.click('.background-dialog button:has-text("Draw a sprite")');
  await page.waitForSelector('.sprite-dialog .sprite-grid');
  const grid = await page.locator('.sprite-dialog .sprite-grid').boundingBox();
  if (grid) {
    // A small diamond, drawn with the mirror on.
    await page.click('.sprite-dialog .toggle');
    const cell = grid.width / 16;
    for (let y = 3; y < 13; y++) {
      const half = 5 - Math.abs(y - 7.5) + 0.5;
      for (let x = 8 - Math.ceil(half); x < 8; x++) {
        await page.mouse.click(grid.x + (x + 0.5) * cell, grid.y + (y + 0.5) * cell);
      }
    }
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, '76-studio-sprite-editor.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.close();
  await context.close();

  // Performance at 4K: the base alone, every adjustment, and three emitters at the cap, with
  // pixel match on and off.
  const big = await browser.newContext({ viewport: { width: 3840, height: 2160 } });
  page = await openApp(big, '?autoplay', { backgroundMode: 'song' });
  await setBrightPicture(page);
  await page.close();
  const cases = [
    ['base', {}],
    ['all adjustments', { effects: EFFECT_SHOTS.at(-1)[1] }],
    [
      'three emitters (cap)',
      {
        emitters: [
          ['dust', { count: 300 }],
          ['embers', { count: 300 }],
          ['sparks', { count: 40 }],
        ],
      },
    ],
  ];
  for (const pixelMatch of [true, false]) {
    for (const [label, spec] of cases) {
      const p = await openApp(big, '?autoplay', { backgroundMode: 'song' });
      await setBackgroundOverride(p, { ...spec, pixelMatch });
      await playFrom(p, 37_000, 800);
      await waitForBake(p);
      const t = await backgroundTiming(p);
      const info = await p.evaluate(() => window.__ataraxiaBackground?.() ?? null);
      console.log(
        `[4K${pixelMatch ? '' : ' full-res'}] ${label}: ${t.fps.toFixed(1)} fps, worst frame ${t.worstMs.toFixed(1)} ms` +
          (info
            ? `, cpu ${info.costMs.toFixed(2)} ms, ${info.particles} particles, quality ${info.quality}`
            : ''),
      );
      if (label.startsWith('three') && !pixelMatch) {
        await p.screenshot({ path: join(dir, '77-particles-4k-full-res.png') });
      }
      await p.close();
    }
  }
  await big.close();
}

try {
  if (backgroundsOnly) await backgrounds();
  if (feelOnly) await feel();
  for (const size of gameplayOnly || editorOnly || backgroundsOnly || feelOnly ? [] : SIZES) {
    const dir = join(outDir, size.name);
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error(`[${size.name}] page error:`, err.message));
    await page.goto(url);
    await page.waitForFunction(() => window.__ataraxia !== undefined);
    await page.evaluate(() => document.fonts.ready);

    await shoot(page, dir, '01-main-menu');
    await go(page, 'songSelect', {});
    await shoot(page, dir, '02-song-select');
    await page.keyboard.type('zz');
    await shoot(page, dir, '03-song-select-no-match');
    await page.keyboard.press('Escape');

    for (const [i, tab] of ['gameplay', 'controls', 'audio', 'display', 'calibration'].entries()) {
      await go(page, 'settings', { returnTo: { scene: 'menu' } });
      await page.click(`#tab-${tab}`);
      if (tab === 'controls') await page.click('.keybind >> nth=1');
      await shoot(page, dir, `04-settings-${i + 1}-${tab}`);
    }
    await page.keyboard.press('Escape');

    await go(page, 'calibration', { returnTo: { scene: 'menu' } });
    await shoot(page, dir, '05-calibration');

    await go(page, 'results', {
      game: { mode: 'play', songId: 'builtin:demo', chartId: 'x' },
      result: RESULT,
      chartInfo: { title: 'Still Water', artist: 'ataraxia', difficulty: 'Hard', level: 12 },
      save: false,
    });
    await shoot(page, dir, '06-results');

    await go(page, 'songSelect', {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await shoot(page, dir, '07-pause');
    await page.keyboard.press('KeyQ');

    await go(page, 'studio', {});
    await shoot(page, dir, '08-studio-home');
    await page.keyboard.press('KeyR');
    await shoot(page, dir, '09-modal-error');
    await page.keyboard.press('Escape');

    if (size.name === '1920x1080') {
      // Button states: idle, hover, pressed and keyboard focus.
      await go(page, 'menu');
      await page.waitForTimeout(300);
      const list = page.locator('.main-menu-list');
      const box = await list.boundingBox();
      const clip = { x: box.x - 40, y: box.y - 20, width: box.width + 80, height: box.height + 40 };
      await page.mouse.move(5, 5);
      await page.screenshot({ path: join(dir, '10-buttons-focus.png'), clip });
      await page.hover('.main-menu-list .btn >> nth=1');
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(dir, '11-buttons-hover-mid-sheen.png'), clip });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(dir, '12-buttons-hover.png'), clip });
      await page.mouse.down();
      await page.screenshot({ path: join(dir, '13-buttons-pressed.png'), clip });
      await page.mouse.up();
    }
    await context.close();
  }
  const some = gameplayOnly || editorOnly || backgroundsOnly || feelOnly;
  if (!some || gameplayOnly) await gameplay();
  if (!some || gameplayOnly) await feel();
  if (!some || editorOnly) await editor();
  if (!some) await backgrounds();
  console.log(`screenshots: written to ${outDir}`);
} finally {
  await browser.close();
  await server.close();
}
