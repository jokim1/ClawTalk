// Content feature PR 1 — typed accessors for the `contents` and
// `content_proposals` tables.
//
// Caller contract: every function below must run inside a
// `withUserContext(userId, ...)` block. RLS on both tables gates by
// `owner_id = auth.uid()`; the surrounding `withRequestScopedDb`
// scope opens the notify queue so outbox emits get flushed
// post-commit.
//
// The accept/update paths route the body through the shared
// `src/shared/rich-text/` module: markdown → Tiptap JSON → AST
// mutation → markdown. The anchor map is recomputed from the
// resulting JSON; the body and the map always ship together.

import { getDbPg } from '../../db.js';
import {
  type AnchorMap,
  type RichTextDocument,
  type RichTextNode,
  computeAnchorMap,
  ensureAnchorIds,
  findBlockIndexByAnchor,
  getAnchorId,
  insertAfterAnchor,
  markdownToTiptapJson,
  sanitizeMarkdown,
  sanitizeRichTextDocument,
  tiptapJsonToMarkdown,
} from '../../shared/rich-text/index.js';
import { emitOutboxEvent } from '../talks/outbox-emit.js';

export const CONTENT_BODY_BYTE_LIMIT = 512_000;
export type ProposalKind = 'append';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface ContentRecord {
  id: string;
  owner_id: string;
  talk_id: string;
  title: string;
  content_kind: string;
  content_format: string;
  body_markdown: string;
  body_version: number;
  anchor_map_json: AnchorMap;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

export interface Content {
  id: string;
  ownerId: string;
  talkId: string;
  title: string;
  contentKind: string;
  contentFormat: string;
  bodyMarkdown: string;
  bodyVersion: number;
  anchorMap: AnchorMap;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

export interface ContentProposalRecord {
  id: string;
  content_id: string;
  owner_id: string;
  proposed_by_run_id: string | null;
  proposed_by_agent_id: string | null;
  proposed_by_message_id: string | null;
  kind: ProposalKind;
  after_anchor_id: string | null;
  inserted_markdown: string;
  rationale: string | null;
  status: ProposalStatus;
  status_reason: string | null;
  base_content_version: number;
  base_anchor_content_hash: string | null;
  applied_anchor_ids: string[];
  created_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
}

export interface ContentProposal {
  id: string;
  contentId: string;
  proposedByRunId: string | null;
  proposedByAgentId: string | null;
  proposedByMessageId: string | null;
  kind: ProposalKind;
  afterAnchorId: string | null;
  insertedMarkdown: string;
  rationale: string | null;
  status: ProposalStatus;
  statusReason: string | null;
  baseContentVersion: number;
  baseAnchorContentHash: string | null;
  appliedAnchorIds: string[];
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
}

function toContent(row: ContentRecord): Content {
  return {
    id: row.id,
    ownerId: row.owner_id,
    talkId: row.talk_id,
    title: row.title,
    contentKind: row.content_kind,
    contentFormat: row.content_format,
    bodyMarkdown: row.body_markdown,
    bodyVersion: row.body_version,
    anchorMap: row.anchor_map_json ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

function toProposal(row: ContentProposalRecord): ContentProposal {
  return {
    id: row.id,
    contentId: row.content_id,
    proposedByRunId: row.proposed_by_run_id,
    proposedByAgentId: row.proposed_by_agent_id,
    proposedByMessageId: row.proposed_by_message_id,
    kind: row.kind,
    afterAnchorId: row.after_anchor_id,
    insertedMarkdown: row.inserted_markdown,
    rationale: row.rationale,
    status: row.status,
    statusReason: row.status_reason,
    baseContentVersion: row.base_content_version,
    baseAnchorContentHash: row.base_anchor_content_hash,
    appliedAnchorIds: row.applied_anchor_ids ?? [],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedByUserId: row.resolved_by_user_id,
  };
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Content title is required');
  return trimmed;
}

function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// ── content CRUD ─────────────────────────────────────────────────

export async function createContent(input: {
  ownerId: string;
  talkId: string;
  title: string;
  createdByUserId?: string | null;
}): Promise<Content> {
  const title = normalizeTitle(input.title);
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    insert into public.contents
      (owner_id, talk_id, title, content_kind, content_format,
       body_markdown, body_version, anchor_map_json,
       created_by_user_id, updated_by_user_id, updated_by_run_id)
    values
      (${input.ownerId}::uuid, ${input.talkId}::uuid, ${title},
       'document', 'markdown',
       '', 1, '{}'::jsonb,
       ${input.createdByUserId ?? null}::uuid,
       ${input.createdByUserId ?? null}::uuid,
       null)
    returning id, owner_id, talk_id, title, content_kind, content_format,
              body_markdown, body_version, anchor_map_json,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  return toContent(rows[0]);
}

export interface ContentSidebarRecord {
  id: string;
  talk_id: string;
  title: string;
  updated_at: string;
}

export async function listContentsForSidebar(): Promise<
  ContentSidebarRecord[]
> {
  const db = getDbPg();
  const rows = await db<ContentSidebarRecord[]>`
    select id, talk_id, title, updated_at
    from public.contents
    order by updated_at desc, id
  `;
  return rows;
}

export async function getContentByTalkId(
  talkId: string,
): Promise<Content | null> {
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0] ? toContent(rows[0]) : null;
}

export async function getContentById(
  contentId: string,
): Promise<Content | null> {
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${contentId}::uuid
    limit 1
  `;
  return rows[0] ? toContent(rows[0]) : null;
}

export type UpdateContentResult =
  | {
      kind: 'ok';
      content: Content;
      staledProposalIds: string[];
    }
  | { kind: 'conflict'; current: Content }
  | { kind: 'not_found' }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

export async function updateContentBody(input: {
  contentId: string;
  ownerId: string;
  expectedVersion: number;
  bodyMarkdown: string;
  title?: string;
  updatedByUserId?: string | null;
  updatedByRunId?: string | null;
}): Promise<UpdateContentResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('expectedVersion must be a positive integer');
  }

  const sanitized = sanitizeMarkdown(input.bodyMarkdown);
  if (byteLengthOf(sanitized) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(sanitized),
    };
  }

  // Parse → re-stamp anchors → re-serialize so the markdown reflects
  // the canonical anchored shape regardless of what the client sent.
  const parsed = sanitizeRichTextDocument(markdownToTiptapJson(sanitized));
  const stamped = ensureAnchorIds(parsed);
  const canonicalMarkdown = tiptapJsonToMarkdown(stamped);
  if (byteLengthOf(canonicalMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(canonicalMarkdown),
    };
  }
  const anchorMap = await computeAnchorMap(stamped);

  const db = getDbPg();
  const existingRows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) return { kind: 'not_found' };
  if (existing.body_version !== input.expectedVersion) {
    return { kind: 'conflict', current: toContent(existing) };
  }

  const nextTitle =
    input.title !== undefined ? normalizeTitle(input.title) : existing.title;

  const updatedRows = await db<ContentRecord[]>`
    update public.contents
    set body_markdown = ${canonicalMarkdown},
        body_version = body_version + 1,
        anchor_map_json = ${db.json(anchorMap as never)},
        title = ${nextTitle},
        updated_at = now(),
        updated_by_user_id = ${input.updatedByUserId ?? null}::uuid,
        updated_by_run_id = ${input.updatedByRunId ?? null}::uuid
    where id = ${input.contentId}::uuid
      and body_version = ${input.expectedVersion}
    returning id, owner_id, talk_id, title, content_kind, content_format,
              body_markdown, body_version, anchor_map_json,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  const updated = updatedRows[0];
  if (!updated) {
    // CAS lost. Refetch for the caller.
    const refetch = await db<ContentRecord[]>`
      select id, owner_id, talk_id, title, content_kind, content_format,
             body_markdown, body_version, anchor_map_json,
             created_at, updated_at,
             created_by_user_id, updated_by_user_id, updated_by_run_id
      from public.contents
      where id = ${input.contentId}::uuid
      limit 1
    `;
    if (!refetch[0]) return { kind: 'not_found' };
    return { kind: 'conflict', current: toContent(refetch[0]) };
  }

  // In the same transaction, mark stale any pending proposal whose
  // after_anchor_id no longer exists in the new anchor map.
  // The `?` operator tests jsonb key existence at the top level —
  // anchor_map_json is shaped `{ anchorId: { ... } }`, so this checks
  // whether the anchor key is present.
  const staleRows = await db<{ id: string }[]>`
    update public.content_proposals
    set status = 'stale',
        status_reason = 'anchor_removed',
        resolved_at = now()
    where content_id = ${input.contentId}::uuid
      and status = 'pending'
      and after_anchor_id is not null
      and not (${db.json(anchorMap as never)}::jsonb ? after_anchor_id)
    returning id
  `;
  const staledProposalIds = staleRows.map((r) => r.id);

  for (const id of staledProposalIds) {
    await emitOutboxEvent({
      topic: `talk:${updated.talk_id}`,
      eventType: 'content_proposal_stale',
      payload: {
        contentId: updated.id,
        proposalId: id,
        reason: 'anchor_removed',
      },
      ownerIds: [updated.owner_id],
    });
  }

  await emitOutboxEvent({
    topic: `talk:${updated.talk_id}`,
    eventType: 'content_updated',
    payload: {
      contentId: updated.id,
      version: updated.body_version,
      appliedAnchorIds: [],
    },
    ownerIds: [updated.owner_id],
  });

  return {
    kind: 'ok',
    content: toContent(updated),
    staledProposalIds,
  };
}

// ── proposals ────────────────────────────────────────────────────

export async function getProposalById(
  proposalId: string,
): Promise<ContentProposal | null> {
  const db = getDbPg();
  const rows = await db<ContentProposalRecord[]>`
    select id, content_id, owner_id, proposed_by_run_id,
           proposed_by_agent_id, proposed_by_message_id,
           kind, after_anchor_id, inserted_markdown, rationale,
           status, status_reason, base_content_version,
           base_anchor_content_hash, applied_anchor_ids,
           created_at, resolved_at, resolved_by_user_id
    from public.content_proposals
    where id = ${proposalId}::uuid
    limit 1
  `;
  return rows[0] ? toProposal(rows[0]) : null;
}

export async function listPendingProposalsByContentId(
  contentId: string,
): Promise<ContentProposal[]> {
  const db = getDbPg();
  const rows = await db<ContentProposalRecord[]>`
    select id, content_id, owner_id, proposed_by_run_id,
           proposed_by_agent_id, proposed_by_message_id,
           kind, after_anchor_id, inserted_markdown, rationale,
           status, status_reason, base_content_version,
           base_anchor_content_hash, applied_anchor_ids,
           created_at, resolved_at, resolved_by_user_id
    from public.content_proposals
    where content_id = ${contentId}::uuid
      and status = 'pending'
    order by created_at asc, id asc
  `;
  return rows.map(toProposal);
}

export interface CreateProposalInput {
  contentId: string;
  ownerId: string;
  kind: ProposalKind;
  afterAnchorId: string | null;
  insertedMarkdown: string;
  rationale?: string | null;
  proposedByRunId?: string | null;
  proposedByAgentId?: string | null;
  proposedByMessageId?: string | null;
}

export type CreateProposalResult =
  | { kind: 'ok'; proposal: ContentProposal }
  | { kind: 'content_not_found' }
  | { kind: 'anchor_missing'; anchorId: string }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

export async function createProposal(
  input: CreateProposalInput,
): Promise<CreateProposalResult> {
  if (byteLengthOf(input.insertedMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(input.insertedMarkdown),
    };
  }

  const db = getDbPg();
  const contentRows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const content = contentRows[0];
  if (!content) return { kind: 'content_not_found' };

  // Derive base_anchor_content_hash from the content's current anchor
  // map so callers (tool handlers, test code) don't have to recompute
  // it. content_hash on the map is the canonical "anchor block's
  // plain text at last save" value; the accept path compares against
  // it for drift detection.
  const anchorMap = content.anchor_map_json ?? {};
  let baseAnchorContentHash: string | null = null;
  if (input.afterAnchorId !== null) {
    const entry = anchorMap[input.afterAnchorId];
    if (!entry) {
      return { kind: 'anchor_missing', anchorId: input.afterAnchorId };
    }
    baseAnchorContentHash = entry.content_hash ?? null;
  }

  const sanitizedInsert = sanitizeMarkdown(input.insertedMarkdown);

  const rows = await db<ContentProposalRecord[]>`
    insert into public.content_proposals
      (content_id, owner_id, proposed_by_run_id, proposed_by_agent_id,
       proposed_by_message_id, kind, after_anchor_id, inserted_markdown,
       rationale, status, base_content_version, base_anchor_content_hash)
    values
      (${input.contentId}::uuid, ${input.ownerId}::uuid,
       ${input.proposedByRunId ?? null}::uuid,
       ${input.proposedByAgentId ?? null}::uuid,
       ${input.proposedByMessageId ?? null}::uuid,
       ${input.kind}, ${input.afterAnchorId},
       ${sanitizedInsert}, ${input.rationale ?? null},
       'pending', ${content.body_version},
       ${baseAnchorContentHash})
    returning id, content_id, owner_id, proposed_by_run_id,
              proposed_by_agent_id, proposed_by_message_id,
              kind, after_anchor_id, inserted_markdown, rationale,
              status, status_reason, base_content_version,
              base_anchor_content_hash, applied_anchor_ids,
              created_at, resolved_at, resolved_by_user_id
  `;
  const proposal = toProposal(rows[0]);

  await emitOutboxEvent({
    topic: `talk:${content.talk_id}`,
    eventType: 'content_proposal_created',
    payload: {
      contentId: content.id,
      proposalId: proposal.id,
      messageId: proposal.proposedByMessageId,
      afterAnchorId: proposal.afterAnchorId,
      agentId: proposal.proposedByAgentId,
    },
    ownerIds: [content.owner_id],
  });

  return { kind: 'ok', proposal };
}

export type AcceptProposalResult =
  | {
      kind: 'ok';
      content: Content;
      proposal: ContentProposal;
      driftDetected: boolean;
    }
  | { kind: 'not_found' }
  | { kind: 'proposal_already_resolved'; status: ProposalStatus }
  | { kind: 'proposal_stale' }
  | { kind: 'anchor_missing'; anchorId: string }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

export async function acceptProposal(input: {
  contentId: string;
  proposalId: string;
  userId: string;
  expectedContentVersion?: number;
}): Promise<AcceptProposalResult> {
  const db = getDbPg();

  const proposalRows = await db<ContentProposalRecord[]>`
    select id, content_id, owner_id, proposed_by_run_id,
           proposed_by_agent_id, proposed_by_message_id,
           kind, after_anchor_id, inserted_markdown, rationale,
           status, status_reason, base_content_version,
           base_anchor_content_hash, applied_anchor_ids,
           created_at, resolved_at, resolved_by_user_id
    from public.content_proposals
    where id = ${input.proposalId}::uuid
      and content_id = ${input.contentId}::uuid
    limit 1
  `;
  const proposal = proposalRows[0];
  if (!proposal) return { kind: 'not_found' };
  if (proposal.status !== 'pending') {
    return { kind: 'proposal_already_resolved', status: proposal.status };
  }

  const contentRows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const content = contentRows[0];
  if (!content) return { kind: 'not_found' };

  // Parse the canonical body so we can locate the anchor block and
  // splice the proposal's inserted nodes after it.
  const parsedCurrent = sanitizeRichTextDocument(
    markdownToTiptapJson(content.body_markdown),
  );
  const parsedStamped = ensureAnchorIds(parsedCurrent);

  if (proposal.after_anchor_id !== null) {
    const idx = findBlockIndexByAnchor(parsedStamped, proposal.after_anchor_id);
    if (idx === -1) {
      // Anchor truly gone — mark stale and return.
      await db`
        update public.content_proposals
        set status = 'stale',
            status_reason = 'anchor_missing',
            resolved_at = now()
        where id = ${proposal.id}::uuid
      `;
      await emitOutboxEvent({
        topic: `talk:${content.talk_id}`,
        eventType: 'content_proposal_stale',
        payload: {
          contentId: content.id,
          proposalId: proposal.id,
          reason: 'anchor_missing',
        },
        ownerIds: [content.owner_id],
      });
      return { kind: 'proposal_stale' };
    }
  }

  // Drift detection: compare the proposal's captured hash against the
  // current anchor_map entry. The map's content_hash is kept fresh by
  // every save, so this is the canonical "did the block change since
  // proposal time" check.
  let driftDetected = false;
  if (proposal.after_anchor_id !== null && proposal.base_anchor_content_hash) {
    const currentEntry = (content.anchor_map_json ?? {})[
      proposal.after_anchor_id
    ];
    if (currentEntry?.content_hash) {
      driftDetected =
        currentEntry.content_hash !== proposal.base_anchor_content_hash;
    }
  }

  // Apply the insert.
  const insertedDocSanitized = sanitizeRichTextDocument(
    markdownToTiptapJson(sanitizeMarkdown(proposal.inserted_markdown)),
  );
  const insertedNodes: RichTextNode[] = insertedDocSanitized.content ?? [];

  const insertResult = insertAfterAnchor({
    doc: parsedStamped,
    afterAnchorId: proposal.after_anchor_id,
    insertedNodes,
  });
  if ('kind' in insertResult && insertResult.kind === 'anchor_missing') {
    // Shouldn't happen — we just checked. Belt-and-braces.
    return {
      kind: 'anchor_missing',
      anchorId: proposal.after_anchor_id ?? '',
    };
  }
  const { doc: nextDoc, appliedAnchorIds } = insertResult as {
    doc: RichTextDocument;
    appliedAnchorIds: string[];
  };

  const nextMarkdown = tiptapJsonToMarkdown(nextDoc);
  if (byteLengthOf(nextMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(nextMarkdown),
    };
  }
  const nextAnchorMap = await computeAnchorMap(nextDoc);

  const updatedRows = await db<ContentRecord[]>`
    update public.contents
    set body_markdown = ${nextMarkdown},
        body_version = body_version + 1,
        anchor_map_json = ${db.json(nextAnchorMap as never)},
        updated_at = now(),
        updated_by_user_id = ${input.userId}::uuid,
        updated_by_run_id = null
    where id = ${input.contentId}::uuid
      and body_version = ${content.body_version}
    returning id, owner_id, talk_id, title, content_kind, content_format,
              body_markdown, body_version, anchor_map_json,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  const updated = updatedRows[0];
  if (!updated) {
    // Another writer slipped in between our SELECT and UPDATE.
    const refetch = await db<ContentRecord[]>`
      select body_version from public.contents where id = ${input.contentId}::uuid
    `;
    return {
      kind: 'version_conflict',
      currentVersion: refetch[0]?.body_version ?? content.body_version,
    };
  }

  const resolvedRows = await db<ContentProposalRecord[]>`
    update public.content_proposals
    set status = 'accepted',
        resolved_at = now(),
        resolved_by_user_id = ${input.userId}::uuid,
        applied_anchor_ids = ${appliedAnchorIds}
    where id = ${proposal.id}::uuid
    returning id, content_id, owner_id, proposed_by_run_id,
              proposed_by_agent_id, proposed_by_message_id,
              kind, after_anchor_id, inserted_markdown, rationale,
              status, status_reason, base_content_version,
              base_anchor_content_hash, applied_anchor_ids,
              created_at, resolved_at, resolved_by_user_id
  `;

  await emitOutboxEvent({
    topic: `talk:${updated.talk_id}`,
    eventType: 'content_updated',
    payload: {
      contentId: updated.id,
      version: updated.body_version,
      appliedAnchorIds,
    },
    ownerIds: [updated.owner_id],
  });

  return {
    kind: 'ok',
    content: toContent(updated),
    proposal: toProposal(resolvedRows[0]),
    driftDetected,
  };
}

export type RejectProposalResult =
  | { kind: 'ok'; proposal: ContentProposal }
  | { kind: 'not_found' }
  | { kind: 'proposal_already_resolved'; status: ProposalStatus };

export async function rejectProposal(input: {
  proposalId: string;
  userId: string;
}): Promise<RejectProposalResult> {
  const db = getDbPg();
  const existing = await db<ContentProposalRecord[]>`
    select id, content_id, owner_id, proposed_by_run_id,
           proposed_by_agent_id, proposed_by_message_id,
           kind, after_anchor_id, inserted_markdown, rationale,
           status, status_reason, base_content_version,
           base_anchor_content_hash, applied_anchor_ids,
           created_at, resolved_at, resolved_by_user_id
    from public.content_proposals
    where id = ${input.proposalId}::uuid
    limit 1
  `;
  if (!existing[0]) return { kind: 'not_found' };
  if (existing[0].status !== 'pending') {
    return {
      kind: 'proposal_already_resolved',
      status: existing[0].status,
    };
  }
  const rows = await db<ContentProposalRecord[]>`
    update public.content_proposals
    set status = 'rejected',
        resolved_at = now(),
        resolved_by_user_id = ${input.userId}::uuid
    where id = ${input.proposalId}::uuid
      and status = 'pending'
    returning id, content_id, owner_id, proposed_by_run_id,
              proposed_by_agent_id, proposed_by_message_id,
              kind, after_anchor_id, inserted_markdown, rationale,
              status, status_reason, base_content_version,
              base_anchor_content_hash, applied_anchor_ids,
              created_at, resolved_at, resolved_by_user_id
  `;
  if (!rows[0]) {
    // Concurrent resolution — refetch and report.
    const refetch = await getProposalById(input.proposalId);
    return refetch
      ? { kind: 'proposal_already_resolved', status: refetch.status }
      : { kind: 'not_found' };
  }
  return { kind: 'ok', proposal: toProposal(rows[0]) };
}
