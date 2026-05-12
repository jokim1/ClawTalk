import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import { refreshMainThreadSummary } from '../agents/main-context-loader.js';
import type { BrowserBlockMetadata } from '../browser/metadata.js';
import { notifyOutboxEvent } from '../channels/outbox-notifier.js';
import {
  inferThreadTitleFromContent,
  isLegacyPlaceholderTalkThreadTitle,
  normalizeStoredThreadTitle,
  validateEditableThreadTitle,
} from './thread-title-utils.js';
import {
  TalkAccessRole,
  TalkMessageRole,
  TalkRunStatus,
  UserRole,
  UserType,
} from '../types.js';
// Stubs for removed tool-manager-accessors (tool grants now live on registered_agents)
function initializeTalkToolGrants(_talkId: string, _updatedBy: string): void {
  // No-op: tool permissions are now per-agent via tool_permissions_json
}
function supersedePendingTalkActionConfirmationsForRun(_input: {
  runId: string;
  resolvedBy?: string | null;
  reason?: string | null;
}): number {
  // No-op: confirmations now use run_confirmations table
  return 0;
}

// --- Identity and web session accessors ---

export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  user_type: UserType;
  role: UserRole;
  is_active: number;
  created_at: string;
  last_login_at: string | null;
}

export function upsertUser(input: {
  id: string;
  email: string;
  displayName: string;
  userType?: UserType;
  role?: UserRole;
  isActive?: boolean;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
    INSERT INTO users (id, email, display_name, user_type, role, is_active, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name,
      user_type = excluded.user_type,
      role = excluded.role,
      is_active = excluded.is_active
  `,
    )
    .run(
      input.id,
      input.email,
      input.displayName,
      input.userType || 'human',
      input.role || 'member',
      input.isActive === false ? 0 : 1,
      now,
      now,
    );
}

export function updateUserDisplayName(
  userId: string,
  displayName: string,
): void {
  getDb()
    .prepare('UPDATE users SET display_name = ? WHERE id = ?')
    .run(displayName, userId);
}

export function getUserById(userId: string): UserRecord | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as
    | UserRecord
    | undefined;
}

export function getUserByEmail(email: string): UserRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(email) as UserRecord | undefined;
}

export function getOwnerUser(): UserRecord | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM users WHERE role = 'owner' AND is_active = 1 AND user_type = 'human' ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as UserRecord | undefined;
}

export function hasAnyUsers(): boolean {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND user_type = 'human'",
    )
    .get() as { count: number };
  return row.count > 0;
}

export interface WebSessionRecord {
  id: string;
  user_id: string;
  access_token_hash: string;
  refresh_token_hash: string;
  access_expires_at: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_from: string | null;
  device_id: string | null;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export function upsertWebSession(input: {
  id: string;
  userId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt?: string;
  expiresAt: string;
  revokedAt?: string | null;
  rotatedFrom?: string | null;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO web_sessions (
      id, user_id, access_token_hash, refresh_token_hash, access_expires_at, expires_at, revoked_at,
      rotated_from, device_id, created_at, ip_address, user_agent
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token_hash = excluded.access_token_hash,
      refresh_token_hash = excluded.refresh_token_hash,
      access_expires_at = excluded.access_expires_at,
      expires_at = excluded.expires_at,
      revoked_at = excluded.revoked_at,
      rotated_from = excluded.rotated_from,
      device_id = excluded.device_id,
      ip_address = excluded.ip_address,
      user_agent = excluded.user_agent
  `,
    )
    .run(
      input.id,
      input.userId,
      input.accessTokenHash,
      input.refreshTokenHash,
      input.accessExpiresAt || input.expiresAt,
      input.expiresAt,
      input.revokedAt || null,
      input.rotatedFrom || null,
      input.deviceId || null,
      new Date().toISOString(),
      input.ipAddress || null,
      input.userAgent || null,
    );
}

export function getWebSessionByAccessTokenHash(
  accessTokenHash: string,
): WebSessionRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT * FROM web_sessions
      WHERE access_token_hash = ?
        AND revoked_at IS NULL
        AND COALESCE(access_expires_at, expires_at) > ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(accessTokenHash, new Date().toISOString()) as
    | WebSessionRecord
    | undefined;
}

export function getWebSessionByRefreshTokenHash(
  refreshTokenHash: string,
): WebSessionRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT * FROM web_sessions
      WHERE refresh_token_hash = ?
        AND revoked_at IS NULL
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(refreshTokenHash, new Date().toISOString()) as
    | WebSessionRecord
    | undefined;
}

export function revokeWebSession(sessionId: string, revokedAt?: string): void {
  getDb()
    .prepare(`UPDATE web_sessions SET revoked_at = ? WHERE id = ?`)
    .run(revokedAt || new Date().toISOString(), sessionId);
}

export function revokeWebSessionChain(rootSessionId: string): void {
  const now = new Date().toISOString();
  const pending = [rootSessionId];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    revokeWebSession(next, now);
    const children = getDb()
      .prepare(`SELECT id FROM web_sessions WHERE rotated_from = ?`)
      .all(next) as Array<{ id: string }>;
    for (const child of children) pending.push(child.id);
  }
}

// --- Invite accessors ---

