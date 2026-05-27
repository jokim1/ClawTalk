// Shared rich-text module tests — round-trip stability, anchor
// preservation, server-side proposal insertion, and sanitizer policy.
// No DB / no network — pure-JS unit tests.

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_ATTR_KEY,
  computeAnchorMap,
  ensureAnchorIds,
  findBlockIndexByAnchor,
  freshAnchorId,
  insertAfterAnchor,
  markdownToTiptapJson,
  plainTextOf,
  replaceBlockByAnchor,
  sanitizeMarkdown,
  sanitizeRichTextDocument,
  sha256Hex,
  stripAnchorCommentsFromMarkdown,
  structuralFingerprint,
  tiptapJsonToMarkdown,
  type RichTextDocument,
} from './index.js';

function doc(content: RichTextDocument['content']): RichTextDocument {
  return { type: 'doc', content };
}

describe('tiptap-to-markdown serializer', () => {
  it('renders headings, paragraphs, lists, code, blockquote', () => {
    const input = doc([
      {
        type: 'heading',
        attrs: { level: 1, [ANCHOR_ATTR_KEY]: 'a1' },
        content: [{ type: 'text', text: 'Intro' }],
      },
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'a2' },
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
        ],
      },
      {
        type: 'bulletList',
        attrs: { [ANCHOR_ATTR_KEY]: 'a3' },
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
            ],
          },
        ],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'ts', [ANCHOR_ATTR_KEY]: 'a4' },
        content: [{ type: 'text', text: 'const x = 1;' }],
      },
      {
        type: 'blockquote',
        attrs: { [ANCHOR_ATTR_KEY]: 'a5' },
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Quoted' }] },
        ],
      },
    ]);
    const md = tiptapJsonToMarkdown(input);
    expect(md).toContain('<!-- anchor:a1 -->\n# Intro');
    expect(md).toContain('<!-- anchor:a2 -->\nHello **world**');
    expect(md).toContain('<!-- anchor:a3 -->\n- one\n- two');
    expect(md).toContain('<!-- anchor:a4 -->\n```ts\nconst x = 1;\n```');
    expect(md).toContain('<!-- anchor:a5 -->\n> Quoted');
  });

  it('omits anchor comment when dataAnchorId is absent', () => {
    const md = tiptapJsonToMarkdown(
      doc([
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'no anchor' }],
        },
      ]),
    );
    expect(md).toBe('no anchor');
  });

  it('encodes link href with parens / spaces', () => {
    const md = tiptapJsonToMarkdown(
      doc([
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click',
              marks: [
                { type: 'link', attrs: { href: 'https://x.com/a (b) c' } },
              ],
            },
          ],
        },
      ]),
    );
    expect(md).toBe('[click](https://x.com/a%20%28b%29%20c)');
  });
});

