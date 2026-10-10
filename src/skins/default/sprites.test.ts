import { describe, expect, it } from 'vitest';
import {
  FIELD_W,
  HOLD_CAP_H,
  HOLD_W,
  NOTE_H,
  NOTE_W,
  PROGRESS_H,
  RAIL_W,
  computeFieldLayout,
} from '../../render/fieldLayout';
import { NOTE_HUES } from '../../render/skin';
import type { Bitmap } from '../../ui/pixel/bitmap';
import { unpack } from '../../ui/pixel/color';
import { PALETTE } from '../../ui/theme';
import { MICRO_BASELINE, MICRO_DIGITS } from './microFont';
import {
  backgroundBitmap,
  buildDefaultSprites,
  fieldBitmap,
  fieldGlowBitmap,
  noteBitmap,
} from './sprites';

const palette = new Set(PALETTE);

function strayColours(bmp: Bitmap): string[] {
  const out = new Set<string>();
  for (const c of bmp.colours()) {
    const { hex } = unpack(c);
    if (!palette.has(hex)) out.add(hex);
  }
  return [...out];
}

function size(bmp: Bitmap): [number, number] {
  return [bmp.w, bmp.h];
}

describe('default skin sprites', () => {
  const s = buildDefaultSprites();

  it('have the sizes the layout expects', () => {
    for (const hue of NOTE_HUES) {
      expect(size(s.note[hue])).toEqual([NOTE_W, NOTE_H]);
      expect(size(s.holdBody[hue])).toEqual([HOLD_W, 1]);
      expect(size(s.holdBodyHeld[hue])).toEqual([HOLD_W, 1]);
      expect(size(s.holdCap[hue])).toEqual([HOLD_W, HOLD_CAP_H]);
    }
    expect(size(s.progressTrack)).toEqual([1, PROGRESS_H]);
    expect(size(s.progressFill)).toEqual([1, PROGRESS_H]);
  });

  it('use only palette colours', () => {
    const all: Bitmap[] = [s.progressTrack, s.progressFill];
    for (const hue of NOTE_HUES) {
      all.push(s.note[hue], s.holdBody[hue], s.holdBodyHeld[hue], s.holdCap[hue]);
    }
    const l = computeFieldLayout(683, 384);
    all.push(
      fieldBitmap(l.height, l.hitLineY),
      fieldGlowBitmap(l.height, l.hitLineY),
      backgroundBitmap(200, 120),
    );
    for (const bmp of all) expect(strayColours(bmp)).toEqual([]);
  });

  it('notes have cut corners, a bright top row and two distinct hues', () => {
    const outer = noteBitmap('outer');
    const inner = noteBitmap('inner');
    // 2-pixel cut: the two corner pixels of the top row are empty, the third is set.
    expect(outer.get(0, 0) & 255).toBe(0);
    expect(outer.get(1, 0) & 255).toBe(0);
    expect(outer.get(2, 0) & 255).not.toBe(0);
    expect(outer.get(30, 7)).not.toBe(inner.get(30, 7));
    // The top interior row is the lightest row of the face.
    expect(unpack(outer.get(30, 1)).hex).toBe(PALETTE.find((c) => c === '#dce3ee'));
  });

  it('builds the field at the layout size with an opaque background', () => {
    const l = computeFieldLayout(960, 540);
    const field = fieldBitmap(l.height, l.hitLineY);
    expect(size(field)).toEqual([FIELD_W + 2 * RAIL_W, 540]);
    // The judgement line is opaque; the glass below it is translucent.
    expect(field.get(RAIL_W + 10, l.hitLineY - 1) & 255).toBe(255);
    expect(field.get(RAIL_W + 10, l.hitLineY + 20) & 255).toBeLessThan(170);
    const bg = backgroundBitmap(96, 54);
    for (const c of bg.data) expect(c & 255).toBe(255);
  });
});

describe('micro digits', () => {
  it('are 7 rows tall and only use # and .', () => {
    for (const rows of Object.values(MICRO_DIGITS)) {
      expect(rows).toHaveLength(MICRO_BASELINE);
      for (const r of rows ?? []) expect(r).toMatch(/^[#.]+$/);
    }
  });
});
