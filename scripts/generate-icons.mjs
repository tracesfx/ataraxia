// Generates the favicons in public/ from the logo mark (src/ui/pixel/logo.ts), so the icon and
// the in-game logo can never drift apart: favicon.svg (rects with crispEdges) and PNGs at 16, 32,
// 48 and 180 (apple-touch-icon, on the steel background). Run with `npm run icons`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { encodePng } from './lib/png.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
try {
  const { logoBitmap } = await server.ssrLoadModule('/src/ui/pixel/logo.ts');
  const { Bitmap, upscale } = await server.ssrLoadModule('/src/ui/pixel/bitmap.ts');
  const { pack } = await server.ssrLoadModule('/src/ui/pixel/color.ts');
  const { RAMPS } = await server.ssrLoadModule('/src/ui/theme.ts');
  const mark = logoBitmap('mark');

  // SVG: one rect per horizontal run of equal colour.
  const hex = (c) => `#${(c >>> 8).toString(16).padStart(6, '0')}`;
  const rects = [];
  for (let y = 0; y < mark.h; y++) {
    let x = 0;
    while (x < mark.w) {
      const c = mark.get(x, y);
      let end = x + 1;
      while (end < mark.w && mark.get(end, y) === c) end++;
      if ((c & 255) !== 0)
        rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(c)}"/>`);
      x = end;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${mark.w} ${mark.h}" shape-rendering="crispEdges">\n${rects.join('\n')}\n</svg>\n`;
  writeFileSync(join(root, 'public', 'favicon.svg'), svg);

  for (const size of [16, 32, 48]) {
    writeFileSync(join(root, 'public', `favicon-${size}.png`), encodePng(upscale(mark, size / 16)));
  }
  // Apple touch icon: opaque, the mark at 10x on the darkest steel with an even margin.
  const touch = new Bitmap(180, 180);
  touch.data.fill(pack(RAMPS.steel[0]));
  const big = upscale(mark, 10);
  for (let y = 0; y < big.h; y++) {
    for (let x = 0; x < big.w; x++) {
      const c = big.get(x, y);
      if ((c & 255) !== 0) touch.set(x + 10, y + 10, c);
    }
  }
  writeFileSync(join(root, 'public', 'apple-touch-icon.png'), encodePng(touch));
  console.log('generate-icons: wrote favicon.svg, favicon-16/32/48.png and apple-touch-icon.png');
} finally {
  await server.close();
}