describe('markdown-to-tiptap parser', () => {
  it('parses headings + paragraphs with anchor restore', () => {
    const md = `<!-- anchor:h1 -->\n# Hello\n\n<!-- anchor:p1 -->\nWorld`;
    const out = markdownToTiptapJson(md);
    expect(out.content.length).toBe(2);
    expect(out.content[0].type).toBe('heading');
    expect(out.content[0].attrs).toMatchObject({
      level: 1,
      [ANCHOR_ATTR_KEY]: 'h1',
    });
    expect(out.content[1].type).toBe('paragraph');
    expect(out.content[1].attrs).toMatchObject({ [ANCHOR_ATTR_KEY]: 'p1' });
  });

  it('parses italic nested inside bold', () => {
    const out = markdownToTiptapJson('A **bold *italic* trailing** end');
    const para = out.content[0];
    expect(para.type).toBe('paragraph');
    const flat = (para.content ?? []).map((n) => ({
      text: n.text,
      marks: (n.marks ?? []).map((m) => m.type).sort(),
    }));
    const italicAndBold = flat.find(
      (f) => f.marks.includes('italic') && f.marks.includes('bold'),
    );
    expect(italicAndBold?.text).toBe('italic');
  });

  it('parses code spans', () => {
    const out = markdownToTiptapJson('Run `npm test` now');
    const para = out.content[0];
    const codeRun = (para.content ?? []).find((n) =>
      n.marks?.some((m) => m.type === 'code'),
    );
    expect(codeRun?.text).toBe('npm test');
  });

  it('parses fenced code block with language', () => {
    const out = markdownToTiptapJson('```ts\nconst x = 1;\n```');
    expect(out.content[0].type).toBe('codeBlock');
    expect(out.content[0].attrs).toMatchObject({ language: 'ts' });
    expect((out.content[0].content ?? [])[0].text).toBe('const x = 1;');
  });

  it('parses ordered list', () => {
    const out = markdownToTiptapJson('1. first\n2. second');
    expect(out.content[0].type).toBe('orderedList');
    expect(out.content[0].content?.length).toBe(2);
  });

  it('parses blockquote', () => {
    const out = markdownToTiptapJson('> A wise quote\n> continued');
    expect(out.content[0].type).toBe('blockquote');
  });

  it('parses horizontal rule', () => {
    const out = markdownToTiptapJson('above\n\n---\n\nbelow');
    expect(out.content[1].type).toBe('horizontalRule');
  });

  it('roundtrips a representative document (anchor + marks + nesting)', () => {
    const original = doc([
      {
        type: 'heading',
        attrs: { level: 2, [ANCHOR_ATTR_KEY]: 'h2' },
        content: [{ type: 'text', text: 'Goals' }],
      },
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'p1' },
        content: [
          { type: 'text', text: 'Ship ' },
          { type: 'text', text: 'PR 1', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' today.' },
        ],
      },
      {
        type: 'bulletList',
        attrs: { [ANCHOR_ATTR_KEY]: 'l1' },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'schema' }],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'accessors' }],
              },
            ],
          },
        ],
      },
    ]);
    const md = tiptapJsonToMarkdown(original);
    const parsed = markdownToTiptapJson(md);
    // Anchor IDs preserved on each block.
    expect(parsed.content[0].attrs?.[ANCHOR_ATTR_KEY]).toBe('h2');
    expect(parsed.content[1].attrs?.[ANCHOR_ATTR_KEY]).toBe('p1');
    expect(parsed.content[2].attrs?.[ANCHOR_ATTR_KEY]).toBe('l1');
    // Re-serialize → byte-identical markdown.
    const md2 = tiptapJsonToMarkdown(parsed);
    expect(md2).toBe(md);
  });

  it('parses + round-trips inline image syntax', () => {
    const md = 'See ![chart](https://example.com/c.png) inline.';
    const parsed = markdownToTiptapJson(md);
    const para = parsed.content[0];
    expect(para.type).toBe('paragraph');
    const inline = para.content ?? [];
    // text + image + text
    expect(inline.length).toBe(3);
    expect(inline[0].type).toBe('text');
    expect(inline[0].text).toBe('See ');
    expect(inline[1].type).toBe('image');
    expect(inline[1].attrs?.src).toBe('https://example.com/c.png');
    expect(inline[1].attrs?.alt).toBe('chart');
    expect(inline[2].type).toBe('text');
    expect(inline[2].text).toBe(' inline.');
    // Round-trip back to identical markdown.
    expect(tiptapJsonToMarkdown(parsed)).toBe(md);
  });

  it('parses an image with empty alt text', () => {
    const md = '![](https://example.com/p.png)';
    const parsed = markdownToTiptapJson(md);
    const inline = parsed.content[0].content ?? [];
    expect(inline.length).toBe(1);
    expect(inline[0].type).toBe('image');
    expect(inline[0].attrs?.src).toBe('https://example.com/p.png');
    // No alt key when text is empty (keeps the round-trip stable).
    expect(inline[0].attrs?.alt).toBeUndefined();
    expect(tiptapJsonToMarkdown(parsed)).toBe(md);
  });

  // Regression for the Google-Docs paste bug: when Tiptap's Image
  // extension was block-default (`inline: false`), a paste of a
  // standalone <img> created a TOP-LEVEL image node — not nested in a
  // paragraph. The serializer's renderBlockNode hit `default` →
  // renderInlineContent(undefined) → '' → the image silently
  // disappeared from the saved markdown. Lock in that block-level
  // image nodes round-trip too.
  it('serializes a top-level (block) image node to `![alt](url)`', () => {
    const blockImageDoc: RichTextDocument = doc([
      {
        type: 'image',
        attrs: { src: 'https://example.com/grid.png', alt: 'grid' },
      },
    ]);
    expect(tiptapJsonToMarkdown(blockImageDoc)).toBe(
      '![grid](https://example.com/grid.png)',
    );
  });

  it('serializes a block image with empty alt as `![](url)`', () => {
    const blockImageDoc: RichTextDocument = doc([
      { type: 'image', attrs: { src: 'https://example.com/a.png' } },
    ]);
    expect(tiptapJsonToMarkdown(blockImageDoc)).toBe(
      '![](https://example.com/a.png)',
    );
  });

  it('returns null for a block image with no src (drops the node)', () => {
    const blockImageDoc: RichTextDocument = doc([
      { type: 'image', attrs: { alt: 'no src' } },
    ]);
    // No src → no markdown — node drops, doesn't degrade to empty
    // paragraph fragments.
    expect(tiptapJsonToMarkdown(blockImageDoc)).toBe('');
  });

  it('round-trips a Google-Docs-shaped paste (paragraph + standalone images + paragraph)', () => {
    // Mirrors what a Google Docs HTML paste produces after the Tiptap
    // schema settles: surrounding paragraphs, with inline images
    // between (each image lives inside a single-child paragraph since
    // the Image extension is now `inline: true`). This is the shape
    // Joseph's image grid takes once the bug is fixed.
    const md = [
      'Intro paragraph.',
      '',
      '![first](https://example.com/1.png)',
      '',
      '![second](https://example.com/2.png)',
      '',
      'Outro paragraph.',
    ].join('\n');
    const parsed = markdownToTiptapJson(md);
    expect(parsed.content.length).toBe(4);
    expect(parsed.content[0].type).toBe('paragraph');
    expect(parsed.content[1].type).toBe('paragraph');
    expect(parsed.content[1].content?.[0].type).toBe('image');
    expect(parsed.content[2].type).toBe('paragraph');
    expect(parsed.content[2].content?.[0].type).toBe('image');
    expect(parsed.content[3].type).toBe('paragraph');
    expect(tiptapJsonToMarkdown(parsed)).toBe(md);
  });
});

