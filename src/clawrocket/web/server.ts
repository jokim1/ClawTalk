import fs from 'fs';
import path from 'path';

import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Context, Hono } from 'hono';

import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_DEV_MODE,
  GOOGLE_OAUTH_REDIRECT_URI,
  REFRESH_TOKEN_TTL_SEC,
  TRUSTED_PROXY_MODE,
  WEB_PORT,
  WEB_SECURE_COOKIES,
  isPublicMode,
} from '../config.js';
import {
  canUserAccessTalk,
  countRunningTalkRuns,
  deleteGoogleOAuthLinkRequest,
  ensureSystemManagedTelegramConnection,
  getTalkForUser,
  getOutboxEventsForTopics,
  getOutboxMaxEventIdForTopics,
  getOutboxMinEventIdForTopics,
  getGoogleOAuthLinkRequest,
  listTalkThreads,
  resolveThreadIdForTalk,
  TalkThreadValidationError,
  getUserById,
  updateUserDisplayName,
} from '../db/index.js';
import { getDb } from '../../db.js';
import {
  completeDeviceAuthFlow,
  completeGoogleOAuthCallback,
  completeGoogleOAuthIdentityCallback,
  createInvite,
  AuthError,
  logoutSession,
  refreshSession,
  startDeviceAuthFlow,
  startGoogleOAuth,
} from '../identity/auth-service.js';
import {
  ACCESS_TOKEN_COOKIE,
  CSRF_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../identity/session.js';
import { KeychainBridge, noopKeychainBridge } from '../secrets/keychain.js';
import type { TalkRunWorkerControl } from '../talks/run-worker.js';
import type { TalkJobWorkerControl } from '../talks/job-worker.js';
import type { MainRunWorkerControl } from '../agents/main-run-worker.js';
import { hashOpaqueToken } from '../security/hash.js';
import { waitForOutboxTopics } from '../channels/outbox-notifier.js';
import { validateCsrfToken } from './middleware/csrf.js';
import {
  idempotencyPrecheck,
  saveIdempotencyResult,
} from './middleware/idempotency.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from './middleware/rate-limit.js';
import {
  buildTalkThreadEventFilter,
  buildTalkScopedSseStream,
  buildUserScopedSseStream,
  formatOutboxEventAsSse,
  getTalkScopedEventTopics,
  getUserScopedEventTopics,
} from './routes/events.js';
import { healthResponse, statusResponse } from './routes/system.js';
import {
  createTalkFolderRoute,
  cancelTalkChat,
  createTalkRoute,
  clearTalkProjectMountRoute,
  deleteTalkMessagesRoute,
  deleteTalkFolderRoute,
  deleteTalkRoute,
  enqueueTalkChat,
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
  updateTalkProjectMountRoute,
  updateTalkPolicyRoute,
} from './routes/talks.js';
// --- New architecture routes ---
import {
  listAgentsRoute as listRegisteredAgentsRoute,
  getAgentRoute,
  createAgentRoute,
  updateAgentRoute,
  deleteAgentRoute,
  getAgentFallbackRoute,
  setAgentFallbackRoute,
  getMainAgentRoute,
  updateMainAgentRoute,
} from './routes/agent-management.js';
import {
  getExecutorSettingsRoute,
  getExecutorStatusRoute,
  getExecutorSubscriptionHostStatusRoute,
  importExecutorSubscriptionRoute,
  putExecutorSettingsRoute,
  verifyExecutorRoute,
} from './routes/executor-settings.js';
import {
  getAiAgentsRoute,
  putAiProviderCredentialRoute,
  updateDefaultClaudeModelRoute,
  verifyAiProviderCredentialRoute,
} from './routes/ai-agents.js';
import {
  listUserToolPermissionsRoute,
  updateUserToolPermissionRoute,
  getEffectiveToolsRoute,
} from './routes/user-settings.js';
import {
  cancelMainRunRoute,
  deleteMainMessagesRoute,
  deleteMainThreadRoute,
  listMainThreadsRoute,
  getMainThreadRoute,
  listMainRunsRoute,
  patchMainThreadRoute,
  postMainRunVisibleRoute,
  postMainMessageRoute,
} from './routes/main-channel.js';
import {
  approveBrowserConfirmationRoute,
  cancelConflictingBrowserRunRoute,
  createBrowserProfileRoute,
  deleteBrowserProfileRoute,
  discoverChromeSubprofilesRoute,
  discoverChromeUserDataDirectoriesRoute,
  getBrowserSessionStatusRoute,
  listBrowserProfilesRoute,
  releaseBrowserProfileSessionsRoute,
  rejectBrowserConfirmationRoute,
  resumeBrowserBlockedRunRoute,
  resumeBrowserSessionRoute,
  startBrowserSetupSessionRoute,
  startBrowserTakeoverRoute,
  updateBrowserProfileConnectionModeRoute,
} from './routes/browser.js';
import {
  deleteTalkThreadRoute,
  patchTalkThreadRoute,
} from './routes/talk-threads.js';
import {
  attachTalkDataConnectorRoute,
  createDataConnectorRoute,
  deleteDataConnectorRoute,
  detachTalkDataConnectorRoute,
  listDataConnectorsRoute,
  listTalkDataConnectorsRoute,
  patchDataConnectorRoute,
  setDataConnectorCredentialRoute,
} from './routes/data-connectors.js';
import {
  createTalkResourceRoute,
  deleteTalkResourceRoute,
  getGooglePickerSessionRoute,
  getTalkToolsRoute,
  getUserGoogleAccountRoute,
  listTalkResourcesRoute,
  startUserGoogleAccountConnectRoute,
  startUserGoogleScopeExpansionRoute,
  updateTalkToolGrantsRoute,
} from './routes/talk-tools.js';
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
  createTalkJobRoute,
  deleteTalkJobRoute,
  getTalkJobRoute,
  listTalkJobRunsRoute,
  listTalkJobsRoute,
  patchTalkJobRoute,
  pauseTalkJobRoute,
  resumeTalkJobRoute,
  runTalkJobNowRoute,
} from './routes/talk-jobs.js';
import {
  getTalkAttachmentContentRoute,
  listTalkAttachmentsRoute,
  uploadTalkAttachmentRoute,
} from './routes/talk-attachments.js';
import {
  approveChannelTargetRoute,
  adoptTelegramEnvTokenRoute,
  approveTelegramTargetRoute,
  clearSlackProviderConfigRoute,
  completeSlackOAuthInstallRoute,
  deleteTelegramChannelConnectorTokenRoute,
  diagnoseSlackWorkspaceTargetRoute,
  disconnectSlackWorkspaceRoute,
  getTelegramChannelConnectorRoute,
  getSlackChannelConnectorRoute,
  handleSlackEventsRoute,
  listChannelConnectionsRoute,
  listChannelTargetsRoute,
  listTalkChannelsRoute,
  createTalkChannelRoute,
  patchTalkChannelRoute,
  deleteTalkChannelRoute,
  listTalkChannelBindingStateRoute,
  upsertTalkChannelBindingStateRoute,
  deleteTalkChannelBindingStateRoute,
  reviewTalkChannelInstructionsRoute,
  testTalkChannelBindingRoute,
  unquarantineTalkChannelBindingRoute,
  retryTalkChannelDeliveryFailuresCappedRoute,
  listTalkChannelIngressFailuresRoute,
  retryTalkChannelIngressFailureRoute,
  deleteTalkChannelIngressFailureRoute,
  listTalkChannelDeliveryFailuresRoute,
  retryTalkChannelDeliveryFailureRoute,
  deleteTalkChannelDeliveryFailureRoute,
  saveSlackProviderConfigRoute,
  saveTelegramChannelConnectorTokenRoute,
  startSlackOAuthInstallRoute,
  syncSlackWorkspaceRoute,
  unapproveChannelTargetRoute,
  unapproveTelegramTargetRoute,
  validateTelegramChannelConnectorRoute,
} from './routes/channels.js';
import {
  createDefaultTalkContextSourceIngestionService,
  type TalkContextSourceIngestionService,
} from '../talks/source-ingestion.js';
import { authenticateRequest } from './middleware/auth.js';
import { canEditTalk } from './middleware/acl.js';
import { AuthContext } from './types.js';
import { DataConnectorVerifier } from '../connectors/connector-verifier.js';
import { persistGoogleOAuthIdentity } from '../identity/google-tools-service.js';
import { logger } from '../../logger.js';
import type { SlackEventEnvelope } from '../../channels/slack.js';

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const SSE_RETRY_MS = 3000;
const SSE_STREAM_HEARTBEAT_MS = 15_000;
const SSE_STREAM_BATCH_LIMIT = 100;
const SSE_STREAM_RETRY_AFTER_SEC = 5;
const MAX_LIVE_SSE_CONNECTIONS_PER_USER = 3;
const DEFAULT_WEB_APP_DIST_DIR = path.resolve(process.cwd(), 'webapp', 'dist');
let warnedAboutUnexpectedForwardedHeaders = false;
let warnedAboutMissingCloudflareClientIp = false;
let warnedAboutMissingCaddyForwardedFor = false;

export interface WebServerOptions {
  host: string;
  port: number;
  keychain: KeychainBridge;
  runWorker: TalkRunWorkerControl;
  jobWorker: TalkJobWorkerControl;
  mainRunWorker: MainRunWorkerControl;
  webAppDistDir: string;
  dataConnectorVerifier: DataConnectorVerifier;
  sourceIngestion: TalkContextSourceIngestionService;
  onTalkTerminal?: (talkId: string) => void;
  sendChannelTestMessage?: (bindingId: string, text: string) => Promise<void>;
  reloadChannelConnection?: (connectionId: string) => Promise<void>;
  disconnectChannelConnection?: (connectionId: string) => Promise<void>;
  handleSlackEvent?: (
    connectionId: string,
    event: SlackEventEnvelope,
  ) => Promise<void>;
}

export interface WebServerHandle {
  start: () => Promise<{ host: string; port: number }>;
  stop: () => Promise<void>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  server: ServerType | null;
  runWorker?: TalkRunWorkerControl;
}

export function createWebServer(
  input?: Partial<WebServerOptions>,
): WebServerHandle {
  const noopRunWorker: TalkRunWorkerControl = {
    wake: () => {
      /* no-op */
    },
    abortTalk: () => {
      /* no-op */
    },
    abortThread: () => {
      /* no-op */
    },
  };

  const noopMainRunWorker: MainRunWorkerControl = {
    wake: () => {
      /* no-op */
    },
    cancelRun: () => {
      /* no-op */
    },
  };
  const noopJobWorker: TalkJobWorkerControl = {
    wake: () => {
      /* no-op */
    },
  };

  const opts: WebServerOptions = {
    host: input?.host ?? '127.0.0.1',
    port: input?.port ?? 3210,
    keychain: input?.keychain || noopKeychainBridge,
    runWorker: input?.runWorker || noopRunWorker,
    jobWorker: input?.jobWorker || noopJobWorker,
    mainRunWorker: input?.mainRunWorker || noopMainRunWorker,
    webAppDistDir: input?.webAppDistDir ?? DEFAULT_WEB_APP_DIST_DIR,
    dataConnectorVerifier:
      input?.dataConnectorVerifier || new DataConnectorVerifier(),
    sourceIngestion:
      input?.sourceIngestion ||
      createDefaultTalkContextSourceIngestionService(),
    onTalkTerminal: input?.onTalkTerminal,
    sendChannelTestMessage: input?.sendChannelTestMessage,
    reloadChannelConnection: input?.reloadChannelConnection,
    disconnectChannelConnection: input?.disconnectChannelConnection,
    handleSlackEvent: input?.handleSlackEvent,
  };

  const app = buildApp(opts);
  let server: ServerType | null = null;

  return {
    get server() {
      return server;
    },
    request: async (path: string, init?: RequestInit) => {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      const url =
        path.startsWith('http://') || path.startsWith('https://')
          ? path
          : `http://localhost${normalizedPath}`;
      return app.request(url, init);
    },
    start: async () => {
      if (server) {
        const address = server.address();
        const resolvedPort =
          address && typeof address === 'object' ? address.port : opts.port;
        return { host: opts.host, port: resolvedPort };
      }

      const candidate = createAdaptorServer({
        fetch: app.fetch,
        hostname: opts.host,
        port: opts.port,
      });
      server = candidate;

      return new Promise<{ host: string; port: number }>((resolve, reject) => {
        const cleanup = () => {
          candidate.off('error', onError);
          candidate.off('listening', onListening);
        };
        const onError = (error: Error) => {
          cleanup();
          server = null;
          reject(error);
        };
        const onListening = () => {
          cleanup();
          const address = candidate.address();
          const resolvedPort =
            address && typeof address === 'object' ? address.port : opts.port;
          resolve({ host: opts.host, port: resolvedPort });
        };

        candidate.once('error', onError);
        candidate.once('listening', onListening);
        candidate.listen(opts.port, opts.host);
      });
    },
    stop: async () => {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      server = null;
    },
  };
}

