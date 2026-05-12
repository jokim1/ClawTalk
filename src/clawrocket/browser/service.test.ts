import { describe, expect, it, vi } from 'vitest';

import { _testOnly } from './service.js';

function makePage(input?: {
  url?: string;
  passwordCount?: number;
  bodyText?: string;
  title?: string;
  visibleTexts?: string[];
  throwOnPasswordCount?: boolean;
  throwOnBodyText?: boolean;
  throwOnTitle?: boolean;
  throwOnVisibleTexts?: boolean;
}): any {
  return {
    url: vi.fn(() => input?.url ?? 'https://example.com/account'),
    title: input?.throwOnTitle
      ? vi.fn().mockRejectedValue(new Error('title failed'))
      : vi.fn().mockResolvedValue(input?.title ?? ''),
    locator: vi.fn((selector: string) => {
      if (selector === 'input[type="password"]') {
        return {
          count: input?.throwOnPasswordCount
            ? vi.fn().mockRejectedValue(new Error('count failed'))
            : vi.fn().mockResolvedValue(input?.passwordCount ?? 0),
        };
      }
      if (selector === 'body') {
        return {
          innerText: input?.throwOnBodyText
            ? vi.fn().mockRejectedValue(new Error('innerText failed'))
            : vi.fn().mockResolvedValue(input?.bodyText ?? ''),
        };
      }
      if (
        selector === 'h1, h2, [role="heading"], button, [role="button"], label'
      ) {
        return {
          allInnerTexts: input?.throwOnVisibleTexts
            ? vi.fn().mockRejectedValue(new Error('allInnerTexts failed'))
            : vi.fn().mockResolvedValue(input?.visibleTexts ?? []),
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }),
  };
}

describe('browser service helpers', () => {
  it('detects auth from URL before reading the page DOM', async () => {
    const page = makePage({
      url: 'https://example.com/login',
    });

    const result = await _testOnly.detectBlockedState(page);

    expect(result).toEqual({
      kind: 'auth_required',
      reason:
        'Current page URL suggests an authentication flow: https://example.com/login',
    });
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('detects auth when the page contains a password field', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        passwordCount: 1,
      }),
    );

    expect(result).toEqual({
      kind: 'auth_required',
      reason: 'Page contains a password field.',
    });
  });

  it('detects auth when the page body contains login or verification copy', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        bodyText: 'Please sign in to continue.',
      }),
    );

    expect(result).toEqual({
      kind: 'auth_required',
      reason:
        'Page content suggests interactive authentication or device verification.',
    });
  });

  it('detects auth when the page body requests phone approval or MFA', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        bodyText:
          'Check your phone and approve sign in in the LinkedIn app to continue.',
        url: 'https://www.linkedin.com/checkpoint/challenge',
      }),
    );

    expect(result).toEqual({
      kind: 'auth_required',
      reason:
        'LinkedIn is waiting for phone or app approval on a trusted device.',
    });
  });

  it('detects LinkedIn verification-code checkpoints with a specific reason', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        url: 'https://www.linkedin.com/checkpoint/challenge',
        bodyText: 'Enter the verification code we sent to your email address.',
      }),
    );

    expect(result).toEqual({
      kind: 'auth_required',
      reason: 'LinkedIn requires a verification code to continue.',
    });
  });

  it('detects LinkedIn phone approval checkpoints from the page title even when the body text is sparse', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        url: 'https://www.linkedin.com/checkpoint/challenge',
        title: 'Check your phone | LinkedIn',
      }),
    );

    expect(result).toEqual({
      kind: 'auth_required',
      reason:
        'LinkedIn is waiting for phone or app approval on a trusted device.',
    });
  });

  it('detects LinkedIn approval checkpoints from visible heading and button copy', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        url: 'https://www.linkedin.com/checkpoint/challenge',
        visibleTexts: ['Approve sign in', 'Open the LinkedIn app'],
      }),
    );

    expect(result).toEqual({
      kind: 'auth_required',
      reason:
        'LinkedIn is waiting for phone or app approval on a trusted device.',
    });
  });

  it('detects LinkedIn human-only security checks with a specific reason', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        url: 'https://www.linkedin.com/checkpoint/challenge',
        bodyText:
          'Security check. Complete the challenge to prove you are human.',
      }),
    );

    expect(result).toEqual({
      kind: 'human_step_required',
      reason:
        'LinkedIn is showing a human-only security check that must be completed in the browser.',
    });
  });

  it('reuses an existing blocked trusted session instead of treating it like a fresh open', () => {
    const result = _testOnly.buildOpenResultFromExistingSessionSnapshot({
      createdProfile: false,
      snapshot: {
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        headed: true,
        state: 'blocked',
        owner: 'agent',
        blockedKind: 'auth_required',
        blockedMessage:
          'LinkedIn is waiting for phone or app approval on a trusted device.',
        currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
        currentTitle: 'Approve sign in',
        lastUpdatedAt: '2026-03-21T20:00:00.000Z',
      },
    });

    expect(result).toEqual({
      status: 'needs_auth',
      siteKey: 'linkedin',
      accountLabel: null,
      sessionId: 'session-1',
      url: 'https://www.linkedin.com/checkpoint/challenge',
      title: 'Approve sign in',
      reusedSession: true,
      createdProfile: false,
      message:
        'LinkedIn is waiting for phone or app approval on a trusted device.',
    });
  });

  it('treats an existing takeover session as a manual step to continue, not a new login', () => {
    const result = _testOnly.buildOpenResultFromExistingSessionSnapshot({
      createdProfile: false,
      snapshot: {
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        headed: true,
        state: 'takeover',
        owner: 'user',
        blockedKind: null,
        blockedMessage: null,
        currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
        currentTitle: 'Approve sign in',
        lastUpdatedAt: '2026-03-21T20:00:00.000Z',
      },
    });

    expect(result).toEqual({
      status: 'human_step_required',
      siteKey: 'linkedin',
      accountLabel: null,
      sessionId: 'session-1',
      url: 'https://www.linkedin.com/checkpoint/challenge',
      title: 'Approve sign in',
      reusedSession: true,
      createdProfile: false,
      message:
        'Reusing the existing trusted LinkedIn browser session. Finish the manual sign-in or verification step in that browser window and the agent will continue from there.',
    });
  });

  it('falls back to URL-only auth detection when DOM inspection throws', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        url: 'https://example.com/account',
        throwOnPasswordCount: true,
      }),
    );

    expect(result).toEqual({ kind: null });
  });

  it('does not classify a harmless click as risky just because the page URL contains confirm', () => {
    const result = _testOnly.classifyRisk({
      action: 'click',
      currentUrl: 'https://example.com/confirm-email',
      descriptor: {
        role: 'link',
        label: 'Go to settings',
        tag: 'a',
        href: '/settings',
        type: null,
      },
    });

    expect(result).toBeNull();
  });

  it('still classifies confirm-like targets as risky final actions', () => {
    const result = _testOnly.classifyRisk({
      action: 'click',
      currentUrl: 'https://example.com/account',
      descriptor: {
        role: 'button',
        label: 'Confirm Purchase',
        tag: 'button',
        href: null,
        type: null,
      },
    });

    expect(result).toMatch(/likely final-action control/i);
  });

  it('still classifies submit controls as risky', () => {
    const result = _testOnly.classifyRisk({
      action: 'click',
      currentUrl: 'https://example.com/account',
      descriptor: {
        role: 'button',
        label: 'Go',
        tag: 'input',
        href: null,
        type: 'submit',
      },
    });

    expect(result).toBeTruthy();
  });

  it('adds --profile-directory when a Chrome subprofile is selected', () => {
    const options = _testOnly.buildLaunchOptions(
      {
        id: 'profile-1',
        siteKey: 'linkedin',
        accountLabel: null,
        profilePath: '/tmp/managed-profile',
        channel: 'chrome',
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
        userAgent: null,
        viewport: { width: 1280, height: 720 },
        policy: null,
        downloadDir: '/tmp/downloads',
        connectionMode: 'chrome_profile',
        connectionConfig: {
          mode: 'chrome_profile',
          chromeProfilePath:
            '/Users/alice/Library/Application Support/Google/Chrome',
          profileDirectory: 'Profile 4',
        },
        createdAt: '2026-03-27T00:00:00.000Z',
        updatedAt: '2026-03-27T00:00:00.000Z',
        lastUsedAt: null,
      },
      false,
    );

    expect(options?.args).toEqual(['--profile-directory=Profile 4']);
  });

  it('does not add profile args when no Chrome subprofile is selected', () => {
    const options = _testOnly.buildLaunchOptions(
      {
        id: 'profile-1',
        siteKey: 'linkedin',
        accountLabel: null,
        profilePath: '/tmp/managed-profile',
        channel: 'chrome',
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
        userAgent: null,
        viewport: { width: 1280, height: 720 },
        policy: null,
        downloadDir: '/tmp/downloads',
        connectionMode: 'chrome_profile',
        connectionConfig: {
          mode: 'chrome_profile',
          chromeProfilePath:
            '/Users/alice/Library/Application Support/Google/Chrome',
        },
        createdAt: '2026-03-27T00:00:00.000Z',
        updatedAt: '2026-03-27T00:00:00.000Z',
        lastUsedAt: null,
      },
      false,
    );

    expect(options?.args).toBeUndefined();
  });
});
