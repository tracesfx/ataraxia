/**
 * Cover image geometry (pure): square crops of an image, the crop dialog's pan/zoom view, and
 * the downscale steps used to shrink a crop smoothly to the stored cover size.
 */

/** Stored cover size (square, px). */
export const COVER_SIZE = 512;
/** Stored thumbnail size (square, px) for song lists. */
export const COVER_THUMB_SIZE = 128;
/** Largest zoom the crop dialog allows (1 = the largest square that fits the image). */
export const MAX_CROP_ZOOM = 8;

/** A square crop in source image pixels. */
export interface CropRect {
  x: number;
  y: number;
  size: number;
}

/** The crop dialog's view: a zoom (>= 1) and the crop centre in source pixels. */
export interface CropView {
  zoom: number;
  cx: number;
  cy: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The largest centred square of a `width`x`height` image. */
export function centerSquareCrop(width: number, height: number): CropRect {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

/**
 * A crop made valid for the image: square, at least 1 px, no larger than the shorter side and
 * entirely inside the image (moved in, never shrunk below what fits).
 */
export function clampCrop(rect: CropRect, width: number, height: number): CropRect {
  const maxSize = Math.min(width, height);
  const size = Number.isFinite(rect.size)
    ? clamp(rect.size, Math.min(1, maxSize), maxSize)
    : maxSize;
  const x = Number.isFinite(rect.x) ? clamp(rect.x, 0, width - size) : (width - size) / 2;
  const y = Number.isFinite(rect.y) ? clamp(rect.y, 0, height - size) : (height - size) / 2;
  return { x, y, size };
}

/** The initial view: the whole short side, centred. */
export function initialCropView(width: number, height: number): CropView {
  return { zoom: 1, cx: width / 2, cy: height / 2 };
}

/** A view with its zoom in [1, MAX_CROP_ZOOM] and its centre kept so the crop stays inside. */
export function clampCropView(view: CropView, width: number, height: number): CropView {
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : 1, 1, MAX_CROP_ZOOM);
  const half = Math.min(width, height) / zoom / 2;
  return {
    zoom,
    cx: clamp(view.cx, half, width - half),
    cy: clamp(view.cy, half, height - half),
  };
}

/** The crop rectangle a view selects. */
export function cropFromView(view: CropView, width: number, height: number): CropRect {
  const v = clampCropView(view, width, height);
  const size = Math.min(width, height) / v.zoom;
  return clampCrop({ x: v.cx - size / 2, y: v.cy - size / 2, size }, width, height);
}

/**
 * Pan by a drag of (`dx`, `dy`) screen pixels in a crop frame `frameSize` pixels wide: the image
 * follows the pointer, so the crop centre moves the opposite way.
 */
export function panCropView(
  view: CropView,
  dx: number,
  dy: number,
  frameSize: number,
  width: number,
  height: number,
): CropView {
  const srcPerScreen = Math.min(width, height) / view.zoom / Math.max(1, frameSize);
  return clampCropView(
    { zoom: view.zoom, cx: view.cx - dx * srcPerScreen, cy: view.cy - dy * srcPerScreen },
    width,
    height,
  );
}

/** Change the zoom, keeping the crop centre (then clamped). */
export function zoomCropView(
  view: CropView,
  zoom: number,
  width: number,
  height: number,
): CropView {
  return clampCropView({ ...view, zoom }, width, height);
}

/**
 * Sizes to draw through when shrinking a `from`-pixel square to `to` pixels: halve while more
 * than twice too large, then one last step to `to`. Each step stays within 2x, so bilinear
 * smoothing never skips source pixels (no aliasing). Never upscales beyond `to`; a source
 * smaller than `to` is drawn once at `to`.
 */
export function downscaleSteps(from: number, to: number): number[] {
  const steps: number[] = [];
  let size = Math.max(1, Math.round(from));
  while (size > to * 2) {
    size = Math.ceil(size / 2);
    steps.push(size);
  }
  steps.push(to);
  return steps;
}
