import { SNAP_DIVISIONS, type SnapDivision } from '../../core/time';

/**
 * The transport bar's snap control: a segmented control with the common divisions and a "more"
 * dropdown with the rest. Pure, so the mapping is tested.
 */
export const COMMON_SNAPS = [4, 8, 16] as const satisfies readonly SnapDivision[];
export const MORE_SNAPS = [3, 6, 12, 2, 1] as const satisfies readonly SnapDivision[];

export function snapLabel(division: number): string {
  return `1/${division}`;
}

export interface SnapSegments {
  /** The pressed segment, or null when the snap is in the "more" list. */
  common: SnapDivision | null;
  /** The "more" button's label: the current snap when it is one of the extra values. */
  moreLabel: string;
  moreActive: boolean;
}

export function snapSegments(snap: SnapDivision): SnapSegments {
  const common = (COMMON_SNAPS as readonly number[]).includes(snap) ? snap : null;
  return {
    common,
    moreLabel: common === null ? snapLabel(snap) : 'more',
    moreActive: common === null,
  };
}

/** Every snap division appears exactly once across the two lists (checked by the tests). */
export function allSnapChoices(): SnapDivision[] {
  return [...COMMON_SNAPS, ...MORE_SNAPS].filter((d) => SNAP_DIVISIONS.includes(d));
}
