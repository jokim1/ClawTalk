// Tests for the content_edits composer + materializer.
//
// Pure-JS tests for the render-time + accept-time composer in
// content-edits-ops.ts. No DB / no network.

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_ATTR_KEY,
  composeBody,
  composeBodyHtml,
  materializeEdits,
  materializeEditsHtml,
  listPendingRunIds,
  groupEditsByRun,
  getPendingRunSummary,
  tiptapJsonToMarkdown,
  PENDING_EDIT_ID_ATTR,
  PENDING_KIND_ATTR,
  PENDING_REPLACE_WRAPPER_TYPE,
  type ContentEditRow,
} from './index.js';

function edit(overrides: Partial<ContentEditRow>): ContentEditRow {
  return {
    id: overrides.id ?? 'edit-x',
    contentId: 'content-1',
    runId: overrides.runId ?? 'run-1',
    agentId: null,
    agentNickname: null,
    messageId: null,
    kind: 'insert',
    baseContentVersion: 1,
    targetAnchorId: null,
    newMarkdown: null,
    newHtml: null,
    rationale: null,
    createdAt: '2026-05-26T12:00:00Z',
    ...overrides,
  };
}

// Deterministic anchor generator so test assertions stay stable.
function makeGenerator(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const SAMPLE_BODY = `<!-- anchor:h1 -->
# Title

<!-- anchor:p1 -->
First paragraph.

<!-- anchor:p2 -->
Second paragraph.`;

describe('composeBody', () => {
  it('returns the parsed body unchanged when no edits', () => {
    const { doc, skippedEditIds } = composeBody(SAMPLE_BODY, []);
    expect(skippedEditIds).toEqual([]);
    expect(doc.content.length).toBe(3);
    expect(doc.content[0].attrs?.[ANCHOR_ATTR_KEY]).toBe('h1');
    expect(doc.content[1].attrs?.[ANCHOR_ATTR_KEY]).toBe('p1');
    expect(doc.content[2].attrs?.[ANCHOR_ATTR_KEY]).toBe('p2');
  });

  it('applies a pending insert after the target anchor', () => {
    const e = edit({
      id: 'e1',
      kind: 'insert',
      targetAnchorId: 'p1',
      newMarkdown: 'Inserted paragraph.',
    });
    const { doc, skippedEditIds } = composeBody(SAMPLE_BODY, [e], {
      generate: makeGenerator('new-'),
    });
    expect(skippedEditIds).toEqual([]);
    expect(doc.content.length).toBe(4);
    // h1, p1, [inserted], p2
    expect(doc.content[0].attrs?.[ANCHOR_ATTR_KEY]).toBe('h1');
    expect(doc.content[1].attrs?.[ANCHOR_ATTR_KEY]).toBe('p1');
    expect(doc.content[2].attrs?.[PENDING_KIND_ATTR]).toBe('insert');
    expect(doc.content[2].attrs?.[PENDING_EDIT_ID_ATTR]).toBe('e1');
    expect(doc.content[3].attrs?.[ANCHOR_ATTR_KEY]).toBe('p2');
  });

  it('prepends a pending insert when target anchor is null', () => {
    const e = edit({
      id: 'e1',
      kind: 'insert',
      targetAnchorId: null,
      newMarkdown: 'Prepended paragraph.',
    });
    const { doc } = composeBody(SAMPLE_BODY, [e]);
    expect(doc.content.length).toBe(4);
    expect(doc.content[0].attrs?.[PENDING_KIND_ATTR]).toBe('insert');
    expect(doc.content[0].attrs?.[PENDING_EDIT_ID_ATTR]).toBe('e1');
    expect(doc.content[1].attrs?.[ANCHOR_ATTR_KEY]).toBe('h1');
  });

  it('wraps a pending replace with prior + new children', () => {
    const e = edit({
      id: 'r1',
      kind: 'replace',
      targetAnchorId: 'p1',
      newMarkdown: 'Rewritten paragraph.',
    });
    const { doc, skippedEditIds } = composeBody(SAMPLE_BODY, [e]);
    expect(skippedEditIds).toEqual([]);
    expect(doc.content.length).toBe(3);
    const wrapper = doc.content[1];
    expect(wrapper.type).toBe(PENDING_REPLACE_WRAPPER_TYPE);
    expect(wrapper.attrs?.[PENDING_EDIT_ID_ATTR]).toBe('r1');
    expect(wrapper.attrs?.[PENDING_KIND_ATTR]).toBe('replace');
    // Anchor preserved for gutter positioning.
    expect(wrapper.attrs?.[ANCHOR_ATTR_KEY]).toBe('p1');
    expect(wrapper.content?.[0].attrs?.role).toBe('prior');
    expect(wrapper.content?.[1].attrs?.role).toBe('new');
  });

  it('marks a pending delete on the existing block', () => {
    const e = edit({
      id: 'd1',
      kind: 'delete',
      targetAnchorId: 'p2',
      newMarkdown: null,
    });
    const { doc } = composeBody(SAMPLE_BODY, [e]);
    expect(doc.content.length).toBe(3);
    expect(doc.content[2].attrs?.[PENDING_KIND_ATTR]).toBe('delete');
    expect(doc.content[2].attrs?.[PENDING_EDIT_ID_ATTR]).toBe('d1');
    expect(doc.content[2].attrs?.[ANCHOR_ATTR_KEY]).toBe('p2');
  });

  it('replaces the entire body for a bulk edit and marks every block', () => {
    const e = edit({
      id: 'b1',
      kind: 'bulk',
      targetAnchorId: null,
      newMarkdown: '# New title\n\nNew body.',
    });
    const { doc } = composeBody(SAMPLE_BODY, [e]);
    expect(doc.content.length).toBe(2);
    for (const node of doc.content) {
      expect(node.attrs?.[PENDING_KIND_ATTR]).toBe('insert');
      expect(node.attrs?.[PENDING_EDIT_ID_ATTR]).toBe('b1');
    }
  });

  it('bulk supersedes other edits in the same run', () => {
    const e1 = edit({
      id: 'i1',
      kind: 'insert',
      targetAnchorId: 'p1',
      newMarkdown: 'Should not render.',
    });
    const e2 = edit({
      id: 'b1',
      kind: 'bulk',
      newMarkdown: '# Bulk wins',
    });
    const { doc } = composeBody(SAMPLE_BODY, [e1, e2]);
    expect(doc.content.length).toBe(1);
    expect(doc.content[0].attrs?.[PENDING_EDIT_ID_ATTR]).toBe('b1');
  });

  it('skips edits whose target anchor is missing', () => {
    const e = edit({
      id: 'r-bad',
      kind: 'replace',
      targetAnchorId: 'nope',
      newMarkdown: 'never rendered',
    });
    const { doc, skippedEditIds } = composeBody(SAMPLE_BODY, [e]);
    expect(skippedEditIds).toEqual(['r-bad']);
    // Body unchanged.
    expect(doc.content.length).toBe(3);
  });

  it('applies inserts in created_at order (caller-supplied order)', () => {
    const first = edit({
      id: 'i1',
      kind: 'insert',
      targetAnchorId: 'p1',
      newMarkdown: 'First insert.',
      createdAt: '2026-05-26T12:00:00Z',
    });
    const second = edit({
      id: 'i2',
      kind: 'insert',
      targetAnchorId: 'p1',
      newMarkdown: 'Second insert.',
      createdAt: '2026-05-26T12:00:01Z',
    });
    const { doc } = composeBody(SAMPLE_BODY, [first, second]);
    // h1, p1, [first], [second], p2 — both inserted AFTER p1, second
    // applied to a doc that already has first inserted after p1, so
    // second lands right after p1 as well, pushing first down one.
    // Order of insertion-at-same-position: latest call lands first.
    expect(doc.content.length).toBe(5);
    expect(doc.content[1].attrs?.[ANCHOR_ATTR_KEY]).toBe('p1');
    expect(doc.content[2].attrs?.[PENDING_EDIT_ID_ATTR]).toBe('i2');
    expect(doc.content[3].attrs?.[PENDING_EDIT_ID_ATTR]).toBe('i1');
  });
});

describe('materializeEdits', () => {
  it('returns the parsed body for no edits', () => {
    const doc = materializeEdits(SAMPLE_BODY, []);
    expect(doc.content.length).toBe(3);
    // No pending markers anywhere.
    for (const node of doc.content) {
      expect(node.attrs?.[PENDING_KIND_ATTR]).toBeUndefined();
      expect(node.attrs?.[PENDING_EDIT_ID_ATTR]).toBeUndefined();
    }
  });

  it('materializes an insert into the body (no pending markers)', () => {
    const e = edit({
      kind: 'insert',
      targetAnchorId: 'p1',
      newMarkdown: 'Accepted insert.',
    });
    const doc = materializeEdits(SAMPLE_BODY, [e], {
      generate: makeGenerator('acc-'),
    });
    expect(doc.content.length).toBe(4);
    expect(doc.content[2].attrs?.[PENDING_KIND_ATTR]).toBeUndefined();
    // The inserted block got an anchor stamp from the generator.
    expect(doc.content[2].attrs?.[ANCHOR_ATTR_KEY]).toBe('acc-1');
    const md = tiptapJsonToMarkdown(doc);
    expect(md).toContain('Accepted insert.');
  });

  it('materializes a replace by swapping the target block', () => {
    const e = edit({
      kind: 'replace',
      targetAnchorId: 'p1',
      newMarkdown: 'Replaced paragraph.',
    });
    const doc = materializeEdits(SAMPLE_BODY, [e]);
    expect(doc.content.length).toBe(3);
    // The new block inherits the target anchor (single-node replace).
    expect(doc.content[1].attrs?.[ANCHOR_ATTR_KEY]).toBe('p1');
    const md = tiptapJsonToMarkdown(doc);
    expect(md).toContain('Replaced paragraph.');
    expect(md).not.toContain('First paragraph.');
  });

  it('materializes a delete by dropping the target block', () => {
    const e = edit({
      kind: 'delete',
      targetAnchorId: 'p2',
      newMarkdown: null,
    });
    const doc = materializeEdits(SAMPLE_BODY, [e]);
    expect(doc.content.length).toBe(2);
    const md = tiptapJsonToMarkdown(doc);
    expect(md).not.toContain('Second paragraph.');
  });

  it('materializes a bulk by replacing entire body with fresh anchors', () => {
    const e = edit({
      kind: 'bulk',
      newMarkdown: '# Bulk title\n\nBulk body.',
    });
    const doc = materializeEdits(SAMPLE_BODY, [e], {
      generate: makeGenerator('bulk-'),
    });
    expect(doc.content.length).toBe(2);
    expect(doc.content[0].attrs?.[ANCHOR_ATTR_KEY]).toBe('bulk-1');
    expect(doc.content[1].attrs?.[ANCHOR_ATTR_KEY]).toBe('bulk-2');
    const md = tiptapJsonToMarkdown(doc);
    expect(md).toContain('# Bulk title');
  });

  it('respects edit order — second edit reads body produced by first', () => {
    const e1 = edit({
      id: 'i1',
      kind: 'insert',
      targetAnchorId: 'p1',
      newMarkdown: 'First.',
    });
    const e2 = edit({
      id: 'r1',
      kind: 'replace',
      targetAnchorId: 'p2',
      newMarkdown: 'Replaced second.',
    });
    const doc = materializeEdits(SAMPLE_BODY, [e1, e2]);
    expect(doc.content.length).toBe(4);
    const md = tiptapJsonToMarkdown(doc);
    expect(md).toContain('First.');
    expect(md).toContain('Replaced second.');
    expect(md).not.toContain('Second paragraph.');
  });

  it('skips edits whose anchor is missing (no throw)', () => {
    const e = edit({
      kind: 'replace',
      targetAnchorId: 'nope',
      newMarkdown: 'ignored',
    });
    const doc = materializeEdits(SAMPLE_BODY, [e]);
    expect(doc.content.length).toBe(3);
  });
});

describe('listPendingRunIds', () => {
  it('returns distinct run ids in encounter order', () => {
    const a = edit({ id: 'a', runId: 'run-1' });
    const b = edit({ id: 'b', runId: 'run-2' });
    const c = edit({ id: 'c', runId: 'run-1' });
    expect(listPendingRunIds([a, b, c])).toEqual(['run-1', 'run-2']);
  });

  it('returns [] for no edits', () => {
    expect(listPendingRunIds([])).toEqual([]);
  });
});

describe('groupEditsByRun', () => {
  it('buckets edits by run id', () => {
    const a = edit({ id: 'a', runId: 'r1' });
    const b = edit({ id: 'b', runId: 'r2' });
    const c = edit({ id: 'c', runId: 'r1' });
    const grouped = groupEditsByRun([a, b, c]);
    expect(grouped.get('r1')?.map((e) => e.id)).toEqual(['a', 'c']);
    expect(grouped.get('r2')?.map((e) => e.id)).toEqual(['b']);
  });
});

describe('getPendingRunSummary', () => {
  it('aggregates counts by kind and pulls the latest non-null rationale', () => {
    const e1 = edit({
      id: 'a',
      runId: 'r1',
      kind: 'insert',
      agentId: 'agent-1',
      agentNickname: 'Kimi',
      rationale: 'first thought',
    });
    const e2 = edit({
      id: 'b',
      runId: 'r1',
      kind: 'replace',
      agentId: 'agent-1',
      agentNickname: 'Kimi',
      rationale: 'better thought',
    });
    const e3 = edit({
      id: 'c',
      runId: 'r1',
      kind: 'delete',
      agentId: 'agent-1',
      agentNickname: 'Kimi',
      rationale: null,
    });
    const summary = getPendingRunSummary([e1, e2, e3], 'r1');
    expect(summary).not.toBeNull();
    expect(summary?.counts).toEqual({
      insert: 1,
      replace: 1,
      delete: 1,
      bulk: 0,
      total: 3,
    });
    expect(summary?.agentNickname).toBe('Kimi');
    expect(summary?.rationale).toBe('better thought');
  });

  it('returns null for an unknown runId', () => {
    expect(getPendingRunSummary([], 'nope')).toBeNull();
  });
});

// ── HTML compose / materialize tests (PR B) ─────────────────────────

const SAMPLE_HTML =
  '<h1 data-anchor-id="h1">Title</h1>' +
  '<p data-anchor-id="p1">First paragraph.</p>' +
  '<p data-anchor-id="p2">Second paragraph.</p>';

describe('composeBodyHtml', () => {
  it('returns the parsed body unchanged when no edits', () => {
    const result = composeBodyHtml(SAMPLE_HTML, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skippedEditIds).toEqual([]);
    expect(result.html).toContain('data-anchor-id="h1"');
    expect(result.html).toContain('First paragraph.');
    expect(result.html).toContain('Second paragraph.');
    expect(result.html).not.toContain('data-pending-kind');
  });

  it('annotates a pending insert after the target anchor', () => {
    const e = edit({
      id: 'i-1',
      kind: 'insert',
      targetAnchorId: 'p1',
      newHtml: '<p>Inserted block.</p>',
    });
    const result = composeBodyHtml(SAMPLE_HTML, [e], {
      generate: makeGenerator('new-'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skippedEditIds).toEqual([]);
    // Inserted block sits between p1 and p2 with pending markers. Match
    // by structure: anchor + pending attrs in any order between the
    // bracket pair, but the inserted text and surrounding anchors must
    // appear in document order.
    expect(result.html).toMatch(
      /data-anchor-id="p1"[^>]*>First paragraph\.<\/p><p [^>]+>Inserted block\.<\/p><p[^>]*data-anchor-id="p2"/,
    );
    expect(result.html).toContain('data-anchor-id="new-1"');
    expect(result.html).toContain('data-pending-kind="insert"');
    expect(result.html).toContain('data-pending-edit-id="i-1"');
  });

  it('prepends a pending insert when target anchor is null', () => {
    const e = edit({
      id: 'i-top',
      kind: 'insert',
      targetAnchorId: null,
      newHtml: '<p>Top block.</p>',
    });
    const result = composeBodyHtml(SAMPLE_HTML, [e], {
      generate: makeGenerator('top-'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // First top-level child carries the new edit + appears before h1.
    expect(result.html).toMatch(
      /^<p [^>]*>Top block\.<\/p><h1[^>]*>Title<\/h1>/,
    );
    expect(result.html).toContain('data-anchor-id="top-1"');
    expect(result.html).toContain('data-pending-kind="insert"');
    expect(result.html).toContain('data-pending-edit-id="i-top"');
  });

  it('splits a pending replace into prior + new sibling blocks', () => {
    const e = edit({
      id: 'r-1',
      kind: 'replace',
      targetAnchorId: 'p1',
      newHtml: '<p>New paragraph.</p>',
    });
    const result = composeBodyHtml(SAMPLE_HTML, [e], {
      generate: makeGenerator('rp-'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Prior keeps its anchor and gets role=prior; new sibling gets role=new.
    // Attribute order is linkedom-dependent — assert each attribute appears
    // alongside its sibling, not in a fixed order.
    expect(result.html).toMatch(
      /<p [^>]*data-anchor-id="p1"[^>]*data-pending-role="prior"|data-pending-role="prior"[^>]*data-anchor-id="p1"/,
    );
    expect(result.html).toMatch(
      /data-pending-edit-id="r-1"[^>]*data-pending-role="prior"|data-pending-role="prior"[^>]*data-pending-edit-id="r-1"/,
    );
    expect(result.html).toMatch(
      /data-pending-edit-id="r-1"[^>]*data-pending-role="new"|data-pending-role="new"[^>]*data-pending-edit-id="r-1"/,
    );
    expect(result.html).toContain('New paragraph.');
  });

  it('marks a pending delete on the existing block', () => {
    const e = edit({
      id: 'd-1',
      kind: 'delete',
      targetAnchorId: 'p2',
      newHtml: null,
    });
    const result = composeBodyHtml(SAMPLE_HTML, [e]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The original p2 block carries the pending-delete marker pair.
    expect(result.html).toMatch(
      /<p [^>]*data-anchor-id="p2"[^>]*data-pending-kind="delete"|data-pending-kind="delete"[^>]*data-anchor-id="p2"/,
    );
    expect(result.html).toContain('data-pending-edit-id="d-1"');
  });

  it('bulk supersedes other edits and marks every new block as insert', () => {
    const granular = edit({
      id: 'g-1',
      kind: 'insert',
      targetAnchorId: 'p1',
      newHtml: '<p>Ignored.</p>',
    });
    const bulk = edit({
      id: 'b-1',
      kind: 'bulk',
      targetAnchorId: null,
      newHtml: '<h1>Bulk title</h1><p>Bulk body.</p>',
    });
    const result = composeBodyHtml(SAMPLE_HTML, [granular, bulk], {
      generate: makeGenerator('blk-'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('Bulk title');
    expect(result.html).toContain('Bulk body.');
    expect(result.html).not.toContain('Ignored.');
    // Every block in the bulk output carries the pending-insert + edit id.
    expect(result.html.match(/data-pending-kind="insert"/g)?.length ?? 0).toBe(
      2,
    );
  });

  it('skips edits with a missing target anchor', () => {
    const e = edit({
      id: 'r-bad',
      kind: 'replace',
      targetAnchorId: 'does-not-exist',
      newHtml: '<p>Never seen.</p>',
    });
    const result = composeBodyHtml(SAMPLE_HTML, [e]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skippedEditIds).toEqual(['r-bad']);
    expect(result.html).not.toContain('Never seen.');
  });

  it('stamps missing top-level anchors before composing', () => {
    const result = composeBodyHtml('<p>No anchor yet.</p>', [], {
      generate: makeGenerator('stamp-'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('data-anchor-id="stamp-1"');
  });
});

describe('materializeEditsHtml', () => {
  it('returns the parsed body for no edits', () => {
    const result = materializeEditsHtml(SAMPLE_HTML, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toContain('data-pending-kind');
    expect(result.html).toContain('Title');
    expect(result.html).toContain('First paragraph.');
  });

  it('materializes an insert into the body (no pending markers)', () => {
    const e = edit({
      kind: 'insert',
      targetAnchorId: 'p1',
      newHtml: '<p>Accepted insert.</p>',
    });
    const result = materializeEditsHtml(SAMPLE_HTML, [e], {
      generate: makeGenerator('acc-'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain(
      '<p data-anchor-id="acc-1">Accepted insert.</p>',
    );
    expect(result.html).not.toContain('data-pending-kind');
  });

  it('materializes a single-node replace by inheriting the target anchor', () => {
    const e = edit({
      kind: 'replace',
      targetAnchorId: 'p1',
      newHtml: '<p>Replaced.</p>',
    });
    const result = materializeEditsHtml(SAMPLE_HTML, [e]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('<p data-anchor-id="p1">Replaced.</p>');
    expect(result.html).not.toContain('First paragraph.');
  });

  it('materializes a multi-node replace with fresh anchors', () => {
    const e = edit({
      kind: 'replace',
      targetAnchorId: 'p1',
      newHtml: '<p>First new.</p><p>Second new.</p>',
    });
    const result = materializeEditsHtml(SAMPLE_HTML, [e], {
      generate: makeGenerator('mr-'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('First new.');
    expect(result.html).toContain('Second new.');
    expect(result.html).not.toContain('First paragraph.');
    expect(result.html).toContain('data-anchor-id="mr-');
  });

  it('materializes a delete by dropping the target block', () => {
    const e = edit({
      kind: 'delete',
      targetAnchorId: 'p2',
      newHtml: null,
    });
    const result = materializeEditsHtml(SAMPLE_HTML, [e]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toContain('Second paragraph.');
    expect(result.html).toContain('First paragraph.');
  });

  it('materializes a bulk by replacing the whole body with fresh anchors', () => {
    const e = edit({
      kind: 'bulk',
      newHtml: '<h1>Bulk H1</h1><p>Bulk para.</p>',
    });
    const result = materializeEditsHtml(SAMPLE_HTML, [e], {
      generate: makeGenerator('bk-'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('Bulk H1');
    expect(result.html).toContain('Bulk para.');
    expect(result.html).not.toContain('Title');
    // Fresh anchors stamped — both top-level blocks get one.
    expect(result.html.match(/data-anchor-id="bk-/g)?.length ?? 0).toBe(2);
  });

  it('respects edit order — second edit sees the body after first', () => {
    const insert = edit({
      id: 'i-1',
      kind: 'insert',
      targetAnchorId: 'p1',
      newHtml: '<p>Inserted.</p>',
    });
    const replace = edit({
      id: 'r-1',
      kind: 'replace',
      targetAnchorId: 'p2',
      newHtml: '<p>Replaced second.</p>',
    });
    const result = materializeEditsHtml(SAMPLE_HTML, [insert, replace]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('Inserted.');
    expect(result.html).toContain('Replaced second.');
    expect(result.html).not.toContain('Second paragraph.');
  });

  it('skips edits whose anchor is missing (no throw)', () => {
    const e = edit({
      kind: 'replace',
      targetAnchorId: 'nope',
      newHtml: '<p>Ignored.</p>',
    });
    const result = materializeEditsHtml(SAMPLE_HTML, [e]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toContain('Ignored.');
    expect(result.html).toContain('First paragraph.');
  });

  it('round-trips compose -> materialize: pending markers vanish on accept', () => {
    const e = edit({
      id: 'rt-1',
      kind: 'replace',
      targetAnchorId: 'p1',
      newHtml: '<p>Accepted via roundtrip.</p>',
    });
    const composed = composeBodyHtml(SAMPLE_HTML, [e]);
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.html).toContain('data-pending-kind');
    const materialized = materializeEditsHtml(SAMPLE_HTML, [e]);
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.html).toContain('Accepted via roundtrip.');
    expect(materialized.html).not.toContain('First paragraph.');
    expect(materialized.html).not.toContain('data-pending-kind');
  });
});
