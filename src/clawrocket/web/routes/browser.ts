import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../../../config.js';
import type { ApiEnvelope, AuthContext } from '../types.js';
import {
  getBrowserService,
  type BrowserOpenResult,
  type BrowserSessionStatusSnapshot,
} from '../../browser/service.js';
import {
  checkBrowserProfileConnectionUniqueness,
  deleteBrowserProfile,
  ensureBrowserProfile,
  getBrowserProfile,
  getBrowserProfileById,
  getBrowserProfileUsage,
  hasNonterminalBrowserSessions,
  listBrowserSessionsByProfile,
  listAllBrowserProfiles,
  markBrowserSessionDisconnected,
  updateBrowserProfileConnectionMode,
  type BrowserConnectionMode,
  type BrowserPersistedSessionState,
  type BrowserProfileSnapshot,
  type BrowserSessionSnapshot,
} from '../../db/browser-accessors.js';
import {
  canUserAccessMainThread,
  canUserAccessTalk,
  cancelBrowserBlockedRun,
  getBrowserBlockForRun,
  getPendingRunConfirmationById,
  getTalkRunById,
  rejectBrowserBlockedRun,
  resolveRunConfirmation,
  resumeBrowserBlockedRun,
} from '../../db/index.js';
import type {
  BrowserBlockMetadata,
  BrowserResumeMetadata,
} from '../../browser/metadata.js';

export interface ChromeUserDataDirectoryCandidate {
  id: string;
  label: string;
  path: string;
  preferred: boolean;
}

export interface ChromeUserDataDirectoryDiscovery {
  platform: string;
  defaultPathHint: string | null;
  candidates: ChromeUserDataDirectoryCandidate[];
}

export interface ChromeSubprofileCandidate {
  directoryName: string;
  displayName: string;
  email: string | null;
  fullName: string | null;
  kind: 'default' | 'profile' | 'guest' | 'system' | 'other';
  preferred: boolean;
  lastUsed: boolean;
  path: string;
}

export interface ChromeSubprofileDiscovery {
  userDataDir: string;
  localStateFound: boolean;
  candidates: ChromeSubprofileCandidate[];
}

export interface BrowserProfileSummary extends BrowserProfileSnapshot {
  inUseSessionCount: number;
  currentSessionState: BrowserPersistedSessionState | null;
}

type ChromeUserDataDirectoryDiscoveryInput = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  isDirectory?: ((targetPath: string) => boolean) | undefined;
};

type ChromeSubprofileDiscoveryInput = {
  userDataDir: string;
  isDirectory?: ((targetPath: string) => boolean) | undefined;
  pathExists?: ((targetPath: string) => boolean) | undefined;
  readDirNames?: ((targetPath: string) => string[]) | undefined;
  readFile?: ((targetPath: string) => string) | undefined;
};

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function readDirNames(targetPath: string): string[] {
  return fs.readdirSync(targetPath);
}

function readFile(targetPath: string): string {
  return fs.readFileSync(targetPath, 'utf8');
}

