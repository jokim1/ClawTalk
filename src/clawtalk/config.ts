import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  PROVIDER_SECRET_DEV_FALLBACK,
  PROVIDER_SECRET_KEY_ENV,
} from './llm/provider-secret-store.js';

const envConfig = readEnvFile([
  'WEB_ENABLED',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_SECURE_COOKIES',
  'PUBLIC_MODE',
  'INITIAL_OWNER_EMAIL',
  'TRUSTED_PROXY_MODE',
  'AUTH_DEV_MODE',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'GOOGLE_PICKER_API_KEY',
  'GOOGLE_PICKER_APP_ID',
  'CLAWTALK_PROVIDER_SECRET_KEY',
  'ACCESS_TOKEN_TTL_SEC',
  'REFRESH_TOKEN_TTL_SEC',
  'DEVICE_CODE_TTL_SEC',
  'CLAWTALK_ALLOWED_ORIGINS',
  'TALK_RUN_POLL_MS',
  'TALK_RUN_MAX_CONCURRENCY',
  'TALK_MOCK_EXECUTION_MS',
  'TALK_EXECUTOR_DEFAULT_ALIAS',
  'TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON',
  'TALK_EXECUTOR_WEB_GROUP_FOLDER',
  'TALK_CONTEXT_BROWSER_TIMEOUT_MS',
  'TALK_CONTEXT_BROWSER_PREFER_HOSTS',
  'TALK_CONTEXT_BROWSER_DISABLE_HOSTS',
  'TALK_CONTEXT_MANAGED_FETCH_ENABLED',
  'TALK_CONTEXT_MANAGED_FETCH_BASE_URL',
  'TALK_CONTEXT_MANAGED_FETCH_API_KEY',
  'TALK_CONTEXT_MANAGED_FETCH_TIMEOUT_MS',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED',
  'MAIN_SUBSCRIPTION_WARM_WORKER_IDLE_TTL_MS',
  'MAIN_SUBSCRIPTION_WARM_WORKER_MAX_COUNT',
  'MAIN_SUBSCRIPTION_WARM_WORKER_BOOT_TIMEOUT_MS',
]);

export type TrustedProxyMode = 'none' | 'cloudflare' | 'caddy';

function parseCsvList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseTrustedProxyMode(value: string | undefined): TrustedProxyMode {
  const normalized = (value || 'none').trim().toLowerCase();
  if (
    normalized === 'cloudflare' ||
    normalized === 'caddy' ||
    normalized === 'none'
  ) {
    return normalized;
  }
  if (normalized) {
    logger.warn(
      { value: normalized },
      'Unrecognized TRUSTED_PROXY_MODE value, defaulting to none',
    );
  }
  return 'none';
}

function looksLikeEmailAddress(value: string): boolean {
  return value.includes('@') && !value.startsWith('@') && !value.endsWith('@');
}

export function isNonLocalhostRedirectUri(uri: string): boolean {
  const trimmed = uri.trim();
  if (!trimmed) return false;

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    return (
      hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1'
    );
  } catch {
    return true;
  }
}

export const WEB_ENABLED =
  (process.env.WEB_ENABLED || envConfig.WEB_ENABLED || 'true') === 'true';
export const WEB_HOST =
  process.env.WEB_HOST || envConfig.WEB_HOST || '127.0.0.1';
export const WEB_PORT = parseInt(
  process.env.WEB_PORT || envConfig.WEB_PORT || '3210',
  10,
);
export const WEB_SECURE_COOKIES =
  (process.env.WEB_SECURE_COOKIES ||
    envConfig.WEB_SECURE_COOKIES ||
    'false') === 'true';
export const PUBLIC_MODE =
  (process.env.PUBLIC_MODE || envConfig.PUBLIC_MODE || 'false') === 'true';
export const INITIAL_OWNER_EMAIL = (
  process.env.INITIAL_OWNER_EMAIL ||
  envConfig.INITIAL_OWNER_EMAIL ||
  ''
)
  .trim()
  .toLowerCase();
