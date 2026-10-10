import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  MAX_BACKGROUND_IMAGES,
  sanitizeBackgroundConfig,
  type BackgroundConfig,
} from '../core/background/config';
import { MAX_CUSTOM_SPRITES, MAX_SPRITE_BYTES } from '../core/background/emitter';
import type { Chart } from '../core/chart';
import { parseChart, serializeChart } from '../core/parseChart';
import { dedupeFileNames, extensionOf, safeFileName } from './fileNames';
import { toChartFile, validateSongMeta, type ChartContent, type SongMeta } from './records';

/**
 * Song packages: a .zip holding `song.json`, the original audio file, `charts/*.json` (standard
 * chart files, one per difficulty) and, from package version 2, an optional cover picture
 * (`cover.webp`, or `cover.png`) named by song.json's `cover` field, and from package version 3 an
 * optional gameplay background: song.json's `background` (the config) and its pictures. Version
 * 3-4 named one picture in `backgroundImage` (`background.webp`); version 5 lists up to eight in
 * `backgroundImages` (`backgrounds/<id>.webp`) and the custom particle sprites in
 * `particleSprites` (`sprites/<id>.png`). Pure: works on bytes, no DOM or IndexedDB. See
 * docs/chart-format.md, "Song packages".
 */

/**
 * Written to song.json. Informational: readers don't check it, so packages exported before the
 * rename (format "pixel-beat-song") still import.
 */
export const PACKAGE_FORMAT = 'ataraxia-song';
/**
 * 2: optional cover picture. 3: optional background (config and picture). 4: the background
 * config is version 2 (base, effects, overlays; Phase 20). 5: background config version 3,
 * several background pictures and custom particle sprites (Phase 21). Older packages still
 * import: their background configs are migrated, their one picture becomes the first, and they
 * import without the parts they lack.
 */
export const PACKAGE_VERSION = 5;
export const SONG_JSON = 'song.json';
export const CHARTS_DIR = 'charts/';
/** Refuse anything bigger before decompressing it (guards against zip bombs). */
export const MAX_AUDIO_BYTES = 300 * 1024 * 1024;
export const MAX_CHART_BYTES = 10 * 1024 * 1024;
/** Largest cover picture read from a package (a stored cover is far smaller). */
export const MAX_PACKAGE_COVER_BYTES = 5 * 1024 * 1024;
/** Largest background picture read from a package (a stored one is at most 3 MB). */
export const MAX_PACKAGE_BACKGROUND_BYTES = 8 * 1024 * 1024;
const MAX_CHARTS = 100;
export const BACKGROUNDS_DIR = 'backgrounds/';
export const SPRITES_DIR = 'sprites/';

/** A cover picture inside a package: its entry name and bytes. */
export interface PackageCover {
  fileName: string;
  /** MIME type recognised from the bytes. */
  type: string;
  bytes: Uint8Array;
}

export interface SongPackageInput {
  song: SongMeta & { audioFileName: string };
  audio: Uint8Array;
  charts: readonly ChartContent[];
  /** The song's cover (`fileName` should be cover.webp or cover.png). */
  cover?: { fileName: string; bytes: Uint8Array } | null;
  /** The song's background config, its pictures (WebP or PNG) and custom sprites (PNG). */
  background?: BackgroundConfig | null;
  backgroundImages?: readonly { id: string; type: string; bytes: Uint8Array }[];
  particleSprites?: readonly { id: string; name: string; bytes: Uint8Array }[];
}

/** A background picture inside a package. */
export interface PackageImage extends PackageCover {
  id: string;
}

/** A custom particle sprite inside a package. */
export interface PackageSprite extends PackageCover {
  id: string;
  name: string;
}

export interface SongPackageContents {
  song: SongMeta;
  audioFileName: string;
  audio: Uint8Array;
  /** Validated charts; their song-level fields are taken from song.json. */
  charts: Chart[];
  /** The cover picture, or null when there is none (or it was unusable: see `warnings`). */
  cover: PackageCover | null;
  /** The background config (package version 3+, migrated to the current version), or null. */
  background: BackgroundConfig | null;
  /** The background pictures (unusable ones are left out: see `warnings`). */
  backgroundImages: PackageImage[];
  /** The custom particle sprites (unusable ones are left out: see `warnings`). */
  particleSprites: PackageSprite[];
}

