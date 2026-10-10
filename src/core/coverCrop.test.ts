import { describe, expect, it } from 'vitest';
import {
  MAX_CROP_ZOOM,
  centerSquareCrop,
  clampCrop,
  clampCropView,
  cropFromView,
  downscaleSteps,
  initialCropView,
  panCropView,
  zoomCropView,
} from './coverCrop';

describe('centerSquareCrop', () => {
  it('takes the centred short side of a landscape image', () => {
    expect(centerSquareCrop(1920, 1080)).toEqual({ x: 420, y: 0, size: 1080 });
  });
  it('takes the centred short side of a portrait image', () => {
    expect(centerSquareCrop(600, 1000)).toEqual({ x: 0, y: 200, size: 600 });
  });
  it('keeps a square image whole', () => {
    expect(centerSquareCrop(512, 512)).toEqual({ x: 0, y: 0, size: 512 });
  });
});

describe('clampCrop', () => {
  it('moves a crop back inside the image', () => {
    expect(clampCrop({ x: -50, y: 900, size: 300 }, 1000, 1000)).toEqual({
      x: 0,
      y: 700,
      size: 300,
    });
  });
  it('shrinks a crop larger than the short side', () => {
    expect(clampCrop({ x: 0, y: 0, size: 5000 }, 800, 600)).toEqual({ x: 0, y: 0, size: 600 });
  });
  it('replaces non-finite values with a centred crop', () => {
    expect(clampCrop({ x: NaN, y: Infinity, size: NaN }, 800, 600)).toEqual({
      x: 100,
      y: 0,
      size: 600,
    });
  });
});

describe('crop view', () => {
  it('starts with the whole short side', () => {
    const v = initialCropView(1600, 900);
    expect(cropFromView(v, 1600, 900)).toEqual({ x: 350, y: 0, size: 900 });
  });

  it('zooming in shrinks the crop around its centre', () => {
    const v = zoomCropView(initialCropView(1000, 1000), 2, 1000, 1000);
    expect(cropFromView(v, 1000, 1000)).toEqual({ x: 250, y: 250, size: 500 });
  });

  it('clamps the zoom to [1, MAX_CROP_ZOOM]', () => {
    expect(clampCropView({ zoom: 0.2, cx: 50, cy: 50 }, 100, 100).zoom).toBe(1);
    expect(clampCropView({ zoom: 99, cx: 50, cy: 50 }, 100, 100).zoom).toBe(MAX_CROP_ZOOM);
  });

  it('panning follows the pointer and stops at the image edge', () => {
    const start = zoomCropView(initialCropView(1000, 1000), 2, 1000, 1000);
    // Frame 250 px wide shows 500 source px: 1 screen px = 2 source px.
    const moved = panCropView(start, 50, 0, 250, 1000, 1000);
    expect(moved.cx).toBe(400);
    const far = panCropView(start, 10_000, -10_000, 250, 1000, 1000);
    expect(cropFromView(far, 1000, 1000)).toEqual({ x: 0, y: 500, size: 500 });
  });

  it('at zoom 1 a landscape image pans only horizontally', () => {
    const v = panCropView(initialCropView(2000, 1000), -100, 300, 100, 2000, 1000);
    expect(v.cy).toBe(500);
    expect(v.cx).toBe(1500);
    expect(cropFromView(v, 2000, 1000)).toEqual({ x: 1000, y: 0, size: 1000 });
  });

  it('zooming out keeps the crop inside the image', () => {
    const zoomed = { zoom: 4, cx: 990, cy: 10 };
    const out = zoomCropView(zoomed, 1, 1000, 1000);
    expect(cropFromView(out, 1000, 1000)).toEqual({ x: 0, y: 0, size: 1000 });
  });
});

describe('downscaleSteps', () => {
  it('halves until within 2x of the target', () => {
    expect(downscaleSteps(4000, 512)).toEqual([2000, 1000, 512]);
  });
  it('goes straight to the target when already within 2x', () => {
    expect(downscaleSteps(900, 512)).toEqual([512]);
    expect(downscaleSteps(512, 512)).toEqual([512]);
  });
  it('draws a small source once at the target size', () => {
    expect(downscaleSteps(64, 512)).toEqual([512]);
  });
  it('makes a 128 thumbnail from a 512 cover in two halvings', () => {
    expect(downscaleSteps(512, 128)).toEqual([256, 128]);
  });
});
