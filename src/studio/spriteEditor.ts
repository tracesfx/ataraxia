import { hexToRgb, rgbToHex } from '../core/background/color';
import { MAX_SPRITE_SIZE } from '../core/background/emitter';
import type { App } from '../ui/app';
import { button, select, textField, toggle } from '../ui/components';
import { el } from '../ui/dom';
import { createFilePicker, downloadBlob } from '../ui/files';
import { openModal } from '../ui/modal';
import type { SceneScope } from '../ui/sceneManager';
import { safeFileName } from '../library/fileNames';
import { RAMPS } from '../ui/theme';

/**
 * The pixel sprite editor (Studio only): a 16x16 or 32x32 grid with draw, erase, flood fill and
 * eyedropper, horizontal mirroring, a palette (white levels that tint cleanly, then the theme
 * ramps, then any colour), undo and redo, previews at 1x, 2x and 4x on dark and light, PNG import
 * and export, and "Save to this song". Resolves with the sprite as a PNG, or null.
 */

export interface SpriteDraft {
  name: string;
  blob: Blob;
}

type Tool = 'draw' | 'erase' | 'fill' | 'pick';
const TOOLS: readonly { id: Tool; label: string; key: string }[] = [
  { id: 'draw', label: 'Draw', key: 'B' },
  { id: 'erase', label: 'Erase', key: 'E' },
  { id: 'fill', label: 'Fill', key: 'G' },
  { id: 'pick', label: 'Pick', key: 'I' },
];

/** White levels first (they tint cleanly), then a few shades of each theme ramp. */
const PALETTE: readonly string[] = [
  '#ffffff',
  '#c8c8c8',
  '#808080',
  ...(['accent', 'iris', 'success', 'warning', 'danger'] as const).flatMap((k) => {
    const r: readonly string[] = RAMPS[k];
    return [r[1], r[Math.floor(r.length / 2)], r[r.length - 1]].filter(
      (c): c is string => c !== undefined,
    );
  }),
];

const VIEW_PX = 384;
const HISTORY_MAX = 80;

/** RGBA pixels of a `size`x`size` sprite. */
class Pixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  constructor(public size: number) {
    this.data = new Uint8ClampedArray(size * size * 4);
  }
  get(x: number, y: number): number {
    const i = (y * this.size + x) * 4;
    const d = this.data;
    return (
      (((d[i] as number) << 24) |
        ((d[i + 1] as number) << 16) |
        ((d[i + 2] as number) << 8) |
        (d[i + 3] as number)) >>>
      0
    );
  }
  set(x: number, y: number, rgba: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    this.data[i] = (rgba >>> 24) & 255;
    this.data[i + 1] = (rgba >>> 16) & 255;
    this.data[i + 2] = (rgba >>> 8) & 255;
    this.data[i + 3] = rgba & 255;
  }
  resize(size: number): void {
    const old = this.data;
    const oldSize = this.size;
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
    const n = Math.min(size, oldSize);
    for (let y = 0; y < n; y++) {
      this.data.set(old.subarray(y * oldSize * 4, (y * oldSize + n) * 4), y * size * 4);
    }
  }
}

const packHex = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex);
  return ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
};

function canvasOf(px: Pixels): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = px.size;
  c.height = px.size;
  c.getContext('2d')?.putImageData(new ImageData(px.data, px.size, px.size), 0, 0);
  return c;
}

function toPng(px: Pixels): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvasOf(px).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Encoding failed.'))),
      'image/png',
    );
  });
}

