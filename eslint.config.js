// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'dist-studio/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.browser, __STUDIO__: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Rule 2: src/core stays pure — no DOM or Web Audio.
    files: ['src/core/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'AudioContext',
        'requestAnimationFrame',
        'setTimeout',
        'setInterval',
        'localStorage',
        'indexedDB',
      ],
    },
  },
  {
    // Seeded determinism (Phases 13 and 15): the analysis, the backgrounds and the chart generator take all randomness
    // from one seeded Rng (src/core/random.ts), never Math.random, so a seed reproduces a chart.
    files: [
      'src/core/analysis/**/*.ts',
      'src/core/background/**/*.ts',
      'src/render/background/**/*.ts',
      'src/studio/charting/**/*.ts',
      'src/core/random.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Use the seeded Rng from src/core/random.ts so generated charts are reproducible.',
        },
      ],
    },
  },
  {
    // Studio isolation: player code never imports src/studio. The only door is the dynamic
    // import in src/app/studio-entry.ts, which main.ts loads behind `if (__STUDIO__)`.
    files: ['src/**/*.ts'],
    ignores: ['src/studio/**', 'src/app/studio-entry.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/studio', '**/studio/**'],
              message:
                'Only src/app/studio-entry.ts may import src/studio (see docs/architecture.md).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