export interface UserInviteRecord {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string;
  accepted: number;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export function createUserInvite(input: {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invitedBy: string;
  expiresAt: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO user_invites (
      id, email, role, invited_by, accepted, created_at, expires_at, accepted_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)
  `,
    )
    .run(
      input.id,
      input.email.toLowerCase(),
      input.role,
      input.invitedBy,
      new Date().toISOString(),
      input.expiresAt,
    );
}

export function getActiveInviteByEmail(
  email: string,
): UserInviteRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM user_invites
      WHERE email = ? COLLATE NOCASE
        AND accepted = 0
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(email, new Date().toISOString()) as UserInviteRecord | undefined;
}

export function markInviteAccepted(inviteId: string): void {
  getDb()
    .prepare(
      `
    UPDATE user_invites
    SET accepted = 1, accepted_at = ?
    WHERE id = ?
  `,
    )
    .run(new Date().toISOString(), inviteId);
}

// --- OAuth state accessors ---

export interface OAuthStateRecord {
  id: string;
  provider: string;
  state_hash: string;
  nonce_hash: string;
  code_verifier_hash: string;
  code_verifier: string | null;
  redirect_uri: string;
  return_to: string | null;
  requested_by_user_id: string | null;
  requested_by_session_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export function createOAuthState(input: {
  id: string;
  provider: string;
  stateHash: string;
  nonceHash: string;
  codeVerifierHash: string;
  codeVerifier?: string;
  redirectUri: string;
  returnTo?: string;
  requestedByUserId?: string | null;
  requestedBySessionId?: string | null;
  expiresAt: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO oauth_state (
      id, provider, state_hash, nonce_hash, code_verifier_hash, code_verifier, redirect_uri, return_to,
      requested_by_user_id, requested_by_session_id, created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `,
    )
    .run(
      input.id,
      input.provider,
      input.stateHash,
      input.nonceHash,
      input.codeVerifierHash,
      input.codeVerifier || null,
      input.redirectUri,
      input.returnTo || null,
      input.requestedByUserId || null,
      input.requestedBySessionId || null,
      new Date().toISOString(),
      input.expiresAt,
    );
}

export function consumeOAuthStateByHash(
  stateHash: string,
): OAuthStateRecord | undefined {
  const now = new Date().toISOString();
  const tx = getDb().transaction(
    (
      hashedState: string,
      currentTime: string,
    ): OAuthStateRecord | undefined => {
      const row = getDb()
        .prepare(
          `
          SELECT *
          FROM oauth_state
          WHERE state_hash = ?
            AND used_at IS NULL
            AND expires_at > ?
          LIMIT 1
        `,
        )
        .get(hashedState, currentTime) as OAuthStateRecord | undefined;
      if (!row) return undefined;

      const updated = getDb()
        .prepare(
          `
          UPDATE oauth_state
          SET used_at = ?
          WHERE id = ?
            AND used_at IS NULL
            AND expires_at > ?
        `,
        )
        .run(currentTime, row.id, currentTime);
      if (updated.changes !== 1) return undefined;

      return { ...row, used_at: currentTime };
    },
  );

  return tx(stateHash, now);
}

// --- Device auth code accessors ---

export interface DeviceAuthCodeRecord {
  id: string;
  device_code_hash: string;
  user_code_hash: string;
  status: 'pending' | 'completed' | 'expired';
  user_id: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

export function createDeviceAuthCode(input: {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  expiresAt: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO device_auth_codes (
      id, device_code_hash, user_code_hash, status, user_id, created_at, expires_at, completed_at
    ) VALUES (?, ?, ?, 'pending', NULL, ?, ?, NULL)
  `,
    )
    .run(
      input.id,
      input.deviceCodeHash,
      input.userCodeHash,
      new Date().toISOString(),
      input.expiresAt,
    );
}

export function getPendingDeviceAuthCodeByDeviceHash(
  deviceCodeHash: string,
): DeviceAuthCodeRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM device_auth_codes
      WHERE device_code_hash = ?
        AND status = 'pending'
        AND expires_at > ?
      LIMIT 1
    `,
    )
    .get(deviceCodeHash, new Date().toISOString()) as
    | DeviceAuthCodeRecord
    | undefined;
}

export function markDeviceAuthCodeCompleted(input: {
  id: string;
  userId: string;
}): void {
  getDb()
    .prepare(
      `
    UPDATE device_auth_codes
    SET status = 'completed', user_id = ?, completed_at = ?
    WHERE id = ?
  `,
    )
    .run(input.userId, new Date().toISOString(), input.id);
}

// --- Talk ACL accessors ---

export interface TalkRecord {
  id: string;
  owner_id: string;
  folder_id: string | null;
  sort_order: number;
  topic_title: string | null;
  project_path: string | null;
  orchestration_mode: 'ordered' | 'panel';
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TalkFolderRecord {
  id: string;
  owner_id: string;
  title: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type TalkAccessLevel = 'owner' | 'admin' | 'editor' | 'viewer';

export interface TalkWithAccessRecord extends TalkRecord {
  access_role: TalkAccessLevel;
  llm_policy: string | null;
}

export interface TalkExecutorSessionRecord {
  talk_id: string;
  session_id: string;
  executor_alias: string;
  executor_model: string;
  session_compat_key: string;
  updated_at: string;
}

export interface TalkListPage {
  limit: number;
  offset: number;
}

export interface TalkSidebarTalkRecord {
  id: string;
  owner_id: string;
  folder_id: string | null;
  sort_order: number;
  topic_title: string | null;
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
  access_role: TalkAccessLevel;
  llm_policy: string | null;
  last_message_at: string | null;
  message_count: number;
  has_active_run: boolean;
}

export interface TalkSidebarTreeRecord {
  folders: TalkFolderRecord[];
  rootTalks: TalkSidebarTalkRecord[];
  talksByFolderId: Record<string, TalkSidebarTalkRecord[]>;
}

export interface SettingRecord {
  key: string;
  value: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export function normalizeTalkListPage(input?: {
  limit?: number;
  offset?: number;
}): TalkListPage {
  const limit =
    typeof input?.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 50;
  const offset =
    typeof input?.offset === 'number'
      ? Math.max(0, Math.floor(input.offset))
      : 0;
  return { limit, offset };
}

export function getSettingValue(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM settings_kv WHERE key = ? LIMIT 1`)
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function upsertSettingValue(input: {
  key: string;
  value: string | null;
  updatedBy?: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO settings_kv (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(input.key, input.value, now, input.updatedBy ?? null);
}

export function deleteSettingValue(key: string): void {
  getDb().prepare(`DELETE FROM settings_kv WHERE key = ?`).run(key);
}

function bumpRootSortOrders(ownerId: string): void {
  getDb()
    .prepare(
      `
      UPDATE talks
      SET sort_order = sort_order + 1
      WHERE owner_id = ? AND folder_id IS NULL
    `,
    )
    .run(ownerId);
  getDb()
    .prepare(
      `
      UPDATE talk_folders
      SET sort_order = sort_order + 1
      WHERE owner_id = ?
    `,
    )
    .run(ownerId);
}

function writeRootSidebarOrder(
  ownerId: string,
  items: Array<{ type: 'talk' | 'folder'; id: string }>,
): void {
  const updateTalk = getDb().prepare(
    `
      UPDATE talks
      SET sort_order = ?
      WHERE id = ? AND owner_id = ? AND folder_id IS NULL
    `,
  );
  const updateFolder = getDb().prepare(
    `
      UPDATE talk_folders
      SET sort_order = ?
      WHERE id = ? AND owner_id = ?
    `,
  );
  items.forEach((item, index) => {
    if (item.type === 'talk') {
      updateTalk.run(index, item.id, ownerId);
    } else {
      updateFolder.run(index, item.id, ownerId);
    }
  });
}

function writeFolderTalkOrder(
  ownerId: string,
  folderId: string,
  talkIds: string[],
): void {
  const updateTalk = getDb().prepare(
    `
      UPDATE talks
      SET sort_order = ?
      WHERE id = ? AND owner_id = ? AND folder_id = ?
    `,
  );
  talkIds.forEach((talkId, index) => {
    updateTalk.run(index, talkId, ownerId, folderId);
  });
}

function listOwnedRootSidebarItems(ownerId: string): Array<{
  type: 'talk' | 'folder';
  id: string;
  sort_order: number;
}> {
  return getDb()
    .prepare(
      `
      SELECT 'talk' AS type, id, sort_order
      FROM talks
      WHERE owner_id = ? AND folder_id IS NULL
      UNION ALL
      SELECT 'folder' AS type, id, sort_order
      FROM talk_folders
      WHERE owner_id = ?
      ORDER BY sort_order ASC, id ASC
    `,
    )
    .all(ownerId, ownerId) as Array<{
    type: 'talk' | 'folder';
    id: string;
    sort_order: number;
  }>;
}

function listOwnedFolderTalkIds(ownerId: string, folderId: string): string[] {
  return getDb()
    .prepare(
      `
      SELECT id
      FROM talks
      WHERE owner_id = ? AND folder_id = ?
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `,
    )
    .all(ownerId, folderId)
    .map((row) => (row as { id: string }).id);
}

function getTalkFolderByIdForOwner(
  folderId: string,
  ownerId: string,
): TalkFolderRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_folders
      WHERE id = ? AND owner_id = ?
      LIMIT 1
    `,
    )
    .get(folderId, ownerId) as TalkFolderRecord | undefined;
}

function appendTalksToTopLevel(ownerId: string, talkIds: string[]): void {
  if (talkIds.length === 0) return;
  const maxRootTalk = getDb()
    .prepare(
      `
      SELECT COALESCE(MAX(sort_order), -1) AS value
      FROM talks
      WHERE owner_id = ? AND folder_id IS NULL
    `,
    )
    .get(ownerId) as { value: number };
  const maxRootFolder = getDb()
    .prepare(
      `
      SELECT COALESCE(MAX(sort_order), -1) AS value
      FROM talk_folders
      WHERE owner_id = ?
    `,
    )
    .get(ownerId) as { value: number };
  let nextSort = Math.max(maxRootTalk.value, maxRootFolder.value) + 1;
  const update = getDb().prepare(
    `
      UPDATE talks
      SET folder_id = NULL, sort_order = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `,
  );
  const now = new Date().toISOString();
  talkIds.forEach((talkId) => {
    update.run(nextSort, now, talkId, ownerId);
    nextSort += 1;
  });
}

export function createTalk(input: {
  id: string;
  ownerId: string;
  topicTitle?: string;
  orchestrationMode?: 'ordered' | 'panel';
  status?: 'active' | 'paused' | 'archived';
}): void {
  const tx = getDb().transaction((txInput: typeof input) => {
    const now = new Date().toISOString();
    bumpRootSortOrders(txInput.ownerId);
    getDb()
      .prepare(
        `
      INSERT INTO talks (
        id, owner_id, folder_id, sort_order, topic_title, project_path, orchestration_mode,
        status, version, created_at, updated_at
      )
      VALUES (?, ?, NULL, 0, ?, NULL, ?, ?, 1, ?, ?)
    `,
      )
      .run(
        txInput.id,
        txInput.ownerId,
        txInput.topicTitle || null,
        txInput.orchestrationMode || 'ordered',
        txInput.status || 'active',
        now,
        now,
      );
    getOrCreateDefaultThread(txInput.id);
    initializeTalkToolGrants(txInput.id, txInput.ownerId);
  });
  tx(input);
}

export function getTalkById(talkId: string): TalkRecord | undefined {
  return getDb().prepare('SELECT * FROM talks WHERE id = ?').get(talkId) as
    | TalkRecord
    | undefined;
}

export function touchTalkUpdatedAt(talkId: string, updatedAt?: string): void {
  getDb()
    .prepare('UPDATE talks SET updated_at = ? WHERE id = ?')
    .run(updatedAt || new Date().toISOString(), talkId);
}

export function listTalksForUser(input: {
  userId: string;
  limit?: number;
  offset?: number;
  status?: 'active' | 'paused' | 'archived';
}): TalkWithAccessRecord[] {
  const user = getUserById(input.userId);
  if (!user || user.is_active !== 1) return [];
  const page = normalizeTalkListPage({
    limit: input.limit,
    offset: input.offset,
  });
  const statusFilter = input.status ?? null;

  if (user.role === 'owner' || user.role === 'admin') {
    // Global admin/owner role is authoritative here; membership role is not surfaced.
    const accessRole = user.role === 'owner' ? 'owner' : 'admin';
    return getDb()
      .prepare(
        `
        SELECT t.id, t.owner_id, t.topic_title, t.status, t.version, t.created_at, t.updated_at,
               t.folder_id, t.sort_order, t.project_path, t.orchestration_mode,
               p.llm_policy,
               CASE WHEN t.owner_id = ? THEN 'owner' ELSE ? END AS access_role
        FROM talks t
        LEFT JOIN talk_llm_policies p
          ON p.talk_id = t.id
        WHERE (? IS NULL OR t.status = ?)
        ORDER BY t.updated_at DESC, t.created_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(
        input.userId,
        accessRole,
        statusFilter,
        statusFilter,
        page.limit,
        page.offset,
      ) as TalkWithAccessRecord[];
  }

  return getDb()
    .prepare(
      `
      SELECT DISTINCT
        t.id,
        t.owner_id,
        t.folder_id,
        t.sort_order,
        t.project_path,
        t.orchestration_mode,
        t.topic_title,
        t.status,
        t.version,
        t.created_at,
        t.updated_at,
        p.llm_policy,
        CASE WHEN t.owner_id = ? THEN 'owner' ELSE tm.role END AS access_role
      FROM talks t
      LEFT JOIN talk_members tm
        ON tm.talk_id = t.id
       AND tm.user_id = ?
      LEFT JOIN talk_llm_policies p
        ON p.talk_id = t.id
      WHERE (t.owner_id = ? OR tm.user_id = ?)
        AND (? IS NULL OR t.status = ?)
      ORDER BY t.updated_at DESC, t.created_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      statusFilter,
      statusFilter,
      page.limit,
      page.offset,
    ) as TalkWithAccessRecord[];
}

export function getTalkForUser(
  talkId: string,
  userId: string,
): TalkWithAccessRecord | undefined {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return undefined;

  if (user.role === 'owner' || user.role === 'admin') {
    // Global admin/owner role is authoritative here; membership role is not surfaced.
    const row = getDb()
      .prepare(
        `
        SELECT t.id, t.owner_id, t.topic_title, t.status, t.version, t.created_at, t.updated_at,
               t.folder_id, t.sort_order, t.project_path, t.orchestration_mode,
               p.llm_policy,
               CASE WHEN t.owner_id = ? THEN 'owner' ELSE ? END AS access_role
        FROM talks t
        LEFT JOIN talk_llm_policies p
          ON p.talk_id = t.id
        WHERE t.id = ?
        LIMIT 1
      `,
      )
      .get(userId, user.role === 'owner' ? 'owner' : 'admin', talkId) as
      | TalkWithAccessRecord
      | undefined;
    return row;
  }

  const row = getDb()
    .prepare(
      `
      SELECT
        t.id,
        t.owner_id,
        t.folder_id,
        t.sort_order,
        t.project_path,
        t.orchestration_mode,
        t.topic_title,
        t.status,
        t.version,
        t.created_at,
        t.updated_at,
        p.llm_policy,
        CASE WHEN t.owner_id = ? THEN 'owner' ELSE tm.role END AS access_role
      FROM talks t
      LEFT JOIN talk_members tm
        ON tm.talk_id = t.id
       AND tm.user_id = ?
      LEFT JOIN talk_llm_policies p
        ON p.talk_id = t.id
      WHERE t.id = ?
        AND (t.owner_id = ? OR tm.user_id = ?)
      LIMIT 1
    `,
    )
    .get(userId, userId, talkId, userId, userId) as
    | TalkWithAccessRecord
    | undefined;
  return row;
}

export function upsertTalk(input: {
  id: string;
  ownerId: string;
  topicTitle?: string;
  orchestrationMode?: 'ordered' | 'panel';
  status?: 'active' | 'paused' | 'archived';
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
    INSERT INTO talks (
      id, owner_id, folder_id, sort_order, topic_title, project_path, orchestration_mode,
      status, version, created_at, updated_at
    )
    VALUES (?, ?, NULL, 0, ?, NULL, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      topic_title = excluded.topic_title,
      project_path = excluded.project_path,
      orchestration_mode = excluded.orchestration_mode,
      status = excluded.status,
      updated_at = excluded.updated_at,
      version = talks.version + 1
  `,
    )
    .run(
      input.id,
      input.ownerId,
      input.topicTitle || null,
      input.orchestrationMode || 'ordered',
      input.status || 'active',
      now,
      now,
    );
}

export function listTalkFoldersForOwner(ownerId: string): TalkFolderRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_folders
      WHERE owner_id = ?
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `,
    )
    .all(ownerId) as TalkFolderRecord[];
}

export function createTalkFolder(input: {
  id: string;
  ownerId: string;
  title: string;
}): TalkFolderRecord {
  const tx = getDb().transaction((txInput: typeof input) => {
    const now = new Date().toISOString();
    bumpRootSortOrders(txInput.ownerId);
    getDb()
      .prepare(
        `
        INSERT INTO talk_folders (id, owner_id, title, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `,
      )
      .run(txInput.id, txInput.ownerId, txInput.title, now, now);
    return getTalkFolderByIdForOwner(txInput.id, txInput.ownerId)!;
  });
  return tx(input);
}

export function renameTalkFolder(input: {
  id: string;
  ownerId: string;
  title: string;
}): TalkFolderRecord | undefined {
  getDb()
    .prepare(
      `
      UPDATE talk_folders
      SET title = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `,
    )
    .run(input.title, new Date().toISOString(), input.id, input.ownerId);
  return getTalkFolderByIdForOwner(input.id, input.ownerId);
}

export function deleteTalkFolderAndMoveTalksToTopLevel(input: {
  id: string;
  ownerId: string;
}): boolean {
  const tx = getDb().transaction((txInput: typeof input) => {
    const folder = getTalkFolderByIdForOwner(txInput.id, txInput.ownerId);
    if (!folder) return false;
    const talkIds = listOwnedFolderTalkIds(txInput.ownerId, txInput.id);
    appendTalksToTopLevel(txInput.ownerId, talkIds);
    getDb()
      .prepare('DELETE FROM talk_folders WHERE id = ? AND owner_id = ?')
      .run(txInput.id, txInput.ownerId);
    const remainingRoot = listOwnedRootSidebarItems(txInput.ownerId).map(
      (item) => ({
        type: item.type,
        id: item.id,
      }),
    );
    writeRootSidebarOrder(txInput.ownerId, remainingRoot);
    return true;
  });
  return tx(input);
}

export function patchTalkMetadata(input: {
  talkId: string;
  ownerId: string;
  title?: string;
  folderId?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
}): TalkRecord | undefined {
  const tx = getDb().transaction((txInput: typeof input) => {
    const talk = getTalkById(txInput.talkId);
    if (!talk || talk.owner_id !== txInput.ownerId) return undefined;

    const nextFolderId =
      txInput.folderId === undefined ? talk.folder_id : txInput.folderId;
    if (nextFolderId !== null && nextFolderId !== talk.folder_id) {
      const folder = getTalkFolderByIdForOwner(nextFolderId, txInput.ownerId);
      if (!folder) return undefined;
    }

    const now = new Date().toISOString();
    if (
      txInput.title !== undefined ||
      txInput.orchestrationMode !== undefined
    ) {
      getDb()
        .prepare(
          `
          UPDATE talks
          SET topic_title = COALESCE(?, topic_title),
              orchestration_mode = COALESCE(?, orchestration_mode),
              updated_at = ?,
              version = version + 1
          WHERE id = ? AND owner_id = ?
        `,
        )
        .run(
          txInput.title !== undefined ? txInput.title || null : null,
          txInput.orchestrationMode ?? null,
          now,
          txInput.talkId,
          txInput.ownerId,
        );
    }

    if (txInput.folderId !== undefined && txInput.folderId !== talk.folder_id) {
      const oldFolderId = talk.folder_id;
      const oldRootItems =
        oldFolderId === null
          ? listOwnedRootSidebarItems(txInput.ownerId)
              .filter(
                (item) => !(item.type === 'talk' && item.id === txInput.talkId),
              )
              .map((item) => ({ type: item.type, id: item.id }))
          : null;
      const oldFolderItems =
        oldFolderId !== null
          ? listOwnedFolderTalkIds(txInput.ownerId, oldFolderId).filter(
              (id) => id !== txInput.talkId,
            )
          : null;
      if (oldRootItems) {
        writeRootSidebarOrder(txInput.ownerId, oldRootItems);
      }
      if (oldFolderItems && oldFolderId) {
        writeFolderTalkOrder(txInput.ownerId, oldFolderId, oldFolderItems);
      }

      if (txInput.folderId === null) {
        appendTalksToTopLevel(txInput.ownerId, [txInput.talkId]);
      } else {
        const folderTalkIds = listOwnedFolderTalkIds(
          txInput.ownerId,
          txInput.folderId,
        );
        getDb()
          .prepare(
            `
            UPDATE talks
            SET folder_id = ?, sort_order = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND owner_id = ?
          `,
          )
          .run(
            txInput.folderId,
            folderTalkIds.length,
            now,
            txInput.talkId,
            txInput.ownerId,
          );
      }
    }

    return getTalkById(txInput.talkId);
  });
  return tx(input);
}

export function updateTalkProjectPath(input: {
  talkId: string;
  ownerId: string;
  projectPath: string | null;
}): TalkRecord | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE talks
      SET project_path = ?,
          updated_at = ?,
          version = version + 1
      WHERE id = ? AND owner_id = ?
    `,
    )
    .run(input.projectPath, now, input.talkId, input.ownerId);
  return getTalkById(input.talkId);
}

export function deleteTalkForOwner(input: {
  talkId: string;
  ownerId: string;
}): boolean {
  const tx = getDb().transaction((txInput: typeof input) => {
    const talk = getTalkById(txInput.talkId);
    if (!talk || talk.owner_id !== txInput.ownerId) return false;
    const oldFolderId = talk.folder_id;
    getDb()
      .prepare('DELETE FROM talks WHERE id = ? AND owner_id = ?')
      .run(txInput.talkId, txInput.ownerId);
    if (oldFolderId === null) {
      const remaining = listOwnedRootSidebarItems(txInput.ownerId).map(
        (item) => ({
          type: item.type,
          id: item.id,
        }),
      );
      writeRootSidebarOrder(txInput.ownerId, remaining);
    } else {
      const remaining = listOwnedFolderTalkIds(txInput.ownerId, oldFolderId);
      writeFolderTalkOrder(txInput.ownerId, oldFolderId, remaining);
    }
    return true;
  });
  return tx(input);
}

export function reorderTalkSidebarItem(input: {
  ownerId: string;
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): boolean {
  const tx = getDb().transaction((txInput: typeof input) => {
    if (txInput.itemType === 'folder' && txInput.destinationFolderId !== null) {
      return false;
    }

    const talk =
      txInput.itemType === 'talk' ? getTalkById(txInput.itemId) : undefined;
    const folder =
      txInput.itemType === 'folder'
        ? getTalkFolderByIdForOwner(txInput.itemId, txInput.ownerId)
        : undefined;

    if (txInput.itemType === 'talk') {
      if (!talk || talk.owner_id !== txInput.ownerId) return false;
      if (
        txInput.destinationFolderId !== null &&
        !getTalkFolderByIdForOwner(txInput.destinationFolderId, txInput.ownerId)
      ) {
        return false;
      }
    } else if (!folder) {
      return false;
    }

    if (txInput.itemType === 'folder') {
      const rootItems = listOwnedRootSidebarItems(txInput.ownerId)
        .filter(
          (item) => !(item.type === 'folder' && item.id === txInput.itemId),
        )
        .map((item) => ({ type: item.type, id: item.id }));
      const index = Math.max(
        0,
        Math.min(txInput.destinationIndex, rootItems.length),
      );
      rootItems.splice(index, 0, { type: 'folder', id: txInput.itemId });
      writeRootSidebarOrder(txInput.ownerId, rootItems);
      return true;
    }

    const sourceFolderId = talk!.folder_id;
    if (sourceFolderId === txInput.destinationFolderId) {
      if (sourceFolderId === null) {
        const rootItems = listOwnedRootSidebarItems(txInput.ownerId)
          .filter(
            (item) => !(item.type === 'talk' && item.id === txInput.itemId),
          )
          .map((item) => ({ type: item.type, id: item.id }));
        const index = Math.max(
          0,
          Math.min(txInput.destinationIndex, rootItems.length),
        );
        rootItems.splice(index, 0, { type: 'talk', id: txInput.itemId });
        writeRootSidebarOrder(txInput.ownerId, rootItems);
      } else {
        const talkIds = listOwnedFolderTalkIds(
          txInput.ownerId,
          sourceFolderId,
        ).filter((id) => id !== txInput.itemId);
        const index = Math.max(
          0,
          Math.min(txInput.destinationIndex, talkIds.length),
        );
        talkIds.splice(index, 0, txInput.itemId);
        writeFolderTalkOrder(txInput.ownerId, sourceFolderId, talkIds);
      }
      return true;
    }

    if (sourceFolderId === null) {
      const rootItems = listOwnedRootSidebarItems(txInput.ownerId)
        .filter((item) => !(item.type === 'talk' && item.id === txInput.itemId))
        .map((item) => ({ type: item.type, id: item.id }));
      writeRootSidebarOrder(txInput.ownerId, rootItems);
    } else {
      const sourceTalkIds = listOwnedFolderTalkIds(
        txInput.ownerId,
        sourceFolderId,
      ).filter((id) => id !== txInput.itemId);
      writeFolderTalkOrder(txInput.ownerId, sourceFolderId, sourceTalkIds);
    }

    const now = new Date().toISOString();
    if (txInput.destinationFolderId === null) {
      const rootItems = listOwnedRootSidebarItems(txInput.ownerId).map(
        (item) => ({
          type: item.type,
          id: item.id,
        }),
      );
      const index = Math.max(
        0,
        Math.min(txInput.destinationIndex, rootItems.length),
      );
      rootItems.splice(index, 0, { type: 'talk', id: txInput.itemId });
      getDb()
        .prepare(
          `
          UPDATE talks
          SET folder_id = NULL, updated_at = ?, version = version + 1
          WHERE id = ? AND owner_id = ?
        `,
        )
        .run(now, txInput.itemId, txInput.ownerId);
      writeRootSidebarOrder(txInput.ownerId, rootItems);
    } else {
      const talkIds = listOwnedFolderTalkIds(
        txInput.ownerId,
        txInput.destinationFolderId,
      );
      const index = Math.max(
        0,
        Math.min(txInput.destinationIndex, talkIds.length),
      );
      talkIds.splice(index, 0, txInput.itemId);
      getDb()
        .prepare(
          `
          UPDATE talks
          SET folder_id = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND owner_id = ?
        `,
        )
        .run(txInput.destinationFolderId, now, txInput.itemId, txInput.ownerId);
      writeFolderTalkOrder(
        txInput.ownerId,
        txInput.destinationFolderId,
        talkIds,
      );
    }
    return true;
  });
  return tx(input);
}

export function listTalkSidebarTreeForUser(
  userId: string,
): TalkSidebarTreeRecord {
  const folders = listTalkFoldersForOwner(userId);
  // Sidebar trees stay intentionally small in v1; this ceiling avoids pulling an
  // unbounded root list while still covering normal usage comfortably.
  const rawTalks = listTalksForUser({
    userId,
    limit: 1000,
    offset: 0,
    status: 'active',
  });
  const talkIds = rawTalks.map((talk) => talk.id);

  const metricsByTalkId = new Map<
    string,
    {
      lastMessageAt: string | null;
      messageCount: number;
      hasActiveRun: boolean;
    }
  >();

  if (talkIds.length > 0) {
    const placeholders = talkIds.map(() => '?').join(', ');
    const messageRows = getDb()
      .prepare(
        `
        SELECT talk_id, COUNT(*) AS message_count, MAX(created_at) AS last_message_at
        FROM talk_messages
        WHERE talk_id IN (${placeholders})
        GROUP BY talk_id
      `,
      )
      .all(...talkIds) as Array<{
      talk_id: string;
      message_count: number;
      last_message_at: string | null;
    }>;

    for (const row of messageRows) {
      metricsByTalkId.set(row.talk_id, {
        lastMessageAt: row.last_message_at,
        messageCount: row.message_count,
        hasActiveRun: false,
      });
    }

    const runRows = getDb()
      .prepare(
        `
        SELECT talk_id, COUNT(*) AS active_run_count
        FROM talk_runs
        WHERE talk_id IN (${placeholders})
          AND status IN ('queued', 'running', 'awaiting_confirmation')
        GROUP BY talk_id
      `,
      )
      .all(...talkIds) as Array<{
      talk_id: string;
      active_run_count: number;
    }>;

    for (const row of runRows) {
      const current = metricsByTalkId.get(row.talk_id) ?? {
        lastMessageAt: null,
        messageCount: 0,
        hasActiveRun: false,
      };
      metricsByTalkId.set(row.talk_id, {
        ...current,
        hasActiveRun: row.active_run_count > 0,
      });
    }
  }

  const talks = rawTalks.map(
    (talk) =>
      ({
        ...talk,
        last_message_at: metricsByTalkId.get(talk.id)?.lastMessageAt ?? null,
        message_count: metricsByTalkId.get(talk.id)?.messageCount ?? 0,
        has_active_run: metricsByTalkId.get(talk.id)?.hasActiveRun ?? false,
      }) satisfies TalkSidebarTalkRecord,
  );
  const rootTalks = talks
    .filter((talk) => talk.folder_id === null)
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at),
    );
  const talksByFolderId = folders.reduce<
    Record<string, TalkSidebarTalkRecord[]>
  >((acc, folder) => {
    acc[folder.id] = talks
      .filter((talk) => talk.folder_id === folder.id)
      .sort(
        (a, b) =>
          a.sort_order - b.sort_order ||
          a.created_at.localeCompare(b.created_at),
      );
    return acc;
  }, {});
  return { folders, rootTalks, talksByFolderId };
}

export function upsertTalkMember(input: {
  talkId: string;
  userId: string;
  role: TalkAccessRole;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_members (talk_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(talk_id, user_id) DO UPDATE SET role = excluded.role
  `,
    )
    .run(input.talkId, input.userId, input.role, new Date().toISOString());
}

export function upsertTalkLlmPolicy(input: {
  talkId: string;
  llmPolicy: string;
  updatedAt?: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_llm_policies (talk_id, llm_policy, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(talk_id) DO UPDATE SET
      llm_policy = excluded.llm_policy,
      updated_at = excluded.updated_at
  `,
    )
    .run(
      input.talkId,
      input.llmPolicy,
      input.updatedAt || new Date().toISOString(),
    );
}

export function deleteTalkLlmPolicy(talkId: string): void {
  getDb()
    .prepare('DELETE FROM talk_llm_policies WHERE talk_id = ?')
    .run(talkId);
}

export function getTalkLlmPolicyByTalkId(talkId: string): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT llm_policy
      FROM talk_llm_policies
      WHERE talk_id = ?
      LIMIT 1
    `,
    )
    .get(talkId) as { llm_policy: string } | undefined;
  return row?.llm_policy || null;
}

export function getTalkExecutorSession(
  talkId: string,
): TalkExecutorSessionRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT
        talk_id,
        session_id,
        executor_alias,
        executor_model,
        session_compat_key,
        updated_at
      FROM talk_executor_sessions
      WHERE talk_id = ?
      LIMIT 1
    `,
    )
    .get(talkId) as TalkExecutorSessionRecord | undefined;
}

export function upsertTalkExecutorSession(input: {
  talkId: string;
  sessionId: string;
  executorAlias: string;
  executorModel: string;
  sessionCompatKey: string;
  updatedAt?: string;
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO talk_executor_sessions (
        talk_id,
        session_id,
        executor_alias,
        executor_model,
        session_compat_key,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(talk_id) DO UPDATE SET
        session_id = excluded.session_id,
        executor_alias = excluded.executor_alias,
        executor_model = excluded.executor_model,
        session_compat_key = excluded.session_compat_key,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.talkId,
      input.sessionId,
      input.executorAlias,
      input.executorModel,
      input.sessionCompatKey,
      input.updatedAt || new Date().toISOString(),
    );
}

export function deleteTalkExecutorSession(talkId: string): void {
  getDb()
    .prepare('DELETE FROM talk_executor_sessions WHERE talk_id = ?')
    .run(talkId);
}

export function canUserAccessTalk(talkId: string, userId: string): boolean {
  const owned = getDb()
    .prepare('SELECT 1 AS ok FROM talks WHERE id = ? AND owner_id = ?')
    .get(talkId, userId) as { ok: number } | undefined;
  if (owned) return true;

  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;

  const shared = getDb()
    .prepare(
      'SELECT 1 AS ok FROM talk_members WHERE talk_id = ? AND user_id = ?',
    )
    .get(talkId, userId) as { ok: number } | undefined;
  return Boolean(shared);
}

export function canUserEditTalk(talkId: string, userId: string): boolean {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;

  const owned = getDb()
    .prepare('SELECT 1 AS ok FROM talks WHERE id = ? AND owner_id = ?')
    .get(talkId, userId) as { ok: number } | undefined;
  if (owned) return true;

  const sharedEditor = getDb()
    .prepare(
      `
      SELECT 1 AS ok
      FROM talk_members
      WHERE talk_id = ? AND user_id = ? AND role = 'editor'
    `,
    )
    .get(talkId, userId) as { ok: number } | undefined;
  return Boolean(sharedEditor);
}

export function getTalkIdsAccessibleByUser(userId: string): string[] {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return [];
  if (user.role === 'owner' || user.role === 'admin') {
    return (
      getDb().prepare('SELECT id FROM talks').all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  const rows = getDb()
    .prepare(
      `
      SELECT DISTINCT t.id
      FROM talks t
      LEFT JOIN talk_members tm ON tm.talk_id = t.id
      WHERE t.owner_id = ? OR tm.user_id = ?
    `,
    )
    .all(userId, userId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export interface TalkMessageRecord {
  id: string;
  talk_id: string | null;
  thread_id: string;
  role: TalkMessageRole;
  content: string;
  created_by: string | null;
  created_at: string;
  run_id: string | null;
  metadata_json: string | null;
  sequence_in_run: number | null;
}

export function createTalkMessage(input: {
  id: string;
  talkId: string;
  threadId: string;
  role: TalkMessageRole;
  content: string;
  createdBy?: string | null;
  runId?: string | null;
  metadataJson?: string | null;
  sequenceInRun?: number | null;
  createdAt?: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_messages (
      id, talk_id, thread_id, role, content, created_by, created_at, run_id, metadata_json, sequence_in_run
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.id,
      input.talkId,
      input.threadId,
      input.role,
      input.content,
      input.createdBy || null,
      input.createdAt || new Date().toISOString(),
      input.runId || null,
      input.metadataJson || null,
      input.sequenceInRun ?? null,
    );
}

function parseMessageMetadataJson(
  metadataJson: string | null | undefined,
): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractMessageActorFromMetadata(
  metadata: Record<string, unknown> | null,
): { agentId: string | null; agentNickname: string | null } {
  if (!metadata) {
    return { agentId: null, agentNickname: null };
  }

  const agentId =
    typeof metadata.agentId === 'string' ? metadata.agentId : null;
  const agentNickname =
    typeof metadata.agentNickname === 'string'
      ? metadata.agentNickname
      : typeof metadata.agentName === 'string'
        ? metadata.agentName
        : null;

  return { agentId, agentNickname };
}

export function listTalkMessages(input: {
  talkId: string;
  threadId?: string | null;
  limit?: number;
  beforeCreatedAt?: string;
}): TalkMessageRecord[] {
  const limit =
    typeof input.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 100;
  const before = input.beforeCreatedAt || null;
  const threadId = input.threadId || null;

  const rows = getDb()
    .prepare(
      `
      SELECT id, talk_id, thread_id, role, content, created_by, created_at, run_id, metadata_json, sequence_in_run
      FROM talk_messages
      WHERE talk_id = ?
        AND (? IS NULL OR thread_id = ?)
        AND (? IS NULL OR created_at < ?)
      ORDER BY created_at DESC, COALESCE(sequence_in_run, 0) DESC, id DESC
      LIMIT ?
    `,
    )
    .all(
      input.talkId,
      threadId,
      threadId,
      before,
      before,
      limit,
    ) as TalkMessageRecord[];

  rows.reverse();
  return rows;
}

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function searchTalkMessages(input: {
  talkId: string;
  query: string;
  limit?: number;
}): Array<{
  id: string;
  thread_id: string;
  thread_title: string | null;
  role: TalkMessageRole;
  content: string;
  created_at: string;
}> {
  const normalizedQuery = input.query.trim();
  const limit =
    typeof input.limit === 'number'
      ? Math.min(50, Math.max(1, Math.floor(input.limit)))
      : 20;
  if (normalizedQuery.length === 0) {
    return [];
  }

  const likePattern = `%${escapeLikePattern(normalizedQuery)}%`;
  return getDb()
    .prepare(
      `
      SELECT
        m.id,
        m.thread_id,
        t.title AS thread_title,
        m.role,
        m.content,
        m.created_at
      FROM talk_messages m
      LEFT JOIN talk_threads t ON t.id = m.thread_id
      WHERE m.talk_id = ?
        AND m.content LIKE ? ESCAPE '\\'
      ORDER BY m.created_at DESC, COALESCE(m.sequence_in_run, 0) DESC, m.id DESC
      LIMIT ?
    `,
    )
    .all(input.talkId, likePattern, limit) as Array<{
    id: string;
    thread_id: string;
    thread_title: string | null;
    role: TalkMessageRole;
    content: string;
    created_at: string;
  }>;
}

export interface TalkReplayRow {
  user: TalkMessageRecord;
  assistant: TalkMessageRecord;
}

export function listTalkReplayRows(input: {
  talkId: string;
  currentRunId: string;
  currentUserMessageId: string;
  limit?: number;
}): TalkReplayRow[] {
  const limit =
    typeof input.limit === 'number'
      ? Math.min(500, Math.max(1, Math.floor(input.limit)))
      : 500;

  const rows = getDb()
    .prepare(
      `
      WITH recent_messages AS (
        SELECT id, talk_id, thread_id, role, content, created_by, created_at, run_id, metadata_json, sequence_in_run
        FROM talk_messages
        WHERE talk_id = ?
        ORDER BY created_at DESC, COALESCE(sequence_in_run, 0) DESC, id DESC
        LIMIT ?
      )
      SELECT
        u.id AS user_id,
        u.talk_id AS user_talk_id,
        u.thread_id AS user_thread_id,
        u.role AS user_role,
        u.content AS user_content,
        u.created_by AS user_created_by,
        u.created_at AS user_created_at,
        u.run_id AS user_run_id,
        u.metadata_json AS user_metadata_json,
        u.sequence_in_run AS user_sequence_in_run,
        a.id AS assistant_id,
        a.talk_id AS assistant_talk_id,
        a.thread_id AS assistant_thread_id,
        a.role AS assistant_role,
        a.content AS assistant_content,
        a.created_by AS assistant_created_by,
        a.created_at AS assistant_created_at,
        a.run_id AS assistant_run_id,
        a.metadata_json AS assistant_metadata_json,
        a.sequence_in_run AS assistant_sequence_in_run
      FROM recent_messages a
      JOIN talk_runs r ON r.id = a.run_id
      JOIN talk_messages u ON u.id = r.trigger_message_id
      WHERE a.role = 'assistant'
        AND a.run_id IS NOT NULL
        AND a.run_id != ?
        AND u.role = 'user'
        AND u.id != ?
      ORDER BY
        u.created_at ASC,
        u.id ASC,
        a.created_at ASC,
        COALESCE(a.sequence_in_run, 0) ASC,
        a.id ASC
    `,
    )
    .all(
      input.talkId,
      limit,
      input.currentRunId,
      input.currentUserMessageId,
    ) as Array<{
    user_id: string;
    user_talk_id: string;
    user_thread_id: string;
    user_role: TalkMessageRole;
    user_content: string;
    user_created_by: string | null;
    user_created_at: string;
    user_run_id: string | null;
    user_metadata_json: string | null;
    user_sequence_in_run: number | null;
    assistant_id: string;
    assistant_talk_id: string;
    assistant_thread_id: string;
    assistant_role: TalkMessageRole;
    assistant_content: string;
    assistant_created_by: string | null;
    assistant_created_at: string;
    assistant_run_id: string | null;
    assistant_metadata_json: string | null;
    assistant_sequence_in_run: number | null;
  }>;

  return rows.map((row) => ({
    user: {
      id: row.user_id,
      talk_id: row.user_talk_id,
      thread_id: row.user_thread_id,
      role: row.user_role,
      content: row.user_content,
      created_by: row.user_created_by,
      created_at: row.user_created_at,
      run_id: row.user_run_id,
      metadata_json: row.user_metadata_json,
      sequence_in_run: row.user_sequence_in_run,
    },
    assistant: {
      id: row.assistant_id,
      talk_id: row.assistant_talk_id,
      thread_id: row.assistant_thread_id,
      role: row.assistant_role,
      content: row.assistant_content,
      created_by: row.assistant_created_by,
      created_at: row.assistant_created_at,
      run_id: row.assistant_run_id,
      metadata_json: row.assistant_metadata_json,
      sequence_in_run: row.assistant_sequence_in_run,
    },
  }));
}

export function getTalkMessageById(
  messageId: string,
): TalkMessageRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM talk_messages WHERE id = ?')
    .get(messageId) as TalkMessageRecord | undefined;
}

export function deleteTalkMessagesAtomic(input: {
  talkId: string;
  messageIds: string[];
  threadId: string;
  now?: string;
}): { deletedCount: number; deletedMessageIds: string[] } {
  const normalizedIds = Array.from(
    new Set(
      input.messageIds
        .map((messageId) => messageId.trim())
        .filter((messageId) => messageId.length > 0),
    ),
  );

  const tx = getDb().transaction(
    (
      txInput: typeof input,
      ids: string[],
    ): { deletedCount: number; deletedMessageIds: string[] } => {
      if (ids.length === 0) {
        throw new Error('talk history edit requires at least one message');
      }

      const placeholders = ids.map(() => '?').join(', ');
      const rows = getDb()
        .prepare(
          `
          SELECT id, role, thread_id
          FROM talk_messages
          WHERE talk_id = ?
            AND id IN (${placeholders})
        `,
        )
        .all(txInput.talkId, ...ids) as Array<{
        id: string;
        role: TalkMessageRole;
        thread_id: string;
      }>;

      if (rows.length !== ids.length) {
        throw new Error('one or more talk messages were not found');
      }
      if (rows.some((row) => row.role === 'system')) {
        throw new Error('system messages cannot be deleted');
      }
      const threadIds = Array.from(new Set(rows.map((row) => row.thread_id)));
      if (threadIds.length !== 1 || threadIds[0] !== txInput.threadId) {
        throw new Error(
          'selected messages do not belong to the requested thread',
        );
      }
      if (hasActiveTalkRuns(txInput.talkId, txInput.threadId)) {
        throw new TalkActiveRoundError('thread');
      }

      const now = txInput.now || new Date().toISOString();
      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET trigger_message_id = NULL
          WHERE talk_id = ?
            AND thread_id = ?
            AND trigger_message_id IN (${placeholders})
        `,
        )
        .run(txInput.talkId, txInput.threadId, ...ids);
      getDb()
        .prepare(
          `
          DELETE FROM talk_messages
          WHERE talk_id = ?
            AND id IN (${placeholders})
        `,
        )
        .run(txInput.talkId, ...ids);

      // Reset cached executor session so future runs do not retain deleted context.
      deleteTalkExecutorSession(txInput.talkId);
      touchTalkUpdatedAt(txInput.talkId, now);
      appendOutboxEvent({
        topic: `talk:${txInput.talkId}`,
        eventType: 'talk_history_edited',
        payload: JSON.stringify({
          talkId: txInput.talkId,
          threadIds: [txInput.threadId],
          deletedCount: ids.length,
          deletedMessageIds: ids,
          editedAt: now,
        }),
      });

      return { deletedCount: ids.length, deletedMessageIds: ids };
    },
  );

