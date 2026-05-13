// clawtalk Phase 5 PR 2 — Workers Hono app factory.
//
// `getWorkerApp(env)` returns a Hono instance wired with the cloud
// auth surface plus every route handler that has been caller-swapped
// to the postgres + RLS path (Waves 2-3 of the PR 2 cutover).
//
// Public surfaces (no JWT):
//   GET  /api/v1/health             — postgres-backed health probe
//   POST /api/v1/auth/callback      — webapp hands over Supabase
//                                     access+refresh tokens, we set
//                                     eb_at/eb_rt/eb_csrf
//   POST /api/v1/auth/refresh       — eb_rt cookie → fresh trio via
//                                     Supabase /auth/v1/token
//   POST /api/v1/auth/logout        — best-effort Supabase logout +
//                                     always clear cookies
//
// Authed surfaces (requireAuthMiddleware verifies eb_at via JWKS in
// Worker mode, or honors CLAWTALK_DEV_STUB_ENABLED in Node mode):
//   /api/v1/_protected/whoami       — JWT sanity probe
//   /api/v1/agents[/...]            — ai-agents.ts (page composite
//                                     + provider credential CRUD)
//   /api/v1/registered-agents[/...] — agent-management.ts (CRUD,
//                                     fallback config, main agent,
//                                     effective tools)
//   /api/v1/talks[/...]             — talks.ts (talks + folders +
//                                     messages + agents + runs +
//                                     policy + project-mount)
//   /api/v1/talk-folders[/...]      — talks.ts (folder CRUD)
//   /api/v1/user/tool-permissions   — user-settings.ts
//   /api/v1/talks/:talkId/context[/...] — talk-context.ts (goal +
//                                         rules + state + sources)
//   /api/v1/talks/:talkId/state[/...]   — talk-context.ts (talk state
//                                         entries are served from the
//                                         same module as the rest of
//                                         the context surface)
//   /api/v1/talks/:talkId/outputs[/...] — talk-outputs.ts
//
// NOT mounted (still sqlite-bound or needs Workers Queue plumbing):
//   /api/v1/talks/:talkId/chat[/cancel] — needs run-worker wake; will
//                                          land alongside the Queue
//                                          producer in a future unit.
//   /api/v1/talks/:talkId/threads[/...] — talk-threads.ts still on
//                                          sqlite.
//   /api/v1/talks/:talkId/{attachments,jobs}
//                                       — corresponding route file
//                                          still on sqlite.
//   /api/v1/events, /api/v1/talks/:talkId/events — SSE streams; SSE
//                                          + outbox-notifier still
//                                          sqlite + Node-process
//                                          coupled.
//   /api/v1/main/*, /api/v1/browser/*, /api/v1/data-connectors/*,
//   /api/v1/channel-connectors/*, /api/v1/channel-connections/*,
//   /api/v1/talks/:talkId/{tools,resources,channels,data-connectors}
//                                       — chassis-removed surfaces.
//
// The 501 catch-all at the bottom of buildApp() now only fires for
// routes in the not-yet-mounted bucket (above) plus genuinely
// unknown paths.

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';