function buildApp(opts: WebServerOptions): Hono {
  const app = new Hono();
  const liveSseConnectionsByUser = new Map<string, number>();

  const tryAcquireLiveSseConnection = (userId: string): boolean => {
    const active = liveSseConnectionsByUser.get(userId) || 0;
    if (active >= MAX_LIVE_SSE_CONNECTIONS_PER_USER) return false;
    liveSseConnectionsByUser.set(userId, active + 1);
    return true;
  };

  const releaseLiveSseConnection = (userId: string): void => {
    const active = liveSseConnectionsByUser.get(userId) || 0;
    if (active <= 1) {
      liveSseConnectionsByUser.delete(userId);
      return;
    }
    liveSseConnectionsByUser.set(userId, active - 1);
  };

  app.use(
    '/api/v1/*',
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => {
        c.header('Connection', 'close');
        return c.json(
          {
            ok: false,
            error: {
              code: 'payload_too_large',
              message: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
            },
          },
          413,
        );
      },
    }),
  );

  app.use('/api/v1/*', async (c, next) => {
    maybeWarnAboutUnexpectedForwardedHeaders(c);
    await next();
  });

  app.get('/api/v1/health', async (c) => {
    const health = await healthResponse();
    return c.json(health, health.ok ? 200 : 503);
  });

  app.get('/api/v1/auth/config', async (c) => {
    return c.json(
      {
        ok: true,
        data: {
          devMode: AUTH_DEV_MODE,
        },
      },
      200,
    );
  });

  app.post('/api/v1/auth/google/start', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_start',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      let requestedReturnTo: string | undefined;
      const contentType = (c.req.header('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const body = (await c.req.json().catch(() => ({}))) as {
          returnTo?: unknown;
        };
        if (typeof body.returnTo === 'string') {
          requestedReturnTo = body.returnTo;
        }
      }

      const payload = startGoogleOAuth({
        redirectUri: resolveGoogleOAuthRedirectUri(c, opts),
        returnTo: normalizeReturnToPath(requestedReturnTo) || undefined,
      });
      return c.json({ ok: true, data: payload }, 200);
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.get('/api/v1/auth/google/callback', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_callback',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const state = c.req.query('state') || '';
      const code = c.req.query('code') || undefined;
      const email = c.req.query('email') || undefined;
      const displayName = c.req.query('name') || undefined;
      const stateHash = state ? hashOpaqueToken(state) : '';
      const linkRequest = stateHash
        ? getGoogleOAuthLinkRequest(stateHash)
        : undefined;
      const accept = (c.req.header('accept') || '').toLowerCase();

      if (linkRequest) {
        try {
          const result = await completeGoogleOAuthIdentityCallback({
            state,
            code,
            email,
            displayName,
            requestedScopes: linkRequest.scopes,
          });
          persistGoogleOAuthIdentity(linkRequest.userId, result.identity);
          deleteGoogleOAuthLinkRequest(stateHash);
          const returnTo =
            normalizeReturnToPath(result.returnTo) || '/app/talks';
          if (accept.includes('text/html')) {
            return renderGoogleAccountCallbackHtml({
              status: 'success',
              returnTo,
            });
          }
          return c.json(
            {
              ok: true,
              data: {
                linked: true,
                returnTo,
              },
            },
            200,
          );
        } catch (err) {
          deleteGoogleOAuthLinkRequest(stateHash);
          if (accept.includes('text/html')) {
            return renderGoogleAccountCallbackHtml({
              status: 'error',
              returnTo: '/app/talks',
              message:
                err instanceof Error
                  ? err.message
                  : 'Failed to connect Google account.',
            });
          }
          return authErrorResponse(c, err);
        }
      }

      const result = await completeGoogleOAuthCallback({
        state,
        code,
        email,
        displayName,
        ipAddress: getClientIp(c),
        userAgent: c.req.header('user-agent'),
      });
      setSessionCookies(c, result.session);
      if (accept.includes('text/html')) {
        c.header('cache-control', 'no-store');
        return c.redirect(
          normalizeReturnToPath(result.returnTo) || '/app/talks',
          302,
        );
      }
      return c.json(
        {
          ok: true,
          data: {
            user: normalizeUser(result.user),
            accessExpiresAt: result.session.accessExpiresAt,
            refreshExpiresAt: result.session.refreshExpiresAt,
          },
        },
        200,
      );
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.get('/api/v1/me/google-account', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = getUserGoogleAccountRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/me/google-account/connect', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ returnTo?: unknown; scopes?: unknown }>(
      bodyText,
    );
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const scopes = Array.isArray(payload.data.scopes)
      ? payload.data.scopes.filter(
          (scope): scope is string => typeof scope === 'string',
        )
      : [];

    const result = startUserGoogleAccountConnectRoute({
      auth,
      scopes,
      redirectUri: resolveGoogleOAuthRedirectUri(c, opts),
      returnTo:
        typeof payload.data.returnTo === 'string'
          ? normalizeReturnToPath(payload.data.returnTo)
          : null,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/me/google-account/expand-scopes', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ scopes?: unknown; returnTo?: unknown }>(
      bodyText,
    );
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const scopes = Array.isArray(payload.data.scopes)
      ? payload.data.scopes.filter(
          (scope): scope is string => typeof scope === 'string',
        )
      : [];
    const result = startUserGoogleScopeExpansionRoute({
      auth,
      scopes,
      redirectUri: resolveGoogleOAuthRedirectUri(c, opts),
      returnTo:
        typeof payload.data.returnTo === 'string'
          ? normalizeReturnToPath(payload.data.returnTo)
          : null,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/me/google-account/picker-token', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = await getGooglePickerSessionRoute({ auth });
    const response = new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    if (result.noStore) {
      response.headers.set('cache-control', 'no-store');
    }
    return response;
  });

  app.post('/api/v1/auth/refresh', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_sensitive',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const refreshToken =
        getCookie(c, REFRESH_TOKEN_COOKIE) ||
        c.req.header('x-refresh-token') ||
        '';
      const result = refreshSession(refreshToken);
      setSessionCookies(c, result.session);
      return c.json(
        {
          ok: true,
          data: {
            user: normalizeUser(result.user),
            accessExpiresAt: result.session.accessExpiresAt,
            refreshExpiresAt: result.session.refreshExpiresAt,
          },
        },
        200,
      );
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.post('/api/v1/auth/device/start', async (c) => {
    if (isPublicMode) return publicModeDisabledResponse(c);

    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_start',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const payload = startDeviceAuthFlow();
      return c.json({ ok: true, data: payload }, 200);
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.post('/api/v1/auth/device/complete', async (c) => {
    if (isPublicMode) return publicModeDisabledResponse(c);

    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_sensitive',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        deviceCode?: string;
        email?: string;
        displayName?: string;
      };
      const result = completeDeviceAuthFlow({
        deviceCode: body.deviceCode || '',
        email: body.email || '',
        displayName: body.displayName,
        ipAddress: getClientIp(c),
        userAgent: c.req.header('user-agent'),
      });

      return c.json(
        {
          ok: true,
          data: {
            accessToken: result.session.accessToken,
            refreshToken: result.session.refreshToken,
            expiresInSec: ACCESS_TOKEN_TTL_SEC,
            user: normalizeUser(result.user),
          },
        },
        200,
      );
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.post('/api/v1/auth/logout', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    logoutSession(auth.sessionId);
    clearSessionCookies(c);
    return c.json({ ok: true, data: { loggedOut: true } }, 200);
  });

  app.get('/api/v1/session/me', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const user = getUserById(auth.userId);
    if (!user || user.is_active !== 1) return unauthorized(c);

    return c.json({ ok: true, data: { user: normalizeUser(user) } }, 200);
  });

  app.patch('/api/v1/session/me', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_body', message: 'Invalid JSON body.' },
        },
        400,
      );
    }

    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim() : null;
    if (displayName !== null) {
      if (displayName.length === 0 || displayName.length > 200) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_display_name',
              message: 'Display name must be between 1 and 200 characters.',
            },
          },
          400,
        );
      }
      updateUserDisplayName(auth.userId, displayName);
    }

    const user = getUserById(auth.userId);
    if (!user || user.is_active !== 1) return unauthorized(c);

    return c.json({ ok: true, data: { user: normalizeUser(user) } }, 200);
  });

  app.post('/api/v1/settings/users/invite', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return c.json(
        {
          ok: false,
          error: {
            code: 'forbidden',
            message: 'Owner or admin role required',
          },
        },
        403,
      );
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      role?: 'admin' | 'member';
    };
    const email = (body.email || '').trim().toLowerCase();
    if (!email) {
      return c.json(
        {
          ok: false,
          error: { code: 'email_required', message: 'email is required' },
        },
        400,
      );
    }

    const invite = createInvite({
      inviterUserId: auth.userId,
      email,
      role: body.role === 'admin' ? 'admin' : 'member',
    });

    return c.json(
      {
        ok: true,
        data: {
          inviteId: invite.inviteId,
          email,
          role: body.role === 'admin' ? 'admin' : 'member',
          expiresAt: invite.expiresAt,
        },
      },
      200,
    );
  });

  app.get('/api/v1/status', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const payload = await statusResponse(opts.keychain);
    return c.json(payload, 200);
  });

  app.get('/api/v1/talks', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const limit = parsePositiveInt(c.req.query('limit'));
    const offset = parseNonNegativeInt(c.req.query('offset'));

    const result = listTalksRoute({
      auth,
      limit: limit ?? undefined,
      offset: offset ?? undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/sidebar', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = listTalkSidebarRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // =========================================================================
  // AI Agents page composite endpoint + Executor settings/status
  // =========================================================================

  app.get('/api/v1/agents', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await getAiAgentsRoute();
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/settings/executor', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = getExecutorSettingsRoute(auth);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/settings/executor-status', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = getExecutorStatusRoute(auth);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/settings/executor/subscription-host-status', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await getExecutorSubscriptionHostStatusRoute(auth);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // ── PUT /api/v1/settings/executor ─ save credentials + auth mode ──────

  app.put('/api/v1/settings/executor', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const body = await c.req.json();
    const result = putExecutorSettingsRoute(auth, body);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // ── PUT /api/v1/agents/default-claude ─ update default model ──────────

  app.put('/api/v1/agents/default-claude', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const body = await c.req.json();
    const result = await updateDefaultClaudeModelRoute(auth, body);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/agents/providers/:providerId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const providerId = c.req.param('providerId');
    const body = await c.req.json();
    const result = await putAiProviderCredentialRoute(auth, providerId, body);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/agents/providers/:providerId/verify', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const providerId = c.req.param('providerId');
    const result = await verifyAiProviderCredentialRoute(auth, providerId);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // ── POST /api/v1/settings/executor/verify ─ credential verification ───

  app.post('/api/v1/settings/executor/verify', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await verifyExecutorRoute(auth);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/settings/executor/subscription/import', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const body = await c.req.json();
    const result = await importExecutorSubscriptionRoute(auth, body);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // =========================================================================
  // New Architecture: Registered Agents CRUD
  // =========================================================================

  app.get('/api/v1/registered-agents', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const result = listRegisteredAgentsRoute(auth);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/registered-agents/main', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const result = getMainAgentRoute(auth);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/registered-agents/main', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const body = await c.req.json().catch(() => null);
    const result = updateMainAgentRoute(auth, body);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const result = getAgentRoute(auth, c.req.param('agentId'));
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/registered-agents', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok)
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    const bodyText = await c.req.text();
    const payload = parseJsonPayload<Record<string, unknown>>(bodyText);
    if (!payload.ok)
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    const result = createAgentRoute(auth, payload.data as any);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok)
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    const bodyText = await c.req.text();
    const payload = parseJsonPayload<Record<string, unknown>>(bodyText);
    if (!payload.ok)
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    const result = updateAgentRoute(
      auth,
      c.req.param('agentId'),
      payload.data as any,
    );
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/registered-agents/:agentId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok)
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    const result = deleteAgentRoute(auth, c.req.param('agentId'));
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/registered-agents/:agentId/fallback', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const result = getAgentFallbackRoute(auth, c.req.param('agentId'));
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/registered-agents/:agentId/fallback', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok)
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    const bodyText = await c.req.text();
    const payload = parseJsonPayload<Record<string, unknown>>(bodyText);
    if (!payload.ok)
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    const result = setAgentFallbackRoute(
      auth,
      c.req.param('agentId'),
      payload.data as any,
    );
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/registered-agents/:agentId/effective-tools', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const result = getEffectiveToolsRoute(auth, c.req.param('agentId'));
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // =========================================================================
  // New Architecture: User Tool Permissions
  // =========================================================================

  app.get('/api/v1/user/tool-permissions', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const result = listUserToolPermissionsRoute(auth);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/user/tool-permissions', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok)
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    const bodyText = await c.req.text();
    const payload = parseJsonPayload<Record<string, unknown>>(bodyText);
    if (!payload.ok)
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    const result = updateUserToolPermissionRoute(auth, payload.data as any);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // =========================================================================
  // New Architecture: Main Agent Channel
  // =========================================================================

  app.get('/api/v1/main/threads', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const result = listMainThreadsRoute(auth);
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/main/threads/:threadId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const result = getMainThreadRoute(auth, c.req.param('threadId'));
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/main/threads/:threadId/runs', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    const result = listMainRunsRoute(auth, c.req.param('threadId'));
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/main/threads/:threadId/messages/delete', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<Record<string, unknown>>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = deleteMainMessagesRoute(
      auth,
      c.req.param('threadId'),
      payload.data,
    );
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/main/threads/:threadId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<Record<string, unknown>>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = patchMainThreadRoute(
      auth,
      c.req.param('threadId'),
      payload.data,
    );
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/main/threads/:threadId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = deleteMainThreadRoute(auth, c.req.param('threadId'));
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/main/messages', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok)
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: { code: 'idempotency_error', message: precheck.error },
        },
        400,
      );
    }
    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }

    const payload = parseJsonPayload<Record<string, unknown>>(bodyText);
    if (!payload.ok)
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );

    const result = postMainMessageRoute(auth, payload.data as any);
    if (result.statusCode === 202 && result.body.ok) {
      opts.mainRunWorker.wake();
    }

    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/main/runs/:runId/visible', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    const payload = parseJsonPayload<{ firstVisibleAt?: unknown }>(
      await c.req.text(),
    );
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = postMainRunVisibleRoute(
      auth,
      c.req.param('runId'),
      payload.data,
    );
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/main/runs/:runId/cancel', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: { code: 'idempotency_error', message: precheck.error },
        },
        400,
      );
    }
    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }

    const result = cancelMainRunRoute(auth, c.req.param('runId'));
    if (result.statusCode === 200 && result.body.ok) {
      if (result.cancelledRunning) {
        opts.mainRunWorker.cancelRun(result.body.data.runId);
      }
      opts.mainRunWorker.wake();
    }

    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // Browser profile management routes
  app.get('/api/v1/browser/profiles', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = listBrowserProfilesRoute({ auth });
    return c.json(result.body, result.statusCode as 200);
  });

  app.get('/api/v1/browser/discovery/chrome-user-data', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = discoverChromeUserDataDirectoriesRoute({ auth });
    return c.json(result.body, result.statusCode as 200);
  });

  app.get('/api/v1/browser/discovery/chrome-profiles', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = discoverChromeSubprofilesRoute({
      auth,
      userDataDir: c.req.query('userDataDir'),
    });
    return c.json(result.body, result.statusCode as 200);
  });

  app.post('/api/v1/browser/profiles', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }
    const payload = parseJsonPayload<Record<string, unknown>>(
      await c.req.text(),
    );
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    const result = createBrowserProfileRoute({
      auth,
      siteKey: payload.data.siteKey,
      accountLabel: payload.data.accountLabel,
      connectionMode: payload.data.connectionMode,
      connectionConfig: payload.data.connectionConfig,
    });
    return c.json(result.body, result.statusCode as 200);
  });

  app.patch('/api/v1/browser/profiles/:profileId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }
    const payload = parseJsonPayload<Record<string, unknown>>(
      await c.req.text(),
    );
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    const result = updateBrowserProfileConnectionModeRoute({
      auth,
      profileId: c.req.param('profileId'),
      connectionMode: payload.data.connectionMode,
      connectionConfig: payload.data.connectionConfig,
    });
    return c.json(result.body, result.statusCode as 200);
  });

  app.delete('/api/v1/browser/profiles/:profileId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }
    const result = deleteBrowserProfileRoute({
      auth,
      profileId: c.req.param('profileId'),
    });
    return c.json(result.body, result.statusCode as 200);
  });

  app.post(
    '/api/v1/browser/profiles/:profileId/release-sessions',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const rateResult = checkRateLimit({
        principalId: auth.userId,
        bucket: 'write',
      });
      if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
      const csrf = validateCsrfToken({
        method: c.req.method,
        authType: auth.authType,
        cookieHeader: c.req.header('cookie'),
        csrfHeader: c.req.header('x-csrf-token'),
      });
      if (!csrf.ok) {
        return c.json(
          { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
          403,
        );
      }
      const result = await releaseBrowserProfileSessionsRoute({
        auth,
        profileId: c.req.param('profileId'),
      });
      return c.json(result.body, result.statusCode as 200);
    },
  );

  app.post('/api/v1/browser/setup', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const payload = parseJsonPayload<Record<string, unknown>>(
      await c.req.text(),
    );
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = await startBrowserSetupSessionRoute({
      auth,
      siteKey: payload.data.siteKey,
      accountLabel: payload.data.accountLabel,
      url: payload.data.url,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/browser/sessions/:sessionId/takeover', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = await startBrowserTakeoverRoute({
      auth,
      sessionId: c.req.param('sessionId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/browser/sessions/:sessionId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = await getBrowserSessionStatusRoute({
      auth,
      sessionId: c.req.param('sessionId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/browser/sessions/:sessionId/resume', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = await resumeBrowserSessionRoute({
      auth,
      sessionId: c.req.param('sessionId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/browser/runs/:runId/resume', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const payload = parseJsonPayload<{ note?: unknown }>(await c.req.text());
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = await resumeBrowserBlockedRunRoute({
      auth,
      runId: c.req.param('runId'),
      note: typeof payload.data.note === 'string' ? payload.data.note : null,
    });
    if (result.wakeTalk) opts.runWorker.wake();
    if (result.wakeMain) opts.mainRunWorker.wake();
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/browser/runs/:runId/cancel-conflict', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = await cancelConflictingBrowserRunRoute({
      auth,
      runId: c.req.param('runId'),
    });
    if (result.wakeTalk) opts.runWorker.wake();
    if (result.wakeMain) opts.mainRunWorker.wake();
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post(
    '/api/v1/browser/confirmations/:confirmationId/approve',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const rateResult = checkRateLimit({
        principalId: auth.userId,
        bucket: 'write',
      });
      if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
      const csrf = validateCsrfToken({
        method: c.req.method,
        authType: auth.authType,
        cookieHeader: c.req.header('cookie'),
        csrfHeader: c.req.header('x-csrf-token'),
      });
      if (!csrf.ok) {
        return c.json(
          { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
          403,
        );
      }

      const payload = parseJsonPayload<{ note?: unknown }>(await c.req.text());
      if (!payload.ok) {
        return c.json(
          {
            ok: false,
            error: { code: 'invalid_json', message: payload.error },
          },
          400,
        );
      }

      const result = await approveBrowserConfirmationRoute({
        auth,
        confirmationId: c.req.param('confirmationId'),
        note: typeof payload.data.note === 'string' ? payload.data.note : null,
      });
      if (result.wakeTalk) opts.runWorker.wake();
      if (result.wakeMain) opts.mainRunWorker.wake();
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.post(
    '/api/v1/browser/confirmations/:confirmationId/reject',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const rateResult = checkRateLimit({
        principalId: auth.userId,
        bucket: 'write',
      });
      if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);
      const csrf = validateCsrfToken({
        method: c.req.method,
        authType: auth.authType,
        cookieHeader: c.req.header('cookie'),
        csrfHeader: c.req.header('x-csrf-token'),
      });
      if (!csrf.ok) {
        return c.json(
          { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
          403,
        );
      }

      const payload = parseJsonPayload<{ note?: unknown }>(await c.req.text());
      if (!payload.ok) {
        return c.json(
          {
            ok: false,
            error: { code: 'invalid_json', message: payload.error },
          },
          400,
        );
      }

      const result = await rejectBrowserConfirmationRoute({
        auth,
        confirmationId: c.req.param('confirmationId'),
        note: typeof payload.data.note === 'string' ? payload.data.note : null,
      });
      if (result.wakeTalk) opts.runWorker.wake();
      if (result.wakeMain) opts.mainRunWorker.wake();
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.get('/api/v1/data-connectors', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = listDataConnectorsRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/data-connectors', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      name?: string;
      connectorKind?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = createDataConnectorRoute({
      auth,
      name: typeof payload.data.name === 'string' ? payload.data.name : '',
      connectorKind:
        typeof payload.data.connectorKind === 'string'
          ? payload.data.connectorKind
          : '',
      config:
        payload.data.config && typeof payload.data.config === 'object'
          ? payload.data.config
          : undefined,
      enabled:
        typeof payload.data.enabled === 'boolean'
          ? payload.data.enabled
          : undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/data-connectors/:connectorId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      name?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = await patchDataConnectorRoute({
      auth,
      connectorId: c.req.param('connectorId'),
      name:
        typeof payload.data.name === 'string' ? payload.data.name : undefined,
      config:
        payload.data.config !== undefined &&
        payload.data.config &&
        typeof payload.data.config === 'object'
          ? payload.data.config
          : payload.data.config === null
            ? {}
            : undefined,
      enabled:
        typeof payload.data.enabled === 'boolean'
          ? payload.data.enabled
          : undefined,
      verifier: opts.dataConnectorVerifier,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/data-connectors/:connectorId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = deleteDataConnectorRoute({
      auth,
      connectorId: c.req.param('connectorId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/data-connectors/:connectorId/credential', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      apiKey?: string | null;
      useGoogleAccount?: unknown;
      clearCredential?: unknown;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = await setDataConnectorCredentialRoute({
      auth,
      connectorId: c.req.param('connectorId'),
      apiKey:
        typeof payload.data.apiKey === 'string' || payload.data.apiKey === null
          ? payload.data.apiKey
          : undefined,
      useGoogleAccount:
        typeof payload.data.useGoogleAccount === 'boolean'
          ? payload.data.useGoogleAccount
          : undefined,
      clearCredential:
        typeof payload.data.clearCredential === 'boolean'
          ? payload.data.clearCredential
          : undefined,
      verifier: opts.dataConnectorVerifier,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'idempotency_error',
            message: precheck.error,
          },
        },
        400,
      );
    }

    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }

    const payload = parseJsonPayload<{ title?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = createTalkRoute({
      auth,
      title: payload.data.title,
    });

    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talk-folders', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ title?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = createTalkFolderRoute({
      auth,
      title: payload.data.title,
    });

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = getTalkRoute({
      talkId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/talks/:id', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const encodedTalkId = c.req.param('id');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      title?: string;
      folderId?: string | null;
      orchestrationMode?: 'ordered' | 'panel';
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = patchTalkRoute({
      talkId,
      auth,
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
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/project-mount', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = getTalkProjectMountRoute({ auth, talkId });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/talks/:talkId/project-mount', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ projectPath?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

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

    const result = updateTalkProjectMountRoute({
      auth,
      talkId,
      projectPath: payload.data.projectPath,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/project-mount', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = clearTalkProjectMountRoute({ auth, talkId });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:id', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const encodedTalkId = c.req.param('id');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = deleteTalkRoute({
      talkId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/talk-folders/:id', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const encodedFolderId = c.req.param('id');
    const folderId = safeDecodePathSegment(encodedFolderId);
    if (!folderId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_folder_id',
            message: 'Folder ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ title?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = patchTalkFolderRoute({
      folderId,
      auth,
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talk-folders/:id', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const encodedFolderId = c.req.param('id');
    const folderId = safeDecodePathSegment(encodedFolderId);
    if (!folderId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_folder_id',
            message: 'Folder ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = deleteTalkFolderRoute({
      folderId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/sidebar/reorder', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      itemType?: 'talk' | 'folder';
      itemId?: string;
      destinationFolderId?: string | null;
      destinationIndex?: number;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

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

    const result = reorderTalkSidebarRoute({
      auth,
      itemType: payload.data.itemType,
      itemId: payload.data.itemId,
      destinationFolderId: payload.data.destinationFolderId,
      destinationIndex: payload.data.destinationIndex,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/messages', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const limit = parsePositiveInt(c.req.query('limit'));
    const beforeCreatedAt = c.req.query('before') || undefined;
    const threadId = (c.req.query('threadId') || '').trim() || undefined;
    const result = listTalkMessagesRoute({
      talkId,
      auth,
      threadId,
      limit: limit ?? undefined,
      beforeCreatedAt,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/messages/delete', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      messageIds?: unknown;
      threadId?: unknown;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const messageIds = Array.isArray(payload.data.messageIds)
      ? payload.data.messageIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const threadId =
      typeof payload.data.threadId === 'string' ? payload.data.threadId : null;
    const result = deleteTalkMessagesRoute({
      talkId: c.req.param('talkId'),
      auth,
      messageIds,
      threadId,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/messages/search', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const query = c.req.query('q') || '';
    const limit = parsePositiveInt(c.req.query('limit'));
    const result = searchTalkMessagesRoute({
      talkId,
      auth,
      query,
      limit: limit ?? undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  // ---------------------------------------------------------------------------
  // Talk threads
  // ---------------------------------------------------------------------------

  app.get('/api/v1/talks/:talkId/threads', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_talk_id', message: 'Invalid Talk ID' },
        },
        400,
      );
    }

    try {
      const talk = getTalkForUser(talkId, auth.userId);
      if (!talk) {
        return c.json(
          {
            ok: false,
            error: { code: 'talk_not_found', message: 'Talk not found' },
          },
          404,
        );
      }
      const threads = listTalkThreads(talkId);
      return c.json({ ok: true, data: { threads } });
    } catch (err) {
      return c.json(
        { ok: false, error: { code: 'internal_error', message: String(err) } },
        500,
      );
    }
  });

  app.post('/api/v1/talks/:talkId/threads', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_talk_id', message: 'Invalid Talk ID' },
        },
        400,
      );
    }

    try {
      const { getTalkForUser, createTalkThread } =
        await import('../db/accessors.js');
      const talk = getTalkForUser(talkId, auth.userId);
      if (!talk) {
        return c.json(
          {
            ok: false,
            error: { code: 'talk_not_found', message: 'Talk not found' },
          },
          404,
        );
      }
      if (!canEditTalk(talkId, auth.userId, auth.role)) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'forbidden',
              message:
                'You do not have permission to create threads for this talk',
            },
          },
          403,
        );
      }
      const body = await c.req.json().catch(() => ({}));
      const title =
        typeof body.title === 'string' ? body.title.trim() || null : null;
      const thread = createTalkThread({ talkId, title });
      return c.json({ ok: true, data: { thread } }, 201);
    } catch (err) {
      return c.json(
        { ok: false, error: { code: 'internal_error', message: String(err) } },
        500,
      );
    }
  });

  app.patch('/api/v1/talks/:talkId/threads/:threadId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    const threadId = safeDecodePathSegment(c.req.param('threadId'));
    if (!talkId || !threadId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Invalid Talk or thread ID',
          },
        },
        400,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ title?: unknown; pinned?: unknown }>(
      bodyText,
    );
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    const result = patchTalkThreadRoute({
      auth,
      talkId,
      threadId,
      body: payload.data,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/threads/:threadId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    const threadId = safeDecodePathSegment(c.req.param('threadId'));
    if (!talkId || !threadId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Invalid Talk or thread ID',
          },
        },
        400,
      );
    }

    const result = deleteTalkThreadRoute({
      auth,
      talkId,
      threadId,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/agents', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = listTalkAgentsRoute({
      talkId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/channel-connections', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = listChannelConnectionsRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/channel-connectors/telegram', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = getTelegramChannelConnectorRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/channel-connectors/telegram/validate', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = await validateTelegramChannelConnectorRoute({
      auth,
      botToken: typeof body.botToken === 'string' ? body.botToken : '',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/channel-connectors/telegram/token', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = await saveTelegramChannelConnectorTokenRoute({
      auth,
      botToken: typeof body.botToken === 'string' ? body.botToken : '',
      reloadConnector: () =>
        opts.reloadChannelConnection?.(
          ensureSystemManagedTelegramConnection().id,
        ) || Promise.resolve(),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/channel-connectors/telegram/token', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = await deleteTelegramChannelConnectorTokenRoute({
      auth,
      reloadConnector: () =>
        opts.reloadChannelConnection?.(
          ensureSystemManagedTelegramConnection().id,
        ) || Promise.resolve(),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/channel-connectors/telegram/adopt-env', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = await adoptTelegramEnvTokenRoute({
      auth,
      reloadConnector: () =>
        opts.reloadChannelConnection?.(
          ensureSystemManagedTelegramConnection().id,
        ) || Promise.resolve(),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/channel-connectors/telegram/targets/approve', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = await approveTelegramTargetRoute({
      auth,
      rawInput: typeof body.rawInput === 'string' ? body.rawInput : undefined,
      targetKind:
        typeof body.targetKind === 'string' ? body.targetKind : undefined,
      targetId: typeof body.targetId === 'string' ? body.targetId : undefined,
      displayName:
        typeof body.displayName === 'string' ? body.displayName : undefined,
      reloadConnector: () =>
        opts.reloadChannelConnection?.(
          ensureSystemManagedTelegramConnection().id,
        ) || Promise.resolve(),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete(
    '/api/v1/channel-connectors/telegram/targets/:targetKind/:targetId/approval',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const targetKind = safeDecodePathSegment(c.req.param('targetKind'));
      const targetId = safeDecodePathSegment(c.req.param('targetId'));
      if (!targetKind || !targetId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'Target path segments are not valid URL encoding',
            },
          },
          400,
        );
      }

      const result = unapproveTelegramTargetRoute({
        auth,
        targetKind,
        targetId,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.get('/api/v1/channel-connectors/slack', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = getSlackChannelConnectorRoute({
      auth,
      requestOrigin: resolveRequestOrigin(c),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/channel-connectors/slack/config', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = saveSlackProviderConfigRoute({
      auth,
      requestOrigin: resolveRequestOrigin(c),
      clientId: typeof body.clientId === 'string' ? body.clientId : '',
      clientSecret:
        typeof body.clientSecret === 'string' ? body.clientSecret : null,
      signingSecret:
        typeof body.signingSecret === 'string' ? body.signingSecret : null,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/channel-connectors/slack/config', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = clearSlackProviderConfigRoute({
      auth,
      requestOrigin: resolveRequestOrigin(c),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/channel-connectors/slack/oauth/start', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = await startSlackOAuthInstallRoute({
      auth,
      requestOrigin: resolveRequestOrigin(c),
      returnTo:
        typeof body.returnTo === 'string'
          ? normalizeReturnToPath(body.returnTo)
          : null,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/channel-connectors/slack/oauth/callback', async (c) => {
    const auth = requireAuth(c);
    if (!auth) {
      return renderSlackOAuthCallbackHtml({
        status: 'error',
        message: 'You must be signed in to finish Slack installation.',
        returnTo: '/app/connectors?tab=channel-connectors',
      });
    }

    const result = await completeSlackOAuthInstallRoute({
      auth,
      requestOrigin: resolveRequestOrigin(c),
      state: c.req.query('state') || '',
      code: c.req.query('code') || '',
      reloadConnection: opts.reloadChannelConnection,
    });

    if (result.statusCode >= 400 || !result.body.ok) {
      const message = result.body.ok
        ? 'Slack installation failed.'
        : result.body.error?.message || 'Slack installation failed.';
      return renderSlackOAuthCallbackHtml({
        status: 'error',
        message,
        returnTo: '/app/connectors?tab=channel-connectors',
      });
    }

    const workspace = result.body.data?.workspace;
    return renderSlackOAuthCallbackHtml({
      status: 'success',
      message: 'Slack workspace connected.',
      returnTo: '/app/connectors?tab=channel-connectors',
      workspaceName: workspace?.teamName || undefined,
    });
  });

  app.post('/api/v1/channel-connectors/slack/events', async (c) => {
    const rawBody = await c.req.text();
    const result = await handleSlackEventsRoute({
      rawBody,
      timestampHeader: c.req.header('x-slack-request-timestamp') || null,
      signatureHeader: c.req.header('x-slack-signature') || null,
      enqueueEvent: (connectionId, event) => {
        queueMicrotask(() => {
          void opts.handleSlackEvent?.(connectionId, event);
        });
      },
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post(
    '/api/v1/channel-connectors/slack/workspaces/:connectionId/sync',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const connectionId = safeDecodePathSegment(c.req.param('connectionId'));
      if (!connectionId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_connection_id',
              message:
                'Channel connection path segment is not valid URL encoding',
            },
          },
          400,
        );
      }

      const result = await syncSlackWorkspaceRoute({
        auth,
        connectionId,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.delete(
    '/api/v1/channel-connectors/slack/workspaces/:connectionId',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const connectionId = safeDecodePathSegment(c.req.param('connectionId'));
      if (!connectionId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_connection_id',
              message:
                'Channel connection path segment is not valid URL encoding',
            },
          },
          400,
        );
      }

      const result = await disconnectSlackWorkspaceRoute({
        auth,
        connectionId,
        disconnectConnection: opts.disconnectChannelConnection,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.post(
    '/api/v1/channel-connectors/slack/workspaces/:connectionId/diagnose-target',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const connectionId = safeDecodePathSegment(c.req.param('connectionId'));
      if (!connectionId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_connection_id',
              message:
                'Channel connection path segment is not valid URL encoding',
            },
          },
          400,
        );
      }

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const result = await diagnoseSlackWorkspaceTargetRoute({
        auth,
        connectionId,
        rawInput: typeof body.rawInput === 'string' ? body.rawInput : '',
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.get('/api/v1/channel-connections/:connectionId/targets', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedConnectionId = c.req.param('connectionId');
    const connectionId = safeDecodePathSegment(encodedConnectionId);
    if (!connectionId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_connection_id',
            message: 'Connection ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const query = c.req.query('query');
    const rawLimit = c.req.query('limit');
    const rawOffset = c.req.query('offset');
    const approval = c.req.query('approval');
    const parsedLimit =
      rawLimit && rawLimit.trim()
        ? Number.parseInt(rawLimit.trim(), 10)
        : undefined;
    const parsedOffset =
      rawOffset && rawOffset.trim()
        ? Number.parseInt(rawOffset.trim(), 10)
        : undefined;

    const result = listChannelTargetsRoute({
      auth,
      connectionId,
      query,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
      approval:
        approval === 'approved' || approval === 'discovered' ? approval : 'all',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post(
    '/api/v1/channel-connections/:connectionId/targets/approve',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const connectionId = safeDecodePathSegment(c.req.param('connectionId'));
      if (!connectionId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_connection_id',
              message:
                'Channel connection path segment is not valid URL encoding',
            },
          },
          400,
        );
      }

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const metadata =
        body.metadata &&
        typeof body.metadata === 'object' &&
        !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : null;
      const result = approveChannelTargetRoute({
        auth,
        connectionId,
        targetKind: typeof body.targetKind === 'string' ? body.targetKind : '',
        targetId: typeof body.targetId === 'string' ? body.targetId : '',
        displayName:
          typeof body.displayName === 'string' ? body.displayName : undefined,
        metadata,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.delete(
    '/api/v1/channel-connections/:connectionId/targets/:targetKind/:targetId/approval',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const connectionId = safeDecodePathSegment(c.req.param('connectionId'));
      const targetKind = safeDecodePathSegment(c.req.param('targetKind'));
      const targetId = safeDecodePathSegment(c.req.param('targetId'));
      if (!connectionId || !targetKind || !targetId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'Target path segments are not valid URL encoding',
            },
          },
          400,
        );
      }

      const result = unapproveChannelTargetRoute({
        auth,
        connectionId,
        targetKind,
        targetId,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.get('/api/v1/talks/:talkId/channels', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const result = listTalkChannelsRoute({ auth, talkId });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/channels', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = createTalkChannelRoute({
      auth,
      talkId,
      connectionId: String(body.connectionId || ''),
      targetKind: String(body.targetKind || 'chat'),
      targetId: String(body.targetId || ''),
      displayName: String(body.displayName || body.targetId || ''),
      responseMode:
        body.responseMode === 'off' ||
        body.responseMode === 'mentions' ||
        body.responseMode === 'all'
          ? body.responseMode
          : undefined,
      responderMode:
        body.responderMode === 'primary' || body.responderMode === 'agent'
          ? body.responderMode
          : undefined,
      responderAgentId:
        typeof body.responderAgentId === 'string'
          ? body.responderAgentId
          : null,
      deliveryMode:
        body.deliveryMode === 'reply' || body.deliveryMode === 'channel'
          ? body.deliveryMode
          : undefined,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      instructions:
        typeof body.instructions === 'string' ? body.instructions : null,
      inboundRateLimitPerMinute:
        typeof body.inboundRateLimitPerMinute === 'number'
          ? body.inboundRateLimitPerMinute
          : undefined,
      maxPendingEvents:
        typeof body.maxPendingEvents === 'number'
          ? body.maxPendingEvents
          : undefined,
      overflowPolicy:
        body.overflowPolicy === 'drop_oldest' ||
        body.overflowPolicy === 'drop_newest'
          ? body.overflowPolicy
          : undefined,
      maxDeferredAgeMinutes:
        typeof body.maxDeferredAgeMinutes === 'number'
          ? body.maxDeferredAgeMinutes
          : undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/talks/:talkId/channels/:bindingId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = patchTalkChannelRoute({
      auth,
      talkId,
      bindingId: c.req.param('bindingId'),
      active: typeof body.active === 'boolean' ? body.active : undefined,
      displayName:
        typeof body.displayName === 'string' ? body.displayName : undefined,
      responseMode:
        body.responseMode === 'off' ||
        body.responseMode === 'mentions' ||
        body.responseMode === 'all'
          ? body.responseMode
          : undefined,
      responderMode:
        body.responderMode === 'primary' || body.responderMode === 'agent'
          ? body.responderMode
          : undefined,
      responderAgentId:
        typeof body.responderAgentId === 'string'
          ? body.responderAgentId
          : undefined,
      deliveryMode:
        body.deliveryMode === 'reply' || body.deliveryMode === 'channel'
          ? body.deliveryMode
          : undefined,
      timezone:
        typeof body.timezone === 'string'
          ? body.timezone
          : body.timezone === null
            ? null
            : undefined,
      instructions:
        typeof body.instructions === 'string'
          ? body.instructions
          : body.instructions === null
            ? null
            : undefined,
      inboundRateLimitPerMinute:
        typeof body.inboundRateLimitPerMinute === 'number'
          ? body.inboundRateLimitPerMinute
          : undefined,
      maxPendingEvents:
        typeof body.maxPendingEvents === 'number'
          ? body.maxPendingEvents
          : undefined,
      overflowPolicy:
        body.overflowPolicy === 'drop_oldest' ||
        body.overflowPolicy === 'drop_newest'
          ? body.overflowPolicy
          : undefined,
      maxDeferredAgeMinutes:
        typeof body.maxDeferredAgeMinutes === 'number'
          ? body.maxDeferredAgeMinutes
          : undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/channels/:bindingId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const result = deleteTalkChannelRoute({
      auth,
      talkId,
      bindingId: c.req.param('bindingId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/channels/:bindingId/state', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const result = listTalkChannelBindingStateRoute({
      auth,
      talkId,
      bindingId: c.req.param('bindingId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/channels/:bindingId/state', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = upsertTalkChannelBindingStateRoute({
      auth,
      talkId,
      bindingId: c.req.param('bindingId'),
      keySuffix: typeof body.keySuffix === 'string' ? body.keySuffix : '',
      value: body.value,
      expectedVersion:
        typeof body.expectedVersion === 'number'
          ? body.expectedVersion
          : Number.NaN,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/channels/:bindingId/state', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = deleteTalkChannelBindingStateRoute({
      auth,
      talkId,
      bindingId: c.req.param('bindingId'),
      keySuffix: typeof body.keySuffix === 'string' ? body.keySuffix : '',
      expectedVersion:
        typeof body.expectedVersion === 'number'
          ? body.expectedVersion
          : Number.NaN,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/channel-instruction-review', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = await reviewTalkChannelInstructionsRoute({
      auth,
      talkId,
      platform: body.platform === 'telegram' ? 'telegram' : 'slack',
      instructions:
        typeof body.instructions === 'string' ? body.instructions : '',
      bindingId:
        typeof body.bindingId === 'string' ? body.bindingId : undefined,
      bindingLabel:
        typeof body.bindingLabel === 'string' ? body.bindingLabel : undefined,
      timezone:
        typeof body.timezone === 'string'
          ? body.timezone
          : body.timezone === null
            ? null
            : undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/channels/:bindingId/test', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }
    const result = await testTalkChannelBindingRoute({
      auth,
      talkId,
      bindingId: c.req.param('bindingId'),
      sendTestMessage: opts.sendChannelTestMessage,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post(
    '/api/v1/talks/:talkId/channels/:bindingId/unquarantine',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const talkId = safeDecodePathSegment(c.req.param('talkId'));
      if (!talkId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_talk_id',
              message: 'Talk ID path segment is not valid URL encoding',
            },
          },
          400,
        );
      }
      const result = await unquarantineTalkChannelBindingRoute({
        auth,
        talkId,
        bindingId: c.req.param('bindingId'),
        sendTestMessage: opts.sendChannelTestMessage,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.post(
    '/api/v1/talks/:talkId/channels/:bindingId/retry-failures',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const talkId = safeDecodePathSegment(c.req.param('talkId'));
      if (!talkId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_talk_id',
              message: 'Talk ID path segment is not valid URL encoding',
            },
          },
          400,
        );
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const rawMaxAge = Number(body.maxAgeMins);
      const rawMaxCount = Number(body.maxCount);
      const maxAgeMins =
        Number.isFinite(rawMaxAge) && rawMaxAge > 0 ? rawMaxAge : undefined;
      const maxCount =
        Number.isFinite(rawMaxCount) && rawMaxCount > 0
          ? rawMaxCount
          : undefined;
      const result = retryTalkChannelDeliveryFailuresCappedRoute({
        auth,
        talkId,
        bindingId: c.req.param('bindingId'),
        maxAgeMins,
        maxCount,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.get(
    '/api/v1/talks/:talkId/channels/:bindingId/ingress-failures',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const talkId = safeDecodePathSegment(c.req.param('talkId'));
      if (!talkId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_talk_id',
              message: 'Talk ID path segment is not valid URL encoding',
            },
          },
          400,
        );
      }
      const result = listTalkChannelIngressFailuresRoute({
        auth,
        talkId,
        bindingId: c.req.param('bindingId'),
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.post(
    '/api/v1/talks/:talkId/channels/:bindingId/ingress-failures/:rowId/retry',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const talkId = safeDecodePathSegment(c.req.param('talkId'));
      if (!talkId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_talk_id',
              message: 'Talk ID path segment is not valid URL encoding',
            },
          },
          400,
        );
      }
      const result = retryTalkChannelIngressFailureRoute({
        auth,
        talkId,
        bindingId: c.req.param('bindingId'),
        rowId: c.req.param('rowId'),
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.delete(
    '/api/v1/talks/:talkId/channels/:bindingId/ingress-failures/:rowId',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const talkId = safeDecodePathSegment(c.req.param('talkId'));
      if (!talkId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_talk_id',
              message: 'Talk ID path segment is not valid URL encoding',
            },
          },
          400,
        );
      }
      const result = deleteTalkChannelIngressFailureRoute({
        auth,
        talkId,
        bindingId: c.req.param('bindingId'),
        rowId: c.req.param('rowId'),
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.get(
    '/api/v1/talks/:talkId/channels/:bindingId/delivery-failures',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const talkId = safeDecodePathSegment(c.req.param('talkId'));
      if (!talkId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_talk_id',
              message: 'Talk ID path segment is not valid URL encoding',
            },
          },
          400,
        );
      }
      const result = listTalkChannelDeliveryFailuresRoute({
        auth,
        talkId,
        bindingId: c.req.param('bindingId'),
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.post(
    '/api/v1/talks/:talkId/channels/:bindingId/delivery-failures/:rowId/retry',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const talkId = safeDecodePathSegment(c.req.param('talkId'));
      if (!talkId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_talk_id',
              message: 'Talk ID path segment is not valid URL encoding',
            },
          },
          400,
        );
      }
      const result = retryTalkChannelDeliveryFailureRoute({
        auth,
        talkId,
        bindingId: c.req.param('bindingId'),
        rowId: c.req.param('rowId'),
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.delete(
    '/api/v1/talks/:talkId/channels/:bindingId/delivery-failures/:rowId',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);
      const talkId = safeDecodePathSegment(c.req.param('talkId'));
      if (!talkId) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_talk_id',
              message: 'Talk ID path segment is not valid URL encoding',
            },
          },
          400,
        );
      }
      const result = deleteTalkChannelDeliveryFailureRoute({
        auth,
        talkId,
        bindingId: c.req.param('bindingId'),
        rowId: c.req.param('rowId'),
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.get('/api/v1/talks/:talkId/tools', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = getTalkToolsRoute({ auth, talkId });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/talks/:talkId/tools/grants', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      grants?: Array<{ toolId?: unknown; enabled?: unknown }>;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const grants = Array.isArray(payload.data.grants)
      ? payload.data.grants
          .filter(
            (grant): grant is { toolId: string; enabled: boolean } =>
              typeof grant?.toolId === 'string' &&
              typeof grant?.enabled === 'boolean',
          )
          .map((grant) => ({
            toolId: grant.toolId,
            enabled: grant.enabled,
          }))
      : [];

    const result = updateTalkToolGrantsRoute({
      auth,
      talkId,
      grants,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/resources', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = listTalkResourcesRoute({ auth, talkId });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/resources', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      kind?: unknown;
      externalId?: unknown;
      displayName?: unknown;
      metadata?: unknown;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = createTalkResourceRoute({
      auth,
      talkId,
      kind:
        typeof payload.data.kind === 'string'
          ? (payload.data.kind as
              | 'google_drive_folder'
              | 'google_drive_file'
              | 'data_connector'
              | 'saved_source'
              | 'message_attachment')
          : ('saved_source' as const),
      externalId:
        typeof payload.data.externalId === 'string'
          ? payload.data.externalId
          : '',
      displayName:
        typeof payload.data.displayName === 'string'
          ? payload.data.displayName
          : '',
      metadata:
        payload.data.metadata &&
        typeof payload.data.metadata === 'object' &&
        !Array.isArray(payload.data.metadata)
          ? (payload.data.metadata as Record<string, unknown>)
          : null,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/resources/:resourceId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const talkId = safeDecodePathSegment(c.req.param('talkId'));
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = deleteTalkResourceRoute({
      auth,
      talkId,
      resourceId: c.req.param('resourceId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/data-connectors', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = listTalkDataConnectorsRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/data-connectors', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      connectorId?: string;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = attachTalkDataConnectorRoute({
      auth,
      talkId: c.req.param('talkId'),
      connectorId:
        typeof payload.data.connectorId === 'string'
          ? payload.data.connectorId
          : '',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete(
    '/api/v1/talks/:talkId/data-connectors/:connectorId',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const rateResult = checkRateLimit({
        principalId: auth.userId,
        bucket: 'write',
      });
      if (!rateResult.allowed) {
        return rateLimitedResponse(c, rateResult);
      }

      const csrf = validateCsrfToken({
        method: c.req.method,
        authType: auth.authType,
        cookieHeader: c.req.header('cookie'),
        csrfHeader: c.req.header('x-csrf-token'),
      });
      if (!csrf.ok) {
        return c.json(
          { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
          403,
        );
      }

      const result = detachTalkDataConnectorRoute({
        auth,
        talkId: c.req.param('talkId'),
        connectorId: c.req.param('connectorId'),
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Context tab routes
  // ---------------------------------------------------------------------------

  app.get('/api/v1/talks/:talkId/context', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = getTalkContextRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/talks/:talkId/context/goal', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ goalText?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = setTalkGoalRoute({
      auth,
      talkId: c.req.param('talkId'),
      goalText:
        typeof payload.data.goalText === 'string' ? payload.data.goalText : '',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/context/rules', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = listTalkContextRulesRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/state', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = getTalkStateRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/state/:key', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = deleteTalkStateEntryRoute({
      auth,
      talkId: c.req.param('talkId'),
      key: c.req.param('key'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/outputs', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = listTalkOutputsRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/outputs/:outputId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = getTalkOutputRoute({
      auth,
      talkId: c.req.param('talkId'),
      outputId: c.req.param('outputId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/outputs', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      title?: string;
      contentMarkdown?: string;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = createTalkOutputRoute({
      auth,
      talkId: c.req.param('talkId'),
      title: typeof payload.data.title === 'string' ? payload.data.title : '',
      contentMarkdown:
        typeof payload.data.contentMarkdown === 'string'
          ? payload.data.contentMarkdown
          : '',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/talks/:talkId/outputs/:outputId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      expectedVersion?: number;
      title?: string;
      contentMarkdown?: string;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = patchTalkOutputRoute({
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
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/outputs/:outputId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = deleteTalkOutputRoute({
      auth,
      talkId: c.req.param('talkId'),
      outputId: c.req.param('outputId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/jobs', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = listTalkJobsRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/jobs/:jobId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = getTalkJobRoute({
      auth,
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/jobs/:jobId/runs', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rawLimit = c.req.query('limit');
    const parsedLimit =
      rawLimit && /^\d+$/.test(rawLimit) ? parseInt(rawLimit, 10) : undefined;
    const result = listTalkJobRunsRoute({
      auth,
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
      limit: parsedLimit,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/jobs', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      title?: string;
      prompt?: string;
      targetAgentId?: string;
      schedule?: Record<string, unknown>;
      timezone?: string;
      deliverableKind?: 'thread' | 'report';
      reportOutputId?: string | null;
      createReport?: Record<string, unknown>;
      sourceScope?: Record<string, unknown>;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = createTalkJobRoute({
      auth,
      talkId: c.req.param('talkId'),
      title: typeof payload.data.title === 'string' ? payload.data.title : '',
      prompt:
        typeof payload.data.prompt === 'string' ? payload.data.prompt : '',
      targetAgentId:
        typeof payload.data.targetAgentId === 'string'
          ? payload.data.targetAgentId
          : '',
      schedule: (payload.data.schedule ?? null) as any,
      timezone:
        typeof payload.data.timezone === 'string' ? payload.data.timezone : '',
      deliverableKind:
        payload.data.deliverableKind === 'report' ? 'report' : 'thread',
      reportOutputId:
        typeof payload.data.reportOutputId === 'string' ||
        payload.data.reportOutputId === null
          ? payload.data.reportOutputId
          : undefined,
      createReport: payload.data.createReport,
      sourceScope: (payload.data.sourceScope ?? null) as any,
    });

    if (result.statusCode === 201) {
      opts.jobWorker.wake();
    }

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/talks/:talkId/jobs/:jobId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      title?: string;
      prompt?: string;
      targetAgentId?: string;
      schedule?: Record<string, unknown>;
      timezone?: string;
      deliverableKind?: 'thread' | 'report';
      reportOutputId?: string | null;
      createReport?: Record<string, unknown>;
      sourceScope?: Record<string, unknown>;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = patchTalkJobRoute({
      auth,
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
      prompt:
        typeof payload.data.prompt === 'string'
          ? payload.data.prompt
          : undefined,
      targetAgentId:
        typeof payload.data.targetAgentId === 'string'
          ? payload.data.targetAgentId
          : undefined,
      schedule: payload.data.schedule as any,
      timezone:
        typeof payload.data.timezone === 'string'
          ? payload.data.timezone
          : undefined,
      deliverableKind:
        payload.data.deliverableKind === 'report' ||
        payload.data.deliverableKind === 'thread'
          ? payload.data.deliverableKind
          : undefined,
      reportOutputId:
        typeof payload.data.reportOutputId === 'string' ||
        payload.data.reportOutputId === null
          ? payload.data.reportOutputId
          : undefined,
      createReport: payload.data.createReport,
      sourceScope: payload.data.sourceScope as any,
    });

    if (result.statusCode === 200) {
      opts.jobWorker.wake();
    }

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/jobs/:jobId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = deleteTalkJobRoute({
      auth,
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/jobs/:jobId/pause', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = pauseTalkJobRoute({
      auth,
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/jobs/:jobId/resume', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = resumeTalkJobRoute({
      auth,
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    if (result.statusCode === 200) {
      opts.jobWorker.wake();
    }
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/jobs/:jobId/run-now', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = runTalkJobNowRoute({
      auth,
      talkId: c.req.param('talkId'),
      jobId: c.req.param('jobId'),
    });
    if (result.statusCode === 202) {
      opts.runWorker.wake();
    }
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/context/rules', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ ruleText?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = createTalkContextRuleRoute({
      auth,
      talkId: c.req.param('talkId'),
      ruleText:
        typeof payload.data.ruleText === 'string' ? payload.data.ruleText : '',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/talks/:talkId/context/rules/:ruleId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      ruleText?: string;
      isActive?: boolean;
      sortOrder?: number;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = patchTalkContextRuleRoute({
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
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/context/rules/:ruleId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = deleteTalkContextRuleRoute({
      auth,
      talkId: c.req.param('talkId'),
      ruleId: c.req.param('ruleId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/context/sources', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      sourceType?: string;
      title?: string;
      note?: string | null;
      sourceUrl?: string | null;
      extractedText?: string | null;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const sourceType =
      typeof payload.data.sourceType === 'string'
        ? payload.data.sourceType
        : '';
    const sourceUrl =
      typeof payload.data.sourceUrl === 'string'
        ? payload.data.sourceUrl
        : null;

    const result = createTalkContextSourceRoute({
      auth,
      talkId: c.req.param('talkId'),
      sourceType,
      title: typeof payload.data.title === 'string' ? payload.data.title : '',
      note: typeof payload.data.note === 'string' ? payload.data.note : null,
      sourceUrl,
      extractedText:
        typeof payload.data.extractedText === 'string'
          ? payload.data.extractedText
          : null,
    });

    // Fire-and-forget: kick off URL ingestion asynchronously after creation.
    if (result.statusCode === 201 && sourceType === 'url' && sourceUrl) {
      const createdSource = (
        result.body as { ok: boolean; data?: { source?: { id: string } } }
      ).data?.source;
      if (createdSource?.id) {
        opts.sourceIngestion.enqueueUrlSource(createdSource.id, sourceUrl);
      }
    }

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/context/sources/upload', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

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

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get(
    '/api/v1/talks/:talkId/context/sources/:sourceId/content',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const rateResult = checkRateLimit({
        principalId: auth.userId,
        bucket: 'read',
      });
      if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

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
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      title?: string;
      note?: string | null;
      sortOrder?: number;
      extractedText?: string | null;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = patchTalkContextSourceRoute({
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
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:talkId/context/sources/:sourceId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = await deleteTalkContextSourceRoute({
      auth,
      talkId: c.req.param('talkId'),
      sourceId: c.req.param('sourceId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post(
    '/api/v1/talks/:talkId/context/sources/:sourceId/retry',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const rateResult = checkRateLimit({
        principalId: auth.userId,
        bucket: 'write',
      });
      if (!rateResult.allowed) {
        return rateLimitedResponse(c, rateResult);
      }

      const csrf = validateCsrfToken({
        method: c.req.method,
        authType: auth.authType,
        cookieHeader: c.req.header('cookie'),
        csrfHeader: c.req.header('x-csrf-token'),
      });
      if (!csrf.ok) {
        return c.json(
          { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
          403,
        );
      }

      const result = retryTalkContextSourceRoute({
        auth,
        talkId: c.req.param('talkId'),
        sourceId: c.req.param('sourceId'),
      });

      if (result.statusCode === 200 && result.body.ok) {
        const source = result.body.data.source;
        if (
          source.sourceType === 'url' &&
          typeof source.sourceUrl === 'string'
        ) {
          opts.sourceIngestion.enqueueUrlSource(source.id, source.sourceUrl);
        }
      }

      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  // ---- Message attachments (file upload) ----

  app.post('/api/v1/talks/:talkId/attachments', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

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
    const result = await uploadTalkAttachmentRoute({
      auth,
      talkId: c.req.param('talkId'),
      file: {
        name: file.name || 'unnamed',
        data: Buffer.from(arrayBuffer),
        type: file.type || 'application/octet-stream',
      },
    });

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/attachments', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    const attachmentsResult = listTalkAttachmentsRoute({
      auth,
      talkId: c.req.param('talkId'),
    });

    return new Response(JSON.stringify(attachmentsResult.body), {
      status: attachmentsResult.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get(
    '/api/v1/talks/:talkId/attachments/:attachmentId/content',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const rateResult = checkRateLimit({
        principalId: auth.userId,
        bucket: 'read',
      });
      if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

      const result = await getTalkAttachmentContentRoute({
        auth,
        talkId: c.req.param('talkId'),
        attachmentId: c.req.param('attachmentId'),
      });

      if (Buffer.isBuffer(result.body) && 'headers' in result) {
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

  app.put('/api/v1/talks/:talkId/agents', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'idempotency_error',
            message: precheck.error,
          },
        },
        400,
      );
    }

    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }
    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const payload = parseJsonPayload<{ agents?: unknown }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = updateTalkAgentsRoute({
      talkId,
      auth,
      agents: payload.data.agents,
    });
    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/runs', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = listTalkRunsRoute({ talkId, auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/runs/:runId/context', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    const encodedRunId = c.req.param('runId');
    const runId = safeDecodePathSegment(encodedRunId);
    if (!talkId || !runId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'bad_request',
            message: 'Talk ID or run ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = getTalkRunContextRoute({ talkId, runId, auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/policy', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = getTalkPolicyRoute({
      talkId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/talks/:talkId/policy', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'idempotency_error',
            message: precheck.error,
          },
        },
        400,
      );
    }

    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }
    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const payload = parseJsonPayload<{ agents?: unknown }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = updateTalkPolicyRoute({
      talkId,
      auth,
      agents: payload.data.agents,
    });
    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/chat', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      userId: auth.userId,
      bucket: 'chat_write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'idempotency_error',
            message: precheck.error,
          },
        },
        400,
      );
    }

    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }
    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const payload = parseJsonPayload<{
      content?: string;
      threadId?: string;
      targetAgentIds?: unknown;
      attachmentIds?: unknown;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = enqueueTalkChat({
      talkId,
      threadId:
        typeof payload.data.threadId === 'string'
          ? payload.data.threadId.trim() || null
          : null,
      auth,
      content: payload.data.content || '',
      targetAgentIds: Array.isArray(payload.data.targetAgentIds)
        ? payload.data.targetAgentIds.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : null,
      attachmentIds: Array.isArray(payload.data.attachmentIds)
        ? payload.data.attachmentIds.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : null,
      idempotencyKey,
    });
    if (result.statusCode === 202 && result.body.ok) {
      opts.runWorker.wake();
    }

    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/events', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    if (isLiveSseMode(c.req.query('stream'))) {
      const rawLastEventId = c.req.header('last-event-id');
      const lastEventId = parseLastEventId(rawLastEventId);
      const topics = getUserScopedEventTopics(auth.userId);
      if (!tryAcquireLiveSseConnection(auth.userId)) {
        c.header('retry-after', String(SSE_STREAM_RETRY_AFTER_SEC));
        return c.json(
          {
            ok: false,
            error: {
              code: 'too_many_stream_connections',
              message: `Maximum ${MAX_LIVE_SSE_CONNECTIONS_PER_USER} live event streams per user`,
            },
          },
          429,
        );
      }
      return createLiveSseResponse({
        topics,
        lastEventId:
          rawLastEventId === undefined
            ? (getOutboxMaxEventIdForTopics(topics) ?? 0)
            : lastEventId,
        requestSignal: c.req.raw.signal,
        onClose: () => releaseLiveSseConnection(auth.userId),
      });
    }

    const lastEventId = parseLastEventId(c.req.header('last-event-id'));
    const stream = buildUserScopedSseStream({
      userId: auth.userId,
      lastEventId,
    });

    return c.body(
      `retry: ${SSE_RETRY_MS}\n\n${stream}`,
      200,
      sseHeaders('snapshot'),
    );
  });

  app.get('/api/v1/talks/:talkId/events', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    if (!canUserAccessTalk(talkId, auth.userId)) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'talk_not_found',
            message: 'Talk not found',
          },
        },
        404,
      );
    }

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const requestedThreadId = (c.req.query('threadId') || '').trim() || null;
    let threadId: string | null = null;
    if (requestedThreadId) {
      try {
        threadId = resolveThreadIdForTalk(talkId, requestedThreadId);
      } catch (error) {
        if (error instanceof TalkThreadValidationError) {
          return c.json(
            {
              ok: false,
              error: {
                code: error.code,
                message: error.message,
              },
            },
            400,
          );
        }
        throw error;
      }
    }

    if (isLiveSseMode(c.req.query('stream'))) {
      const rawLastEventId = c.req.header('last-event-id');
      const lastEventId = parseLastEventId(rawLastEventId);
      const topics = getTalkScopedEventTopics(talkId);
      if (!tryAcquireLiveSseConnection(auth.userId)) {
        c.header('retry-after', String(SSE_STREAM_RETRY_AFTER_SEC));
        return c.json(
          {
            ok: false,
            error: {
              code: 'too_many_stream_connections',
              message: `Maximum ${MAX_LIVE_SSE_CONNECTIONS_PER_USER} live event streams per user`,
            },
          },
          429,
        );
      }
      return createLiveSseResponse({
        topics,
        lastEventId:
          rawLastEventId === undefined
            ? (getOutboxMaxEventIdForTopics(topics) ?? 0)
            : lastEventId,
        eventFilter: threadId
          ? buildTalkThreadEventFilter(threadId)
          : undefined,
        requestSignal: c.req.raw.signal,
        onClose: () => releaseLiveSseConnection(auth.userId),
      });
    }

    const lastEventId = parseLastEventId(c.req.header('last-event-id'));
    const stream = buildTalkScopedSseStream({ talkId, lastEventId, threadId });

    return c.body(
      `retry: ${SSE_RETRY_MS}\n\n${stream}`,
      200,
      sseHeaders('snapshot'),
    );
  });

  app.post('/api/v1/talks/:talkId/chat/cancel', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      userId: auth.userId,
      bucket: 'chat_write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'idempotency_error',
            message: precheck.error,
          },
        },
        400,
      );
    }

    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const payload = parseJsonPayload<Record<string, unknown>>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }

    const result = cancelTalkChat({
      talkId,
      threadId:
        typeof payload.data.threadId === 'string'
          ? payload.data.threadId.trim() || null
          : null,
      auth,
    });
    if (
      result.statusCode === 200 &&
      result.body.ok &&
      result.cancelledRunning
    ) {
      const cancelledThreadId = result.body.data.threadId;
      if (
        typeof cancelledThreadId === 'string' &&
        cancelledThreadId.length > 0
      ) {
        opts.runWorker.abortThread(cancelledThreadId);
      } else {
        opts.runWorker.abortTalk(talkId);
      }
    }

    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.all('/api/v1/*', (c) => {
    return c.json(
      {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Route not found',
        },
      },
      404,
    );
  });

  // Serve SPA assets in production from webapp/dist.
  app.get('*', (c) => {
    const response = serveWebAppRequest(c.req.path, opts.webAppDistDir);
    return response || c.text('Not Found', 404);
  });

  return app;
}

function requireAuth(c: Context): AuthContext | null {
  return authenticateRequest({
    authorization: c.req.header('authorization'),
    cookie: c.req.header('cookie'),
  });
}

function unauthorized(c: Context) {
  return c.json(
    {
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Authentication is required',
      },
    },
    401,
  );
}

function forbidden(c: Context, message: string) {
  return c.json(
    {
      ok: false,
      error: {
        code: 'forbidden',
        message,
      },
    },
    403,
  );
}

function authErrorResponse(c: Context, err: unknown) {
  if (err instanceof AuthError) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: err.code,
          message: err.message,
        },
      }),
      {
        status: err.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }

  return c.json(
    {
      ok: false,
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
    },
    500,
  );
}

function setSessionCookies(c: Context, session: SessionCookieInput): void {
  setCookie(c, ACCESS_TOKEN_COOKIE, session.accessToken, {
    httpOnly: true,
    secure: WEB_SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SEC,
  });
  setCookie(c, REFRESH_TOKEN_COOKIE, session.refreshToken, {
    httpOnly: true,
    secure: WEB_SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SEC,
  });
  setCookie(c, CSRF_TOKEN_COOKIE, session.csrfToken, {
    httpOnly: false,
    secure: WEB_SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SEC,
  });
}

function clearSessionCookies(c: Context): void {
  deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' });
  deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });
  deleteCookie(c, CSRF_TOKEN_COOKIE, { path: '/' });
}

function parseLastEventId(value: string | undefined): number {
  const parsed = value ? parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function isLiveSseMode(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function sseHeaders(mode: 'snapshot' | 'stream'): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-clawrocket-sse-mode': mode,
  };
}

function createLiveSseResponse(input: {
  topics: string[];
  lastEventId: number;
  eventFilter?: (event: {
    event_id: number;
    event_type: string;
    payload: string;
  }) => boolean;
  requestSignal: AbortSignal;
  onClose?: () => void;
}): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  let finalized = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    input.onClose?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const write = (chunk: string) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(chunk));
      };
      const close = () => {
        if (!cancelled) {
          cancelled = true;
        }
        try {
          controller.close();
        } catch {
          // ignored; stream may already be closed
        } finally {
          finalize();
        }
      };

      const onAbort = () => close();
      input.requestSignal.addEventListener('abort', onAbort, { once: true });

      try {
        write(`retry: ${SSE_RETRY_MS}\n\n`);

        let cursor = input.lastEventId;
        let lastHeartbeatMs = Date.now();

        while (!cancelled && !input.requestSignal.aborted) {
          const minId = getOutboxMinEventIdForTopics(input.topics);
          if (cursor > 0 && minId !== null && cursor < minId - 1) {
            write(
              'event: replay_gap\ndata: {"message":"Requested replay position is outside retention window"}\n\n',
            );
            // Resume from earliest retained event to avoid repeated replay_gap spam.
            cursor = minId - 1;
          }

          const events = getOutboxEventsForTopics(
            input.topics,
            cursor,
            SSE_STREAM_BATCH_LIMIT,
          );
          for (const event of events) {
            if (!input.eventFilter || input.eventFilter(event)) {
              write(formatOutboxEventAsSse(event));
            }
            cursor = event.event_id;
          }

          const nowMs = Date.now();
          if (nowMs - lastHeartbeatMs >= SSE_STREAM_HEARTBEAT_MS) {
            write(': keepalive\n\n');
            lastHeartbeatMs = nowMs;
          }

          const waitTimeoutMs = Math.max(
            1,
            SSE_STREAM_HEARTBEAT_MS - (Date.now() - lastHeartbeatMs),
          );
          const waitResult = await waitForOutboxTopics({
            topics: input.topics,
            afterEventId: cursor,
            timeoutMs: waitTimeoutMs,
            signal: input.requestSignal,
          });
          if (waitResult === 'timeout') {
            const heartbeatNowMs = Date.now();
            if (heartbeatNowMs - lastHeartbeatMs >= SSE_STREAM_HEARTBEAT_MS) {
              write(': keepalive\n\n');
              lastHeartbeatMs = heartbeatNowMs;
            }
          }
        }
      } finally {
        input.requestSignal.removeEventListener('abort', onAbort);
        close();
      }
    },
    cancel: () => {
      cancelled = true;
      finalize();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders('stream'),
  });
}

function serveWebAppRequest(
  requestPath: string,
  webAppDistDir: string,
): Response | null {
  const distDir = path.resolve(webAppDistDir);
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) return null;

  // Asset requests (with extension) map directly to files under dist/.
  const extension = path.extname(requestPath);
  if (extension) {
    const assetPath = resolveSafeDistPath(distDir, requestPath);
    if (
      !assetPath ||
      !fs.existsSync(assetPath) ||
      !fs.statSync(assetPath).isFile()
    ) {
      return null;
    }
    return serveStaticFile(assetPath, false, requestPath);
  }

  // Route paths fallback to SPA index.
  return serveStaticFile(indexPath, true, requestPath);
}

function resolveSafeDistPath(
  distDir: string,
  requestPath: string,
): string | null {
  const relativePath = requestPath.startsWith('/')
    ? requestPath.slice(1)
    : requestPath;
  const normalizedRelative = path.normalize(relativePath);
  if (
    !normalizedRelative ||
    normalizedRelative.startsWith('..') ||
    path.isAbsolute(normalizedRelative)
  ) {
    return null;
  }

  const fullPath = path.resolve(distDir, normalizedRelative);
  if (fullPath === distDir || !fullPath.startsWith(`${distDir}${path.sep}`)) {
    return null;
  }

  return fullPath;
}

function serveStaticFile(
  filePath: string,
  isHtml: boolean,
  requestPath: string,
): Response {
  const body = fs.readFileSync(filePath);
  const headers: Record<string, string> = {
    'content-type': contentTypeForPath(filePath),
  };
  if (isHtml) {
    headers['cache-control'] = 'no-cache';
    headers['content-security-policy'] =
      "default-src 'self'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com https://www.google.com; connect-src 'self' https://apis.google.com https://www.googleapis.com https://content.googleapis.com https://docs.google.com; font-src 'self' https://fonts.gstatic.com; frame-src 'self' https://accounts.google.com https://docs.google.com https://drive.google.com https://*.googleusercontent.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  } else if (requestPath.startsWith('/assets/')) {
    headers['cache-control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['cache-control'] = 'public, max-age=3600';
  }
  return new Response(body, { status: 200, headers });
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function parseJsonPayload<T>(
  bodyText: string,
): { ok: true; data: T } | { ok: false; error: string } {
  if (!bodyText.trim()) {
    return { ok: true, data: {} as T };
  }
  try {
    return { ok: true, data: JSON.parse(bodyText) as T };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON' };
  }
}

function safeDecodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeReturnToPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const candidate = value.trim();
  if (!candidate) return null;
  if (/%0d|%0a/i.test(candidate)) return null;
  if (!isSafeRelativeRedirectTarget(candidate)) return null;

  let decoded = '';
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return null;
  }

  if (/%0d|%0a/i.test(decoded)) return null;
  if (!isSafeRelativeRedirectTarget(decoded)) return null;

  return candidate;
}

function appendQueryParam(
  pathValue: string,
  key: string,
  value: string,
): string {
  const separator = pathValue.includes('?') ? '&' : '?';
  return `${pathValue}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function renderGoogleAccountCallbackHtml(input: {
  status: 'success' | 'error';
  returnTo: string;
  message?: string;
}): Response {
  const payload = JSON.stringify({
    type: 'clawrocket:google-account-link',
    status: input.status,
    message: input.message ?? null,
  });
  const fallbackTarget =
    input.status === 'error' && input.message
      ? appendQueryParam(input.returnTo, 'googleToolsError', input.message)
      : input.returnTo;
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Google Account</title>
  </head>
  <body>
    <script>
      (function() {
        var payload = ${payload};
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
          window.close();
          return;
        }
        window.location.replace(${JSON.stringify(fallbackTarget)});
      })();
    </script>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    },
  });
}

function renderSlackOAuthCallbackHtml(input: {
  status: 'success' | 'error';
  returnTo: string;
  message?: string;
  workspaceName?: string;
}): Response {
  const payload = JSON.stringify({
    type: 'clawrocket:slack-workspace-install',
    status: input.status,
    message: input.message ?? null,
    workspaceName: input.workspaceName ?? null,
  });
  const fallbackTarget =
    input.status === 'error' && input.message
      ? appendQueryParam(input.returnTo, 'slackConnectError', input.message)
      : input.returnTo;
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Slack Workspace</title>
  </head>
  <body>
    <script>
      (function() {
        var payload = ${payload};
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
          window.close();
          return;
        }
        window.location.replace(${JSON.stringify(fallbackTarget)});
      })();
    </script>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    },
  });
}

function isSafeRelativeRedirectTarget(pathValue: string): boolean {
  if (!pathValue.startsWith('/')) return false;
  if (pathValue.startsWith('//')) return false;
  if (pathValue.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(pathValue)) return false;
  return true;
}

function resolveGoogleOAuthRedirectUri(
  c: Context,
  opts: WebServerOptions,
): string {
  const localOverride = resolveLoopbackGoogleOAuthRedirectUri(c, opts);
  if (localOverride) return localOverride;
  return (
    GOOGLE_OAUTH_REDIRECT_URI ||
    `http://127.0.0.1:${WEB_PORT}/api/v1/auth/google/callback`
  );
}

function resolveLoopbackGoogleOAuthRedirectUri(
  c: Context,
  opts: WebServerOptions,
): string | null {
  let requestUrl: URL;
  try {
    requestUrl = new URL(c.req.url);
  } catch {
    return null;
  }

  if (!isLoopbackHostname(requestUrl.hostname)) {
    return null;
  }

  const callbackUrl = new URL(requestUrl.toString());
  callbackUrl.hostname = isLoopbackHostname(opts.host)
    ? opts.host
    : requestUrl.hostname;
  callbackUrl.pathname = '/api/v1/auth/google/callback';
  callbackUrl.search = '';
  callbackUrl.hash = '';
  callbackUrl.port =
    requestUrl.port || (opts.port > 0 ? String(opts.port) : String(WEB_PORT));
  return callbackUrl.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function normalizeUser(user: UserLike) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
  };
}

type ForwardedHeaderSnapshot = {
  xForwardedFor?: string;
  xForwardedProto?: string;
  xForwardedHost?: string;
  cfConnectingIp?: string;
  cfVisitor?: string;
  host?: string;
};

export function _resetForwardedHeaderWarningStateForTests(): void {
  warnedAboutUnexpectedForwardedHeaders = false;
  warnedAboutMissingCloudflareClientIp = false;
  warnedAboutMissingCaddyForwardedFor = false;
}

export function _resolveClientIpForTests(input: {
  xForwardedFor?: string;
  cfConnectingIp?: string;
  remoteAddress?: string;
}): string | undefined {
  return resolveClientIpFromHeaders(input, input.remoteAddress);
}

export function _warnAboutUnexpectedForwardedHeadersForTests(input: {
  xForwardedFor?: string;
  cfConnectingIp?: string;
}): void {
  maybeWarnAboutUnexpectedForwardedHeadersFromHeaders(input);
}

function publicModeDisabledResponse(c: Context): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: 'device_auth_disabled',
        message: 'Device auth is disabled in public mode',
      },
    },
    403,
  );
}

function maybeWarnAboutUnexpectedForwardedHeaders(c: Context): void {
  maybeWarnAboutUnexpectedForwardedHeadersFromHeaders(getForwardedHeaders(c));
}

function maybeWarnAboutUnexpectedForwardedHeadersFromHeaders(
  headers: ForwardedHeaderSnapshot,
): void {
  if (isPublicMode || warnedAboutUnexpectedForwardedHeaders) return;
  if (!headers.xForwardedFor && !headers.cfConnectingIp) return;

  warnedAboutUnexpectedForwardedHeaders = true;
  logger.warn(
    'Forwarded headers detected but PUBLIC_MODE is not enabled. If this instance is internet-facing, set PUBLIC_MODE=true.',
  );
}

function resolveClientIpFromHeaders(
  headers: ForwardedHeaderSnapshot,
  remoteAddress: string | undefined,
): string | undefined {
  switch (TRUSTED_PROXY_MODE) {
    case 'cloudflare': {
      const cfConnectingIp = normalizeIp(headers.cfConnectingIp);
      if (cfConnectingIp) return cfConnectingIp;
      if (!warnedAboutMissingCloudflareClientIp) {
        warnedAboutMissingCloudflareClientIp = true;
        logger.error(
          { remoteAddress: remoteAddress || 'unknown' },
          'CF-Connecting-IP header missing. Per-client rate limiting is degraded; requests may collapse to a single identity such as 127.0.0.1. Verify cloudflared configuration and request path.',
        );
      }
      return normalizeIp(remoteAddress);
    }
    case 'caddy': {
      const forwarded = getCaddyForwardedClientIp(headers.xForwardedFor);
      if (forwarded) return forwarded;
      if (!warnedAboutMissingCaddyForwardedFor) {
        warnedAboutMissingCaddyForwardedFor = true;
        logger.error(
          { remoteAddress: remoteAddress || 'unknown' },
          'X-Forwarded-For header missing. Per-client rate limiting is degraded; requests may collapse to a single identity at the proxy hop. Verify Caddy proxy configuration.',
        );
      }
      return normalizeIp(remoteAddress);
    }
    case 'none':
    default:
      return normalizeIp(remoteAddress);
  }
}

function getForwardedHeaders(c: Context): ForwardedHeaderSnapshot {
  return {
    xForwardedFor: c.req.header('x-forwarded-for') || undefined,
    xForwardedProto: c.req.header('x-forwarded-proto') || undefined,
    xForwardedHost: c.req.header('x-forwarded-host') || undefined,
    cfConnectingIp: c.req.header('cf-connecting-ip') || undefined,
    cfVisitor: c.req.header('cf-visitor') || undefined,
    host: c.req.header('host') || undefined,
  };
}

export function _resolveRequestOriginForTests(input: {
  requestUrl: string;
  xForwardedProto?: string;
  xForwardedHost?: string;
  cfVisitor?: string;
  host?: string;
}): string {
  return resolveRequestOriginFromHeaders(input.requestUrl, {
    xForwardedProto: input.xForwardedProto,
    xForwardedHost: input.xForwardedHost,
    cfVisitor: input.cfVisitor,
    host: input.host,
  });
}

function resolveRequestOrigin(c: Context): string {
  return resolveRequestOriginFromHeaders(c.req.url, getForwardedHeaders(c));
}

function resolveRequestOriginFromHeaders(
  requestUrl: string,
  headers: ForwardedHeaderSnapshot,
): string {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return requestUrl;
  }

  let protocol = parsed.protocol.replace(/:$/, '');
  let host = parsed.host;

  if (TRUSTED_PROXY_MODE !== 'none') {
    const forwardedProto = resolveForwardedProto(headers);
    const forwardedHost = resolveForwardedHost(headers);
    if (forwardedProto) {
      protocol = forwardedProto;
    }
    if (forwardedHost) {
      host = forwardedHost;
    }
  }

  return `${protocol}://${host}`;
}

function resolveForwardedProto(
  headers: ForwardedHeaderSnapshot,
): 'http' | 'https' | null {
  const normalizedXForwardedProto = headers.xForwardedProto
    ?.split(',')
    .map((value) => value.trim().toLowerCase())
    .find((value) => value === 'http' || value === 'https');
  if (
    normalizedXForwardedProto === 'http' ||
    normalizedXForwardedProto === 'https'
  ) {
    return normalizedXForwardedProto;
  }

  if (TRUSTED_PROXY_MODE === 'cloudflare' && headers.cfVisitor) {
    try {
      const parsed = JSON.parse(headers.cfVisitor) as { scheme?: unknown };
      if (parsed.scheme === 'http' || parsed.scheme === 'https') {
        return parsed.scheme;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function resolveForwardedHost(headers: ForwardedHeaderSnapshot): string | null {
  const normalizedXForwardedHost = headers.xForwardedHost
    ?.split(',')
    .map((value) => value.trim())
    .find(Boolean);
  if (normalizedXForwardedHost) {
    return normalizedXForwardedHost;
  }
  return headers.host?.trim() || null;
}

function getClientIp(c: Context): string | undefined {
  return resolveClientIpFromHeaders(
    getForwardedHeaders(c),
    getRemoteAddress(c),
  );
}

function normalizeIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getCaddyForwardedClientIp(
  xForwardedFor: string | undefined,
): string | undefined {
  if (!xForwardedFor) return undefined;
  const parts = xForwardedFor
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1);
}

function getRemoteAddress(c: Context): string | undefined {
  try {
    const connInfo = getConnInfo(c);
    return normalizeIp(connInfo.remote.address);
  } catch {
    return undefined;
  }
}

function getRequestRateLimitPrincipal(c: Context): string {
  const ip = getClientIp(c);
  return ip ? `ip:${ip}` : 'ip:unknown';
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

type SessionCookieInput = {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
};

type UserLike = {
  id: string;
  email: string;
  display_name: string;
  role: string;
  created_at: string;
};
