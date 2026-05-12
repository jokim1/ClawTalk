import {
  createTalkOutput,
  deleteTalkOutput,
  getTalkForUser,
  getTalkOutput,
  listTalkOutputs,
  patchTalkOutput,
  type TalkOutput,
  type TalkOutputSummary,
} from '../../db/index.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbiddenResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function badRequestResponse(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

function conflictResponse(current: TalkOutput): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 409,
    body: {
      ok: false,
      error: {
        code: 'version_conflict',
        message:
          'This output changed before your update was applied. Reload and retry with the current version.',
        details: { current },
      },
    },
  };
}

function talkOrNull(talkId: string, userId: string) {
  return getTalkForUser(talkId, userId);
}

function requireEditAccess(
  talkId: string,
  auth: AuthContext,
): ReturnType<typeof forbiddenResponse> | null {
  if (!canEditTalk(talkId, auth.userId, auth.role)) {
    return forbiddenResponse('You do not have permission to edit this talk.');
  }
  return null;
}

export function listTalkOutputsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ outputs: TalkOutputSummary[] }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { outputs: listTalkOutputs(input.talkId) },
    },
  };
}

export function getTalkOutputRoute(input: {
  auth: AuthContext;
  talkId: string;
  outputId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ output: TalkOutput }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  const output = getTalkOutput(input.talkId, input.outputId);
  if (!output) return notFoundResponse('Output not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { output } },
  };
}

export function createTalkOutputRoute(input: {
  auth: AuthContext;
  talkId: string;
  title: string;
  contentMarkdown?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ output: TalkOutput }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  if (!input.title.trim()) {
    return badRequestResponse('title_required', 'Output title is required.');
  }

  try {
    const output = createTalkOutput({
      talkId: input.talkId,
      title: input.title,
      contentMarkdown: input.contentMarkdown ?? '',
      createdByUserId: input.auth.userId,
    });
    return {
      statusCode: 201,
      body: { ok: true, data: { output } },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create output.';
    return badRequestResponse('invalid_output', message);
  }
}

export function patchTalkOutputRoute(input: {
  auth: AuthContext;
  talkId: string;
  outputId: string;
  expectedVersion?: number;
  title?: string;
  contentMarkdown?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ output: TalkOutput }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  if (
    typeof input.expectedVersion !== 'number' ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    return badRequestResponse(
      'expected_version_required',
      'PATCH requires a positive integer expectedVersion.',
    );
  }
  if (input.title === undefined && input.contentMarkdown === undefined) {
    return badRequestResponse(
      'empty_patch',
      'PATCH must include title and/or contentMarkdown.',
    );
  }

  try {
    const result = patchTalkOutput({
      talkId: input.talkId,
      outputId: input.outputId,
      expectedVersion: input.expectedVersion,
      title: input.title,
      contentMarkdown: input.contentMarkdown,
      updatedByUserId: input.auth.userId,
    });
    if (result.kind === 'not_found') {
      return notFoundResponse('Output not found.');
    }
    if (result.kind === 'conflict') {
      return conflictResponse(result.current);
    }
    return {
      statusCode: 200,
      body: { ok: true, data: { output: result.output } },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update output.';
    return badRequestResponse('invalid_output', message);
  }
}

export function deleteTalkOutputRoute(input: {
  auth: AuthContext;
  talkId: string;
  outputId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const deleted = deleteTalkOutput(input.talkId, input.outputId);
  if (!deleted) return notFoundResponse('Output not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}