export const TRUSTED_PROXY_MODE = parseTrustedProxyMode(
  process.env.TRUSTED_PROXY_MODE || envConfig.TRUSTED_PROXY_MODE || 'none',
);
export const AUTH_DEV_MODE =
  (process.env.AUTH_DEV_MODE || envConfig.AUTH_DEV_MODE || 'true') === 'true';
export const GOOGLE_OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID || envConfig.GOOGLE_OAUTH_CLIENT_ID || '';
export const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
  envConfig.GOOGLE_OAUTH_CLIENT_SECRET ||
  '';
export const GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI ||
  envConfig.GOOGLE_OAUTH_REDIRECT_URI ||
  '';
export const GOOGLE_PICKER_API_KEY =
  process.env.GOOGLE_PICKER_API_KEY || envConfig.GOOGLE_PICKER_API_KEY || '';
export const GOOGLE_PICKER_APP_ID =
  process.env.GOOGLE_PICKER_APP_ID || envConfig.GOOGLE_PICKER_APP_ID || '';
export const CLAWTALK_PROVIDER_SECRET_KEY =
  process.env.CLAWTALK_PROVIDER_SECRET_KEY ||
  envConfig.CLAWTALK_PROVIDER_SECRET_KEY ||
  '';
export const isPublicMode =
  PUBLIC_MODE ||
  TRUSTED_PROXY_MODE !== 'none' ||
  isNonLocalhostRedirectUri(GOOGLE_OAUTH_REDIRECT_URI);

export function getPublicModeConfigErrors(): string[] {
  if (!isPublicMode) return [];

  const errors: string[] = [];

  if (AUTH_DEV_MODE) {
    errors.push('AUTH_DEV_MODE must be false when public mode is enabled');
  }
  if (!WEB_SECURE_COOKIES) {
    errors.push('WEB_SECURE_COOKIES must be true when public mode is enabled');
  }
  if (
    !CLAWTALK_PROVIDER_SECRET_KEY.trim() ||
    CLAWTALK_PROVIDER_SECRET_KEY.trim() === PROVIDER_SECRET_DEV_FALLBACK
  ) {
    errors.push(
      `${PROVIDER_SECRET_KEY_ENV} must be set to a non-development key when public mode is enabled`,
    );
  }
  if (TRUSTED_PROXY_MODE === 'none') {
    errors.push(
      'TRUSTED_PROXY_MODE must be set to cloudflare or caddy when public mode is enabled',
    );
  }
  if (!GOOGLE_OAUTH_CLIENT_ID.trim()) {
    errors.push(
      'GOOGLE_OAUTH_CLIENT_ID must be set when public mode is enabled',
    );
  }
  if (!GOOGLE_OAUTH_CLIENT_SECRET.trim()) {
    errors.push(
      'GOOGLE_OAUTH_CLIENT_SECRET must be set when public mode is enabled',
    );
  }
  if (!isNonLocalhostRedirectUri(GOOGLE_OAUTH_REDIRECT_URI)) {
    errors.push(
      'GOOGLE_OAUTH_REDIRECT_URI must be set to a non-localhost URL when public mode is enabled',
    );
  }

  return errors;
}

export function getPublicModeDatabaseErrors(hasOwner: boolean): string[] {
  if (!isPublicMode) return [];
  if (hasOwner) return [];
  if (INITIAL_OWNER_EMAIL) {
    if (looksLikeEmailAddress(INITIAL_OWNER_EMAIL)) return [];
    return [
      'INITIAL_OWNER_EMAIL must look like an email address when public mode is enabled and no owner exists',
    ];
  }
  return [
    'INITIAL_OWNER_EMAIL must be set or an owner must already exist when public mode is enabled',
  ];
}
export const ACCESS_TOKEN_TTL_SEC = parseInt(
  process.env.ACCESS_TOKEN_TTL_SEC || envConfig.ACCESS_TOKEN_TTL_SEC || '3600',
  10,
);
export const REFRESH_TOKEN_TTL_SEC = parseInt(
  process.env.REFRESH_TOKEN_TTL_SEC ||
    envConfig.REFRESH_TOKEN_TTL_SEC ||
    `${30 * 24 * 60 * 60}`,
  10,
);
export const DEVICE_CODE_TTL_SEC = parseInt(
  process.env.DEVICE_CODE_TTL_SEC || envConfig.DEVICE_CODE_TTL_SEC || '600',
  10,
);

