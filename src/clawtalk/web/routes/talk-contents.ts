import { withUserContext } from '../../../db.js';
import {
  CONTENT_BODY_BYTE_LIMIT,
  acceptProposal,
  createContent,
  getContentById,
  getContentByTalkId,
  getProposalById,
  getTalkForUser,
  listPendingProposalsByContentId,
  rejectProposal,
  updateContentBody,
  type Content,
  type ContentProposal,
} from '../../db/index.js';
import {
  acceptPendingEdit,
  acceptPendingRun,
  getPendingEditById,
  getPendingEditsByContent,
  rejectPendingEdit,
  rejectPendingRun,
} from '../../db/content-edits-accessors.js';
import type { ContentEditRow } from '../../../shared/rich-text/index.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';

interface RouteResult<T> {
  statusCode: number;
  body: ApiEnvelope<T>;
}

function notFound(message: string): RouteResult<never> {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbidden(message: string): RouteResult<never> {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function badRequest(code: string, message: string): RouteResult<never> {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

function versionConflict(currentVersion: number): RouteResult<never> {
  return {
    statusCode: 409,
    body: {
      ok: false,
      error: {
        code: 'version_conflict',
        message: 'This content changed since you started. Reload and retry.',
        details: { currentVersion },
      },
    },
  };
}

function anchorMissing(anchorId: string): RouteResult<never> {
  return {
    statusCode: 409,
    body: {
      ok: false,
      error: {
        code: 'anchor_missing',
        message: 'The target anchor no longer exists in the document.',
        details: { anchorId },
      },
    },
  };
}

function proposalStale(proposalId: string): RouteResult<never> {
  return {
    statusCode: 410,
    body: {
      ok: false,
      error: {
        code: 'proposal_stale',
        message:
          'The target block was removed before this proposal could be applied.',
        details: { proposalId, status: 'stale' },
      },
    },
  };
}

function proposalAlreadyResolved(
  proposalId: string,
  status: string,
): RouteResult<never> {
  return {
    statusCode: 410,
    body: {
      ok: false,
      error: {
        code: 'proposal_already_resolved',
        message: `Proposal is already ${status}.`,
        details: { proposalId, status },
      },
    },
  };
}

function docSizeLimit(wouldBeBytes: number): RouteResult<never> {
  return {
    statusCode: 413,
    body: {
      ok: false,
      error: {
        code: 'doc_size_limit',
        message: 'Document body exceeds the size limit.',
        details: {
          limitBytes: CONTENT_BODY_BYTE_LIMIT,
          wouldBeBytes,
        },
      },
    },
  };
}

export async function getTalkContentRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<
  RouteResult<{
    content: Content | null;
    pendingProposals: ContentProposal[];
    pendingEdits: ContentEditRow[];
  }>
> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFound('Talk not found.');

    const content = await getContentByTalkId(input.talkId);
    if (!content) {
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: { content: null, pendingProposals: [], pendingEdits: [] },
        },
      };
    }
    const [pendingProposals, pendingEdits] = await Promise.all([
      listPendingProposalsByContentId(content.id),
      getPendingEditsByContent(content.id),
    ]);
    return {
      statusCode: 200,
      body: { ok: true, data: { content, pendingProposals, pendingEdits } },
    };
  });
}

export async function createTalkContentRoute(input: {
  auth: AuthContext;
  talkId: string;
  title?: unknown;
}): Promise<RouteResult<{ content: Content }>> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFound('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    if (typeof input.title !== 'string' || !input.title.trim()) {
      return badRequest('title_required', 'Content title is required.');
    }

    const existing = await getContentByTalkId(input.talkId);
    if (existing) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'content_already_exists',
            message: 'This talk already has a content document.',
            details: { contentId: existing.id },
          },
        },
      };
    }

    try {
      const content = await createContent({
        ownerId: input.auth.userId,
        talkId: input.talkId,
        title: input.title,
        createdByUserId: input.auth.userId,
      });
      return {
        statusCode: 201,
        body: { ok: true, data: { content } },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create content.';
      return badRequest('invalid_content', message);
    }
  });
}

export async function patchContentRoute(input: {
  auth: AuthContext;
  contentId: string;
  expectedVersion?: unknown;
  bodyMarkdown?: unknown;
  title?: unknown;
  acceptPendingEditIds?: unknown;
}): Promise<
  RouteResult<{
    content: Content;
    staledProposalIds: string[];
    acceptedPendingEditIds: string[];
  }>