describe('anchor-ops', () => {
  it('freshAnchorId returns a unique-ish 12-char string', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(freshAnchorId());
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id.length).toBe(12);
  });

  it('ensureAnchorIds fills in missing IDs only', () => {
    const input = doc([
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'keepme' },
        content: [{ type: 'text', text: 'a' }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
    ]);
    const stamped = ensureAnchorIds(input);
    expect(stamped.content[0].attrs?.[ANCHOR_ATTR_KEY]).toBe('keepme');
    const newId = stamped.content[1].attrs?.[ANCHOR_ATTR_KEY] as string;
    expect(typeof newId).toBe('string');
    expect(newId.length).toBe(12);
  });

  it('computeAnchorMap indexes blocks + hashes plain text', async () => {
    const input = doc([
      {
        type: 'heading',
        attrs: { level: 1, [ANCHOR_ATTR_KEY]: 'h1' },
        content: [{ type: 'text', text: 'Title' }],
      },
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'p1' },
        content: [{ type: 'text', text: 'Body' }],
      },
    ]);
    const map = await computeAnchorMap(input);
    expect(Object.keys(map)).toEqual(['h1', 'p1']);
    expect(map.h1.kind).toBe('heading');
    expect(map.h1.preview).toBe('Title');
    expect(map.h1.content_hash).toBe(await sha256Hex('Title'));
    expect(map.p1.sort_order).toBe(1);
  });

  it('insertAfterAnchor splices a new block after the anchor', () => {
    const start = doc([
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'a' },
        content: [{ type: 'text', text: 'one' }],
      },
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'b' },
        content: [{ type: 'text', text: 'three' }],
      },
    ]);
    const result = insertAfterAnchor({
      doc: start,
      afterAnchorId: 'a',
      insertedNodes: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'two' }],
        },
      ],
    });
    if ('kind' in result) throw new Error('unexpected anchor_missing');
    expect(result.doc.content.length).toBe(3);
    expect(plainTextOf(result.doc.content[1])).toBe('two');
    expect(result.appliedAnchorIds.length).toBe(1);
    expect(typeof result.appliedAnchorIds[0]).toBe('string');
  });

  it('insertAfterAnchor at null inserts at top', () => {
    const start = doc([
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'a' },
        content: [{ type: 'text', text: 'tail' }],
      },
    ]);
    const result = insertAfterAnchor({
      doc: start,
      afterAnchorId: null,
      insertedNodes: [
        { type: 'paragraph', content: [{ type: 'text', text: 'head' }] },
      ],
    });
    if ('kind' in result) throw new Error('unexpected anchor_missing');
    expect(plainTextOf(result.doc.content[0])).toBe('head');
    expect(plainTextOf(result.doc.content[1])).toBe('tail');
  });

  it('insertAfterAnchor returns anchor_missing for unknown anchor', () => {
    const result = insertAfterAnchor({
      doc: doc([]),
      afterAnchorId: 'nope',
      insertedNodes: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      ],
    });
    expect('kind' in result && result.kind).toBe('anchor_missing');
  });

  it('findBlockIndexByAnchor returns -1 for missing anchor', () => {
    expect(findBlockIndexByAnchor(doc([]), 'x')).toBe(-1);
  });
});

