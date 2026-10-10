import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { GAME_TITLE, STUDIO_TITLE } from './src/core/constants.ts';


/**
 * Two builds from one codebase (see docs/architecture.md):
 * - Player (`vite build`, `vite --mode player`, `vite preview`): `__STUDIO__` is false, so everything behind
 *   `if (__STUDIO__)` (the editor and every creation tool in src/studio) is dropped.
 * - Studio (`vite` dev server, `vite build --mode studio`, `vite preview --mode studio`):
 *   `__STUDIO__` is true.
 */
export default defineConfig(({ command, mode, isPreview }) => {
  // The dev server defaults to Studio; `vite preview` serves the player build unless --mode studio.
  const studio = mode === 'studio' || (command === 'serve' && !isPreview && mode !== 'player');
  const title = studio ? STUDIO_TITLE : GAME_TITLE;
  const env = loadEnv(mode, '.', 'VITE_');

  return {
    base: env.VITE_BASE ?? '/',
    define: {
      __STUDIO__: JSON.stringify(studio),
    },
    build: {
      target: 'es2022',
      outDir: studio ? 'dist-studio' : 'dist',
    },
    plugins: [
      {
        name: 'game-title',
        // Keeps the <title> in index.html in sync with the title constants.
        transformIndexHtml: (html: string) => html.replaceAll('%GAME_TITLE%', title),
      },
    ],
    test: {
      include: ['src/**/*.test.ts'],
      environment: 'node',
    },
  };
});