  return tx(input, normalizedIds);
}

export function deleteMainMessagesAtomic(input: {
  threadId: string;
  userId: string;
  messageIds: string[];
  now?: string;
}): {
  deletedCount: number;
  deletedMessageIds: string[];
  threadDeleted: boolean;
} {
  const normalizedIds = Array.from(
    new Set(
      input.messageIds
        .map((messageId) => messageId.trim())
        .filter((messageId) => messageId.length > 0),
    ),
  );

  const tx = getDb().transaction(
    (
      txInput: typeof input,
      ids: string[],
    ): {
      deletedCount: number;
      deletedMessageIds: string[];
      threadDeleted: boolean;
    } => {
      if (ids.length === 0) {
        throw new Error('main history edit requires at least one message');
      }

      const owner = getMainThreadOwner(txInput.threadId);
      if (owner !== txInput.userId) {
        throw new Error('main thread not found');
      }

      const placeholders = ids.map(() => '?').join(', ');
      const rows = getDb()
        .prepare(
          `
          SELECT id, role
          FROM talk_messages
          WHERE talk_id IS NULL
            AND thread_id = ?
            AND id IN (${placeholders})
        `,
        )
        .all(txInput.threadId, ...ids) as Array<{
        id: string;
        role: TalkMessageRole;
      }>;

      if (rows.length !== ids.length) {
        throw new Error('one or more main messages were not found');
      }
      if (rows.some((row) => row.role === 'system')) {
        throw new Error('system messages cannot be deleted');
      }

      const remaining = getDb()
        .prepare(
          `
          SELECT
            COUNT(*) AS remaining_count,
            COALESCE(
              SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END),
              0
            ) AS remaining_user_count
          FROM talk_messages
          WHERE talk_id IS NULL
            AND thread_id = ?
            AND id NOT IN (${placeholders})
        `,
        )
        .get(txInput.threadId, ...ids) as {
        remaining_count: number;
        remaining_user_count: number;
      };

      if (
        remaining.remaining_count > 0 &&
        remaining.remaining_user_count === 0
      ) {
        throw new Error('main thread must retain at least one user message');
      }

      const activeRun = getDb()
        .prepare(
          `
          SELECT 1 AS active
          FROM talk_runs
          WHERE talk_id IS NULL
            AND thread_id = ?
            AND status IN ('queued', 'running', 'awaiting_confirmation')
          LIMIT 1
        `,
        )
        .get(txInput.threadId) as { active: number } | undefined;
      if (activeRun) {
        throw new TalkActiveRoundError('thread');
      }

      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET trigger_message_id = NULL
          WHERE talk_id IS NULL
            AND thread_id = ?
            AND trigger_message_id IN (${placeholders})
        `,
        )
        .run(txInput.threadId, ...ids);

      getDb()
        .prepare(
          `
          DELETE FROM talk_messages
          WHERE talk_id IS NULL
            AND thread_id = ?
            AND id IN (${placeholders})
        `,
        )
        .run(txInput.threadId, ...ids);

      if (remaining.remaining_count === 0) {
        getDb()
          .prepare(`DELETE FROM main_thread_summaries WHERE thread_id = ?`)
          .run(txInput.threadId);
        getDb()
          .prepare(`DELETE FROM main_threads WHERE thread_id = ?`)
          .run(txInput.threadId);
        getDb()
          .prepare(`DELETE FROM talk_threads WHERE id = ? AND talk_id IS NULL`)
          .run(txInput.threadId);
      } else {
        refreshMainThreadSummary(txInput.threadId);
      }

      return {
        deletedCount: ids.length,
        deletedMessageIds: ids,
        threadDeleted: remaining.remaining_count === 0,
      };
    },
  );

  return tx(input, normalizedIds);
}

/**
 * Get or create the default thread for a Talk.
 * If the Talk already has a default thread (is_default=1), returns its ID.
 * Otherwise creates one and returns the new ID.
 */
function getFirstTalkThreadUserMessageContent(
  talkId: string,
  threadId: string,
): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT content
      FROM talk_messages
      WHERE talk_id = ? AND thread_id = ? AND role = 'user'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    )
    .get(talkId, threadId) as { content: string } | undefined;
  return row?.content ?? null;
}

function getFirstMainThreadUserMessageContent(threadId: string): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT content
      FROM talk_messages
      WHERE talk_id IS NULL AND thread_id = ? AND role = 'user'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    )
    .get(threadId) as { content: string } | undefined;
  return row?.content ?? null;
}

function maybePersistTalkThreadTitleFromMessages(
  talkId: string,
  threadId: string,
  currentTitle: string | null | undefined,
): string | null {
  const normalizedTitle = normalizeStoredThreadTitle(currentTitle);
  if (
    normalizedTitle !== null &&
    !isLegacyPlaceholderTalkThreadTitle(normalizedTitle)
  ) {
    return normalizedTitle;
  }

  const inferredTitle = inferThreadTitleFromContent(
    getFirstTalkThreadUserMessageContent(talkId, threadId),
  );
  if (!inferredTitle) {
    return normalizedTitle;
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE talk_threads
      SET title = ?, updated_at = ?
      WHERE id = ? AND talk_id = ?
        AND (
          title IS NULL OR
          trim(title) = '' OR
          title = 'Default Thread'
        )
    `,
    )
    .run(inferredTitle, now, threadId, talkId);

  return inferredTitle;
}

function ensureMainThreadMetadataRow(input: {
  threadId: string;
  userId: string;
  now: string;
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO main_threads (thread_id, user_id, title, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(thread_id) DO NOTHING
    `,
    )
    .run(input.threadId, input.userId, input.now, input.now);
}

function maybePersistMainThreadTitleFromMessages(input: {
  threadId: string;
  userId: string;
  currentTitle: string | null | undefined;
}): string | null {
  const normalizedTitle = normalizeStoredThreadTitle(input.currentTitle);
  if (normalizedTitle) {
    return normalizedTitle;
  }

  const inferredTitle = inferThreadTitleFromContent(
    getFirstMainThreadUserMessageContent(input.threadId),
  );
  if (!inferredTitle) {
    return null;
  }

  const now = new Date().toISOString();
  ensureMainThreadMetadataRow({
    threadId: input.threadId,
    userId: input.userId,
    now,
  });
  getDb()
    .prepare(
      `
      UPDATE main_threads
      SET title = ?, updated_at = ?
      WHERE thread_id = ? AND (title IS NULL OR trim(title) = '')
    `,
    )
    .run(inferredTitle, now, input.threadId);

  return inferredTitle;
}

export function getOrCreateDefaultThread(talkId: string): string {
  const existing = getDb()
    .prepare(
      `SELECT id FROM talk_threads WHERE talk_id = ? AND is_default = 1 LIMIT 1`,
    )
    .get(talkId) as { id: string } | undefined;

  if (existing) return existing.id;

  const now = new Date().toISOString();
  const { uuid } = getDb()
    .prepare(
      `SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)),2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) ||
        substr(hex(randomblob(2)),2) || '-' ||
        hex(randomblob(6))) AS uuid`,
    )
    .get() as { uuid: string };
  const threadId = `thread_${uuid}`;

  getDb()
    .prepare(
      `INSERT INTO talk_threads (id, talk_id, title, is_default, is_internal, created_at, updated_at)
       VALUES (?, ?, NULL, 1, 0, ?, ?)`,
    )
    .run(threadId, talkId, now, now);

  return threadId;
}

/**
 * List threads for a Talk, ordered by most recent activity.
 */
export function listTalkThreads(talkId: string): Array<{
  id: string;
  talk_id: string;
  title: string | null;
  is_default: number;
  is_pinned: number;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message_at: string | null;
}> {
  // Talks created before the thread UI rollout, or talks inserted before the
  // createTalk() default-thread fix, may still have zero thread rows. Heal that
  // state on read so the UI always has an active thread to select.
  getOrCreateDefaultThread(talkId);
  const rows = getDb()
    .prepare(
      `
      SELECT
        t.id,
        t.talk_id,
        t.title,
        t.is_default,
        t.is_pinned,
        t.created_at,
        t.updated_at,
        COALESCE(m.message_count, 0) AS message_count,
        m.last_message_at
      FROM talk_threads t
      LEFT JOIN (
        SELECT thread_id, COUNT(*) AS message_count, MAX(created_at) AS last_message_at
        FROM talk_messages
        WHERE talk_id = ?
        GROUP BY thread_id
      ) m ON m.thread_id = t.id
      WHERE t.talk_id = ? AND t.is_internal = 0
      ORDER BY t.is_pinned DESC, COALESCE(m.last_message_at, t.created_at) DESC
    `,
    )
    .all(talkId, talkId) as Array<{
    id: string;
    talk_id: string;
    title: string | null;
    is_default: number;
    is_pinned: number;
    created_at: string;
    updated_at: string;
    message_count: number;
    last_message_at: string | null;
  }>;
  return rows;
}

/**
 * Create a new thread for a Talk.
 */
export function createTalkThread(input: {
  talkId: string;
  title?: string | null;
  isInternal?: boolean;
}): {
  id: string;
  talk_id: string;
  title: string | null;
  is_default: number;
  is_internal: number;
  is_pinned: number;
  created_at: string;
  updated_at: string;
} {
  const now = new Date().toISOString();
  const normalizedTitle = normalizeStoredThreadTitle(input.title ?? null);
  const { uuid } = getDb()
    .prepare(
      `SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)),2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) ||
        substr(hex(randomblob(2)),2) || '-' ||
        hex(randomblob(6))) AS uuid`,
    )
    .get() as { uuid: string };
  const threadId = `thread_${uuid}`;

  getDb()
    .prepare(
      `INSERT INTO talk_threads (id, talk_id, title, is_default, is_internal, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      threadId,
      input.talkId,
      normalizedTitle,
      input.isInternal ? 1 : 0,
      now,
      now,
    );

  return {
    id: threadId,
    talk_id: input.talkId,
    title: normalizedTitle,
    is_default: 0,
    is_internal: input.isInternal ? 1 : 0,
    is_pinned: 0,
    created_at: now,
    updated_at: now,
  };
}

