// Unit tests for the pure helpers in context-loader.ts.
//
// buildContentOutline now renders the inlined doc (full block text +
// anchor comments) rather than 60-char previews — the agent needs to
// see the prose it's being asked to rewrite. The full loadTalkContext
// is integration-tested end-to-end through the executor + worker; this
// file isolates the cheap parts.

import { describe, expect, it } from 'vitest';

import {
  buildAtRefForcedInjectionFromRows,
  buildContentOutline,
  buildSourceManifest,
  buildSourcePreview,
  computeRasterPageAttachment,
  isPageSetComplete,
  renderForcedInjectionResolutions,
  resolveAtRefRequestsForRender,
  MAX_TOTAL_PDF_PAYLOAD_BYTES,
  type AtRefCandidateRow,
  type ForcedInjectionResolution,
  type SourceRow,
} from './context-loader.js';
import {
  MAX_TOTAL_RASTER_PAYLOAD_BYTES,
  encodedSizeBytes,
} from '../../shared/attachment-caps.js';
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
    updated_at: input.updated_at ?? '2026-05-26T00:00:00Z',
    expected_page_count: input.expected_page_count ?? null,
    page_image_count: input.page_image_count ?? 0,
    page_image_total_bytes: input.page_image_total_bytes ?? 0,
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
    threadId: '44444444-4444-4444-4444-444444444444',
    title: input.title ?? 'Doc',
    contentKind: 'document',
    contentFormat: 'markdown',
    bodyMarkdown: input.bodyMarkdown,
    bodyHtml: null,
    bodyVersion: input.bodyVersion ?? 1,
    anchorMap: input.anchorMap ?? {},
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    createdByUserId: null,
    updatedByUserId: null,
    updatedByRunId: null,
  };
}

