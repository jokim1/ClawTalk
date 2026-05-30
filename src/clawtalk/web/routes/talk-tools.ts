// /api/v1/talks/:talkId/tools — Talk-scoped tool toggle route.
//
// GET   returns { active, available }
//          active     — Record<string, boolean> from talks.active_tool_families_json
//          available  — string[] of the light tool family slugs shown on
//                       the chip bar (static; heavy families excluded)
// PATCH  takes  { family, enabled } — flips one family on/off
//          400 on unknown family slug
//          404 when the Talk is not owned by the caller (RLS hides it)
//
// On PATCH success, emits a `talk_tools_changed` outbox event so other
// open tabs sync the chip state. The event filter at
// src/clawtalk/talks/event-filters.ts allowlists this type for
// thread-scoped subscriptions (see T7 / codex #5).

import { withUserContext } from '../../../db.js';
import { TALK_TOOL_FAMILIES } from '../../db/agent-accessors.js';
import { getTalkForUser } from '../../db/accessors.js';
import {
  getTalkActiveTools,
  setTalkActiveTool,
} from '../../db/talk-tools-accessors.js';
import { emitOutboxEvent } from '../../talks/outbox-emit.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

export interface TalkToolsResponse {
  talkId: string;
  active: Record<string, boolean>;
  available: string[];
}

export async function getTalkToolsRoute(input: {
  talkId: string;
  auth: AuthContext;
}): Promise<{ statusCode: number; body: ApiEnvelope<TalkToolsResponse> }> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'talk_not_found',
            message: 'Talk not found',
          },
        },
      };
    }
    const active = await getTalkActiveTools(input.talkId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          active,
          // The tool bar shows the static light vocabulary; heavy families
          // (shell/filesystem/browser) are excluded.
          available: TALK_TOOL_FAMILIES,
        },
      },
    };
  });
}

export async function updateTalkToolRoute(input: {
  talkId: string;
  auth: AuthContext;
  body: unknown;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<TalkToolsResponse>;
}> {
  const normalized = normalizePatchBody(input.body);
  if (!normalized.ok) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_tool_toggle',
          message: normalized.error,
        },
      },
    };
  }
  const { family, enabled } = normalized;

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'talk_not_found',
            message: 'Talk not found',
          },
        },
      };
    }
    const active = await setTalkActiveTool(input.talkId, family, enabled);
    await emitOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: 'talk_tools_changed',
      payload: {
        talkId: input.talkId,
        active,
      },
      ownerIds: [input.auth.userId],
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          active,
          available: TALK_TOOL_FAMILIES,
        },
      },
    };
  });
}

type NormalizedPatch =
  | { ok: true; family: string; enabled: boolean }
  | { ok: false; error: string };

function normalizePatchBody(body: unknown): NormalizedPatch {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'request body must be an object' };
  }
  const obj = body as Record<string, unknown>;
  const family = obj.family;
  const enabled = obj.enabled;
  if (typeof family !== 'string' || family.length === 0) {
    return { ok: false, error: 'family must be a non-empty string' };
  }
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' };
  }
  if (!TALK_TOOL_FAMILIES.includes(family)) {
    return {
      ok: false,
      error: `unknown family '${family}' — must be one of ${TALK_TOOL_FAMILIES.join(
        ', ',
      )}`,
    };
  }
  return { ok: true, family, enabled };
}