export function updateTalkThreadMetadata(input: {
  talkId: string;
  threadId: string;
  title?: string;
  pinned?: boolean;
}): {
  id: string;
  talk_id: string;
  title: string | null;
  is_default: number;
  is_internal: number;
  is_pinned: number;
  created_at: string;
  updated_at: string;
} | null {
  const normalizedTitle =
    input.title === undefined
      ? undefined
      : validateEditableThreadTitle(input.title);

  const existing = getDb()
    .prepare(
      `
      SELECT id, talk_id, title, is_default, is_internal, is_pinned, created_at
      FROM talk_threads
      WHERE id = ? AND talk_id = ?
    `,
    )
    .get(input.threadId, input.talkId) as
    | {
        id: string;
        talk_id: string;
        title: string | null;
        is_default: number;
        is_internal: number;
        is_pinned: number;
        created_at: string;
      }
    | undefined;
  if (!existing) {
    return null;
  }

  const nextTitle = normalizedTitle ?? existing.title;
  const nextPinned =
    input.pinned === undefined ? existing.is_pinned : input.pinned ? 1 : 0;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE talk_threads
      SET title = ?, is_pinned = ?, updated_at = ?
      WHERE id = ? AND talk_id = ?
    `,
    )
    .run(nextTitle, nextPinned, now, input.threadId, input.talkId);

  return {
    id: existing.id,
    talk_id: existing.talk_id,
    title: nextTitle,
    is_default: existing.is_default,
    is_internal: existing.is_internal,
    is_pinned: nextPinned,
    created_at: existing.created_at,
    updated_at: now,
  };
}

export function updateTalkThreadTitle(input: {
  talkId: string;
  threadId: string;
  title: string;
}): {
  id: string;
  talk_id: string;
  title: string;
  is_default: number;
  is_internal: number;
  is_pinned: number;
  created_at: string;
  updated_at: string;
} | null {
  const updated = updateTalkThreadMetadata(input);
  if (!updated || updated.title === null) {
    return null;
  }
  return {
    ...updated,
    title: updated.title,
  };
}

export function enqueueTalkTurnAtomic(input: {
  talkId: string;
  threadId?: string | null;
  userId: string;
  content: string;
  messageId: string;
  runIds: string[];
  targetAgentIds: string[];
  responseGroupId?: string | null;
  sequenceIndexes?: Array<number | null> | null;
  attachmentIds?: string[] | null;
  maxAttachmentsPerMessage?: number;
  idempotencyKey?: string | null;
  now?: string;
}): { message: TalkMessageRecord; runs: TalkRunRecord[]; threadId: string } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      message: TalkMessageRecord;
      runs: TalkRunRecord[];
      threadId: string;
    } => {
      const now = txInput.now || new Date().toISOString();
      if (
        txInput.runIds.length === 0 ||
        txInput.runIds.length !== txInput.targetAgentIds.length
      ) {
        throw new Error('talk turn requires one run id per target agent');
      }
      if (
        txInput.sequenceIndexes &&
        txInput.sequenceIndexes.length !== txInput.runIds.length
      ) {
        throw new Error('talk turn requires one sequence index per run');
      }

      const threadId = resolveThreadIdForTalk(txInput.talkId, txInput.threadId);
      const responseGroupId =
        txInput.responseGroupId?.trim() || `group_${randomUUID()}`;
      const sequenceIndexes = txInput.runIds.map((_, index) => {
        const raw = txInput.sequenceIndexes?.[index];
        if (
          typeof raw === 'number' &&
          Number.isFinite(raw) &&
          Number.isInteger(raw) &&
          raw >= 0
        ) {
          return raw;
        }
        return null;
      });

      const active = getDb()
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM talk_runs
          WHERE talk_id = ? AND thread_id = ?
            AND status IN ('queued', 'running', 'awaiting_confirmation')
        `,
        )
        .get(txInput.talkId, threadId) as { count: number };
      if ((active?.count || 0) > 0) {
        throw new TalkActiveRoundError('thread');
      }

      const message: TalkMessageRecord = {
        id: txInput.messageId,
        talk_id: txInput.talkId,
        thread_id: threadId,
        role: 'user',
        content: txInput.content,
        created_by: txInput.userId,
        created_at: now,
        run_id: null,
        metadata_json: null,
        sequence_in_run: null,
      };

      const runs: TalkRunRecord[] = txInput.runIds.map((runId, index) => ({
        id: runId,
        talk_id: txInput.talkId,
        thread_id: threadId,
        requested_by: txInput.userId,
        status: 'queued',
        trigger_message_id: txInput.messageId,
        target_agent_id: txInput.targetAgentIds[index] || null,
        idempotency_key: index === 0 ? txInput.idempotencyKey || null : null,
        response_group_id: responseGroupId,
        sequence_index: sequenceIndexes[index],
        executor_alias: null,
        executor_model: null,
        source_binding_id: null,
        source_external_message_id: null,
        source_thread_key: null,
        created_at: now,
        started_at: null,
        ended_at: null,
        cancel_reason: null,
      }));

      createTalkMessage({
        id: message.id,
        talkId: message.talk_id!,
        threadId,
        role: message.role,
        content: message.content,
        createdBy: message.created_by,
        createdAt: message.created_at,
      });
      const currentThread = getDb()
        .prepare(`SELECT title FROM talk_threads WHERE id = ? AND talk_id = ?`)
        .get(threadId, txInput.talkId) as { title: string | null } | undefined;
      maybePersistTalkThreadTitleFromMessages(
        txInput.talkId,
        threadId,
        currentThread?.title ?? null,
      );

      for (const run of runs) {
        createTalkRun(run);
      }

      touchTalkUpdatedAt(txInput.talkId, now);

      appendOutboxEvent({
        topic: `talk:${txInput.talkId}`,
        eventType: 'message_appended',
        payload: JSON.stringify({
          talkId: txInput.talkId,
          threadId,
          messageId: txInput.messageId,
          runId: null,
          role: 'user',
          createdBy: txInput.userId,
          content: txInput.content,
          createdAt: now,
        }),
      });
      for (const run of runs) {
        appendOutboxEvent({
          topic: `talk:${txInput.talkId}`,
          eventType: 'talk_run_queued',
          payload: JSON.stringify({
            talkId: txInput.talkId,
            threadId,
            runId: run.id,
            runKind: run.run_kind ?? 'conversation',
            triggerMessageId: txInput.messageId,
            targetAgentId: run.target_agent_id || null,
            responseGroupId,
            sequenceIndex: run.sequence_index,
            status: 'queued',
            executorAlias: run.executor_alias,
            executorModel: run.executor_model,
          }),
        });
      }

      // Validate and link attachments inside the same transaction so the
      // entire operation is atomic — no race between validation and linking.
      const attIds = txInput.attachmentIds;
      if (Array.isArray(attIds) && attIds.length > 0) {
        const cap = txInput.maxAttachmentsPerMessage ?? 5;
        if (attIds.length > cap) {
          throw new AttachmentValidationError(
            'too_many_attachments',
            `A message may have at most ${cap} attachments.`,
          );
        }

        const linkStmt = getDb().prepare(
          `UPDATE talk_message_attachments
           SET message_id = ?
           WHERE id = ? AND talk_id = ? AND message_id IS NULL`,
        );
        const invalidIds: string[] = [];
        for (const attId of attIds) {
          const result = linkStmt.run(message.id, attId, txInput.talkId);
          if (result.changes === 0) {
            invalidIds.push(attId);
          }
        }
        if (invalidIds.length > 0) {
          throw new AttachmentValidationError(
            'invalid_attachment_ids',
            `Some attachment IDs could not be linked: ${invalidIds.join(', ')}. ` +
              'They may be invalid, already linked, or belong to another talk.',
          );
        }
      }

      return { message, runs, threadId };
    },
  );

  return tx(input);
}

/**
 * Thrown when attachment validation fails inside enqueueTalkTurnAtomic.
 * The transaction is rolled back so no message or runs are persisted.
 */
export class AttachmentValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.code = code;
  }
}

export class TalkActiveRoundError extends Error {
  readonly code = 'talk_active_round';
  readonly scope: 'talk' | 'thread';

  constructor(scope: 'talk' | 'thread') {
    super(
      scope === 'thread'
        ? 'This thread already has an active round'
        : 'This talk already has an active round',
    );
    this.name = 'TalkActiveRoundError';
    this.scope = scope;
  }
}

export class TalkThreadValidationError extends Error {
  readonly code: 'thread_not_found';

  constructor(message = 'Thread not found or does not belong to this talk') {
    super(message);
    this.name = 'TalkThreadValidationError';
    this.code = 'thread_not_found';
  }
}

export class ThreadDeleteConflictError extends Error {
  readonly code:
    | 'default_thread'
    | 'internal_thread'
    | 'job_owned_thread'
    | 'thread_has_active_runs';

  constructor(
    code:
      | 'default_thread'
      | 'internal_thread'
      | 'job_owned_thread'
      | 'thread_has_active_runs',
    message: string,
  ) {
    super(message);
    this.name = 'ThreadDeleteConflictError';
    this.code = code;
  }
}

export function resolveThreadIdForTalk(
  talkId: string,
  threadId?: string | null,
): string {
  if (!threadId) {
    return getOrCreateDefaultThread(talkId);
  }

  const threadRow = getDb()
    .prepare(`SELECT id FROM talk_threads WHERE id = ? AND talk_id = ?`)
    .get(threadId, talkId) as { id: string } | undefined;
  if (!threadRow) {
    throw new TalkThreadValidationError();
  }
  return threadRow.id;
}

export function deleteTalkThread(input: {
  talkId: string;
  threadId: string;
}): boolean {
  const tx = getDb().transaction((txInput: typeof input): boolean => {
    const thread = getDb()
      .prepare(
        `
        SELECT id, is_default, is_internal
        FROM talk_threads
        WHERE id = ? AND talk_id = ?
      `,
      )
      .get(txInput.threadId, txInput.talkId) as
      | {
          id: string;
          is_default: number;
          is_internal: number;
        }
      | undefined;
    if (!thread) {
      return false;
    }
    if (thread.is_default === 1) {
      throw new ThreadDeleteConflictError(
        'default_thread',
        'The default thread cannot be deleted.',
      );
    }
    if (thread.is_internal === 1) {
      throw new ThreadDeleteConflictError(
        'internal_thread',
        'Internal threads cannot be deleted.',
      );
    }

    const jobRef = getDb()
      .prepare(
        `
        SELECT id
        FROM talk_jobs
        WHERE talk_id = ? AND thread_id = ?
        LIMIT 1
      `,
      )
      .get(txInput.talkId, txInput.threadId) as { id: string } | undefined;
    if (jobRef) {
      throw new ThreadDeleteConflictError(
        'job_owned_thread',
        'Job-owned threads cannot be deleted.',
      );
    }

    const activeRun = getDb()
      .prepare(
        `
        SELECT id
        FROM talk_runs
        WHERE talk_id = ? AND thread_id = ?
          AND status IN ('queued', 'running', 'awaiting_confirmation')
        LIMIT 1
      `,
      )
      .get(txInput.talkId, txInput.threadId) as { id: string } | undefined;
    if (activeRun) {
      throw new ThreadDeleteConflictError(
        'thread_has_active_runs',
        'Threads with active work cannot be deleted.',
      );
    }

    const runIds = (
      getDb()
        .prepare(
          `
          SELECT id
          FROM talk_runs
          WHERE talk_id = ? AND thread_id = ?
        `,
        )
        .all(txInput.talkId, txInput.threadId) as Array<{ id: string }>
    ).map((row) => row.id);
    const messageIds = (
      getDb()
        .prepare(
          `
          SELECT id
          FROM talk_messages
          WHERE talk_id = ? AND thread_id = ?
        `,
        )
        .all(txInput.talkId, txInput.threadId) as Array<{ id: string }>
    ).map((row) => row.id);

    if (runIds.length > 0 && messageIds.length > 0) {
      const runPlaceholders = runIds.map(() => '?').join(', ');
      const messagePlaceholders = messageIds.map(() => '?').join(', ');
      getDb()
        .prepare(
          `
          DELETE FROM channel_delivery_outbox
          WHERE talk_id = ?
            AND (
              run_id IN (${runPlaceholders})
              OR talk_message_id IN (${messagePlaceholders})
            )
        `,
        )
        .run(txInput.talkId, ...runIds, ...messageIds);
    } else if (runIds.length > 0) {
      const runPlaceholders = runIds.map(() => '?').join(', ');
      getDb()
        .prepare(
          `
          DELETE FROM channel_delivery_outbox
          WHERE talk_id = ? AND run_id IN (${runPlaceholders})
        `,
        )
        .run(txInput.talkId, ...runIds);
    } else if (messageIds.length > 0) {
      const messagePlaceholders = messageIds.map(() => '?').join(', ');
      getDb()
        .prepare(
          `
          DELETE FROM channel_delivery_outbox
          WHERE talk_id = ? AND talk_message_id IN (${messagePlaceholders})
        `,
        )
        .run(txInput.talkId, ...messageIds);
    }

    getDb()
      .prepare(
        `
        DELETE FROM talk_runs
        WHERE talk_id = ? AND thread_id = ?
      `,
      )
      .run(txInput.talkId, txInput.threadId);
    getDb()
      .prepare(
        `
        DELETE FROM talk_messages
        WHERE talk_id = ? AND thread_id = ?
      `,
      )
      .run(txInput.talkId, txInput.threadId);
    getDb()
      .prepare(
        `
        DELETE FROM talk_threads
        WHERE id = ? AND talk_id = ?
      `,
      )
      .run(txInput.threadId, txInput.talkId);
    touchTalkUpdatedAt(txInput.talkId);
    return true;
  });

  return tx(input);
}

// --- Event outbox ---

export interface OutboxEvent {
  event_id: number;
  topic: string;
  event_type: string;
  payload: string;
  created_at: string;
}

export function appendOutboxEvent(input: {
  topic: string;
  eventType: string;
  payload: string;
}): number {
  const stmt = getDb().prepare(
    `
    INSERT INTO event_outbox (topic, event_type, payload, created_at)
    VALUES (?, ?, ?, ?)
  `,
  );
  const result = stmt.run(
    input.topic,
    input.eventType,
    input.payload,
    new Date().toISOString(),
  );
  const eventId = Number(result.lastInsertRowid);
  // Defer wakeups until the surrounding transaction scope has fully unwound so
  // subscribers do not race a still-uncommitted outbox row.
  queueMicrotask(() => {
    notifyOutboxEvent({ topic: input.topic, eventId });
  });
  return eventId;
}

export function getOutboxEventsForTopics(
  topics: string[],
  afterEventId: number,
  limit = 100,
): OutboxEvent[] {
  if (topics.length === 0) return [];
  const placeholders = topics.map(() => '?').join(',');
  return getDb()
    .prepare(
      `
      SELECT event_id, topic, event_type, payload, created_at
      FROM event_outbox
      WHERE topic IN (${placeholders}) AND event_id > ?
      ORDER BY event_id ASC
      LIMIT ?
    `,
    )
    .all(...topics, afterEventId, limit) as OutboxEvent[];
}

export function getOutboxMinEventIdForTopics(topics: string[]): number | null {
  if (topics.length === 0) return null;
  const placeholders = topics.map(() => '?').join(',');
  const row = getDb()
    .prepare(
      `
      SELECT MIN(event_id) AS min_event_id
      FROM event_outbox
      WHERE topic IN (${placeholders})
    `,
    )
    .get(...topics) as { min_event_id: number | null };
  return row?.min_event_id ?? null;
}

export function getOutboxMaxEventIdForTopics(topics: string[]): number | null {
  if (topics.length === 0) return null;
  const placeholders = topics.map(() => '?').join(',');
  const row = getDb()
    .prepare(
      `
      SELECT MAX(event_id) AS max_event_id
      FROM event_outbox
      WHERE topic IN (${placeholders})
    `,
    )
    .get(...topics) as { max_event_id: number | null };
  return row?.max_event_id ?? null;
}

export function pruneEventOutbox(input?: {
  nowMs?: number;
  retentionHours?: number;
  keepRecentPerTopic?: number;
}): number {
  const nowMs = input?.nowMs ?? Date.now();
  const retentionMs = (input?.retentionHours ?? 72) * 60 * 60 * 1000;
  const keepRecentPerTopic = input?.keepRecentPerTopic ?? 5000;
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();

  const topics = getDb()
    .prepare('SELECT DISTINCT topic FROM event_outbox')
    .all() as Array<{ topic: string }>;
  let deleted = 0;

  for (const row of topics) {
    const threshold = getDb()
      .prepare(
        `
        SELECT event_id
        FROM event_outbox
        WHERE topic = ?
        ORDER BY event_id DESC
        LIMIT 1 OFFSET ?
      `,
      )
      .get(row.topic, keepRecentPerTopic - 1) as
      | { event_id: number }
      | undefined;

    const result = threshold
      ? getDb()
          .prepare(
            `
            DELETE FROM event_outbox
            WHERE topic = ?
              AND created_at < ?
              AND event_id < ?
          `,
          )
          .run(row.topic, cutoffIso, threshold.event_id)
      : getDb()
          .prepare(
            `
            DELETE FROM event_outbox
            WHERE topic = ?
              AND created_at < ?
          `,
          )
          .run(row.topic, cutoffIso);

    deleted += result.changes;
  }

  return deleted;
}

// --- Idempotency cache ---

export interface IdempotencyCacheRecord {
  idempotency_key: string;
  user_id: string;
  method: string;
  path: string;
  request_hash: string;
  status_code: number;
  response_body: string;
  created_at: string;
  expires_at: string;
}

