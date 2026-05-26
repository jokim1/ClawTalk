// Unit tests for the pure helpers in context-loader.ts.
//
// buildContentOutline now renders the inlined doc (full block text +
// anchor comments) rather than 60-char previews — the agent needs to
// see the prose it's being asked to rewrite. The full loadTalkContext
// is integration-tested end-to-end through the executor + worker; this
// file isolates the cheap parts.

import { describe, expect, it } from 'vitest';

import { buildContentOutline } from './context-loader.js';
import type { Content } from '../db/content-accessors.js';
import type { AnchorMap } from '../../shared/rich-text/index.js';

function makeContent(input: {
  title?: string;
  bodyVersion?: number;
  bodyMarkdown: string;
  anchorMap?: AnchorMap;
}): Content {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    ownerId: '22222222-2222-2222-2222-222222222222',
    talkId: '33333333-3333-3333-3333-333333333333',
    title: input.title ?? 'Doc',
    contentKind: 'document',
    contentFormat: 'markdown',
    bodyMarkdown: input.bodyMarkdown,
    bodyVersion: input.bodyVersion ?? 1,
    anchorMap: input.anchorMap ?? {},
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    createdByUserId: null,
    updatedByUserId: null,
    updatedByRunId: null,
  };
}

describe('buildContentOutline', () => {
  it('inlines full block content with anchor markers in document order', () => {
    const md = [
      '<!-- anchor:aaaa11112222 -->',
      '# The Audience Trap',
      '',
      '<!-- anchor:bbbb11112222 -->',
      'Why the hardest problem is the one no one budgets for',
    ].join('\n');
    const content = makeContent({
      title: 'Why Fortnite UEFN Failed',
      bodyVersion: 3,
      bodyMarkdown: md,
    });

    const outline = buildContentOutline(content);
    expect(outline).toContain('**The Doc');
    expect(outline).toContain('"Why Fortnite UEFN Failed" (v3)');
    expect(outline.toLowerCase()).toContain('google doc');
    expect(outline).toContain('@doc');
    expect(outline).toContain('<!-- anchor:aaaa11112222 -->');
    expect(outline).toContain('[heading] The Audience Trap');
    expect(outline).toContain('<!-- anchor:bbbb11112222 -->');
    expect(outline).toContain(
      '[paragraph] Why the hardest problem is the one no one budgets for',
    );
    expect(outline.indexOf('aaaa11112222')).toBeLessThan(
      outline.indexOf('bbbb11112222'),
    );
    // The direct-edit redesign renames the tool; legacy propose_* tools
    // remain registered during the migration (see context-loader's tool
    // list) but the directive points the agent at apply_content_edit.
    expect(outline).toContain('apply_content_edit');
  });

  it('respects the byte budget by truncating from the bottom at block boundaries', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => {
      const anchor = `anchor${i.toString().padStart(6, '0')}`;
      return `<!-- anchor:${anchor} -->\n${'A'.repeat(50)}`;
    });
    const content = makeContent({
      bodyMarkdown: blocks.join('\n\n'),
    });
    // 4096-byte budget — generous enough to fit the header + footer
    // (which grew with the Kimi-prior hardening plus the bulk-tool
    // registration) and a handful of blocks, while still forcing
    // truncation of the rest.
    const outline = buildContentOutline(content, 4096);
    expect(new TextEncoder().encode(outline).byteLength).toBeLessThanOrEqual(
      4096,
    );
    expect(outline).toMatch(/\[… \d+ more blocks omitted/);
  });

  it('emits no truncation suffix when every block fits', () => {
    const content = makeContent({
      bodyMarkdown: '<!-- anchor:dddd11112222 -->\nOnly block',
    });
    const outline = buildContentOutline(content);
    expect(outline).not.toContain('more blocks omitted');
  });

  it('emits a header + footer even when there are zero blocks', () => {
    const content = makeContent({ title: 'Empty Doc', bodyMarkdown: '' });
    const outline = buildContentOutline(content);
    expect(outline).toContain('**The Doc');
    expect(outline).toContain('"Empty Doc"');
    expect(outline).toContain('apply_content_edit');
  });

  it('strips ASCII control characters from inlined block content', () => {
    // Embed a NUL byte and a bell character (0x07) inside the block.
    const dirty = `<!-- anchor:eeee11112222 -->\nclean${String.fromCharCode(0, 7)}body`;
    const content = makeContent({ bodyMarkdown: dirty });
    const outline = buildContentOutline(content);
    expect(outline).toContain('cleanbody');
    expect(outline).not.toContain(String.fromCharCode(0));
    expect(outline).not.toContain(String.fromCharCode(7));
  });

  it('mentions @doc + the directive to use tools instead of chat', () => {
    const content = makeContent({
      bodyMarkdown: '<!-- anchor:ffff11112222 -->\nSome prose.',
    });
    const outline = buildContentOutline(content);
    expect(outline).toContain('do NOT write substantive new prose into chat');
  });

  // Kimi 2.6 refused to call the doc-edit tool when the user asked
  // "can you add a summary paragraph at the end to @doc" — it read the
  // rhetorical "can you?" as a capability inquiry and replied with text
  // explaining what it would do. These assertions lock in the prompt
  // additions that address both that and the related "I cannot directly
  // edit @doc because it is not a bound Google Doc" pattern.
  it('teaches the agent that rhetorical questions are instructions', () => {
    const content = makeContent({
      bodyMarkdown: '<!-- anchor:ffff11112222 -->\nSome prose.',
    });
    const outline = buildContentOutline(content);
    expect(outline).toContain('Rhetorical questions count as instructions');
    expect(outline).toContain('Can you add a summary?');
  });

  it('forbids the "I cannot directly edit" capability-narration pattern', () => {
    const content = makeContent({
      bodyMarkdown: '<!-- anchor:ffff11112222 -->\nSome prose.',
    });
    const outline = buildContentOutline(content);
    expect(outline).toContain('NEVER narrate your capabilities');
    expect(outline).toContain('I cannot directly edit @doc');
  });
});