// Allowed origins for the Supabase Auth callback + refresh routes.
// Phase 5 PR 2: locked at clawtalk.app + local dev (vite + tsx).
// Cleared CSV string → parsed list. Tests run inside Node mode and
// can override via the env var or by importing CLAWTALK_ALLOWED_ORIGINS
// directly.
export const CLAWTALK_ALLOWED_ORIGINS = (
  process.env.CLAWTALK_ALLOWED_ORIGINS ||
  envConfig.CLAWTALK_ALLOWED_ORIGINS ||
  'https://clawtalk.app,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3210,http://localhost:3210'
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const talkRunPollMs = parseInt(
  process.env.TALK_RUN_POLL_MS || envConfig.TALK_RUN_POLL_MS || '500',
  10,
);
export const TALK_RUN_POLL_MS = Number.isFinite(talkRunPollMs)
  ? Math.max(10, talkRunPollMs)
  : 500;

export const TALK_RUN_MAX_CONCURRENCY = Math.max(
  1,
  parseInt(
    process.env.TALK_RUN_MAX_CONCURRENCY ||
      envConfig.TALK_RUN_MAX_CONCURRENCY ||
      '1',
    10,
  ) || 1,
);

const talkMockExecutionMs = parseInt(
  process.env.TALK_MOCK_EXECUTION_MS ||
    envConfig.TALK_MOCK_EXECUTION_MS ||
    '300',
  10,
);
export const TALK_MOCK_EXECUTION_MS = Number.isFinite(talkMockExecutionMs)
  ? Math.max(0, talkMockExecutionMs)
  : 300;

export const TALK_EXECUTOR_DEFAULT_ALIAS =
  process.env.TALK_EXECUTOR_DEFAULT_ALIAS ||
  envConfig.TALK_EXECUTOR_DEFAULT_ALIAS ||
  'Mock';

export const TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON =
  process.env.TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON ||
  envConfig.TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON ||
  '';

export const TALK_EXECUTOR_WEB_GROUP_FOLDER =
  process.env.TALK_EXECUTOR_WEB_GROUP_FOLDER ||
  envConfig.TALK_EXECUTOR_WEB_GROUP_FOLDER ||
  'web-talks';

const talkContextBrowserTimeoutMs = parseInt(
  process.env.TALK_CONTEXT_BROWSER_TIMEOUT_MS ||
    envConfig.TALK_CONTEXT_BROWSER_TIMEOUT_MS ||
    '30000',
  10,
);
export const TALK_CONTEXT_BROWSER_TIMEOUT_MS = Number.isFinite(
  talkContextBrowserTimeoutMs,
)
  ? Math.max(1_000, talkContextBrowserTimeoutMs)
  : 30_000;

export const TALK_CONTEXT_BROWSER_PREFER_HOSTS = parseCsvList(
  process.env.TALK_CONTEXT_BROWSER_PREFER_HOSTS ||
    envConfig.TALK_CONTEXT_BROWSER_PREFER_HOSTS ||
    'substack.com',
);

export const TALK_CONTEXT_BROWSER_DISABLE_HOSTS = parseCsvList(
  process.env.TALK_CONTEXT_BROWSER_DISABLE_HOSTS ||
    envConfig.TALK_CONTEXT_BROWSER_DISABLE_HOSTS ||
    '',
);

export const TALK_CONTEXT_MANAGED_FETCH_ENABLED =
  (process.env.TALK_CONTEXT_MANAGED_FETCH_ENABLED ||
    envConfig.TALK_CONTEXT_MANAGED_FETCH_ENABLED ||
    'false') === 'true';

export const TALK_CONTEXT_MANAGED_FETCH_BASE_URL =
  process.env.TALK_CONTEXT_MANAGED_FETCH_BASE_URL ||
  envConfig.TALK_CONTEXT_MANAGED_FETCH_BASE_URL ||
  '';

export const TALK_CONTEXT_MANAGED_FETCH_API_KEY =
  process.env.TALK_CONTEXT_MANAGED_FETCH_API_KEY ||
  envConfig.TALK_CONTEXT_MANAGED_FETCH_API_KEY ||
  '';

const talkContextManagedTimeoutMs = parseInt(
  process.env.TALK_CONTEXT_MANAGED_FETCH_TIMEOUT_MS ||
    envConfig.TALK_CONTEXT_MANAGED_FETCH_TIMEOUT_MS ||
    '30000',
  10,
);
export const TALK_CONTEXT_MANAGED_FETCH_TIMEOUT_MS = Number.isFinite(
  talkContextManagedTimeoutMs,
)
  ? Math.max(1_000, talkContextManagedTimeoutMs)
  : 30_000;

export const TALK_EXECUTOR_ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY || '';
export const TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  envConfig.CLAUDE_CODE_OAUTH_TOKEN ||
  '';
export const TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN =
  process.env.ANTHROPIC_AUTH_TOKEN || envConfig.ANTHROPIC_AUTH_TOKEN || '';
export const TALK_EXECUTOR_ANTHROPIC_BASE_URL =
  process.env.ANTHROPIC_BASE_URL || envConfig.ANTHROPIC_BASE_URL || '';

export const TALK_EXECUTOR_HAS_PROVIDER_AUTH =
  TALK_EXECUTOR_ANTHROPIC_API_KEY.length > 0 ||
  TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN.length > 0 ||
  TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN.length > 0;

const mainSubscriptionWarmWorkerEnabledRaw =
  process.env.MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED ||
  envConfig.MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED ||
  (process.env.NODE_ENV === 'production' ? 'false' : 'true');
export const MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED =
  mainSubscriptionWarmWorkerEnabledRaw === 'true';

const mainSubscriptionWarmWorkerIdleTtlMs = parseInt(
  process.env.MAIN_SUBSCRIPTION_WARM_WORKER_IDLE_TTL_MS ||
    envConfig.MAIN_SUBSCRIPTION_WARM_WORKER_IDLE_TTL_MS ||
    `${5 * 60 * 1000}`,
  10,
);
export const MAIN_SUBSCRIPTION_WARM_WORKER_IDLE_TTL_MS = Number.isFinite(
  mainSubscriptionWarmWorkerIdleTtlMs,
)
  ? Math.max(5_000, mainSubscriptionWarmWorkerIdleTtlMs)
  : 5 * 60 * 1000;

const mainSubscriptionWarmWorkerMaxCount = parseInt(
  process.env.MAIN_SUBSCRIPTION_WARM_WORKER_MAX_COUNT ||
    envConfig.MAIN_SUBSCRIPTION_WARM_WORKER_MAX_COUNT ||
    '3',
  10,
);
export const MAIN_SUBSCRIPTION_WARM_WORKER_MAX_COUNT = Number.isFinite(
  mainSubscriptionWarmWorkerMaxCount,
)
  ? Math.max(1, mainSubscriptionWarmWorkerMaxCount)
  : 3;

const mainSubscriptionWarmWorkerBootTimeoutMs = parseInt(
  process.env.MAIN_SUBSCRIPTION_WARM_WORKER_BOOT_TIMEOUT_MS ||
    envConfig.MAIN_SUBSCRIPTION_WARM_WORKER_BOOT_TIMEOUT_MS ||
    '15000',
  10,
);
export const MAIN_SUBSCRIPTION_WARM_WORKER_BOOT_TIMEOUT_MS = Number.isFinite(
  mainSubscriptionWarmWorkerBootTimeoutMs,
)
  ? Math.max(1_000, mainSubscriptionWarmWorkerBootTimeoutMs)
  : 15_000;