export function getIdempotencyCache(input: {
  userId: string;
  idempotencyKey: string;
  method: string;
  path: string;
}): IdempotencyCacheRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM idempotency_cache
      WHERE user_id = ?
        AND idempotency_key = ?
        AND method = ?
        AND path = ?
        AND expires_at > ?
      LIMIT 1
    `,
    )
    .get(
      input.userId,
      input.idempotencyKey,
      input.method.toUpperCase(),
      input.path,
      new Date().toISOString(),
    ) as IdempotencyCacheRecord | undefined;
  return row;
}

export function saveIdempotencyCache(input: IdempotencyCacheRecord): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO idempotency_cache (
      idempotency_key, user_id, method, path, request_hash, status_code,
      response_body, created_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.idempotency_key,
      input.user_id,
      input.method.toUpperCase(),
      input.path,
      input.request_hash,
      input.status_code,
      input.response_body,
      input.created_at,
      input.expires_at,
    );
}

export function pruneIdempotencyCache(nowMs?: number): number {
  const nowIso = new Date(nowMs ?? Date.now()).toISOString();
  const result = getDb()
    .prepare('DELETE FROM idempotency_cache WHERE expires_at <= ?')
    .run(nowIso);
  return result.changes;
}

// --- Dead-letter queue ---

export interface DeadLetterRecord {
  id: string;
  source_type: string;
  source_id: string;
  payload: string;
  error_class: string;
  error_detail: string | null;
  attempts: number;
  created_at: string;
  last_retry_at: string | null;
  resolved_at: string | null;
}

export function scanDeadLetterQueue(limit = 50): DeadLetterRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM dead_letter_queue
      WHERE resolved_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `,
    )
    .all(limit) as DeadLetterRecord[];
}

// --- Talk runs ---

export type TalkRunKind = 'conversation' | 'instruction_review';
export type TalkRunTaskType = 'chat' | 'browser';
export type TalkRunBrowserPhase = 'starting' | 'interacting' | 'summarizing';
export type TalkRunBlockedReason =
  | 'login_required'
  | 'phone_approval'
  | 'app_approval'
  | 'code_entry'
  | 'session_conflict'
  | 'manual_takeover';
export type TalkRunSelectedMode = 'api' | 'subscription';
export type TalkRunTransport = 'direct' | 'subscription';

export interface TalkRunRecord {
  id: string;
  talk_id: string | null;
  thread_id: string;
  requested_by: string;
  status: TalkRunStatus;
  trigger_message_id: string | null;
  job_id?: string | null;
  target_agent_id?: string | null;
  idempotency_key: string | null;
  run_kind?: TalkRunKind;
  response_group_id?: string | null;
  sequence_index?: number | null;
  executor_alias: string | null;
  executor_model: string | null;
  source_binding_id?: string | null;
  source_external_message_id?: string | null;
  source_thread_key?: string | null;
  task_type?: TalkRunTaskType | null;
  browser_phase?: TalkRunBrowserPhase | null;
  blocked_reason?: TalkRunBlockedReason | null;
  browser_session_id?: string | null;
  selected_mode?: TalkRunSelectedMode | null;
  transport?: TalkRunTransport | null;
  timeout_phase?: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_reason: string | null;
  metadata_json?: string | null;
}

export function createTalkRun(input: TalkRunRecord): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_runs (
      id, talk_id, thread_id, requested_by, status, trigger_message_id, job_id, target_agent_id, idempotency_key,
      run_kind, response_group_id, sequence_index, executor_alias, executor_model,
      source_binding_id, source_external_message_id, source_thread_key,
      task_type, browser_phase, blocked_reason, browser_session_id, selected_mode, transport, timeout_phase,
      created_at, started_at, ended_at, cancel_reason, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.id,
      input.talk_id,
      input.thread_id,
      input.requested_by,
      input.status,
      input.trigger_message_id,
      input.job_id ?? null,
      input.target_agent_id || null,
      input.idempotency_key,
      input.run_kind ?? 'conversation',
      input.response_group_id || null,
      input.sequence_index ?? null,
      input.executor_alias,
      input.executor_model,
      input.source_binding_id || null,
      input.source_external_message_id || null,
      input.source_thread_key || null,
      input.task_type ?? null,
      input.browser_phase ?? null,
      input.blocked_reason ?? null,
      input.browser_session_id ?? null,
      input.selected_mode ?? null,
      input.transport ?? null,
      input.timeout_phase ?? null,
      input.created_at,
      input.started_at,
      input.ended_at,
      input.cancel_reason,
      input.metadata_json ?? null,
    );
}

export function setTalkRunMetadataJson(
  runId: string,
  metadataJson: string | null,
): void {
  getDb()
    .prepare(
      `
      UPDATE talk_runs
      SET metadata_json = ?
      WHERE id = ?
    `,
    )
    .run(metadataJson, runId);
}

function parseRunMetadataJson(
  metadataJson: string | null | undefined,
): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function parseMainBrowserBlockFromMetadata(
  metadataJson: string | null | undefined,
): BrowserBlockMetadata | null {
  const metadata = parseRunMetadataJson(metadataJson);
  const browserBlock = metadata.browserBlock;
  if (
    !browserBlock ||
    typeof browserBlock !== 'object' ||
    Array.isArray(browserBlock)
  ) {
    return null;
  }
  return browserBlock as BrowserBlockMetadata;
}

export function normalizeTalkRunTaskType(
  value: unknown,
): TalkRunTaskType | null {
  return value === 'chat' || value === 'browser' ? value : null;
}

export function normalizeTalkRunBrowserPhase(
  value: unknown,
): TalkRunBrowserPhase | null {
  return value === 'starting' ||
    value === 'interacting' ||
    value === 'summarizing'
    ? value
    : null;
}

export function normalizeTalkRunBlockedReason(
  value: unknown,
): TalkRunBlockedReason | null {
  return value === 'login_required' ||
    value === 'phone_approval' ||
    value === 'app_approval' ||
    value === 'code_entry' ||
    value === 'session_conflict' ||
    value === 'manual_takeover'
    ? value
    : null;
}

export function normalizeTalkRunSelectedMode(
  value: unknown,
): TalkRunSelectedMode | null {
  return value === 'api' || value === 'subscription' ? value : null;
}

export function normalizeTalkRunTransport(
  value: unknown,
): TalkRunTransport | null {
  return value === 'direct' || value === 'subscription' ? value : null;
}

export function inferTalkRunBlockedReasonFromBrowserBlock(
  browserBlock: BrowserBlockMetadata | null,
): TalkRunBlockedReason | null {
  if (!browserBlock) return null;
  if (browserBlock.kind === 'session_conflict') {
    return 'session_conflict';
  }
  if (browserBlock.kind === 'human_step_required') {
    return 'manual_takeover';
  }
  const text = [
    browserBlock.message,
    browserBlock.title,
    browserBlock.url,
    browserBlock.riskReason,
  ]
    .filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    .join(' ')
    .toLowerCase();
  if (/\b(linkedin )?app\b/.test(text)) {
    return 'app_approval';
  }
  if (/\bphone\b|\bdevice\b/.test(text)) {
    return 'phone_approval';
  }
  if (/\bcode\b/.test(text)) {
    return 'code_entry';
  }
  return 'login_required';
}

export function getTalkRunTaskType(
  run: Pick<TalkRunRecord, 'task_type' | 'metadata_json'>,
): TalkRunTaskType {
  const typed = normalizeTalkRunTaskType(run.task_type);
  if (typed) return typed;
  const metadata = parseRunMetadataJson(run.metadata_json);
  if (
    metadata.browserBlock ||
    metadata.executionStrategy === 'browser_fast_lane' ||
    metadata.routeReason === 'browser_fast_lane'
  ) {
    return 'browser';
  }
  return 'chat';
}

export function getTalkRunBrowserPhase(
  run: Pick<TalkRunRecord, 'browser_phase'>,
): TalkRunBrowserPhase | null {
  return normalizeTalkRunBrowserPhase(run.browser_phase);
}

export function getTalkRunBlockedReason(
  run: Pick<TalkRunRecord, 'blocked_reason' | 'metadata_json'>,
): TalkRunBlockedReason | null {
  const typed = normalizeTalkRunBlockedReason(run.blocked_reason);
  if (typed) return typed;
  return inferTalkRunBlockedReasonFromBrowserBlock(
    parseMainBrowserBlockFromMetadata(run.metadata_json),
  );
}

export function getTalkRunBrowserSessionId(
  run: Pick<TalkRunRecord, 'browser_session_id' | 'metadata_json'>,
): string | null {
  if (typeof run.browser_session_id === 'string' && run.browser_session_id) {
    return run.browser_session_id;
  }
  return (
    parseMainBrowserBlockFromMetadata(run.metadata_json)?.sessionId ?? null
  );
}

export function getTalkRunSelectedMode(
  run: Pick<TalkRunRecord, 'selected_mode' | 'metadata_json'>,
): TalkRunSelectedMode | null {
  const typed = normalizeTalkRunSelectedMode(run.selected_mode);
  if (typed) return typed;
  const metadata = parseRunMetadataJson(run.metadata_json);
  const authPath =
    metadata.executionDecision &&
    typeof metadata.executionDecision === 'object' &&
    !Array.isArray(metadata.executionDecision)
      ? (metadata.executionDecision as Record<string, unknown>).authPath
      : null;
  if (authPath === 'api_key') return 'api';
  if (authPath === 'subscription') return 'subscription';
  return null;
}

export function getTalkRunTransport(
  run: Pick<TalkRunRecord, 'transport' | 'metadata_json'>,
): TalkRunTransport | null {
  const typed = normalizeTalkRunTransport(run.transport);
  if (typed) return typed;
  const metadata = parseRunMetadataJson(run.metadata_json);
  const backend =
    metadata.executionDecision &&
    typeof metadata.executionDecision === 'object' &&
    !Array.isArray(metadata.executionDecision)
      ? (metadata.executionDecision as Record<string, unknown>).backend
      : null;
  if (backend === 'direct_http') return 'direct';
  if (backend === 'container') return 'subscription';
  return null;
}

export function getTalkRunTimeoutPhase(
  run: Pick<TalkRunRecord, 'timeout_phase' | 'metadata_json'>,
): string | null {
  if (typeof run.timeout_phase === 'string' && run.timeout_phase) {
    return run.timeout_phase;
  }
  const metadata = parseRunMetadataJson(run.metadata_json);
  return typeof metadata.timeoutPhase === 'string'
    ? metadata.timeoutPhase
    : null;
}

export function updateTalkRunMetadata(
  runId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown> | null,
): string | null {
  const current = getDb()
    .prepare(
      `
      SELECT metadata_json
      FROM talk_runs
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(runId) as { metadata_json: string | null } | undefined;

  const nextValue = updater(parseRunMetadataJson(current?.metadata_json));
  const nextJson =
    nextValue && Object.keys(nextValue).length > 0
      ? JSON.stringify(nextValue)
      : null;
  setTalkRunMetadataJson(runId, nextJson);
  return nextJson;
}

export function setTalkRunExecutorProfile(input: {
  runId: string;
  executorAlias: string;
  executorModel: string;
}): void {
  getDb()
    .prepare(
      `
      UPDATE talk_runs
      SET executor_alias = ?, executor_model = ?
      WHERE id = ?
    `,
    )
    .run(input.executorAlias, input.executorModel, input.runId);
}

export function getTalkRunById(runId: string): TalkRunRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM talk_runs WHERE id = ?')
    .get(runId) as TalkRunRecord | undefined;
  return row || null;
}

export function getRunningTalkRun(talkId: string): TalkRunRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE talk_id = ? AND status IN ('running', 'awaiting_confirmation')
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          ELSE 1
        END ASC,
        created_at ASC
      LIMIT 1
    `,
    )
    .get(talkId) as TalkRunRecord | undefined;
  return row || null;
}

export function getQueuedTalkRuns(
  talkId: string,
  limit?: number,
): TalkRunRecord[] {
  if (limit && limit > 0) {
    return getDb()
      .prepare(
        `
        SELECT *
        FROM talk_runs
        WHERE talk_id = ? AND status = 'queued'
        ORDER BY created_at ASC
        LIMIT ?
      `,
      )
      .all(talkId, limit) as TalkRunRecord[];
  }
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE talk_id = ? AND status = 'queued'
      ORDER BY created_at ASC
    `,
    )
    .all(talkId) as TalkRunRecord[];
}

export function listQueuedTalkRuns(limit = 50): TalkRunRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT ?
    `,
    )
    .all(normalizedLimit) as TalkRunRecord[];
}

export function listRunningTalkRuns(limit = 50): TalkRunRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE status IN ('running', 'awaiting_confirmation')
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          ELSE 1
        END ASC,
        created_at ASC
      LIMIT ?
    `,
    )
    .all(normalizedLimit) as TalkRunRecord[];
}

export function countRunningTalkRuns(): number {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM talk_runs
      WHERE status IN ('running', 'awaiting_confirmation')
    `,
    )
    .get() as { count: number };
  return row.count;
}

