import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import {
  buildBrowserProfileKey,
  ensureBrowserProfile,
  getBrowserSessionById,
  getBrowserProfileById,
  reconcileBrowserSessionsOnStartup,
  touchBrowserProfileLastUsed,
  upsertBrowserSessionState,
  type BrowserConnectionMode,
  type BrowserProfileSnapshot,
} from '../db/browser-accessors.js';

const REF_ATTRIBUTE = 'data-nanoclaw-ref';
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const DEFAULT_ACTION_TIMEOUT_MS = 15000;
const HUMAN_ONLY_CHECKPOINT_REGEX =
  /\b(captcha|not a robot|verify you are human|security check|complete the challenge|press and hold)\b/i;
const INTERACTIVE_AUTH_CHECKPOINT_REGEX =
  /\b(sign in|log in|login|verify your identity|approve sign[- ]?in|check your phone|check your device|open (the )?(linkedin )?app|authentication app|verification code|enter the code|two-step verification|2-step verification|two factor authentication|two-factor authentication|2fa|confirm (that )?it'?s you|use your passkey)\b/i;
const LINKEDIN_PHONE_APPROVAL_REGEX =
  /\b(check your phone|approve sign[- ]?in|approve the sign in|open (the )?linkedin app|linkedin app|approve on your phone|approve from your phone|approve from another device|check your device)\b/i;
const LINKEDIN_CODE_REGEX =
  /\b(verification code|security code|enter the code|enter code|use the code|we sent .*code|6-digit code|six-digit code)\b/i;
const LINKEDIN_DEVICE_TRUST_REGEX =
  /\b(verify your identity|confirm (that )?it'?s you|trust this device|remember this device|device verification|new device|approve this sign in)\b/i;

export type BrowserResultStatus =
  | 'ok'
  | 'needs_auth'
  | 'human_step_required'
  | 'awaiting_confirmation'
  | 'error';

export type BrowserBlockedKind =
  | 'auth_required'
  | 'confirmation_required'
  | 'human_step_required'
  | 'session_conflict';

export type BrowserSessionState =
  | 'active'
  | 'blocked'
  | 'takeover'
  | 'disconnected'
  | 'closed'
  | 'dead';

export type BrowserSessionOwner = 'agent' | 'user';

export interface BrowserSessionSnapshot {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  headed: boolean;
}

export interface BrowserSessionStatusSnapshot extends BrowserSessionSnapshot {
  state: BrowserSessionState;
  owner: BrowserSessionOwner;
  blockedKind: BrowserBlockedKind | null;
  blockedMessage: string | null;
  currentUrl: string;
  currentTitle: string;
  lastUpdatedAt: string;
}

export interface BrowserRunCarriedSession {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  lastKnownState: BrowserSessionState;
  blockedKind: BrowserBlockedKind | null;
  lastKnownUrl: string;
  lastKnownTitle: string;
  lastUpdatedAt: string;
}

export interface BrowserOpenResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  sessionId?: string;
  url: string;
  title: string;
  reusedSession: boolean;
  createdProfile: boolean;
  message: string;
}

export interface BrowserSnapshotElement {
  ref: string;
  role: string | null;
  name: string | null;
  tag: string;
  text: string | null;
  href: string | null;
  disabled: boolean;
  checked: boolean;
}

export interface BrowserSnapshotResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  message: string;
}

export interface BrowserActionResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  message: string;
  riskReason?: string;
}

export interface BrowserWaitResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  message: string;
}

export interface BrowserScreenshotResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  path: string;
  contentType: string;
  content: Buffer;
}

export interface BrowserCloseResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  message: string;
}

export interface BrowserActionAuditInput {
  talkId?: string | null;
  runId?: string | null;
}

interface LiveSession {
  sessionId: string;
  userId: string | null;
  ownerRunId: string | null;
  profileId: string;
  siteKey: string;
  accountLabel: string | null;
  headed: boolean;
  connectionMode: BrowserConnectionMode;
  ownsBrowser: boolean;
  browser: Browser | null;
  state: BrowserSessionState;
  owner: BrowserSessionOwner;
  blockedKind: BrowserBlockedKind | null;
  blockedMessage: string | null;
  lastKnownUrl: string;
  lastKnownTitle: string;
  lastUpdatedAt: string;
  touchedRunIds: Set<string>;
  context: BrowserContext;
  page: Page;
}

type PersistentContextLaunchOptions = Parameters<
  typeof chromium.launchPersistentContext
>[1];

function buildProfileMapKey(
  siteKey: string,
  accountLabel: string | null,
): string {
  return buildBrowserProfileKey(siteKey, accountLabel);
}

function humanizeSiteKey(siteKey: string): string {
  if (siteKey.toLowerCase() === 'linkedin') {
    return 'LinkedIn';
  }
  if (siteKey.length <= 3) {
    return siteKey.toUpperCase();
  }
  return siteKey
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function isLinkedInSurface(url: string, bodyText?: string | null): boolean {
  return /linkedin\.com/i.test(url) || /\blinkedin\b/i.test(bodyText || '');
}

function compactSurfaceText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length > 0 ? compacted : null;
}