function isDescendantPath(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(
    path.resolve(rootPath),
    path.resolve(targetPath),
  );
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function deleteOwnedBrowserProfileArtifacts(
  profile: BrowserProfileSnapshot,
): void {
  const ownedRoots = [
    path.join(DATA_DIR, 'browser-profiles'),
    path.join(DATA_DIR, 'browser-downloads'),
  ];

  for (const artifactPath of [profile.profilePath, profile.downloadDir]) {
    if (!artifactPath) {
      continue;
    }
    if (!ownedRoots.some((root) => isDescendantPath(root, artifactPath))) {
      continue;
    }
    try {
      fs.rmSync(artifactPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function inferChromeSubprofileKind(
  directoryName: string,
): ChromeSubprofileCandidate['kind'] {
  if (/^Default$/i.test(directoryName)) {
    return 'default';
  }
  if (/^Profile \d+$/i.test(directoryName)) {
    return 'profile';
  }
  if (/^Guest Profile$/i.test(directoryName)) {
    return 'guest';
  }
  if (/^System Profile$/i.test(directoryName)) {
    return 'system';
  }
  return 'other';
}

function isSafeChromeProfileDirectoryName(directoryName: string): boolean {
  const trimmed = directoryName.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === '.' || trimmed === '..') {
    return false;
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return false;
  }
  return !path.isAbsolute(trimmed);
}

function compareChromeSubprofiles(
  left: ChromeSubprofileCandidate,
  right: ChromeSubprofileCandidate,
): number {
  if (left.preferred !== right.preferred) {
    return left.preferred ? -1 : 1;
  }
  if (left.lastUsed !== right.lastUsed) {
    return left.lastUsed ? -1 : 1;
  }

  const rank = (candidate: ChromeSubprofileCandidate): number => {
    switch (candidate.kind) {
      case 'default':
        return 0;
      case 'profile':
        return 1;
      case 'other':
        return 2;
      case 'guest':
        return 3;
      case 'system':
        return 4;
      default:
        return 5;
    }
  };

  const rankDiff = rank(left) - rank(right);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  return left.directoryName.localeCompare(right.directoryName, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function buildDiscoveryCandidates(input: {
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): {
  defaultPathHint: string | null;
  candidates: ChromeUserDataDirectoryCandidate[];
} {
  switch (input.platform) {
    case 'darwin': {
      const libraryDir = path.join(
        input.homeDir,
        'Library',
        'Application Support',
      );
      return {
        defaultPathHint: path.join(libraryDir, 'Google', 'Chrome'),
        candidates: [
          {
            id: 'google-chrome',
            label: 'Google Chrome',
            path: path.join(libraryDir, 'Google', 'Chrome'),
            preferred: true,
          },
          {
            id: 'google-chrome-beta',
            label: 'Google Chrome Beta',
            path: path.join(libraryDir, 'Google', 'Chrome Beta'),
            preferred: false,
          },
          {
            id: 'google-chrome-dev',
            label: 'Google Chrome Dev',
            path: path.join(libraryDir, 'Google', 'Chrome Dev'),
            preferred: false,
          },
          {
            id: 'google-chrome-canary',
            label: 'Google Chrome Canary',
            path: path.join(libraryDir, 'Google', 'Chrome Canary'),
            preferred: false,
          },
          {
            id: 'chromium',
            label: 'Chromium',
            path: path.join(libraryDir, 'Chromium'),
            preferred: false,
          },
        ],
      };
    }
    case 'win32': {
      const localAppData =
        input.env.LOCALAPPDATA?.trim() ||
        path.join(input.homeDir, 'AppData', 'Local');
      return {
        defaultPathHint: path.join(
          localAppData,
          'Google',
          'Chrome',
          'User Data',
        ),
        candidates: [
          {
            id: 'google-chrome',
            label: 'Google Chrome',
            path: path.join(localAppData, 'Google', 'Chrome', 'User Data'),
            preferred: true,
          },
          {
            id: 'google-chrome-beta',
            label: 'Google Chrome Beta',
            path: path.join(localAppData, 'Google', 'Chrome Beta', 'User Data'),
            preferred: false,
          },
          {
            id: 'google-chrome-canary',
            label: 'Google Chrome Canary',
            path: path.join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
            preferred: false,
          },
          {
            id: 'chromium',
            label: 'Chromium',
            path: path.join(localAppData, 'Chromium', 'User Data'),
            preferred: false,
          },
        ],
      };
    }
    default: {
      const configDir = path.join(input.homeDir, '.config');
      return {
        defaultPathHint: path.join(configDir, 'google-chrome'),
        candidates: [
          {
            id: 'google-chrome',
            label: 'Google Chrome',
            path: path.join(configDir, 'google-chrome'),
            preferred: true,
          },
          {
            id: 'google-chrome-beta',
            label: 'Google Chrome Beta',
            path: path.join(configDir, 'google-chrome-beta'),
            preferred: false,
          },
          {
            id: 'google-chrome-dev',
            label: 'Google Chrome Dev',
            path: path.join(configDir, 'google-chrome-unstable'),
            preferred: false,
          },
          {
            id: 'chromium',
            label: 'Chromium',
            path: path.join(configDir, 'chromium'),
            preferred: false,
          },
        ],
      };
    }
  }
}

export function discoverChromeUserDataDirectories(
  input: ChromeUserDataDirectoryDiscoveryInput = {},
): ChromeUserDataDirectoryDiscovery {
  const platform = input.platform ?? process.platform;
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;
  const checkDirectory = input.isDirectory ?? isDirectory;
  const { defaultPathHint, candidates } = buildDiscoveryCandidates({
    platform,
    homeDir,
    env,
  });

  const seenPaths = new Set<string>();
  const detected = candidates.filter((candidate) => {
    if (!candidate.path || seenPaths.has(candidate.path)) {
      return false;
    }
    seenPaths.add(candidate.path);
    return checkDirectory(candidate.path);
  });

  return {
    platform,
    defaultPathHint,
    candidates: detected,
  };
}

export function discoverChromeSubprofiles(
  input: ChromeSubprofileDiscoveryInput,
): ChromeSubprofileDiscovery {
  const userDataDir = input.userDataDir.trim();
  const checkDirectory = input.isDirectory ?? isDirectory;
  const exists = input.pathExists ?? pathExists;
  const listDirNames = input.readDirNames ?? readDirNames;
  const readTextFile = input.readFile ?? readFile;

  let localStateFound = false;
  let preferredDirectoryName: string | null = null;
  let infoCache: Record<string, Record<string, unknown>> = {};

  try {
    const localStatePath = path.join(userDataDir, 'Local State');
    const parsed = JSON.parse(readTextFile(localStatePath)) as Record<
      string,
      unknown
    >;
    const profileSection =
      parsed.profile && typeof parsed.profile === 'object'
        ? (parsed.profile as Record<string, unknown>)
        : null;
    if (profileSection) {
      localStateFound = true;
      preferredDirectoryName =
        stringOrNull(profileSection.last_used) ||
        (Array.isArray(profileSection.last_active_profiles)
          ? profileSection.last_active_profiles.find(
              (value): value is string =>
                typeof value === 'string' && value.trim().length > 0,
            ) || null
          : null);
      if (
        profileSection.info_cache &&
        typeof profileSection.info_cache === 'object' &&
        !Array.isArray(profileSection.info_cache)
      ) {
        infoCache = Object.fromEntries(
          Object.entries(profileSection.info_cache as Record<string, unknown>)
            .filter(
              ([, value]) =>
                value && typeof value === 'object' && !Array.isArray(value),
            )
            .map(([key, value]) => [key, value as Record<string, unknown>]),
        );
      }
    }
  } catch {
    // ignored
  }

  const candidateNames = new Set<string>(Object.keys(infoCache));
  try {
    for (const entryName of listDirNames(userDataDir)) {
      candidateNames.add(entryName);
    }
  } catch {
    // ignored
  }

  const candidates: ChromeSubprofileCandidate[] = [];
  for (const directoryName of candidateNames) {
    if (!isSafeChromeProfileDirectoryName(directoryName)) {
      continue;
    }

    const fullPath = path.join(userDataDir, directoryName);
    if (!checkDirectory(fullPath)) {
      continue;
    }

    const hasPreferences = exists(path.join(fullPath, 'Preferences'));
    const hasLocalStateInfo = Object.prototype.hasOwnProperty.call(
      infoCache,
      directoryName,
    );
    const kind = inferChromeSubprofileKind(directoryName);
    if (kind === 'guest' || kind === 'system') {
      continue;
    }
    if (!hasPreferences && !hasLocalStateInfo && kind === 'other') {
      continue;
    }

    const profileInfo = infoCache[directoryName] ?? {};
    const fullName = stringOrNull(profileInfo.gaia_name);
    const email = stringOrNull(profileInfo.user_name);
    const configuredName = stringOrNull(profileInfo.name);
    const usesDefaultName = profileInfo.is_using_default_name === true;
    const displayName =
      (usesDefaultName && fullName) ||
      configuredName ||
      fullName ||
      directoryName;
    const lastUsed = preferredDirectoryName === directoryName;

    candidates.push({
      directoryName,
      displayName,
      email,
      fullName,
      kind,
      preferred: lastUsed,
      lastUsed,
      path: fullPath,
    });
  }

  candidates.sort(compareChromeSubprofiles);
  if (!candidates.some((candidate) => candidate.preferred)) {
    const fallback =
      candidates.find(
        (candidate) =>
          candidate.kind === 'default' || candidate.kind === 'profile',
      ) || candidates[0];
    if (fallback) {
      fallback.preferred = true;
    }
  }

  return {
    userDataDir,
    localStateFound,
    candidates,
  };
}

function parseObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function canAccessRun(auth: AuthContext, runId: string): boolean {
  const run = getTalkRunById(runId);
  if (!run) return false;
  if (run.talk_id) {
    return canUserAccessTalk(run.talk_id, auth.userId);
  }
  return canUserAccessMainThread(run.thread_id, auth.userId);
}

async function canAccessSession(
  auth: AuthContext,
  sessionId: string,
): Promise<boolean> {
  const service = getBrowserService();
  const snapshot = await service.getSessionStatus(sessionId);
  if (!snapshot) {
    return false;
  }

  const touchedRunIds = service.getSessionTouchedRunIds(sessionId);
  if (touchedRunIds.length === 0) {
    // Single-user self-hosted default: setup/takeover sessions can exist before
    // they are attached to a run.
    return true;
  }

  return touchedRunIds.some((runId) => canAccessRun(auth, runId));
}

async function maybeResumeTakeover(
  sessionId: string | null | undefined,
): Promise<void> {
  if (!sessionId) return;
  const service = getBrowserService();
  const snapshot = await service.getSessionStatus(sessionId);
  if (snapshot?.state === 'takeover') {
    await service.resumeTakeover({ sessionId, userId: null });
  }
}

export async function startBrowserSetupSessionRoute(input: {
  auth: AuthContext;
  siteKey?: unknown;
  accountLabel?: unknown;
  url?: unknown;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<BrowserOpenResult>;
}> {
  if (typeof input.siteKey !== 'string' || !input.siteKey.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_site_key',
          message: 'siteKey is required.',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: await getBrowserService().openSetupSession({
        siteKey: input.siteKey.trim(),
        accountLabel:
          typeof input.accountLabel === 'string'
            ? input.accountLabel.trim() || null
            : null,
        url: typeof input.url === 'string' ? input.url.trim() || null : null,
        userId: input.auth.userId,
      }),
    },
  };
}

export async function startBrowserTakeoverRoute(input: {
  auth: AuthContext;
  sessionId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<BrowserSessionStatusSnapshot>;
}> {
  if (!(await canAccessSession(input.auth, input.sessionId))) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: 'Browser session not found.',
        },
      },
    };
  }

  try {
    const snapshot = await getBrowserService().startTakeover({
      sessionId: input.sessionId,
      userId: input.auth.userId,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: snapshot,
      },
    };
  } catch (error) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

export async function getBrowserSessionStatusRoute(input: {
  auth: AuthContext;
  sessionId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<BrowserSessionStatusSnapshot>;
}> {
  if (!(await canAccessSession(input.auth, input.sessionId))) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: 'Browser session not found.',
        },
      },
    };
  }

  const snapshot = await getBrowserService().getSessionStatus(input.sessionId);
  if (!snapshot) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: 'Browser session not found.',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: snapshot,
    },
  };
}

