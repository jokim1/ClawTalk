import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { MainChannelPage } from './MainChannelPage';
import { ApiError } from '../lib/api';
import type { openMainStream } from '../lib/mainStream';

type MainStreamCallbacks = Parameters<typeof openMainStream>[0];

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function isoOffset(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const {
  deleteMainMessagesMock,
  listMainThreadsMock,
  getMainThreadMock,
  getMainRegisteredAgentMock,
  listMainRunsMock,
  postMainRunVisibleMock,
  postMainMessageMock,
  cancelMainRunMock,
  getBrowserSessionStatusMock,
  startBrowserSetupSessionMock,
  startBrowserTakeoverMock,
  resumeBrowserBlockedRunMock,
  cancelConflictingBrowserRunMock,
  approveBrowserConfirmationMock,
  rejectBrowserConfirmationMock,
  updateMainThreadMock,
  deleteMainThreadMock,
  openMainStreamMock,
} = vi.hoisted(() => ({
  deleteMainMessagesMock: vi.fn(),
  listMainThreadsMock: vi.fn(),
  getMainThreadMock: vi.fn(),
  getMainRegisteredAgentMock: vi.fn(),
  listMainRunsMock: vi.fn(),
  postMainRunVisibleMock: vi.fn(),
  postMainMessageMock: vi.fn(),
  cancelMainRunMock: vi.fn(),
  getBrowserSessionStatusMock: vi.fn(),
  startBrowserSetupSessionMock: vi.fn(),
  startBrowserTakeoverMock: vi.fn(),
  resumeBrowserBlockedRunMock: vi.fn(),
  cancelConflictingBrowserRunMock: vi.fn(),
  approveBrowserConfirmationMock: vi.fn(),
  rejectBrowserConfirmationMock: vi.fn(),
  updateMainThreadMock: vi.fn(),
  deleteMainThreadMock: vi.fn(),
  openMainStreamMock: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../lib/api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    deleteMainMessages: deleteMainMessagesMock,
    listMainThreads: listMainThreadsMock,
    getMainThread: getMainThreadMock,
    getMainRegisteredAgent: getMainRegisteredAgentMock,
    listMainRuns: listMainRunsMock,
    postMainRunVisible: postMainRunVisibleMock,
    postMainMessage: postMainMessageMock,
    cancelMainRun: cancelMainRunMock,
    getBrowserSessionStatus: getBrowserSessionStatusMock,
    startBrowserSetupSession: startBrowserSetupSessionMock,
    startBrowserTakeover: startBrowserTakeoverMock,
    resumeBrowserBlockedRun: resumeBrowserBlockedRunMock,
    cancelConflictingBrowserRun: cancelConflictingBrowserRunMock,
    approveBrowserConfirmation: approveBrowserConfirmationMock,
    rejectBrowserConfirmation: rejectBrowserConfirmationMock,
    updateMainThread: updateMainThreadMock,
    deleteMainThread: deleteMainThreadMock,
  };
});

vi.mock('../lib/mainStream', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/mainStream')>(
      '../lib/mainStream',
    );
  return {
    ...actual,
    openMainStream: openMainStreamMock,
  };
});

function buildMainAgentSnapshot(input?: {
  browserEnabled?: boolean;
  ready?: boolean;
  message?: string;
  selectedMode?: 'api' | 'subscription' | null;
  transport?: 'direct' | 'subscription' | null;
  reasonCode?: string | null;
}) {
  const browserEnabled = input?.browserEnabled ?? false;
  const ready = input?.ready ?? true;
  const selectedMode = input?.selectedMode ?? (ready ? 'subscription' : null);
  const transport = input?.transport ?? (ready ? 'subscription' : null);
  const backend =
    ready && transport === 'direct'
      ? ('direct_http' as const)
      : ready && transport === 'subscription'
        ? ('container' as const)
        : null;
  const authPath =
    ready && selectedMode === 'api'
      ? ('api_key' as const)
      : ready && selectedMode === 'subscription'
        ? ('subscription' as const)
        : null;
  return {
    id: 'agent.main',
    name: 'Nanoclaw',
    providerId: 'provider.anthropic',
    modelId: 'claude-sonnet-4-6',
    toolPermissions: browserEnabled
      ? { shell: true, filesystem: true, web: true, browser: true }
      : { shell: true, filesystem: true, web: true },
    personaRole: 'assistant',
    systemPrompt: null,
    enabled: true,
    createdAt: '2026-03-20T20:00:00.000Z',
    updatedAt: '2026-03-20T20:00:00.000Z',
    executionPreview: {
      surface: 'main' as const,
      backend,
      authPath,
      selectedMode,
      transport,
      reasonCode: input?.reasonCode ?? null,
      routeReason: ready ? ('normal' as const) : ('no_valid_path' as const),
      ready,
      message:
        input?.message ||
        (ready
          ? selectedMode === 'api'
            ? 'Browser automation is ready in API mode.'
            : 'Browser automation is ready in subscription mode.'
          : 'Browser access is not configured for this agent.'),
    },
  };
}

