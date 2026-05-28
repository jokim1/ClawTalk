import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearThreadScroll,
  loadThreadScroll,
  saveThreadScroll,
} from './threadScroll';

describe('threadScroll', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns null when no state was saved', () => {
    expect(loadThreadScroll('talk-a', 'thread-1')).toBeNull();
  });

  it('round-trips per (talkId, threadId)', () => {
    saveThreadScroll('talk-a', 'thread-1', { offset: 240, atBottom: false });
    saveThreadScroll('talk-a', 'thread-2', { offset: 0, atBottom: true });
    saveThreadScroll('talk-b', 'thread-1', { offset: 99, atBottom: false });
    expect(loadThreadScroll('talk-a', 'thread-1')).toEqual({
      offset: 240,
      atBottom: false,
    });
    expect(loadThreadScroll('talk-a', 'thread-2')).toEqual({
      offset: 0,
      atBottom: true,
    });
    expect(loadThreadScroll('talk-b', 'thread-1')).toEqual({
      offset: 99,
      atBottom: false,
    });
  });

  it('overwrites the saved state on repeat save', () => {
    saveThreadScroll('talk-a', 'thread-1', { offset: 10, atBottom: false });
    saveThreadScroll('talk-a', 'thread-1', { offset: 999, atBottom: true });
    expect(loadThreadScroll('talk-a', 'thread-1')).toEqual({
      offset: 999,
      atBottom: true,
    });
  });

  it('clamps negative offsets to zero', () => {
    saveThreadScroll('talk-a', 'thread-1', { offset: -50, atBottom: false });
    expect(loadThreadScroll('talk-a', 'thread-1')?.offset).toBe(0);
  });

  it('returns null for corrupt JSON', () => {
    window.localStorage.setItem('clawtalk.scroll:talk-a:thread-1', '{not json');
    expect(loadThreadScroll('talk-a', 'thread-1')).toBeNull();
  });

  it('returns null when atBottom is missing', () => {
    window.localStorage.setItem(
      'clawtalk.scroll:talk-a:thread-1',
      JSON.stringify({ offset: 100 }),
    );
    expect(loadThreadScroll('talk-a', 'thread-1')).toBeNull();
  });

  it('clearThreadScroll removes the saved entry', () => {
    saveThreadScroll('talk-a', 'thread-1', { offset: 120, atBottom: false });
    clearThreadScroll('talk-a', 'thread-1');
    expect(loadThreadScroll('talk-a', 'thread-1')).toBeNull();
  });
});
