/** Level badge colour tier (index into `SkinPalette.levelTiers`) for a 1-20 chart level. */
export function levelTier(level: number): 0 | 1 | 2 | 3 {
  return level <= 5 ? 0 : level <= 10 ? 1 : level <= 15 ? 2 : 3;
}
