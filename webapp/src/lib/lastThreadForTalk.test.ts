import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getLastThreadForTalk,
  setLastThreadForTalk,
} from './lastThreadForTalk';

describe('lastThreadForTalk', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns null when nothing has been saved', () => {
    expect(getLastThreadForTalk('talk-a')).toBeNull();
  });

  it('round-trips a thread id per-talk', () => {
    setLastThreadForTalk('talk-a', 'thread-1');
    setLastThreadForTalk('talk-b', 'thread-2');
    expect(getLastThreadForTalk('talk-a')).toBe('thread-1');
    expect(getLastThreadForTalk('talk-b')).toBe('thread-2');
  });

  it('overwrites the saved id when called again', () => {
    setLastThreadForTalk('talk-a', 'thread-1');
    setLastThreadForTalk('talk-a', 'thread-2');
    expect(getLastThreadForTalk('talk-a')).toBe('thread-2');
  });
});