describe('sanitizer policy', () => {
  it('strips raw HTML except anchor comments and underline tags', () => {
    const input =
      '<script>alert(1)</script><!-- anchor:keep -->\nHello <iframe>bad</iframe> <u>ok</u>';
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<iframe>');
    expect(out).toContain('<!-- anchor:keep -->');
    expect(out).toContain('<u>ok</u>');
  });

  it('strips other HTML comments but keeps anchor comments', () => {
    const out = sanitizeMarkdown(
      '<!-- secret --> body <!-- anchor:abc --> end',
    );
    expect(out).not.toContain('secret');
    expect(out).toContain('<!-- anchor:abc -->');
  });

  it('sanitizeRichTextDocument drops unsafe link marks', () => {
    const out = sanitizeRichTextDocument(
      doc([
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'bad',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
            {
              type: 'text',
              text: 'ok',
              marks: [{ type: 'link', attrs: { href: 'https://x.com' } }],
            },
          ],
        },
      ]),
    );
    const inline = out.content[0].content ?? [];
    expect(inline[0].marks?.length ?? 0).toBe(0);
    expect(inline[1].marks?.[0]?.attrs?.href).toBe('https://x.com/');
  });

  it('sanitizeRichTextDocument allows http/https/data image src + strips extras', () => {
    const out = sanitizeRichTextDocument(
      doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'inline ' },
            {
              type: 'image',
              attrs: {
                src: 'https://lh3.googleusercontent.com/abc=w750',
                alt: 'chart',
                onclick: 'alert(1)',
                srcset: 'huge.png 2x',
              },
            },
            { type: 'text', text: ' http img ' },
            {
              type: 'image',
              attrs: { src: 'http://example.com/pic.jpg', alt: 'pic' },
            },
            { type: 'text', text: ' data img ' },
            {
              type: 'image',
              attrs: {
                src: 'data:image/png;base64,iVBORw0KGgo=',
              },
            },
          ],
        },
      ]),
    );
    const inline = out.content[0].content ?? [];
    // First image kept; src normalized, alt preserved, onclick + srcset gone.
    const first = inline[1];
    expect(first.type).toBe('image');
    expect(first.attrs?.src).toBe('https://lh3.googleusercontent.com/abc=w750');
    expect(first.attrs?.alt).toBe('chart');
    expect(first.attrs?.onclick).toBeUndefined();
    expect(first.attrs?.srcset).toBeUndefined();
    // Second image: http URL allowed.
    expect(inline[3].type).toBe('image');
    expect(inline[3].attrs?.src).toBe('http://example.com/pic.jpg');
    // Third image: data:image/png allowed.
    expect(inline[5].type).toBe('image');
    expect(inline[5].attrs?.src).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('sanitizeRichTextDocument drops image with unsafe src (javascript:, data:text/html)', () => {
    const out = sanitizeRichTextDocument(
      doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            {
              type: 'image',
              attrs: { src: 'javascript:alert(1)' },
            },
            { type: 'text', text: 'b' },
            {
              type: 'image',
              attrs: { src: 'data:text/html,<script>alert(1)</script>' },
            },
          ],
        },
      ]),
    );
    const inline = out.content[0].content ?? [];
    // Both unsafe images are replaced with empty text nodes (preserves
    // surrounding structure but no live src).
    expect(inline[1].type).toBe('text');
    expect(inline[1].text).toBe('');
    expect(inline[3].type).toBe('text');
    expect(inline[3].text).toBe('');
  });
});

