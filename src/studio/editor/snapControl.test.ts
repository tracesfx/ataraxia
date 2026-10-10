import { describe, expect, it } from 'vitest';
import { SNAP_DIVISIONS } from '../../core/time';
import { COMMON_SNAPS, MORE_SNAPS, allSnapChoices, snapLabel, snapSegments } from './snapControl';

describe('snap segments', () => {
  it('offers every division exactly once', () => {
    const all = allSnapChoices();
    expect([...all].sort((a, b) => a - b)).toEqual([...SNAP_DIVISIONS]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('presses the common segment for 1/4, 1/8 and 1/16', () => {
    for (const d of COMMON_SNAPS) {
      expect(snapSegments(d)).toEqual({ common: d, moreLabel: 'more', moreActive: false });
    }
  });

  it('shows other divisions on the "more" button', () => {
    for (const d of MORE_SNAPS) {
      const s = snapSegments(d);
      expect(s.common).toBeNull();
      expect(s.moreActive).toBe(true);
      expect(s.moreLabel).toBe(snapLabel(d));
    }
    expect(snapLabel(12)).toBe('1/12');
  });
});
