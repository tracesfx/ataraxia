import { describe, expect, it } from 'vitest';
import { PALETTE, RAMPS } from '../theme';
import type { Bitmap } from './bitmap';
import { unpack } from './color';
import { coverBitmap, coverStyle } from './cover';
import { ICON_SIZE, iconMask, iconNames } from './icons';
import { logoBitmap, markMask, wordmarkMask } from './logo';
import { RANK_H, RANK_W, rankBitmap } from './rank';
import { BUTTON, BUTTON_STATES, BUTTON_VARIANTS, CHIP_TONES, buildUiSprites } from './sprites';

const palette = new Set(PALETTE);

function strayColours(bmp: Bitmap): string[] {
  const out: string[] = [];
  for (const c of bmp.colours()) {
    const { hex } = unpack(c);
    if (!palette.has(hex)) out.push(hex);
  }
  return out;
}

describe('UI sprites', () => {
  const sprites = buildUiSprites();

  it('has every button variant and state', () => {
    for (const v of BUTTON_VARIANTS) {
      for (const s of BUTTON_STATES) expect(sprites.has(`button.${v}.${s}`)).toBe(true);
    }
    for (const tone of CHIP_TONES) {
      expect(sprites.has(`chip.${tone}`)).toBe(true);
      expect(sprites.has(`chip.${tone}.selected`)).toBe(true);
    }
    for (const name of [
      'glass',
      'modal',
      'card.idle',
      'card.selected',
      'tooltip',
      'field.idle',
      'field.focus',
      'toggle.on.idle',
      'toggle.off.focus',
      'slider.track',
      'slider.fill',
      'slider.thumb.idle',
      'tab.h.selected',
      'tab.v.selected',
      'row.hover',
      'row.selected',
      'keycap',
      'progress.track',
      'progress.fill',
      'scrollbar.idle',
      'divider',
      'focus',
      'sheen',
      'cover.frame',
      'toast.accent',
    ]) {
      expect(sprites.has(name), name).toBe(true);
    }
  });

  it('buttons are the documented size with a 3-pixel glow margin', () => {
    const s = sprites.get('button.primary.idle');
    expect(s?.bitmap.w).toBe(BUTTON.w + 2 * BUTTON.margin);
    expect(s?.bitmap.h).toBe(BUTTON.h + 2 * BUTTON.margin);
    expect(s?.slice).toEqual([10, 9, 10, 9]);
    expect(s?.outset).toBe(3);
  });

  it('9-slice insets leave a stretchable middle inside the sprite', () => {
    for (const s of sprites.values()) {
      if (!s.slice) continue;
      const [t, r, b, l] = s.slice;
      expect(t + b, `${s.name} vertical slices`).toBeLessThanOrEqual(s.bitmap.h);
      expect(l + r, `${s.name} horizontal slices`).toBeLessThan(s.bitmap.w);
      for (const v of s.slice) expect(Number.isInteger(v) && v >= 0).toBe(true);
      expect(s.outset).toBeLessThanOrEqual(Math.min(t, r, b, l));
    }
  });

  it('uses only palette colours (alpha may vary)', () => {
    for (const s of sprites.values()) expect(strayColours(s.bitmap), s.name).toEqual([]);
  });

  it('never draws a button outline in black, white or another ramp', () => {
    const s = sprites.get('button.secondary.idle');
    // The left edge pixel halfway down the body is outline: a dark steel tone.
    const c = s?.bitmap.get(BUTTON.margin, BUTTON.margin + 8) ?? 0;
    expect(RAMPS.steel.slice(0, 3)).toContain(unpack(c).hex);
  });

  it('keeps the button glint inside the corner slice (not stretched)', () => {
    const s = sprites.get('button.secondary.idle');
    const bmp = s?.bitmap;
    const slice = s?.slice;
    if (!bmp || !slice) throw new Error('missing sprite');
    for (let y = 0; y < bmp.h; y++) {
      for (let x = 0; x < bmp.w; x++) {
        if (unpack(bmp.get(x, y)).hex !== RAMPS.steel[8]) continue;
        expect(x).toBeLessThan(slice[3]);
        expect(y).toBeLessThan(slice[0]);
      }
    }
  });
});

describe('icons', () => {
  it('are 16x16 and not empty', () => {
    for (const name of iconNames()) {
      const m = iconMask(name);
      expect(m?.w, name).toBe(ICON_SIZE);
      expect(m?.h, name).toBe(ICON_SIZE);
      expect(m?.count(), name).toBeGreaterThan(8);
    }
    expect(iconMask('nope')).toBeNull();
  });
});

describe('logo', () => {
  it('has three variants built from palette colours', () => {
    for (const v of ['large', 'small', 'mark'] as const) {
      const bmp = logoBitmap(v);
      expect(bmp.colours().size).toBeGreaterThan(3);
      expect(strayColours(bmp)).toEqual([]);
    }
    expect(logoBitmap('mark').w).toBe(16);
    expect(logoBitmap('mark').h).toBe(16);
  });

  it('spaces the wordmark letters evenly and keeps the mark symmetric', () => {
    const large = wordmarkMask('large');
    expect(large.h).toBe(26);
    const mark = markMask(8);
    for (let y = 0; y < mark.h; y++) {
      for (let x = 0; x < mark.w; x++) expect(mark.has(x, y)).toBe(mark.has(mark.w - 1 - x, y));
    }
  });
});

describe('rank letters and covers', () => {
  it('draws each rank with its own ramp', () => {
    const seen = new Set<string>();
    for (const r of ['S', 'A', 'B', 'C', 'D'] as const) {
      const bmp = rankBitmap(r);
      expect(bmp.w).toBe(RANK_W + 3);
      expect(bmp.h).toBe(RANK_H + 3);
      expect(strayColours(bmp)).toEqual([]);
      const key = [...bmp.colours()].sort().join();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('generates deterministic covers from the title', () => {
    expect(coverStyle('Hello')).toEqual(coverStyle('hello '));
    const a = coverBitmap('Hello', 24);
    const b = coverBitmap('Hello', 24);
    expect([...a.data]).toEqual([...b.data]);
    expect(a.w).toBe(24);
    expect(strayColours(a)).toEqual([]);
    const different = ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => coverStyle(t).tone);
    expect(new Set(different).size).toBeGreaterThan(1);
  });
});