export function hasActiveTalkRuns(
  talkId: string,
  threadId?: string | null,
): boolean {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM talk_runs
      WHERE talk_id = ?
        AND (? IS NULL OR thread_id = ?)
        AND status IN ('queued', 'running', 'awaiting_confirmation')
    `,
    )
    .get(talkId, threadId ?? null, threadId ?? null) as { count: number };
  return row.count > 0;
}

export function listTalkRunsForTalk(
  talkId: string,
  limit = 50,
): Array<
  TalkRunRecord & {
    target_agent_nickname: string | null;
  }
> {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return getDb()
    .prepare(
      `
      SELECT
        r.*,
        COALESCE(
          (
            SELECT ta.nickname
            FROM talk_agents ta
            WHERE ta.talk_id = r.talk_id
              AND ta.registered_agent_id = r.target_agent_id
            ORDER BY ta.sort_order ASC, ta.created_at ASC
            LIMIT 1
          ),
          ra.name
        ) AS target_agent_nickname
      FROM talk_runs r
      LEFT JOIN registered_agents ra ON ra.id = r.target_agent_id
      WHERE r.talk_id = ?
        AND COALESCE(r.run_kind, 'conversation') = 'conversation'
      ORDER BY r.created_at DESC
      LIMIT ?
    `,
    )
    .all(talkId, normalizedLimit) as Array<
    TalkRunRecord & { target_agent_nickname: string | null }
  >;
}

/**
 * Appends an assistant message and related outbox event.
 *
 * Safe to call inside an existing transaction (better-sqlite3 will use savepoints
 * for nested transactional scopes), and also safe as a standalone helper.
 */
export function appendAssistantMessageWithOutbox(input: {
  talkId: string;
  threadId: string;
  runId: string;
  messageId: string;
  content: string;
  metadataJson?: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  sequenceInRun?: number | null;
  createdAt?: string;
}): TalkMessageRecord {
  const tx = getDb().transaction((txInput: typeof input): TalkMessageRecord => {
    const createdAt = txInput.createdAt || new Date().toISOString();
    const parsedMetadata = parseMessageMetadataJson(txInput.metadataJson);
    const mergedMetadata: Record<string, unknown> | null =
      parsedMetadata ||
      (!txInput.metadataJson && (txInput.agentId || txInput.agentNickname)
        ? {}
        : null);
    if (mergedMetadata) {
      if (txInput.agentId && typeof mergedMetadata.agentId !== 'string') {
        mergedMetadata.agentId = txInput.agentId;
      }
      if (
        txInput.agentNickname &&
        typeof mergedMetadata.agentNickname !== 'string'
      ) {
        mergedMetadata.agentNickname = txInput.agentNickname;
      }
    }
    const metadataJson =
      mergedMetadata && Object.keys(mergedMetadata).length > 0
        ? JSON.stringify(mergedMetadata)
        : txInput.metadataJson || null;
    const message: TalkMessageRecord = {
      id: txInput.messageId,
      talk_id: txInput.talkId,
      thread_id: txInput.threadId,
      role: 'assistant',
      content: txInput.content,
      created_by: null,
      created_at: createdAt,
      run_id: txInput.runId,
      metadata_json: metadataJson,
      sequence_in_run: txInput.sequenceInRun ?? null,
    };

    createTalkMessage({
      id: message.id,
      talkId: message.talk_id!,
      threadId: txInput.threadId,
      role: message.role,
      content: message.content,
      createdBy: null,
      runId: message.run_id,
      metadataJson: message.metadata_json,
      sequenceInRun: message.sequence_in_run,
      createdAt: message.created_at,
    });

    touchTalkUpdatedAt(txInput.talkId, createdAt);
    appendOutboxEvent({
      topic: `talk:${txInput.talkId}`,
      eventType: 'message_appended',
      payload: JSON.stringify({
        talkId: txInput.talkId,
        threadId: txInput.threadId,
        messageId: txInput.messageId,
        runId: txInput.runId,
        role: 'assistant',
        createdBy: null,
        content: txInput.content,
        createdAt,
        agentId: txInput.agentId || null,
        agentNickname: txInput.agentNickname || null,
        metadata: mergedMetadata,
      }),
    });

    return message;
  });

  return tx(input);
}

export function appendRuntimeTalkMessage(input: {
  id: string;
  talkId: string;
  threadId: string;
  runId: string;
  role: 'assistant' | 'tool';
  content: string;
  metadataJson?: string | null;
  sequenceInRun: number;
  createdAt?: string;
}): TalkMessageRecord {
  const tx = getDb().transaction((txInput: typeof input): TalkMessageRecord => {
    const createdAt = txInput.createdAt || new Date().toISOString();
    const metadata = parseMessageMetadataJson(txInput.metadataJson);
    const actor = extractMessageActorFromMetadata(metadata);
    const message: TalkMessageRecord = {
      id: txInput.id,
      talk_id: txInput.talkId,
      thread_id: txInput.threadId,
      role: txInput.role,
      content: txInput.content,
      created_by: null,
      created_at: createdAt,
      run_id: txInput.runId,
      metadata_json: txInput.metadataJson || null,
      sequence_in_run: txInput.sequenceInRun,
    };

    createTalkMessage({
      id: message.id,
      talkId: message.talk_id!,
      threadId: txInput.threadId,
      role: message.role,
      content: message.content,
      createdBy: null,
      runId: message.run_id,
      metadataJson: message.metadata_json,
      sequenceInRun: message.sequence_in_run,
      createdAt: message.created_at,
    });

    touchTalkUpdatedAt(txInput.talkId, createdAt);
    appendOutboxEvent({
      topic: `talk:${txInput.talkId}`,
      eventType: 'message_appended',
      payload: JSON.stringify({
        talkId: txInput.talkId,
        threadId: txInput.threadId,
        messageId: txInput.id,
        runId: txInput.runId,
        role: txInput.role,
        createdBy: null,
        content: txInput.content,
        createdAt,
        agentId: actor.agentId,
        agentNickname: actor.agentNickname,
        metadata,
      }),
    });

    return message;
  });

  return tx(input);
}

export function claimQueuedTalkRuns(
  limit: number,
  now?: string,
): TalkRunRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const tx = getDb().transaction(
    (txLimit: number, txNow?: string): TalkRunRecord[] => {
      const startedAt = txNow || new Date().toISOString();
      const queued = getDb()
        .prepare(
          `
          SELECT r.*
          FROM talk_runs r
          WHERE r.status = 'queued' AND r.talk_id IS NOT NULL
            AND (
              r.sequence_index IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM talk_runs prior
                WHERE prior.response_group_id = r.response_group_id
                  AND prior.sequence_index IS NOT NULL
                  AND prior.sequence_index < r.sequence_index
                  AND prior.status NOT IN ('completed', 'failed')
              )
            )
          ORDER BY r.created_at ASC, COALESCE(r.sequence_index, -1) ASC, r.id ASC
          LIMIT ?
        `,
        )
        .all(txLimit) as TalkRunRecord[];
      if (queued.length === 0) return [];

      const updateStmt = getDb().prepare(
        `
        UPDATE talk_runs
        SET status = 'running',
            browser_phase = CASE
              WHEN task_type = 'browser' THEN 'starting'
              ELSE browser_phase
            END,
            blocked_reason = NULL,
            timeout_phase = NULL,
            started_at = ?,
            ended_at = NULL,
            cancel_reason = NULL
        WHERE id = ? AND status = 'queued'
      `,
      );
      const claimed: TalkRunRecord[] = [];
      for (const run of queued) {
        const updated = updateStmt.run(startedAt, run.id);
        if (updated.changes !== 1) continue;
        const claimedRun: TalkRunRecord = {
          ...run,
          status: 'running',
          started_at: startedAt,
          ended_at: null,
          cancel_reason: null,
        };
        claimed.push(claimedRun);
        appendOutboxEvent({
          topic: `talk:${run.talk_id}`,
          eventType: 'talk_run_started',
          payload: JSON.stringify({
            talkId: run.talk_id,
            threadId: run.thread_id,
            runId: run.id,
            runKind: run.run_kind ?? 'conversation',
            triggerMessageId: run.trigger_message_id,
            targetAgentId: run.target_agent_id || null,
            responseGroupId: run.response_group_id || null,
            sequenceIndex: run.sequence_index ?? null,
            status: 'running',
            executorAlias: run.executor_alias,
            executorModel: run.executor_model,
          }),
        });
      }

      return claimed;
    },
  );

  return tx(normalizedLimit, now);
}

export function completeRunAndPromoteNextAtomic(input: {
  runId: string;
  responseMessageId: string;
  responseContent: string;
  responseMetadataJson?: string | null;
  deliverySuppressed?: boolean;
  suppressionReason?: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  latencyMs?: number | null;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  } | null;
  responseSequenceInRun?: number | null;
  now?: string;
}): {
  applied: boolean;
  talkId: string | null;
  deliveryQueued: boolean;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      applied: boolean;
      talkId: string | null;
      deliveryQueued: boolean;
    } => {
      const now = txInput.now || new Date().toISOString();
      const run = getDb()
        .prepare(
          `
          SELECT id, talk_id, thread_id, trigger_message_id, target_agent_id, executor_alias, executor_model,
                 run_kind, response_group_id, sequence_index,
                 source_binding_id, source_external_message_id, source_thread_key, metadata_json
          FROM talk_runs
          WHERE id = ? AND status = 'running'
          LIMIT 1
        `,
        )
        .get(txInput.runId) as
        | {
            id: string;
            talk_id: string;
            thread_id: string;
            trigger_message_id: string | null;
            target_agent_id: string | null;
            executor_alias: string | null;
            executor_model: string | null;
            run_kind: TalkRunKind | null;
            response_group_id: string | null;
            sequence_index: number | null;
            source_binding_id: string | null;
            source_external_message_id: string | null;
            source_thread_key: string | null;
            metadata_json: string | null;
          }
        | undefined;
      if (!run) {
        return { applied: false, talkId: null, deliveryQueued: false };
      }

      const suppressionActive =
        run.source_binding_id !== null && txInput.deliverySuppressed === true;

      const completed = getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'completed',
              ended_at = ?,
              cancel_reason = NULL
          WHERE id = ? AND status = 'running'
        `,
        )
        .run(now, run.id);
      if (completed.changes !== 1) {
        return { applied: false, talkId: run.talk_id, deliveryQueued: false };
      }

      const currentMetadata = parseRunMetadataJson(run.metadata_json);
      const responseMetadata = parseRunMetadataJson(
        txInput.responseMetadataJson,
      );
      if (Object.keys(responseMetadata).length > 0) {
        currentMetadata.responseMetadata = responseMetadata;
      }
      if (run.source_binding_id) {
        currentMetadata.channelDelivery = {
          suppressed: suppressionActive,
          suppressionReason: suppressionActive
            ? txInput.suppressionReason || null
            : null,
        };
      }
      if (Object.keys(currentMetadata).length > 0 || run.metadata_json) {
        setTalkRunMetadataJson(
          run.id,
          Object.keys(currentMetadata).length > 0
            ? JSON.stringify(currentMetadata)
            : null,
        );
      }

      const responseMessage = suppressionActive
        ? null
        : appendAssistantMessageWithOutbox({
            talkId: run.talk_id,
            threadId: run.thread_id,
            runId: run.id,
            messageId: txInput.responseMessageId,
            content: txInput.responseContent,
            metadataJson: txInput.responseMetadataJson || null,
            agentId: txInput.agentId || run.target_agent_id,
            agentNickname: txInput.agentNickname || null,
            sequenceInRun: txInput.responseSequenceInRun ?? null,
            createdAt: now,
          });

      if (txInput.modelId) {
        getDb()
          .prepare(
            `
            INSERT INTO llm_attempts (
              run_id, talk_id, agent_id, provider_id, model_id,
              status, latency_ms, input_tokens, cached_input_tokens,
              output_tokens,
              estimated_cost_usd, created_at
            ) VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            txInput.runId,
            run.talk_id,
            txInput.agentId || run.target_agent_id || null,
            txInput.providerId || null,
            txInput.modelId,
            txInput.latencyMs ?? null,
            txInput.usage?.inputTokens ?? null,
            txInput.usage?.cachedInputTokens ?? null,
            txInput.usage?.outputTokens ?? null,
            txInput.usage?.estimatedCostUsd ?? null,
            now,
          );
      }

      let deliveryQueued = false;
      if (run.source_binding_id && responseMessage) {
        const binding = getDb()
          .prepare(
            `
            SELECT b.id, b.active, b.target_kind, b.target_id, p.delivery_mode
            FROM talk_channel_bindings b
            JOIN talk_channel_policies p ON p.binding_id = b.id
            WHERE b.id = ?
            LIMIT 1
          `,
          )
          .get(run.source_binding_id) as
          | {
              id: string;
              active: number;
              target_kind: string;
              target_id: string;
              delivery_mode: 'reply' | 'channel';
            }
          | undefined;
        if (binding) {
          const immediateDeadLetter = binding.active !== 1;
          getDb()
            .prepare(
              `
              INSERT INTO channel_delivery_outbox (
                id, binding_id, talk_id, run_id, talk_message_id, target_kind,
                target_id, payload_json, status, reason_code, reason_detail,
                dedupe_key, available_at, created_at, updated_at, attempt_count
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `,
            )
            .run(
              `delivery_${randomUUID()}`,
              binding.id,
              run.talk_id,
              run.id,
              responseMessage.id,
              binding.target_kind,
              binding.target_id,
              JSON.stringify({
                content: txInput.responseContent,
                metadataJson: txInput.responseMetadataJson || null,
                deliveryMode: binding.delivery_mode,
                sourceThreadKey: run.source_thread_key || null,
                sourceExternalMessageId: run.source_external_message_id || null,
              }),
              immediateDeadLetter ? 'dead_letter' : 'pending',
              immediateDeadLetter ? 'binding_deactivated' : null,
              immediateDeadLetter
                ? 'Binding was deactivated before the response could be delivered'
                : null,
              `delivery:${run.id}:${responseMessage.id}`,
              now,
              now,
              now,
            );
          deliveryQueued = !immediateDeadLetter;
        }
      }

      appendOutboxEvent({
        topic: `talk:${run.talk_id}`,
        eventType: 'talk_run_completed',
        payload: JSON.stringify({
          talkId: run.talk_id,
          threadId: run.thread_id,
          runId: run.id,
          runKind: run.run_kind ?? 'conversation',
          triggerMessageId: run.trigger_message_id,
          responseMessageId: responseMessage?.id || null,
          responseGroupId: run.response_group_id,
          sequenceIndex: run.sequence_index,
          executorAlias: run.executor_alias,
          executorModel: run.executor_model,
        }),
      });

      return {
        applied: true,
        talkId: run.talk_id,
        deliveryQueued,
      };
    },
  );

  return tx(input);
}

export function failRunAndPromoteNextAtomic(input: {
  runId: string;
  errorCode: string;
  errorMessage: string;
  metadataPatch?: Record<string, unknown> | null;
  now?: string;
}): {
  applied: boolean;
  talkId: string | null;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      applied: boolean;
      talkId: string | null;
    } => {
      const now = txInput.now || new Date().toISOString();
      const run = getDb()
        .prepare(
          `
          SELECT id, talk_id, thread_id, trigger_message_id, target_agent_id, executor_alias, executor_model,
                 run_kind, response_group_id, sequence_index, metadata_json
          FROM talk_runs
          WHERE id = ? AND status = 'running'
          LIMIT 1
        `,
        )
        .get(txInput.runId) as
        | {
            id: string;
            talk_id: string;
            thread_id: string;
            trigger_message_id: string | null;
            target_agent_id: string | null;
            executor_alias: string | null;
            executor_model: string | null;
            run_kind: TalkRunKind | null;
            response_group_id: string | null;
            sequence_index: number | null;
            metadata_json: string | null;
          }
        | undefined;
      if (!run) {
        return { applied: false, talkId: null };
      }

      const failed = getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'failed',
              ended_at = ?,
              cancel_reason = ?
          WHERE id = ? AND status = 'running'
        `,
        )
        .run(
          now,
          `${txInput.errorCode}: ${txInput.errorMessage}`.slice(0, 500),
          run.id,
        );
      if (failed.changes !== 1) {
        return { applied: false, talkId: run.talk_id };
      }

      if (txInput.metadataPatch && Object.keys(txInput.metadataPatch).length) {
        const currentMetadata = parseRunMetadataJson(run.metadata_json);
        currentMetadata.responseMetadata = txInput.metadataPatch;
        setTalkRunMetadataJson(run.id, JSON.stringify(currentMetadata));
      }

      appendOutboxEvent({
        topic: `talk:${run.talk_id}`,
        eventType: 'talk_run_failed',
        payload: JSON.stringify({
          talkId: run.talk_id,
          threadId: run.thread_id,
          runId: run.id,
          runKind: run.run_kind ?? 'conversation',
          triggerMessageId: run.trigger_message_id,
          responseGroupId: run.response_group_id,
          sequenceIndex: run.sequence_index,
          errorCode: txInput.errorCode,
          errorMessage: txInput.errorMessage,
          executorAlias: run.executor_alias,
          executorModel: run.executor_model,
        }),
      });

      return {
        applied: true,
        talkId: run.talk_id,
      };
    },
  );

  return tx(input);
}

export function cancelTalkRunsAtomic(input: {
  talkId: string;
  threadId?: string | null;
  cancelledBy: string;
  now?: string;
}): {
  cancelledRuns: number;
  cancelledRunIds: string[];
  cancelledRunning: boolean;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      cancelledRuns: number;
      cancelledRunIds: string[];
      cancelledRunning: boolean;
    } => {
      const now = txInput.now || new Date().toISOString();
      const threadId = txInput.threadId
        ? resolveThreadIdForTalk(txInput.talkId, txInput.threadId)
        : null;
      const activeRuns = getDb()
        .prepare(
          `
          SELECT id, thread_id, status, trigger_message_id, target_agent_id, executor_alias, executor_model
                 , response_group_id, sequence_index
          FROM talk_runs
          WHERE talk_id = ?
            AND (? IS NULL OR thread_id = ?)
            AND status IN ('queued', 'running', 'awaiting_confirmation')
          ORDER BY created_at ASC
        `,
        )
        .all(txInput.talkId, threadId, threadId) as Array<{
        id: string;
        thread_id: string;
        status: TalkRunStatus;
        trigger_message_id: string | null;
        target_agent_id: string | null;
        executor_alias: string | null;
        executor_model: string | null;
        response_group_id: string | null;
        sequence_index: number | null;
      }>;

      const cancelledRunIds: string[] = [];
      let cancelledRunning = false;
      const cancelStmt = getDb().prepare(
        `
        UPDATE talk_runs
        SET status = 'cancelled',
            ended_at = ?,
            cancel_reason = ?
        WHERE id = ? AND status IN ('queued', 'running', 'awaiting_confirmation')
      `,
      );
      for (const run of activeRuns) {
        const updated = cancelStmt.run(
          now,
          `Cancelled by ${txInput.cancelledBy}`.slice(0, 500),
          run.id,
        );
        if (updated.changes !== 1) continue;
        cancelledRunIds.push(run.id);
        supersedePendingTalkActionConfirmationsForRun({
          runId: run.id,
          resolvedBy: txInput.cancelledBy,
          reason:
            `Run cancelled by ${txInput.cancelledBy} before confirmation was resolved.`.slice(
              0,
              500,
            ),
        });
        if (run.status === 'running') {
          cancelledRunning = true;
          appendOutboxEvent({
            topic: `talk:${txInput.talkId}`,
            eventType: 'talk_response_cancelled',
            payload: JSON.stringify({
              talkId: txInput.talkId,
              threadId: run.thread_id,
              runId: run.id,
              agentId: run.target_agent_id || null,
              responseGroupId: run.response_group_id,
              sequenceIndex: run.sequence_index,
            }),
          });
        }
      }

      if (cancelledRunIds.length > 0) {
        appendOutboxEvent({
          topic: `talk:${txInput.talkId}`,
          eventType: 'talk_run_cancelled',
          payload: JSON.stringify({
            talkId: txInput.talkId,
            cancelledBy: txInput.cancelledBy,
            runIds: cancelledRunIds,
            threadIds: Array.from(
              new Set(
                activeRuns
                  .filter((run) => cancelledRunIds.includes(run.id))
                  .map((run) => run.thread_id)
                  .filter((threadId): threadId is string => Boolean(threadId)),
              ),
            ),
          }),
        });
      }

      return {
        cancelledRuns: cancelledRunIds.length,
        cancelledRunIds,
        cancelledRunning,
      };
    },
  );

  return tx(input);
}

export function failInterruptedRunsOnStartup(now?: string): {
  failedRunIds: string[];
  promotedRunIds: string[];
} {
  const tx = getDb().transaction(
    (
      inputNow?: string,
    ): { failedRunIds: string[]; promotedRunIds: string[] } => {
      const currentNow = inputNow || new Date().toISOString();
      const runningRuns = getDb()
        .prepare(
          `
          SELECT id, talk_id, thread_id, trigger_message_id, executor_alias, executor_model, run_kind
          FROM talk_runs
          WHERE status = 'running' AND talk_id IS NOT NULL
          ORDER BY created_at ASC
        `,
        )
        .all() as Array<{
        id: string;
        talk_id: string;
        thread_id: string;
        trigger_message_id: string | null;
        executor_alias: string | null;
        executor_model: string | null;
        run_kind: TalkRunKind | null;
      }>;

      const failedRunIds: string[] = [];
      for (const run of runningRuns) {
        const updated = getDb()
          .prepare(
            `
            UPDATE talk_runs
            SET status = 'failed',
                ended_at = ?,
                cancel_reason = ?
            WHERE id = ? AND status = 'running'
          `,
          )
          .run(currentNow, 'interrupted_by_restart', run.id);
        if (updated.changes !== 1) continue;

        failedRunIds.push(run.id);
        appendOutboxEvent({
          topic: `talk:${run.talk_id}`,
          eventType: 'talk_run_failed',
          payload: JSON.stringify({
            talkId: run.talk_id,
            threadId: run.thread_id,
            runId: run.id,
            runKind: run.run_kind ?? 'conversation',
            triggerMessageId: run.trigger_message_id,
            errorCode: 'interrupted_by_restart',
            errorMessage: 'Run interrupted by process restart',
            executorAlias: run.executor_alias,
            executorModel: run.executor_model,
          }),
        });
      }

      return { failedRunIds, promotedRunIds: [] };
    },
  );

  return tx(now);
}

export function markTalkRunStatus(
  runId: string,
  status: TalkRunStatus,
  endedAt: string | null,
  cancelReason: string | null,
  startedAt?: string | null,
): void {
  getDb()
    .prepare(
      `
    UPDATE talk_runs
    SET status = ?,
        ended_at = ?,
        cancel_reason = ?,
        started_at = COALESCE(?, started_at)
    WHERE id = ?
  `,
    )
    .run(status, endedAt, cancelReason, startedAt || null, runId);
}

// ============================================================================
// Main Channel Accessors
// ============================================================================

/**
 * @internal Builds the scalar SQL query for resolving the first-author owner of
 * a Main thread. `threadIdExpr` must be a trusted SQL expression such as `?`
 * or `t.thread_id`, never raw user input.
 */
function buildMainThreadOwnerSubquery(threadIdExpr: string): string {
  return `
    SELECT created_by
    FROM talk_messages
    WHERE thread_id = ${threadIdExpr} AND talk_id IS NULL AND role = 'user'
    ORDER BY created_at ASC
    LIMIT 1
  `;
}

/**
 * Derive Main thread ownership from the first user message.
 * No separate table — ownership is a query.
 */
export function getMainThreadOwner(threadId: string): string | null {
  const row = getDb()
    .prepare(buildMainThreadOwnerSubquery('?'))
    .get(threadId) as { created_by: string | null } | undefined;
  return row?.created_by ?? null;
}

export function canUserAccessMainThread(
  threadId: string,
  userId: string,
): boolean {
  const owner = getMainThreadOwner(threadId);
  // New threads (no messages yet) have no owner — allow the creator
  if (owner === null) return true;
  return owner === userId;
}

export function listMainThreadsForUser(userId: string): Array<{
  thread_id: string;
  title: string | null;
  is_pinned: number;
  last_message_at: string;
  message_count: number;
  has_active_run: number;
}> {
  const rows = getDb()
    .prepare(
      `
      SELECT
        t.thread_id,
        mt.title,
        COALESCE(mt.is_pinned, 0) AS is_pinned,
        t.last_message_at,
        t.message_count,
        CASE WHEN COALESCE(r.active_run_count, 0) > 0 THEN 1 ELSE 0 END AS has_active_run
      FROM (
        SELECT
          thread_id,
          MAX(created_at) AS last_message_at,
          COUNT(*) AS message_count
        FROM talk_messages
        WHERE talk_id IS NULL AND thread_id IS NOT NULL
        GROUP BY thread_id
      ) t
      LEFT JOIN main_threads mt ON mt.thread_id = t.thread_id
      LEFT JOIN (
        SELECT
          thread_id,
          COUNT(*) AS active_run_count
        FROM talk_runs
        WHERE talk_id IS NULL
          AND thread_id IS NOT NULL
          AND status IN ('queued', 'running', 'awaiting_confirmation')
        GROUP BY thread_id
      ) r ON r.thread_id = t.thread_id
      WHERE (${buildMainThreadOwnerSubquery('t.thread_id')}) = ?
      ORDER BY COALESCE(mt.is_pinned, 0) DESC, t.last_message_at DESC
    `,
    )
    .all(userId) as Array<{
    thread_id: string;
    title: string | null;
    is_pinned: number;
    last_message_at: string;
    message_count: number;
    has_active_run: number;
  }>;
  return rows;
}