describe('MainChannelPage', () => {
  beforeEach(() => {
    deleteMainMessagesMock.mockResolvedValue({
      threadId: 'thread-main-1',
      deletedCount: 2,
      deletedMessageIds: ['msg-1', 'msg-2'],
      threadDeleted: false,
    });
    listMainRunsMock.mockResolvedValue([]);
    getMainRegisteredAgentMock.mockResolvedValue(buildMainAgentSnapshot());
    postMainRunVisibleMock.mockResolvedValue({ recorded: true });
    cancelMainRunMock.mockResolvedValue({
      runId: 'run-main-browser',
      threadId: 'thread-main-1',
      cancelled: true,
    });
    getBrowserSessionStatusMock.mockResolvedValue({
      sessionId: 'session-1',
      siteKey: 'linkedin',
      accountLabel: null,
      headed: false,
      state: 'blocked',
      owner: 'agent',
      blockedKind: 'auth_required',
      blockedMessage: 'Authenticate to continue.',
      currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
      currentTitle: 'Approve sign in',
      lastUpdatedAt: '2026-03-20T20:24:00.000Z',
    });
    startBrowserSetupSessionMock.mockResolvedValue({
      status: 'ok',
      siteKey: 'linkedin',
      accountLabel: null,
      sessionId: 'session-1',
      url: 'https://www.linkedin.com/feed/',
      title: 'LinkedIn',
      reusedSession: false,
      createdProfile: false,
      message: 'Browser setup session opened.',
    });
    startBrowserTakeoverMock.mockResolvedValue({
      sessionId: 'session-1',
      siteKey: 'linkedin',
      accountLabel: null,
      headed: true,
      state: 'takeover',
      owner: 'user',
      blockedKind: 'auth_required',
      blockedMessage: 'Authenticate to continue.',
      currentUrl: 'https://www.linkedin.com/login',
      currentTitle: 'LinkedIn',
      lastUpdatedAt: '2026-03-20T20:24:00.000Z',
    });
    resumeBrowserBlockedRunMock.mockResolvedValue({
      runId: 'run-main-browser',
      resumed: true,
      queueState: 'queued',
      browserResume: {
        kind: 'auth_completed',
        resumedAt: '2026-03-20T20:25:00.000Z',
        resumedBy: 'user-1',
        sessionId: 'session-1',
        confirmationId: null,
        note: null,
        pendingToolCall: null,
      },
    });
    approveBrowserConfirmationMock.mockResolvedValue({
      confirmationId: 'confirmation-1',
      runId: 'run-main-browser',
      approved: true,
      queueState: 'queued',
      browserResume: {
        kind: 'confirmation_approved',
        resumedAt: '2026-03-20T20:25:00.000Z',
        resumedBy: 'user-1',
        sessionId: 'session-1',
        confirmationId: 'confirmation-1',
        note: null,
        pendingToolCall: null,
      },
    });
    rejectBrowserConfirmationMock.mockResolvedValue({
      confirmationId: 'confirmation-1',
      runId: 'run-main-browser',
      rejected: true,
    });
    cancelConflictingBrowserRunMock.mockResolvedValue({
      runId: 'run-main-browser',
      conflictingRunId: 'run-owner',
      queuedCurrentRun: true,
      currentRunStatus: 'queued',
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('drops stale route thread ids that are not in the current Main thread list', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: '78fc5d1e-e7e9-4d65-a82d-352c89eba992',
        title: 'Morning planning',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
        hasActiveRun: false,
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread_stale']}>
        <Routes>
          <Route
            path="/app/main"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
          <Route
            path="/app/main/:threadId"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Main (Nanoclaw)' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/main'),
    );
    expect(getMainThreadMock).not.toHaveBeenCalled();
    expect(screen.getByText('Nanoclaw')).toBeTruthy();
  });

  it('shows an explicit browser-disabled badge when the Main agent lacks browser tools', async () => {
    listMainThreadsMock.mockResolvedValue([]);
    getMainThreadMock.mockResolvedValue([]);
    getMainRegisteredAgentMock.mockResolvedValue(buildMainAgentSnapshot());

    render(
      <MemoryRouter initialEntries={['/app/main']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const capabilityStatus = await screen.findByRole('list', {
      name: 'Main capability status',
    });
    expect(within(capabilityStatus).getByText('Browser disabled')).toBeTruthy();
    expect(
      screen.getByText(
        'The selected Main agent can use web search and fetch, but browser automation is disabled.',
      ),
    ).toBeTruthy();
  });

  it('shows browser misconfigured when the Main agent is browser-capable but execution is not ready', async () => {
    listMainThreadsMock.mockResolvedValue([]);
    getMainThreadMock.mockResolvedValue([]);
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({
        browserEnabled: true,
        ready: false,
        message:
          'Browser access is not configured for this agent. Configure the agent execution credentials before retrying.',
      }),
    );

    render(
      <MemoryRouter initialEntries={['/app/main']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const capabilityStatus = await screen.findByRole('list', {
      name: 'Main capability status',
    });
    expect(
      within(capabilityStatus).getByText('Browser misconfigured'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Browser access is not configured for this agent. Configure the agent execution credentials before retrying.',
      ),
    ).toBeTruthy();
  });

  it('retries an active chat run as a forced browser run from the same prompt', async () => {
    const user = userEvent.setup();
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: '2026-03-22T20:00:00.000Z',
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Check what you can access on LinkedIn for me.',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-22T20:00:00.000Z',
      },
    ]);
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({ browserEnabled: true, ready: true }),
    );
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-chat-1',
        threadId: 'thread-main-1',
        taskType: 'chat',
        status: 'running',
        createdAt: '2026-03-22T20:00:00.000Z',
        startedAt: '2026-03-22T20:00:01.000Z',
        endedAt: null,
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: 'Checking LinkedIn…',
        browserBlock: null,
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: null,
        streamedTextPreview: null,
        lastProgressMessage: 'Thinking…',
        lastHeartbeatAt: '2026-03-22T20:00:01.000Z',
        terminalSummary: null,
        resumeRequestedAt: null,
        resumeRequestedBy: null,
      },
    ]);
    cancelMainRunMock.mockResolvedValue({
      runId: 'run-chat-1',
      threadId: 'thread-main-1',
      cancelled: true,
    });
    postMainMessageMock.mockResolvedValue({
      messageId: 'msg-main-2',
      threadId: 'thread-main-1',
      runId: 'run-browser-1',
      title: 'LinkedIn Messaging',
      run: {
        id: 'run-browser-1',
        threadId: 'thread-main-1',
        taskType: 'browser',
        status: 'queued',
        createdAt: '2026-03-22T20:00:02.000Z',
        startedAt: null,
        endedAt: null,
        triggerMessageId: 'msg-main-2',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: null,
        browserBlock: null,
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: null,
        streamedTextPreview: null,
        lastProgressMessage: null,
        lastHeartbeatAt: '2026-03-22T20:00:02.000Z',
        terminalSummary: null,
        resumeRequestedAt: null,
        resumeRequestedBy: null,
      },
    });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Check what you can access on LinkedIn for me.');
    await user.click(
      await screen.findByRole('button', { name: 'Open in browser instead' }),
    );

    await waitFor(() =>
      expect(cancelMainRunMock).toHaveBeenCalledWith({ runId: 'run-chat-1' }),
    );
    await waitFor(() =>
      expect(postMainMessageMock).toHaveBeenCalledWith({
        content: 'Check what you can access on LinkedIn for me.',
        threadId: 'thread-main-1',
        forceBrowser: true,
      }),
    );
    expect(
      await screen.findByText(
        'Cancelled the chat run and queued a browser run from the same prompt.',
      ),
    ).toBeTruthy();
  });

  it('hides the browser retry action when browser execution is not ready', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: '2026-03-22T20:00:00.000Z',
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Check what you can access on LinkedIn for me.',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-22T20:00:00.000Z',
      },
    ]);
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({
        browserEnabled: true,
        ready: false,
        message: 'Browser access is not configured for this agent.',
      }),
    );
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-chat-1',
        threadId: 'thread-main-1',
        taskType: 'chat',
        status: 'failed',
        createdAt: '2026-03-22T20:00:00.000Z',
        startedAt: '2026-03-22T20:00:01.000Z',
        endedAt: '2026-03-22T20:00:02.000Z',
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: 'execution_failed: Text-only response',
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: null,
        browserBlock: null,
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: null,
        streamedTextPreview: null,
        lastProgressMessage: null,
        lastHeartbeatAt: '2026-03-22T20:00:02.000Z',
        terminalSummary: {
          statusLabel: 'Failed',
          body: 'Text-only response',
        },
        resumeRequestedAt: null,
        resumeRequestedBy: null,
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Text-only response');
    expect(
      screen.queryByRole('button', { name: 'Open in browser instead' }),
    ).toBeNull();
  });

  it('shows browser ready with the selected mode in the Main header', async () => {
    listMainThreadsMock.mockResolvedValue([]);
    getMainThreadMock.mockResolvedValue([]);
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({
        browserEnabled: true,
        ready: true,
        selectedMode: 'api',
        transport: 'direct',
      }),
    );

    render(
      <MemoryRouter initialEntries={['/app/main']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const capabilityStatus = await screen.findByRole('list', {
      name: 'Main capability status',
    });
    expect(
      within(capabilityStatus).getByText('Browser ready (API)'),
    ).toBeTruthy();
    expect(
      screen.getByText('Browser automation is ready in API mode.'),
    ).toBeTruthy();
  });

  it('renders persisted current step and fast-lane route timing for active runs', async () => {
    const queuedAt = isoOffset(-5_000);
    const executorStartedAt = isoOffset(-4_000);
    const providerStartedAt = isoOffset(-3_000);
    const pageReadyAt = isoOffset(-1_000);
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-fast-lane',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: queuedAt,
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-fast-lane-1',
        threadId: 'thread-main-fast-lane',
        role: 'user',
        content: 'Open LinkedIn and tell me what you can access.',
        agentId: null,
        createdBy: 'user-1',
        createdAt: queuedAt,
      },
    ]);
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({ browserEnabled: true }),
    );
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-fast-lane',
        threadId: 'thread-main-fast-lane',
        status: 'running',
        createdAt: queuedAt,
        startedAt: executorStartedAt,
        endedAt: null,
        triggerMessageId: 'msg-fast-lane-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: null,
        browserBlock: null,
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: {
          backend: 'direct_http',
          authPath: 'api_key',
          credentialSource: 'env',
          routeReason: 'browser_fast_lane',
          plannerReason: 'direct_only',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        },
        executionStrategy: 'browser_fast_lane',
        routeReason: 'browser_fast_lane',
        currentStep: 'Opening LinkedIn…',
        timeoutPhase: null,
        timing: {
          queueStartedAt: queuedAt,
          executorStartedAt,
          firstProviderEventAt: providerStartedAt,
          firstPageReadyAt: pageReadyAt,
        },
        streamedTextPreview: null,
        lastProgressMessage: 'Opening LinkedIn…',
        lastHeartbeatAt: pageReadyAt,
        terminalSummary: null,
        resumeRequestedAt: null,
        resumeRequestedBy: null,
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-fast-lane']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findAllByText('* Opening LinkedIn…')).toHaveLength(2);
    expect(
      screen.getByText(
        'Browser fast lane · Direct API fast lane · Queue 1.0s · Provider 1.0s · Page 3.0s',
      ),
    ).toBeTruthy();
  });

  it('renders warm worker lease metadata for subscription fallback runs', async () => {
    const queuedAt = isoOffset(-8_000);
    const executorStartedAt = isoOffset(-7_000);
    const leaseRequestedAt = isoOffset(-6_000);
    const leaseReadyAt = isoOffset(-5_000);
    const taskDispatchedAt = isoOffset(-4_000);
    const providerStartedAt = isoOffset(-3_000);
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-warm-worker',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: queuedAt,
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-warm-worker-1',
        threadId: 'thread-main-warm-worker',
        role: 'user',
        content: 'Open LinkedIn and tell me what you can access.',
        agentId: null,
        createdBy: 'user-1',
        createdAt: queuedAt,
      },
    ]);
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({ browserEnabled: true }),
    );
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-warm-worker',
        threadId: 'thread-main-warm-worker',
        status: 'running',
        createdAt: queuedAt,
        startedAt: executorStartedAt,
        endedAt: null,
        triggerMessageId: 'msg-warm-worker-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: null,
        browserBlock: null,
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: {
          backend: 'container',
          authPath: 'subscription',
          credentialSource: 'oauth_token',
          routeReason: 'subscription_fallback',
          plannerReason: 'container_only',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        },
        executionStrategy: 'browser_fast_lane',
        routeReason: 'subscription_fallback',
        currentStep: 'Reusing warm subscription worker…',
        timeoutPhase: null,
        leaseState: 'warm_reuse',
        timing: {
          queueStartedAt: queuedAt,
          executorStartedAt,
          leaseRequestedAt,
          leaseReadyAt,
          taskDispatchedAt,
          firstProviderEventAt: providerStartedAt,
        },
        streamedTextPreview: null,
        lastProgressMessage: 'Reusing warm subscription worker…',
        lastHeartbeatAt: providerStartedAt,
        terminalSummary: null,
        resumeRequestedAt: null,
        resumeRequestedBy: null,
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-warm-worker']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findAllByText('* Reusing warm subscription worker…'),
    ).toHaveLength(2);
    expect(
      screen.getByText(
        'Browser fast lane · Subscription fallback · Warm worker reuse · Queue 1.0s · Lease 1.0s · Dispatch 1.0s · Provider 4.0s',
      ),
    ).toBeTruthy();
  });

  it('navigates away from a Main thread that now returns 404', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: '78fc5d1e-e7e9-4d65-a82d-352c89eba992',
        title: 'Morning planning',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockRejectedValue(
      new ApiError(
        "Thread '78fc5d1e-e7e9-4d65-a82d-352c89eba992' not found",
        404,
        'not_found',
      ),
    );

    render(
      <MemoryRouter
        initialEntries={['/app/main/78fc5d1e-e7e9-4d65-a82d-352c89eba992']}
      >
        <Routes>
          <Route
            path="/app/main"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
          <Route
            path="/app/main/:threadId"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Main (Nanoclaw)' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/main'),
    );
    expect(screen.queryByText(/ApiError:/)).toBeNull();
  });

  it('renders inferred thread titles and the shared new-thread affordance', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Cal football recruiting notes',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Cal football recruiting notes',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:00.000Z',
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('button', { name: 'Start new thread' });
    expect(
      screen.getAllByText('Cal football recruiting notes').length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Rename thread' })).toBeTruthy();
  });

  it('strips surrounding quotes when inferring a new Main thread title', async () => {
    listMainThreadsMock.mockResolvedValue([]);
    getMainThreadMock.mockResolvedValue([]);
    postMainMessageMock.mockResolvedValue({
      messageId: 'msg-1',
      threadId: 'thread-main-1',
      runId: 'run-1',
      title: null,
      run: {
        id: 'run-1',
        threadId: 'thread-main-1',
        status: 'queued',
        createdAt: '2026-03-18T12:00:00.000Z',
        startedAt: null,
        endedAt: null,
        triggerMessageId: 'msg-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: null,
      },
    });

    render(
      <MemoryRouter initialEntries={['/app/main']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Main (Nanoclaw)' });
    fireEvent.change(screen.getByPlaceholderText('Message Nanoclaw…'), {
      target: { value: '"Cal football recruiting notes"' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(
        screen.getAllByText('Cal football recruiting notes')[0],
      ).toBeTruthy(),
    );
    expect(screen.queryByText('"Cal football recruiting notes"')).toBeNull();
  });

  it('opens edit history from /edit and deletes selected Main thread messages', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => true));
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Planning',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:02.000Z',
        messageCount: 3,
        hasActiveRun: false,
      },
    ]);
    const initialMessages = [
      {
        id: 'msg-1',
        threadId: 'thread-main-1',
        role: 'user' as const,
        content: 'Old main prompt',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:00.000Z',
      },
      {
        id: 'msg-2',
        threadId: 'thread-main-1',
        role: 'assistant' as const,
        content: 'Old main answer',
        agentId: null,
        createdBy: null,
        createdAt: '2026-03-18T12:00:01.000Z',
      },
      {
        id: 'msg-3',
        threadId: 'thread-main-1',
        role: 'user' as const,
        content: 'Keep this latest main note',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:02.000Z',
      },
    ];
    getMainThreadMock
      .mockResolvedValueOnce(initialMessages)
      .mockResolvedValueOnce([initialMessages[2]!]);
    deleteMainMessagesMock.mockResolvedValue({
      threadId: 'thread-main-1',
      deletedCount: 2,
      deletedMessageIds: ['msg-1', 'msg-2'],
      threadDeleted: false,
    });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const composer = await screen.findByPlaceholderText('Message Nanoclaw…');
    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();
    await user.click(screen.getByLabelText(/You.*Old main prompt/i));
    await user.click(screen.getByLabelText(/Nanoclaw.*Old main answer/i));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(deleteMainMessagesMock).toHaveBeenCalledWith({
      threadId: 'thread-main-1',
      messageIds: ['msg-1', 'msg-2'],
    });
    expect(
      await screen.findByText('Deleted 2 messages from this Main thread history.'),
    ).toBeTruthy();
    expect(screen.queryByText('Old main prompt')).toBeNull();
    expect(screen.queryByText('Old main answer')).toBeNull();
    expect(screen.getByText('Keep this latest main note')).toBeTruthy();
  });

  it('keeps Edit history in sync when a stale Main snapshot resolves after deleting messages', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => true));
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Planning',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:02.000Z',
        messageCount: 3,
        hasActiveRun: false,
      },
    ]);
    const initialMessages = [
      {
        id: 'msg-1',
        threadId: 'thread-main-1',
        role: 'user' as const,
        content: 'Old main prompt',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:00.000Z',
      },
      {
        id: 'msg-2',
        threadId: 'thread-main-1',
        role: 'assistant' as const,
        content: 'Old main answer',
        agentId: null,
        createdBy: null,
        createdAt: '2026-03-18T12:00:01.000Z',
      },
      {
        id: 'msg-3',
        threadId: 'thread-main-1',
        role: 'user' as const,
        content: 'Keep this latest main note',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:02.000Z',
      },
    ];
    const staleReplay = createDeferred<typeof initialMessages>();
    getMainThreadMock
      .mockResolvedValueOnce(initialMessages)
      .mockImplementationOnce(() => staleReplay.promise)
      .mockResolvedValueOnce([initialMessages[2]!]);
    deleteMainMessagesMock.mockResolvedValue({
      threadId: 'thread-main-1',
      deletedCount: 2,
      deletedMessageIds: ['msg-1', 'msg-2'],
      threadDeleted: false,
    });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const composer = await screen.findByPlaceholderText('Message Nanoclaw…');
    const streamCallbacks = (
      openMainStreamMock.mock.calls as unknown as Array<[MainStreamCallbacks]>
    )[0]?.[0];
    expect(streamCallbacks).toBeTruthy();

    streamCallbacks?.onReplayGap?.();

    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();

    await user.click(screen.getByLabelText(/You.*Old main prompt/i));
    await user.click(screen.getByLabelText(/Nanoclaw.*Old main answer/i));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(
      await screen.findByText('Deleted 2 messages from this Main thread history.'),
    ).toBeTruthy();

    staleReplay.resolve(initialMessages);
    await waitFor(() => {
      expect(screen.queryByText('Old main prompt')).toBeNull();
      expect(screen.queryByText('Old main answer')).toBeNull();
    });

    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Edit history' });
    expect(within(dialog).queryByText('Old main prompt')).toBeNull();
    expect(within(dialog).queryByText('Old main answer')).toBeNull();
    expect(within(dialog).getByText('Keep this latest main note')).toBeTruthy();
  });

  it('removes persisted failed run cards when their trigger messages are deleted from Main history', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => true));
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Planning',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:02.000Z',
        messageCount: 2,
        hasActiveRun: false,
      },
    ]);
    const initialMessages = [
      {
        id: 'msg-1',
        threadId: 'thread-main-1',
        role: 'user' as const,
        content: 'Old main prompt',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:00.000Z',
      },
      {
        id: 'msg-2',
        threadId: 'thread-main-1',
        role: 'user' as const,
        content: 'Keep this latest main note',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:02.000Z',
      },
    ];
    getMainThreadMock
      .mockResolvedValueOnce(initialMessages)
      .mockResolvedValueOnce([initialMessages[1]!]);
    listMainRunsMock
      .mockResolvedValueOnce([
      {
        id: 'run-main-1',
        threadId: 'thread-main-1',
        status: 'failed',
        createdAt: '2026-03-18T12:00:01.000Z',
        startedAt: '2026-03-18T12:00:01.000Z',
        endedAt: '2026-03-18T12:00:01.500Z',
        triggerMessageId: 'msg-1',
        targetAgentId: null,
        cancelReason: 'execution_failed',
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: 'Checking LinkedIn…',
        browserBlock: null,
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: null,
        streamedTextPreview: null,
        lastProgressMessage: null,
        lastHeartbeatAt: '2026-03-18T12:00:01.500Z',
        terminalSummary: {
          statusLabel: 'Failed',
          body: 'Anthropic API error: Unauthorized',
        },
      },
      ])
      .mockResolvedValueOnce([]);
    deleteMainMessagesMock.mockResolvedValue({
      threadId: 'thread-main-1',
      deletedCount: 1,
      deletedMessageIds: ['msg-1'],
      threadDeleted: false,
    });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('Anthropic API error: Unauthorized'),
    ).toBeTruthy();

    const composer = await screen.findByPlaceholderText('Message Nanoclaw…');
    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();

    await user.click(screen.getByLabelText(/You.*Old main prompt/i));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(
      await screen.findByText('Deleted 1 message from this Main thread history.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('Old main prompt')).toBeNull();
      expect(screen.queryByText('Anthropic API error: Unauthorized')).toBeNull();
    });
    expect(screen.getByText('Keep this latest main note')).toBeTruthy();
  });

  it('shows pending copy in the thread sidebar when a thread is still responding', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Capabilities',
        isPinned: false,
        lastMessageAt: isoOffset(-5_000),
        messageCount: 2,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-1',
        threadId: 'thread-main-1',
        status: 'running',
        createdAt: isoOffset(-4_000),
        startedAt: isoOffset(-3_000),
        endedAt: null,
        triggerMessageId: 'msg-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: null,
        lastHeartbeatAt: isoOffset(-1_000),
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const threadRail = screen.getByLabelText('Threads');
    await within(threadRail).findByText('Capabilities');
    expect(within(threadRail).getByText('* Working…')).toBeTruthy();
  });

  it('renders a generic in-thread status card for active Main runs before streaming starts', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: isoOffset(-5_000),
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Try to access my LinkedIn again.',
        agentId: null,
        createdBy: 'user-1',
        createdAt: isoOffset(-5_000),
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-1',
        threadId: 'thread-main-1',
        status: 'running',
        createdAt: isoOffset(-4_000),
        startedAt: isoOffset(-4_000),
        endedAt: null,
        triggerMessageId: 'msg-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: null,
        browserBlock: null,
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: null,
        lastHeartbeatAt: isoOffset(-1_000),
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Try to access my LinkedIn again.');
    expect(screen.getByText(/Run in progress/)).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
  });

  it('renders blocked browser runs in the Main timeline and starts setup from the inline card', async () => {
    const user = userEvent.setup();
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-browser',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: '2026-03-20T20:20:00.000Z',
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-browser',
        role: 'user',
        content: 'Check my LinkedIn inbox',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-20T20:20:00.000Z',
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-browser',
        threadId: 'thread-main-browser',
        status: 'awaiting_confirmation',
        createdAt: '2026-03-20T20:20:01.000Z',
        startedAt: '2026-03-20T20:20:03.000Z',
        endedAt: null,
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'LinkedIn needs you to sign in.',
        browserBlock: {
          kind: 'auth_required',
          sessionId: 'session-1',
          siteKey: 'linkedin',
          accountLabel: null,
          url: 'https://www.linkedin.com/login',
          title: 'LinkedIn Login',
          message: 'LinkedIn needs interactive login before the run can continue.',
          riskReason: null,
          setupCommand: 'npx tsx src/clawrocket/browser/setup.ts --site linkedin',
          artifacts: [],
          confirmationId: null,
          pendingToolCall: {
            toolName: 'browser_open',
            args: {},
          },
          createdAt: '2026-03-20T20:20:04.000Z',
          updatedAt: '2026-03-20T20:20:04.000Z',
        },
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: {
          backend: 'direct_http',
          authPath: 'subscription',
          credentialSource: 'oauth_token',
          plannerReason: 'Browser stayed in the direct Main parent.',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        },
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-browser']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Browser authentication required');
    expect(screen.getByText('LinkedIn needs interactive login before the run can continue.')).toBeTruthy();

    await user.click(
      screen.getByRole('button', { name: 'Authenticate browser' }),
    );

    await waitFor(() =>
      expect(startBrowserSetupSessionMock).toHaveBeenCalledWith({
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/login',
      }),
    );
    expect(screen.getByText('Browser setup session opened.')).toBeTruthy();
  });

  it('tells the user to check their phone when LinkedIn is waiting for app approval', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-phone-approval',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: '2026-03-20T20:20:00.000Z',
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-phone-1',
        threadId: 'thread-main-phone-approval',
        role: 'user',
        content: 'Check my LinkedIn inbox',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-20T20:20:00.000Z',
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-phone-approval',
        threadId: 'thread-main-phone-approval',
        status: 'awaiting_confirmation',
        createdAt: '2026-03-20T20:20:01.000Z',
        startedAt: '2026-03-20T20:20:03.000Z',
        endedAt: null,
        triggerMessageId: 'msg-main-phone-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'LinkedIn is waiting for phone approval.',
        browserBlock: {
          kind: 'auth_required',
          sessionId: 'session-phone-1',
          siteKey: 'linkedin',
          accountLabel: null,
          url: 'https://www.linkedin.com/checkpoint/challenge',
          title: 'LinkedIn Security Check',
          message:
            'LinkedIn is waiting for phone or app approval on a trusted device.',
          riskReason: null,
          setupCommand: null,
          artifacts: [],
          confirmationId: null,
          pendingToolCall: {
            toolName: 'browser_open',
            args: {},
          },
          createdAt: '2026-03-20T20:20:04.000Z',
          updatedAt: '2026-03-20T20:20:04.000Z',
        },
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: {
          backend: 'container',
          authPath: 'subscription',
          credentialSource: 'oauth_token',
          plannerReason: 'Browser uses the container-backed Main path.',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        },
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-phone-approval']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Approve sign-in on your phone');
    expect(
      screen.getByText('Check your phone or LinkedIn app now.', {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByText('Check phone approval')).toBeTruthy();
  });

  it('replaces a live thinking response with a blocked browser card when Main receives a browser_blocked event', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-browser',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: '2026-03-20T20:20:00.000Z',
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-browser',
        role: 'user',
        content: 'Check my LinkedIn inbox',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-20T20:20:00.000Z',
      },
    ]);
    listMainRunsMock
      .mockResolvedValueOnce([
        {
          id: 'run-main-browser',
          threadId: 'thread-main-browser',
          status: 'running',
          createdAt: '2026-03-20T20:20:01.000Z',
          startedAt: '2026-03-20T20:20:03.000Z',
          endedAt: null,
          triggerMessageId: 'msg-main-1',
          targetAgentId: null,
          cancelReason: null,
          kind: null,
          parentRunId: null,
          promotionState: null,
          promotionChildRunId: null,
          requestedToolFamilies: ['browser'],
          userVisibleSummary: 'Opening LinkedIn in the browser.',
          browserBlock: null,
          browserResume: null,
          carriedBrowserSessions: [],
          executionDecision: null,
        },
      ])
      .mockResolvedValue([
        {
          id: 'run-main-browser',
          threadId: 'thread-main-browser',
          status: 'awaiting_confirmation',
          createdAt: '2026-03-20T20:20:01.000Z',
          startedAt: '2026-03-20T20:20:03.000Z',
          endedAt: null,
          triggerMessageId: 'msg-main-1',
          targetAgentId: null,
          cancelReason: null,
          kind: null,
          parentRunId: null,
          promotionState: null,
          promotionChildRunId: null,
          requestedToolFamilies: ['browser'],
          userVisibleSummary: 'LinkedIn needs you to sign in.',
          browserBlock: {
            kind: 'auth_required',
            sessionId: 'session-1',
            siteKey: 'linkedin',
            accountLabel: null,
            url: 'https://www.linkedin.com/checkpoint/challenge',
            title: 'Approve sign in',
            message: 'Check your phone and approve sign in to continue.',
            riskReason: null,
            setupCommand:
              'npx tsx src/clawrocket/browser/setup.ts --site linkedin',
            artifacts: [],
            confirmationId: null,
            pendingToolCall: {
              toolName: 'browser_wait',
              args: { conditionType: 'load' },
            },
            createdAt: '2026-03-20T20:20:04.000Z',
            updatedAt: '2026-03-20T20:20:04.000Z',
          },
          browserResume: null,
          carriedBrowserSessions: [],
          executionDecision: {
            backend: 'container',
            authPath: 'subscription',
            credentialSource: 'oauth_token',
            plannerReason: 'Browser ran in the container-backed path.',
            providerId: 'provider.anthropic',
            modelId: 'claude-sonnet-4-6',
          },
        },
      ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-browser']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Check my LinkedIn inbox');
    const streamCallbacks = (
      openMainStreamMock.mock.calls as unknown as Array<[MainStreamCallbacks]>
    )[0]?.[0];
    expect(streamCallbacks).toBeTruthy();

    streamCallbacks?.onResponseStarted?.({
      runId: 'run-main-browser',
      threadId: 'thread-main-browser',
      agentId: 'agent-claude',
      agentName: 'Sonnet Heavy',
    });

    streamCallbacks?.onBrowserBlocked?.({
      runId: 'run-main-browser',
      talkId: null,
      threadId: 'thread-main-browser',
      browserBlock: {
        kind: 'auth_required',
      },
    });

    expect(
      await screen.findByText('Approve sign-in on your phone'),
    ).toBeTruthy();
    expect(
      screen.getByText('Check your phone and approve sign in to continue.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume run' })).toBeTruthy();
  });

  it('renders browser-blocked Main runs directly from persisted run records', async () => {
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({ browserEnabled: true }),
    );
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-browser',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: isoOffset(-10_000),
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-browser',
        role: 'user',
        content: 'Check my LinkedIn inbox',
        agentId: null,
        createdBy: 'user-1',
        createdAt: isoOffset(-10_000),
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-browser',
        threadId: 'thread-main-browser',
        status: 'awaiting_confirmation',
        createdAt: isoOffset(-9_000),
        startedAt: isoOffset(-8_000),
        endedAt: null,
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'LinkedIn needs you to sign in.',
        browserBlock: {
          kind: 'auth_required',
          sessionId: 'session-1',
          siteKey: 'linkedin',
          accountLabel: null,
          url: 'https://www.linkedin.com/checkpoint/challenge',
          title: 'Approve sign in',
          message: 'Check your phone and approve sign in to continue.',
          riskReason: null,
          setupCommand:
            'npx tsx src/clawrocket/browser/setup.ts --site linkedin',
          artifacts: [],
          confirmationId: null,
          pendingToolCall: {
            toolName: 'browser_wait',
            args: { conditionType: 'load' },
          },
          createdAt: isoOffset(-7_000),
          updatedAt: isoOffset(-7_000),
        },
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: {
          backend: 'container',
          authPath: 'subscription',
          credentialSource: 'oauth_token',
          plannerReason: 'Browser ran in the container-backed path.',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        },
        lastHeartbeatAt: isoOffset(-1_000),
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-browser']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Check my LinkedIn inbox')).toBeTruthy();
    expect(screen.getByText('Approve sign-in on your phone')).toBeTruthy();
    expect(
      screen.getByText('Check your phone and approve sign in to continue.'),
    ).toBeTruthy();
  });

  it('automatically resumes a blocked browser run once session status becomes active', async () => {
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({ browserEnabled: true }),
    );
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-browser',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: isoOffset(-10_000),
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-browser',
        role: 'user',
        content: 'Check my LinkedIn inbox',
        agentId: null,
        createdBy: 'user-1',
        createdAt: isoOffset(-10_000),
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-browser',
        threadId: 'thread-main-browser',
        status: 'awaiting_confirmation',
        createdAt: isoOffset(-9_000),
        startedAt: isoOffset(-8_000),
        endedAt: null,
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'LinkedIn needs you to sign in.',
        browserBlock: {
          kind: 'auth_required',
          sessionId: 'session-1',
          siteKey: 'linkedin',
          accountLabel: null,
          url: 'https://www.linkedin.com/checkpoint/challenge',
          title: 'Approve sign in',
          message: 'Check your phone and approve sign in to continue.',
          riskReason: null,
          setupCommand:
            'npx tsx src/clawrocket/browser/setup.ts --site linkedin',
          artifacts: [],
          confirmationId: null,
          pendingToolCall: null,
          createdAt: isoOffset(-7_000),
          updatedAt: isoOffset(-7_000),
        },
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: null,
        lastHeartbeatAt: isoOffset(-1_000),
      },
    ]);
    getBrowserSessionStatusMock
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        headed: false,
        state: 'active',
        owner: 'agent',
        blockedKind: null,
        blockedMessage: null,
        currentUrl: 'https://www.linkedin.com/feed/',
        currentTitle: 'LinkedIn',
        lastUpdatedAt: '2026-03-20T20:25:00.000Z',
      });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-browser']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('Approve sign-in on your phone'),
    ).toBeTruthy();

    await waitFor(() =>
      expect(resumeBrowserBlockedRunMock).toHaveBeenCalledWith({
        runId: 'run-main-browser',
        note: 'auto_resumed_after_browser_status_check',
      }),
    );
    expect(getBrowserSessionStatusMock).toHaveBeenCalledWith('session-1');
  });

  it('renders deferred resume state for paused runs that are waiting on another task', async () => {
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({ browserEnabled: true }),
    );
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-browser',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: isoOffset(-10_000),
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-browser',
        role: 'user',
        content: 'Check my LinkedIn inbox',
        agentId: null,
        createdBy: 'user-1',
        createdAt: isoOffset(-10_000),
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-browser',
        threadId: 'thread-main-browser',
        status: 'awaiting_confirmation',
        createdAt: isoOffset(-9_000),
        startedAt: isoOffset(-8_000),
        endedAt: null,
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'LinkedIn needs you to sign in.',
        browserBlock: {
          kind: 'auth_required',
          sessionId: 'session-1',
          siteKey: 'linkedin',
          accountLabel: null,
          url: 'https://www.linkedin.com/checkpoint/challenge',
          title: 'Approve sign in',
          message: 'Check your phone and approve sign in to continue.',
          riskReason: null,
          setupCommand: null,
          artifacts: [],
          confirmationId: null,
          pendingToolCall: null,
          createdAt: isoOffset(-7_000),
          updatedAt: isoOffset(-7_000),
        },
        browserResume: {
          kind: 'auth_completed',
          resumedAt: isoOffset(-2_000),
          resumedBy: 'user-1',
          sessionId: 'session-1',
          confirmationId: null,
          note: null,
          pendingToolCall: null,
        },
        carriedBrowserSessions: [],
        executionDecision: null,
        lastHeartbeatAt: isoOffset(-1_000),
        resumeRequestedAt: isoOffset(-2_000),
        resumeRequestedBy: 'user-1',
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-browser']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('Resume requested. This run will continue automatically when the current task finishes.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume requested' })).toBeDisabled();
    expect(screen.getAllByText('Resume requested').length).toBeGreaterThan(0);
  });

  it('renders session-conflict actions and cancels the conflicting run from the card', async () => {
    const user = userEvent.setup();
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({ browserEnabled: true }),
    );
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-browser',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: isoOffset(-10_000),
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-browser',
        role: 'user',
        content: 'Check my LinkedIn inbox',
        agentId: null,
        createdBy: 'user-1',
        createdAt: isoOffset(-10_000),
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-browser',
        threadId: 'thread-main-browser',
        status: 'awaiting_confirmation',
        createdAt: isoOffset(-9_000),
        startedAt: isoOffset(-8_000),
        endedAt: null,
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'Check my LinkedIn inbox',
        browserBlock: {
          kind: 'session_conflict',
          sessionId: 'session-1',
          siteKey: 'linkedin',
          accountLabel: null,
          conflictingRunId: 'run-owner',
          conflictingSessionId: 'session-1',
          conflictingRunSummary: 'Existing LinkedIn auth task',
          url: 'https://www.linkedin.com/checkpoint/challenge',
          title: 'Approve sign in',
          message: 'Another paused browser task already owns the linkedin session. Resolve that task before this run can continue.',
          riskReason: 'session_conflict',
          setupCommand: null,
          artifacts: [],
          confirmationId: null,
          pendingToolCall: null,
          createdAt: isoOffset(-7_000),
          updatedAt: isoOffset(-7_000),
        },
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: null,
        lastHeartbeatAt: isoOffset(-1_000),
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-browser']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('Browser session already in use'),
    ).toBeTruthy();
    expect(screen.getByText('Existing LinkedIn auth task')).toBeTruthy();

    await user.click(
      screen.getByRole('button', {
        name: 'Cancel existing task and retry this run',
      }),
    );

    await waitFor(() =>
      expect(cancelConflictingBrowserRunMock).toHaveBeenCalledWith({
        runId: 'run-main-browser',
      }),
    );
    expect(
      screen.getByText(
        'The conflicting browser task was cancelled and this run is queued.',
      ),
    ).toBeTruthy();
  });

  it('clears a stalled run when a heartbeat event arrives', async () => {
    getMainRegisteredAgentMock.mockResolvedValue(
      buildMainAgentSnapshot({ browserEnabled: false }),
    );
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-stalled',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: isoOffset(-10_000),
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-stalled',
        role: 'user',
        content: 'Check LinkedIn',
        agentId: null,
        createdBy: 'user-1',
        createdAt: isoOffset(-40_000),
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-stalled',
        threadId: 'thread-main-stalled',
        status: 'running',
        createdAt: isoOffset(-40_000),
        startedAt: isoOffset(-39_000),
        endedAt: null,
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: 'Checking LinkedIn…',
        browserBlock: null,
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: null,
        lastHeartbeatAt: isoOffset(-35_000),
        streamedTextPreview: null,
        lastProgressMessage: null,
        terminalSummary: null,
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-stalled']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Stalled')).toBeTruthy();
    const streamCallbacks = (
      openMainStreamMock.mock.calls as unknown as Array<[MainStreamCallbacks]>
    )[0]?.[0];
    expect(streamCallbacks).toBeTruthy();

    act(() => {
      streamCallbacks?.onHeartbeat?.({
        runId: 'run-main-stalled',
        threadId: 'thread-main-stalled',
        at: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('Stalled')).toBeNull();
    });
    expect(screen.getByText('Working')).toBeTruthy();
  });

  it('renders persisted failed Main runs when the live response bubble is no longer present', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: '2026-03-21T16:04:27.000Z',
        messageCount: 1,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Try LinkedIn again.',
        runId: null,
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-21T16:04:27.000Z',
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-1',
        threadId: 'thread-main-1',
        status: 'failed',
        createdAt: '2026-03-21T16:04:27.000Z',
        startedAt: '2026-03-21T16:04:28.000Z',
        endedAt: '2026-03-21T16:04:41.000Z',
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: 'execution_failed: LinkedIn blocked the browser session.',
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'Checking LinkedIn…',
        executionDecision: {
          backend: 'container',
          authPath: 'subscription',
          credentialSource: 'oauth_token',
          plannerReason: 'Browser-enabled Main run stayed local.',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        },
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('LinkedIn blocked the browser session.');
    expect(screen.getByText(/Execution:/)).toBeTruthy();
    expect(
      screen.getByText('Browser-enabled Main run stayed local.'),
    ).toBeTruthy();
  });

  it('does not render superseded cancellation cards for older Main runs', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: '2026-03-21T16:04:27.000Z',
        messageCount: 1,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Try LinkedIn again.',
        runId: null,
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-21T16:04:27.000Z',
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-1',
        threadId: 'thread-main-1',
        status: 'cancelled',
        createdAt: '2026-03-21T16:04:27.000Z',
        startedAt: '2026-03-21T16:04:28.000Z',
        endedAt: '2026-03-21T16:04:29.000Z',
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: 'superseded_by_new_user_message',
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'Checking LinkedIn…',
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Try LinkedIn again.');
    expect(screen.queryByText('Cancelled')).toBeNull();
    expect(
      screen.queryByText(/Run cancelled: superseded_by_new_user_message/i),
    ).toBeNull();
  });

  it('opens a right-click menu and renames a thread inline', async () => {
    const user = userEvent.setup();
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Capabilities',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockResolvedValue([]);
    updateMainThreadMock.mockResolvedValue({
      threadId: 'thread-main-1',
      title: 'Planning',
      isPinned: false,
    });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route path="/app/main" element={<MainChannelPage onUnauthorized={vi.fn()} />} />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const threadRail = screen.getByLabelText('Threads');
    await within(threadRail).findByText('Capabilities');
    fireEvent.contextMenu(within(threadRail).getByText('Capabilities'));

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename thread' });
    await user.clear(input);
    await user.type(input, 'Planning{Enter}');

    await waitFor(() => {
      expect(screen.getAllByText('Planning').length).toBeGreaterThan(0);
    });
    expect(updateMainThreadMock).toHaveBeenCalledWith({
      threadId: 'thread-main-1',
      title: 'Planning',
    });
  });

  it('pins a thread and reorders pinned threads first', async () => {
    const user = userEvent.setup();
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Older',
        isPinned: false,
        lastMessageAt: '2026-03-18T11:00:00.000Z',
        messageCount: 2,
        hasActiveRun: false,
      },
      {
        threadId: 'thread-main-2',
        title: 'Newer',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 3,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockResolvedValue([]);
    updateMainThreadMock.mockResolvedValue({
      threadId: 'thread-main-1',
      title: 'Older',
      isPinned: true,
    });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-2']}>
        <Routes>
          <Route path="/app/main" element={<MainChannelPage onUnauthorized={vi.fn()} />} />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Older');
    const olderThread = screen
      .getAllByRole('button')
      .find(
        (button) =>
          button.className.includes('main-thread-item') &&
          within(button).queryByText('Older'),
      );
    expect(olderThread).toBeTruthy();
    fireEvent.contextMenu(olderThread!, { clientX: 24, clientY: 36 });
    await user.click(screen.getByRole('menuitem', { name: 'Pin' }));

    await waitFor(() => {
      const items = screen
        .getAllByRole('button')
        .filter((button) =>
          button.className.includes('main-thread-item'),
        );
      expect(within(items[0]!).getByText('Older')).toBeTruthy();
    });
    expect(updateMainThreadMock).toHaveBeenCalledWith({
      threadId: 'thread-main-1',
      pinned: true,
    });
  });

  it('deletes a thread after confirmation and navigates to the next thread', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => true));
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Keep me',
        isPinned: false,
        lastMessageAt: '2026-03-18T11:00:00.000Z',
        messageCount: 1,
        hasActiveRun: false,
      },
      {
        threadId: 'thread-main-2',
        title: 'Delete me',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockResolvedValue([]);
    deleteMainThreadMock.mockResolvedValue(undefined);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-2']}>
        <Routes>
          <Route
            path="/app/main"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
          <Route
            path="/app/main/:threadId"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const threadRail = screen.getByLabelText('Threads');
    await within(threadRail).findByText('Delete me');
    const deleteThreadButton = within(threadRail)
      .getAllByRole('button')
      .find(
        (button) =>
          button.className.includes('main-thread-item') &&
          within(button).queryByText('Delete me'),
      );
    expect(deleteThreadButton).toBeTruthy();
    fireEvent.contextMenu(deleteThreadButton!, { clientX: 24, clientY: 36 });
    await user.click(screen.getByRole('menuitem', { name: 'Delete thread' }));

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/app/main/thread-main-1',
      ),
    );
    expect(deleteMainThreadMock).toHaveBeenCalledWith('thread-main-2');
    expect(
      within(threadRail).queryByText('Delete me'),
    ).toBeNull();
  });
});

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}
