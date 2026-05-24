import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getContentSplitRatio,
  setContentSplitRatio,
} from './contentSplitRatio';

describe('contentSplitRatio', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns 0.5 when nothing is stored', () => {
    expect(getContentSplitRatio('talk-a')).toBe(0.5);
  });

  it('round-trips a per-Talk ratio under a Talk-scoped key', () => {
    setContentSplitRatio('talk-a', 0.7);
    expect(getContentSplitRatio('talk-a')).toBe(0.7);
    expect(getContentSplitRatio('talk-b')).toBe(0.5);
    expect(window.localStorage.getItem('clawtalk.contentSplitRatio:talk-a')).toBe(
      '0.7',
    );
  });

  it('seeds a Talk-scoped key from the legacy global key on first read', () => {
    window.localStorage.setItem('clawtalk.contentSplitRatio', '0.35');
    expect(getContentSplitRatio('talk-a')).toBe(0.35);
    expect(
      window.localStorage.getItem('clawtalk.contentSplitRatio:talk-a'),
    ).toBe('0.35');
    setContentSplitRatio('talk-a', 0.6);
    expect(getContentSplitRatio('talk-a')).toBe(0.6);
    expect(window.localStorage.getItem('clawtalk.contentSplitRatio')).toBe(
      '0.35',
    );
  });

  it('clamps stored values to the [0.2, 0.8] range', () => {
    setContentSplitRatio('talk-a', 0.05);
    expect(getContentSplitRatio('talk-a')).toBe(0.2);
    setContentSplitRatio('talk-b', 1.5);
    expect(getContentSplitRatio('talk-b')).toBe(0.8);
  });

  it('falls back to the default for non-numeric stored values', () => {
    window.localStorage.setItem(
      'clawtalk.contentSplitRatio:talk-a',
      'not-a-number',
    );
    expect(getContentSplitRatio('talk-a')).toBe(0.5);
  });
});