export function getMainThreadTitle(
  threadId: string,
  _userId: string,
): string | null {
  const row = getDb()
    .prepare(`SELECT title FROM main_threads WHERE thread_id = ?`)
    .get(threadId) as { title: string | null } | undefined;
  return normalizeStoredThreadTitle(row?.title ?? null);
}

export function updateMainThreadMetadata(input: {
  threadId: string;
  userId: string;
  title?: string;
  pinned?: boolean;
}): {
  thread_id: string;
  user_id: string;
  title: string | null;
  is_pinned: number;
  updated_at: string;
} | null {
  const normalizedTitle =
    input.title === undefined
      ? undefined
      : validateEditableThreadTitle(input.title);

  const exists = getDb()
    .prepare(
      `
      SELECT 1 AS exists_flag
      FROM talk_messages
      WHERE talk_id IS NULL AND thread_id = ?
      LIMIT 1
    `,
    )
    .get(input.threadId) as { exists_flag: number } | undefined;
  if (!exists) {
    return null;
  }

  const now = new Date().toISOString();
  ensureMainThreadMetadataRow({
    threadId: input.threadId,
    userId: input.userId,
    now,
  });
  const existing = getDb()
    .prepare(
      `
      SELECT title, is_pinned
      FROM main_threads
      WHERE thread_id = ?
    `,
    )
    .get(input.threadId) as
    | {
        title: string | null;
        is_pinned: number;
      }
    | undefined;
  const nextTitle = normalizedTitle ?? existing?.title ?? null;
  const nextPinned =
    input.pinned === undefined
      ? (existing?.is_pinned ?? 0)
      : input.pinned
        ? 1
        : 0;
  getDb()
    .prepare(
      `
      UPDATE main_threads
      SET user_id = ?, title = ?, is_pinned = ?, updated_at = ?
      WHERE thread_id = ?
    `,
    )
    .run(input.userId, nextTitle, nextPinned, now, input.threadId);

  return {
    thread_id: input.threadId,
    user_id: input.userId,
    title: nextTitle,
    is_pinned: nextPinned,
    updated_at: now,
  };
}

export function updateMainThreadTitle(input: {
  threadId: string;
  userId: string;
  title: string;
}): {
  thread_id: string;
  user_id: string;
  title: string;
  is_pinned: number;
  updated_at: string;
} | null {
  const updated = updateMainThreadMetadata(input);
  if (!updated || updated.title === null) {
    return null;
  }
  return {
    ...updated,
    title: updated.title,
  };
}

export function deleteMainThread(input: {
  threadId: string;
  userId: string;
}): boolean {
  const tx = getDb().transaction((txInput: typeof input): boolean => {
    const owner = getMainThreadOwner(txInput.threadId);
    if (owner !== txInput.userId) {
      return false;
    }

    const activeRun = getDb()
      .prepare(
        `
        SELECT id
        FROM talk_runs
        WHERE talk_id IS NULL AND thread_id = ?
          AND status IN ('queued', 'running', 'awaiting_confirmation')
        LIMIT 1
      `,
      )
      .get(txInput.threadId) as { id: string } | undefined;
    if (activeRun) {
      throw new ThreadDeleteConflictError(
        'thread_has_active_runs',
        'Threads with active work cannot be deleted.',
      );
    }

    getDb()
      .prepare(
        `
        DELETE FROM talk_runs
        WHERE talk_id IS NULL AND thread_id = ?
      `,
      )
      .run(txInput.threadId);
    const deletedMessages = getDb()
      .prepare(
        `
        DELETE FROM talk_messages
        WHERE talk_id IS NULL AND thread_id = ?
      `,
      )
      .run(txInput.threadId);
    const deletedMetadata = getDb()
      .prepare(
        `
        DELETE FROM main_threads
        WHERE thread_id = ?
      `,
      )
      .run(txInput.threadId);
    return (
      deletedMessages.changes > 0 ||
      deletedMetadata.changes > 0 ||
      owner !== null
    );
  });

  return tx(input);
}

function parseMainRunMetadata(metadataJson: string | null | undefined): {
  kind: string | null;
  parentRunId: string | null;
  promotionState: 'pending' | 'superseded' | null;
} {
  const metadata = parseRunMetadataJson(metadataJson);
  const kind =
    typeof metadata.kind === 'string' && metadata.kind ? metadata.kind : null;
  const parentRunId =
    typeof metadata.parentRunId === 'string' && metadata.parentRunId
      ? metadata.parentRunId
      : null;
  const promotionState =
    metadata.promotionState === 'pending' ||
    metadata.promotionState === 'superseded'
      ? metadata.promotionState
      : null;
  return { kind, parentRunId, promotionState };
}

function isMainPromotionChildRun(run: TalkRunRecord): boolean {
  return parseMainRunMetadata(run.metadata_json).kind === 'main_promotion';
}

function parseMainBrowserBlockMetadata(
  metadataJson: string | null | undefined,
): BrowserBlockMetadata | null {
  return parseMainBrowserBlockFromMetadata(metadataJson);
}

function parseMainResumeRequestMetadata(
  metadataJson: string | null | undefined,
): {
  resumeRequestedAt: string | null;
  resumeRequestedBy: string | null;
} {
  const metadata = parseRunMetadataJson(metadataJson);
  return {
    resumeRequestedAt:
      typeof metadata.resumeRequestedAt === 'string'
        ? metadata.resumeRequestedAt
        : null,
    resumeRequestedBy:
      typeof metadata.resumeRequestedBy === 'string'
        ? metadata.resumeRequestedBy
        : null,
  };
}

function parseMainRunUserVisibleSummary(
  metadataJson: string | null | undefined,
): string | null {
  const metadata = parseRunMetadataJson(metadataJson);
  return typeof metadata.userVisibleSummary === 'string'
    ? metadata.userVisibleSummary
    : null;
}

export function countRunnableMainRuns(input: {
  threadId: string;
  excludeRunId?: string | null;
}): number {
  const row = input.excludeRunId
    ? (getDb()
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM talk_runs
          WHERE thread_id = ? AND talk_id IS NULL
            AND id != ?
            AND status IN ('queued', 'running')
        `,
        )
        .get(input.threadId, input.excludeRunId) as { count: number }) || {
        count: 0,
      }
    : (getDb()
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM talk_runs
          WHERE thread_id = ? AND talk_id IS NULL
            AND status IN ('queued', 'running')
        `,
        )
        .get(input.threadId) as { count: number }) || { count: 0 };
  return row.count || 0;
}

export function getUnambiguousPausedMainBrowserOwner(input: {
  threadId: string;
  excludeRunId?: string | null;
}): {
  runId: string;
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  summary: string | null;
} | null {
  const pausedRuns = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE talk_id IS NULL
        AND thread_id = ?
        AND status = 'awaiting_confirmation'
        ${input.excludeRunId ? 'AND id != ?' : ''}
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(
      ...(input.excludeRunId
        ? [input.threadId, input.excludeRunId]
        : [input.threadId]),
    ) as TalkRunRecord[];

  const owners: Array<{
    run: TalkRunRecord;
    browserBlock: BrowserBlockMetadata;
  }> = [];
  for (const run of pausedRuns) {
    const browserBlock = parseMainBrowserBlockMetadata(run.metadata_json);
    const sessionId = getTalkRunBrowserSessionId(run);
    if (
      !browserBlock ||
      !sessionId ||
      getTalkRunBlockedReason(run) === 'session_conflict'
    ) {
      continue;
    }
    owners.push({
      run,
      browserBlock: {
        ...browserBlock,
        sessionId,
      },
    });
  }
  if (owners.length !== 1) {
    return null;
  }
  const owner = owners[0];
  return {
    runId: owner.run.id,
    sessionId: owner.browserBlock.sessionId!,
    siteKey: owner.browserBlock.siteKey,
    accountLabel: owner.browserBlock.accountLabel ?? null,
    url: owner.browserBlock.url,
    title: owner.browserBlock.title,
    summary:
      parseMainRunUserVisibleSummary(owner.run.metadata_json) ||
      owner.browserBlock.message ||
      null,
  };
}

export function getPendingMainBrowserRun(input: {
  threadId: string;
  excludeRunId?: string | null;
}): {
  runId: string;
  browserBlock: BrowserBlockMetadata;
  summary: string | null;
} | null {
  const pausedRuns = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE talk_id IS NULL
        AND thread_id = ?
        AND status = 'awaiting_confirmation'
        ${input.excludeRunId ? 'AND id != ?' : ''}
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(
      ...(input.excludeRunId
        ? [input.threadId, input.excludeRunId]
        : [input.threadId]),
    ) as TalkRunRecord[];

  for (const run of pausedRuns) {
    const browserBlock = parseMainBrowserBlockMetadata(run.metadata_json);
    if (!browserBlock) {
      continue;
    }
    return {
      runId: run.id,
      browserBlock: {
        ...browserBlock,
        sessionId: browserBlock.sessionId ?? getTalkRunBrowserSessionId(run),
      },
      summary:
        parseMainRunUserVisibleSummary(run.metadata_json) ||
        browserBlock.message ||
        null,
    };
  }

  return null;
}

export function getPausedMainBrowserOwnerForProfile(input: {
  threadId: string;
  siteKey: string;
  accountLabel?: string | null;
  excludeRunId?: string | null;
}): {
  runId: string;
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  summary: string | null;
} | null {
  const pausedRuns = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE talk_id IS NULL
        AND thread_id = ?
        AND status = 'awaiting_confirmation'
        ${input.excludeRunId ? 'AND id != ?' : ''}
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(
      ...(input.excludeRunId
        ? [input.threadId, input.excludeRunId]
        : [input.threadId]),
    ) as TalkRunRecord[];

  const normalizedAccountLabel = input.accountLabel ?? null;
  const owners: Array<{
    run: TalkRunRecord;
    browserBlock: BrowserBlockMetadata;
  }> = [];
  for (const run of pausedRuns) {
    const browserBlock = parseMainBrowserBlockMetadata(run.metadata_json);
    const sessionId = getTalkRunBrowserSessionId(run);
    if (
      !browserBlock ||
      !sessionId ||
      getTalkRunBlockedReason(run) === 'session_conflict'
    ) {
      continue;
    }
    if (
      browserBlock.siteKey !== input.siteKey ||
      (browserBlock.accountLabel ?? null) !== normalizedAccountLabel
    ) {
      continue;
    }
    owners.push({
      run,
      browserBlock: {
        ...browserBlock,
        sessionId,
      },
    });
  }

  if (owners.length !== 1) {
    return null;
  }
  const owner = owners[0];
  return {
    runId: owner.run.id,
    sessionId: owner.browserBlock.sessionId!,
    siteKey: owner.browserBlock.siteKey,
    accountLabel: owner.browserBlock.accountLabel ?? null,
    url: owner.browserBlock.url,
    title: owner.browserBlock.title,
    summary:
      parseMainRunUserVisibleSummary(owner.run.metadata_json) ||
      owner.browserBlock.message ||
      null,
  };
}

function queuePausedMainRun(
  run: TalkRunRecord,
  now: string,
  reason: 'deferred_resume' | 'session_conflict_cleared',
): boolean {
  const current = parseRunMetadataJson(run.metadata_json);
  const next = { ...current };
  delete next.browserBlock;
  delete next.resumeRequestedAt;
  delete next.resumeRequestedBy;
  const metadataJson = JSON.stringify({
    ...next,
    lastHeartbeatAt: now,
  });
  const updated = getDb()
    .prepare(
      `
      UPDATE talk_runs
      SET status = 'queued',
          blocked_reason = NULL,
          timeout_phase = NULL,
          cancel_reason = NULL,
          ended_at = NULL,
          metadata_json = ?
      WHERE id = ? AND status = 'awaiting_confirmation'
    `,
    )
    .run(metadataJson, run.id);
  if (updated.changes !== 1) {
    return false;
  }

  appendOutboxEvent({
    topic: `user:${run.requested_by}`,
    eventType: 'browser_unblocked',
    payload: JSON.stringify({
      runId: run.id,
      threadId: run.thread_id,
      reason,
    }),
  });
  appendOutboxEvent({
    topic: `user:${run.requested_by}`,
    eventType: 'main_run_queued',
    payload: JSON.stringify({
      runId: run.id,
      threadId: run.thread_id,
      status: 'queued',
    }),
  });
  return true;
}

export function queueNextDeferredMainRunIfIdle(
  threadId: string,
  now = new Date().toISOString(),
): string | null {
  // This helper is often called from inside an outer better-sqlite3
  // transaction. queuePausedMainRun() appends an outbox event, and the SSE
  // notifier is intentionally deferred with queueMicrotask so subscribers are
  // notified only after the surrounding synchronous transaction returns. If
  // this code ever moves to async transaction semantics, revisit that ordering.
  if (countRunnableMainRuns({ threadId }) > 0) {
    return null;
  }

  const pausedRuns = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE talk_id IS NULL
        AND thread_id = ?
        AND status = 'awaiting_confirmation'
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(threadId) as TalkRunRecord[];

  const deferredResumeCandidate = pausedRuns
    .map((run) => ({
      run,
      resumeRequestedAt: parseMainResumeRequestMetadata(run.metadata_json)
        .resumeRequestedAt,
    }))
    .filter(
      (entry): entry is { run: TalkRunRecord; resumeRequestedAt: string } =>
        typeof entry.resumeRequestedAt === 'string' &&
        entry.resumeRequestedAt.length > 0,
    )
    .sort((left, right) =>
      left.resumeRequestedAt.localeCompare(right.resumeRequestedAt),
    )[0];
  if (
    deferredResumeCandidate &&
    queuePausedMainRun(deferredResumeCandidate.run, now, 'deferred_resume')
  ) {
    return deferredResumeCandidate.run.id;
  }

  for (const run of pausedRuns) {
    const browserBlock = parseMainBrowserBlockMetadata(run.metadata_json);
    if (
      !browserBlock ||
      browserBlock.kind !== 'session_conflict' ||
      !browserBlock.conflictingRunId
    ) {
      continue;
    }
    const ownerRun = getTalkRunById(browserBlock.conflictingRunId);
    const ownerBlock = ownerRun
      ? parseMainBrowserBlockMetadata(ownerRun.metadata_json)
      : null;
    const ownerStillBlocking =
      ownerRun?.status === 'awaiting_confirmation' &&
      ownerBlock?.kind !== 'session_conflict' &&
      ownerBlock?.sessionId &&
      ownerBlock.sessionId === browserBlock.conflictingSessionId;
    if (ownerStillBlocking) {
      continue;
    }
    if (queuePausedMainRun(run, now, 'session_conflict_cleared')) {
      return run.id;
    }
  }

  return null;
}

function updateParentPromotionState(
  parentRunId: string,
  input: {
    promotionState: 'pending' | 'superseded' | null;
    promotionChildRunId?: string | null;
  },
): void {
  updateTalkRunMetadata(parentRunId, (current) => ({
    ...current,
    promotionRequested: true,
    promotionState: input.promotionState,
    promotionChildRunId:
      input.promotionChildRunId === undefined
        ? ((current.promotionChildRunId as string | null | undefined) ?? null)
        : input.promotionChildRunId,
  }));
}

export function getLastMainRunForThread(
  threadId: string,
): Pick<TalkRunRecord, 'task_type' | 'selected_mode' | 'transport'> | null {
  const row = getDb()
    .prepare(
      `
      SELECT task_type, selected_mode, transport
      FROM talk_runs
      WHERE thread_id = ? AND talk_id IS NULL
        AND trigger_message_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(threadId) as
    | Pick<TalkRunRecord, 'task_type' | 'selected_mode' | 'transport'>
    | undefined;
  return row ?? null;
}

export function listMainRunsForThread(threadId: string): TalkRunRecord[] {
  return getDb()
    .prepare(
      `
      SELECT r.*
      FROM talk_runs r
      LEFT JOIN talk_messages m
        ON m.id = r.trigger_message_id
       AND m.talk_id IS NULL
       AND m.thread_id = r.thread_id
      WHERE r.talk_id IS NULL
        AND r.thread_id = ?
        AND (
          r.status IN ('queued', 'running', 'awaiting_confirmation')
          OR m.id IS NOT NULL
        )
      ORDER BY r.created_at DESC, r.id DESC
    `,
    )
    .all(threadId) as TalkRunRecord[];
}

export function createMainPromotionRunAtomic(input: {
  parentRunId: string;
  childRunId: string;
  threadId: string;
  requestedBy: string;
  triggerMessageId: string;
  targetAgentId?: string | null;
  requiredToolFamilies: string[];
  userVisibleSummary: string;
  handoffNote?: string | null;
  taskDescription: string;
  requiresApproval: boolean;
  carriedBrowserSessions?: Array<Record<string, unknown>>;
  now?: string;
}): TalkRunRecord | null {
  const tx = getDb().transaction(
    (txInput: typeof input): TalkRunRecord | null => {
      const now = txInput.now || new Date().toISOString();
      const parent = getDb()
        .prepare(
          `
        SELECT id
        FROM talk_runs
        WHERE id = ? AND talk_id IS NULL AND thread_id = ?
        LIMIT 1
      `,
        )
        .get(txInput.parentRunId, txInput.threadId) as
        | { id: string }
        | undefined;
      if (!parent) return null;

      const status: TalkRunStatus = txInput.requiresApproval
        ? 'awaiting_confirmation'
        : 'queued';
      const metadataJson = JSON.stringify({
        kind: 'main_promotion',
        parentRunId: txInput.parentRunId,
        requestedToolFamilies: txInput.requiredToolFamilies,
        userVisibleSummary: txInput.userVisibleSummary,
        handoffNote: txInput.handoffNote ?? null,
        taskDescription: txInput.taskDescription,
        carriedBrowserSessions: txInput.carriedBrowserSessions ?? [],
      });

      getDb()
        .prepare(
          `
        INSERT INTO talk_runs (
          id, talk_id, thread_id, requested_by, status,
          trigger_message_id, target_agent_id, created_at, metadata_json
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          txInput.childRunId,
          txInput.threadId,
          txInput.requestedBy,
          status,
          txInput.triggerMessageId,
          txInput.targetAgentId ?? null,
          now,
          metadataJson,
        );

      updateParentPromotionState(txInput.parentRunId, {
        promotionState: null,
        promotionChildRunId: txInput.childRunId,
      });

      const eventType =
        status === 'awaiting_confirmation'
          ? 'main_run_waiting_approval'
          : 'main_run_queued';
      appendOutboxEvent({
        topic: `user:${txInput.requestedBy}`,
        eventType,
        payload: JSON.stringify({
          runId: txInput.childRunId,
          threadId: txInput.threadId,
          parentRunId: txInput.parentRunId,
          status,
          requestedToolFamilies: txInput.requiredToolFamilies,
          userVisibleSummary: txInput.userVisibleSummary,
          createdAt: now,
          triggerMessageId: txInput.triggerMessageId,
        }),
      });

      return {
        id: txInput.childRunId,
        talk_id: null,
        thread_id: txInput.threadId,
        requested_by: txInput.requestedBy,
        status,
        trigger_message_id: txInput.triggerMessageId,
        target_agent_id: txInput.targetAgentId ?? null,
        idempotency_key: null,
        executor_alias: null,
        executor_model: null,
        created_at: now,
        started_at: null,
        ended_at: null,
        cancel_reason: null,
        metadata_json: metadataJson,
      };
    },
  );

  return tx(input);
}

