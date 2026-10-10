import type { Settings } from '../core/settings';

/**
 * Milliseconds to subtract from a key press's song time to cancel the player's latency (game
 * judgement, editor live recording, calibration fine-tune). Song time already follows the
 * *heard* audio (AudioEngine.eventTimeToSongMs), so this is only the player's personal offset.
 */
export function inputLatencyOffsetMs(settings: Readonly<Settings>): number {
  return settings.audioOffsetMs;
}