import { isPgDatabaseHealthy } from '../../db.js';
import { authenticateRequestPg } from './middleware/auth.js';
import { authChallengeHeader, extractJwksEnv } from './middleware/auth.js';
import { validateCsrfTokenPg } from './middleware/csrf.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from './middleware/rate-limit.js';
import { handleAuthCallback } from './routes/auth-callback.js';
import { handleAuthLogout } from './routes/auth-logout.js';
import { handleAuthRefresh } from './routes/auth-refresh.js';
import {
  createAgentRoute,
  deleteAgentRoute,
  getAgentFallbackRoute,
  getAgentRoute,
  getMainAgentRoute,
  listAgentsRoute as listRegisteredAgentsRoute,
  setAgentFallbackRoute,
  updateAgentRoute,
  updateMainAgentRoute,
} from './routes/agent-management.js';
import {
  getAiAgentsRoute,
  putAiProviderCredentialRoute,
  updateDefaultClaudeModelRoute,
  verifyAiProviderCredentialRoute,
} from './routes/ai-agents.js';
import {
  createTalkContextRuleRoute,
  createTalkContextSourceRoute,
  deleteTalkContextRuleRoute,
  deleteTalkContextSourceRoute,
  deleteTalkStateEntryRoute,
  getTalkContextRoute,
  getTalkContextSourceContentRoute,
  getTalkStateRoute,
  listTalkContextRulesRoute,
  patchTalkContextRuleRoute,
  patchTalkContextSourceRoute,
  retryTalkContextSourceRoute,
  setTalkGoalRoute,
  uploadTalkContextSourceRoute,
} from './routes/talk-context.js';
import {
  createTalkOutputRoute,
  deleteTalkOutputRoute,
  getTalkOutputRoute,
  listTalkOutputsRoute,
  patchTalkOutputRoute,
} from './routes/talk-outputs.js';
import {
  cancelTalkChat,
  clearTalkProjectMountRoute,
  createTalkFolderRoute,
  createTalkRoute,
  deleteTalkFolderRoute,
  deleteTalkMessagesRoute,
  deleteTalkRoute,
  getTalkPolicyRoute,
  getTalkProjectMountRoute,
  getTalkRoute,
  getTalkRunContextRoute,
  listTalkAgentsRoute,
  listTalkMessagesRoute,
  listTalkRunsRoute,
  listTalkSidebarRoute,
  listTalksRoute,
  patchTalkFolderRoute,
  patchTalkRoute,
  reorderTalkSidebarRoute,
  searchTalkMessagesRoute,
  updateTalkAgentsRoute,
  updateTalkPolicyRoute,
  updateTalkProjectMountRoute,
} from './routes/talks.js';
import {
  getEffectiveToolsRoute,
  listUserToolPermissionsRoute,
  updateUserToolPermissionRoute,
} from './routes/user-settings.js';
import { AuthContext } from './types.js';

// Suppress unused-import warnings for the cancelTalkChat handler;
// see the "NOT mounted" note in the file header. Kept in the import
// list so the next session that wires Queues only has to add the
// closure, not the import.
void cancelTalkChat;

export interface WorkerAppEnv {
  SUPABASE_PROJECT_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  JWKS_CACHE?: unknown;
}

// Hono variables we carry on Context. The auth middleware writes
// `auth` after a successful JWT verification; downstream handlers
// read it via `c.get('auth')`.
type Variables = {
  auth: AuthContext;
};

let cachedApp: Hono<{ Variables: Variables }> | null = null;

/**
 * Lazy-init the Hono app once per isolate. Workers cold-boot for
 * each isolate, but reused across requests, so amortizing the
 * Hono router construction across the isolate's lifetime is the
 * right shape — matches editorialroom's `getWorkerApp()`.
 */
export function getWorkerApp(): Hono<{ Variables: Variables }> {
  if (cachedApp) return cachedApp;
  cachedApp = buildApp();
  return cachedApp;
}

/** Test-only: drop the cached app so a fresh build can pick up
 * test-time module changes. */
export function _resetWorkerAppForTests(): void {
  cachedApp = null;
}

function buildApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // ── Public surfaces ──────────────────────────────────────────
  app.get('/api/v1/health', handleHealth);
  app.post('/api/v1/auth/callback', handleAuthCallback);
  app.post('/api/v1/auth/refresh', handleAuthRefresh);
  app.post('/api/v1/auth/logout', handleAuthLogout);

  // ── Auth gate for every cloud-ready surface ──────────────────
  // Hono's `app.use(path, mw)` only matches the literal `path`
  // when path is a glob — `/api/v1/agents/*` matches sub-paths
  // but NOT bare `/api/v1/agents`. Register both shapes per
  // namespace so the bare collection endpoints (e.g. GET
  // /api/v1/agents → ai-agents page composite) are gated too.
  app.use('/api/v1/_protected/*', requireAuthMiddleware);
  app.use('/api/v1/agents', requireAuthMiddleware);
  app.use('/api/v1/agents/*', requireAuthMiddleware);
  app.use('/api/v1/registered-agents', requireAuthMiddleware);
  app.use('/api/v1/registered-agents/*', requireAuthMiddleware);
  app.use('/api/v1/talks', requireAuthMiddleware);
  app.use('/api/v1/talks/*', requireAuthMiddleware);
  app.use('/api/v1/talk-folders', requireAuthMiddleware);
  app.use('/api/v1/talk-folders/*', requireAuthMiddleware);
  app.use('/api/v1/user/*', requireAuthMiddleware);

  // ── Sanity probe for the auth middleware ─────────────────────
  app.get('/api/v1/_protected/whoami', (c) => {
    const auth = c.get('auth');
    return c.json({
      ok: true,
      data: {
        userId: auth.userId,
        sessionId: auth.sessionId,
        role: auth.role,
        authType: auth.authType,
      },
    });
  });

  // ── ai-agents.ts: page composite + provider credentials ──────
  app.get('/api/v1/agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getAiAgentsRoute(auth);
    return jsonResponse(result);
  });

  app.put('/api/v1/agents/default-claude', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await updateDefaultClaudeModelRoute(auth, body);
    return jsonResponse(result);
  });

  app.put('/api/v1/agents/providers/:providerId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => ({}));
    const result = await putAiProviderCredentialRoute(
      auth,
      c.req.param('providerId'),
      body,
    );
    return jsonResponse(result);
  });

  app.post('/api/v1/agents/providers/:providerId/verify', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await verifyAiProviderCredentialRoute(
      auth,
      c.req.param('providerId'),
    );
    return jsonResponse(result);
  });

  // ── agent-management.ts: registered-agents CRUD ──────────────
  app.get('/api/v1/registered-agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listRegisteredAgentsRoute(auth);
    return jsonResponse(result);
  });

  app.get('/api/v1/registered-agents/main', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getMainAgentRoute(auth);
    return jsonResponse(result);
  });

  app.put('/api/v1/registered-agents/main', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.json().catch(() => null);
    const result = await updateMainAgentRoute(auth, body);
    return jsonResponse(result);
  });

  app.get('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getAgentRoute(auth, c.req.param('agentId'));
    return jsonResponse(result);
  });

  app.post('/api/v1/registered-agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createAgentRoute(auth, payload.data as any);
    return jsonResponse(result);
  });

  app.put('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateAgentRoute(
      auth,
      c.req.param('agentId'),
      payload.data as any,
    );
    return jsonResponse(result);
  });

  app.delete('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteAgentRoute(auth, c.req.param('agentId'));
    return jsonResponse(result);
  });

  app.get('/api/v1/registered-agents/:agentId/fallback', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getAgentFallbackRoute(auth, c.req.param('agentId'));
    return jsonResponse(result);
  });

  app.put('/api/v1/registered-agents/:agentId/fallback', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await setAgentFallbackRoute(
      auth,
      c.req.param('agentId'),
      payload.data as any,
    );
    return jsonResponse(result);
  });

  // ── user-settings.ts: tool permissions + effective-tools ─────
  app.get('/api/v1/registered-agents/:agentId/effective-tools', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getEffectiveToolsRoute(auth, c.req.param('agentId'));
    return jsonResponse(result);
  });

  app.get('/api/v1/user/tool-permissions', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listUserToolPermissionsRoute(auth);
    return jsonResponse(result);
  });

  app.put('/api/v1/user/tool-permissions', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateUserToolPermissionRoute(
      auth,
      payload.data as any,
    );
    return jsonResponse(result);
  });

  // ── talks.ts: talks + folders + messages + agents + runs ─────
  app.get('/api/v1/talks', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const limit = parsePositiveInt(c.req.query('limit'));
    const offset = parseNonNegativeInt(c.req.query('offset'));
    const result = await listTalksRoute({
      auth,
      limit: limit ?? undefined,
      offset: offset ?? undefined,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/sidebar', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listTalkSidebarRoute({ auth });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ title?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createTalkRoute({
      auth,
      title: payload.data.title,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talk-folders', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ title?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createTalkFolderRoute({
      auth,
      title: payload.data.title,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await getTalkRoute({ auth, talkId: talkId.value });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talks/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'id');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody<{
      title?: string;
      folderId?: string | null;
      orchestrationMode?: 'ordered' | 'panel';
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchTalkRoute({
      auth,
      talkId: talkId.value,
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
      folderId:
        typeof payload.data.folderId === 'string' ||
        payload.data.folderId === null
          ? payload.data.folderId
          : undefined,
      orchestrationMode:
        payload.data.orchestrationMode === 'ordered' ||
        payload.data.orchestrationMode === 'panel'
          ? payload.data.orchestrationMode
          : undefined,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/project-mount', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await getTalkProjectMountRoute({
      auth,
      talkId: talkId.value,
    });
    return jsonResponse(result);
  });

  app.put('/api/v1/talks/:talkId/project-mount', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody<{ projectPath?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    if (typeof payload.data.projectPath !== 'string') {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_project_path',
            message: 'projectPath must be a string',
          },
        },
        400,
      );
    }
    const result = await updateTalkProjectMountRoute({
      auth,
      talkId: talkId.value,
      projectPath: payload.data.projectPath,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/project-mount', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await clearTalkProjectMountRoute({
      auth,
      talkId: talkId.value,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'id');
    if (!talkId.ok) return talkId.response;
    const result = await deleteTalkRoute({ auth, talkId: talkId.value });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talk-folders/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const folderId = decodeIdParam(c, 'id');
    if (!folderId.ok) return folderId.response;
    const payload = await readJsonBody<{ title?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchTalkFolderRoute({
      auth,
      folderId: folderId.value,
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talk-folders/:id', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const folderId = decodeIdParam(c, 'id');
    if (!folderId.ok) return folderId.response;
    const result = await deleteTalkFolderRoute({
      auth,
      folderId: folderId.value,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/sidebar/reorder', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      itemType?: 'talk' | 'folder';
      itemId?: string;
      destinationFolderId?: string | null;
      destinationIndex?: number;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    if (
      payload.data.itemType !== 'talk' &&
      payload.data.itemType !== 'folder'
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_sidebar_reorder',
            message: 'Item type must be talk or folder',
          },
        },
        400,
      );
    }
    if (
      typeof payload.data.itemId !== 'string' ||
      payload.data.itemId.length === 0
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_sidebar_reorder',
            message: 'Item id is required',
          },
        },
        400,
      );
    }
    if (
      !(
        typeof payload.data.destinationFolderId === 'string' ||
        payload.data.destinationFolderId === null
      )
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_sidebar_reorder',
            message: 'Destination folder must be a folder id or null',
          },
        },
        400,
      );
    }
    if (
      typeof payload.data.destinationIndex !== 'number' ||
      Number.isNaN(payload.data.destinationIndex)
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_sidebar_reorder',
            message: 'Destination index must be a number',
          },
        },
        400,
      );
    }
    const result = await reorderTalkSidebarRoute({
      auth,
      itemType: payload.data.itemType,
      itemId: payload.data.itemId,
      destinationFolderId: payload.data.destinationFolderId,
      destinationIndex: payload.data.destinationIndex,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/messages', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const limit = parsePositiveInt(c.req.query('limit'));
    const beforeCreatedAt = c.req.query('before') || undefined;
    const threadId = (c.req.query('threadId') || '').trim() || undefined;
    const result = await listTalkMessagesRoute({
      auth,
      talkId: talkId.value,
      threadId,
      limit: limit ?? undefined,
      beforeCreatedAt,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/messages/delete', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      messageIds?: unknown;
      threadId?: unknown;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const messageIds = Array.isArray(payload.data.messageIds)
      ? payload.data.messageIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const threadId =
      typeof payload.data.threadId === 'string' ? payload.data.threadId : null;
    const result = await deleteTalkMessagesRoute({
      auth,
      talkId: c.req.param('talkId'),
      messageIds,
      threadId,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/messages/search', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const query = c.req.query('q') || '';
    const limit = parsePositiveInt(c.req.query('limit'));
    const result = await searchTalkMessagesRoute({
      auth,
      talkId: talkId.value,
      query,
      limit: limit ?? undefined,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await listTalkAgentsRoute({ auth, talkId: talkId.value });
    return jsonResponse(result);
  });

  app.put('/api/v1/talks/:talkId/agents', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody<{ agents?: unknown }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateTalkAgentsRoute({
      auth,
      talkId: talkId.value,
      agents: payload.data.agents,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/runs', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await listTalkRunsRoute({ auth, talkId: talkId.value });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/runs/:runId/context', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const runId = decodeIdParam(c, 'runId');
    if (!runId.ok) return runId.response;
    const result = await getTalkRunContextRoute({
      auth,
      talkId: talkId.value,
      runId: runId.value,
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/policy', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const result = await getTalkPolicyRoute({ auth, talkId: talkId.value });
    return jsonResponse(result);
  });

  app.put('/api/v1/talks/:talkId/policy', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const talkId = decodeIdParam(c, 'talkId');
    if (!talkId.ok) return talkId.response;
    const payload = await readJsonBody<{ agents?: unknown }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await updateTalkPolicyRoute({
      auth,
      talkId: talkId.value,
      agents: payload.data.agents,
    });
    return jsonResponse(result);
  });

  // ── talk-outputs.ts: per-Talk markdown outputs CRUD ──────────
  app.get('/api/v1/talks/:talkId/outputs', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listTalkOutputsRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/outputs/:outputId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getTalkOutputRoute({
      auth,
      talkId: c.req.param('talkId'),
      outputId: c.req.param('outputId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/outputs', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      title?: string;
      contentMarkdown?: string;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createTalkOutputRoute({
      auth,
      talkId: c.req.param('talkId'),
      title: typeof payload.data.title === 'string' ? payload.data.title : '',
      contentMarkdown:
        typeof payload.data.contentMarkdown === 'string'
          ? payload.data.contentMarkdown
          : '',
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talks/:talkId/outputs/:outputId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      expectedVersion?: number;
      title?: string;
      contentMarkdown?: string;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchTalkOutputRoute({
      auth,
      talkId: c.req.param('talkId'),
      outputId: c.req.param('outputId'),
      expectedVersion:
        typeof payload.data.expectedVersion === 'number'
          ? payload.data.expectedVersion
          : undefined,
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
      contentMarkdown:
        typeof payload.data.contentMarkdown === 'string'
          ? payload.data.contentMarkdown
          : undefined,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/outputs/:outputId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteTalkOutputRoute({
      auth,
      talkId: c.req.param('talkId'),
      outputId: c.req.param('outputId'),
    });
    return jsonResponse(result);
  });

  // ── talk-context.ts: goal + rules + state + sources ──────────
  app.get('/api/v1/talks/:talkId/context', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getTalkContextRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.put('/api/v1/talks/:talkId/context/goal', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ goalText?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await setTalkGoalRoute({
      auth,
      talkId: c.req.param('talkId'),
      goalText:
        typeof payload.data.goalText === 'string' ? payload.data.goalText : '',
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/context/rules', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await listTalkContextRulesRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/context/rules', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{ ruleText?: string }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createTalkContextRuleRoute({
      auth,
      talkId: c.req.param('talkId'),
      ruleText:
        typeof payload.data.ruleText === 'string' ? payload.data.ruleText : '',
    });
    return jsonResponse(result);
  });

  app.patch('/api/v1/talks/:talkId/context/rules/:ruleId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      ruleText?: string;
      isActive?: boolean;
      sortOrder?: number;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchTalkContextRuleRoute({
      auth,
      talkId: c.req.param('talkId'),
      ruleId: c.req.param('ruleId'),
      ruleText:
        typeof payload.data.ruleText === 'string'
          ? payload.data.ruleText
          : undefined,
      isActive:
        typeof payload.data.isActive === 'boolean'
          ? payload.data.isActive
          : undefined,
      sortOrder:
        typeof payload.data.sortOrder === 'number'
          ? payload.data.sortOrder
          : undefined,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/context/rules/:ruleId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteTalkContextRuleRoute({
      auth,
      talkId: c.req.param('talkId'),
      ruleId: c.req.param('ruleId'),
    });
    return jsonResponse(result);
  });

  app.get('/api/v1/talks/:talkId/state', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const result = await getTalkStateRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/state/:key', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteTalkStateEntryRoute({
      auth,
      talkId: c.req.param('talkId'),
      key: c.req.param('key'),
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/context/sources', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      sourceType?: string;
      title?: string;
      note?: string | null;
      sourceUrl?: string | null;
      extractedText?: string | null;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await createTalkContextSourceRoute({
      auth,
      talkId: c.req.param('talkId'),
      sourceType:
        typeof payload.data.sourceType === 'string'
          ? payload.data.sourceType
          : '',
      title: typeof payload.data.title === 'string' ? payload.data.title : '',
      note: typeof payload.data.note === 'string' ? payload.data.note : null,
      sourceUrl:
        typeof payload.data.sourceUrl === 'string'
          ? payload.data.sourceUrl
          : null,
      extractedText:
        typeof payload.data.extractedText === 'string'
          ? payload.data.extractedText
          : null,
    });
    return jsonResponse(result);
  });

  app.post('/api/v1/talks/:talkId/context/sources/upload', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!file || !(file instanceof File)) {
      return c.json(
        {
          ok: false,
          error: { code: 'file_required', message: 'A file field is required' },
        },
        400,
      );
    }
    const arrayBuffer = await file.arrayBuffer();
    const title = typeof body['title'] === 'string' ? body['title'] : undefined;
    const result = await uploadTalkContextSourceRoute({
      auth,
      talkId: c.req.param('talkId'),
      file: {
        name: file.name || 'unnamed',
        data: Buffer.from(arrayBuffer),
        type: file.type || 'application/octet-stream',
      },
      title,
    });
    return jsonResponse(result);
  });

  app.get(
    '/api/v1/talks/:talkId/context/sources/:sourceId/content',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'read' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const result = await getTalkContextSourceContentRoute({
        auth,
        talkId: c.req.param('talkId'),
        sourceId: c.req.param('sourceId'),
      });
      if ('headers' in result && result.headers) {
        return new Response(result.body, {
          status: result.statusCode,
          headers: result.headers,
        });
      }
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.patch('/api/v1/talks/:talkId/context/sources/:sourceId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const payload = await readJsonBody<{
      title?: string;
      note?: string | null;
      sortOrder?: number;
      extractedText?: string | null;
    }>(c);
    if (!payload.ok) return invalidJsonResponse(c, payload.error);
    const result = await patchTalkContextSourceRoute({
      auth,
      talkId: c.req.param('talkId'),
      sourceId: c.req.param('sourceId'),
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
      note:
        payload.data.note !== undefined
          ? typeof payload.data.note === 'string'
            ? payload.data.note
            : null
          : undefined,
      sortOrder:
        typeof payload.data.sortOrder === 'number'
          ? payload.data.sortOrder
          : undefined,
      extractedText:
        typeof payload.data.extractedText === 'string'
          ? payload.data.extractedText
          : undefined,
    });
    return jsonResponse(result);
  });

  app.delete('/api/v1/talks/:talkId/context/sources/:sourceId', async (c) => {
    const auth = c.get('auth');
    const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
    if (!rl.allowed) return rateLimitedResponse(c, rl);
    const csrfFail = checkCsrf(c, auth);
    if (csrfFail) return csrfFail;
    const result = await deleteTalkContextSourceRoute({
      auth,
      talkId: c.req.param('talkId'),
      sourceId: c.req.param('sourceId'),
    });
    return jsonResponse(result);
  });

  app.post(
    '/api/v1/talks/:talkId/context/sources/:sourceId/retry',
    async (c) => {
      const auth = c.get('auth');
      const rl = checkRateLimit({ principalId: auth.userId, bucket: 'write' });
      if (!rl.allowed) return rateLimitedResponse(c, rl);
      const csrfFail = checkCsrf(c, auth);
      if (csrfFail) return csrfFail;
      const result = await retryTalkContextSourceRoute({
        auth,
        talkId: c.req.param('talkId'),
        sourceId: c.req.param('sourceId'),
      });
      return jsonResponse(result);
    },
  );

  // 501 fallback for any /api/v1/* path that hasn't been mounted.
  // Routes still on sqlite, chassis-removed, or pending Queues
  // wiring (chat enqueue / SSE) all land here.
  app.all('/api/v1/*', (c) =>
    c.json(
      {
        ok: false,
        error: {
          code: 'not_implemented_in_worker',
          message:
            'This route is not yet wired through the Worker entry. PR 2 caller-swap is in progress.',
        },
      },
      501,
    ),
  );

  return app;
}

async function handleHealth(c: Context): Promise<Response> {
  const dbHealthy = await isPgDatabaseHealthy().catch(() => false);
  return c.json({
    ok: true,
    data: {
      status: 'ok',
      db: dbHealthy,
      runtime: 'workers',
    },
  });
}

/**
 * Hono middleware that verifies the eb_at cookie via Supabase JWKS
 * and attaches the resolved AuthContext to the request. Worker mode
 * (env has JWKS_CACHE + SUPABASE_PROJECT_URL) verifies cryptograph-
 * ically; Node mode (vitest, tsx local) falls back to the
 * CLAWTALK_DEV_STUB_ENABLED gate.
 */
const requireAuthMiddleware: MiddlewareHandler<{
  Variables: Variables;
}> = async (c, next) => {
  const env = extractJwksEnv(c.env);
  const result = await authenticateRequestPg(
    {
      authorization: c.req.header('authorization'),
      cookie: c.req.header('cookie'),
    },
    env,
  );
  if (result.kind !== 'authenticated') {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'Authentication is required',
        },
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': authChallengeHeader(result.reason),
        },
      },
    );
  }
  c.set('auth', result.auth);
  await next();
};

// ── shared helpers ──────────────────────────────────────────────

/** Translate a route handler envelope into an HTTP response. */
function jsonResponse(result: { statusCode: number; body: unknown }): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function rateLimitedResponse(
  c: Context,
  rateResult: RateLimitResult,
): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'Rate limit exceeded',
        details: {
          limit: rateResult.limit,
          retryAfterSec: rateResult.retryAfterSec,
        },
      },
    },
    429,
    {
      'retry-after': String(rateResult.retryAfterSec),
    },
  );
}

/** Returns a 403 csrf_failed response if validation fails, else null. */
function checkCsrf(c: Context, auth: AuthContext): Response | null {
  const csrf = validateCsrfTokenPg({
    method: c.req.method,
    authType: auth.authType,
    cookieHeader: c.req.header('cookie'),
    csrfHeader: c.req.header('x-csrf-token'),
  });
  if (csrf.ok) return null;
  return c.json(
    {
      ok: false,
      error: { code: 'csrf_failed', message: csrf.reason },
    },
    403,
  );
}

async function readJsonBody<T = Record<string, unknown>>(
  c: Context,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const bodyText = await c.req.text();
  if (!bodyText.trim()) return { ok: true, data: {} as T };
  try {
    return { ok: true, data: JSON.parse(bodyText) as T };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON' };
  }
}

function invalidJsonResponse(c: Context, message: string): Response {
  return c.json({ ok: false, error: { code: 'invalid_json', message } }, 400);
}

type DecodedIdParam =
  | { ok: true; value: string }
  | { ok: false; response: Response };

function decodeIdParam(c: Context, paramName: string): DecodedIdParam {
  const raw = c.req.param(paramName);
  if (raw) {
    try {
      return { ok: true, value: decodeURIComponent(raw) };
    } catch {
      // fall through to error response
    }
  }
  return {
    ok: false,
    response: c.json(
      {
        ok: false,
        error: {
          code: paramName === 'talkId' ? 'invalid_talk_id' : 'bad_request',
          message: `${paramName} path segment is not valid URL encoding`,
        },
      },
      400,
    ),
  };
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}
