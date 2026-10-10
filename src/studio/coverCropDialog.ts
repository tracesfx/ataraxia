import './studio.css';
import {
  MAX_CROP_ZOOM,
  clampCropView,
  cropFromView,
  initialCropView,
  panCropView,
  zoomCropView,
  type CropRect,
  type CropView,
} from '../core/coverCrop';
import { decodeCoverImage, type DecodedImage } from '../library/cover';
import { slider } from '../ui/components';
import { el } from '../ui/dom';
import { openModal } from '../ui/modal';
import type { SceneScope } from '../ui/sceneManager';

/** Arrow keys pan by this fraction of the frame; +/- zoom by this factor. */
const KEY_PAN = 0.05;
const KEY_ZOOM = 1.15;
/** Slider positions (log scale from zoom 1 to MAX_CROP_ZOOM). */
const SLIDER_STEPS = 200;

const zoomOfSlider = (v: number): number => MAX_CROP_ZOOM ** (v / SLIDER_STEPS);
const sliderOfZoom = (zoom: number): number =>
  Math.round((Math.log(zoom) / Math.log(MAX_CROP_ZOOM)) * SLIDER_STEPS);

/** Draw the crop of `image` into `canvas` at its displayed size (device pixels), smoothly. */
function paint(canvas: HTMLCanvasElement, image: DecodedImage, crop: CropRect): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(1, Math.round(Math.max(rect.width, rect.height) * dpr));
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(
    image as unknown as CanvasImageSource,
    crop.x,
    crop.y,
    crop.size,
    crop.size,
    0,
    0,
    size,
    size,
  );
}

/**
 * The crop dialog: a square frame showing exactly what the cover will be (drag to pan, wheel,
 * slider or +/- to zoom, arrow keys to pan), with live previews at list and panel size inside
 * the cover frame. Resolves with the chosen square in source pixels, or null when cancelled.
 * Decoding problems are thrown as LibraryErrors before the dialog opens.
 */
export async function openCoverCropDialog(
  scope: SceneScope,
  host: HTMLElement,
  file: Blob,
  name?: string,
): Promise<CropRect | null> {
  const image = await decodeCoverImage(file, name);
  try {
    if (scope.disposed) return null;
    const { width, height } = image;
    let view: CropView = initialCropView(width, height);

    const frame = el('canvas', {
      className: 'crop-frame ring',
      attrs: {
        tabindex: '0',
        role: 'img',
        'aria-label': 'Cover crop. Drag or use the arrow keys to move, wheel or + and - to zoom.',
      },
    });
    const previewCanvases = [
      el('canvas', { className: 'cover-img cover-photo' }),
      el('canvas', { className: 'cover-img cover-photo' }),
    ];
    const previews = el('div', { className: 'crop-previews' }, [
      el('div', { className: 'cover cover--medium has-photo' }, [
        previewCanvases[0] as HTMLCanvasElement,
      ]),
      el('div', { className: 'cover cover--thumb has-photo' }, [
        previewCanvases[1] as HTMLCanvasElement,
      ]),
    ]);

    const redraw = (): void => {
      const crop = cropFromView(view, width, height);
      paint(frame, image, crop);
      for (const c of previewCanvases) paint(c, image, crop);
    };
    const zoom = slider(scope, {
      label: 'Zoom',
      min: 0,
      max: SLIDER_STEPS,
      step: 1,
      value: 0,
      format: (v) => `${zoomOfSlider(v).toFixed(1)}x`,
      onInput: (v) => {
        view = zoomCropView(view, zoomOfSlider(v), width, height);
        redraw();
      },
    });
    const setView = (next: CropView): void => {
      view = clampCropView(next, width, height);
      zoom.set(sliderOfZoom(view.zoom));
      redraw();
    };

    // Drag to pan.
    let drag: { id: number; x: number; y: number } | null = null;
    scope.listen(frame, 'pointerdown', (e) => {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      frame.setPointerCapture(e.pointerId);
      frame.classList.add('is-dragging');
      frame.focus();
    });
    scope.listen(frame, 'pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const size = frame.getBoundingClientRect().width;
      view = panCropView(view, e.clientX - drag.x, e.clientY - drag.y, size, width, height);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      redraw();
    });
    const endDrag = (e: PointerEvent): void => {
      if (drag?.id !== e.pointerId) return;
      drag = null;
      frame.classList.remove('is-dragging');
    };
    scope.listen(frame, 'pointerup', endDrag);
    scope.listen(frame, 'pointercancel', endDrag);
    scope.listen(
      frame,
      'wheel',
      (e) => {
        e.preventDefault();
        setView({ ...view, zoom: view.zoom * Math.exp(-e.deltaY * 0.0015) });
      },
      { passive: false },
    );
    scope.listen(frame, 'keydown', (e) => {
      const size = frame.getBoundingClientRect().width;
      const step = size * KEY_PAN;
      const pans: Record<string, [number, number]> = {
        ArrowLeft: [step, 0],
        ArrowRight: [-step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      };
      const pan = pans[e.key];
      if (pan) {
        view = panCropView(view, pan[0], pan[1], size, width, height);
        redraw();
      } else if (e.key === '+' || e.key === '=') {
        setView({ ...view, zoom: view.zoom * KEY_ZOOM });
      } else if (e.key === '-' || e.key === '_') {
        setView({ ...view, zoom: view.zoom / KEY_ZOOM });
      } else if (e.key === '0') {
        setView(initialCropView(width, height));
      } else {
        return;
      }
      e.preventDefault();
    });

    const body = el('div', { className: 'crop-dialog' }, [
      frame,
      el('div', { className: 'crop-side' }, [
        el('p', { className: 'crop-label t-label', text: 'Preview' }),
        previews,
        el('p', { className: 'crop-label t-label', text: 'Zoom' }),
        zoom.root,
        el('p', {
          className: 'crop-help',
          text: 'Drag the picture to move it. Use the wheel, the slider or + and - to zoom.',
        }),
      ]),
    ]);
    const result = openModal(scope, host, {
      title: 'Crop cover',
      className: 'modal--crop',
      body: [body],
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'Apply', value: true, primary: true },
      ],
      cancelValue: false,
    });
    // The dialog is open (and laid out) now: the canvases take their size from CSS.
    redraw();
    const applied = await result;
    return applied ? cropFromView(view, width, height) : null;
  } finally {
    image.close();
  }
}