export function supersedePendingMainPromotionRunsAtomic(input: {
  threadId: string;
  requestedBy: string;
  now?: string;
}): string[] {
  const tx = getDb().transaction((txInput: typeof input): string[] => {
    const now = txInput.now || new Date().toISOString();
    const candidates = getDb()
      .prepare(
        `
        SELECT *
        FROM talk_runs
        WHERE talk_id IS NULL
          AND thread_id = ?
          AND status IN ('queued', 'awaiting_confirmation')
        ORDER BY created_at ASC
      `,
      )
      .all(txInput.threadId) as TalkRunRecord[];

    const cancelledRunIds: string[] = [];
    for (const run of candidates) {
      if (!isMainPromotionChildRun(run)) continue;
      const updated = getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'cancelled',
              ended_at = ?,
              cancel_reason = ?
          WHERE id = ? AND status IN ('queued', 'awaiting_confirmation')
        `,
        )
        .run(now, 'superseded_by_new_user_message', run.id);
      if (updated.changes !== 1) continue;
      cancelledRunIds.push(run.id);

      const metadata = parseMainRunMetadata(run.metadata_json);
      if (metadata.parentRunId) {
        updateParentPromotionState(metadata.parentRunId, {
          promotionState: 'superseded',
        });
      }

      appendOutboxEvent({
        topic: `user:${txInput.requestedBy}`,
        eventType: 'main_run_cancelled',
        payload: JSON.stringify({
          runId: run.id,
          threadId: txInput.threadId,
          cancelReason: 'superseded_by_new_user_message',
        }),
      });
    }

    return cancelledRunIds;
  });

  return tx(input);
}

export function cancelMainRunAtomic(input: {
  runId: string;
  cancelledBy: string;
  now?: string;
}): {
  cancelled: boolean;
  cancelledRunning: boolean;
  threadId: string | null;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      cancelled: boolean;
      cancelledRunning: boolean;
      threadId: string | null;
    } => {
      const run = getTalkRunById(txInput.runId);
      if (!run || run.talk_id !== null) {
        return {
          cancelled: false,
          cancelledRunning: false,
          threadId: null,
        };
      }

      if (
        run.status !== 'queued' &&
        run.status !== 'running' &&
        run.status !== 'awaiting_confirmation'
      ) {
        return {
          cancelled: false,
          cancelledRunning: false,
          threadId: run.thread_id,
        };
      }

      const now = txInput.now || new Date().toISOString();
      const cancelReason = `Cancelled by ${txInput.cancelledBy}`.slice(0, 500);
      const updated = getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'cancelled',
              ended_at = ?,
              cancel_reason = ?
          WHERE id = ? AND status IN ('queued', 'running', 'awaiting_confirmation')
        `,
        )
        .run(now, cancelReason, run.id);
      if (updated.changes !== 1) {
        return {
          cancelled: false,
          cancelledRunning: false,
          threadId: run.thread_id,
        };
      }

      if (isMainPromotionChildRun(run)) {
        const metadata = parseMainRunMetadata(run.metadata_json);
        if (metadata.parentRunId) {
          updateParentPromotionState(metadata.parentRunId, {
            promotionState: 'superseded',
          });
        }
      }

      appendOutboxEvent({
        topic: `user:${run.requested_by}`,
        eventType: 'main_run_cancelled',
        payload: JSON.stringify({
          runId: run.id,
          threadId: run.thread_id,
          cancelReason,
        }),
      });

      if (run.thread_id) {
        queueNextDeferredMainRunIfIdle(run.thread_id, now);
      }

      return {
        cancelled: true,
        cancelledRunning: run.status === 'running',
        threadId: run.thread_id,
      };
    },
  );

  return tx(input);
}

export function recordMainRunFirstVisibleAt(input: {
  runId: string;
  firstVisibleAt: string;
}): boolean {
  const existing = getTalkRunById(input.runId);
  if (!existing || existing.talk_id !== null) {
    return false;
  }
  updateTalkRunMetadata(input.runId, (current) => {
    const clientTiming =
      current.clientTiming &&
      typeof current.clientTiming === 'object' &&
      !Array.isArray(current.clientTiming)
        ? { ...(current.clientTiming as Record<string, unknown>) }
        : {};
    if (typeof clientTiming.firstVisibleAt === 'string') {
      return current;
    }
    return {
      ...current,
      clientTiming: {
        ...clientTiming,
        firstVisibleAt: input.firstVisibleAt,
      },
    };
  });
  return true;
}

/**
 * Atomically create a user message and a queued run for the Main channel.
 * Guards: one active run per thread.
 */
export function enqueueMainTurnAtomic(input: {
  threadId: string;
  userId: string;
  content: string;
  messageId: string;
  runId: string;
  taskType?: TalkRunTaskType;
  selectedMode?: TalkRunSelectedMode | null;
  transport?: TalkRunTransport | null;
}): { message: TalkMessageRecord; run: TalkRunRecord } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): { message: TalkMessageRecord; run: TalkRunRecord } => {
      const now = new Date().toISOString();

      supersedePendingMainPromotionRunsAtomic({
        threadId: txInput.threadId,
        requestedBy: txInput.userId,
        now,
      });

      // Runnable-run guard: paused runs may coexist, but queued/running remain exclusive.
      if (countRunnableMainRuns({ threadId: txInput.threadId }) > 0) {
        throw new MainThreadBusyError(txInput.threadId);
      }

      // Insert user message
      getDb()
        .prepare(
          `
          INSERT INTO talk_messages (
            id, talk_id, thread_id, role, content, created_by, created_at
          ) VALUES (?, NULL, ?, 'user', ?, ?, ?)
        `,
        )
        .run(
          txInput.messageId,
          txInput.threadId,
          txInput.content,
          txInput.userId,
          now,
        );
      ensureMainThreadMetadataRow({
        threadId: txInput.threadId,
        userId: txInput.userId,
        now,
      });
      maybePersistMainThreadTitleFromMessages({
        threadId: txInput.threadId,
        userId: txInput.userId,
        currentTitle: null,
      });

      // Insert queued run
      getDb()
        .prepare(
          `
          INSERT INTO talk_runs (
            id, talk_id, thread_id, requested_by, status,
            trigger_message_id, task_type, selected_mode, transport,
            created_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          txInput.runId,
          null,
          txInput.threadId,
          txInput.userId,
          'queued',
          txInput.messageId,
          txInput.taskType ?? 'chat',
          txInput.selectedMode ?? null,
          txInput.transport ?? null,
          now,
          JSON.stringify({
            timing: {
              queueStartedAt: now,
              enqueuedAt: now,
            },
            lastHeartbeatAt: now,
          }),
        );

      appendOutboxEvent({
        topic: `user:${txInput.userId}`,
        eventType: 'message_appended',
        payload: JSON.stringify({
          threadId: txInput.threadId,
          messageId: txInput.messageId,
          role: 'user',
          createdBy: txInput.userId,
          content: txInput.content,
          createdAt: now,
        }),
      });
      appendOutboxEvent({
        topic: `user:${txInput.userId}`,
        eventType: 'main_run_queued',
        payload: JSON.stringify({
          runId: txInput.runId,
          threadId: txInput.threadId,
          triggerMessageId: txInput.messageId,
          status: 'queued',
          createdAt: now,
        }),
      });

      const message: TalkMessageRecord = {
        id: txInput.messageId,
        talk_id: null,
        thread_id: txInput.threadId,
        role: 'user',
        content: txInput.content,
        created_by: txInput.userId,
        created_at: now,
        run_id: null,
        metadata_json: null,
        sequence_in_run: null,
      };

      const run: TalkRunRecord = {
        id: txInput.runId,
        talk_id: null,
        thread_id: txInput.threadId,
        requested_by: txInput.userId,
        status: 'queued',
        trigger_message_id: txInput.messageId,
        task_type: txInput.taskType ?? 'chat',
        selected_mode: txInput.selectedMode ?? null,
        transport: txInput.transport ?? null,
        browser_phase: null,
        blocked_reason: null,
        browser_session_id: null,
        timeout_phase: null,
        idempotency_key: null,
        executor_alias: null,
        executor_model: null,
        created_at: now,
        started_at: null,
        ended_at: null,
        cancel_reason: null,
        metadata_json: JSON.stringify({
          timing: {
            queueStartedAt: now,
            enqueuedAt: now,
          },
          lastHeartbeatAt: now,
        }),
      };

      return { message, run };
    },
  );

  return tx(input);
}

export class MainThreadBusyError extends Error {
  readonly threadId: string;
  constructor(threadId: string) {
    super(`Thread ${threadId} already has an active run`);
    this.name = 'MainThreadBusyError';
    this.threadId = threadId;
  }
}

/**
 * Claim queued Main channel runs (talk_id IS NULL, thread_id IS NOT NULL).
 */
export function claimQueuedMainRuns(
  limit: number,
  now?: string,
): TalkRunRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const tx = getDb().transaction(
    (txLimit: number, txNow?: string): TalkRunRecord[] => {
      const startedAt = txNow || new Date().toISOString();
      const queued = getDb()
        .prepare(
          `
          SELECT *
          FROM talk_runs
          WHERE status = 'queued' AND talk_id IS NULL AND thread_id IS NOT NULL
          ORDER BY created_at ASC
          LIMIT ?
        `,
        )
        .all(txLimit) as TalkRunRecord[];
      if (queued.length === 0) return [];

      const updateStmt = getDb().prepare(
        `
        UPDATE talk_runs
        SET status = 'running',
            started_at = ?,
            ended_at = NULL,
            cancel_reason = NULL
        WHERE id = ? AND status = 'queued'
      `,
      );

      const claimed: TalkRunRecord[] = [];
      for (const run of queued) {
        const result = updateStmt.run(startedAt, run.id);
        if (result.changes === 1) {
          updateTalkRunMetadata(run.id, (current) => {
            const timing =
              current.timing &&
              typeof current.timing === 'object' &&
              !Array.isArray(current.timing)
                ? { ...(current.timing as Record<string, unknown>) }
                : {};
            return {
              ...current,
              timing: {
                ...timing,
                claimedAt: startedAt,
              },
              lastHeartbeatAt: startedAt,
            };
          });
          appendOutboxEvent({
            topic: `user:${run.requested_by}`,
            eventType: 'main_run_started',
            payload: JSON.stringify({
              runId: run.id,
              threadId: run.thread_id,
              status: 'running',
              startedAt,
            }),
          });
          claimed.push({
            ...run,
            status: 'running' as TalkRunStatus,
            browser_phase:
              getTalkRunTaskType(run) === 'browser' ? 'starting' : null,
            blocked_reason: null,
            timeout_phase: null,
            started_at: startedAt,
          });
        }
      }
      return claimed;
    },
  );
  return tx(normalizedLimit, now);
}

/**
 * Atomically complete a Main run: update run status, persist assistant message,
 * record LLM attempt, and emit outbox events (message_appended + terminal).
 */
export function completeMainRunAtomic(input: {
  runId: string;
  threadId: string;
  requestedBy: string;
  responseMessageId: string;
  responseContent: string;
  agentId: string;
  providerId: string;
  modelId: string;
  latencyMs?: number;
  usage?: {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  };
}): { applied: boolean } {
  const tx = getDb().transaction(
    (txInput: typeof input): { applied: boolean } => {
      const now = new Date().toISOString();

      // 1. Complete the run
      const updated = getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'completed',
              browser_phase = NULL,
              blocked_reason = NULL,
              timeout_phase = NULL,
              ended_at = ?
          WHERE id = ? AND status = 'running'
        `,
        )
        .run(now, txInput.runId);
      if (updated.changes !== 1) {
        return { applied: false };
      }
      updateTalkRunMetadata(txInput.runId, (current) => {
        const timing =
          current.timing &&
          typeof current.timing === 'object' &&
          !Array.isArray(current.timing)
            ? { ...(current.timing as Record<string, unknown>) }
            : {};
        return {
          ...current,
          timing: {
            ...timing,
            completedAt: now,
          },
          lastHeartbeatAt: now,
          lastProgressMessage: null,
          currentStep: null,
          timeoutPhase: null,
          terminalSummary: null,
        };
      });

      // 2. Insert assistant message
      getDb()
        .prepare(
          `
          INSERT INTO talk_messages (
            id, talk_id, thread_id, role, content, agent_id,
            created_by, created_at, run_id, metadata_json
          ) VALUES (?, NULL, ?, 'assistant', ?, ?, NULL, ?, ?, ?)
        `,
        )
        .run(
          txInput.responseMessageId,
          txInput.threadId,
          txInput.responseContent,
          txInput.agentId,
          now,
          txInput.runId,
          JSON.stringify({
            runId: txInput.runId,
            providerId: txInput.providerId,
            modelId: txInput.modelId,
          }),
        );

      // 3. Insert LLM attempt
      getDb()
        .prepare(
          `
          INSERT INTO llm_attempts (
            run_id, talk_id, agent_id, provider_id, model_id,
            status, latency_ms, input_tokens, cached_input_tokens,
            output_tokens,
            estimated_cost_usd, created_at
          ) VALUES (?, NULL, ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          txInput.runId,
          txInput.agentId,
          txInput.providerId,
          txInput.modelId,
          txInput.latencyMs ?? null,
          txInput.usage?.inputTokens ?? null,
          txInput.usage?.cachedInputTokens ?? null,
          txInput.usage?.outputTokens ?? null,
          txInput.usage?.estimatedCostUsd ?? null,
          now,
        );

      appendOutboxEvent({
        topic: `user:${txInput.requestedBy}`,
        eventType: 'message_appended',
        payload: JSON.stringify({
          threadId: txInput.threadId,
          messageId: txInput.responseMessageId,
          runId: txInput.runId,
          role: 'assistant',
          agentId: txInput.agentId,
          content: txInput.responseContent,
          createdAt: now,
        }),
      });

      appendOutboxEvent({
        topic: `user:${txInput.requestedBy}`,
        eventType: 'main_response_completed',
        payload: JSON.stringify({
          type: 'main_response_completed',
          runId: txInput.runId,
          threadId: txInput.threadId,
          agentId: txInput.agentId,
          responseMessageId: txInput.responseMessageId,
        }),
      });
      appendOutboxEvent({
        topic: `user:${txInput.requestedBy}`,
        eventType: 'main_run_completed',
        payload: JSON.stringify({
          runId: txInput.runId,
          threadId: txInput.threadId,
          status: 'completed',
          responseMessageId: txInput.responseMessageId,
          endedAt: now,
        }),
      });

      queueNextDeferredMainRunIfIdle(txInput.threadId, now);

      return { applied: true };
    },
  );
  return tx(input);
}

/**
 * Atomically fail a Main run and emit terminal failure event.
 */
export function failMainRunAtomic(input: {
  runId: string;
  threadId: string;
  requestedBy: string;
  errorCode: string;
  errorMessage: string;
  timeoutPhase?: string | null;
}): { applied: boolean } {
  const tx = getDb().transaction(
    (txInput: typeof input): { applied: boolean } => {
      const now = new Date().toISOString();

      const updated = getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'failed',
              blocked_reason = NULL,
              timeout_phase = ?,
              ended_at = ?,
              cancel_reason = ?
          WHERE id = ? AND status = 'running'
        `,
        )
        .run(
          txInput.timeoutPhase ?? null,
          now,
          `${txInput.errorCode}: ${txInput.errorMessage}`,
          txInput.runId,
        );
      if (updated.changes !== 1) {
        return { applied: false };
      }
      updateTalkRunMetadata(txInput.runId, (current) => {
        const timing =
          current.timing &&
          typeof current.timing === 'object' &&
          !Array.isArray(current.timing)
            ? { ...(current.timing as Record<string, unknown>) }
            : {};
        return {
          ...current,
          timing: {
            ...timing,
            completedAt: now,
          },
          lastHeartbeatAt: now,
          currentStep: null,
          timeoutPhase: txInput.timeoutPhase ?? null,
          lastProgressMessage: null,
          terminalSummary: {
            statusLabel: 'Failed',
            body:
              txInput.errorMessage ||
              'The run failed before a response could be recorded.',
          },
        };
      });

      appendOutboxEvent({
        topic: `user:${txInput.requestedBy}`,
        eventType: 'main_response_failed',
        payload: JSON.stringify({
          type: 'main_response_failed',
          runId: txInput.runId,
          threadId: txInput.threadId,
          errorCode: txInput.errorCode,
          errorMessage: txInput.errorMessage,
        }),
      });
      appendOutboxEvent({
        topic: `user:${txInput.requestedBy}`,
        eventType: 'main_run_failed',
        payload: JSON.stringify({
          runId: txInput.runId,
          threadId: txInput.threadId,
          status: 'failed',
          errorCode: txInput.errorCode,
          errorMessage: txInput.errorMessage,
          endedAt: now,
        }),
      });

      queueNextDeferredMainRunIfIdle(txInput.threadId, now);

      return { applied: true };
    },
  );
  return tx(input);
}

/**
 * Fail interrupted Main runs on startup.
 * Separate from Talk recovery — only touches talk_id IS NULL rows.
 */
export function failInterruptedMainRunsOnStartup(now?: string): {
  failedRunIds: string[];
} {
  const tx = getDb().transaction(
    (inputNow?: string): { failedRunIds: string[] } => {
      const currentNow = inputNow || new Date().toISOString();
      const runningRuns = getDb()
        .prepare(
          `
          SELECT id, thread_id, requested_by
          FROM talk_runs
          WHERE status = 'running' AND talk_id IS NULL AND thread_id IS NOT NULL
          ORDER BY created_at ASC
        `,
        )
        .all() as Array<{
        id: string;
        thread_id: string;
        requested_by: string;
      }>;

      const failedRunIds: string[] = [];
      for (const run of runningRuns) {
        const updated = getDb()
          .prepare(
            `
            UPDATE talk_runs
            SET status = 'failed',
                ended_at = ?,
                cancel_reason = ?
            WHERE id = ? AND status = 'running'
          `,
          )
          .run(currentNow, 'interrupted_by_restart', run.id);
        if (updated.changes !== 1) continue;

        failedRunIds.push(run.id);
        appendOutboxEvent({
          topic: `user:${run.requested_by}`,
          eventType: 'main_response_failed',
          payload: JSON.stringify({
            type: 'main_response_failed',
            runId: run.id,
            threadId: run.thread_id,
            errorCode: 'interrupted_by_restart',
            errorMessage: 'Execution interrupted by server restart',
          }),
        });
        appendOutboxEvent({
          topic: `user:${run.requested_by}`,
          eventType: 'main_run_failed',
          payload: JSON.stringify({
            runId: run.id,
            threadId: run.thread_id,
            status: 'failed',
            errorCode: 'interrupted_by_restart',
            errorMessage: 'Execution interrupted by server restart',
            endedAt: currentNow,
          }),
        });

        queueNextDeferredMainRunIfIdle(run.thread_id, currentNow);
      }

      return { failedRunIds };
    },
  );
  return tx(now);
}