export async function resumeBrowserSessionRoute(input: {
  auth: AuthContext;
  sessionId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<BrowserSessionStatusSnapshot>;
}> {
  if (!(await canAccessSession(input.auth, input.sessionId))) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: 'Browser session not found.',
        },
      },
    };
  }

  try {
    const snapshot = await getBrowserService().resumeTakeover({
      sessionId: input.sessionId,
      userId: input.auth.userId,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: snapshot,
      },
    };
  } catch (error) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

export async function resumeBrowserBlockedRunRoute(input: {
  auth: AuthContext;
  runId: string;
  note?: string | null;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<Record<string, unknown>>;
  wakeMain: boolean;
  wakeTalk: boolean;
}> {
  const run = getTalkRunById(input.runId);
  if (
    !run ||
    run.status !== 'awaiting_confirmation' ||
    !canAccessRun(input.auth, input.runId)
  ) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'blocked_run_not_found',
          message: 'Blocked run not found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserBlock = getBrowserBlockForRun(input.runId);
  if (!browserBlock) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'browser_block_missing',
          message: 'Run has no browser block metadata.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  if (browserBlock.kind === 'confirmation_required') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'confirmation_required',
          message:
            'This blocked run requires explicit approval or rejection, not a generic resume.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  await maybeResumeTakeover(browserBlock.sessionId);
  const browserResume: BrowserResumeMetadata = {
    kind:
      browserBlock.kind === 'auth_required'
        ? 'auth_completed'
        : 'human_step_completed',
    resumedAt: new Date().toISOString(),
    resumedBy: input.auth.userId,
    sessionId: browserBlock.sessionId,
    confirmationId: browserBlock.confirmationId,
    note: input.note ?? null,
    pendingToolCall: browserBlock.pendingToolCall,
  };
  const resumed = resumeBrowserBlockedRun({
    runId: input.runId,
    resumedBy: input.auth.userId,
    browserResume,
  });
  if (!resumed.applied) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'browser_resume_failed',
          message: 'The blocked run could not be resumed.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        runId: input.runId,
        resumed: true,
        browserResume,
        queueState: resumed.queueState,
      },
    },
    wakeMain: resumed.run?.talk_id == null,
    wakeTalk: resumed.run?.talk_id != null,
  };
}

