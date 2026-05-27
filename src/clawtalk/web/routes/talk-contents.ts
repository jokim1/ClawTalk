import { withUserContext } from '../../../db.js';
import {
  CONTENT_BODY_BYTE_LIMIT,
  createContent,
  getContentById,
  getContentByTalkId,
  getContentByThreadId,
  getOrCreateDefaultThread,
  getTalkForUser,
  updateContentBody,
  type Content,
  type ContentFormat,
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
import { getDbPg } from '../../../db.js';

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

function docSizeLimit(wouldBeBytes: number): RouteResult<never> {
  const mb = (n: number): string => (n / 1_000_000).toFixed(1);
  return {
    statusCode: 413,
    body: {
      ok: false,
      error: {
        code: 'doc_size_limit',
        message: `Document body is ${mb(wouldBeBytes)} MB; the limit is ${mb(CONTENT_BODY_BYTE_LIMIT)} MB. Inline base64 images from pasted screenshots are the usual cause — host them externally and reference by URL, or split the doc.`,
        details: {
          limitBytes: CONTENT_BODY_BYTE_LIMIT,
          wouldBeBytes,
        },
      },
    },
  };
}

function formatMismatch(format: ContentFormat): RouteResult<never> {
  return {
    statusCode: 400,
    body: {
      ok: false,
      error: {
        code: 'format_mismatch',
        message: `This content is ${format}-format; cannot accept body in a different format.`,
        details: { format },
      },
    },
  };
}

/**
 * Resolve a thread row to (talkId, ownerId) without going through the
 * RLS-shaped accessors that don't expose talk_id directly. RLS still
 * gates this lookup — a thread the caller can't see returns null.
 */
async function loadThread(
  threadId: string,
): Promise<{ id: string; talkId: string } | null> {
  const db = getDbPg();
  const rows = await db<{ id: string; talk_id: string }[]>`
    select id, talk_id
    from public.talk_threads
    where id = ${threadId}::uuid
    limit 1
  `;
  if (!rows[0]) return null;
  return { id: rows[0].id, talkId: rows[0].talk_id };
}

export async function getTalkContentRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<
  RouteResult<{
    content: Content | null;
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
        body: { ok: true, data: { content: null, pendingEdits: [] } },
      };
    }
    const pendingEdits = await getPendingEditsByContent(content.id);
    return {
      statusCode: 200,
      body: { ok: true, data: { content, pendingEdits } },
    };
  });
}

export async function getThreadContentRoute(input: {
  auth: AuthContext;
  threadId: string;
}): Promise<
  RouteResult<{
    content: Content | null;
    pendingEdits: ContentEditRow[];
  }>
> {
  return await withUserContext(input.auth.userId, async () => {
    const thread = await loadThread(input.threadId);
    if (!thread) return notFound('Thread not found.');

    // Talk-level access check ensures the caller can read the parent
    // talk; RLS on talk_threads already enforced the thread fetch.
    const talk = await getTalkForUser(thread.talkId);
    if (!talk) return notFound('Thread not found.');

    const content = await getContentByThreadId(input.threadId);
    if (!content) {
      return {
        statusCode: 200,
        body: { ok: true, data: { content: null, pendingEdits: [] } },
      };
    }
    const pendingEdits = await getPendingEditsByContent(content.id);
    return {
      statusCode: 200,
      body: { ok: true, data: { content, pendingEdits } },
    };
  });
}