function mergeSurfaceText(...values: Array<string | null | undefined>): string {
  return values
    .map((value) => compactSurfaceText(value))
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function buildLinkedInBlockedReason(input: {
  url: string;
  bodyText?: string | null;
  titleText?: string | null;
  visibleText?: string | null;
  passwordFieldCount?: number;
  urlSuggestsAuth?: boolean;
}): { kind: BrowserBlockedKind; reason: string } | null {
  const surfaceText = mergeSurfaceText(
    input.titleText,
    input.visibleText,
    input.bodyText,
  );
  if (!isLinkedInSurface(input.url, surfaceText)) {
    return null;
  }
  const bodyText = surfaceText;
  if (HUMAN_ONLY_CHECKPOINT_REGEX.test(bodyText)) {
    return {
      kind: 'human_step_required',
      reason:
        'LinkedIn is showing a human-only security check that must be completed in the browser.',
    };
  }
  if ((input.passwordFieldCount || 0) > 0) {
    return {
      kind: 'auth_required',
      reason: 'LinkedIn needs interactive sign-in for this browser profile.',
    };
  }
  if (LINKEDIN_PHONE_APPROVAL_REGEX.test(bodyText)) {
    return {
      kind: 'auth_required',
      reason:
        'LinkedIn is waiting for phone or app approval on a trusted device.',
    };
  }
  if (LINKEDIN_CODE_REGEX.test(bodyText)) {
    return {
      kind: 'auth_required',
      reason: 'LinkedIn requires a verification code to continue.',
    };
  }
  if (LINKEDIN_DEVICE_TRUST_REGEX.test(bodyText)) {
    return {
      kind: 'auth_required',
      reason:
        'LinkedIn is asking you to verify this sign-in or device before the agent can continue.',
    };
  }
  if (INTERACTIVE_AUTH_CHECKPOINT_REGEX.test(bodyText)) {
    return {
      kind: 'auth_required',
      reason:
        'LinkedIn needs interactive sign-in or device approval before the agent can continue.',
    };
  }
  if (
    input.urlSuggestsAuth &&
    /(checkpoint|challenge|login|signin|sign-in|verify)/i.test(input.url)
  ) {
    return {
      kind: 'auth_required',
      reason:
        'LinkedIn is in a checkpoint or sign-in flow and needs interactive approval before the agent can continue.',
    };
  }
  return null;
}

async function readOptionalPageTitle(page: Page): Promise<string | null> {
  try {
    return compactSurfaceText(await page.title());
  } catch {
    return null;
  }
}

async function readOptionalInnerText(
  page: Page,
  selector: string,
): Promise<string | null> {
  try {
    return compactSurfaceText(await page.locator(selector).innerText());
  } catch {
    return null;
  }
}

async function readOptionalAllInnerTexts(
  page: Page,
  selector: string,
): Promise<string | null> {
  try {
    return compactSurfaceText(
      (await page.locator(selector).allInnerTexts()).join('\n'),
    );
  } catch {
    return null;
  }
}

function buildReusePrefix(siteKey: string): string {
  return `Reusing the existing trusted ${humanizeSiteKey(siteKey)} browser session.`;
}

function buildOpenResultFromExistingSessionSnapshot(input: {
  snapshot: BrowserSessionStatusSnapshot;
  createdProfile: boolean;
}): BrowserOpenResult | null {
  const { snapshot, createdProfile } = input;
  const prefix = buildReusePrefix(snapshot.siteKey);

  if (snapshot.state === 'takeover' || snapshot.owner === 'user') {
    return {
      status: 'human_step_required',
      siteKey: snapshot.siteKey,
      accountLabel: snapshot.accountLabel,
      sessionId: snapshot.sessionId,
      url: snapshot.currentUrl,
      title: snapshot.currentTitle,
      reusedSession: true,
      createdProfile,
      message: `${prefix} Finish the manual sign-in or verification step in that browser window and the agent will continue from there.`,
    };
  }

  if (snapshot.state !== 'blocked') {
    return null;
  }

  if (snapshot.blockedKind === 'confirmation_required') {
    return {
      status: 'awaiting_confirmation',
      siteKey: snapshot.siteKey,
      accountLabel: snapshot.accountLabel,
      sessionId: snapshot.sessionId,
      url: snapshot.currentUrl,
      title: snapshot.currentTitle,
      reusedSession: true,
      createdProfile,
      message:
        snapshot.blockedMessage ||
        `${prefix} Resolve the pending confirmation in the existing browser session before continuing.`,
    };
  }

  if (snapshot.blockedKind === 'human_step_required') {
    return {
      status: 'human_step_required',
      siteKey: snapshot.siteKey,
      accountLabel: snapshot.accountLabel,
      sessionId: snapshot.sessionId,
      url: snapshot.currentUrl,
      title: snapshot.currentTitle,
      reusedSession: true,
      createdProfile,
      message:
        snapshot.blockedMessage ||
        `${prefix} Complete the manual browser step in the existing session and the agent will reuse it.`,
    };
  }

  return {
    status: 'needs_auth',
    siteKey: snapshot.siteKey,
    accountLabel: snapshot.accountLabel,
    sessionId: snapshot.sessionId,
    url: snapshot.currentUrl,
    title: snapshot.currentTitle,
    reusedSession: true,
    createdProfile,
    message:
      snapshot.blockedMessage ||
      `${prefix} Finish the interactive sign-in or device approval step in the existing session and the agent will reuse it.`,
  };
}

function buildSetupSessionReuseMessage(
  snapshot: BrowserSessionStatusSnapshot,
): string {
  const siteLabel = humanizeSiteKey(snapshot.siteKey);
  if (snapshot.state === 'takeover' || snapshot.owner === 'user') {
    return `${siteLabel} setup session is already open. Continue the existing manual sign-in or verification step in that browser window.`;
  }
  if (snapshot.blockedKind === 'human_step_required') {
    return `Continue the existing ${siteLabel} human-only verification step in the opened browser window.`;
  }
  if (snapshot.blockedKind === 'confirmation_required') {
    return `Resolve the existing ${siteLabel} confirmation step in the opened browser window.`;
  }
  return `Continue the existing ${siteLabel} sign-in or device approval step in the opened browser window.`;
}

function inferPersistedBlockedReason(input: {
  kind: BrowserBlockedKind | null;
  message?: string | null;
}):
  | 'login_required'
  | 'phone_approval'
  | 'app_approval'
  | 'code_entry'
  | 'session_conflict'
  | 'manual_takeover'
  | null {
  if (input.kind === 'session_conflict') {
    return 'session_conflict';
  }
  if (
    input.kind === 'human_step_required' ||
    input.kind === 'confirmation_required'
  ) {
    return 'manual_takeover';
  }
  if (input.kind !== 'auth_required') {
    return null;
  }
  const text = (input.message || '').toLowerCase();
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

function urlsEquivalent(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.host === rightUrl.host &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return left.replace(/#.*$/, '') === right.replace(/#.*$/, '');
  }
}

function resolveViewport(profile: BrowserProfileSnapshot): {
  width: number;
  height: number;
} {
  return profile.viewport;
}

function buildChromeProfileLaunchArgs(
  profile: BrowserProfileSnapshot,
): string[] {
  if (profile.connectionConfig.mode !== 'chrome_profile') {
    return [];
  }

  const profileDirectory = profile.connectionConfig.profileDirectory?.trim();
  if (!profileDirectory) {
    return [];
  }

  return [`--profile-directory=${profileDirectory}`];
}

function buildLaunchOptions(
  profile: BrowserProfileSnapshot,
  headed: boolean,
): PersistentContextLaunchOptions {
  const options: PersistentContextLaunchOptions = {
    headless: !headed,
    channel: profile.channel || undefined,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    viewport: resolveViewport(profile),
    acceptDownloads: true,
    downloadsPath: profile.downloadDir,
  };
  if (profile.userAgent) {
    options.userAgent = profile.userAgent;
  }
  const args = buildChromeProfileLaunchArgs(profile);
  if (args.length > 0) {
    options.args = args;
  }
  return options;
}

async function gotoWithOptionalRetry(input: {
  page: Page;
  url: string;
  timeoutMs: number;
  retryOnTimeout?: boolean;
}): Promise<void> {
  try {
    await input.page.goto(input.url, {
      waitUntil: 'domcontentloaded',
      timeout: input.timeoutMs,
    });
    return;
  } catch (error) {
    const isTimeoutError =
      error instanceof Error &&
      (error.name === 'TimeoutError' || /timeout/i.test(error.message));
    if (!input.retryOnTimeout || !isTimeoutError) {
      throw error;
    }
  }

  await input.page.goto(input.url, {
    waitUntil: 'domcontentloaded',
    timeout: input.timeoutMs,
  });
}

async function ensurePrimaryPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  if (pages.length > 0) {
    return pages[0]!;
  }
  return context.newPage();
}

async function detectBlockedState(page: Page): Promise<{
  kind: BrowserBlockedKind | null;
  reason?: string;
}> {
  const url = page.url();
  const urlSuggestsAuth =
    /(login|signin|sign-in|auth|checkpoint|challenge|verify)/i.test(url);
  if (urlSuggestsAuth && !isLinkedInSurface(url)) {
    return {
      kind: 'auth_required',
      reason: `Current page URL suggests an authentication flow: ${url}`,
    };
  }

  let passwordFieldCount = 0;
  try {
    passwordFieldCount = await page.locator('input[type="password"]').count();
  } catch {
    passwordFieldCount = 0;
  }
  if (passwordFieldCount > 0) {
    const passwordLinkedInBlocked = buildLinkedInBlockedReason({
      url,
      passwordFieldCount,
      urlSuggestsAuth,
    });
    if (passwordLinkedInBlocked) {
      return passwordLinkedInBlocked;
    }
    return {
      kind: 'auth_required',
      reason: 'Page contains a password field.',
    };
  }

  const titleText = await readOptionalPageTitle(page);
  const visibleText = await readOptionalAllInnerTexts(
    page,
    'h1, h2, [role="heading"], button, [role="button"], label',
  );
  const bodyText = await readOptionalInnerText(page, 'body');
  const linkedInBlocked = buildLinkedInBlockedReason({
    url,
    bodyText,
    titleText,
    visibleText,
    urlSuggestsAuth,
  });
  if (linkedInBlocked) {
    return linkedInBlocked;
  }

  const surfaceText = mergeSurfaceText(titleText, visibleText, bodyText);
  if (HUMAN_ONLY_CHECKPOINT_REGEX.test(surfaceText)) {
    return {
      kind: 'human_step_required',
      reason: 'Page content suggests a human-only verification step.',
    };
  }
  if (INTERACTIVE_AUTH_CHECKPOINT_REGEX.test(surfaceText)) {
    return {
      kind: 'auth_required',
      reason:
        'Page content suggests interactive authentication or device verification.',
    };
  }

  if (urlSuggestsAuth) {
    const linkedInBlocked = buildLinkedInBlockedReason({
      url,
      urlSuggestsAuth,
    });
    if (linkedInBlocked) {
      return linkedInBlocked;
    }
    return {
      kind: 'auth_required',
      reason: `Current page URL suggests an authentication flow: ${url}`,
    };
  }

  return { kind: null };
}

async function describeTarget(
  page: Page,
  target: string,
): Promise<{
  ref: string;
  role: string | null;
  label: string | null;
  tag: string | null;
  href: string | null;
  type: string | null;
}> {
  const descriptor = await page
    .locator(`[${REF_ATTRIBUTE}="${target}"]`)
    .first()
    .evaluate((element, refAttribute) => {
      const ref = element.getAttribute(refAttribute) || '';
      const elementRecord = element as {
        value?: unknown;
        textContent?: string | null;
        tagName?: string;
        href?: string | null;
        type?: string | null;
      };
      const label =
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        (typeof elementRecord.value === 'string'
          ? elementRecord.value
          : null) ||
        elementRecord.textContent ||
        null;

      return {
        ref,
        role: element.getAttribute('role'),
        label: label?.trim() || null,
        tag: (elementRecord.tagName || '').toLowerCase(),
        href:
          typeof elementRecord.href === 'string' ? elementRecord.href : null,
        type:
          typeof elementRecord.type === 'string' ? elementRecord.type : null,
      };
    }, REF_ATTRIBUTE);

  return descriptor;
}

function classifyRisk(input: {
  action: string;
  descriptor: {
    role: string | null;
    label: string | null;
    tag: string | null;
    href: string | null;
    type: string | null;
  } | null;
  currentUrl: string;
}): string | null {
  const action = input.action;
  if (
    !['click', 'dblclick'].includes(action) &&
    !(action === 'press' && input.descriptor)
  ) {
    return null;
  }

  const descriptor = input.descriptor;
  if (!descriptor) {
    return null;
  }

  const combined = [
    descriptor.label || '',
    descriptor.role || '',
    descriptor.tag || '',
    descriptor.type || '',
    descriptor.href || '',
  ]
    .join(' ')
    .toLowerCase();

  if (
    /\b(pay|purchase|checkout|book|order|place order|confirm|accept|approve|delete|remove|submit|send|sign)\b/.test(
      combined,
    )
  ) {
    return `Target appears to be a likely final-action control (${descriptor.label || descriptor.tag || descriptor.role || 'unknown target'}).`;
  }

  if (descriptor.type === 'submit') {
    return 'Target is a submit control.';
  }

  return null;
}

async function collectSnapshot(
  page: Page,
  interactiveOnly: boolean,
  maxElements: number,
): Promise<BrowserSnapshotElement[]> {
  return page.evaluate(
    ({ interactiveOnly, maxElements, refAttribute }) => {
      const windowRef = globalThis as { getComputedStyle?: (node: any) => any };
      const documentRef = (globalThis as { document?: any }).document;
      const isVisible = (element: any): boolean => {
        const style = windowRef.getComputedStyle?.(element);
        if (style.visibility === 'hidden' || style.display === 'none') {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const selector = interactiveOnly
        ? [
            'a',
            'button',
            'input',
            'select',
            'textarea',
            '[role="button"]',
            '[role="link"]',
            '[role="checkbox"]',
            '[role="tab"]',
            '[contenteditable="true"]',
          ].join(',')
        : 'body *';

      documentRef
        ?.querySelectorAll?.(`[${refAttribute}]`)
        .forEach((node: any) => node.removeAttribute(refAttribute));

      const nodes = (
        Array.from(documentRef?.querySelectorAll?.(selector) ?? []) as any[]
      )
        .filter((node) => isVisible(node))
        .slice(0, maxElements);

      return nodes.map((node: any, index) => {
        const element = node as {
          tagName?: string;
          textContent?: string | null;
          href?: string | null;
          disabled?: boolean;
          checked?: boolean;
        };
        const ref = `e${index + 1}`;
        node.setAttribute(refAttribute, ref);

        const tag = (element.tagName || '').toLowerCase();
        const role = node.getAttribute('role');
        const text =
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          element.textContent ||
          null;
        const href = typeof element.href === 'string' ? element.href : null;
        const disabled =
          typeof element.disabled === 'boolean'
            ? element.disabled
            : node.getAttribute('aria-disabled') === 'true';
        const checked =
          typeof element.checked === 'boolean'
            ? element.checked
            : node.getAttribute('aria-checked') === 'true';

        return {
          ref,
          role,
          name:
            node.getAttribute('aria-label') ||
            node.getAttribute('name') ||
            node.getAttribute('title') ||
            null,
          tag,
          text: text?.trim() || null,
          href,
          disabled,
          checked,
        };
      });
    },
    {
      interactiveOnly,
      maxElements,
      refAttribute: REF_ATTRIBUTE,
    },
  );
}

function basenameList(files?: string[]): string[] | undefined {
  if (!files) return undefined;
  return files.map((file) => path.basename(file));
}

function nowIso(): string {
  return new Date().toISOString();
}

function detectChromeLockFile(userDataDir: string): boolean {
  // On Linux, Chrome places a SingletonLock in the user-data directory root.
  // On macOS, check for the Chrome process instead (lock file is not reliably used).
  const platform = process.platform;
  if (platform === 'darwin') {
    try {
      const { execSync } =
        require('child_process') as typeof import('child_process');
      const result = execSync('pgrep -x "Google Chrome" 2>/dev/null || true', {
        encoding: 'utf8',
        timeout: 3000,
      });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  const lockPath = path.join(userDataDir, 'SingletonLock');
  try {
    fs.lstatSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

interface AcquiredContext {
  context: BrowserContext;
  page: Page;
  browser: Browser | null;
  ownsBrowser: boolean;
}

async function acquireManagedContext(
  profile: BrowserProfileSnapshot,
  headed: boolean,
): Promise<AcquiredContext> {
  fs.mkdirSync(profile.profilePath, { recursive: true });
  fs.mkdirSync(profile.downloadDir, { recursive: true });
  const context = await chromium.launchPersistentContext(
    profile.profilePath,
    buildLaunchOptions(profile, headed),
  );
  const page = await ensurePrimaryPage(context);
  return { context, page, browser: null, ownsBrowser: true };
}

async function acquireChromeProfileContext(
  profile: BrowserProfileSnapshot,
  headed: boolean,
): Promise<AcquiredContext> {
  if (profile.connectionConfig.mode !== 'chrome_profile') {
    throw new Error('Profile is not configured for chrome_profile mode');
  }
  const chromeUserDataDir = profile.connectionConfig.chromeProfilePath;
  const profileDirectory =
    profile.connectionConfig.profileDirectory?.trim() || null;

  if (detectChromeLockFile(chromeUserDataDir)) {
    logger.warn(
      { chromeUserDataDir, profileDirectory },
      'Chrome may already be running with this profile — close Chrome and retry',
    );
  }

  // Ensure the managed download directory still exists
  fs.mkdirSync(profile.downloadDir, { recursive: true });

  const context = await chromium.launchPersistentContext(
    chromeUserDataDir,
    buildLaunchOptions(profile, headed),
  );
  const page = await ensurePrimaryPage(context);
  return { context, page, browser: null, ownsBrowser: true };
}

async function acquireCdpContext(
  profile: BrowserProfileSnapshot,
): Promise<AcquiredContext> {
  if (profile.connectionConfig.mode !== 'cdp') {
    throw new Error('Profile is not configured for cdp mode');
  }
  const endpointUrl = profile.connectionConfig.endpointUrl;
  const browser = await chromium.connectOverCDP(endpointUrl);
  const context = browser.contexts()[0]!;
  // Always open a NEW tab — never hijack existing ones
  const page = await context.newPage();
  return { context, page, browser, ownsBrowser: false };
}

async function acquireContext(
  profile: BrowserProfileSnapshot,
  headed: boolean,
): Promise<AcquiredContext> {
  switch (profile.connectionMode) {
    case 'chrome_profile':
      return acquireChromeProfileContext(profile, headed);
    case 'cdp':
      return acquireCdpContext(profile);
    case 'managed':
    default:
      return acquireManagedContext(profile, headed);
  }
}

export class BrowserService {
  private readonly sessionsById = new Map<string, LiveSession>();
  private readonly profileSessionIds = new Map<string, string>();
  private readonly runSessionIds = new Map<string, Set<string>>();

  constructor() {
    const reconciled = reconcileBrowserSessionsOnStartup();
    if (reconciled > 0) {
      logger.info(
        { reconciled },
        'Reconciled persisted browser sessions on startup',
      );
    }
  }

  private persistSessionState(session: LiveSession): void {
    upsertBrowserSessionState({
      id: session.sessionId,
      userId: session.userId,
      profileId: session.profileId,
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      state: session.state === 'dead' ? 'disconnected' : session.state,
      blockedReason: inferPersistedBlockedReason({
        kind: session.blockedKind,
        message: session.blockedMessage,
      }),
      ownerRunId: session.ownerRunId,
      lastSeenAt: session.lastUpdatedAt,
      lastLiveContextAt:
        session.state === 'closed' || session.state === 'dead'
          ? null
          : session.lastUpdatedAt,
      updatedAt: session.lastUpdatedAt,
    });
  }

  private buildPersistedStatusSnapshot(
    sessionId: string,
  ): BrowserSessionStatusSnapshot | null {
    const persisted = getBrowserSessionById(sessionId);
    if (!persisted) return null;
    return {
      sessionId: persisted.id,
      siteKey: persisted.siteKey,
      accountLabel: persisted.accountLabel,
      headed: false,
      state: persisted.state,
      owner: persisted.state === 'takeover' ? 'user' : 'agent',
      blockedKind:
        persisted.blockedReason === 'session_conflict'
          ? 'session_conflict'
          : persisted.blockedReason === 'manual_takeover'
            ? 'human_step_required'
            : persisted.blockedReason
              ? 'auth_required'
              : null,
      blockedMessage: null,
      currentUrl: '',
      currentTitle: '',
      lastUpdatedAt: persisted.updatedAt,
    };
  }

  getSessionSnapshot(sessionId: string): BrowserSessionSnapshot | null {
    const session = this.sessionsById.get(sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      headed: session.headed,
    };
  }

  private async buildStatusSnapshot(
    session: LiveSession,
  ): Promise<BrowserSessionStatusSnapshot> {
    session.lastKnownUrl = session.page.url();
    session.lastKnownTitle = await session.page.title();
    session.lastUpdatedAt = nowIso();
    this.persistSessionState(session);
    return {
      sessionId: session.sessionId,
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      headed: session.headed,
      state: session.state,
      owner: session.owner,
      blockedKind: session.blockedKind,
      blockedMessage: session.blockedMessage,
      currentUrl: session.lastKnownUrl,
      currentTitle: session.lastKnownTitle,
      lastUpdatedAt: session.lastUpdatedAt,
    };
  }

  getRunTouchedSessions(runId: string): BrowserRunCarriedSession[] {
    const sessionIds = this.runSessionIds.get(runId);
    if (!sessionIds || sessionIds.size === 0) {
      return [];
    }

    const carried: BrowserRunCarriedSession[] = [];
    for (const sessionId of sessionIds) {
      const session = this.sessionsById.get(sessionId);
      if (!session) continue;
      carried.push({
        sessionId: session.sessionId,
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        lastKnownState: session.state,
        blockedKind: session.blockedKind,
        lastKnownUrl: session.lastKnownUrl,
        lastKnownTitle: session.lastKnownTitle,
        lastUpdatedAt: session.lastUpdatedAt,
      });
    }
    return carried;
  }

  recordRunSessionTouch(
    runId: string | null | undefined,
    sessionId: string,
    userId?: string | null,
  ): void {
    if (!runId) return;
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      const persisted = getBrowserSessionById(sessionId);
      if (!persisted) return;
      upsertBrowserSessionState({
        id: sessionId,
        userId: userId ?? null,
        profileId: persisted.profileId,
        siteKey: persisted.siteKey,
        accountLabel: persisted.accountLabel,
        state: persisted.state,
        blockedReason: persisted.blockedReason,
        ownerRunId: runId,
      });
      return;
    }
    session.userId = userId ?? session.userId;
    session.ownerRunId = runId;
    session.touchedRunIds.add(runId);
    const current = this.runSessionIds.get(runId) || new Set<string>();
    current.add(sessionId);
    this.runSessionIds.set(runId, current);
    this.persistSessionState(session);
  }

  getSessionTouchedRunIds(sessionId: string): string[] {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      const persisted = getBrowserSessionById(sessionId);
      return persisted?.ownerRunId ? [persisted.ownerRunId] : [];
    }
    return Array.from(session.touchedRunIds);
  }

  async getSessionStatus(
    sessionId: string,
  ): Promise<BrowserSessionStatusSnapshot | null> {
    const session = this.sessionsById.get(sessionId);
    if (!session) return this.buildPersistedStatusSnapshot(sessionId);
    if (
      session.owner !== 'user' &&
      session.state !== 'closed' &&
      session.state !== 'dead' &&
      session.blockedKind !== 'confirmation_required'
    ) {
      const blockedState = await detectBlockedState(session.page);
      if (blockedState.kind) {
        this.markSessionBlocked(
          session,
          blockedState.kind,
          blockedState.reason ||
            (blockedState.kind === 'human_step_required'
              ? 'This session is waiting on a human-only browser step.'
              : 'This session is waiting on interactive authentication.'),
        );
      } else if (
        session.state === 'blocked' &&
        (session.blockedKind === 'auth_required' ||
          session.blockedKind === 'human_step_required')
      ) {
        this.markSessionActive(session);
      }
    }
    return this.buildStatusSnapshot(session);
  }

  private async createSession(input: {
    profile: BrowserProfileSnapshot;
    headed: boolean;
    sessionId?: string;
    userId?: string | null;
    ownerRunId?: string | null;
  }): Promise<LiveSession> {
    const acquired = await acquireContext(input.profile, input.headed);
    const { context, page, browser, ownsBrowser } = acquired;
    page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);

    const session: LiveSession = {
      sessionId: input.sessionId || `bs_${randomUUID()}`,
      userId: input.userId ?? null,
      ownerRunId: input.ownerRunId ?? null,
      profileId: input.profile.id,
      siteKey: input.profile.siteKey,
      accountLabel: input.profile.accountLabel,
      headed: input.headed,
      connectionMode: input.profile.connectionMode,
      ownsBrowser,
      browser,
      state: 'active',
      owner: 'agent',
      blockedKind: null,
      blockedMessage: null,
      lastKnownUrl: page.url(),
      lastKnownTitle: '',
      lastUpdatedAt: nowIso(),
      touchedRunIds: new Set<string>(),
      context,
      page,
    };

    context.once('close', () => {
      session.lastUpdatedAt = nowIso();
      upsertBrowserSessionState({
        id: session.sessionId,
        userId: session.userId,
        profileId: session.profileId,
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        state: session.state === 'closed' ? 'closed' : 'disconnected',
        blockedReason: inferPersistedBlockedReason({
          kind: session.blockedKind,
          message: session.blockedMessage,
        }),
        ownerRunId: session.ownerRunId,
        lastSeenAt: session.lastUpdatedAt,
        lastLiveContextAt: null,
        updatedAt: session.lastUpdatedAt,
      });
      this.profileSessionIds.delete(
        buildProfileMapKey(session.siteKey, session.accountLabel),
      );
      this.sessionsById.delete(session.sessionId);
      for (const runId of session.touchedRunIds) {
        const sessions = this.runSessionIds.get(runId);
        if (!sessions) continue;
        sessions.delete(session.sessionId);
        if (sessions.size === 0) {
          this.runSessionIds.delete(runId);
        }
      }
    });

    this.sessionsById.set(session.sessionId, session);
    this.profileSessionIds.set(
      buildProfileMapKey(session.siteKey, session.accountLabel),
      session.sessionId,
    );
    this.persistSessionState(session);
    return session;
  }

  private async relaunchSession(
    liveSession: LiveSession,
    headed: boolean,
  ): Promise<LiveSession> {
    const profile = getBrowserProfileById(liveSession.profileId);
    if (!profile) {
      throw new Error('Browser profile not found for live session');
    }
    const {
      sessionId,
      userId,
      ownerRunId,
      state,
      owner,
      blockedKind,
      blockedMessage,
      lastKnownUrl,
      lastKnownTitle,
      touchedRunIds,
    } = liveSession;

    // Close the old session appropriately
    if (liveSession.ownsBrowser) {
      await liveSession.context.close();
    } else {
      try {
        await liveSession.page.close();
      } catch {
        /* ignore */
      }
      if (liveSession.browser) {
        try {
          await liveSession.browser.close();
        } catch {
          /* ignore */
        }
      }
    }

    const relaunched = await this.createSession({
      profile,
      headed,
      sessionId,
      userId,
      ownerRunId,
    });
    relaunched.state = state;
    relaunched.owner = owner;
    relaunched.blockedKind = blockedKind;
    relaunched.blockedMessage = blockedMessage;
    relaunched.lastKnownUrl = lastKnownUrl;
    relaunched.lastKnownTitle = lastKnownTitle;
    relaunched.lastUpdatedAt = nowIso();
    relaunched.touchedRunIds = new Set(touchedRunIds);
    for (const runId of touchedRunIds) {
      const sessions = this.runSessionIds.get(runId) || new Set<string>();
      sessions.add(relaunched.sessionId);
      this.runSessionIds.set(runId, sessions);
    }
    this.persistSessionState(relaunched);
    return relaunched;
  }

  private getSessionOrThrow(sessionId: string): LiveSession {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      throw new Error(`Browser session ${sessionId} not found`);
    }
    if (session.state === 'takeover' || session.owner === 'user') {
      throw new Error(
        `Browser session ${sessionId} is currently under user takeover and must be resumed before the agent can continue.`,
      );
    }
    return session;
  }

  private markSessionActive(session: LiveSession): void {
    session.state = 'active';
    session.owner = 'agent';
    session.blockedKind = null;
    session.blockedMessage = null;
    session.lastUpdatedAt = nowIso();
    this.persistSessionState(session);
  }

  private markSessionBlocked(
    session: LiveSession,
    kind: BrowserBlockedKind,
    message: string,
  ): void {
    session.state = 'blocked';
    session.owner = 'agent';
    session.blockedKind = kind;
    session.blockedMessage = message;
    session.lastUpdatedAt = nowIso();
    this.persistSessionState(session);
  }

  private async refreshSessionLocation(session: LiveSession): Promise<void> {
    session.lastKnownUrl = session.page.url();
    session.lastKnownTitle = await session.page.title();
    session.lastUpdatedAt = nowIso();
  }

  async open(input: {
    siteKey: string;
    url: string;
    accountLabel?: string | null;
    userId?: string | null;
    runId?: string | null;
    headed?: boolean;
    reuseSession?: boolean;
    navigationTimeoutMs?: number;
    retryOnInitialTimeout?: boolean;
    onPageReady?: (() => void) | undefined;
  }): Promise<BrowserOpenResult> {
    const navigationTimeoutMs =
      input.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    const { profile, created } = ensureBrowserProfile({
      siteKey: input.siteKey,
      accountLabel: input.accountLabel,
    });
    const profileKey = buildProfileMapKey(
      profile.siteKey,
      profile.accountLabel,
    );
    const headed = input.headed === true;
    const reuseSession = input.reuseSession !== false;

    let session: LiveSession | null = null;
    const existingSessionId = this.profileSessionIds.get(profileKey);
    if (existingSessionId) {
      const liveSession = this.sessionsById.get(existingSessionId) || null;
      if (liveSession) {
        if (!reuseSession) {
          return {
            status: 'error',
            siteKey: profile.siteKey,
            accountLabel: profile.accountLabel,
            url: liveSession.page.url(),
            title: await liveSession.page.title(),
            reusedSession: false,
            createdProfile: created,
            message:
              'A live browser session already exists for this profile. Reuse it or close it before opening another session.',
          };
        }

        const existingSnapshot = await this.getSessionStatus(
          liveSession.sessionId,
        );
        if (existingSnapshot) {
          liveSession.userId = input.userId ?? liveSession.userId;
          liveSession.ownerRunId = input.runId ?? liveSession.ownerRunId;
          this.persistSessionState(liveSession);
          const blockedResult = buildOpenResultFromExistingSessionSnapshot({
            snapshot: existingSnapshot,
            createdProfile: created,
          });
          if (blockedResult) {
            touchBrowserProfileLastUsed(profile.id);
            input.onPageReady?.();
            return blockedResult;
          }
          if (
            existingSnapshot.state === 'active' &&
            urlsEquivalent(existingSnapshot.currentUrl, input.url)
          ) {
            touchBrowserProfileLastUsed(profile.id);
            input.onPageReady?.();
            return {
              status: 'ok',
              siteKey: profile.siteKey,
              accountLabel: profile.accountLabel,
              sessionId: liveSession.sessionId,
              url: existingSnapshot.currentUrl,
              title: existingSnapshot.currentTitle,
              reusedSession: true,
              createdProfile: created,
              message:
                'Reused the existing trusted browser session without reloading the page.',
            };
          }
        }

        session =
          liveSession.headed === headed
            ? liveSession
            : await this.relaunchSession(liveSession, headed);
      }
    }

    if (!session) {
      session = await this.createSession({
        profile,
        headed,
        userId: input.userId ?? null,
        ownerRunId: input.runId ?? null,
      });
    } else {
      session.userId = input.userId ?? session.userId;
      session.ownerRunId = input.runId ?? session.ownerRunId;
      this.persistSessionState(session);
    }

    await gotoWithOptionalRetry({
      page: session.page,
      url: input.url,
      timeoutMs: navigationTimeoutMs,
      retryOnTimeout: input.retryOnInitialTimeout === true,
    });
    await this.refreshSessionLocation(session);
    input.onPageReady?.();

    touchBrowserProfileLastUsed(profile.id);
    const blockedState = await detectBlockedState(session.page);
    if (blockedState.kind) {
      this.markSessionBlocked(
        session,
        blockedState.kind,
        blockedState.reason || '',
      );
      return {
        status:
          blockedState.kind === 'human_step_required'
            ? 'human_step_required'
            : 'needs_auth',
        siteKey: profile.siteKey,
        accountLabel: profile.accountLabel,
        sessionId: session.sessionId,
        url: session.page.url(),
        title: await session.page.title(),
        reusedSession: !created && Boolean(existingSessionId && reuseSession),
        createdProfile: created,
        message:
          blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This site requires a human-only browser step before the agent can continue.'
            : 'This site requires interactive authentication for this profile.'),
      };
    }

    this.markSessionActive(session);

    return {
      status: 'ok',
      siteKey: profile.siteKey,
      accountLabel: profile.accountLabel,
      sessionId: session.sessionId,
      url: session.page.url(),
      title: await session.page.title(),
      reusedSession: !created && Boolean(existingSessionId && reuseSession),
      createdProfile: created,
      message: 'Browser session ready.',
    };
  }

  async openSetupSession(input: {
    siteKey: string;
    accountLabel?: string | null;
    url?: string | null;
    userId?: string | null;
  }): Promise<BrowserOpenResult> {
    const { profile, created } = ensureBrowserProfile({
      siteKey: input.siteKey,
      accountLabel: input.accountLabel,
    });
    const profileKey = buildProfileMapKey(
      profile.siteKey,
      profile.accountLabel,
    );

    const existingSessionId = this.profileSessionIds.get(profileKey);
    const existingSession = existingSessionId
      ? this.sessionsById.get(existingSessionId) || null
      : null;
    const existingSnapshot = existingSession
      ? await this.getSessionStatus(existingSession.sessionId)
      : null;

    const session =
      existingSession && existingSession.headed
        ? existingSession
        : existingSession
          ? await this.relaunchSession(existingSession, true)
          : await this.createSession({
              profile,
              headed: true,
              userId: input.userId ?? null,
            });

    session.userId = input.userId ?? session.userId;
    this.persistSessionState(session);

    if (
      existingSnapshot &&
      (existingSnapshot.state !== 'active' || existingSnapshot.owner === 'user')
    ) {
      await this.refreshSessionLocation(session);
      touchBrowserProfileLastUsed(profile.id);
      session.state = 'takeover';
      session.owner = 'user';
      session.blockedKind = null;
      session.blockedMessage = null;
      session.lastUpdatedAt = nowIso();
      this.persistSessionState(session);
      return {
        status: 'ok',
        siteKey: profile.siteKey,
        accountLabel: profile.accountLabel,
        sessionId: session.sessionId,
        url: session.page.url(),
        title: await session.page.title(),
        reusedSession: true,
        createdProfile: created,
        message: buildSetupSessionReuseMessage(existingSnapshot),
      };
    }

    if (input.url) {
      await session.page.goto(input.url, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
      });
    }
    await this.refreshSessionLocation(session);

    touchBrowserProfileLastUsed(profile.id);
    session.state = 'takeover';
    session.owner = 'user';
    session.blockedKind = null;
    session.blockedMessage = null;
    session.lastUpdatedAt = nowIso();
    this.persistSessionState(session);
    return {
      status: 'ok',
      siteKey: profile.siteKey,
      accountLabel: profile.accountLabel,
      sessionId: session.sessionId,
      url: session.page.url(),
      title: await session.page.title(),
      reusedSession: Boolean(existingSession),
      createdProfile: created,
      message:
        'Setup session opened. Complete authentication in the browser, then return to the terminal.',
    };
  }

  async snapshot(input: {
    sessionId: string;
    interactiveOnly?: boolean;
    maxElements?: number;
  }): Promise<BrowserSnapshotResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    const elements = await collectSnapshot(
      session.page,
      input.interactiveOnly !== false,
      input.maxElements && input.maxElements > 0
        ? Math.floor(input.maxElements)
        : 200,
    );
    await this.refreshSessionLocation(session);

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      url: session.page.url(),
      title: await session.page.title(),
      elements,
      message: 'Snapshot collected.',
    };
  }

  async act(
    input: {
      sessionId: string;
      action: string;
      target?: string;
      value?: string;
      files?: string[];
      confirm?: boolean;
      timeoutMs?: number;
    },
    audit: BrowserActionAuditInput = {},
  ): Promise<BrowserActionResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    const urlBefore = session.page.url();
    let targetDescriptor: Awaited<ReturnType<typeof describeTarget>> | null =
      null;
    let gatingDecision = 'auto_allowed';
    let riskReason: string | null = null;

    try {
      if (input.target) {
        targetDescriptor = await describeTarget(session.page, input.target);
      }
    } catch {
      targetDescriptor = null;
    }

    riskReason = classifyRisk({
      action: input.action,
      descriptor: targetDescriptor,
      currentUrl: urlBefore,
    });
    if (riskReason && input.confirm !== true) {
      gatingDecision = 'blocked_confirmation';
      this.markSessionBlocked(
        session,
        'confirmation_required',
        'Action requires confirmation before proceeding.',
      );
      await this.logAudit({
        event: 'browser_action_audit',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        sessionId: session.sessionId,
        action: input.action,
        targetRef: targetDescriptor?.ref ?? input.target ?? null,
        targetRole: targetDescriptor?.role ?? null,
        targetLabel: targetDescriptor?.label ?? null,
        urlBefore,
        urlAfter: urlBefore,
        confirmFlag: false,
        gatingDecision,
        riskReason,
        talkId: audit.talkId ?? null,
        runId: audit.runId ?? null,
        valueProvided: input.value !== undefined,
        valueLength: input.value?.length ?? null,
        uploadFiles: basenameList(input.files) ?? null,
      });

      return {
        status: 'awaiting_confirmation',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        url: urlBefore,
        title: await session.page.title(),
        message: 'Action requires confirmation before proceeding.',
        riskReason,
      };
    }

    if (riskReason && input.confirm === true) {
      gatingDecision = 'confirmed';
    }

    const timeout = input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const locator = input.target
      ? session.page.locator(`[${REF_ATTRIBUTE}="${input.target}"]`).first()
      : null;

    switch (input.action) {
      case 'navigate':
        if (!input.value) {
          throw new Error('navigate requires value');
        }
        await session.page.goto(input.value, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
        break;
      case 'click':
        if (!locator) throw new Error('click requires target');
        await locator.click({ timeout });
        break;
      case 'dblclick':
        if (!locator) throw new Error('dblclick requires target');
        await locator.dblclick({ timeout });
        break;
      case 'fill':
        if (!locator) throw new Error('fill requires target');
        await locator.fill(input.value ?? '', { timeout });
        break;
      case 'type':
        if (!locator) throw new Error('type requires target');
        await locator.type(input.value ?? '', { timeout });
        break;
      case 'press':
        if (locator) {
          await locator.press(input.value || 'Enter', { timeout });
        } else {
          await session.page.keyboard.press(input.value || 'Enter');
        }
        break;
      case 'select':
        if (!locator) throw new Error('select requires target');
        await locator.selectOption(input.value ?? '', { timeout });
        break;
      case 'check':
        if (!locator) throw new Error('check requires target');
        await locator.check({ timeout });
        break;
      case 'uncheck':
        if (!locator) throw new Error('uncheck requires target');
        await locator.uncheck({ timeout });
        break;
      case 'hover':
        if (!locator) throw new Error('hover requires target');
        await locator.hover({ timeout });
        break;
      case 'scroll':
        await session.page.evaluate(
          (value) => {
            (
              globalThis as { scrollBy?: (x: number, y: number) => void }
            ).scrollBy?.(0, value);
          },
          Number.parseInt(input.value || '600', 10),
        );
        break;
      case 'upload':
        if (!locator) throw new Error('upload requires target');
        if (!input.files?.length) {
          throw new Error('upload requires files');
        }
        await locator.setInputFiles(input.files);
        break;
      case 'back':
        await session.page.goBack({ timeout, waitUntil: 'domcontentloaded' });
        break;
      case 'forward':
        await session.page.goForward({
          timeout,
          waitUntil: 'domcontentloaded',
        });
        break;
      case 'reload':
        await session.page.reload({ timeout, waitUntil: 'domcontentloaded' });
        break;
      default:
        throw new Error(`Unsupported browser action: ${input.action}`);
    }

    touchBrowserProfileLastUsed(session.profileId);
    const blockedState = await detectBlockedState(session.page);
    const urlAfter = session.page.url();
    await this.refreshSessionLocation(session);
    await this.logAudit({
      event: 'browser_action_audit',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      sessionId: session.sessionId,
      action: input.action,
      targetRef: targetDescriptor?.ref ?? input.target ?? null,
      targetRole: targetDescriptor?.role ?? null,
      targetLabel: targetDescriptor?.label ?? null,
      urlBefore,
      urlAfter,
      confirmFlag: input.confirm === true,
      gatingDecision,
      riskReason,
      talkId: audit.talkId ?? null,
      runId: audit.runId ?? null,
      valueProvided: input.value !== undefined,
      valueLength: input.value?.length ?? null,
      uploadFiles: basenameList(input.files) ?? null,
    });

    if (blockedState.kind) {
      this.markSessionBlocked(
        session,
        blockedState.kind,
        blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This action led to a human-only browser step.'
            : 'This action led to an interactive authentication step.'),
      );
      return {
        status:
          blockedState.kind === 'human_step_required'
            ? 'human_step_required'
            : 'needs_auth',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        url: urlAfter,
        title: await session.page.title(),
        message:
          blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This action led to a human-only browser step.'
            : 'This action led to an interactive authentication step.'),
      };
    }

    this.markSessionActive(session);

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      url: urlAfter,
      title: await session.page.title(),
      message: 'Browser action completed.',
      ...(riskReason ? { riskReason } : {}),
    };
  }

  private async logAudit(payload: Record<string, unknown>): Promise<void> {
    logger.info(payload, 'browser_action_audit');
  }

  async wait(input: {
    sessionId: string;
    conditionType: 'url' | 'text' | 'element' | 'load';
    value?: string;
    timeoutMs?: number;
  }): Promise<BrowserWaitResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    const timeout = input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

    switch (input.conditionType) {
      case 'url':
        if (!input.value) {
          throw new Error('browser_wait(url) requires value');
        }
        await session.page.waitForURL(input.value, { timeout });
        break;
      case 'text':
        if (!input.value) {
          throw new Error('browser_wait(text) requires value');
        }
        await session.page
          .locator(`text=${input.value}`)
          .first()
          .waitFor({ timeout });
        break;
      case 'element':
        if (!input.value) {
          throw new Error('browser_wait(element) requires value');
        }
        await session.page
          .locator(`[${REF_ATTRIBUTE}="${input.value}"]`)
          .first()
          .waitFor({ timeout });
        break;
      case 'load':
        await session.page.waitForLoadState(
          (input.value as 'load' | 'domcontentloaded' | 'networkidle') ||
            'load',
          { timeout },
        );
        break;
      default:
        throw new Error(
          `Unsupported browser_wait condition: ${input.conditionType}`,
        );
    }

    const blockedState = await detectBlockedState(session.page);
    await this.refreshSessionLocation(session);
    if (blockedState.kind) {
      this.markSessionBlocked(
        session,
        blockedState.kind,
        blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This page now requires a human-only browser step.'
            : 'This page now requires interactive authentication.'),
      );
      return {
        status:
          blockedState.kind === 'human_step_required'
            ? 'human_step_required'
            : 'needs_auth',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        url: session.page.url(),
        title: await session.page.title(),
        message:
          blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This page now requires a human-only browser step.'
            : 'This page now requires interactive authentication.'),
      };
    }

    this.markSessionActive(session);

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      url: session.page.url(),
      title: await session.page.title(),
      message: 'Wait condition satisfied.',
    };
  }

  async screenshot(input: {
    sessionId: string;
    fullPage?: boolean;
    label?: string;
  }): Promise<BrowserScreenshotResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    const content = await session.page.screenshot({
      type: 'png',
      fullPage: input.fullPage === true,
    });
    const label = input.label?.trim() || 'screenshot';
    const dir = path.join(DATA_DIR, 'browser-artifacts', session.siteKey);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(
      dir,
      `${Date.now()}-${label.replace(/[^a-zA-Z0-9._-]+/g, '-')}.png`,
    );
    fs.writeFileSync(filePath, content);
    await this.refreshSessionLocation(session);

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      url: session.page.url(),
      title: await session.page.title(),
      path: filePath,
      contentType: 'image/png',
      content,
    };
  }

  async close(input: {
    sessionId: string;
    keepProfile?: boolean;
    userId?: string | null;
  }): Promise<BrowserCloseResult> {
    const session = this.sessionsById.get(input.sessionId);
    if (!session) {
      throw new Error(`Browser session ${input.sessionId} not found`);
    }
    session.userId = input.userId ?? session.userId;
    session.state = 'closed';
    session.lastUpdatedAt = nowIso();
    this.persistSessionState(session);

    if (session.ownsBrowser) {
      // managed / chrome_profile: we launched the browser, so context.close() kills it
      await session.context.close();
    } else {
      // CDP: close only the tab we opened, then disconnect (don't kill Chrome)
      try {
        await session.page.close();
      } catch {
        // page may already be closed
      }
      if (session.browser) {
        try {
          await session.browser.close();
        } catch {
          // disconnect may already have happened
        }
      }
    }

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      message: 'Browser session closed.',
    };
  }

  async startTakeover(input: {
    sessionId: string;
    userId?: string | null;
  }): Promise<BrowserSessionStatusSnapshot> {
    const session = this.sessionsById.get(input.sessionId);
    if (!session) {
      throw new Error(`Browser session ${input.sessionId} not found`);
    }

    const activeSession = session.headed
      ? session
      : await this.relaunchSession(session, true);
    activeSession.userId = input.userId ?? activeSession.userId;
    await this.refreshSessionLocation(activeSession);
    activeSession.state = 'takeover';
    activeSession.owner = 'user';
    activeSession.blockedKind = null;
    activeSession.blockedMessage = null;
    activeSession.lastUpdatedAt = nowIso();
    this.persistSessionState(activeSession);
    return this.buildStatusSnapshot(activeSession);
  }

  async resumeTakeover(input: {
    sessionId: string;
    userId?: string | null;
  }): Promise<BrowserSessionStatusSnapshot> {
    const session = this.sessionsById.get(input.sessionId);
    if (!session) {
      throw new Error(`Browser session ${input.sessionId} not found`);
    }
    session.userId = input.userId ?? session.userId;
    this.markSessionActive(session);
    await this.refreshSessionLocation(session);
    return this.buildStatusSnapshot(session);
  }
}

let browserService: BrowserService | null = null;

export function getBrowserService(): BrowserService {
  if (!browserService) {
    browserService = new BrowserService();
  }
  return browserService;
}

export function _resetBrowserServiceForTests(): void {
  browserService = null;
}

export const _testOnly = {
  detectBlockedState,
  classifyRisk,
  buildLinkedInBlockedReason,
  buildOpenResultFromExistingSessionSnapshot,
  buildChromeProfileLaunchArgs,
  buildLaunchOptions,
};