export async function approveBrowserConfirmationRoute(input: {
  auth: AuthContext;
  confirmationId: string;
  note?: string | null;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<Record<string, unknown>>;
  wakeMain: boolean;
  wakeTalk: boolean;
}> {
  const confirmation = getPendingRunConfirmationById(input.confirmationId);
  if (!confirmation || !canAccessRun(input.auth, confirmation.run_id)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'confirmation_not_found',
          message: 'Pending browser confirmation not found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserBlock = getBrowserBlockForRun(confirmation.run_id);
  if (!browserBlock) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'browser_block_missing',
          message: 'Run has no browser block metadata.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const resolved = resolveRunConfirmation({
    confirmationId: input.confirmationId,
    status: 'approved',
    resolvedBy: input.auth.userId,
  });
  if (!resolved) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'confirmation_already_resolved',
          message: 'This confirmation has already been resolved.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  await maybeResumeTakeover(browserBlock.sessionId);
  const browserResume: BrowserResumeMetadata = {
    kind: 'confirmation_approved',
    resumedAt: new Date().toISOString(),
    resumedBy: input.auth.userId,
    sessionId: browserBlock.sessionId,
    confirmationId: input.confirmationId,
    note: input.note ?? null,
    pendingToolCall: browserBlock.pendingToolCall,
  };
  const resumed = resumeBrowserBlockedRun({
    runId: confirmation.run_id,
    resumedBy: input.auth.userId,
    browserResume,
  });
  if (!resumed.applied) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'browser_resume_failed',
          message: 'The blocked run could not be resumed.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        confirmationId: input.confirmationId,
        runId: confirmation.run_id,
        approved: true,
        browserResume,
        queueState: resumed.queueState,
      },
    },
    wakeMain: resumed.run?.talk_id == null,
    wakeTalk: resumed.run?.talk_id != null,
  };
}

