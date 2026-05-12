import {
  deleteTalkThread,
  getTalkForUser,
  ThreadDeleteConflictError,
  updateTalkThreadMetadata,
} from '../../db/index.js';
import {
  ThreadTitleValidationError,
  validateEditableThreadTitle,
} from '../../db/thread-title-utils.js';
import { canEditTalk } from '../middleware/acl.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

interface PatchTalkThreadBody {
  title?: unknown;
  pinned?: unknown;
}

type PatchTalkThreadResult = {
  id: string;
  talk_id: string;
  title: string | null;
  is_default: number;
  is_internal: number;
  is_pinned: number;
  created_at: string;
  updated_at: string;
} | null;

interface PatchTalkThreadDeps {
  getTalkForUser?: typeof getTalkForUser;
  updateTalkThreadMetadata?: typeof updateTalkThreadMetadata;
}

export function patchTalkThreadRoute(input: {
  auth: AuthContext;
  talkId: string;
  threadId: string;
  body: PatchTalkThreadBody;
  deps?: PatchTalkThreadDeps;
}): {
  statusCode: number;
  body: ApiEnvelope<PatchTalkThreadResult>;
} {
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

  const talk = (input.deps?.getTalkForUser ?? getTalkForUser)(
    input.talkId,
    input.auth.userId,
  );
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Talk is read-only' },
      },
    };
  }

  try {
    const thread = (
      input.deps?.updateTalkThreadMetadata ?? updateTalkThreadMetadata
    )({
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
}

interface DeleteTalkThreadDeps {
  getTalkForUser?: typeof getTalkForUser;
  deleteTalkThread?: typeof deleteTalkThread;
}

export function deleteTalkThreadRoute(input: {
  auth: AuthContext;
  talkId: string;
  threadId: string;
  deps?: DeleteTalkThreadDeps;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = (input.deps?.getTalkForUser ?? getTalkForUser)(
    input.talkId,
    input.auth.userId,
  );
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Talk is read-only' },
      },
    };
  }

  try {
    const deleted = (input.deps?.deleteTalkThread ?? deleteTalkThread)({
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
}
