import { randomUUID } from 'crypto';
import path from 'path';

import { getDb } from '../../db.js';
import { DATA_DIR, TIMEZONE } from '../../config.js';

export interface BrowserProfileRecord {
  id: string;
  site_key: string;
  account_label: string | null;
  profile_path: string;
  channel: string;
  locale: string;
  timezone_id: string;
  user_agent: string | null;
  viewport_json: string;
  policy_json: string | null;
  download_dir: string;
  connection_mode: string;
  connection_config_json: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export type BrowserConnectionMode = 'managed' | 'chrome_profile' | 'cdp';

export type BrowserConnectionConfig =
  | { mode: 'managed' }
  | {
      mode: 'chrome_profile';
      chromeProfilePath: string;
      profileDirectory?: string;
    }
  | { mode: 'cdp'; endpointUrl: string };

export interface BrowserProfileSnapshot {
  id: string;
  siteKey: string;
  accountLabel: string | null;
  profilePath: string;
  channel: string;
  locale: string;
  timezoneId: string;
  userAgent: string | null;
  viewport: BrowserViewport;
  policy: Record<string, unknown> | null;
  downloadDir: string;
  connectionMode: BrowserConnectionMode;
  connectionConfig: BrowserConnectionConfig;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface BrowserProfileUsageSnapshot {
  inUseSessionCount: number;
  currentSessionState: BrowserPersistedSessionState | null;
}

export type BrowserPersistedSessionState =
  | 'active'
  | 'blocked'
  | 'takeover'
  | 'disconnected'
  | 'closed';

export type BrowserPersistedBlockedReason =
  | 'login_required'
  | 'phone_approval'
  | 'app_approval'
  | 'code_entry'
  | 'session_conflict'
  | 'manual_takeover';

export interface BrowserSessionRecord {
  id: string;
  user_id: string | null;
  profile_id: string | null;
  profile_key: string;
  site_key: string;
  account_label: string | null;
  state: BrowserPersistedSessionState;
  blocked_reason: BrowserPersistedBlockedReason | null;
  owner_run_id: string | null;
  last_seen_at: string;
  last_live_context_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrowserSessionSnapshot {
  id: string;
  userId: string | null;
  profileId: string | null;
  profileKey: string;
  siteKey: string;
  accountLabel: string | null;
  state: BrowserPersistedSessionState;
  blockedReason: BrowserPersistedBlockedReason | null;
  ownerRunId: string | null;
  lastSeenAt: string;
  lastLiveContextAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_VIEWPORT: BrowserViewport = { width: 1280, height: 720 };
const DEFAULT_CHANNEL = 'chrome';
const DEFAULT_LOCALE = 'en-US';

function normalizeSiteKey(siteKey: string): string {
  const trimmed = siteKey.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('siteKey is required');
  }
  if (!/^[a-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      'siteKey must contain only lowercase letters, digits, dots, underscores, or hyphens.',
    );
  }
  return trimmed;
}

function normalizeAccountLabel(accountLabel?: string | null): string | null {
  const trimmed = accountLabel?.trim() || '';
  return trimmed ? trimmed : null;
}

function slugSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'default';
}

function slugForPaths(siteKey: string, accountLabel: string | null): string {
  return accountLabel ? `${siteKey}--${slugSegment(accountLabel)}` : siteKey;
}

export function buildBrowserProfileKey(
  siteKey: string,
  accountLabel?: string | null,
): string {
  const normalizedSiteKey = normalizeSiteKey(siteKey);
  const normalizedAccountLabel = normalizeAccountLabel(accountLabel);
  return normalizedAccountLabel
    ? `${normalizedSiteKey}::${normalizedAccountLabel}`
    : normalizedSiteKey;
}

function buildProfilePath(
  siteKey: string,
  accountLabel: string | null,
): string {
  return path.join(
    DATA_DIR,
    'browser-profiles',
    slugForPaths(siteKey, accountLabel),
  );
}

function buildDownloadDir(
  siteKey: string,
  accountLabel: string | null,
): string {
  return path.join(
    DATA_DIR,
    'browser-downloads',
    slugForPaths(siteKey, accountLabel),
  );
}

function parseViewport(valueJson: string): BrowserViewport {
  try {
    const parsed = JSON.parse(valueJson) as Partial<BrowserViewport>;
    if (
      typeof parsed.width === 'number' &&
      parsed.width > 0 &&
      typeof parsed.height === 'number' &&
      parsed.height > 0
    ) {
      return {
        width: Math.floor(parsed.width),
        height: Math.floor(parsed.height),
      };
    }
  } catch {
    // fall through
  }
  return { ...DEFAULT_VIEWPORT };
}

function parsePolicy(
  valueJson: string | null | undefined,
): Record<string, unknown> | null {
  if (!valueJson) return null;
  try {
    const parsed = JSON.parse(valueJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return null;
}

function parseConnectionConfig(
  mode: string | null | undefined,
  configJson: string | null | undefined,
): {
  connectionMode: BrowserConnectionMode;
  connectionConfig: BrowserConnectionConfig;
} {
  const connectionMode: BrowserConnectionMode =
    mode === 'chrome_profile' || mode === 'cdp' ? mode : 'managed';

  if (connectionMode === 'managed') {
    return { connectionMode, connectionConfig: { mode: 'managed' } };
  }

  if (configJson) {
    try {
      const parsed = JSON.parse(configJson) as Record<string, unknown>;
      if (
        connectionMode === 'chrome_profile' &&
        typeof parsed.chromeProfilePath === 'string'
      ) {
        const profileDirectory =
          typeof parsed.profileDirectory === 'string' &&
          parsed.profileDirectory.trim()
            ? parsed.profileDirectory.trim()
            : undefined;
        return {
          connectionMode,
          connectionConfig: {
            mode: 'chrome_profile',
            chromeProfilePath: parsed.chromeProfilePath,
            ...(profileDirectory ? { profileDirectory } : {}),
          },
        };
      }
      if (connectionMode === 'cdp' && typeof parsed.endpointUrl === 'string') {
        return {
          connectionMode,
          connectionConfig: { mode: 'cdp', endpointUrl: parsed.endpointUrl },
        };
      }
    } catch {
      // fall through to default
    }
  }

  // Mode is set but config is missing/invalid — fall back to managed
  return { connectionMode: 'managed', connectionConfig: { mode: 'managed' } };
}

function toSnapshot(row: BrowserProfileRecord): BrowserProfileSnapshot {
  const { connectionMode, connectionConfig } = parseConnectionConfig(
    row.connection_mode,
    row.connection_config_json,
  );
  return {
    id: row.id,
    siteKey: row.site_key,
    accountLabel: row.account_label,
    profilePath: row.profile_path,
    channel: row.channel,
    locale: row.locale,
    timezoneId: row.timezone_id,
    userAgent: row.user_agent,
    viewport: parseViewport(row.viewport_json),
    policy: parsePolicy(row.policy_json),
    downloadDir: row.download_dir,
    connectionMode,
    connectionConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function toSessionSnapshot(row: BrowserSessionRecord): BrowserSessionSnapshot {
  return {
    id: row.id,
    userId: row.user_id,
    profileId: row.profile_id,
    profileKey: row.profile_key,
    siteKey: row.site_key,
    accountLabel: row.account_label,
    state: row.state,
    blockedReason: row.blocked_reason,
    ownerRunId: row.owner_run_id,
    lastSeenAt: row.last_seen_at,
    lastLiveContextAt: row.last_live_context_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getBrowserProfile(
  siteKey: string,
  accountLabel?: string | null,
): BrowserProfileSnapshot | null {
  const normalizedSiteKey = normalizeSiteKey(siteKey);
  const normalizedAccountLabel = normalizeAccountLabel(accountLabel);
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM browser_profiles
      WHERE site_key = ?
        AND (
          (account_label IS NULL AND ? IS NULL)
          OR account_label = ?
        )
      LIMIT 1
    `,
    )
    .get(normalizedSiteKey, normalizedAccountLabel, normalizedAccountLabel) as
    | BrowserProfileRecord
    | undefined;
  return row ? toSnapshot(row) : null;
}

export function getBrowserProfileById(
  profileId: string,
): BrowserProfileSnapshot | null {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM browser_profiles
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(profileId) as BrowserProfileRecord | undefined;
  return row ? toSnapshot(row) : null;
}

export function ensureBrowserProfile(input: {
  siteKey: string;
  accountLabel?: string | null;
}): { profile: BrowserProfileSnapshot; created: boolean } {
  const siteKey = normalizeSiteKey(input.siteKey);
  const accountLabel = normalizeAccountLabel(input.accountLabel);
  const existing = getBrowserProfile(siteKey, accountLabel);
  if (existing) {
    return { profile: existing, created: false };
  }

  const now = new Date().toISOString();
  const id = `bp_${randomUUID()}`;
  const profilePath = buildProfilePath(siteKey, accountLabel);
  const downloadDir = buildDownloadDir(siteKey, accountLabel);

  getDb()
    .prepare(
      `
      INSERT INTO browser_profiles (
        id,
        site_key,
        account_label,
        profile_path,
        channel,
        locale,
        timezone_id,
        user_agent,
        viewport_json,
        policy_json,
        download_dir,
        connection_mode,
        connection_config_json,
        created_at,
        updated_at,
        last_used_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed', NULL, ?, ?, NULL)
    `,
    )
    .run(
      id,
      siteKey,
      accountLabel,
      profilePath,
      DEFAULT_CHANNEL,
      DEFAULT_LOCALE,
      TIMEZONE,
      null,
      JSON.stringify(DEFAULT_VIEWPORT),
      null,
      downloadDir,
      now,
      now,
    );

  const created = getBrowserProfileById(id);
  if (!created) {
    throw new Error('Failed to create browser profile');
  }
  return { profile: created, created: true };
}

export function touchBrowserProfileLastUsed(profileId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE browser_profiles
      SET last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(now, now, profileId);
}

export function getBrowserSessionById(
  sessionId: string,
): BrowserSessionSnapshot | null {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM browser_sessions
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(sessionId) as BrowserSessionRecord | undefined;
  return row ? toSessionSnapshot(row) : null;
}

export function listBrowserSessionsByOwnerRun(
  ownerRunId: string,
): BrowserSessionSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM browser_sessions
      WHERE owner_run_id = ?
      ORDER BY updated_at DESC, id DESC
    `,
    )
    .all(ownerRunId) as BrowserSessionRecord[];
  return rows.map(toSessionSnapshot);
}

export function listBrowserSessionsByProfile(input: {
  profileId?: string | null;
  siteKey?: string | null;
  accountLabel?: string | null;
}): BrowserSessionSnapshot[] {
  if (input.profileId) {
    const rows = getDb()
      .prepare(
        `
        SELECT *
        FROM browser_sessions
        WHERE profile_id = ?
        ORDER BY updated_at DESC, id DESC
      `,
      )
      .all(input.profileId) as BrowserSessionRecord[];
    return rows.map(toSessionSnapshot);
  }
  if (input.siteKey) {
    const profileKey = buildBrowserProfileKey(
      input.siteKey,
      input.accountLabel,
    );
    const rows = getDb()
      .prepare(
        `
        SELECT *
        FROM browser_sessions
        WHERE profile_key = ?
        ORDER BY updated_at DESC, id DESC
      `,
      )
      .all(profileKey) as BrowserSessionRecord[];
    return rows.map(toSessionSnapshot);
  }
  return [];
}

export function markBrowserSessionDisconnected(
  sessionId: string,
  now = new Date().toISOString(),
): BrowserSessionSnapshot | null {
  getDb()
    .prepare(
      `
      UPDATE browser_sessions
      SET state = 'disconnected',
          updated_at = ?,
          last_seen_at = ?,
          last_live_context_at = NULL
      WHERE id = ?
    `,
    )
    .run(now, now, sessionId);
  return getBrowserSessionById(sessionId);
}

export function upsertBrowserSessionState(input: {
  id: string;
  userId?: string | null;
  profileId?: string | null;
  siteKey: string;
  accountLabel?: string | null;
  state: BrowserPersistedSessionState;
  blockedReason?: BrowserPersistedBlockedReason | null;
  ownerRunId?: string | null;
  lastSeenAt?: string | null;
  lastLiveContextAt?: string | null;
  updatedAt?: string | null;
}): BrowserSessionSnapshot {
  const now = input.updatedAt?.trim() || new Date().toISOString();
  const lastSeenAt = input.lastSeenAt?.trim() || now;
  const normalizedSiteKey = normalizeSiteKey(input.siteKey);
  const normalizedAccountLabel = normalizeAccountLabel(input.accountLabel);
  const profileKey = buildBrowserProfileKey(
    normalizedSiteKey,
    normalizedAccountLabel,
  );
  getDb()
    .prepare(
      `
      INSERT INTO browser_sessions (
        id,
        user_id,
        profile_id,
        profile_key,
        site_key,
        account_label,
        state,
        blocked_reason,
        owner_run_id,
        last_seen_at,
        last_live_context_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = COALESCE(excluded.user_id, browser_sessions.user_id),
        profile_id = COALESCE(excluded.profile_id, browser_sessions.profile_id),
        profile_key = excluded.profile_key,
        site_key = excluded.site_key,
        account_label = excluded.account_label,
        state = excluded.state,
        blocked_reason = excluded.blocked_reason,
        owner_run_id = excluded.owner_run_id,
        last_seen_at = excluded.last_seen_at,
        last_live_context_at = COALESCE(excluded.last_live_context_at, browser_sessions.last_live_context_at),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.id,
      input.userId ?? null,
      input.profileId ?? null,
      profileKey,
      normalizedSiteKey,
      normalizedAccountLabel,
      input.state,
      input.blockedReason ?? null,
      input.ownerRunId ?? null,
      lastSeenAt,
      input.lastLiveContextAt ?? null,
      now,
      now,
    );

  const snapshot = getBrowserSessionById(input.id);
  if (!snapshot) {
    throw new Error(`Failed to persist browser session ${input.id}`);
  }
  return snapshot;
}

export function listAllBrowserProfiles(): BrowserProfileSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM browser_profiles
      ORDER BY site_key ASC, account_label ASC
    `,
    )
    .all() as BrowserProfileRecord[];
  return rows.map(toSnapshot);
}

export function getBrowserProfileUsage(
  profileId: string,
): BrowserProfileUsageSnapshot {
  const rows = getDb()
    .prepare(
      `
      SELECT state
      FROM browser_sessions
      WHERE profile_id = ?
        AND state IN ('active', 'blocked', 'takeover')
      ORDER BY updated_at DESC, id DESC
    `,
    )
    .all(profileId) as Array<{ state: BrowserPersistedSessionState }>;

  return {
    inUseSessionCount: rows.length,
    currentSessionState: rows[0]?.state ?? null,
  };
}

export function updateBrowserProfileConnectionMode(
  profileId: string,
  mode: BrowserConnectionMode,
  configJson: string | null,
): BrowserProfileSnapshot | null {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE browser_profiles
      SET connection_mode = ?,
          connection_config_json = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(mode, configJson, now, profileId);
  return getBrowserProfileById(profileId);
}

export function deleteBrowserProfile(profileId: string): boolean {
  const result = getDb()
    .prepare(
      `
      DELETE FROM browser_profiles
      WHERE id = ?
    `,
    )
    .run(profileId);
  return result.changes > 0;
}

function chromeProfileSelectionsConflict(input: {
  leftPath: string;
  leftProfileDirectory?: string | null;
  rightPath: string;
  rightProfileDirectory?: string | null;
}): boolean {
  if (input.leftPath !== input.rightPath) {
    return false;
  }

  const leftProfileDirectory = input.leftProfileDirectory?.trim() || null;
  const rightProfileDirectory = input.rightProfileDirectory?.trim() || null;

  // A root-only selection is ambiguous and can overlap any specific subprofile
  // under the same Chrome user-data directory.
  if (!leftProfileDirectory || !rightProfileDirectory) {
    return true;
  }

  return leftProfileDirectory === rightProfileDirectory;
}

export function checkBrowserProfileConnectionUniqueness(input: {
  mode: BrowserConnectionMode;
  configJson: string | null;
  excludeProfileId?: string | null;
}): {
  conflict: boolean;
  conflictProfileId?: string;
  conflictSiteKey?: string;
} {
  if (input.mode === 'managed' || !input.configJson) {
    return { conflict: false };
  }

  try {
    const parsed = JSON.parse(input.configJson) as Record<string, unknown>;
    const chromeProfilePath =
      input.mode === 'chrome_profile' &&
      typeof parsed.chromeProfilePath === 'string'
        ? parsed.chromeProfilePath
        : null;
    const chromeProfileDirectory =
      input.mode === 'chrome_profile' &&
      typeof parsed.profileDirectory === 'string'
        ? parsed.profileDirectory
        : null;
    const endpointUrl =
      input.mode === 'cdp' && typeof parsed.endpointUrl === 'string'
        ? parsed.endpointUrl
        : null;

    if (
      (input.mode === 'chrome_profile' && !chromeProfilePath) ||
      (input.mode === 'cdp' && !endpointUrl)
    ) {
      return { conflict: false };
    }

    // Search existing profiles for duplicates
    const rows = getDb()
      .prepare(
        `
        SELECT id, site_key, connection_config_json
        FROM browser_profiles
        WHERE connection_mode = ?
          AND connection_config_json IS NOT NULL
          AND id != ?
      `,
      )
      .all(input.mode, input.excludeProfileId ?? '') as Array<{
      id: string;
      site_key: string;
      connection_config_json: string;
    }>;

    for (const row of rows) {
      try {
        const existingConfig = JSON.parse(row.connection_config_json) as Record<
          string,
          unknown
        >;

        if (input.mode === 'chrome_profile') {
          if (typeof existingConfig.chromeProfilePath !== 'string') {
            continue;
          }
          const existingProfileDirectory =
            typeof existingConfig.profileDirectory === 'string'
              ? existingConfig.profileDirectory
              : null;
          if (
            chromeProfileSelectionsConflict({
              leftPath: existingConfig.chromeProfilePath,
              leftProfileDirectory: existingProfileDirectory,
              rightPath: chromeProfilePath!,
              rightProfileDirectory: chromeProfileDirectory,
            })
          ) {
            return {
              conflict: true,
              conflictProfileId: row.id,
              conflictSiteKey: row.site_key,
            };
          }
          continue;
        }

        if (existingConfig.endpointUrl === endpointUrl) {
          return {
            conflict: true,
            conflictProfileId: row.id,
            conflictSiteKey: row.site_key,
          };
        }
      } catch {
        // ignore parse errors in existing rows
      }
    }
  } catch {
    // ignore parse errors
  }

  return { conflict: false };
}

export function hasNonterminalBrowserSessions(profileId: string): boolean {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) as cnt
      FROM browser_sessions
      WHERE profile_id = ?
        AND state IN ('active', 'blocked', 'takeover')
    `,
    )
    .get(profileId) as { cnt: number } | undefined;
  return (row?.cnt ?? 0) > 0;
}

export function reconcileBrowserSessionsOnStartup(
  now = new Date().toISOString(),
): number {
  const result = getDb()
    .prepare(
      `
      UPDATE browser_sessions
      SET state = 'disconnected',
          updated_at = ?,
          last_seen_at = ?,
          last_live_context_at = NULL
      WHERE state IN ('active', 'blocked', 'takeover')
    `,
    )
    .run(now, now);
  return result.changes;
}
