import { defaultBackgroundConfig, type BackgroundConfig, type BaseKind } from './config';

/**
 * Which background a song is played with. Precedence:
 * 1. the player's choice (Settings -> Display -> Background): Off, Cover only, or Custom image
 *    replace the song's base (the song's adjustments and particles stay, except with Off);
 * 2. the song's configured background (made in the Studio, stored with the song);
 * 3. the default: the song's cover as the base with no adjustments and no particles.
 * A base whose picture is missing falls back: image -> cover -> none (a near-black neutral with a
 * subtle vignette).
 */

/** Settings -> Display -> Background. */
export type BackgroundMode = 'song' | 'cover' | 'image' | 'off';
export const BACKGROUND_MODES: readonly BackgroundMode[] = ['song', 'cover', 'image', 'off'];

export function isBackgroundMode(v: unknown): v is BackgroundMode {
  return typeof v === 'string' && (BACKGROUND_MODES as readonly string[]).includes(v);
}

export interface PlayerBackgroundChoice {
  mode: BackgroundMode;
  /** A custom picture is stored (for mode 'image'). */
  hasImage: boolean;
}

export interface SongBackgroundInfo {
  config: BackgroundConfig | null;
  /** The song has at least one background picture of its own. */
  hasImage: boolean;
  hasCover: boolean;
}

export type BackgroundSource = 'player' | 'song' | 'default';
/** Where the base picture comes from. */
export type PictureSource = 'player' | 'song' | 'cover';

export interface ResolvedBackground {
  /** The config to draw; its base kind is what is actually shown. */
  config: BackgroundConfig;
  source: BackgroundSource;
  /** The base picture (null for base solid and none). */
  picture: PictureSource | null;
}

function withBase(c: BackgroundConfig, kind: BaseKind): BackgroundConfig {
  return c.base.kind === kind ? c : { ...c, base: { ...c.base, kind } };
}

/** The base actually shown for a wanted base and the pictures that exist. */
function settle(
  c: BackgroundConfig,
  song: SongBackgroundInfo,
  source: BackgroundSource,
): ResolvedBackground {
  let kind = c.base.kind;
  if (kind === 'image' && !song.hasImage) kind = 'cover';
  if (kind === 'cover' && !song.hasCover) kind = 'none';
  const picture: PictureSource | null =
    kind === 'image' ? 'song' : kind === 'cover' ? 'cover' : null;
  return { config: withBase(c, kind), source, picture };
}

export function resolveBackground(
  player: PlayerBackgroundChoice,
  song: SongBackgroundInfo,
): ResolvedBackground {
  const songConfig = song.config ?? defaultBackgroundConfig('cover');
  const songSource: BackgroundSource = song.config ? 'song' : 'default';
  switch (player.mode) {
    case 'off':
      return { config: defaultBackgroundConfig('none'), source: 'player', picture: null };
    case 'image':
      if (player.hasImage) {
        return { config: withBase(songConfig, 'image'), source: 'player', picture: 'player' };
      }
      return settle(songConfig, song, songSource);
    case 'cover':
      return settle(withBase(songConfig, 'cover'), song, 'player');
    case 'song':
      return settle(songConfig, song, songSource);
  }
}