export type PackageReadResult =
  | { ok: true; contents: SongPackageContents; errors: []; warnings: string[] }
  | { ok: false; contents: null; errors: string[]; warnings: [] };

/** The picture type of some bytes from their signature, or null when not a cover picture. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number, text: string): boolean =>
    [...text].every((ch, k) => bytes[i + k] === ch.charCodeAt(0));
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (bytes.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif';
  if (bytes.length >= 12 && at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis'))) return 'image/avif';
  return null;
}

/** The cover's entry name inside the package: a plain top-level name that collides with nothing. */
function coverEntryName(fileName: string): string {
  const ext = extensionOf(fileName);
  return `cover.${ext === 'png' ? 'png' : 'webp'}`;
}

const SAFE_ID = /^[\w-]{1,64}$/;

/** The audio file's name inside the package (its original name, made safe). */
function audioEntryName(audioFileName: string): string {
  const ext = extensionOf(audioFileName);
  const name = safeFileName(audioFileName, ext ? `audio.${ext}` : 'audio');
  // Never collide with song.json or look like a chart.
  return name.toLowerCase() === SONG_JSON || extensionOf(name) === 'json' ? `audio-${name}` : name;
}

export function buildSongPackage(input: SongPackageInput): Uint8Array {
  const { song } = input;
  const audioName = audioEntryName(song.audioFileName);
  let coverName = input.cover ? coverEntryName(input.cover.fileName) : null;
  if (coverName !== null && coverName === audioName) coverName = `art-${coverName}`;
  const images = (input.backgroundImages ?? []).filter((i) => SAFE_ID.test(i.id));
  const sprites = (input.particleSprites ?? []).filter((i) => SAFE_ID.test(i.id));
  const imageFile = (i: { id: string; type: string }): string =>
    `${BACKGROUNDS_DIR}${i.id}.${i.type === 'image/png' ? 'png' : 'webp'}`;
  const spriteFile = (i: { id: string }): string => `${SPRITES_DIR}${i.id}.png`;
  const songJson = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    title: song.title,
    artist: song.artist,
    audio: audioName,
    ...(coverName !== null ? { cover: coverName } : {}),
    bpm: song.bpm,
    offsetMs: song.offsetMs,
    previewStartMs: song.previewStartMs,
    ...(input.background ? { background: input.background } : {}),
    ...(images.length > 0
      ? { backgroundImages: images.map((i) => ({ id: i.id, file: imageFile(i) })) }
      : {}),
    ...(sprites.length > 0
      ? {
          particleSprites: sprites.map((i) => ({ id: i.id, name: i.name, file: spriteFile(i) })),
        }
      : {}),
  };
  const chartNames = dedupeFileNames(
    input.charts.map((c) => `${safeFileName(c.difficulty, 'chart')}.json`),
  );
  const files: Zippable = {
    [SONG_JSON]: strToU8(JSON.stringify(songJson, null, 2)),
    // Audio is already compressed: store it as-is.
    [audioName]: [input.audio, { level: 0 }],
  };
  // Covers are compressed pictures too: stored as-is.
  if (coverName !== null && input.cover) files[coverName] = [input.cover.bytes, { level: 0 }];
  for (const i of images) files[imageFile(i)] = [i.bytes, { level: 0 }];
  for (const i of sprites) files[spriteFile(i)] = [i.bytes, { level: 0 }];
  input.charts.forEach((chart, i) => {
    files[`${CHARTS_DIR}${chartNames[i] as string}`] = strToU8(
      serializeChart(toChartFile(song, chart)),
    );
  });
  return zipSync(files, { level: 6 });
}

interface EntryInfo {
  name: string;
  size: number;
}

function fail(errors: string[]): PackageReadResult {
  return { ok: false, contents: null, errors, warnings: [] };
}

function isIgnored(name: string): boolean {
  return name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name);
}

/**
 * Read and fully validate a song package. Either everything in it is valid and returned, or
 * nothing is, with every problem found listed as a complete sentence.
 */
