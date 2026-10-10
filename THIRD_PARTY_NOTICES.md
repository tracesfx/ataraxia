# Third-party notices

ataraxia ships the following third-party fonts and packages in its builds (`dist/` and
`dist-studio/`). Development tools (Vite, TypeScript, Vitest, ESLint, Prettier, Playwright,
fake-indexeddb) are not shipped. Everything else (code, pixel art, logo, icons, demo song) is
original to this project.

## Fonts

| Font      | Package                      | Version | License                   | Used for                                    |
| --------- | ---------------------------- | ------- | ------------------------- | ------------------------------------------- |
| Jersey 10 | `@fontsource/jersey-10`      | 5.3.0   | SIL Open Font License 1.1 | Menu labels and all gameplay canvas text    |
| Inter     | `@fontsource-variable/inter` | 5.3.0   | SIL Open Font License 1.1 | Menu descriptions, long text and form input |

- Jersey 10: Copyright 2023 The Soft Type Project Authors
  (https://github.com/scfried/soft-type-jersey).
- Inter: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter).

The full SIL Open Font License 1.1 text is included in each package's `LICENSE` file and at
https://openfontlicense.org. The fonts are bundled unmodified (Fontsource's web subsets).

## Packages

| Package          | Version | License | Used for                                                         |
| ---------------- | ------- | ------- | ---------------------------------------------------------------- |
| `fflate`         | 0.8.3   | MIT     | Song packages (.zip) import and export                           |
| `idb`            | 8.0.3   | ISC     | IndexedDB access for the song library                            |
| `music-metadata` | 12.0.0  | MIT     | Studio only: title, artist and artwork from imported audio files |

`music-metadata` is loaded on demand in the Studio build only, with its dependencies (all MIT):
`strtok3`, `token-types`, `file-type`, `debug`, `ms`, `win-guid`, `media-typer`, `content-type`,
`@tokenizer/token`, `uint8array-extras`, `@borewit/text-codec`.

- fflate: Copyright (c) Arjun Barrett. MIT License.
- idb: Copyright (c) 2016, Jake Archibald. ISC License.
- music-metadata: Copyright (c) Borewit. MIT License.

The license texts are in each package's `LICENSE` file in `node_modules`.
