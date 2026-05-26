// Tests for the HTML anchor module — PR B.
// Pure-JS tests; linkedom runs in the worker test env. No DB / no
// network.

import { describe, expect, it } from 'vitest';

import {
  BLOCK_ELIGIBLE_TAGS,
  extractOutline,
  insertAnchors,
  stripAnchors,
} from './html-anchors.js';

function makeGenerator(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

describe('insertAnchors', () => {
  it('stamps fresh anchors on every top-level block', () => {
    const result = insertAnchors(
      '<h1>Title</h1><p>Body paragraph.</p><ul><li>One</li></ul>',
      { generate: makeGenerator('a') },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('data-anchor-id="a1"');
    expect(result.value).toContain('data-anchor-id="a2"');
    expect(result.value).toContain('data-anchor-id="a3"');
  });

  it('preserves existing anchors and only fills the missing ones (idempotent)', () => {
    const first = insertAnchors('<h1>One</h1><p>Two</p><p>Three</p>', {
      generate: makeGenerator('first-'),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Second pass with a different generator must NOT overwrite the
    // first pass's anchors.
    const second = insertAnchors(first.value, {
      generate: makeGenerator('second-'),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toContain('data-anchor-id="first-1"');
    expect(second.value).toContain('data-anchor-id="first-2"');
    expect(second.value).toContain('data-anchor-id="first-3"');
    expect(second.value).not.toContain('data-anchor-id="second-');
  });

  it('only stamps top-level blocks — nested children are ignored', () => {
    const result = insertAnchors(
      '<section><p>Nested para</p><h2>Nested heading</h2></section>',
      { generate: makeGenerator('n') },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The top-level <section> is anchored.
    expect(result.value).toContain('data-anchor-id="n1"');
    // The nested <p> and <h2> are NOT anchored by us.
    // Count occurrences of the attribute name.
    const matches = result.value.match(/data-anchor-id=/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('skips non-block top-level elements (e.g. inline-only)', () => {
    // <a> is not in BLOCK_ELIGIBLE_TAGS so a top-level link gets no anchor.
    // Note: linkedom wraps stray inline content under a <p>-ish, but a
    // bare top-level <a> should still be left alone.
    const result = insertAnchors(
      '<a href="https://example.com">link</a><p>para</p>',
      { generate: makeGenerator('s') },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exactly one anchor — the <p>.
    const matches = result.value.match(/data-anchor-id=/g) ?? [];
    expect(matches.length).toBe(1);
    expect(result.value).toContain('<p data-anchor-id="s1">para</p>');
  });

  it('covers every block-eligible tag', () => {
    for (const tag of BLOCK_ELIGIBLE_TAGS) {
      const result = insertAnchors(`<${tag}>x</${tag}>`, {
        generate: () => 'pin',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value).toContain('data-anchor-id="pin"');
    }
  });

  it('returns a structured error for non-string input', () => {
    // @ts-expect-error — deliberately wrong type to verify guard.
    const result = insertAnchors(42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('html_parse_failed');
  });
});

describe('stripAnchors', () => {
  it('removes only data-anchor-id, preserves other attrs', () => {
    const result = stripAnchors(
      '<p data-anchor-id="x1" class="lead" id="intro">Hi</p>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('data-anchor-id');
    expect(result.value).toContain('class="lead"');
    expect(result.value).toContain('id="intro"');
  });

  it('strips anchors at every depth — top-level AND nested', () => {
    const result = stripAnchors(
      '<section data-anchor-id="outer"><p data-anchor-id="inner">x</p></section>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('data-anchor-id');
  });

  it('is a no-op when nothing has the attribute', () => {
    const input = '<h1>Title</h1><p>Body</p>';
    const result = stripAnchors(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(input);
  });
});

describe('extractOutline', () => {
  it('returns one entry per anchored top-level block', () => {
    const anchored = insertAnchors(
      '<h1>Heading</h1><p>First paragraph.</p><blockquote>Quote.</blockquote>',
      { generate: makeGenerator('e') },
    );
    expect(anchored.ok).toBe(true);
    if (!anchored.ok) return;
    const outline = extractOutline(anchored.value);
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.value).toEqual([
      { anchorId: 'e1', tag: 'h1', textExcerpt: 'Heading' },
      { anchorId: 'e2', tag: 'p', textExcerpt: 'First paragraph.' },
      { anchorId: 'e3', tag: 'blockquote', textExcerpt: 'Quote.' },
    ]);
  });

  it('truncates text excerpts at 80 chars with an ellipsis', () => {
    const long = 'word '.repeat(50).trim(); // 249 chars
    const html = `<p data-anchor-id="long-1">${long}</p>`;
    const outline = extractOutline(html);
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.value).toHaveLength(1);
    const entry = outline.value[0];
    expect(entry.textExcerpt.endsWith('…')).toBe(true);
    // The ellipsis is one extra char beyond the 80-char head.
    expect(entry.textExcerpt.length).toBeLessThanOrEqual(81);
  });

  it('decodes HTML entities (linkedom owns the decode)', () => {
    const html =
      '<p data-anchor-id="ent-1">&amp;&lt;tag&gt; &quot;quoted&quot;</p>';
    const outline = extractOutline(html);
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.value[0].textExcerpt).toBe('&<tag> "quoted"');
  });

  it('collapses runs of whitespace into single spaces', () => {
    const html =
      '<p data-anchor-id="w-1">Line one\n\n   line two\t\twith tabs</p>';
    const outline = extractOutline(html);
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.value[0].textExcerpt).toBe('Line one line two with tabs');
  });

  it('skips unanchored blocks rather than fabricating IDs', () => {
    const html = '<p data-anchor-id="kept">A</p><p>B</p>';
    const outline = extractOutline(html);
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.value).toHaveLength(1);
    expect(outline.value[0].anchorId).toBe('kept');
  });

  it('returns an empty list for an empty doc', () => {
    const outline = extractOutline('');
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.value).toEqual([]);
  });

  it('handles empty blocks (yields "")', () => {
    const outline = extractOutline('<p data-anchor-id="e-1"></p>');
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.value).toEqual([
      { anchorId: 'e-1', tag: 'p', textExcerpt: '' },
    ]);
  });
});