export function readSongPackage(bytes: Uint8Array): PackageReadResult {
  // Pass 1: list entries without decompressing anything.
  const entries: EntryInfo[] = [];
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (!isIgnored(f.name)) entries.push({ name: f.name, size: f.originalSize });
        return false;
      },
    });
  } catch {
    return fail([
      'This file is not a valid song package: it could not be opened as a .zip archive. It may be damaged or not a .zip file at all.',
    ]);
  }

  // Allow packages that were re-zipped inside a single folder ("My Song/song.json").
  let prefix = '';
  if (!entries.some((e) => e.name === SONG_JSON)) {
    const nested = entries.filter((e) => /^[^/]+\/song\.json$/.test(e.name));
    if (nested.length !== 1) {
      return fail([
        `This song package has no ${SONG_JSON}. A package must contain ${SONG_JSON}, the audio file and a charts/ folder.`,
      ]);
    }
    prefix = (nested[0] as EntryInfo).name.slice(0, -SONG_JSON.length);
  }
  const local = entries
    .filter((e) => e.name.startsWith(prefix))
    .map((e) => ({ ...e, name: e.name.slice(prefix.length) }));

  const errors: string[] = [];
  const sizeOf = (name: string): number => local.find((e) => e.name === name)?.size ?? 0;
  if (sizeOf(SONG_JSON) > MAX_CHART_BYTES) {
    return fail([`${SONG_JSON} is too large to be a song description.`]);
  }

  // Pass 2: decompress song.json and the charts.
  const chartNames = local
    .filter((e) => e.name.startsWith(CHARTS_DIR) && extensionOf(e.name) === 'json')
    .map((e) => e.name)
    .sort();
  if (chartNames.length > MAX_CHARTS) {
    return fail([
      `This song package has ${chartNames.length} charts; at most ${MAX_CHARTS} are allowed.`,
    ]);
  }
  for (const name of chartNames) {
    if (sizeOf(name) > MAX_CHART_BYTES) {
      errors.push(
        `${name} is larger than ${MAX_CHART_BYTES / 1024 / 1024} MB, which is too large for a chart.`,
      );
    }
  }
  if (errors.length > 0) return fail(errors);

  let text: Record<string, Uint8Array>;
  try {
    const wanted = new Set([SONG_JSON, ...chartNames].map((n) => prefix + n));
    text = unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
  } catch {
    return fail(['This song package is damaged: some of its files could not be decompressed.']);
  }

  // song.json
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(text[prefix + SONG_JSON] ?? new Uint8Array()));
  } catch {
    return fail([`${SONG_JSON} is not valid JSON.`]);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail([`${SONG_JSON} must contain a JSON object.`]);
  }
  const obj = raw as Record<string, unknown>;
  const version = obj['version'] ?? PACKAGE_VERSION;
  if (typeof version !== 'number' || !Number.isInteger(version) || version > PACKAGE_VERSION) {
    return fail([
      `${SONG_JSON} has package version ${String(version)}, which this game does not support (up to ${PACKAGE_VERSION}). Update the game to import it.`,
    ]);
  }
  const song: SongMeta = {
    title: obj['title'] as string,
    artist: (obj['artist'] ?? '') as string,
    bpm: obj['bpm'] as number,
    offsetMs: (obj['offsetMs'] ?? 0) as number,
    previewStartMs: (obj['previewStartMs'] ?? 0) as number,
  };
  for (const e of validateSongMeta(song)) errors.push(`${SONG_JSON}: ${e}`);

  // Cover (optional): named by song.json. Problems only produce warnings.
  const warnings: string[] = [];
  const NO_COVER = 'The song was imported without a cover.';
  let coverName: string | null = null;
  const namedCover = obj['cover'];
  if (namedCover !== undefined && namedCover !== null) {
    if (typeof namedCover !== 'string' || namedCover === '') {
      warnings.push(`The "cover" field of ${SONG_JSON} is not a file name. ${NO_COVER}`);
    } else if (!local.some((e) => e.name === namedCover)) {
      warnings.push(
        `${SONG_JSON} names the cover "${namedCover}", but the package does not contain it. ${NO_COVER}`,
      );
    } else if (sizeOf(namedCover) > MAX_PACKAGE_COVER_BYTES) {
      warnings.push(
        `The cover "${namedCover}" is larger than ${MAX_PACKAGE_COVER_BYTES / 1024 / 1024} MB. ${NO_COVER}`,
      );
    } else if (sizeOf(namedCover) === 0) {
      warnings.push(`The cover "${namedCover}" is empty. ${NO_COVER}`);
    } else {
      coverName = namedCover;
    }
  }

  // Background (optional, version 3): a config and a picture named by song.json. Problems only
  // produce warnings; the song then uses the default background.
  let background: BackgroundConfig | null = null;
  const rawBackground = obj['background'];
  if (rawBackground !== undefined && rawBackground !== null) {
    background = sanitizeBackgroundConfig(rawBackground);
    if (!background) {
      warnings.push(
        `The "background" field of ${SONG_JSON} is not a background this game knows. The song uses the default background.`,
      );
    }
  }
  // Pictures and sprites named by song.json. Version 3-4 packages name one picture in
  // `backgroundImage`; it becomes the first.
  const wantedImages: { id: string; name: string }[] = [];
  const wantedSprites: { id: string; name: string; label: string }[] = [];
  const listOf = (field: string): unknown[] => {
    const v = obj[field];
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v;
    warnings.push(`The "${field}" field of ${SONG_JSON} is not a list, so it was ignored.`);
    return [];
  };
  const fileOf = (v: unknown, what: string): string | null => {
    const file = (v as { file?: unknown } | null)?.file;
    if (typeof file !== 'string' || file === '') {
      warnings.push(`${SONG_JSON} lists ${what} without a file name, so it was left out.`);
      return null;
    }
    if (!local.some((e) => e.name === file)) {
      warnings.push(
        `${SONG_JSON} names ${what} "${file}", but the package does not contain it, so it was left out.`,
      );
      return null;
    }
    if (sizeOf(file) === 0) {
      warnings.push(`The file "${file}" is empty, so it was left out.`);
      return null;
    }
    return file;
  };
  const legacy = obj['backgroundImage'];
  if (legacy !== undefined && legacy !== null) {
    const file =
      typeof legacy === 'string' && legacy !== ''
        ? fileOf({ file: legacy }, 'the background picture')
        : fileOf({}, 'the background picture');
    if (file && sizeOf(file) > MAX_PACKAGE_BACKGROUND_BYTES) {
      warnings.push(
        `The background picture "${file}" is larger than ${MAX_PACKAGE_BACKGROUND_BYTES / 1024 / 1024} MB, so it was left out.`,
      );
    } else if (file) {
      wantedImages.push({ id: 'image-1', name: file });
    }
  }
  for (const item of listOf('backgroundImages').slice(0, MAX_BACKGROUND_IMAGES)) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !SAFE_ID.test(id) || wantedImages.some((w) => w.id === id)) {
      warnings.push(`A background picture in ${SONG_JSON} has no usable id, so it was left out.`);
      continue;
    }
    const file = fileOf(item, 'a background picture');
    if (!file) continue;
    if (sizeOf(file) > MAX_PACKAGE_BACKGROUND_BYTES) {
      warnings.push(
        `The background picture "${file}" is larger than ${MAX_PACKAGE_BACKGROUND_BYTES / 1024 / 1024} MB, so it was left out.`,
      );
      continue;
    }
    wantedImages.push({ id, name: file });
  }
  for (const item of listOf('particleSprites').slice(0, MAX_CUSTOM_SPRITES)) {
    const id = (item as { id?: unknown } | null)?.id;
    const label = (item as { name?: unknown } | null)?.name;
    if (typeof id !== 'string' || !SAFE_ID.test(id) || wantedSprites.some((w) => w.id === id)) {
      warnings.push(`A custom sprite in ${SONG_JSON} has no usable id, so it was left out.`);
      continue;
    }
    const file = fileOf(item, 'a custom sprite');
    if (!file) continue;
    if (sizeOf(file) > MAX_SPRITE_BYTES) {
      warnings.push(
        `The custom sprite "${file}" is larger than ${MAX_SPRITE_BYTES / 1024} KB, so it was left out.`,
      );
      continue;
    }
    wantedSprites.push({ id, name: file, label: typeof label === 'string' ? label : id });
  }
  const pictures = new Set([namedCover, legacy].filter((n): n is string => typeof n === 'string'));

  // Audio: named by song.json, or else the only other file at the top level.
  let audioName: string | null = null;
  const named = obj['audio'];
  if (typeof named === 'string' && named !== '') {
    if (local.some((e) => e.name === named)) audioName = named;
    else
      errors.push(
        `${SONG_JSON} names the audio file "${named}", but the package does not contain it.`,
      );
  } else {
    const candidates = local.filter(
      (e) => !e.name.includes('/') && e.name !== SONG_JSON && !pictures.has(e.name),
    );
    if (candidates.length === 1) audioName = (candidates[0] as EntryInfo).name;
    else if (candidates.length === 0)
      errors.push('This song package does not contain an audio file.');
    else {
      errors.push(
        `This song package has several files that could be the audio (${candidates.map((c) => c.name).join(', ')}). Name the right one in the "audio" field of ${SONG_JSON}.`,
      );
    }
  }
  if (audioName !== null) {
    const size = sizeOf(audioName);
    if (size === 0) errors.push(`The audio file "${audioName}" is empty.`);
    if (size > MAX_AUDIO_BYTES) {
      errors.push(
        `The audio file "${audioName}" is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`,
      );
    }
  }

  // Charts
  const charts: Chart[] = [];
  for (const name of chartNames) {
    const result = parseChart(strFromU8(text[prefix + name] ?? new Uint8Array()));
    if (!result.ok) {
      for (const e of result.errors) errors.push(`${name}: ${e}`);
      continue;
    }
    charts.push({ ...result.chart, ...song, audio: audioName ?? '' });
  }

  if (errors.length > 0 || audioName === null) return fail(errors);

  let audio: Uint8Array | undefined;
  try {
    const fullName = prefix + audioName;
    audio = unzipSync(bytes, { filter: (f) => f.name === fullName })[fullName];
  } catch {
    // Reported below.
  }
  if (!audio || audio.length === 0) {
    return fail([
      `The audio file "${audioName}" in this package is damaged and could not be extracted.`,
    ]);
  }

  let cover: PackageCover | null = null;
  if (coverName !== null) {
    let bytesOut: Uint8Array | undefined;
    try {
      const fullName = prefix + coverName;
      bytesOut = unzipSync(bytes, { filter: (f) => f.name === fullName })[fullName];
    } catch {
      // Reported below.
    }
    const type = bytesOut ? sniffImageType(bytesOut) : null;
    if (!bytesOut || bytesOut.length === 0) {
      warnings.push(`The cover "${coverName}" is damaged and could not be extracted. ${NO_COVER}`);
    } else if (type === null) {
      warnings.push(
        `The cover "${coverName}" is not a PNG, JPEG, WebP, GIF or AVIF picture. ${NO_COVER}`,
      );
    } else {
      cover = { fileName: coverName, type, bytes: bytesOut };
    }
  }

  /** A picture entry's bytes and type, or null with a warning. */
  const picture = (
    name: string,
    kind: 'picture' | 'png',
  ): { type: string; bytes: Uint8Array } | null => {
    let bytesOut: Uint8Array | undefined;
    try {
      const fullName = prefix + name;
      bytesOut = unzipSync(bytes, { filter: (f) => f.name === fullName })[fullName];
    } catch {
      // Reported below.
    }
    const type = bytesOut ? sniffImageType(bytesOut) : null;
    if (!bytesOut || bytesOut.length === 0) {
      warnings.push(`"${name}" is damaged and could not be extracted, so it was left out.`);
      return null;
    }
    if (type === null || (kind === 'png' && type !== 'image/png')) {
      warnings.push(
        kind === 'png'
          ? `"${name}" is not a PNG picture, so it was left out.`
          : `"${name}" is not a PNG, JPEG, WebP, GIF or AVIF picture, so it was left out.`,
      );
      return null;
    }
    return { type, bytes: bytesOut };
  };
  const backgroundImages: PackageImage[] = [];
  for (const w of wantedImages) {
    const p = picture(w.name, 'picture');
    if (p) backgroundImages.push({ id: w.id, fileName: w.name, ...p });
  }
  const particleSprites: PackageSprite[] = [];
  for (const w of wantedSprites) {
    const p = picture(w.name, 'png');
    if (p) particleSprites.push({ id: w.id, name: w.label, fileName: w.name, ...p });
  }

  return {
    ok: true,
    errors: [],
    warnings,
    contents: {
      song,
      audioFileName: audioName,
      audio,
      charts,
      cover,
      background,
      backgroundImages,
      particleSprites,
    },
  };
}
