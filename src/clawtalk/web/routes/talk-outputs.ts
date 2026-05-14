import { withUserContext } from '../../../db.js';
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

export async function listTalkOutputsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ outputs: TalkOutputSummary[] }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');

    const outputs = await listTalkOutputs(input.talkId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { outputs },
      },
    };
  });
}

export async function getTalkOutputRoute(input: {
  auth: AuthContext;
  talkId: string;
  outputId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ output: TalkOutput }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');

    const output = await getTalkOutput(input.talkId, input.outputId);
    if (!output) return notFoundResponse('Output not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { output } },
    };
  });
}

export async function createTalkOutputRoute(input: {
  auth: AuthContext;
  talkId: string;
  title: string;
  contentMarkdown?: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ output: TalkOutput }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbiddenResponse('You do not have permission to edit this talk.');
    }

    if (!input.title.trim()) {
      return badRequestResponse('title_required', 'Output title is required.');
    }

    try {
      const output = await createTalkOutput({
        ownerId: input.auth.userId,
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
  });
}

export async function patchTalkOutputRoute(input: {
  auth: AuthContext;
  talkId: string;
  outputId: string;
  expectedVersion?: number;
  title?: string;
  contentMarkdown?: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ output: TalkOutput }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbiddenResponse('You do not have permission to edit this talk.');
    }

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
      const result = await patchTalkOutput({
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
  });
}

export async function deleteTalkOutputRoute(input: {
  auth: AuthContext;
  talkId: string;
  outputId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    if (!(await canEditTalk(input.talkId))) {
      return forbiddenResponse('You do not have permission to edit this talk.');
    }

    const deleted = await deleteTalkOutput(input.talkId, input.outputId);
    if (!deleted) return notFoundResponse('Output not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { deleted: true } },
    };
  });
}
