import { describe, expect, it } from 'vitest';
import { DEFAULT_LANE_KEYS, rebindLane } from '../core/settings';
import { capText, keyCap, keyCaps, laneKeyCaps } from './keyHints';

describe('key hints', () => {
  it('shows the lane keys from the binding config', () => {
    expect(laneKeyCaps(DEFAULT_LANE_KEYS).map(capText)).toEqual(['S', 'D', 'J', 'K']);
    const rebound = rebindLane(DEFAULT_LANE_KEYS, 1, 'Semicolon');
    if (!rebound.ok) throw new Error(rebound.error);
    expect(laneKeyCaps(rebound.keys).map(capText)).toEqual(['S', ';', 'J', 'K']);
  });

  it('uses lowercase words and arrow icons for named keys', () => {
    expect(keyCap('Escape')).toEqual({ text: 'esc' });
    expect(keyCap('Enter')).toEqual({ text: 'enter' });
    expect(keyCap('Space')).toEqual({ text: 'space' });
    expect(keyCap('ArrowUp')).toEqual({ icon: 'chevron-up' });
    expect(keyCap('F2')).toEqual({ text: 'f2' });
    expect(keyCap('Digit3')).toEqual({ text: '3' });
    expect(keyCap('/')).toEqual({ text: '/' });
  });

  it('splits combinations into caps', () => {
    expect(keyCaps('Ctrl+O').map(capText)).toEqual(['ctrl', 'O']);
    expect(keyCaps('Ctrl+KeyP').map(capText)).toEqual(['ctrl', 'P']);
  });
});
