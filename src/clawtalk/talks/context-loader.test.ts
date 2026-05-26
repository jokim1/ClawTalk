// Unit tests for the pure helpers in context-loader.ts.
//
// buildContentOutline now renders the inlined doc (full block text +
// anchor comments) rather than 60-char previews — the agent needs to
// see the prose it's being asked to rewrite. The full loadTalkContext
// is integration-tested end-to-end through the executor + worker; this
// file isolates the cheap parts.

import { describe, expect, it } from 'vitest';

import {
  buildContentOutline,
  buildSourceManifest,
  buildSourcePreview,
  type SourceRow,
} from './context-loader.js';
import type { Content } from '../db/content-accessors.js';
import type { AnchorMap } from '../../shared/rich-text/index.js';

function makeSource(
  input: Partial<SourceRow> & {
    source_ref: string;
    source_type: string;
    title: string;
  },
): SourceRow {
  return {
    id: `id-${input.source_ref}`,
    source_ref: input.source_ref,
    source_type: input.source_type,
    title: input.title,
    title_slug: input.title_slug ?? null,
    note: input.note ?? null,
    source_url: input.source_url ?? null,
    file_name: input.file_name ?? null,
    file_size: input.file_size ?? null,
    mime_type: input.mime_type ?? null,
    storage_key: input.storage_key ?? null,
    extracted_text: input.extracted_text ?? null,
    status: input.status ?? 'ready',
  };
}

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

describe('buildSourcePreview', () => {
  it('returns null for empty/null input', () => {
    expect(buildSourcePreview(null)).toBeNull();
    expect(buildSourcePreview('')).toBeNull();
    expect(buildSourcePreview('   \n\n  ')).toBeNull();
  });

  it('collapses whitespace and newlines into single spaces', () => {
    const preview = buildSourcePreview('hello\n\n  world\t\tagain');
    expect(preview).toBe('hello world again');
  });

  it('strips control characters', () => {
    const dirty = `clean${String.fromCharCode(0, 7, 0x7f)}body`;
    expect(buildSourcePreview(dirty)).toBe('cleanbody');
  });

  it('escapes backticks so the preview cannot break out of a code fence', () => {
    expect(buildSourcePreview('hello `code` world')).toBe("hello 'code' world");
  });

  it('truncates to 200 chars with an ellipsis', () => {
    const long = 'a'.repeat(500);
    const preview = buildSourcePreview(long);
    expect(preview).not.toBeNull();
    expect(preview!.endsWith('…')).toBe(true);
    expect(preview!.length).toBeLessThanOrEqual(201);
  });

  it('does not append ellipsis when text fits', () => {
    expect(buildSourcePreview('short text')).toBe('short text');
  });
});

describe('buildSourceManifest', () => {
  // REGRESSION (iron rule): the inline-if-small heuristic is gone. A
  // small text source must NOT inline its full content into the system
  // prompt — only the manifest preview line appears.
  it('does NOT inline small text source content', () => {
    const source = makeSource({
      source_ref: 'S1',
      source_type: 'text',
      title: 'Tiny',
      extracted_text:
        'this is small enough that the old heuristic would have inlined it',
    });
    const manifest = buildSourceManifest([source], false);
    expect(manifest).toHaveLength(1);
    // No inlineContent field exists on the manifest shape anymore.
    expect(
      (manifest[0] as unknown as Record<string, unknown>).inlineContent,
    ).toBeUndefined();
    // The preview is bounded; the full text length appears only inside the preview clause.
    expect(manifest[0].line).toContain('[S1] Tiny');
    expect(manifest[0].line).toContain('preview:');
  });

  it('emits a URL manifest line with note + url + preview', () => {
    const source = makeSource({
      source_ref: 'S2',
      source_type: 'url',
      title: 'Design Notes',
      note: 'product roadmap',
      source_url: 'https://example.com/notes',
      extracted_text:
        'The roadmap for Q4 covers retention, monetization, and onboarding.',
    });
    const manifest = buildSourceManifest([source], false);
    expect(manifest[0].line).toBe(
      '[S2] Design Notes (product roadmap) — https://example.com/notes — preview: "The roadmap for Q4 covers retention, monetization, and onboarding."',
    );
  });

  it('emits a file manifest line with filename + preview, no note clause when note is null', () => {
    const source = makeSource({
      source_ref: 'S3',
      source_type: 'file',
      title: 'Spec',
      file_name: 'spec.pdf',
      extracted_text: 'Section 1: introduction. Section 2: design.',
    });
    const manifest = buildSourceManifest([source], false);
    expect(manifest[0].line).toBe(
      '[S3] Spec — spec.pdf — preview: "Section 1: introduction. Section 2: design."',
    );
  });

  it('emits a text manifest line with just title + preview (no locator)', () => {
    const source = makeSource({
      source_ref: 'S4',
      source_type: 'text',
      title: 'Note',
      extracted_text: 'snippet body',
    });
    const manifest = buildSourceManifest([source], false);
    expect(manifest[0].line).toBe('[S4] Note — preview: "snippet body"');
  });

  it('emits image manifest line with vision-aware suffix; no preview', () => {
    const source = makeSource({
      source_ref: 'S5',
      source_type: 'file',
      title: 'Mockup',
      file_name: 'mockup.png',
      mime_type: 'image/png',
    });
    const visionOn = buildSourceManifest([source], true);
    expect(visionOn[0].line).toContain(
      '(image — mockup.png; attached to this turn)',
    );
    expect(visionOn[0].line).not.toContain('preview:');

    const visionOff = buildSourceManifest([source], false);
    expect(visionOff[0].line).toContain(
      "hidden, this agent's model lacks vision",
    );
  });

  it('emits "(content not yet available)" when a non-text source has no extracted_text', () => {
    const source = makeSource({
      source_ref: 'S6',
      source_type: 'url',
      title: 'Empty',
      source_url: 'https://example.com',
      extracted_text: null,
    });
    const manifest = buildSourceManifest([source], false);
    expect(manifest[0].line).toContain('(content not yet available)');
  });
});
