import { describe, expect, it } from 'vitest';

import { formatStrippedTags } from './sanitize-warn';

describe('formatStrippedTags', () => {
  it('returns empty string for empty arrays', () => {
    expect(formatStrippedTags([])).toBe('');
  });

  it('uses singular "tag" for a single occurrence', () => {
    expect(formatStrippedTags([{ tag: 'script', count: 1 }])).toBe(
      'Stripped 1 tag: <script>',
    );
  });

  it('pluralizes "tags" for multiple occurrences', () => {
    expect(
      formatStrippedTags([
        { tag: 'script', count: 1 },
        { tag: 'iframe', count: 2 },
      ]),
    ).toBe('Stripped 3 tags: <script>, <iframe>');
  });

  it('sums counts across distinct tags', () => {
    expect(
      formatStrippedTags([
        { tag: 'script', count: 2 },
        { tag: 'form', count: 1 },
        { tag: 'iframe', count: 1 },
      ]),
    ).toBe('Stripped 4 tags: <script>, <form>, <iframe>');
  });

  it('clamps negative counts to 0 so the total never lies', () => {
    expect(
      formatStrippedTags([
        { tag: 'script', count: -1 },
        { tag: 'iframe', count: 2 },
      ]),
    ).toBe('Stripped 2 tags: <script>, <iframe>');
  });
});