> {
  return await withUserContext(input.auth.userId, async () => {
    if (
      typeof input.expectedVersion !== 'number' ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      return badRequest(
        'expected_version_required',
        'PATCH requires a positive integer expectedVersion.',
      );
    }

    const requestedAcceptIds: string[] = Array.isArray(
      input.acceptPendingEditIds,
    )
      ? input.acceptPendingEditIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : [];

    if (
      typeof input.bodyMarkdown !== 'string' &&
      typeof input.title !== 'string' &&
      requestedAcceptIds.length === 0
    ) {
      return badRequest(
        'empty_patch',
        'PATCH must include bodyMarkdown, title, or acceptPendingEditIds.',
      );
    }

    const existing = await getContentById(input.contentId);
    if (!existing) return notFound('Content not found.');
    if (!(await canEditTalk(existing.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    try {
      // Per-block implicit accept: materialize any pending edits the
      // client says the user typed over BEFORE we apply the bodyMarkdown
      // update so the base body the autosave PATCH writes against is
      // already up-to-date. Each acceptPendingEdit call CAS-bumps the
      // body, so iterate sequentially and advance the expectedVersion.
      let runningVersion = input.expectedVersion;
      const acceptedEditIds: string[] = [];
      for (const editId of requestedAcceptIds) {
        const acceptResult = await acceptPendingEdit({
          editId,
          userId: input.auth.userId,
          expectedContentVersion: runningVersion,
        });
        if (acceptResult.kind === 'not_found') {
          // Sibling auto-accept may have cleared the row already; ignore.
          continue;
        }
        if (acceptResult.kind === 'version_conflict') {
          return versionConflict(acceptResult.currentVersion);
        }
        if (acceptResult.kind === 'doc_size_limit') {
          return docSizeLimit(acceptResult.wouldBeBytes);
        }
        if (acceptResult.kind === 'anchor_missing') {
          return anchorMissing(acceptResult.anchorId);
        }
        runningVersion = acceptResult.content.bodyVersion;
        acceptedEditIds.push(acceptResult.editId);
      }

      // Decide whether the autosave PATCH itself needs to fire — if the
      // client only sent acceptPendingEditIds (no body / title change),
      // we're done after the materializations above.
      const wantsBodyUpdate =
        typeof input.bodyMarkdown === 'string' ||
        typeof input.title === 'string';
      if (!wantsBodyUpdate) {
        const refreshed = await getContentById(input.contentId);
        if (!refreshed) return notFound('Content not found.');
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              content: refreshed,
              staledProposalIds: [],
              acceptedPendingEditIds: acceptedEditIds,
            },
          },
        };
      }

      const result = await updateContentBody({
        contentId: input.contentId,
        ownerId: input.auth.userId,
        expectedVersion: runningVersion,
        bodyMarkdown:
          typeof input.bodyMarkdown === 'string'
            ? input.bodyMarkdown
            : existing.bodyMarkdown,
        title: typeof input.title === 'string' ? input.title : undefined,
        updatedByUserId: input.auth.userId,
      });
      if (result.kind === 'not_found') return notFound('Content not found.');
      if (result.kind === 'conflict') {
        return versionConflict(result.current.bodyVersion);
      }
      if (result.kind === 'doc_size_limit') {
        return docSizeLimit(result.wouldBeBytes);
      }
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            content: result.content,
            staledProposalIds: result.staledProposalIds,
            acceptedPendingEditIds: acceptedEditIds,
          },
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to update content.';
      return badRequest('invalid_content', message);
    }
  });
}

export async function getContentProposalRoute(input: {
  auth: AuthContext;
  contentId: string;
  proposalId: string;
}): Promise<RouteResult<{ proposal: ContentProposal }>> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    const proposal = await getProposalById(input.proposalId);
    if (!proposal || proposal.contentId !== input.contentId) {
      return notFound('Proposal not found.');
    }
    return {
      statusCode: 200,
      body: { ok: true, data: { proposal } },
    };
  });
}

export async function acceptContentProposalRoute(input: {
  auth: AuthContext;
  contentId: string;
  proposalId: string;
  expectedContentVersion?: unknown;
}): Promise<
  RouteResult<{
    content: Content;
    proposal: ContentProposal;
    driftDetected: boolean;
    staledSiblingProposalIds: string[];
  }>
> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    if (!(await canEditTalk(content.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    const expected =
      typeof input.expectedContentVersion === 'number'
        ? input.expectedContentVersion
        : undefined;

    const result = await acceptProposal({
      contentId: input.contentId,
      proposalId: input.proposalId,
      userId: input.auth.userId,
      expectedContentVersion: expected,
    });

    switch (result.kind) {
      case 'not_found':
        return notFound('Proposal not found.');
      case 'proposal_already_resolved':
        return proposalAlreadyResolved(input.proposalId, result.status);
      case 'proposal_stale':
        return proposalStale(input.proposalId);
      case 'anchor_missing':
        return anchorMissing(result.anchorId);
      case 'version_conflict':
        return versionConflict(result.currentVersion);
      case 'doc_size_limit':
        return docSizeLimit(result.wouldBeBytes);
      case 'ok':
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              content: result.content,
              proposal: result.proposal,
              driftDetected: result.driftDetected,
              staledSiblingProposalIds: result.staledSiblingProposalIds,
            },
          },
        };
    }
  });
}