export async function cancelConflictingBrowserRunRoute(input: {
  auth: AuthContext;
  runId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<Record<string, unknown>>;
  wakeMain: boolean;
  wakeTalk: boolean;
}> {
  const run = getTalkRunById(input.runId);
  if (
    !run ||
    run.status !== 'awaiting_confirmation' ||
    !canAccessRun(input.auth, input.runId)
  ) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'blocked_run_not_found',
          message: 'Blocked run not found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserBlock = getBrowserBlockForRun(input.runId);
  if (
    !browserBlock ||
    browserBlock.kind !== 'session_conflict' ||
    !browserBlock.conflictingRunId
  ) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'session_conflict_missing',
          message: 'Run is not blocked by a conflicting browser session.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  if (!canAccessRun(input.auth, browserBlock.conflictingRunId)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'conflicting_run_not_found',
          message: 'The conflicting blocked run could not be found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const cancelled = cancelBrowserBlockedRun({
    runId: browserBlock.conflictingRunId,
    cancelledBy: input.auth.userId,
    cancelReason: 'browser_session_conflict_cancelled',
  });
  if (!cancelled.applied) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'conflicting_run_cancel_failed',
          message: 'The conflicting browser task could not be cancelled.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const updatedRun = getTalkRunById(input.runId);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        runId: input.runId,
        conflictingRunId: browserBlock.conflictingRunId,
        queuedCurrentRun: updatedRun?.status === 'queued',
        currentRunStatus: updatedRun?.status ?? null,
      },
    },
    wakeMain: cancelled.run?.talk_id == null,
    wakeTalk: cancelled.run?.talk_id != null,
  };
}

export async function rejectBrowserConfirmationRoute(input: {
  auth: AuthContext;
  confirmationId: string;
  note?: string | null;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<Record<string, unknown>>;
  wakeMain: boolean;
  wakeTalk: boolean;
}> {
  const confirmation = getPendingRunConfirmationById(input.confirmationId);
  if (!confirmation || !canAccessRun(input.auth, confirmation.run_id)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'confirmation_not_found',
          message: 'Pending browser confirmation not found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserBlock = getBrowserBlockForRun(confirmation.run_id);
  const resolved = resolveRunConfirmation({
    confirmationId: input.confirmationId,
    status: 'rejected',
    resolvedBy: input.auth.userId,
  });
  if (!resolved) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'confirmation_already_resolved',
          message: 'This confirmation has already been resolved.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserResume: BrowserResumeMetadata = {
    kind: 'confirmation_rejected',
    resumedAt: new Date().toISOString(),
    resumedBy: input.auth.userId,
    sessionId: browserBlock?.sessionId ?? null,
    confirmationId: input.confirmationId,
    note: input.note ?? null,
    pendingToolCall: browserBlock?.pendingToolCall ?? null,
  };
  const rejected = rejectBrowserBlockedRun({
    runId: confirmation.run_id,
    rejectedBy: input.auth.userId,
    browserResume,
  });
  if (!rejected.applied) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'browser_reject_failed',
          message: 'The blocked run could not be rejected.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        confirmationId: input.confirmationId,
        runId: confirmation.run_id,
        rejected: true,
      },
    },
    wakeMain: false,
    wakeTalk: false,
  };
}

