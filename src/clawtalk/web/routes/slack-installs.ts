// Slack workspace install routes.
//
// Admin-managed Slack OAuth installs. One row per installed workspace; the
// PR 2 channel picker reads `team_id` from this list to look up channels
// for the chosen workspace.
//
// JSON routes (/api/v1/workspace/connectors/slack/installs/*) return the
// standard { statusCode, body: ApiEnvelope<T> } shape. The popup callback
// at /api/v1/auth/slack/callback returns an HTML Response directly because
// the page runs in the popup window and posts back to window.opener.

import { withUserContext } from '../../../db.js';
import { SLACK_OAUTH_REDIRECT_URI } from '../../config.js';
import {
  SlackOAuthError,
  completeSlackInstallCallback,
  startSlackInstall,
} from '../../connectors/slack-oauth-service.js';
import {
  deleteWorkspaceSlackInstall,
  listWorkspaceSlackInstalls,
  type WorkspaceSlackInstallRecord,
} from '../../db/slack-installs-accessors.js';
import { ApiEnvelope, AuthContext } from '../types.js';

interface JsonRouteResult<T> {
  statusCode: number;
  body: ApiEnvelope<T>;
}

function errorResult(
  statusCode: number,
  code: string,
  message: string,
): JsonRouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function fromOAuthError(err: SlackOAuthError): JsonRouteResult<never> {
  return errorResult(err.status, err.code, err.message);
}

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function forbiddenAdminResponse(): JsonRouteResult<never> {
  return errorResult(
    403,
    'forbidden',
    'Only workspace admins can manage Slack installs.',
  );
}

export interface ApiWorkspaceSlackInstall {
  teamId: string;
  teamName: string;
  botUserId: string | null;
  appId: string | null;
  scopes: string[];
  installedBy: string | null;
  installedAt: string;
  updatedAt: string;
  boundChannelCount: number;
}

function toApiInstall(
  row: WorkspaceSlackInstallRecord,
): ApiWorkspaceSlackInstall {
  return {
    teamId: row.team_id,
    teamName: row.team_name,
    botUserId: row.bot_user_id,
    appId: row.app_id,
    scopes: row.scopes,
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    boundChannelCount: row.bound_channel_count,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/workspace/connectors/slack/installs
// ---------------------------------------------------------------------------

export async function listWorkspaceSlackInstallsRoute(
  auth: AuthContext,
): Promise<JsonRouteResult<{ installs: ApiWorkspaceSlackInstall[] }>> {
  return withUserContext(auth.userId, async () => {
    const rows = await listWorkspaceSlackInstalls();
    return {
      statusCode: 200,
      body: { ok: true, data: { installs: rows.map(toApiInstall) } },
    };
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/workspace/connectors/slack/installs/connect
// ---------------------------------------------------------------------------

export async function startSlackInstallRoute(
  auth: AuthContext,
  body: { returnTo?: unknown },
): Promise<
  JsonRouteResult<{ authorizationUrl: string; expiresInSec: number }>
> {
  if (!isAdminLike(auth.role)) return forbiddenAdminResponse();

  const returnTo =
    typeof body.returnTo === 'string' && body.returnTo.length > 0
      ? body.returnTo
      : null;

  try {
    const result = await withUserContext(auth.userId, () =>
      startSlackInstall({
        userId: auth.userId,
        redirectUri: SLACK_OAUTH_REDIRECT_URI,
        returnTo,
      }),
    );
    return { statusCode: 200, body: { ok: true, data: result } };
  } catch (err) {
    if (err instanceof SlackOAuthError) return fromOAuthError(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/workspace/connectors/slack/installs/:teamId
// ---------------------------------------------------------------------------

export async function deleteWorkspaceSlackInstallRoute(input: {
  auth: AuthContext;
  teamId: string;
}): Promise<JsonRouteResult<{ deleted: boolean }>> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();
  return withUserContext(input.auth.userId, async () => {
    const deleted = await deleteWorkspaceSlackInstall(input.teamId);
    if (!deleted) {
      return errorResult(404, 'not_found', 'Slack install not found.');
    }
    return { statusCode: 200, body: { ok: true, data: { deleted: true } } };
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/auth/slack/callback
// ---------------------------------------------------------------------------

export function htmlSafeJson(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}

function renderCallbackHtml(payload: {
  type: 'clawtalk:slack-workspace-install';
  status: 'success' | 'error';
  teamName?: string | null;
  message?: string | null;
}): string {
  const serialized = htmlSafeJson(payload);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Slack install</title></head>
<body>
<p>Closing window…</p>
<script>
(function () {
  var payload = ${serialized};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
    }
  } catch (e) {}
  setTimeout(function () { window.close(); }, 50);
})();
</script>
</body></html>`;
}

export async function handleSlackCallback(rawQuery: {
  state: string | null;
  code: string | null;
  error: string | null;
}): Promise<{ html: string; statusCode: number }> {
  if (!rawQuery.state) {
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:slack-workspace-install',
        status: 'error',
        message: 'Install link is invalid.',
      }),
      statusCode: 400,
    };
  }

  try {
    const result = await completeSlackInstallCallback({
      rawState: rawQuery.state,
      code: rawQuery.code,
      slackError: rawQuery.error,
    });
    if (result.status === 'success') {
      return {
        html: renderCallbackHtml({
          type: 'clawtalk:slack-workspace-install',
          status: 'success',
          teamName: result.teamName ?? null,
        }),
        statusCode: 200,
      };
    }
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:slack-workspace-install',
        status: 'error',
        message: result.message ?? 'Could not complete install.',
      }),
      statusCode: result.status === 'denied' ? 200 : 400,
    };
  } catch (err) {
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:slack-workspace-install',
        status: 'error',
        message: 'Could not complete install.',
      }),
      statusCode: err instanceof SlackOAuthError ? err.status : 500,
    };
  }
}
