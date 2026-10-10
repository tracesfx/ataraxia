import type { PixelLayout } from './pixelScale';
import type { Skin } from './skin';

/**
 * Diagnostic pattern proving the pixel canvas is crisp: a 1px border, a 1px checkerboard,
 * single-pixel diagonals, the note sprites, text at each size, and a block that moves by whole
 * pixels. Any blur or uneven pixel sizes on screen indicate a scaling problem. (A debugging aid
 * on F2 in the main menu, not part of the game's look.)
 */
export function drawTestPattern(
  ctx: CanvasRenderingContext2D,
  skin: Skin,
  layout: Readonly<PixelLayout>,
  timeSec: number,
  devicePixelRatio: number,
): void {
  const { width: w, height: h } = ctx.canvas;
  const c = skin.colors;

  ctx.fillStyle = c.background;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = c.textFaint;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 32; x++) {
      if ((x + y) % 2 === 0) ctx.fillRect(8 + x, 8 + y, 1, 1);
    }
  }
  ctx.fillStyle = c.accentText;
  for (let i = 0; i < 32; i++) {
    ctx.fillRect(48 + i, 8 + Math.floor(i / 2), 1, 1);
    ctx.fillRect(48 + i, 23 - Math.floor(i / 2), 1, 1);
  }
  ctx.drawImage(skin.sprites.note.outer, 96, 8);
  ctx.drawImage(skin.sprites.note.inner, 160, 8);
  ctx.drawImage(skin.sprites.holdCap.outer, 224, 8);

  const f = skin.fonts;
  f.label.draw(ctx, 'Label text 0123456789', 8, 40, c.text, c.shadow);
  f.title.draw(ctx, 'Title 0123', 8, 60, c.text, c.shadow);
  f.label.drawText(ctx, '1234', 8, 92, 3, c.comboTiers[0] ?? [c.text], c.outline);
  f.particle.small.draw(ctx, '+60 -34', 8, 136, c.late, c.shadow);
  f.particle.medium.draw(ctx, '+60 -34', 60, 136, c.early, c.shadow);
  f.particle.large.draw(ctx, '+60 -34', 120, 136, c.late, c.shadow);

  const travel = w - 16 - 8;
  const phase = Math.floor(timeSec * 60) % (travel * 2);
  const x = 8 + (phase > travel ? travel * 2 - phase : phase);
  ctx.fillStyle = c.accentText;
  ctx.fillRect(x, h - 20, 8, 8);

  ctx.fillRect(0, 0, w, 1);
  ctx.fillRect(0, h - 1, w, 1);
  ctx.fillRect(0, 0, 1, h);
  ctx.fillRect(w - 1, 0, 1, h);

  const info = `${w}x${h}  scale ${fmtScale(layout.scale)}  dpr ${fmtScale(devicePixelRatio)}`;
  f.label.draw(ctx, info, w - 8, h - 36, c.textMuted, c.shadow, 'right');
}

function fmtScale(n: number): string {
  return Number.isInteger(n) ? `${n}x` : `${n.toFixed(2)}x`;
}