export async function rejectContentProposalRoute(input: {
  auth: AuthContext;
  contentId: string;
  proposalId: string;
}): Promise<RouteResult<{ proposal: ContentProposal }>> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    if (!(await canEditTalk(content.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    const result = await rejectProposal({
      proposalId: input.proposalId,
      userId: input.auth.userId,
    });
    switch (result.kind) {
      case 'not_found':
        return notFound('Proposal not found.');
      case 'proposal_already_resolved':
        return proposalAlreadyResolved(input.proposalId, result.status);
      case 'ok':
        return {
          statusCode: 200,
          body: { ok: true, data: { proposal: result.proposal } },
        };
    }
  });
}

// ── Pending-edit accept/reject routes (edit-log architecture) ────────

export async function acceptContentEditRoute(input: {
  auth: AuthContext;
  contentId: string;
  editId: string;
  expectedContentVersion?: unknown;
}): Promise<
  RouteResult<{ content: Content; editId: string; runId: string }>
> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    if (!(await canEditTalk(content.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    const expected =
      typeof input.expectedContentVersion === 'number'
        ? input.expectedContentVersion
        : undefined;

    const result = await acceptPendingEdit({
      editId: input.editId,
      userId: input.auth.userId,
      expectedContentVersion: expected,
    });
    switch (result.kind) {
      case 'not_found':
        return notFound('Pending edit not found.');
      case 'version_conflict':
        return versionConflict(result.currentVersion);
      case 'doc_size_limit':
        return docSizeLimit(result.wouldBeBytes);
      case 'anchor_missing':
        return anchorMissing(result.anchorId);
      case 'ok':
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              content: result.content,
              editId: result.editId,
              runId: result.runId,
            },
          },
        };
    }
  });
}

export async function rejectContentEditRoute(input: {
  auth: AuthContext;
  contentId: string;
  editId: string;
}): Promise<RouteResult<{ editId: string; runId: string }>> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    if (!(await canEditTalk(content.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    // Authorize: the edit must belong to this content.
    const edit = await getPendingEditById(input.editId);
    if (!edit) return notFound('Pending edit not found.');
    if (edit.contentId !== input.contentId) {
      return notFound('Pending edit not found.');
    }

    const result = await rejectPendingEdit({
      editId: input.editId,
      userId: input.auth.userId,
    });
    switch (result.kind) {
      case 'not_found':
        return notFound('Pending edit not found.');
      case 'ok':
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: { editId: result.editId, runId: result.runId },
          },
        };
    }
  });
}

export async function acceptContentEditRunRoute(input: {
  auth: AuthContext;
  contentId: string;
  runId: string;
  expectedContentVersion?: unknown;
}): Promise<
  RouteResult<{ content: Content; runId: string; editIds: string[] }>
> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    if (!(await canEditTalk(content.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    const expected =
      typeof input.expectedContentVersion === 'number'
        ? input.expectedContentVersion
        : undefined;

    const result = await acceptPendingRun({
      contentId: input.contentId,
      runId: input.runId,
      userId: input.auth.userId,
      expectedContentVersion: expected,
    });
    switch (result.kind) {
      case 'not_found':
        return notFound('Pending edit run not found.');
      case 'version_conflict':
        return versionConflict(result.currentVersion);
      case 'doc_size_limit':
        return docSizeLimit(result.wouldBeBytes);
      case 'ok':
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              content: result.content,
              runId: result.runId,
              editIds: result.editIds,
            },
          },
        };
    }
  });
}

export async function rejectContentEditRunRoute(input: {
  auth: AuthContext;
  contentId: string;
  runId: string;
}): Promise<RouteResult<{ runId: string; editIds: string[] }>> {
  return await withUserContext(input.auth.userId, async () => {
    const content = await getContentById(input.contentId);
    if (!content) return notFound('Content not found.');
    if (!(await canEditTalk(content.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    const result = await rejectPendingRun({
      contentId: input.contentId,
      runId: input.runId,
      userId: input.auth.userId,
    });
    switch (result.kind) {
      case 'not_found':
        return notFound('Pending edit run not found.');
      case 'ok':
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: { runId: result.runId, editIds: result.editIds },
          },
        };
    }
  });
}
