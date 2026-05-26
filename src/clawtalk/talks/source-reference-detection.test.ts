import { describe, expect, it } from 'vitest';

import { extractSourceReferences } from './source-reference-detection.js';

describe('extractSourceReferences', () => {
  describe('ref form (@S<n>)', () => {
    it('matches @S1 at start of string', () => {
      expect(extractSourceReferences('@S1 summarize this')).toEqual({
        refs: ['S1'],
        slugs: [],
      });
    });

    it('matches @S1 after whitespace', () => {
      expect(extractSourceReferences('please read @S1 carefully')).toEqual({
        refs: ['S1'],
        slugs: [],
      });
    });

    it('matches @S1 after punctuation', () => {
      expect(extractSourceReferences('checking (@S1) for context')).toEqual({
        refs: ['S1'],
        slugs: [],
      });
    });

    it('matches lowercase @s1 and normalizes to S1', () => {
      expect(extractSourceReferences('check @s99 please')).toEqual({
        refs: ['S99'],
        slugs: [],
      });
    });

    it('dedupes repeated refs', () => {
      expect(extractSourceReferences('@S1 vs @S1 and again @s1')).toEqual({
        refs: ['S1'],
        slugs: [],
      });
    });

    it('handles multiple distinct refs', () => {
      const result = extractSourceReferences('compare @S1 and @S2 and @S10');
      expect(result.refs.sort()).toEqual(['S1', 'S10', 'S2']);
      expect(result.slugs).toEqual([]);
    });
  });

  describe('slug form (@<slug>)', () => {
    it('matches @design-notes at start', () => {
      expect(extractSourceReferences('@design-notes please')).toEqual({
        refs: [],
        slugs: ['design-notes'],
      });
    });

    it('matches single-word slug', () => {
      expect(extractSourceReferences('summarize @memo')).toEqual({
        refs: [],
        slugs: ['memo'],
      });
    });

    it('normalizes uppercase slug to lowercase', () => {
      expect(extractSourceReferences('read @Design-Notes today')).toEqual({
        refs: [],
        slugs: ['design-notes'],
      });
    });

    it('strips trailing hyphens', () => {
      expect(extractSourceReferences('@design-notes- and then')).toEqual({
        refs: [],
        slugs: ['design-notes'],
      });
    });

    it('matches alphanumeric slugs', () => {
      expect(extractSourceReferences('see @v2-launch-plan')).toEqual({
        refs: [],
        slugs: ['v2-launch-plan'],
      });
    });

    it('dedupes repeated slugs', () => {
      expect(extractSourceReferences('@memo and @memo again')).toEqual({
        refs: [],
        slugs: ['memo'],
      });
    });

    it('handles mixed refs and slugs in one message', () => {
      const result = extractSourceReferences(
        '@S1 and @design-notes both apply here',
      );
      expect(result.refs).toEqual(['S1']);
      expect(result.slugs).toEqual(['design-notes']);
    });
  });

  describe('boundary guards (negative cases)', () => {
    it('does not match in-word @', () => {
      expect(extractSourceReferences('foo@bar')).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('does not match email addresses', () => {
      expect(
        extractSourceReferences('email me at jokim@gmail.com about it'),
      ).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('does not match @S1 immediately after a word char', () => {
      expect(extractSourceReferences('see source42@S1')).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('does not match markdown URL fragment after @', () => {
      // `(url@something)` — `@` is preceded by `l` (word char), so it's
      // treated as part of a URL/token, not a mention.
      expect(
        extractSourceReferences('[click](https://example.com/url@something)'),
      ).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('matches @S1 alongside an email in the same message', () => {
      expect(
        extractSourceReferences('email me at jokim@gmail.com about @S1'),
      ).toEqual({
        refs: ['S1'],
        slugs: [],
      });
    });

    it('does not match bare @ or single-char @s', () => {
      expect(extractSourceReferences('just @ alone or @s here')).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('does not match @-foo (leading hyphen)', () => {
      expect(extractSourceReferences('odd token @-foo here')).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('returns empty for empty / null-ish input', () => {
      expect(extractSourceReferences('')).toEqual({ refs: [], slugs: [] });
      expect(extractSourceReferences(null as unknown as string)).toEqual({
        refs: [],
        slugs: [],
      });
    });
  });

  describe('denylist', () => {
    it('drops @doc', () => {
      expect(extractSourceReferences('@doc summarize this')).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('drops @everyone', () => {
      expect(extractSourceReferences('hey @everyone')).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('drops @here', () => {
      expect(extractSourceReferences('ping @here please')).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('drops denylist tokens case-insensitively', () => {
      expect(extractSourceReferences('@DOC and @EveryOne')).toEqual({
        refs: [],
        slugs: [],
      });
    });

    it('still matches other slugs alongside denylisted ones', () => {
      expect(extractSourceReferences('@doc and @notes apply')).toEqual({
        refs: [],
        slugs: ['notes'],
      });
    });
  });

  describe('punctuation boundaries', () => {
    it('matches @S1 followed by period', () => {
      expect(extractSourceReferences('per @S1.')).toEqual({
        refs: ['S1'],
        slugs: [],
      });
    });

    it('matches @S1 followed by comma', () => {
      expect(extractSourceReferences('@S1, @S2, and @S3')).toEqual({
        refs: ['S1', 'S2', 'S3'],
        slugs: [],
      });
    });

    it('matches @S1 after newline', () => {
      expect(extractSourceReferences('paragraph one.\n@S1 next line')).toEqual({
        refs: ['S1'],
        slugs: [],
      });
    });

    it('matches @S1 after open paren', () => {
      expect(extractSourceReferences('cite(@S1)')).toEqual({
        refs: ['S1'],
        slugs: [],
      });
    });

    it('matches @slug after open bracket', () => {
      expect(extractSourceReferences('[@design-notes]')).toEqual({
        refs: [],
        slugs: ['design-notes'],
      });
    });
  });
});
