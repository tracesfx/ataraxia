/**
 * Cosmetic animation curves. Pure functions of an age in ms that return plain numbers (no
 * allocation), so the renderer can call them every frame and tests can pin them. Offsets are
 * whole logical pixels and fades move in a few flat alpha
 * steps, like the rest of the art.
 */

/** Judgement text: on screen for POPUP_HOLD_MS, then fades out over POPUP_FADE_OUT_MS. */
export const POPUP_HOLD_MS = 300;
export const POPUP_FADE_OUT_MS = 200;
export const POPUP_MS = POPUP_HOLD_MS + POPUP_FADE_OUT_MS;
/** Simple fade-in (Good, and every judgement in the simple style): 3 steps. */
export const POPUP_FADE_IN_MS = 48;
/** The text rises into place from this many pixels below, one pixel per step (Perfect, Great). */
export const POPUP_RISE_PX = 3;
export const POPUP_RISE_STEP_MS = 20;

/** Vertical offset of the judgement text (positive = down): 3, 2, 1, then 0. */
export function popupOffsetY(ageMs: number): number {
  if (ageMs < 0) return 0;
  return Math.max(0, POPUP_RISE_PX - Math.floor(ageMs / POPUP_RISE_STEP_MS));
}

/**
 * Judgement text opacity: solid at once (`fadeIn` false) or in 3 steps, solid until
 * POPUP_HOLD_MS, then 4 steps out. 0 means "don't draw".
 */
export function popupAlpha(ageMs: number, fadeIn = false): number {
  if (ageMs < 0 || ageMs >= POPUP_MS) return 0;
  if (fadeIn && ageMs < POPUP_FADE_IN_MS)
    return (Math.floor((ageMs / POPUP_FADE_IN_MS) * 3) + 1) / 4; // 0.25, 0.5, 0.75
  if (ageMs < POPUP_HOLD_MS) return 1;
  const k = Math.floor(((ageMs - POPUP_HOLD_MS) / POPUP_FADE_OUT_MS) * 4);
  return (4 - k) / 4; // 1, 0.75, 0.5, 0.25
}

/** Miss: a 2-pixel sideways jitter for about 100 ms (4 steps of 25 ms). */
export const MISS_JITTER_MS = 100;
export const MISS_JITTER_PX = 2;

export function missJitterX(ageMs: number): number {
  if (ageMs < 0 || ageMs >= MISS_JITTER_MS) return 0;
  return Math.floor(ageMs / 25) % 2 === 0 ? MISS_JITTER_PX : -MISS_JITTER_PX;
}

/** Combo bump on each increment: 2 pixels up, then 1, then rest. */
export const COMBO_BUMP_MS = 80;

export function comboBumpOffsetY(ageMs: number): number {
  if (ageMs < 0 || ageMs >= COMBO_BUMP_MS) return 0;
  return ageMs < COMBO_BUMP_MS / 2 ? -2 : -1;
}

/**
 * Combo break: the old number turns steel and shakes sideways for COMBO_BREAK_HOLD_MS, then
 * fades out in 2 steps (COMBO_SHAKE_MS in total).
 */
export const COMBO_BREAK_HOLD_MS = 150;
export const COMBO_SHAKE_MS = 230;
export const COMBO_SHAKE_PX = 2;
export const COMBO_SHAKE_STEP_MS = 30;

export function comboShakeOffsetX(ageMs: number): number {
  if (ageMs < 0 || ageMs >= COMBO_SHAKE_MS) return 0;
  const step = Math.floor(ageMs / COMBO_SHAKE_STEP_MS);
  const amplitude = ageMs < COMBO_BREAK_HOLD_MS / 2 ? COMBO_SHAKE_PX : 1;
  return step % 2 === 0 ? amplitude : -amplitude;
}

/** Opacity of the broken combo: solid, then 2 steps out. */
export function comboBreakAlpha(ageMs: number): number {
  if (ageMs < 0 || ageMs >= COMBO_SHAKE_MS) return 0;
  if (ageMs < COMBO_BREAK_HOLD_MS) return 1;
  return ageMs < (COMBO_BREAK_HOLD_MS + COMBO_SHAKE_MS) / 2 ? 0.66 : 0.33;
}

/** Combo colour tier cross-fade (about 150 ms, 3 alpha steps). */
export const TIER_FADE_MS = 150;

export function tierFadeAlpha(ageMs: number): number {
  if (ageMs < 0) return 0;
  if (ageMs >= TIER_FADE_MS) return 1;
  return (Math.floor((ageMs / TIER_FADE_MS) * 3) + 1) / 4; // 0.25, 0.5, 0.75
}

/** Opacity of notes that can no longer be hit (missed taps, dropped holds). */
export const DIMMED_NOTE_ALPHA = 0.32;
/** Opacity of the combo digits (they sit behind the notes). */
export const COMBO_ALPHA = 0.85;
