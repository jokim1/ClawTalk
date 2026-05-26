// Tests for the content_edits composer + materializer.
//
// Pure-JS tests for the render-time + accept-time composer in
// content-edits-ops.ts. No DB / no network.

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_ATTR_KEY,
  composeBody,
  materializeEdits,
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
