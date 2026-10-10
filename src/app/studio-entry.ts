/**
 * The only door from player code into src/studio (ESLint enforces this). main.ts imports this
 * file dynamically inside `if (__STUDIO__)`, so in the player build the import is dead code and
 * no Studio chunk is emitted. See docs/architecture.md.
 */
export { installStudio } from '../studio';
