// Unit tests for the pure helpers in context-loader.ts.
//
// PR 5 added buildContentOutline. The full loadTalkContext is integration-tested
// end-to-end through the executor + worker; this file isolates the cheap parts.

import { describe, expect, it } from 'vitest';

import { buildContentOutline } from './context-loader.js';
import type { Content } from '../db/content-accessors.js';
import type { AnchorMap } from '../../shared/rich-text/index.js';

function makeContent(input: {
  title?: string;
  bodyVersion?: number;
  blocks: Array<{
    anchorId: string;
    kind: string;
    preview: string;
    sortOrder: number;
  }>;
}): Content {
  const anchorMap: AnchorMap = {};
  for (const b of input.blocks) {
    anchorMap[b.anchorId] = {
      kind: b.kind,
      sort_order: b.sortOrder,
      preview: b.preview,
      content_hash: 'deadbeef',
    };
  }
  return {
    id: '11111111-1111-1111-1111-111111111111',
    ownerId: '22222222-2222-2222-2222-222222222222',
    talkId: '33333333-3333-3333-3333-333333333333',
    title: input.title ?? 'Doc',
    contentKind: 'document',
    contentFormat: 'markdown',
    bodyMarkdown: '',
    bodyVersion: input.bodyVersion ?? 1,
    anchorMap,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    createdByUserId: null,
    updatedByUserId: null,
    updatedByRunId: null,
  };
}

describe('buildContentOutline', () => {
  it('emits one line per block in sort_order with anchor + kind + preview', () => {
    const content = makeContent({
      title: 'Why Fortnite UEFN Failed',
      bodyVersion: 3,
      blocks: [
        {
          anchorId: 'aaaa11112222',
          kind: 'heading',
          preview: 'The Audience Trap',
          sortOrder: 0,
        },
        {
          anchorId: 'bbbb11112222',
          kind: 'paragraph',
          preview: 'Why the hardest problem is the one no one budgets for',
          sortOrder: 1,
        },
      ],
    });

    const outline = buildContentOutline(content);
    expect(outline).toContain(
      '**Document Outline:** "Why Fortnite UEFN Failed" (v3)',
    );
    expect(outline).toContain(
      '[anchor:aaaa11112222] heading "The Audience Trap"',
    );
    expect(outline).toContain(
      '[anchor:bbbb11112222] paragraph "Why the hardest problem is the one no one budgets for"',
    );
    expect(outline.indexOf('aaaa11112222')).toBeLessThan(
      outline.indexOf('bbbb11112222'),
    );
    expect(outline).toContain('propose_content_append');
  });

  it('escapes embedded double quotes in the preview so the format stays parseable', () => {
    const content = makeContent({
      blocks: [
        {
          anchorId: 'cccc11112222',
          kind: 'paragraph',
          preview: 'They said "no" and meant it',
          sortOrder: 0,
        },
      ],
    });
    const outline = buildContentOutline(content);
    expect(outline).toContain('\\"no\\"');
  });

  it('respects the 2KB byte budget by truncating from the bottom', () => {
    // 100 blocks at ~80 bytes each = ~8KB → must truncate.
    const blocks = Array.from({ length: 100 }, (_, i) => ({
      anchorId: `anchor${i.toString().padStart(6, '0')}`,
      kind: 'paragraph',
      preview: 'A'.repeat(50),
      sortOrder: i,
    }));
    const content = makeContent({ blocks });
    const outline = buildContentOutline(content, 2048);
    expect(new TextEncoder().encode(outline).byteLength).toBeLessThanOrEqual(
      2048,
    );
    expect(outline).toMatch(/\[… \d+ more blocks not shown\]/);
  });

  it('emits no truncation suffix when every block fits', () => {
    const content = makeContent({
      blocks: [
        {
          anchorId: 'dddd11112222',
          kind: 'paragraph',
          preview: 'Only block',
          sortOrder: 0,
        },
      ],
    });
    const outline = buildContentOutline(content);
    expect(outline).not.toContain('more blocks not shown');
  });

  it('emits a header + footer even when there are zero blocks', () => {
    const content = makeContent({ title: 'Empty Doc', blocks: [] });
    const outline = buildContentOutline(content);
    expect(outline).toContain('**Document Outline:** "Empty Doc"');
    expect(outline).toContain('propose_content_append');
  });
});