function makeHtmlContent(input: {
  title?: string;
  bodyVersion?: number;
  bodyHtml: string;
  anchorMap?: AnchorMap;
}): Content {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    ownerId: '66666666-6666-6666-6666-666666666666',
    talkId: '77777777-7777-7777-7777-777777777777',
    threadId: '88888888-8888-8888-8888-888888888888',
    title: input.title ?? 'HTML Doc',
    contentKind: 'document',
    contentFormat: 'html',
    bodyMarkdown: '',
    bodyHtml: input.bodyHtml,
    bodyVersion: input.bodyVersion ?? 1,
    anchorMap: input.anchorMap ?? {},
    createdAt: '2026-05-26T00:00:00Z',
    updatedAt: '2026-05-26T00:00:00Z',
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

  // ── HTML format branch (PR B) ──────────────────────────────────────

  it('renders an HTML doc outline with HTML format tag + tag-named blocks', () => {
    const content = makeHtmlContent({
      title: 'HTML Report',
      bodyVersion: 2,
      bodyHtml:
        '<h1 data-anchor-id="h1-id">Heading</h1>' +
        '<p data-anchor-id="p1-id">First paragraph.</p>',
    });
    const outline = buildContentOutline(content);
    expect(outline).toContain('"HTML Report" (v2, HTML format)');
    // Anchors come through verbatim from extractOutline, prefixed with
    // the same `<!-- anchor:... -->` marker as the markdown branch.
    expect(outline).toContain('<!-- anchor:h1-id -->');
    expect(outline).toContain('[h1] Heading');
    expect(outline).toContain('<!-- anchor:p1-id -->');
    expect(outline).toContain('[p] First paragraph.');
    // The HTML-specific stanza about format + allowed tags is appended
    // to the footer for HTML docs only.
    expect(outline).toContain('HTML payload required');
    expect(outline.toLowerCase()).toContain('allowed tags');
    expect(outline).toContain('data-anchor-id');
    expect(outline).toContain('apply_content_edit');
  });

  it('re-stamps missing anchors before extracting the HTML outline', () => {
    // A user-edit may strip a `data-anchor-id` from a block. The outline
    // builder must re-stamp before extracting so the AI sees an anchor
    // for every top-level block — even the stripped one.
    const content = makeHtmlContent({
      bodyHtml: '<h1>Stripped</h1><p data-anchor-id="kept">Kept.</p>',
    });
    const outline = buildContentOutline(content);
    // The "kept" anchor is preserved verbatim.
    expect(outline).toContain('<!-- anchor:kept -->');
    expect(outline).toContain('[p] Kept.');
    // The stripped block also appears with a freshly-stamped anchor.
    expect(outline).toContain('[h1] Stripped');
    // At least two anchor markers should now appear in the outline.
    const markers = outline.match(/<!-- anchor:/g) ?? [];
    expect(markers.length).toBeGreaterThanOrEqual(2);
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

describe('buildAtRefForcedInjectionFromRows', () => {
  function makeRow(
    input: Partial<AtRefCandidateRow> & {
      source_ref: string;
      title: string;
    },
  ): AtRefCandidateRow {
    return {
      id: input.id ?? `id-${input.source_ref}`,
      source_ref: input.source_ref,
      title: input.title,
      title_slug: input.title_slug ?? null,
      status: input.status ?? 'ready',
      extracted_text: input.extracted_text ?? null,
      mime_type: input.mime_type ?? null,
      storage_key: input.storage_key ?? null,
      file_size: input.file_size ?? null,
      file_name: input.file_name ?? null,
      source_type: input.source_type ?? 'text',
      source_url: input.source_url ?? null,
      updated_at: input.updated_at ?? '2026-05-26T00:00:00Z',
      expected_page_count: input.expected_page_count ?? null,
      page_image_count: input.page_image_count ?? 0,
      page_indices: input.page_indices ?? [],
      page_byte_sizes: input.page_byte_sizes ?? [],
    };
  }

  it('returns null when no refs or slugs are requested', () => {
    const result = buildAtRefForcedInjectionFromRows([], [], []);
    expect(result.text).toBeNull();
    expect(result.forcedPdfDocuments).toEqual([]);
  });

  it('renders a fenced block for a single resolved @S<n> ref', () => {
    const rows = [
      makeRow({
        source_ref: 'S1',
        title: 'Investor Memo',
        extracted_text: 'The opportunity is large.',
      }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(rows, ['S1'], []);
    expect(text).toContain('[S1] Investor Memo');
    expect(text).toContain('<<<source');
    expect(text).toContain('The opportunity is large.');
    expect(text).toContain('source>>>');
  });

  it('resolves @<slug> when a unique ready row matches', () => {
    const rows = [
      makeRow({
        source_ref: 'S3',
        title: 'Design Notes',
        title_slug: 'design-notes',
        extracted_text: 'roadmap content here',
      }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(
      rows,
      [],
      ['design-notes'],
    );
    expect(text).toContain('[S3] Design Notes');
    expect(text).toContain('roadmap content here');
  });

  it('emits "(no such source)" for a non-existent ref', () => {
    const { text } = buildAtRefForcedInjectionFromRows([], ['S99'], []);
    expect(text).toBe('[S99] (no such source)');
  });

  it('emits "(no such source)" for a non-existent slug', () => {
    const { text } = buildAtRefForcedInjectionFromRows([], [], ['ghost']);
    expect(text).toBe('[@ghost] (no such source)');
  });

  it('emits "(content not yet available)" for a pending source', () => {
    const rows = [
      makeRow({
        source_ref: 'S4',
        title: 'Stuck URL',
        status: 'pending',
        extracted_text: null,
      }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(rows, ['S4'], []);
    expect(text).toBe('[S4] Stuck URL (content not yet available)');
  });

  it('emits "(content not yet available)" for a ready row with empty extracted_text', () => {
    const rows = [
      makeRow({
        source_ref: 'S5',
        title: 'Empty Body',
        status: 'ready',
        extracted_text: null,
      }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(rows, ['S5'], []);
    expect(text).toBe('[S5] Empty Body (content not yet available)');
  });

  it('emits ambiguity note when a slug matches two ready rows', () => {
    const rows = [
      makeRow({
        source_ref: 'S1',
        title: 'Notes',
        title_slug: 'notes',
        extracted_text: 'a',
      }),
      makeRow({
        source_ref: 'S2',
        title: 'Notes',
        title_slug: 'notes',
        extracted_text: 'b',
      }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(rows, [], ['notes']);
    expect(text).toContain('[@notes] (ambiguous slug');
    expect(text).toContain('S1');
    expect(text).toContain('S2');
    expect(text).toContain('Use the @S<n> form instead');
    expect(text).not.toContain('<<<source');
  });

  it('resolves a slug that matches only one READY row even when a pending row shares it', () => {
    const rows = [
      makeRow({
        source_ref: 'S6',
        title: 'Notes',
        title_slug: 'notes',
        status: 'ready',
        extracted_text: 'real content',
      }),
      makeRow({
        source_ref: 'S7',
        title: 'Notes',
        title_slug: 'notes',
        status: 'pending',
        extracted_text: null,
      }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(rows, [], ['notes']);
    expect(text).toContain('[S6] Notes');
    expect(text).toContain('real content');
    expect(text).not.toContain('ambiguous');
  });

  it('sanitizes control characters and backticks in source content', () => {
    const dirty = `safe body \`code\` here\nmore`;
    const rows = [
      makeRow({
        source_ref: 'S8',
        title: 'Dirty',
        extracted_text: dirty,
      }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(rows, ['S8'], []);
    expect(text).not.toBeNull();
    // Null byte stripped.
    expect(text).not.toContain(' ');
    // Newline preserved (sanitizeBlockForPrompt keeps \n).
    expect(text).toContain('more');
    // Backticks pass through sanitizeBlockForPrompt unchanged but
    // wouldn't break out of the <<<source ... source>>> fence anyway —
    // the fence is intentionally non-markdown.
    expect(text).toContain('code');
  });

  it('joins multiple resolved refs with a blank-line separator', () => {
    const rows = [
      makeRow({ source_ref: 'S1', title: 'One', extracted_text: 'aaa' }),
      makeRow({ source_ref: 'S2', title: 'Two', extracted_text: 'bbb' }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(rows, ['S1', 'S2'], []);
    expect(text).toContain('[S1] One');
    expect(text).toContain('[S2] Two');
    // The two fenced blocks are separated by a blank line.
    const segments = text!.split('\n\n');
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it('does not emit the same source twice when both ref and slug request it', () => {
    const rows = [
      makeRow({
        source_ref: 'S1',
        title: 'One',
        title_slug: 'one',
        extracted_text: 'content',
      }),
    ];
    const { text } = buildAtRefForcedInjectionFromRows(rows, ['S1'], ['one']);
    expect(text!.split('<<<source').length).toBe(2); // exactly one fenced block (split produces N+1 pieces)
  });

  it('truncates with a footer when total bytes exceed the 40 KB budget', () => {
    const big = 'x'.repeat(20 * 1024); // ~20 KB per row
    const rows: AtRefCandidateRow[] = [];
    const refs: string[] = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(
        makeRow({
          source_ref: `S${i}`,
          title: `Big ${i}`,
          extracted_text: big,
        }),
      );
      refs.push(`S${i}`);
    }
    const { text } = buildAtRefForcedInjectionFromRows(rows, refs, []);
    expect(text).not.toBeNull();
    expect(text).toContain('[truncated,');
    expect(text).toContain('more @-refs omitted]');
    // Final size stays within 40 KB.
    expect(new TextEncoder().encode(text!).byteLength).toBeLessThanOrEqual(
      40 * 1024,
    );
  });

  it('emits a pdf-document resolution and exposes forcedPdfDocuments when agent supports docs', () => {
    const rows = [
      makeRow({
        source_ref: 'S9',
        title: 'Annual Report',
        source_type: 'file',
        mime_type: 'application/pdf',
        storage_key: 'attachments/talk-1/abc.pdf',
        file_size: 1024 * 1024,
        file_name: 'annual-report.pdf',
        status: 'ready',
        extracted_text: 'fallback text',
      }),
    ];
    const result = buildAtRefForcedInjectionFromRows(rows, ['S9'], [], {
      agentSupportsDocuments: true,
      perSourceMaxBytes: 12 * 1024 * 1024,
    });
    expect(result.text).toContain('[S9] Annual Report');
    expect(result.text).toContain('pages attached to this turn via @-ref');
    expect(result.text).not.toContain('<<<source');
    expect(result.forcedPdfDocuments).toHaveLength(1);
    expect(result.forcedPdfDocuments[0].source_ref).toBe('S9');
  });

  it('falls through to text injection for PDF rows when agent lacks doc support', () => {
    const rows = [
      makeRow({
        source_ref: 'S10',
        title: 'Annual Report',
        source_type: 'file',
        mime_type: 'application/pdf',
        storage_key: 'attachments/talk-1/abc.pdf',
        file_size: 1024 * 1024,
        file_name: 'annual-report.pdf',
        status: 'ready',
        extracted_text: 'fallback text content',
      }),
    ];
    const result = buildAtRefForcedInjectionFromRows(rows, ['S10'], []);
    expect(result.text).toContain('<<<source');
    expect(result.text).toContain('fallback text content');
    expect(result.forcedPdfDocuments).toHaveLength(0);
  });

  it('falls back to text when a forced PDF exceeds the per-source size cap', () => {
    const rows = [
      makeRow({
        source_ref: 'S11',
        title: 'Huge Slides',
        source_type: 'file',
        mime_type: 'application/pdf',
        storage_key: 'attachments/talk-1/big.pdf',
        file_size: 20 * 1024 * 1024,
        file_name: 'huge.pdf',
        status: 'ready',
        extracted_text: 'fallback excerpt',
      }),
    ];
    const result = buildAtRefForcedInjectionFromRows(rows, ['S11'], [], {
      agentSupportsDocuments: true,
      perSourceMaxBytes: 12 * 1024 * 1024,
    });
    expect(result.text).toContain('exceeds 12 MB attach cap');
    expect(result.text).toContain('fallback excerpt');
    expect(result.forcedPdfDocuments).toHaveLength(0);
  });
});

describe('cumulative-payload guard (resolveAtRefRequestsForRender + render)', () => {
  function makePdfRow(input: {
    source_ref: string;
    title: string;
    sizeBytes: number;
    extracted_text?: string;
  }): AtRefCandidateRow {
    return {
      id: `id-${input.source_ref}`,
      source_ref: input.source_ref,
      title: input.title,
      title_slug: null,
      status: 'ready',
      extracted_text: input.extracted_text ?? 'fallback',
      mime_type: 'application/pdf',
      storage_key: `attachments/talk-1/${input.source_ref}.pdf`,
      file_size: input.sizeBytes,
      file_name: `${input.source_ref}.pdf`,
      source_type: 'file',
      source_url: null,
      updated_at: '2026-05-26T00:00:00Z',
      expected_page_count: null,
      page_image_count: 0,
      page_indices: [],
      page_byte_sizes: [],
    };
  }

  it('downgrades pdf-document resolutions whose cumulative size exceeds the per-turn budget', () => {
    // Three 10 MB PDFs; cumulative budget is MAX_TOTAL_PDF_PAYLOAD_BYTES
    // (24 MiB). #1 and #2 fit (~20 MB); #3 (10 MB) would push to ~30 MB
    // and gets downgraded to pdf-too-large with the row's extracted_text
    // as a fallback body.
    const rows = [
      makePdfRow({
        source_ref: 'S1',
        title: 'Deck One',
        sizeBytes: 10 * 1024 * 1024,
        extracted_text: 'deck one text',
      }),
      makePdfRow({
        source_ref: 'S2',
        title: 'Deck Two',
        sizeBytes: 10 * 1024 * 1024,
        extracted_text: 'deck two text',
      }),
      makePdfRow({
        source_ref: 'S3',
        title: 'Deck Three',
        sizeBytes: 10 * 1024 * 1024,
        extracted_text: 'deck three text',
      }),
    ];

    const resolutions = resolveAtRefRequestsForRender(
      rows,
      ['S1', 'S2', 'S3'],
      [],
      {
        agentSupportsDocuments: true,
        perSourceMaxBytes: 12 * 1024 * 1024,
      },
    );

    // Apply the same cumulative guard the loader applies.
    let remaining = MAX_TOTAL_PDF_PAYLOAD_BYTES;
    const finalResolutions = resolutions.map((res) => {
      if (res.kind !== 'pdf-document') return res;
      const size =
        typeof res.row.file_size === 'string'
          ? Number(res.row.file_size) || 0
          : (res.row.file_size ?? 0);
      if (size > remaining) {
        return {
          kind: 'pdf-too-large' as const,
          sourceRef: res.sourceRef,
          title: res.title,
          maxBytes: MAX_TOTAL_PDF_PAYLOAD_BYTES,
          fallbackText: res.row.extracted_text,
        };
      }
      remaining -= size;
      return res;
    });

    expect(finalResolutions[0].kind).toBe('pdf-document');
    expect(finalResolutions[1].kind).toBe('pdf-document');
    expect(finalResolutions[2].kind).toBe('pdf-too-large');

    const text = renderForcedInjectionResolutions(finalResolutions);
    expect(text).not.toBeNull();
    expect(text).toContain('[S1] Deck One');
    expect(text).toContain('[S2] Deck Two');
    // S3 was downgraded — should render as text fallback, not "pages attached".
    expect(text).toContain('[S3] Deck Three');
    expect(text).toContain('deck three text');
    expect(text).toContain('exceeds 24 MB attach cap');
    // Both pages-attached forced PDFs only have the manifest note in
    // their resolution body (no <<<source fence); only the fallback
    // S3 should have <<<source.
    const fenceCount = text!.split('<<<source').length - 1;
    expect(fenceCount).toBe(1);
  });
});

describe('isPageSetComplete', () => {
  it('is complete only when every expected page landed', () => {
    expect(
      isPageSetComplete({ expected_page_count: 3, page_image_count: 3 }),
    ).toBe(true);
  });

  it('is incomplete when fewer pages landed than expected', () => {
    expect(
      isPageSetComplete({ expected_page_count: 3, page_image_count: 2 }),
    ).toBe(false);
  });

  it('is not complete when no expected count is recorded', () => {
    // PDF never rasterized, or pre-feature upload.
    expect(
      isPageSetComplete({ expected_page_count: null, page_image_count: 0 }),
    ).toBe(false);
  });

  it('treats a zero expected count as not complete', () => {
    expect(
      isPageSetComplete({ expected_page_count: 0, page_image_count: 0 }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PDF page-image (raster) consumption — Lane B (T7/T8/T11/T12)
// ---------------------------------------------------------------------------

function makeRasterRow(
  input: Partial<AtRefCandidateRow> & { source_ref: string; title: string },
): AtRefCandidateRow {
  const pageCount = input.page_image_count ?? 3;
  return {
    id: input.id ?? `id-${input.source_ref}`,
    source_ref: input.source_ref,
    title: input.title,
    title_slug: input.title_slug ?? null,
    status: input.status ?? 'ready',
    extracted_text: input.extracted_text ?? 'chart and figure text',
    mime_type: input.mime_type ?? 'application/pdf',
    storage_key:
      input.storage_key ?? `attachments/talk-1/${input.source_ref}.pdf`,
    file_size: input.file_size ?? 2 * 1024 * 1024,
    file_name: input.file_name ?? `${input.source_ref}.pdf`,
    source_type: input.source_type ?? 'file',
    source_url: input.source_url ?? null,
    updated_at: input.updated_at ?? '2026-05-30T00:00:00Z',
    expected_page_count: input.expected_page_count ?? pageCount,
    page_image_count: pageCount,
    page_indices:
      input.page_indices ?? Array.from({ length: pageCount }, (_, i) => i),
    page_byte_sizes:
      input.page_byte_sizes ?? Array.from({ length: pageCount }, () => 100_000),
  };
}

describe('resolveAtRefRequestsForRender — pdf-page-images (vision-but-not-doc)', () => {
  it('resolves an @S<n> ref to pdf-page-images for a complete-page PDF', () => {
    const rows = [makeRasterRow({ source_ref: 'S1', title: 'Charts Deck' })];
    const res = resolveAtRefRequestsForRender(rows, ['S1'], [], {
      agentSupportsVision: true,
      maxImages: 4,
    });
    expect(res).toHaveLength(1);
    expect(res[0].kind).toBe('pdf-page-images');
  });

  it('resolves an @<slug> to pdf-page-images (parity with @S)', () => {
    const rows = [
      makeRasterRow({
        source_ref: 'S1',
        title: 'Charts Deck',
        title_slug: 'charts-deck',
      }),
    ];
    const res = resolveAtRefRequestsForRender(rows, [], ['charts-deck'], {
      agentSupportsVision: true,
      maxImages: 4,
    });
    expect(res).toHaveLength(1);
    expect(res[0].kind).toBe('pdf-page-images');
  });

  it('resolves a raster-only PDF (text extraction failed) to pdf-page-images', () => {
    const rows = [
      makeRasterRow({
        source_ref: 'S1',
        title: 'Scan',
        status: 'failed',
        extracted_text: null,
      }),
    ];
    const res = resolveAtRefRequestsForRender(rows, ['S1'], [], {
      agentSupportsVision: true,
    });
    expect(res[0].kind).toBe('pdf-page-images');
  });

  it('resolves a raster-only PDF via @<slug> even when status=failed', () => {
    const rows = [
      makeRasterRow({
        source_ref: 'S1',
        title: 'Scan',
        title_slug: 'scan',
        status: 'failed',
        extracted_text: null,
      }),
    ];
    const res = resolveAtRefRequestsForRender(rows, [], ['scan'], {
      agentSupportsVision: true,
    });
    expect(res[0].kind).toBe('pdf-page-images');
  });

  it('REGRESSION: a doc-capable agent still gets pdf-document, not page images', () => {
    const rows = [makeRasterRow({ source_ref: 'S1', title: 'Charts Deck' })];
    const res = resolveAtRefRequestsForRender(rows, ['S1'], [], {
      agentSupportsDocuments: true,
      agentSupportsVision: true,
      perSourceMaxBytes: 12 * 1024 * 1024,
    });
    expect(res[0].kind).toBe('pdf-document');
  });

  it('REGRESSION: a text-only agent (no vision) gets the extracted text', () => {
    const rows = [
      makeRasterRow({
        source_ref: 'S1',
        title: 'Charts Deck',
        extracted_text: 'the deck text',
      }),
    ];
    const res = resolveAtRefRequestsForRender(rows, ['S1'], [], {});
    expect(res[0].kind).toBe('resolved');
  });

  it('falls back to text when the page set is incomplete', () => {
    const rows = [
      makeRasterRow({
        source_ref: 'S1',
        title: 'Half-rendered',
        expected_page_count: 4,
        page_image_count: 2,
        page_indices: [0, 1],
        page_byte_sizes: [100_000, 100_000],
        extracted_text: 'fallback text',
      }),
    ];
    const res = resolveAtRefRequestsForRender(rows, ['S1'], [], {
      agentSupportsVision: true,
    });
    expect(res[0].kind).toBe('resolved');
  });
});

describe('computeRasterPageAttachment', () => {
  const row = {
    page_indices: [0, 1, 2, 3],
    page_byte_sizes: [100_000, 100_000, 100_000, 100_000],
    page_image_count: 4,
  };

  it('attaches every page when under maxImages and budget', () => {
    const att = computeRasterPageAttachment(row, {
      budgetRemainingBytes: MAX_TOTAL_RASTER_PAYLOAD_BYTES,
    });
    expect(att.pageIndices).toEqual([0, 1, 2, 3]);
    expect(att.totalPages).toBe(4);
    expect(att.truncatedReason).toBeNull();
    expect(att.bytesUsed).toBe(4 * encodedSizeBytes(100_000));
  });

  it('caps at maxImages with an image-limit truncation reason', () => {
    const att = computeRasterPageAttachment(row, {
      maxImages: 2,
      budgetRemainingBytes: MAX_TOTAL_RASTER_PAYLOAD_BYTES,
    });
    expect(att.pageIndices).toEqual([0, 1]);
    expect(att.truncatedReason).toBe('image-limit');
  });

  it('caps on the encoded payload budget with a payload-budget reason', () => {
    // Budget fits exactly one encoded page.
    const oneEncoded = encodedSizeBytes(100_000);
    const att = computeRasterPageAttachment(row, {
      budgetRemainingBytes: oneEncoded,
    });
    expect(att.pageIndices).toEqual([0]);
    expect(att.truncatedReason).toBe('payload-budget');
    expect(att.bytesUsed).toBe(oneEncoded);
  });

  it('threads a shared budget across two sources (cumulative)', () => {
    let remaining = encodedSizeBytes(100_000) * 5; // room for 5 pages total
    const a = computeRasterPageAttachment(row, {
      budgetRemainingBytes: remaining,
    });
    remaining -= a.bytesUsed;
    const b = computeRasterPageAttachment(row, {
      budgetRemainingBytes: remaining,
    });
    expect(a.pageIndices).toEqual([0, 1, 2, 3]); // first source takes 4
    expect(b.pageIndices).toEqual([0]); // only 1 page of budget left
    expect(b.truncatedReason).toBe('payload-budget');
  });

  it('preserves the actual (possibly non-contiguous) page indices', () => {
    const att = computeRasterPageAttachment(
      {
        page_indices: [0, 2, 5],
        page_byte_sizes: [100, 100, 100],
        page_image_count: 3,
      },
      { maxImages: 2, budgetRemainingBytes: MAX_TOTAL_RASTER_PAYLOAD_BYTES },
    );
    expect(att.pageIndices).toEqual([0, 2]);
  });
});

describe('renderForcedInjectionResolutions — pdf-page-images', () => {
  const baseRow = makeRasterRow({ source_ref: 'S1', title: 'Charts Deck' });

  it('renders an honest "k of N" note, the truncation cause, and keeps the text', () => {
    const resolutions: ForcedInjectionResolution[] = [
      {
        kind: 'pdf-page-images',
        sourceRef: 'S1',
        title: 'Charts Deck',
        row: { ...baseRow, extracted_text: 'exact quotable text' },
        attachment: {
          pageIndices: [0, 1],
          totalPages: 5,
          truncatedReason: 'image-limit',
        },
      },
    ];
    const text = renderForcedInjectionResolutions(resolutions);
    expect(text).toContain(
      '2 of 5 page images attached to this turn via @-ref',
    );
    expect(text).toContain('per-prompt image limit');
    expect(text).toContain('<<<source');
    expect(text).toContain('exact quotable text');
    expect(text).toContain('source>>>');
  });

  it('renders no truncation phrase when all pages fit', () => {
    const text = renderForcedInjectionResolutions([
      {
        kind: 'pdf-page-images',
        sourceRef: 'S1',
        title: 'Charts Deck',
        row: baseRow,
        attachment: {
          pageIndices: [0, 1, 2],
          totalPages: 3,
          truncatedReason: null,
        },
      },
    ]);
    expect(text).toContain('3 of 3 page images attached');
    expect(text).not.toContain('capped');
  });

  it('renders a raster-only PDF (no text) without a source fence', () => {
    const text = renderForcedInjectionResolutions([
      {
        kind: 'pdf-page-images',
        sourceRef: 'S1',
        title: 'Scan',
        row: { ...baseRow, extracted_text: null },
        attachment: {
          pageIndices: [0],
          totalPages: 1,
          truncatedReason: null,
        },
      },
    ]);
    expect(text).toContain('1 of 1 page image attached');
    expect(text).not.toContain('<<<source');
  });

  it('honestly reports when the budget left zero pages but keeps the text', () => {
    const text = renderForcedInjectionResolutions([
      {
        kind: 'pdf-page-images',
        sourceRef: 'S1',
        title: 'Charts Deck',
        row: { ...baseRow, extracted_text: 'still have the text' },
        attachment: {
          pageIndices: [],
          totalPages: 3,
          truncatedReason: 'payload-budget',
        },
      },
    ]);
    expect(text).toContain('page images omitted');
    expect(text).toContain('still have the text');
  });
});

describe('buildSourceManifest — PDF raster-awareness', () => {
  function makePdf(input: Partial<SourceRow>): SourceRow {
    return makeSource({
      source_ref: 'S1',
      source_type: 'file',
      title: 'Charts Deck',
      file_name: 'deck.pdf',
      mime_type: 'application/pdf',
      storage_key: 'attachments/talk-1/s1.pdf',
      extracted_text: 'deck text',
      ...input,
    });
  }

  it('advertises page images + the @-ref for a vision-but-not-doc agent with a complete set', () => {
    const source = makePdf({ expected_page_count: 3, page_image_count: 3 });
    const [line] = buildSourceManifest([source], true).map((m) => m.line);
    expect(line).toContain('3 page images available');
    expect(line).toContain('@S1 to attach them');
  });

  it('singularizes "page image" for a one-page PDF', () => {
    const source = makePdf({ expected_page_count: 1, page_image_count: 1 });
    const [line] = buildSourceManifest([source], true).map((m) => m.line);
    expect(line).toContain('1 page image available');
  });

  it('says text-only for a vision agent when the PDF has no page set', () => {
    const source = makePdf({ expected_page_count: null, page_image_count: 0 });
    const [line] = buildSourceManifest([source], true).map((m) => m.line);
    expect(line).toContain('text-only; no rasterized page images');
  });

  it('REGRESSION: a non-vision agent still sees the lacks-PDF-vision note', () => {
    const source = makePdf({ expected_page_count: 3, page_image_count: 3 });
    const [line] = buildSourceManifest([source], false).map((m) => m.line);
    expect(line).toContain("this agent's model lacks PDF document vision");
  });

  it('REGRESSION: a doc-capable agent still sees the native-attach note', () => {
    const source = makePdf({ expected_page_count: 3, page_image_count: 3 });
    const [line] = buildSourceManifest([source], true, {
      agentSupportsDocuments: true,
      autoAttachedRefs: new Set(['S1']),
      forceAttachedRefs: new Set(),
    }).map((m) => m.line);
    expect(line).toContain('pages attached to this turn');
    expect(line).not.toContain('page images available');
  });
});