export async function createTalkContentRoute(input: {
  auth: AuthContext;
  talkId: string;
  title?: unknown;
  format?: unknown;
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
    const format =
      input.format === undefined || input.format === null
        ? 'markdown'
        : input.format;
    if (format !== 'markdown' && format !== 'html') {
      return badRequest(
        'invalid_format',
        'Content format must be "markdown" or "html".',
      );
    }

    // Resolve the talk's default thread — the canonical home for the
    // talk-scoped legacy /api/v1/talks/:talkId/content endpoint. This
    // shim keeps existing webapp callers working while new callers
    // route through /threads/:threadId/content directly.
    const threadId = await getOrCreateDefaultThread({
      talkId: input.talkId,
      ownerId: input.auth.userId,
    });

    const existing = await getContentByThreadId(threadId);
    if (existing) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'content_already_exists',
            message: 'This thread already has a content document.',
            details: { contentId: existing.id },
          },
        },
      };
    }

    try {
      const content = await createContent({
        ownerId: input.auth.userId,
        talkId: input.talkId,
        threadId,
        title: input.title,
        format,
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

export async function createThreadContentRoute(input: {
  auth: AuthContext;
  threadId: string;
  title?: unknown;
  format?: unknown;
}): Promise<RouteResult<{ content: Content }>> {
  return await withUserContext(input.auth.userId, async () => {
    const thread = await loadThread(input.threadId);
    if (!thread) return notFound('Thread not found.');
    const talk = await getTalkForUser(thread.talkId);
    if (!talk) return notFound('Thread not found.');
    if (!(await canEditTalk(thread.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    if (typeof input.title !== 'string' || !input.title.trim()) {
      return badRequest('title_required', 'Content title is required.');
    }
    const format =
      input.format === undefined || input.format === null
        ? 'markdown'
        : input.format;
    if (format !== 'markdown' && format !== 'html') {
      return badRequest(
        'invalid_format',
        'Content format must be "markdown" or "html".',
      );
    }

    const existing = await getContentByThreadId(input.threadId);
    if (existing) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'content_already_exists',
            message: 'This thread already has a content document.',
            details: { contentId: existing.id },
          },
        },
      };
    }

    try {
      const content = await createContent({
        ownerId: input.auth.userId,
        talkId: thread.talkId,
        threadId: input.threadId,
        title: input.title,
        format,
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
  bodyHtml?: unknown;
  title?: unknown;
  acceptPendingEditIds?: unknown;
}): Promise<
  RouteResult<{
    content: Content;
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

    const wantsMarkdown = typeof input.bodyMarkdown === 'string';
    const wantsHtml = typeof input.bodyHtml === 'string';
    if (wantsMarkdown && wantsHtml) {
      return badRequest(
        'invalid_patch',
        'PATCH cannot include both bodyMarkdown and bodyHtml.',
      );
    }

    if (
      !wantsMarkdown &&
      !wantsHtml &&
      typeof input.title !== 'string' &&
      requestedAcceptIds.length === 0
    ) {
      return badRequest(
        'empty_patch',
        'PATCH must include bodyMarkdown, bodyHtml, title, or acceptPendingEditIds.',
      );
    }

    const existing = await getContentById(input.contentId);
    if (!existing) return notFound('Content not found.');
    if (!(await canEditTalk(existing.talkId))) {
      return forbidden('You do not have permission to edit this talk.');
    }

    try {
      // Per-block implicit accept: materialize any pending edits the
      // client says the user typed over BEFORE we apply the body
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

      // Decide whether the body PATCH itself needs to fire — if the
      // client only sent acceptPendingEditIds (no body / title
      // change), we're done after the materializations above.
      const wantsBodyUpdate =
        wantsMarkdown || wantsHtml || typeof input.title === 'string';
      if (!wantsBodyUpdate) {
        const refreshed = await getContentById(input.contentId);
        if (!refreshed) return notFound('Content not found.');
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              content: refreshed,
              acceptedPendingEditIds: acceptedEditIds,
            },
          },
        };
      }

      const result = await updateContentBody({
        contentId: input.contentId,
        ownerId: input.auth.userId,
        expectedVersion: runningVersion,
        bodyMarkdown: wantsMarkdown
          ? (input.bodyMarkdown as string)
          : undefined,
        bodyHtml: wantsHtml ? (input.bodyHtml as string) : undefined,
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
      if (result.kind === 'format_mismatch') {
        return formatMismatch(result.format);
      }
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            content: result.content,
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

// ── Pending-edit accept/reject routes (edit-log architecture) ────────

export async function acceptContentEditRoute(input: {
  auth: AuthContext;
  contentId: string;
  editId: string;
  expectedContentVersion?: unknown;
}): Promise<RouteResult<{ content: Content; editId: string; runId: string }>> {
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
