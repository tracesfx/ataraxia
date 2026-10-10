/**
 * Compile-time build flag (Vite `define`, see vite.config.ts). True in the Studio build and the
 * default dev server; false in the player build, where code behind `if (__STUDIO__)` is removed.
 */
declare const __STUDIO__: boolean;
