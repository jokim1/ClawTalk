// Talk-level Google Drive resource bindings.
//
// Lane C of the PR2 plan (snazzy-crunching-quill.md). Restores the
// chassis-era "Bound Drive Resources" surface that the webapp Talk Tools
// sub-tab drives via webapp/src/lib/api.ts.
//
// API shape (frozen by the existing webapp client):
//   GET    /talks/:talkId/resources           → { talkId, bindings: [...] }
//   POST   /talks/:talkId/resources           → { binding: {...} }
//   DELETE /talks/:talkId/resources/:resourceId → { deleted: true }
//
// The DB accessor returns `TalkResourceBindingRecord` (bindingKind, talkId,
// ownerId), but the webapp `TalkResourceBinding` type only carries the
// {id, kind, externalId, displayName, metadata, createdAt, createdBy} subset
// using `kind` instead of `bindingKind`. `toApiBinding` projects the
// record into the API shape so the client doesn't need to know about
// owner_id (RLS already scopes reads to the caller).
//
// C3 — edit-permission gate (security boundary):
//   POST and DELETE both call `canEditTalk(talkId)` before touching the
//   table. RLS on `talk_resource_bindings` only enforces
//   `owner_id = auth.uid()` on the binding row itself; it does NOT
//   verify the caller has edit rights on the parent talk. Without this
//   gate, any authenticated user with a CSRF token could POST a binding
//   row to anyone else's talk_id (their own owner_id would satisfy RLS
//   WITH CHECK, the talk's RLS doesn't apply to the bindings table).

import { withUserContext } from '../../../db.js';
import {
  createTalkResourceBinding,
  deleteTalkResourceBinding,
  getTalkForUser,
  listTalkResourceBindings,
  type TalkResourceBindingKind,
  type TalkResourceBindingRecord,
} from '../../db/index.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';

type JsonMap = Record<string, unknown>;

interface ApiTalkResourceBinding {
  id: string;
  kind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata: JsonMap | null;
  createdAt: string;
  createdBy: string | null;
}

function toApiBinding(row: TalkResourceBindingRecord): ApiTalkResourceBinding {
  return {
    id: row.id,
    kind: row.bindingKind,
    externalId: row.externalId,
    displayName: row.displayName,
    metadata: row.metadata,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

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

function badRequest(
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

const VALID_KINDS: ReadonlySet<TalkResourceBindingKind> = new Set([
  'google_drive_folder',
  'google_drive_file',
]);

// ---------------------------------------------------------------------------
// GET /api/v1/talks/:talkId/resources
// ---------------------------------------------------------------------------

export async function listTalkResourcesRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    bindings: ApiTalkResourceBinding[];
  }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');

    const rows = await listTalkResourceBindings(input.talkId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          bindings: rows.map(toApiBinding),
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/talks/:talkId/resources
// ---------------------------------------------------------------------------

export async function createTalkGoogleDriveResourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  body: {
    kind?: unknown;
    externalId?: unknown;
    displayName?: unknown;
    metadata?: unknown;
  };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ binding: ApiTalkResourceBinding }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');
    // C3: RLS lets the user write a binding with their own owner_id, but
    // doesn't check whether they have edit rights on the parent talk.
    // Gate explicitly before any insert.
    if (!(await canEditTalk(input.talkId))) {
      return forbiddenResponse('You do not have permission to edit this talk.');
    }

    const rawKind =
      typeof input.body.kind === 'string' ? input.body.kind.trim() : '';
    if (!VALID_KINDS.has(rawKind as TalkResourceBindingKind)) {
      return badRequest(
        'invalid_binding_kind',
        'kind must be google_drive_folder or google_drive_file.',
      );
    }
    const bindingKind = rawKind as TalkResourceBindingKind;

    const externalId =
      typeof input.body.externalId === 'string'
        ? input.body.externalId.trim()
        : '';
    if (!externalId) {
      return badRequest('external_id_required', 'externalId is required.');
    }
    if (externalId.length > 512) {
      return badRequest(
        'external_id_too_long',
        'externalId must be 512 characters or fewer.',
      );
    }

    const displayName =
      typeof input.body.displayName === 'string'
        ? input.body.displayName.trim()
        : '';
    if (!displayName) {
      return badRequest('display_name_required', 'displayName is required.');
    }
    if (displayName.length > 512) {
      return badRequest(
        'display_name_too_long',
        'displayName must be 512 characters or fewer.',
      );
    }

    let metadata: JsonMap | null = null;
    if (input.body.metadata !== null && input.body.metadata !== undefined) {
      if (
        typeof input.body.metadata !== 'object' ||
        Array.isArray(input.body.metadata)
      ) {
        return badRequest(
          'invalid_metadata',
          'metadata must be a JSON object.',
        );
      }
      metadata = input.body.metadata as JsonMap;
    }

    const record = await createTalkResourceBinding({
      ownerId: input.auth.userId,
      talkId: input.talkId,
      bindingKind,
      externalId,
      displayName,
      metadata,
      createdBy: input.auth.userId,
    });

    return {
      statusCode: 201,
      body: { ok: true, data: { binding: toApiBinding(record) } },
    };
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/talks/:talkId/resources/:resourceId
// ---------------------------------------------------------------------------

export async function deleteTalkResourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  resourceId: string;
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

    const deleted = await deleteTalkResourceBinding(
      input.talkId,
      input.resourceId,
    );
    if (!deleted) {
      return notFoundResponse('Resource binding not found.');
    }

    return {
      statusCode: 200,
      body: { ok: true, data: { deleted: true } },
    };
  });
}
