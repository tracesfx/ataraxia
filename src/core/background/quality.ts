/**
 * Background quality: the preset sets the background's render scale (of the screen or pixel grid
 * resolution) and the most particles drawn at once;
 * `AdaptiveQuality` steps the preset down during play if the background (or the whole frame) gets
 * too slow. Pure: the caller feeds it measured times.
 */

export const QUALITY_PRESETS = ['high', 'medium', 'low'] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];

export interface QualitySpec {
  /** Render size as a share of the target resolution. */
  renderScale: number;
  /** Most particles drawn at once (all emitters, trails included). */
  particleCap: number;
}

export const QUALITY: Readonly<Record<QualityPreset, QualitySpec>> = {
  high: { renderScale: 1, particleCap: 600 },
  medium: { renderScale: 0.75, particleCap: 400 },
  low: { renderScale: 0.5, particleCap: 200 },
};

export const QUALITY_LABELS: Readonly<Record<QualityPreset, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export function isQualityPreset(v: unknown): v is QualityPreset {
  return typeof v === 'string' && (QUALITY_PRESETS as readonly string[]).includes(v);
}

/** One step down (low stays low). */
export function lowerQuality(q: QualityPreset): QualityPreset {
  return q === 'high' ? 'medium' : 'low';
}

/** Time budget for one background frame (particles and draw calls) at High. */
export const BACKGROUND_BUDGET_MS = 2;

export interface AdaptiveOptions {
  /** Frames averaged before deciding. */
  window?: number;
  /** Background cost (ms per redraw, averaged) above which quality drops. */
  maxCostMs?: number;
  /** Frame interval (ms, averaged) above which quality drops, if the background costs anything. */
  maxFrameMs?: number;
  /** Frames to wait after a drop before judging again (the new level needs time to show). */
  cooldown?: number;
}

/**
 * Steps the quality down when, averaged over `window` frames, the background's redraw costs more
 * than `maxCostMs` (1.5x the 2 ms budget) or the frame interval exceeds `maxFrameMs` (slower than
 * ~45 fps) while the background takes a real share of it. It never steps back up during a song:
 * that would oscillate. Starts from the player's preset.
 */
export class AdaptiveQuality {
  private level: QualityPreset;
  private costSum = 0;
  private frameSum = 0;
  private count = 0;
  private cooldownLeft = 0;
  private readonly window: number;
  private readonly maxCostMs: number;
  private maxFrameMs: number;
  private readonly baseMaxFrameMs: number;
  private readonly cooldown: number;
  /** How many times quality was lowered. */
  drops = 0;

  constructor(
    private preset: QualityPreset,
    o: AdaptiveOptions = {},
  ) {
    this.level = preset;
    this.window = o.window ?? 90;
    this.maxCostMs = o.maxCostMs ?? BACKGROUND_BUDGET_MS * 1.5;
    this.baseMaxFrameMs = o.maxFrameMs ?? 22;
    this.maxFrameMs = this.baseMaxFrameMs;
    this.cooldown = o.cooldown ?? 120;
  }

  get current(): QualityPreset {
    return this.level;
  }

  /** The player picked a preset: start again from it. */
  reset(preset: QualityPreset): void {
    this.preset = preset;
    this.level = preset;
    this.drops = 0;
    this.clear();
    this.cooldownLeft = 0;
  }

  /**
   * The frame interval the player asked for (a capped frame rate): frames are only "slow" when
   * they take clearly longer than that.
   */
  setFrameBudget(expectedFrameMs: number): void {
    const ms = expectedFrameMs > 0 && Number.isFinite(expectedFrameMs) ? expectedFrameMs : 0;
    this.maxFrameMs = Math.max(this.baseMaxFrameMs, ms * 1.35);
  }

  /** The configured preset (before automatic drops). */
  get configured(): QualityPreset {
    return this.preset;
  }

  /**
   * One frame: `costMs` the background spent (0 on frames that only showed the cached layer is
   * fine; average per frame) and the interval since the previous frame. Returns true when the
   * quality just dropped.
   */
  sample(costMs: number, frameMs: number): boolean {
    if (!(costMs >= 0) || !(frameMs > 0) || frameMs > 250) return false; // tab switches, stalls
    if (this.cooldownLeft > 0) {
      this.cooldownLeft -= 1;
      return false;
    }
    this.costSum += costMs;
    this.frameSum += frameMs;
    this.count += 1;
    if (this.count < this.window) return false;
    const cost = this.costSum / this.count;
    const frame = this.frameSum / this.count;
    this.clear();
    const slowBackground = cost > this.maxCostMs;
    const slowFrames = frame > this.maxFrameMs && cost > 0.25 * BACKGROUND_BUDGET_MS;
    if ((slowBackground || slowFrames) && this.level !== 'low') {
      this.level = lowerQuality(this.level);
      this.drops += 1;
      this.cooldownLeft = this.cooldown;
      return true;
    }
    return false;
  }

  private clear(): void {
    this.costSum = 0;
    this.frameSum = 0;
    this.count = 0;
  }
}
