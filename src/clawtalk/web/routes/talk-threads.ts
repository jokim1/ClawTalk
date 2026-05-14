import { withUserContext } from '../../../db.js';
import {
  createTalkThread,
  deleteTalkThread,
  getTalkForUser,
  listTalkThreads,
  ThreadDeleteConflictError,
  updateTalkThreadMetadata,
  type TalkThreadRecord,
  type TalkThreadWithMetrics,
} from '../../db/index.js';
import {
  ThreadTitleValidationError,
  validateEditableThreadTitle,
} from '../../db/thread-title-utils.js';
import { canEditTalk } from '../middleware/acl.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

export async function listTalkThreadsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ threads: TalkThreadWithMetrics[] }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        },
      };
    }

    const threads = await listTalkThreads({
      talkId: input.talkId,
      ownerId: input.auth.userId,
    });
    return {
      statusCode: 200,
      body: { ok: true, data: { threads } },
    };
  });
}

export async function createTalkThreadRoute(input: {
  auth: AuthContext;
  talkId: string;
  title: string | null;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ thread: TalkThreadRecord }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        },
      };
    }

    if (!(await canEditTalk(input.talkId))) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: {
            code: 'forbidden',
            message:
              'You do not have permission to create threads for this talk',
          },
        },
      };
    }

    const thread = await createTalkThread({
      ownerId: input.auth.userId,
      talkId: input.talkId,
      title: input.title,
    });
    return {
      statusCode: 201,
      body: { ok: true, data: { thread } },
    };
  });
}

interface PatchTalkThreadBody {
  title?: unknown;
  pinned?: unknown;
}

export async function patchTalkThreadRoute(input: {
  auth: AuthContext;
  talkId: string;
  threadId: string;
  body: PatchTalkThreadBody;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<TalkThreadRecord | null>;
}> {
  if (input.body.title === undefined && input.body.pinned === undefined) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'At least one of title or pinned is required',
        },
      },
    };
  }

  let title: string | undefined;
  if (input.body.title !== undefined) {
    try {
      title = validateEditableThreadTitle(
        typeof input.body.title === 'string' ? input.body.title : null,
      );
    } catch (err) {
      if (err instanceof ThreadTitleValidationError) {
        return {
          statusCode: 400,
          body: {
            ok: false,
            error: {
              code: 'invalid_input',
              message: err.message,
            },
          },
        };
      }
      throw err;
    }
  }

  let pinned: boolean | undefined;
  if (input.body.pinned !== undefined) {
    if (typeof input.body.pinned !== 'boolean') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'pinned must be a boolean',
          },
        },
      };
    }
    pinned = input.body.pinned;
  }

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        },
      };
    }

    if (!(await canEditTalk(input.talkId))) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: { code: 'forbidden', message: 'Talk is read-only' },
        },
      };
    }

    try {
      const thread = await updateTalkThreadMetadata({
        talkId: input.talkId,
        threadId: input.threadId,
        ...(title !== undefined ? { title } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
      });
      if (!thread) {
        return {
          statusCode: 404,
          body: {
            ok: false,
            error: { code: 'thread_not_found', message: 'Thread not found' },
          },
        };
      }

      return {
        statusCode: 200,
        body: {
          ok: true,
          data: thread,
        },
      };
    } catch (err) {
      if (err instanceof ThreadTitleValidationError) {
        return {
          statusCode: 400,
          body: {
            ok: false,
            error: {
              code: 'invalid_input',
              message: err.message,
            },
          },
        };
      }
      return {
        statusCode: 500,
        body: {
          ok: false,
          error: { code: 'internal_error', message: String(err) },
        },
      };
    }
  });
}

export async function deleteTalkThreadRoute(input: {
  auth: AuthContext;
  talkId: string;
  threadId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        },
      };
    }

    if (!(await canEditTalk(input.talkId))) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: { code: 'forbidden', message: 'Talk is read-only' },
        },
      };
    }

    try {
      const deleted = await deleteTalkThread({
        talkId: input.talkId,
        threadId: input.threadId,
      });
      if (!deleted) {
        return {
          statusCode: 404,
          body: {
            ok: false,
            error: { code: 'thread_not_found', message: 'Thread not found' },
          },
        };
      }
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: { deleted: true },
        },
      };
    } catch (err) {
      if (err instanceof ThreadDeleteConflictError) {
        return {
          statusCode: 409,
          body: {
            ok: false,
            error: {
              code: err.code,
              message: err.message,
            },
          },
        };
      }
      return {
        statusCode: 500,
        body: {
          ok: false,
          error: { code: 'internal_error', message: String(err) },
        },
      };
    }
  });
}