export async function openSpriteEditor(
  scope: SceneScope,
  app: App,
  initial: SpriteDraft | null = null,
): Promise<SpriteDraft | null> {
  const px = new Pixels(16);
  let name = initial?.name ?? 'My sprite';
  if (initial) {
    try {
      const bmp = await createImageBitmap(initial.blob);
      px.resize(bmp.width > 16 || bmp.height > 16 ? 32 : 16);
      const c = document.createElement('canvas');
      c.width = px.size;
      c.height = px.size;
      const g = c.getContext('2d');
      g?.drawImage(bmp, 0, 0);
      bmp.close();
      const img = g?.getImageData(0, 0, px.size, px.size);
      if (img) px.data.set(img.data);
    } catch {
      // Start empty.
    }
  }

  let tool: Tool = 'draw';
  let colour = '#ffffff';
  let mirror = false;
  const undo: Uint8ClampedArray[] = [];
  const redo: Uint8ClampedArray[] = [];
  const snapshot = (): void => {
    undo.push(px.data.slice());
    if (undo.length > HISTORY_MAX) undo.shift();
    redo.length = 0;
  };

  // --- Grid ----------------------------------------------------------------------------------

  const grid = el('canvas', {
    className: 'sprite-grid',
    attrs: { 'aria-label': 'Sprite pixels', tabindex: '0' },
  });
  grid.width = VIEW_PX;
  grid.height = VIEW_PX;
  const previews = ['dark', 'light'].map((tone) => {
    const c = el('canvas', { className: `sprite-preview sprite-preview--${tone}` });
    c.width = 7 * 32 + 16;
    c.height = 4 * 32 + 8;
    return c;
  });

  const redraw = (): void => {
    const g = grid.getContext('2d');
    if (!g) return;
    const cell = VIEW_PX / px.size;
    g.imageSmoothingEnabled = false;
    // A flat dark ground shows transparent pixels.
    g.fillStyle = RAMPS.steel[2];
    g.fillRect(0, 0, VIEW_PX, VIEW_PX);
    g.drawImage(canvasOf(px), 0, 0, VIEW_PX, VIEW_PX);
    g.fillStyle = 'rgba(0, 0, 0, 0.25)';
    for (let i = 1; i < px.size; i++) {
      g.fillRect(Math.round(i * cell), 0, 1, VIEW_PX);
      g.fillRect(0, Math.round(i * cell), VIEW_PX, 1);
    }
    if (mirror) {
      g.fillStyle = RAMPS.accent[5] as string;
      g.fillRect(VIEW_PX / 2 - 1, 0, 2, VIEW_PX);
    }
    const sprite = canvasOf(px);
    previews.forEach((c, k) => {
      const p = c.getContext('2d');
      if (!p) return;
      p.imageSmoothingEnabled = false;
      p.fillStyle = k === 0 ? (RAMPS.steel[0] as string) : RAMPS.steel[8];
      p.fillRect(0, 0, c.width, c.height);
      let x = 8;
      for (const s of [1, 2, 4]) {
        const d = px.size * s;
        p.drawImage(sprite, x, Math.round((c.height - d) / 2), d, d);
        x += d + 8;
      }
    });
  };

  const cellAt = (e: PointerEvent): [number, number] => {
    const r = grid.getBoundingClientRect();
    return [
      Math.floor(((e.clientX - r.left) / r.width) * px.size),
      Math.floor(((e.clientY - r.top) / r.height) * px.size),
    ];
  };
  const paint = (x: number, y: number, value: number): void => {
    px.set(x, y, value);
    if (mirror) px.set(px.size - 1 - x, y, value);
  };
  const fill = (x: number, y: number, value: number): void => {
    const target = px.get(x, y);
    if (target === value) return;
    const stack: [number, number][] = [[x, y]];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) break;
      const [cx, cy] = next;
      if (cx < 0 || cy < 0 || cx >= px.size || cy >= px.size || px.get(cx, cy) !== target) continue;
      paint(cx, cy, value);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  };
  let drawing = false;
  const apply = (e: PointerEvent): void => {
    const [x, y] = cellAt(e);
    if (x < 0 || y < 0 || x >= px.size || y >= px.size) return;
    if (tool === 'pick') {
      const v = px.get(x, y);
      if ((v & 255) > 0)
        setColour(rgbToHex({ r: v >>> 24, g: (v >>> 16) & 255, b: (v >>> 8) & 255 }));
      return;
    }
    if (tool === 'fill') fill(x, y, packHex(colour));
    else paint(x, y, tool === 'erase' ? 0 : packHex(colour));
    redraw();
  };
  scope.listen(grid, 'pointerdown', (e) => {
    e.preventDefault();
    if (tool !== 'pick') snapshot();
    drawing = tool === 'draw' || tool === 'erase';
    grid.setPointerCapture(e.pointerId);
    apply(e);
    refresh();
  });
  scope.listen(grid, 'pointermove', (e) => {
    if (drawing) apply(e);
  });
  scope.listen(grid, 'pointerup', () => {
    drawing = false;
  });
  scope.listen(grid, 'contextmenu', (e) => e.preventDefault());

  // --- Controls ------------------------------------------------------------------------------

  const toolButtons = TOOLS.map((t) => {
    const b = button(scope, {
      label: t.label,
      hint: t.key,
      variant: 'secondary',
      onClick: () => {
        tool = t.id;
        refresh();
      },
    });
    b.dataset['tool'] = t.id;
    return b;
  });
  const mirrorToggle = toggle(scope, {
    label: 'Mirror',
    checked: false,
    onChange: (v) => {
      mirror = v;
      redraw();
    },
  });
  const colourInput = el('input', {
    className: 'bg-color',
    attrs: { type: 'color', 'aria-label': 'Colour' },
  });
  colourInput.value = colour;
  const swatches = PALETTE.map((hex) => {
    const b = el('button', {
      className: 'sprite-swatch',
      attrs: { type: 'button', 'aria-label': hex, title: hex },
    });
    b.style.background = hex;
    scope.listen(b, 'click', () => setColour(hex));
    return b;
  });
  function setColour(hex: string): void {
    colour = hex.toLowerCase();
    colourInput.value = colour;
    if (tool === 'pick' || tool === 'erase') tool = 'draw';
    refresh();
  }
  scope.listen(colourInput, 'input', () => setColour(colourInput.value));

  const sizeSelect = select<number>(scope, {
    label: 'Grid size',
    options: [
      { value: 16, label: '16x16' },
      { value: 32, label: '32x32' },
    ],
    value: px.size,
    onChange: (v) => {
      snapshot();
      px.resize(v);
      redraw();
    },
  });
  const step = (from: Uint8ClampedArray[], to: Uint8ClampedArray[]): void => {
    const s = from.pop();
    if (!s) return;
    to.push(px.data.slice());
    const size = Math.round(Math.sqrt(s.length / 4));
    if (size !== px.size) {
      px.resize(size);
      sizeSelect.set(size);
    }
    px.data.set(s);
    redraw();
    refresh();
  };
  const undoButton = button(scope, {
    label: 'Undo',
    icon: 'undo',
    onClick: () => step(undo, redo),
  });
  const redoButton = button(scope, {
    label: 'Redo',
    icon: 'redo',
    onClick: () => step(redo, undo),
  });
  const clearButton = button(scope, {
    label: 'Clear',
    icon: 'trash',
    variant: 'ghost',
    onClick: () => {
      snapshot();
      px.data.fill(0);
      redraw();
      refresh();
    },
  });

  const message = el('p', { className: 'setting-desc', attrs: { 'aria-live': 'polite' } });
  const picker = createFilePicker(scope, app.ui, (files) => {
    const [file] = files;
    if (!file) return;
    void createImageBitmap(file).then(
      (bmp) => {
        if (bmp.width > 32 || bmp.height > 32) {
          message.textContent = `"${file.name}" is ${bmp.width}x${bmp.height}; the editor works on at most 32x32. Pictures up to ${MAX_SPRITE_SIZE}x${MAX_SPRITE_SIZE} can still be added with Import PNG in the background editor.`;
          bmp.close();
          return;
        }
        snapshot();
        const size = bmp.width > 16 || bmp.height > 16 ? 32 : 16;
        px.resize(size);
        px.data.fill(0);
        sizeSelect.set(size);
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const g = c.getContext('2d');
        g?.drawImage(bmp, 0, 0);
        bmp.close();
        const img = g?.getImageData(0, 0, size, size);
        if (img) px.data.set(img.data);
        message.textContent = `Imported "${file.name}".`;
        redraw();
        refresh();
      },
      () => {
        message.textContent = `"${file.name}" could not be read as a picture. Choose a PNG.`;
      },
    );
  });
  const importButton = button(scope, {
    label: 'Import PNG',
    icon: 'import',
    onClick: () => picker.open('image/png', 'sprite'),
  });
  const exportButton = button(scope, {
    label: 'Export PNG',
    icon: 'export',
    onClick: () => {
      void toPng(px).then((blob) => downloadBlob(blob, `${safeFileName(name, 'sprite')}.png`));
    },
  });
  const nameField = textField(scope, {
    label: 'Sprite name',
    value: name,
    onInput: (v) => {
      name = v;
    },
  });

  const refresh = (): void => {
    for (const b of toolButtons) {
      const on = b.dataset['tool'] === tool;
      b.classList.toggle('btn--primary', on);
      b.classList.toggle('btn--secondary', !on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const s of swatches) s.classList.toggle('is-on', s.title === colour);
    undoButton.disabled = undo.length === 0;
    redoButton.disabled = redo.length === 0;
  };

  const body = el('div', { className: 'sprite-editor' }, [
    el('div', { className: 'sprite-canvas' }, [grid]),
    el('div', { className: 'sprite-side' }, [
      el('div', { className: 'setting-buttons' }, toolButtons),
      el('div', { className: 'bg-inline' }, [
        el('span', { className: 't-label', text: 'Mirror' }),
        mirrorToggle.root,
        el('span', { className: 't-label', text: 'Grid' }),
        sizeSelect.root,
      ]),
      el('div', { className: 'sprite-swatches' }, [
        ...swatches,
        el('span', { className: 'field bg-color-field' }, [colourInput]),
      ]),
      el('p', {
        className: 'setting-desc',
        text: 'White and grey sprites take the emitter colour best; coloured pixels are tinted too.',
      }),
      el('div', { className: 'setting-buttons' }, [undoButton, redoButton, clearButton]),
      el('span', { className: 't-label', text: 'Preview at 1x, 2x and 4x' }),
      ...previews,
      el('div', { className: 'setting-buttons' }, [importButton, exportButton]),
      nameField.root,
      message,
    ]),
  ]);
  scope.listen(body, 'keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) step(redo, undo);
      else step(undo, redo);
    } else if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      step(redo, undo);
    } else if (!ctrl) {
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) {
        tool = t.id;
        refresh();
      }
    }
  });
  redraw();
  refresh();

  let result: Blob | null = null;
  const saved = await openModal(scope, app.ui, {
    title: initial ? `Sprite: ${initial.name}` : 'New sprite',
    className: 'sprite-dialog',
    body: [body],
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Save to this song', value: true, primary: true },
    ],
    cancelValue: false,
    validate: async () => {
      if (!px.data.some((v, i) => i % 4 === 3 && v > 0)) {
        return ['The sprite is empty. Draw at least one pixel, or cancel.'];
      }
      if (name.trim() === '') return ['Give the sprite a name.'];
      result = await toPng(px);
      return [];
    },
  });
  return saved && result ? { name: name.trim().slice(0, 40), blob: result } : null;
}
