import type { Skin } from './skin';

export interface DebugInfo {
  songTimeMs: number;
  /** Most recent press error (negative = early), or null before the first hit. */
  lastErrorMs: number | null;
  /** Mean of the recent press errors, or null before the first hit. */
  averageErrorMs: number | null;
  averageCount: number;
  fps: number;
  /** Output latency the browser reports (already compensated in song time). */
  latencyMs: number;
  /** The player's audio offset setting (subtracted from presses). */
  offsetMs: number;
}

const fmt = (n: number | null, digits = 0): string =>
  n === null ? '--' : `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

/**
 * F3 overlay (Studio only): timing numbers for checking sync by eye (song time, last and average
 * press error, frame rate, output latency), at the left edge under the song card. A debugging
 * tool, so it builds its strings freely.
 */
export function drawDebugOverlay(ctx: CanvasRenderingContext2D, skin: Skin, d: DebugInfo): void {
  const c = skin.colors;
  const font = skin.fonts.label;
  const lines = [
    `t ${Math.round(d.songTimeMs)} ms`,
    `err ${fmt(d.lastErrorMs)} ms`,
    `avg ${fmt(d.averageErrorMs, 1)} (${d.averageCount})`,
    `fps ${Math.round(d.fps)}`,
    `lat ${Math.round(d.latencyMs)} ms`,
    `ofs ${fmt(d.offsetMs)} ms`,
  ];
  const lineH = font.capHeight + 6;
  const x = 12;
  const y = 64;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = c.panel;
  ctx.fillRect(x - 4, y - 5, 120, lines.length * lineH + 6);
  ctx.globalAlpha = 1;
  lines.forEach((line, i) => font.draw(ctx, line, x, y + i * lineH, c.accentText, c.shadow));
}