// ---------------------------------------------------------------------------
// Browser profile CRUD routes
// ---------------------------------------------------------------------------

const VALID_CONNECTION_MODES: BrowserConnectionMode[] = [
  'managed',
  'chrome_profile',
  'cdp',
];

function isValidConnectionMode(mode: unknown): mode is BrowserConnectionMode {
  return (
    typeof mode === 'string' &&
    VALID_CONNECTION_MODES.includes(mode as BrowserConnectionMode)
  );
}

function describeConnectionMode(mode: BrowserConnectionMode): string {
  switch (mode) {
    case 'managed':
      return 'Managed';
    case 'chrome_profile':
      return 'Chrome Profile';
    case 'cdp':
      return 'CDP';
  }
}

function buildProfileExistsMessage(profile: BrowserProfileSnapshot): string {
  const label = profile.accountLabel
    ? `${profile.siteKey} (${profile.accountLabel})`
    : profile.siteKey;
  const modeLabel = describeConnectionMode(profile.connectionMode);
  if (profile.accountLabel) {
    return `A browser profile for ${label} already exists and is using ${modeLabel}. Use Edit to change it.`;
  }
  return `A browser profile for ${label} already exists and is using ${modeLabel}. Use Edit to change it, or add an account label to create another profile for the same site.`;
}

function isNonterminalProfileSession(session: BrowserSessionSnapshot): boolean {
  return (
    session.state === 'active' ||
    session.state === 'blocked' ||
    session.state === 'takeover'
  );
}

function summarizeBrowserProfile(
  profile: BrowserProfileSnapshot,
): BrowserProfileSummary {
  return {
    ...profile,
    ...getBrowserProfileUsage(profile.id),
  };
}

function validateConnectionConfig(
  mode: BrowserConnectionMode,
  config: unknown,
): { valid: boolean; error?: string; configJson: string | null } {
  if (mode === 'managed') {
    return { valid: true, configJson: null };
  }

  if (!config || typeof config !== 'object') {
    return {
      valid: false,
      error: `connectionConfig is required for mode '${mode}'.`,
      configJson: null,
    };
  }

  const configObj = config as Record<string, unknown>;

  if (mode === 'chrome_profile') {
    if (
      typeof configObj.chromeProfilePath !== 'string' ||
      !configObj.chromeProfilePath.trim()
    ) {
      return {
        valid: false,
        error:
          'chromeProfilePath is required for chrome_profile mode. Provide the Chrome user data directory (e.g. /home/user/.config/google-chrome), not a profile subdirectory like Default/.',
        configJson: null,
      };
    }
    const chromeProfilePath = configObj.chromeProfilePath.trim();
    if (!path.isAbsolute(chromeProfilePath)) {
      return {
        valid: false,
        error:
          'chromeProfilePath must be an absolute path to the Chrome user data directory.',
        configJson: null,
      };
    }
    if (!isDirectory(chromeProfilePath)) {
      return {
        valid: false,
        error: `chromeProfilePath was not found: ${chromeProfilePath}`,
        configJson: null,
      };
    }
    // Warn if user appears to have provided a profile subdirectory instead of user data dir
    const basename = path.basename(chromeProfilePath);
    if (
      /^(Default|Profile \d+|Guest Profile|System Profile)$/i.test(basename)
    ) {
      return {
        valid: false,
        error: `chromeProfilePath should be the Chrome user data directory, not the profile subdirectory. Use "${path.dirname(chromeProfilePath)}" instead of "${chromeProfilePath}".`,
        configJson: null,
      };
    }

    const profileDirectory =
      typeof configObj.profileDirectory === 'string' &&
      configObj.profileDirectory.trim()
        ? configObj.profileDirectory.trim()
        : null;
    if (profileDirectory) {
      if (!isSafeChromeProfileDirectoryName(profileDirectory)) {
        return {
          valid: false,
          error:
            'profileDirectory must be a Chrome subprofile folder name like Default or Profile 4, not a full path.',
          configJson: null,
        };
      }

      const selectedProfilePath = path.join(
        chromeProfilePath,
        profileDirectory,
      );
      if (!isDirectory(selectedProfilePath)) {
        return {
          valid: false,
          error: `profileDirectory "${profileDirectory}" was not found inside "${chromeProfilePath}".`,
          configJson: null,
        };
      }
    }

    return {
      valid: true,
      configJson: JSON.stringify({
        chromeProfilePath,
        ...(profileDirectory ? { profileDirectory } : {}),
      }),
    };
  }

  if (mode === 'cdp') {
    if (
      typeof configObj.endpointUrl !== 'string' ||
      !configObj.endpointUrl.trim()
    ) {
      return {
        valid: false,
        error: 'endpointUrl is required for cdp mode.',
        configJson: null,
      };
    }
    const endpointUrl = configObj.endpointUrl.trim();
    try {
      new URL(endpointUrl);
    } catch {
      return {
        valid: false,
        error: 'endpointUrl must be a valid URL.',
        configJson: null,
      };
    }
    return {
      valid: true,
      configJson: JSON.stringify({ endpointUrl }),
    };
  }

  return { valid: false, error: `Unknown mode '${mode}'.`, configJson: null };
}