describe('replaceBlockByAnchor', () => {
  it('substitutes a single block and inherits the target anchor', () => {
    const start = doc([
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'a' },
        content: [{ type: 'text', text: 'before' }],
      },
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'b' },
        content: [{ type: 'text', text: 'target' }],
      },
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'c' },
        content: [{ type: 'text', text: 'after' }],
      },
    ]);
    const result = replaceBlockByAnchor({
      doc: start,
      targetAnchorId: 'b',
      replacementNodes: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'rewritten' }],
        },
      ],
    });
    if ('kind' in result) throw new Error('expected ok');
    expect(result.doc.content.length).toBe(3);
    expect(plainTextOf(result.doc.content[1])).toBe('rewritten');
    expect(result.doc.content[1].attrs?.[ANCHOR_ATTR_KEY]).toBe('b');
    expect(result.appliedAnchorIds).toEqual(['b']);
  });

  it('stamps fresh anchors on every replacement when multiple nodes are supplied', () => {
    const start = doc([
      {
        type: 'paragraph',
        attrs: { [ANCHOR_ATTR_KEY]: 'target' },
        content: [{ type: 'text', text: 'old' }],
      },
    ]);
    const result = replaceBlockByAnchor({
      doc: start,
      targetAnchorId: 'target',
      replacementNodes: [
        {
          type: 'paragraph',
          attrs: { [ANCHOR_ATTR_KEY]: 'attempted-hijack' },
          content: [{ type: 'text', text: 'hijack-one' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'two' }],
        },
      ],
    });
    if ('kind' in result) throw new Error('expected ok');
    expect(result.doc.content.length).toBe(2);
    // Multi-node replacement never inherits — fresh anchors throughout.
    expect(result.doc.content[0].attrs?.[ANCHOR_ATTR_KEY]).not.toBe('target');
    expect(result.doc.content[0].attrs?.[ANCHOR_ATTR_KEY]).not.toBe(
      'attempted-hijack',
    );
    expect(result.doc.content[1].attrs?.[ANCHOR_ATTR_KEY]).not.toBe('target');
  });

  it('returns anchor_missing for unknown target', () => {
    const result = replaceBlockByAnchor({
      doc: doc([]),
      targetAnchorId: 'nope',
      replacementNodes: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      ],
    });
    expect('kind' in result && result.kind).toBe('anchor_missing');
  });
});

describe('structuralFingerprint', () => {
  it('changes when node type changes even if text stays the same', () => {
    const para = {
      type: 'paragraph',
      attrs: { [ANCHOR_ATTR_KEY]: 'a' },
      content: [{ type: 'text', text: 'hello' }],
    };
    const heading = {
      type: 'heading',
      attrs: { [ANCHOR_ATTR_KEY]: 'a', level: 1 },
      content: [{ type: 'text', text: 'hello' }],
    };
    expect(structuralFingerprint(para)).not.toBe(
      structuralFingerprint(heading),
    );
  });

  it('ignores the anchor attribute so the same shape with a different anchor matches', () => {
    const a = {
      type: 'paragraph',
      attrs: { [ANCHOR_ATTR_KEY]: 'a' },
      content: [{ type: 'text', text: 'hi' }],
    };
    const b = {
      type: 'paragraph',
      attrs: { [ANCHOR_ATTR_KEY]: 'b' },
      content: [{ type: 'text', text: 'hi' }],
    };
    expect(structuralFingerprint(a)).toBe(structuralFingerprint(b));
  });

  it('reflects mark changes', () => {
    const plain = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'word' }],
    };
    const bold = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'word', marks: [{ type: 'bold' }] }],
    };
    expect(structuralFingerprint(plain)).not.toBe(structuralFingerprint(bold));
  });
});

describe('stripAnchorCommentsFromMarkdown', () => {
  it('removes anchor comments from agent-supplied markdown', () => {
    const md =
      '<!-- anchor:legit -->\nUser text and <!-- anchor:hijack --> here.';
    const out = stripAnchorCommentsFromMarkdown(md);
    expect(out).not.toContain('anchor:legit');
    expect(out).not.toContain('anchor:hijack');
    expect(out).toContain('User text and');
  });

  it('returns empty string for empty input', () => {
    expect(stripAnchorCommentsFromMarkdown('')).toBe('');
  });

  it('leaves non-anchor HTML comments alone (sanitizeMarkdown handles those next)', () => {
    const out = stripAnchorCommentsFromMarkdown('<!-- not an anchor -->\nbody');
    expect(out).toContain('<!-- not an anchor -->');
  });
});

describe('end-to-end roundtrip with anchored insert', () => {
  it('parse → insertAfterAnchor → serialize produces expected markdown', async () => {
    const startMd = `<!-- anchor:a -->\n# Title\n\n<!-- anchor:b -->\nBody.`;
    const parsed = markdownToTiptapJson(startMd);
    const result = insertAfterAnchor({
      doc: parsed,
      afterAnchorId: 'a',
      insertedNodes: [
        {
          type: 'paragraph',
          attrs: { [ANCHOR_ATTR_KEY]: 'inserted' },
          content: [{ type: 'text', text: 'New section.' }],
        },
      ],
    });
    if ('kind' in result) throw new Error('expected ok');
    const md = tiptapJsonToMarkdown(result.doc);
    expect(md).toBe(
      `<!-- anchor:a -->\n# Title\n\n<!-- anchor:inserted -->\nNew section.\n\n<!-- anchor:b -->\nBody.`,
    );
    const anchorMap = await computeAnchorMap(result.doc);
    expect(Object.keys(anchorMap).sort()).toEqual(['a', 'b', 'inserted']);
  });
});