export function listBrowserProfilesRoute(input: { auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ profiles: BrowserProfileSummary[] }>;
} {
  const profiles = listAllBrowserProfiles().map(summarizeBrowserProfile);
  return {
    statusCode: 200,
    body: { ok: true, data: { profiles } },
  };
}

export function discoverChromeUserDataDirectoriesRoute(input: {
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<ChromeUserDataDirectoryDiscovery>;
} {
  if (input.auth.role !== 'owner') {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Owner role required.' },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: discoverChromeUserDataDirectories(),
    },
  };
}

export function discoverChromeSubprofilesRoute(input: {
  auth: AuthContext;
  userDataDir?: unknown;
}): {
  statusCode: number;
  body: ApiEnvelope<ChromeSubprofileDiscovery>;
} {
  if (input.auth.role !== 'owner') {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Owner role required.' },
      },
    };
  }

  if (typeof input.userDataDir !== 'string' || !input.userDataDir.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_user_data_dir',
          message: 'userDataDir is required.',
        },
      },
    };
  }

  const userDataDir = input.userDataDir.trim();
  if (!path.isAbsolute(userDataDir)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_user_data_dir',
          message: 'userDataDir must be an absolute path.',
        },
      },
    };
  }

  if (!isDirectory(userDataDir)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'user_data_dir_not_found',
          message: `Chrome user data directory not found: ${userDataDir}`,
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: discoverChromeSubprofiles({ userDataDir }),
    },
  };
}

export function createBrowserProfileRoute(input: {
  auth: AuthContext;
  siteKey?: unknown;
  accountLabel?: unknown;
  connectionMode?: unknown;
  connectionConfig?: unknown;
}): {
  statusCode: number;
  body: ApiEnvelope<{ profile: BrowserProfileSnapshot; created: boolean }>;
} {
  if (input.auth.role !== 'owner') {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Owner role required.' },
      },
    };
  }

  if (typeof input.siteKey !== 'string' || !input.siteKey.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: { code: 'invalid_site_key', message: 'siteKey is required.' },
      },
    };
  }

  const siteKey = input.siteKey.trim();
  const accountLabel =
    typeof input.accountLabel === 'string'
      ? input.accountLabel.trim() || null
      : null;
  const existing = getBrowserProfile(siteKey, accountLabel);
  if (existing) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'profile_exists',
          message: buildProfileExistsMessage(existing),
        },
      },
    };
  }

  // Validate connection config BEFORE creating the profile row to avoid
  // leaving behind a managed profile when validation fails.
  const mode = isValidConnectionMode(input.connectionMode)
    ? input.connectionMode
    : null;
  let validatedConfigJson: string | null = null;
  if (mode && mode !== 'managed') {
    const validation = validateConnectionConfig(mode, input.connectionConfig);
    if (!validation.valid) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_connection_config',
            message: validation.error!,
          },
        },
      };
    }
    validatedConfigJson = validation.configJson;

    // Pre-flight uniqueness check (excludeProfileId=null since profile may not exist yet)
    const uniqueness = checkBrowserProfileConnectionUniqueness({
      mode,
      configJson: validatedConfigJson,
      excludeProfileId: null,
    });
    if (uniqueness.conflict) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'connection_config_conflict',
            message: `Another profile (${uniqueness.conflictSiteKey}) already uses this ${mode === 'chrome_profile' ? 'Chrome profile selection' : 'CDP endpoint'}.`,
          },
        },
      };
    }
  }

  const { profile, created } = ensureBrowserProfile({
    siteKey,
    accountLabel,
  });

  if (!created) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'profile_exists',
          message: buildProfileExistsMessage(profile),
        },
      },
    };
  }

  // Apply connection mode if specified
  if (mode && mode !== 'managed') {
    // Block mode change on existing profiles with active sessions
    if (!created && hasNonterminalBrowserSessions(profile.id)) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'active_session_exists',
            message:
              'Cannot change connection mode while active, blocked, or takeover sessions exist for this profile.',
          },
        },
      };
    }

    const updated = updateBrowserProfileConnectionMode(
      profile.id,
      mode,
      validatedConfigJson,
    );
    if (updated) {
      return {
        statusCode: 200,
        body: { ok: true, data: { profile: updated, created } },
      };
    }
  }

  return { statusCode: 200, body: { ok: true, data: { profile, created } } };
}

export function updateBrowserProfileConnectionModeRoute(input: {
  auth: AuthContext;
  profileId: string;
  connectionMode?: unknown;
  connectionConfig?: unknown;
}): {
  statusCode: number;
  body: ApiEnvelope<{ profile: BrowserProfileSnapshot }>;
} {
  if (input.auth.role !== 'owner') {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Owner role required.' },
      },
    };
  }

  const existing = getBrowserProfileById(input.profileId);
  if (!existing) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'profile_not_found',
          message: 'Browser profile not found.',
        },
      },
    };
  }

  if (!isValidConnectionMode(input.connectionMode)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_connection_mode',
          message: `connectionMode must be one of: ${VALID_CONNECTION_MODES.join(', ')}.`,
        },
      },
    };
  }

  const mode = input.connectionMode;
  const validation = validateConnectionConfig(mode, input.connectionConfig);
  if (!validation.valid) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_connection_config',
          message: validation.error!,
        },
      },
    };
  }

  // Block mode change if any nonterminal session exists
  if (hasNonterminalBrowserSessions(input.profileId)) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'active_session_exists',
          message:
            'Cannot change connection mode while active, blocked, or takeover sessions exist for this profile.',
        },
      },
    };
  }

  // Uniqueness check
  const uniqueness = checkBrowserProfileConnectionUniqueness({
    mode,
    configJson: validation.configJson,
    excludeProfileId: input.profileId,
  });
  if (uniqueness.conflict) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'connection_config_conflict',
          message: `Another profile (${uniqueness.conflictSiteKey}) already uses this ${mode === 'chrome_profile' ? 'Chrome profile selection' : 'CDP endpoint'}.`,
        },
      },
    };
  }

  const updated = updateBrowserProfileConnectionMode(
    input.profileId,
    mode,
    validation.configJson,
  );
  if (!updated) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: { code: 'update_failed', message: 'Failed to update profile.' },
      },
    };
  }

  return { statusCode: 200, body: { ok: true, data: { profile: updated } } };
}

export function deleteBrowserProfileRoute(input: {
  auth: AuthContext;
  profileId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ profileId: string }>;
} {
  if (input.auth.role !== 'owner') {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Owner role required.' },
      },
    };
  }

  const profile = getBrowserProfileById(input.profileId);
  if (!profile) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'profile_not_found',
          message: 'Browser profile not found.',
        },
      },
    };
  }

  if (hasNonterminalBrowserSessions(input.profileId)) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'active_session_exists',
          message:
            'Cannot delete a browser profile while active, blocked, or takeover sessions exist for it.',
        },
      },
    };
  }

  const deleted = deleteBrowserProfile(input.profileId);
  if (!deleted) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: { code: 'delete_failed', message: 'Failed to delete profile.' },
      },
    };
  }

  deleteOwnedBrowserProfileArtifacts(profile);

  return {
    statusCode: 200,
    body: { ok: true, data: { profileId: input.profileId } },
  };
}

export async function releaseBrowserProfileSessionsRoute(input: {
  auth: AuthContext;
  profileId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    releasedCount: number;
    liveReleasedCount: number;
    staleReleasedCount: number;
  }>;
}> {
  if (input.auth.role !== 'owner') {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Owner role required.' },
      },
    };
  }

  const profile = getBrowserProfileById(input.profileId);
  if (!profile) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'profile_not_found',
          message: 'Browser profile not found.',
        },
      },
    };
  }

  const sessions = listBrowserSessionsByProfile({
    profileId: input.profileId,
  }).filter(isNonterminalProfileSession);
  if (sessions.length === 0) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          releasedCount: 0,
          liveReleasedCount: 0,
          staleReleasedCount: 0,
        },
      },
    };
  }

  const service = getBrowserService();
  let liveReleasedCount = 0;
  let staleReleasedCount = 0;
  for (const session of sessions) {
    const liveSnapshot = await service.getSessionStatus(session.id);
    if (liveSnapshot) {
      await service.close({
        sessionId: session.id,
        userId: input.auth.userId,
      });
      liveReleasedCount += 1;
      continue;
    }
    markBrowserSessionDisconnected(session.id);
    staleReleasedCount += 1;
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        releasedCount: liveReleasedCount + staleReleasedCount,
        liveReleasedCount,
        staleReleasedCount,
      },
    },
  };
}
