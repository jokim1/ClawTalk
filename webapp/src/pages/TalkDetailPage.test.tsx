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
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { TalkDetailPage } from './TalkDetailPage';
import { openTalkStream } from '../lib/talkStream';
import type {
  AiAgentsPageData,
  ChannelConnection,
  ChannelQueueFailure,
  ChannelTarget,
  Content,
  ContentSidebarItem,
  ContextRule,
  ContextSource,
  TalkContext,
  DataConnector,
  Talk,
  TalkAgent,
  TalkChannelBinding,
  TalkDataConnector,
  TalkMessage,
  TalkMessageAttachment,
  TalkRun,
  TalkRunContextSnapshot,
  TalkJob,
  TalkJobRunSummary,
  TalkStateEntry,
  TalkThread,
  RegisteredAgent,
} from '../lib/api';

const ORCHESTRATION_MODE_TOOLTIP =
  'Ordered is turn based synthesis focused multi-agent response. Parallel is fast independent response.';

vi.mock('../lib/talkStream', () => ({
  openTalkStream: vi.fn(),
}));

// CodeMirror's contentEditable can't drive in jsdom — swap it for a
// textarea so the lazy-loaded HtmlSourceEditor renders synchronously
// in tests and we can drive its onChange via fireEvent.change.
vi.mock('@uiw/react-codemirror', async () => {
  const { forwardRef } = await import('react');
  const FakeCodeMirror = forwardRef<
    HTMLTextAreaElement,
    {
      value?: string;
      onChange?: (next: string) => void;
      placeholder?: string;
      editable?: boolean;
      readOnly?: boolean;
    }
  >(function FakeCodeMirror(props, ref) {
    return (
      <textarea
        ref={ref}
        data-testid="cm-textarea"
        value={props.value ?? ''}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        disabled={props.editable === false}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    );
  });
  return {
    default: FakeCodeMirror,
    EditorView: {
      lineWrapping: { extension: 'mock-lineWrapping' },
    },
  };
});

vi.mock('@codemirror/lang-html', () => ({
  html: () => ({ extension: 'mock-lang-html' }),
}));

vi.mock('@codemirror/view', () => ({
  EditorView: {
    lineWrapping: { extension: 'mock-lineWrapping' },
  },
}));

type StreamCallbacks = Parameters<typeof openTalkStream>[0];
type SavedTalkAgentRequest = {
  agents: TalkAgent[];
};

const DEFAULT_THREAD_ID = 'thread-default';

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

function mockTextareaMetrics(input: {
  offsetHeight: number;
  scrollHeight: number;
}): {
  setScrollHeight: (nextHeight: number) => void;
  restore: () => void;
} {
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'offsetHeight',
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'scrollHeight',
  );
  let currentScrollHeight = input.scrollHeight;

  Object.defineProperty(HTMLTextAreaElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => input.offsetHeight,
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => currentScrollHeight,
  });

  return {
    setScrollHeight(nextHeight: number) {
      currentScrollHeight = nextHeight;
    },
    restore() {
      if (originalOffsetHeight) {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          'offsetHeight',
          originalOffsetHeight,
        );
      } else {
        Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'offsetHeight');
      }
      if (originalScrollHeight) {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          'scrollHeight',
          originalScrollHeight,
        );
      } else {
        Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
      }
    },
  };
}

describe('TalkDetailPage', () => {
  const openTalkStreamMock = vi.mocked(openTalkStream);
  let streamInput: StreamCallbacks | null = null;

  beforeEach(() => {
    document.cookie = 'cr_csrf_token=test-csrf-token';
    streamInput = null;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:preview-image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    openTalkStreamMock.mockImplementation((input) => {
      streamInput = input;
      return {
        close: vi.fn(),
      };
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    document.cookie = 'cr_csrf_token=; Max-Age=0; path=/';
  });

  it('defaults to the Talk tab, shows the status strip, and preserves the stream across tab switches', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1');

    await screen.findByRole('heading', { name: /Cal Football/i });
    const timeline = screen.getByLabelText('Talk timeline');
    expect(timeline).toBeTruthy();
    expect(timeline.querySelector('.talk-thread-detail-header')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull();
    const statusPills = screen.getByRole('list', { name: 'Talk agent status' });
    expect(
      within(statusPills).getByText('Claude Sonnet 4.6 (General)'),
    ).toBeTruthy();
    expect(within(statusPills).getByText('GPT-5 Mini (Critic)')).toBeTruthy();
    expect(within(statusPills).getByText('Primary')).toBeTruthy();
    expect(
      within(statusPills).getByText('Claude Sonnet 4.6 (General)').parentElement
        ?.className,
    ).toContain('talk-status-pill-ready');
    expect(
      within(statusPills).getByText('GPT-5 Mini (Critic)').parentElement
        ?.className,
    ).toContain('talk-status-pill-invalid');
    const responseModeButton = screen.getByRole('button', {
      name: /Response mode, Ordered/i,
    });
    expect(responseModeButton).toBeTruthy();
    expect(responseModeButton).toHaveAttribute(
      'title',
      ORCHESTRATION_MODE_TOOLTIP,
    );
    const composerMeta = screen
      .getByText('Only the selected agent will respond.')
      .closest('.composer-meta-row') as HTMLElement | null;
    expect(composerMeta).toBeTruthy();
    expect(within(composerMeta!).getByText('0/20000')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeTruthy();

    const tabs = within(
      screen.getByRole('navigation', { name: 'Talk sections' }),
    );
    await user.click(tabs.getByRole('link', { name: 'Agents' }));
    await screen.findByRole('heading', { name: 'Agents' });
    expect(screen.getByLabelText('Talk agents')).toBeTruthy();

    await user.click(tabs.getByRole('link', { name: 'Run History' }));
    await screen.findByRole('heading', { name: 'Run History' });
    expect(screen.getByText('run-1')).toBeTruthy();
    expect(screen.getByText('Agent: GPT-5 Mini')).toBeTruthy();

    await user.click(tabs.getByRole('link', { name: 'Talk' }));
    await screen.findByPlaceholderText('Send a message to this thread');

    expect(openTalkStreamMock).toHaveBeenCalledTimes(1);
  });

  it('renders blocked browser runs in the Talk timeline and approves confirmation inline', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-browser-1',
          role: 'user',
          content: 'Check my LinkedIn messages.',
          createdAt: '2026-03-20T20:30:00.000Z',
        }),
      ],
      runs: [
        buildRun({
          id: 'run-browser-confirm',
          status: 'awaiting_confirmation',
          createdAt: '2026-03-20T20:30:01.000Z',
          startedAt: '2026-03-20T20:30:02.000Z',
          triggerMessageId: 'msg-browser-1',
          targetAgentNickname: 'Claude Sonnet 4.6',
          browserBlock: {
            kind: 'confirmation_required',
            sessionId: 'session-browser-1',
            siteKey: 'linkedin',
            accountLabel: null,
            url: 'https://www.linkedin.com/messaging/',
            title: 'LinkedIn Messaging',
            message: 'This browser action will send a real message.',
            riskReason: 'send button',
            setupCommand: null,
            artifacts: [],
            confirmationId: 'confirmation-browser-1',
            pendingToolCall: {
              toolName: 'browser_act',
              args: { action: 'click' },
            },
            createdAt: '2026-03-20T20:30:03.000Z',
            updatedAt: '2026-03-20T20:30:03.000Z',
          },
          executionDecision: {
            backend: 'container',
            authPath: 'subscription',
            credentialSource: 'oauth_token',
            routeReason: 'normal',
            plannerReason: 'Browser ran in the container-backed path.',
            providerId: 'provider.anthropic',
            modelId: 'claude-sonnet-4-6',
          },
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByText('Browser approval required');
    expect(
      screen.getByText('This browser action will send a real message.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Browser ran in the container-backed path.'),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Approve action' }));

    await waitFor(() =>
      expect(screen.queryByText('Browser approval required')).toBeNull(),
    );
  });

  it.skip('resyncs the Talk timeline when a running browser task becomes blocked mid-stream', async () => {
    const runs = [
      buildRun({
        id: 'run-browser-live',
        status: 'running',
        createdAt: '2026-03-20T20:30:01.000Z',
        startedAt: '2026-03-20T20:30:02.000Z',
        triggerMessageId: 'msg-browser-1',
        targetAgentNickname: 'Claude Sonnet 4.6',
      }),
    ];

    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-browser-1',
          role: 'user',
          content: 'Check my LinkedIn messages.',
          createdAt: '2026-03-20T20:30:00.000Z',
        }),
      ],
      runs,
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByText('Check my LinkedIn messages.');
    streamInput?.onResponseStarted?.({
      talkId: 'talk-1',
      threadId: DEFAULT_THREAD_ID,
      runId: 'run-browser-live',
      agentId: 'agent-claude',
      agentNickname: 'Claude Sonnet 4.6',
    });

    runs.splice(
      0,
      runs.length,
      buildRun({
        id: 'run-browser-live',
        status: 'awaiting_confirmation',
        createdAt: '2026-03-20T20:30:01.000Z',
        startedAt: '2026-03-20T20:30:02.000Z',
        triggerMessageId: 'msg-browser-1',
        targetAgentNickname: 'Claude Sonnet 4.6',
        browserBlock: {
          kind: 'auth_required',
          sessionId: 'session-browser-live',
          siteKey: 'linkedin',
          accountLabel: null,
          url: 'https://www.linkedin.com/checkpoint/challenge',
          title: 'Approve sign in',
          message: 'Check your phone and approve sign in to continue.',
          riskReason: null,
          setupCommand: null,
          artifacts: [],
          confirmationId: null,
          pendingToolCall: {
            toolName: 'browser_wait',
            args: { conditionType: 'load' },
          },
          createdAt: '2026-03-20T20:30:03.000Z',
          updatedAt: '2026-03-20T20:30:03.000Z',
        },
      }),
    );

    streamInput?.onBrowserBlocked?.({
      talkId: 'talk-1',
      threadId: DEFAULT_THREAD_ID,
      runId: 'run-browser-live',
      browserBlock: {
        kind: 'auth_required',
        sessionId: 'session-browser-live',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/checkpoint/challenge',
        title: 'Approve sign in',
        message: 'Check your phone and approve sign in to continue.',
        riskReason: null,
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: {
          toolName: 'browser_wait',
          args: { conditionType: 'load' },
        },
        createdAt: '2026-03-20T20:30:03.000Z',
        updatedAt: '2026-03-20T20:30:03.000Z',
      },
    });

    expect(
      await screen.findByText('Browser authentication required'),
    ).toBeTruthy();
    expect(
      screen.getByText('Check your phone and approve sign in to continue.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume run' })).toBeTruthy();
  });

  it('hides the response-mode selector until the talk has at least two assigned agents', async () => {
    installTalkDetailFetch({
      messages: [],
      runs: [],
      talkAgents: [
        buildTalkAgent({
          id: 'agent-claude',
          nickname: 'Claude Sonnet 4.6',
          sourceKind: 'claude_default',
          role: 'assistant',
          isPrimary: true,
          displayOrder: 0,
          health: 'ready',
          providerId: null,
          modelId: 'claude-sonnet-4-6',
          modelDisplayName: 'Claude Sonnet 4.6',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByPlaceholderText('Send a message to this thread');
    expect(screen.queryByRole('button', { name: /Response mode/i })).toBeNull();
  });

  it('uses the shared new-thread button and supports inline thread renaming', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          title: 'Cal recruiting board',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByPlaceholderText('Send a message to this thread');

    const threadRail = await screen.findByLabelText('Talk threads');
    expect(
      within(threadRail).getByRole('button', { name: 'Start new thread' }),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Rename thread' }));
    const input = screen.getByRole('textbox', { name: 'Rename thread' });
    await user.clear(input);
    await user.type(input, 'Daily Cal news{Enter}');

    await waitFor(() => {
      expect(screen.getAllByText('Daily Cal news')).toHaveLength(2);
    });
  });

  it('opens a thread context menu, pins a thread, and reorders it to the top', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          title: 'Default thread',
          isDefault: true,
          lastMessageAt: '2026-03-06T00:00:00.000Z',
        }),
        buildThread({
          id: 'thread-older',
          title: 'Older thread',
          lastMessageAt: '2026-03-06T01:00:00.000Z',
        }),
        buildThread({
          id: 'thread-newer',
          title: 'Newer thread',
          lastMessageAt: '2026-03-06T02:00:00.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    const threadRail = await screen.findByLabelText('Talk threads');
    await within(threadRail).findByText('Older thread');
    const olderThread = within(threadRail)
      .getAllByRole('button')
      .find(
        (button) =>
          button.className.includes('talk-thread-item') &&
          within(button).queryByText('Older thread'),
      );
    expect(olderThread).toBeTruthy();
    fireEvent.mouseDown(olderThread!, { button: 2, clientX: 24, clientY: 36 });
    fireEvent.contextMenu(olderThread!, { clientX: 24, clientY: 36 });
    await user.click(screen.getByRole('menuitem', { name: 'Pin' }));

    await waitFor(() => {
      const items = screen
        .getAllByRole('button')
        .filter((button) => button.className.includes('talk-thread-item'));
      expect(within(items[0]!).getByText('Older thread')).toBeTruthy();
    });
  });

  it('deletes the active thread and falls back to the remaining thread', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          title: 'Default thread',
          isDefault: true,
          lastMessageAt: '2026-03-06T00:00:00.000Z',
        }),
        buildThread({
          id: 'thread-delete',
          title: 'Delete me',
          lastMessageAt: '2026-03-06T02:00:00.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1?thread=thread-delete');

    const threadRail = await screen.findByLabelText('Talk threads');
    await within(threadRail).findByText('Delete me');
    const deleteThreadButton = within(threadRail)
      .getAllByRole('button')
      .find(
        (button) =>
          button.className.includes('talk-thread-item') &&
          within(button).queryByText('Delete me'),
      );
    expect(deleteThreadButton).toBeTruthy();
    fireEvent.mouseDown(deleteThreadButton!, {
      button: 2,
      clientX: 24,
      clientY: 36,
    });
    fireEvent.contextMenu(deleteThreadButton!, { clientX: 24, clientY: 36 });
    await user.click(screen.getByRole('menuitem', { name: 'Delete thread' }));

    await waitFor(() => {
      expect(within(threadRail).queryByText('Delete me')).toBeNull();
    });
    await waitFor(() => {
      expect(within(threadRail).getByText('Default thread')).toBeTruthy();
    });
  });

  it('keeps a thread when delete confirmation is cancelled', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          title: 'Default thread',
          isDefault: true,
        }),
        buildThread({
          id: 'thread-keep',
          title: 'Keep me',
          lastMessageAt: '2026-03-06T02:00:00.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1?thread=thread-keep');

    const threadRail = await screen.findByLabelText('Talk threads');
    await within(threadRail).findByText('Keep me');
    const keepThreadButton = within(threadRail)
      .getAllByRole('button')
      .find(
        (button) =>
          button.className.includes('talk-thread-item') &&
          within(button).queryByText('Keep me'),
      );
    expect(keepThreadButton).toBeTruthy();
    fireEvent.mouseDown(keepThreadButton!, {
      button: 2,
      clientX: 24,
      clientY: 36,
    });
    fireEvent.contextMenu(keepThreadButton!, { clientX: 24, clientY: 36 });
    await user.click(screen.getByRole('menuitem', { name: 'Delete thread' }));

    expect(within(threadRail).getByText('Keep me')).toBeTruthy();
  });

  it('lets users rename the talk from the header and removes legacy header chrome', async () => {
    const user = userEvent.setup();
    const onRenameDraftCommit = vi.fn().mockResolvedValue(undefined);
    installTalkDetailFetch();

    renderDetailPageWithRenameHarness('/app/talks/talk-1', {
      onRenameDraftCommit,
    });

    await screen.findByRole('heading', { name: /Cal Football/i });
    expect(screen.queryByText('Event-authoritative live timeline.')).toBeNull();
    expect(screen.queryByText(/^Live$/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Rename talk title' }));

    const input = screen.getByRole('textbox', { name: 'Talk title' });
    await user.clear(input);
    await user.type(input, 'Golden Bears{Enter}');

    await waitFor(() => {
      expect(onRenameDraftCommit).toHaveBeenCalledWith(
        'talk-1',
        'Golden Bears',
      );
    });
  });

  it('lazily loads and shows the saved context snapshot for an assistant run', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'How will Cal do next season?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Cal should be bowl eligible again.',
          createdAt: '2026-03-06T00:00:03.000Z',
          runId: 'run-1',
          agentId: 'agent-openai',
          agentNickname: 'GPT-5 Mini',
        }),
      ],
      runContextSnapshots: {
        'run-1': {
          version: 1,
          threadId: DEFAULT_THREAD_ID,
          personaRole: 'critic',
          roleHint:
            'Focus on weaknesses, failure modes, and overconfidence in the current plan.',
          goalIncluded: true,
          summaryIncluded: true,
          activeRules: ['Lead with concrete recommendations'],
          stateSnapshot: {
            totalCount: 1,
            omittedCount: 0,
            included: [
              {
                key: 'schedule_strength',
                value: { tier: 'medium' },
                version: 2,
                updatedAt: '2026-03-06T00:00:02.000Z',
                reason: 'state_snapshot',
              },
            ],
          },
          sources: {
            totalCount: 1,
            manifest: [
              {
                ref: 'S1',
                title: '2026 Schedule Notes',
                sourceType: 'text',
                sourceUrl: null,
                fileName: null,
              },
            ],
            inline: [{ ref: 'S1', text: 'Cal returns most of its secondary.' }],
          },
          retrieval: {
            query: 'How will Cal do next season?',
            queryTerms: ['cal', 'season'],
            roleTerms: ['risk', 'weakness'],
            state: [],
            sources: [
              {
                ref: 'S1',
                title: '2026 Schedule Notes',
                excerpt: 'Cal returns most of its secondary.',
              },
            ],
          },
          tools: {
            contextToolNames: ['read_context_source'],
            connectorToolNames: ['google_sheets_query'],
          },
          history: {
            messageIds: ['msg-user-1'],
            turnCount: 1,
          },
          estimatedTokens: 812,
        },
      },
    });

    const originalFetch = globalThis.fetch;
    let contextRequestCount = 0;
    const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method =
        init?.method ??
        (input instanceof Request ? input.method : undefined) ??
        'GET';
      if (
        url.endsWith('/api/v1/talks/talk-1/runs/run-1/context') &&
        method === 'GET'
      ) {
        contextRequestCount += 1;
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = wrappedFetch;

    renderDetailPage('/app/talks/talk-1/runs');

    await screen.findByRole('heading', { name: 'Run History' });
    await user.click(screen.getByRole('button', { name: 'View context' }));

    const contextPanel = await screen.findByLabelText(
      'Context used for run run-1',
    );
    expect(within(contextPanel).getByText(/Estimated context:/)).toBeTruthy();
    expect(within(contextPanel).getByText(/History messages:/)).toBeTruthy();
    expect(
      screen.getByText(
        /Focus on weaknesses, failure modes, and overconfidence/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Lead with concrete recommendations')).toBeTruthy();
    expect(screen.getByText(/schedule_strength/i)).toBeTruthy();
    expect(
      within(contextPanel).getAllByText(/2026 Schedule Notes/).length,
    ).toBeGreaterThan(0);
    expect(contextRequestCount).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Hide context' }));
    await waitFor(() => {
      expect(
        screen.queryByText(
          /Focus on weaknesses, failure modes, and overconfidence/i,
        ),
      ).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'View context' }));
    await screen.findByLabelText('Context used for run run-1');
    expect(contextRequestCount).toBe(1);

    globalThis.fetch = originalFetch;
  });

  it('does not render an inline context button in the Talk timeline', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-user-1',
          role: 'user',
          content: 'How will Cal do next season?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Cal should be bowl eligible again.',
          createdAt: '2026-03-06T00:00:03.000Z',
          runId: 'run-1',
          agentId: 'agent-openai',
          agentNickname: 'GPT-5 Mini',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByText('Cal should be bowl eligible again.');
    expect(screen.queryByRole('button', { name: 'Context used' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View context' })).toBeNull();
  });

  it('shows an empty state when a run has no saved context snapshot', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1/runs');

    await screen.findByRole('heading', { name: 'Run History' });
    await user.click(screen.getByRole('button', { name: 'View context' }));

    const contextPanel = await screen.findByLabelText(
      'Context used for run run-1',
    );
    expect(
      within(contextPanel).getByText(
        'No saved context snapshot is available for this run.',
      ),
    ).toBeTruthy();
  });

  it('shows an inline error when loading run context fails', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch();

    const originalFetch = globalThis.fetch;
    const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method =
        init?.method ??
        (input instanceof Request ? input.method : undefined) ??
        'GET';
      if (
        url.endsWith('/api/v1/talks/talk-1/runs/run-1/context') &&
        method === 'GET'
      ) {
        return jsonResponse(500, {
          ok: false,
          error: {
            code: 'context_fetch_failed',
            message: 'Failed to load context snapshot.',
          },
        });
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = wrappedFetch;

    renderDetailPage('/app/talks/talk-1/runs');

    await screen.findByRole('heading', { name: 'Run History' });
    await user.click(screen.getByRole('button', { name: 'View context' }));

    const contextPanel = await screen.findByLabelText(
      'Context used for run run-1',
    );
    expect(
      within(contextPanel).getByText('Failed to load context snapshot.'),
    ).toBeTruthy();

    globalThis.fetch = originalFetch;
  });

  it('shows the Rules tab badge and persists inline rule edits', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      context: buildTalkContext({
        rules: [
          buildContextRule({
            id: 'rule-1',
            ruleText: 'Use simple language',
            isActive: true,
            sortOrder: 0,
          }),
        ],
      }),
    });

    renderDetailPage('/app/talks/talk-1/rules');

    await screen.findByRole('heading', { name: 'Rules' });
    expect(screen.getByLabelText('1 active rules')).toBeTruthy();

    const input = screen.getByDisplayValue('Use simple language');
    await user.clear(input);
    await user.type(input, 'Lead with concrete recommendations');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Rule updated.')).toBeTruthy();
    expect(
      screen.getByDisplayValue('Lead with concrete recommendations'),
    ).toBeTruthy();
  });

  it('shows an inline error when toggling a rule fails', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      context: buildTalkContext({
        rules: [
          buildContextRule({
            id: 'rule-1',
            ruleText: 'Use simple language',
            isActive: true,
            sortOrder: 0,
          }),
        ],
      }),
      rulePatchError: {
        status: 500,
        code: 'rule_patch_failed',
        message: 'Failed to update rule state.',
      },
    });

    renderDetailPage('/app/talks/talk-1/rules');

    await screen.findByRole('heading', { name: 'Rules' });
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    expect(
      await screen.findByText('Failed to update rule state.'),
    ).toBeTruthy();
  });

  it('shows an inline error when deleting a rule fails', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      context: buildTalkContext({
        rules: [
          buildContextRule({
            id: 'rule-1',
            ruleText: 'Use simple language',
            isActive: true,
            sortOrder: 0,
          }),
        ],
      }),
      ruleDeleteError: {
        status: 500,
        code: 'rule_delete_failed',
        message: 'Failed to delete rule.',
      },
    });

    renderDetailPage('/app/talks/talk-1/rules');

    await screen.findByRole('heading', { name: 'Rules' });
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Failed to delete rule.')).toBeTruthy();
  });

  it('renders read-only Talk state entries from the State tab', async () => {
    installTalkDetailFetch({
      stateEntries: [
        buildTalkStateEntry({
          id: 'state-1',
          key: 'decision',
          value: { winner: 'Claude', confidence: 0.82 },
          version: 3,
          updatedByRunId: 'run-55',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1/state');

    await screen.findByRole('heading', { name: 'State' });
    expect(screen.getByText('decision')).toBeTruthy();
    expect(screen.getByText(/Version 3/i)).toBeTruthy();
    expect(screen.getByText(/run-55/i)).toBeTruthy();
    expect(screen.getByText(/"winner": "Claude"/i)).toBeTruthy();
  });

  it('re-fetches state entries when switching back to the Context tab', async () => {
    const user = userEvent.setup();
    let fetchCount = 0;

    installTalkDetailFetch({
      stateEntries: [
        buildTalkStateEntry({
          id: 'state-a',
          key: 'counter',
          value: 1,
          version: 1,
        }),
      ],
    });

    const originalFetch = globalThis.fetch;
    const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/state') && (init?.method ?? 'GET') === 'GET') {
        fetchCount += 1;
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = wrappedFetch;

    renderDetailPage('/app/talks/talk-1/context');

    await screen.findByRole('heading', { name: 'State' });
    expect(screen.getByText('counter')).toBeTruthy();
    const firstFetchCount = fetchCount;

    const topTabs = within(
      screen.getByRole('navigation', { name: 'Talk sections' }),
    );
    await user.click(topTabs.getByRole('link', { name: 'Talk' }));
    await screen.findByPlaceholderText('Send a message to this thread');

    await user.click(topTabs.getByRole('link', { name: /^Context/ }));
    await screen.findByRole('heading', { name: 'State' });

    expect(fetchCount).toBeGreaterThan(firstFetchCount);

    globalThis.fetch = originalFetch;
  });

  it('Refresh button reloads state entries', async () => {
    const user = userEvent.setup();
    let stateFetchCount = 0;

    installTalkDetailFetch({
      stateEntries: [
        buildTalkStateEntry({
          id: 'state-r',
          key: 'progress',
          value: 'step-1',
          version: 1,
        }),
      ],
    });

    const originalFetch = globalThis.fetch;
    const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method =
        init?.method ??
        (input instanceof Request ? input.method : undefined) ??
        'GET';
      if (url.includes('/api/v1/talks/talk-1/state') && method === 'GET') {
        stateFetchCount += 1;
        if (stateFetchCount >= 2) {
          return jsonResponse(200, {
            ok: true,
            data: {
              entries: [
                buildTalkStateEntry({
                  id: 'state-r',
                  key: 'progress',
                  value: 'step-2',
                  version: 2,
                }),
              ],
            },
          });
        }
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = wrappedFetch;

    renderDetailPage('/app/talks/talk-1/state');

    await screen.findByRole('heading', { name: 'State' });
    expect(screen.getByText('progress')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(screen.getByText(/Version 2/i)).toBeTruthy();
      expect(screen.getByText(/"step-2"/i)).toBeTruthy();
    });
    expect(stateFetchCount).toBeGreaterThan(1);

    globalThis.fetch = originalFetch;
  });

  it('delete button removes a state entry', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch({
      stateEntries: [
        buildTalkStateEntry({
          id: 'state-d1',
          key: 'ephemeral',
          value: 'temp',
          version: 1,
        }),
        buildTalkStateEntry({
          id: 'state-d2',
          key: 'keeper',
          value: 'permanent',
          version: 2,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1/state');

    await screen.findByRole('heading', { name: 'State' });
    expect(screen.getByText('ephemeral')).toBeTruthy();
    expect(screen.getByText('keeper')).toBeTruthy();

    const deleteButtons = screen.getAllByTitle('Delete state entry');
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText('ephemeral')).toBeNull();
    });
    expect(screen.getByText('keeper')).toBeTruthy();
  });

  it('does not delete a state entry when confirmation is cancelled', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );

    installTalkDetailFetch({
      stateEntries: [
        buildTalkStateEntry({
          id: 'state-c1',
          key: 'ephemeral',
          value: 'temp',
          version: 1,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1/state');

    await screen.findByRole('heading', { name: 'State' });
    expect(screen.getByText('ephemeral')).toBeTruthy();

    await user.click(screen.getByTitle('Delete state entry'));

    await waitFor(() => {
      expect(screen.getByText('ephemeral')).toBeTruthy();
    });
  });

  it('shows an error when deleting a state entry fails', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch({
      stateEntries: [
        buildTalkStateEntry({
          id: 'state-f1',
          key: 'ephemeral',
          value: 'temp',
          version: 1,
        }),
      ],
    });

    const originalFetch = globalThis.fetch;
    const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method =
        init?.method ??
        (input instanceof Request ? input.method : undefined) ??
        'GET';
      if (
        url.endsWith('/api/v1/talks/talk-1/state/ephemeral') &&
        method === 'DELETE'
      ) {
        return jsonResponse(500, {
          ok: false,
          error: {
            code: 'server_error',
            message: 'Delete failed.',
          },
        });
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = wrappedFetch;

    renderDetailPage('/app/talks/talk-1/state');

    await screen.findByRole('heading', { name: 'State' });
    expect(screen.getByText('ephemeral')).toBeTruthy();

    await user.click(screen.getByTitle('Delete state entry'));

    await waitFor(() => {
      expect(screen.getByText('Delete failed.')).toBeTruthy();
    });
    expect(screen.getByText('ephemeral')).toBeTruthy();

    globalThis.fetch = originalFetch;
  });

  it('truncates long state values and expands on click', async () => {
    const user = userEvent.setup();
    const longValue = 'x'.repeat(3000);

    installTalkDetailFetch({
      stateEntries: [
        buildTalkStateEntry({
          id: 'state-long',
          key: 'big_data',
          value: longValue,
          version: 1,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1/state');

    await screen.findByRole('heading', { name: 'State' });

    const expandButton = await screen.findByRole('button', {
      name: 'Show full value',
    });
    expect(expandButton).toBeTruthy();

    const pre = screen.getByText(/^"xxxx/);
    expect(pre.textContent!.length).toBeLessThan(longValue.length + 10);

    await user.click(expandButton);

    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('treats awaiting confirmation runs as active rounds on the Talk tab', async () => {
    installTalkDetailFetch({
      runs: [
        buildRun({
          id: 'run-awaiting',
          status: 'awaiting_confirmation',
          createdAt: '2026-03-06T00:00:01.000Z',
          startedAt: '2026-03-06T00:00:02.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByPlaceholderText('Send a message to this thread');
    expect(
      screen.getByText(
        'Wait for the current round to finish or cancel it before sending another message.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'disabled',
    );
    expect(
      screen.getByRole('button', { name: 'Cancel Runs' }),
    ).not.toHaveAttribute('disabled');
  });

  it('switches between ordered and parallel response help text', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      messages: [],
      runs: [],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByPlaceholderText('Send a message to this thread');

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    const refreshedTargetGroup = screen.getByRole('group', {
      name: 'Selected agents',
    });
    await user.click(
      within(refreshedTargetGroup).getByRole('button', {
        name: /GPT-5 Mini \(Critic\)/i,
      }),
    );

    expect(
      screen.getByText(
        'Selected agents will respond in order, with the final response synthesizing earlier perspectives.',
      ),
    ).toBeTruthy();

    await user.click(
      screen.getByRole('button', { name: /Response mode, Ordered/i }),
    );
    await user.click(screen.getByRole('menuitemradio', { name: 'Parallel' }));
    await waitFor(() =>
      expect(
        screen.getByText('Selected agents will each respond independently.'),
      ).toBeTruthy(),
    );
  });

  it('shows live ordered progress for grouped active runs', async () => {
    installTalkDetailFetch({
      runs: [
        buildRun({
          id: 'run-ordered-1',
          status: 'running',
          createdAt: '2026-03-06T00:00:01.000Z',
          startedAt: '2026-03-06T00:00:02.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 0,
        }),
        buildRun({
          id: 'run-ordered-2',
          status: 'queued',
          createdAt: '2026-03-06T00:00:01.100Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-openai',
          targetAgentNickname: 'GPT-5 Mini',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 1,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByPlaceholderText('Send a message to this thread');
    expect(
      screen.getByText('Agent 1 of 2 · Claude Sonnet 4.6 responding…'),
    ).toBeTruthy();
  });

  it('keeps the latest ordered round summary visible after grouped runs finish', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Compare these options.',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-2',
          role: 'assistant',
          content: 'Option A is safer.',
          createdAt: '2026-03-06T00:00:03.000Z',
          runId: 'run-ordered-1',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
        }),
        buildMessage({
          id: 'msg-3',
          role: 'assistant',
          content: 'Option A wins overall.',
          createdAt: '2026-03-06T00:00:05.000Z',
          runId: 'run-ordered-2',
          agentId: 'agent-openai',
          agentNickname: 'GPT-5 Mini',
          metadata: { isSynthesis: true },
        }),
      ],
      runs: [
        buildRun({
          id: 'run-ordered-1',
          status: 'completed',
          createdAt: '2026-03-06T00:00:01.000Z',
          completedAt: '2026-03-06T00:00:03.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 0,
        }),
        buildRun({
          id: 'run-ordered-2',
          status: 'completed',
          createdAt: '2026-03-06T00:00:01.100Z',
          completedAt: '2026-03-06T00:00:05.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-openai',
          targetAgentNickname: 'GPT-5 Mini',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 1,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByText('Option A wins overall.');
    const summary = screen.getByLabelText('Ordered round summary');
    expect(within(summary).getByText('Ordered round finished')).toBeTruthy();
    expect(
      within(summary).getByText(
        'Each agent in the latest ordered round finished and saved a response.',
      ),
    ).toBeTruthy();
    expect(within(summary).getByText('Claude Sonnet 4.6')).toBeTruthy();
    expect(within(summary).getByText('GPT-5 Mini')).toBeTruthy();
    expect(within(summary).getByText('Synthesis')).toBeTruthy();
  });

  it('retries an incomplete ordered agent from the latest round summary', async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn().mockImplementation((body) => ({
      talkId: 'talk-1',
      message: buildMessage({
        id: 'msg-retry-user',
        role: 'user',
        content: body.content,
        createdAt: '2026-03-06T00:00:06.000Z',
      }),
      runs: [
        buildRun({
          id: 'run-retry-agent',
          status: 'queued',
          createdAt: '2026-03-06T00:00:06.100Z',
          triggerMessageId: 'msg-retry-user',
          targetAgentId: body.targetAgentIds[0] ?? null,
          targetAgentNickname: 'GPT-5 Mini',
        }),
      ],
    }));

    installTalkDetailFetch({
      onSendMessage,
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Compare these options.',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-2',
          role: 'assistant',
          content: 'Option A is safer.',
          createdAt: '2026-03-06T00:00:03.000Z',
          runId: 'run-ordered-1',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
        }),
        buildMessage({
          id: 'msg-3',
          role: 'assistant',
          content: 'Option A still wins overall.',
          createdAt: '2026-03-06T00:00:05.000Z',
          runId: 'run-ordered-3',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
          metadata: { isSynthesis: true },
        }),
      ],
      runs: [
        buildRun({
          id: 'run-ordered-1',
          status: 'completed',
          createdAt: '2026-03-06T00:00:01.000Z',
          completedAt: '2026-03-06T00:00:03.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 0,
        }),
        buildRun({
          id: 'run-ordered-2',
          status: 'failed',
          createdAt: '2026-03-06T00:00:01.100Z',
          completedAt: '2026-03-06T00:00:04.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-openai',
          targetAgentNickname: 'GPT-5 Mini',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 1,
          errorCode: 'incomplete_response',
          errorMessage:
            'The model stopped before finishing its answer (provider stop reason: length).',
          providerStopReason: 'length',
          incompleteReason: 'truncated',
          completionStatus: 'incomplete',
        }),
        buildRun({
          id: 'run-ordered-3',
          status: 'completed',
          createdAt: '2026-03-06T00:00:01.200Z',
          completedAt: '2026-03-06T00:00:05.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 2,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    const summary = await screen.findByLabelText('Ordered round summary');
    expect(
      within(summary).getByText('Ordered round finished with a failed step'),
    ).toBeTruthy();
    expect(
      within(summary).getByText(
        'GPT-5 Mini failed, so later agents continued without using its unfinished output.',
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry agent' }));

    expect(onSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Compare these options.',
        targetAgentIds: ['agent-openai'],
      }),
    );
  });

  it('updates nicknames in auto and custom modes and saves talk agents from the Agents tab', async () => {
    const user = userEvent.setup();
    let savedRequest: SavedTalkAgentRequest | undefined;

    installTalkDetailFetch({
      onPutAgents: (body) => {
        savedRequest = body;
        return body.agents.map((agent, index) => ({
          ...agent,
          displayOrder: index,
          health: index === 0 ? 'ready' : 'unknown',
        }));
      },
    });

    renderDetailPage('/app/talks/talk-1/agents');
    await screen.findByRole('heading', { name: 'Agents' });

    const getRegisteredAgentSelects = () =>
      screen.getAllByLabelText('Registered Agent');

    await user.selectOptions(
      getRegisteredAgentSelects()[0],
      'agent-claude-opus',
    );

    const getNicknameInputs = () =>
      screen.getAllByLabelText('Nickname') as HTMLInputElement[];

    expect(getNicknameInputs()[0].value).toBe('Claude Opus 4.6');

    await user.clear(getNicknameInputs()[0]);
    await user.type(getNicknameInputs()[0], 'Coach');
    expect(getNicknameInputs()[0].value).toBe('Coach');

    await user.selectOptions(getRegisteredAgentSelects()[0], 'agent-claude');
    expect(getNicknameInputs()[0].value).toBe('Coach');

    await user.click(screen.getAllByRole('button', { name: 'Reset name' })[0]);
    expect(getNicknameInputs()[0].value).toBe('Claude Sonnet 4.6');

    const roleSelects = screen.getAllByLabelText('Role');
    await user.selectOptions(roleSelects[1], 'strategist');
    await user.click(screen.getAllByLabelText('Primary Agent')[1]);
    await user.click(screen.getByRole('button', { name: 'Save Agents' }));

    expect(await screen.findByText('Talk agents updated.')).toBeTruthy();
    if (!savedRequest) {
      throw new Error('Expected talk agents save payload');
    }

    expect(savedRequest.agents).toHaveLength(2);
    expect(savedRequest.agents[0]).toMatchObject({
      nickname: 'Claude Sonnet 4.6',
      nicknameMode: 'auto',
      modelId: 'claude-sonnet-4-6',
      isPrimary: false,
    });
    expect(savedRequest.agents[1]).toMatchObject({
      nickname: 'GPT-5 Mini',
      role: 'strategist',
      isPrimary: true,
    });
  });

  it('auto-adds a pending footer agent when saving talk agents', async () => {
    const user = userEvent.setup();
    let savedRequest: SavedTalkAgentRequest | undefined;

    installTalkDetailFetch({
      messages: [],
      runs: [],
      talkAgents: [
        buildTalkAgent({
          id: 'agent-claude',
          nickname: 'Claude Sonnet 4.6',
          sourceKind: 'claude_default',
          role: 'assistant',
          isPrimary: true,
          displayOrder: 0,
          health: 'ready',
          providerId: null,
          modelId: 'claude-sonnet-4-6',
          modelDisplayName: 'Claude Sonnet 4.6',
        }),
      ],
      onPutAgents: (body) => {
        savedRequest = body;
        return body.agents.map((agent, index) => ({
          ...agent,
          displayOrder: index,
          health:
            agent.sourceKind === 'claude_default'
              ? 'ready'
              : agent.providerId === 'provider.openai'
                ? 'invalid'
                : 'unknown',
        }));
      },
    });

    renderDetailPage('/app/talks/talk-1/agents');
    await screen.findByRole('heading', { name: 'Agents' });

    await user.selectOptions(screen.getByLabelText('Agent'), 'agent-openai');
    await user.selectOptions(screen.getAllByLabelText('Role')[1], 'critic');
    expect(
      screen.getByRole('button', { name: 'Add + Save Agents' }),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add + Save Agents' }));

    expect(await screen.findByText('Talk agents updated.')).toBeTruthy();
    if (!savedRequest) {
      throw new Error('Expected talk agents save payload');
    }

    expect(savedRequest.agents).toHaveLength(2);
    expect(savedRequest.agents[1]).toMatchObject({
      id: 'agent-openai',
      nickname: 'GPT-5 Mini',
      role: 'critic',
      isPrimary: false,
    });

    const rowAgentSelects = screen.getAllByLabelText('Registered Agent');
    expect(rowAgentSelects).toHaveLength(2);
    expect((rowAgentSelects[1] as HTMLSelectElement).value).toBe(
      'agent-openai',
    );
    expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe(
      '',
    );

    const tabs = within(
      screen.getByRole('navigation', { name: 'Talk sections' }),
    );
    await user.click(tabs.getByRole('link', { name: 'Talk' }));
    await screen.findByLabelText('Talk timeline');

    const statusPills = screen.getByRole('list', { name: 'Talk agent status' });
    expect(within(statusPills).getByText('GPT-5 Mini (Critic)')).toBeTruthy();
  });

  it('shows an inline error when a pending footer agent becomes invalid before save', async () => {
    const user = userEvent.setup();
    let putCalled = false;

    installTalkDetailFetch({
      messages: [],
      runs: [],
      talkAgents: [
        buildTalkAgent({
          id: 'agent-claude',
          nickname: 'Claude Sonnet 4.6',
          sourceKind: 'claude_default',
          role: 'assistant',
          isPrimary: true,
          displayOrder: 0,
          health: 'ready',
          providerId: null,
          modelId: 'claude-sonnet-4-6',
          modelDisplayName: 'Claude Sonnet 4.6',
        }),
      ],
      onPutAgents: (body) => {
        putCalled = true;
        return body.agents;
      },
    });

    renderDetailPage('/app/talks/talk-1/agents');
    await screen.findByRole('heading', { name: 'Agents' });

    await user.selectOptions(screen.getByLabelText('Agent'), 'agent-openai');
    await user.selectOptions(
      screen.getByLabelText('Registered Agent'),
      'agent-openai',
    );

    await user.click(screen.getByRole('button', { name: 'Add + Save Agents' }));

    expect(
      await screen.findByText(
        'Selected registered agent is already assigned to this talk.',
      ),
    ).toBeTruthy();
    expect(putCalled).toBe(false);
  });

  it('shows source failures and refreshes URL source status after retry', async () => {
    const user = userEvent.setup();
    let currentContext = buildTalkContext({
      sources: [
        buildContextSource({
          id: 'source-failed',
          title: 'Gamemakers Substack',
          sourceUrl: 'https://example.substack.com/p/post',
          status: 'failed',
          extractionError:
            'fetch_http_error: HTTP 403 from https://example.substack.com/p/post',
        }),
      ],
    });
    let pollCount = 0;

    installTalkDetailFetch({
      context: currentContext,
      onGetContext: () => {
        if (
          currentContext.sources[0]?.status === 'pending' &&
          pollCount++ >= 0
        ) {
          currentContext = buildTalkContext({
            sources: [
              buildContextSource({
                id: 'source-failed',
                title: 'Gamemakers Substack',
                sourceUrl: 'https://example.substack.com/p/post',
                status: 'ready',
                extractionError: null,
                fetchStrategy: 'browser',
                lastFetchedAt: '2026-03-06T00:05:00.000Z',
                extractedTextLength: 1200,
              }),
            ],
          });
        }
        return currentContext;
      },
      onRetryContextSource: (sourceId) => {
        pollCount = 0;
        const updated = buildContextSource({
          id: sourceId,
          title: 'Gamemakers Substack',
          sourceUrl: 'https://example.substack.com/p/post',
          status: 'pending',
          extractionError: null,
        });
        currentContext = buildTalkContext({ sources: [updated] });
        return updated;
      },
    });

    renderDetailPage('/app/talks/talk-1/context');

    expect(await screen.findByText('Gamemakers Substack')).toBeTruthy();
    expect(
      screen.getByText(
        'fetch_http_error: HTTP 403 from https://example.substack.com/p/post',
      ),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('pending')).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2200));
    });

    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    expect(screen.getByText('via browser')).toBeTruthy();
  }, 10000);

  it('keeps pasted text sources available and lets keyboard users trigger file upload', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1/context');

    const uploadButton = await screen.findByRole('button', {
      name: 'Upload saved source files',
    });
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement | null;
    if (!fileInput) {
      throw new Error('Expected context file input');
    }
    const clickSpy = vi.fn();
    fileInput.click = clickSpy;

    uploadButton.focus();
    fireEvent.keyDown(uploadButton, { key: 'Enter' });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    await user.type(
      screen.getByLabelText('Paste text snippet'),
      'Bring these notes into the talk context.',
    );
    await user.click(screen.getByRole('button', { name: 'Add Text' }));

    await waitFor(() => {
      expect(screen.getByText('Pasted text source')).toBeTruthy();
    });
  });

  it('shows unsaved draft agents in the Talk tab and blocks send until agent changes are saved', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch({
      messages: [],
      runs: [],
      talkAgents: [
        buildTalkAgent({
          id: 'agent-claude',
          nickname: 'Claude Sonnet 4.6',
          sourceKind: 'claude_default',
          role: 'assistant',
          isPrimary: true,
          displayOrder: 0,
          health: 'ready',
          providerId: null,
          modelId: 'claude-sonnet-4-6',
          modelDisplayName: 'Claude Sonnet 4.6',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1/agents');
    await screen.findByRole('heading', { name: 'Agents' });

    const footerAgentSelect = screen.getByLabelText('Agent');
    await user.selectOptions(footerAgentSelect, 'agent-openai');
    await user.selectOptions(screen.getAllByLabelText('Role')[1], 'critic');
    await user.click(screen.getByRole('button', { name: 'Add Agent' }));

    const tabs = within(
      screen.getByRole('navigation', { name: 'Talk sections' }),
    );
    await user.click(tabs.getByRole('link', { name: 'Talk' }));
    await screen.findByLabelText('Talk timeline');

    const statusPills = screen.getByRole('list', { name: 'Talk agent status' });
    expect(
      within(statusPills).getByText('Claude Sonnet 4.6 (General)'),
    ).toBeTruthy();
    expect(within(statusPills).getByText('GPT-5 Mini (Critic)')).toBeTruthy();

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    expect(
      within(targetGroup).getByRole('button', {
        name: /Claude Sonnet 4\.6 \(General\)/i,
      }),
    ).toBeTruthy();
    expect(within(targetGroup).getByText('Claude Sonnet 4.6')).toBeTruthy();
    expect(
      within(targetGroup).queryByText('Claude Sonnet 4.6 (General)'),
    ).toBeNull();
    expect(
      within(targetGroup).getByRole('button', {
        name: /GPT-5 Mini \(Critic\)/i,
      }),
    ).toBeTruthy();
    expect(within(targetGroup).getByText('GPT-5 Mini')).toBeTruthy();
    expect(within(targetGroup).queryByText('GPT-5 Mini (Critic)')).toBeNull();

    expect(
      screen.getByText('Save agent changes before sending a message.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'disabled',
    );
    expect(
      screen.getByPlaceholderText('Send a message to this thread'),
    ).toHaveAttribute('disabled');
  });

  it('uses primary-target chips by default and sends plural targetAgentIds', async () => {
    const user = userEvent.setup();
    let sendBody:
      | {
          content: string;
          targetAgentIds: string[];
        }
      | undefined;

    installTalkDetailFetch({
      onSendMessage: (body) => {
        sendBody = body;
        return {
          talkId: 'talk-1',
          message: buildMessage({
            id: 'msg-posted',
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: body.targetAgentIds.map((agentId, index) =>
            buildRun({
              id: `run-${index + 10}`,
              threadId: body.threadId ?? DEFAULT_THREAD_ID,
              status: 'queued',
              createdAt: `2026-03-06T00:00:0${index + 6}.000Z`,
              triggerMessageId: 'msg-posted',
              targetAgentId: agentId,
              targetAgentNickname:
                agentId === 'agent-claude' ? 'Claude Sonnet 4.6' : 'GPT-5 Mini',
            }),
          ),
        };
      },
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByPlaceholderText('Send a message to this thread');

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    const claudeChip = within(targetGroup).getByRole('button', {
      name: /Claude Sonnet 4\.6 \(General\).*Primary/i,
    });
    const openAiChip = within(targetGroup).getByRole('button', {
      name: /GPT-5 Mini \(Critic\)/i,
    });

    expect(claudeChip.getAttribute('aria-pressed')).toBe('true');
    expect(openAiChip.getAttribute('aria-pressed')).toBe('false');

    await user.click(claudeChip);
    expect(claudeChip.getAttribute('aria-pressed')).toBe('true');

    await user.click(openAiChip);
    expect(openAiChip.getAttribute('aria-pressed')).toBe('true');

    await user.type(
      screen.getByPlaceholderText('Send a message to this thread'),
      'Give me the latest take.',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));

    if (!sendBody) {
      throw new Error('Expected send payload');
    }
    expect(sendBody.content).toBe('Give me the latest take.');
    expect(sendBody.targetAgentIds).toEqual(['agent-claude', 'agent-openai']);

    expect(
      await screen.findByText(
        'Wait for the current round to finish or cancel it before sending another message.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByPlaceholderText('Send a message to this thread'),
    ).toHaveAttribute('disabled');
  });

  it('allows multi-agent Talk turns that mix container and direct agents', async () => {
    const user = userEvent.setup();
    const sendBodies: Array<{ content: string; targetAgentIds: string[] }> = [];

    installTalkDetailFetch({
      registeredAgents: [
        buildRegisteredAgent({
          id: 'agent-claude',
          name: 'Claude Sonnet 4.6',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
          executionPreview: {
            surface: 'main',
            backend: 'container',
            authPath: 'subscription',
            selectedMode: 'subscription',
            transport: 'subscription',
            reasonCode: null,
            routeReason: 'subscription_fallback',
            ready: true,
            message:
              'Main will use Claude subscription via container fallback because no Anthropic API key is configured.',
          },
        }),
        buildRegisteredAgent({
          id: 'agent-openai',
          name: 'GPT-5 Mini',
          providerId: 'provider.openai',
          modelId: 'gpt-5-mini',
        }),
      ],
      onSendMessage: (body) => {
        sendBodies.push(body);
        return {
          talkId: 'talk-1',
          message: buildMessage({
            id: 'msg-posted',
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: body.targetAgentIds.map((agentId, index) =>
            buildRun({
              id: `run-${index + 1}`,
              threadId: body.threadId ?? DEFAULT_THREAD_ID,
              status: 'queued',
              createdAt: `2026-03-06T00:00:0${index + 6}.000Z`,
              triggerMessageId: 'msg-posted',
              targetAgentId: agentId,
              targetAgentNickname:
                agentId === 'agent-claude' ? 'Claude Sonnet 4.6' : 'GPT-5 Mini',
            }),
          ),
        };
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );
    const sendButton = screen.getByRole('button', { name: 'Send' });

    const statusPills = screen.getByRole('list', { name: 'Talk agent status' });
    expect(within(statusPills).queryByText('Single-agent only')).toBeNull();

    await user.type(composer, 'Which team has the edge?');
    expect(sendButton).not.toHaveAttribute('disabled');

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    const openAiChip = within(targetGroup).getByRole('button', {
      name: /GPT-5 Mini \(Critic\)/i,
    });
    await user.click(openAiChip);

    await waitFor(() =>
      expect(
        screen.queryByText(
          /can only run as the sole selected agent in Talk right now/i,
        ),
      ).toBeNull(),
    );
    expect(sendButton).not.toHaveAttribute('disabled');

    await user.click(sendButton);
    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toEqual({
      threadId: DEFAULT_THREAD_ID,
      content: 'Which team has the edge?',
      targetAgentIds: ['agent-claude', 'agent-openai'],
      attachmentIds: [],
    });
  });

  it('submits on Enter and keeps Shift+Enter for a newline in the composer', async () => {
    const user = userEvent.setup();
    const sentBodies: Array<{
      content: string;
      targetAgentIds: string[];
    }> = [];

    installTalkDetailFetch({
      messages: [],
      runs: [],
      onSendMessage: (body) => {
        sentBodies.push(body);
        return {
          talkId: 'talk-1',
          message: buildMessage({
            id: `msg-posted-${sentBodies.length}`,
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: [],
        };
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );

    await user.type(composer, 'Line 1');
    await user.keyboard('{Shift>}{Enter}{/Shift}Line 2');

    expect(composer).toHaveValue('Line 1\nLine 2');
    expect(sentBodies).toHaveLength(0);

    await user.keyboard('{Enter}');

    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]).toMatchObject({
      content: 'Line 1\nLine 2',
      targetAgentIds: ['agent-claude'],
    });
    await waitFor(() => expect(composer).toHaveValue(''));
  });

  it('starts the composer as a single row and shrinks it back after send', async () => {
    const user = userEvent.setup();
    let currentScrollHeight = 48;
    const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'scrollHeight',
    );

    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => currentScrollHeight,
    });

    try {
      installTalkDetailFetch({
        messages: [],
        runs: [],
        onSendMessage: (body) => ({
          talkId: 'talk-1',
          message: buildMessage({
            id: 'msg-posted-autosize',
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: [],
        }),
      });

      renderDetailPage('/app/talks/talk-1');
      const composer = (await screen.findByPlaceholderText(
        'Send a message to this thread',
      )) as HTMLTextAreaElement;

      expect(composer).toHaveAttribute('rows', '1');
      await waitFor(() => expect(composer.style.height).toBe('48px'));

      currentScrollHeight = 132;
      fireEvent.change(composer, {
        target: { value: 'Line 1\nLine 2\nLine 3\nLine 4' },
      });
      await waitFor(() => expect(composer.style.height).toBe('132px'));

      currentScrollHeight = 48;
      fireEvent.keyDown(composer, {
        key: 'Enter',
        code: 'Enter',
        charCode: 13,
      });

      await waitFor(() => expect(composer).toHaveValue(''));
      await waitFor(() => expect(composer.style.height).toBe('48px'));
    } finally {
      if (originalScrollHeightDescriptor) {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          'scrollHeight',
          originalScrollHeightDescriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
      }
    }
  });

  it('attaches dropped files from the talk workspace and sends their attachment ids', async () => {
    const user = userEvent.setup();
    let uploadedFileName: string | null = null;
    let sentBody:
      | {
          content: string;
          targetAgentIds: string[];
          attachmentIds?: string[];
        }
      | undefined;

    installTalkDetailFetch({
      messages: [],
      runs: [],
      onUploadAttachment: (formData) => {
        const file = formData.get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected file in attachment upload payload');
        }
        uploadedFileName = file.name;
        return buildMessageAttachment({
          id: 'att-1',
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          extractionStatus: 'ready',
        });
      },
      onSendMessage: (body) => {
        sentBody = body;
        return {
          talkId: 'talk-1',
          message: buildMessage({
            id: 'msg-posted',
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: [],
        };
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );
    const workspace = composer.closest('.talk-workspace');
    if (!workspace) {
      throw new Error('Expected talk workspace wrapper');
    }

    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    const dataTransfer = createFileDataTransfer([file]);

    const windowDragOverEvent = new Event('dragover', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(windowDragOverEvent, 'dataTransfer', {
      value: dataTransfer,
    });
    window.dispatchEvent(windowDragOverEvent);
    expect(windowDragOverEvent.defaultPrevented).toBe(true);

    fireEvent.dragEnter(workspace, { dataTransfer });
    expect(await screen.findByText('Drop files to attach')).toBeTruthy();

    fireEvent.drop(workspace, { dataTransfer });

    expect(await screen.findByText('notes.txt')).toBeTruthy();
    expect(uploadedFileName).toBe('notes.txt');

    await user.type(composer, 'Please review the attachment.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(sentBody).toMatchObject({
        content: 'Please review the attachment.',
        targetAgentIds: ['agent-claude'],
        attachmentIds: ['att-1'],
      }),
    );
  });

  it('shows an image preview chip for pending image attachments', async () => {
    installTalkDetailFetch({
      messages: [],
      runs: [],
      onUploadAttachment: (formData) => {
        const file = formData.get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected file in attachment upload payload');
        }
        return buildMessageAttachment({
          id: 'att-image',
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          extractionStatus: 'ready',
        });
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );
    const workspace = composer.closest('.talk-workspace');
    if (!workspace) {
      throw new Error('Expected talk workspace wrapper');
    }

    const file = new File([Uint8Array.from([1, 2, 3])], 'diagram.png', {
      type: 'image/png',
    });
    fireEvent.drop(workspace, { dataTransfer: createFileDataTransfer([file]) });

    expect(await screen.findByAltText('diagram.png')).toBeTruthy();
    expect(screen.getByText('diagram.png')).toBeTruthy();
  });

  it('blocks image sends for non-vision agents before submit', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch({
      messages: [],
      runs: [],
      aiAgents: {
        ...buildAiAgentsData(),
        claudeModelSuggestions: [
          {
            modelId: 'claude-sonnet-4-6',
            displayName: 'Claude Sonnet 4.6',
            contextWindowTokens: 200000,
            defaultMaxOutputTokens: 4096,
            supportsVision: false,
          },
        ],
      },
      onUploadAttachment: (formData) => {
        const file = formData.get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected file in attachment upload payload');
        }
        return buildMessageAttachment({
          id: 'att-image',
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          extractionStatus: 'ready',
        });
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );
    const workspace = composer.closest('.talk-workspace');
    if (!workspace) {
      throw new Error('Expected talk workspace wrapper');
    }

    const file = new File([Uint8Array.from([1, 2, 3])], 'diagram.png', {
      type: 'image/png',
    });
    fireEvent.drop(workspace, { dataTransfer: createFileDataTransfer([file]) });

    const guardrail = await screen.findByText(
      /Claude Sonnet 4\.6 .*does not support image attachments\. Switch to a vision-capable model or remove the images before sending\./,
    );
    expect(guardrail).toBeTruthy();
    expect(guardrail.closest('[role="status"]')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    await user.type(composer, 'Please inspect the image');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('allows image sends for Main when its TalkAgent.modelId is null but defaultClaudeModelId is vision-capable', async () => {
    // Repro for PR F Fix 2: the Primary "Agent" chip stores modelId=null on
    // the TalkAgent row; its effective model is aiAgents.defaultClaudeModelId.
    // Pre-fix, talkAgentSupportsVision short-circuited on the null modelId
    // and falsely flashed the banner. The fixture must explicitly null out
    // modelId — the default builder sets it to 'claude-sonnet-4-6'.
    installTalkDetailFetch({
      messages: [],
      runs: [],
      talkAgents: [
        buildTalkAgent({
          id: 'agent-claude',
          nickname: 'Agent',
          sourceKind: 'claude_default',
          role: 'assistant',
          isPrimary: true,
          displayOrder: 0,
          health: 'ready',
          providerId: null,
          modelId: null,
          modelDisplayName: null,
        }),
      ],
      aiAgents: {
        ...buildAiAgentsData(),
        defaultClaudeModelId: 'claude-opus-4-6',
      },
      onUploadAttachment: (formData) => {
        const file = formData.get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected file in attachment upload payload');
        }
        return buildMessageAttachment({
          id: 'att-image',
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          extractionStatus: 'ready',
        });
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread.',
    );
    const workspace = composer.closest('.talk-workspace');
    if (!workspace) {
      throw new Error('Expected talk workspace wrapper');
    }

    const file = new File([Uint8Array.from([1, 2, 3])], 'diagram.png', {
      type: 'image/png',
    });
    fireEvent.drop(workspace, { dataTransfer: createFileDataTransfer([file]) });

    expect(await screen.findByAltText('diagram.png')).toBeTruthy();
    expect(
      screen.queryByText(/does not support image attachments/),
    ).toBeNull();
  });

  it('still blocks image sends for Main when defaultClaudeModelId is unset', async () => {
    // Negative case for PR F Fix 2: the substitution must NOT mask a
    // misconfigured/loading aiAgents.defaultClaudeModelId. An empty string
    // should keep the banner firing rather than silently advertising vision.
    installTalkDetailFetch({
      messages: [],
      runs: [],
      talkAgents: [
        buildTalkAgent({
          id: 'agent-claude',
          nickname: 'Agent',
          sourceKind: 'claude_default',
          role: 'assistant',
          isPrimary: true,
          displayOrder: 0,
          health: 'ready',
          providerId: null,
          modelId: null,
          modelDisplayName: null,
        }),
      ],
      aiAgents: {
        ...buildAiAgentsData(),
        defaultClaudeModelId: '',
      },
      onUploadAttachment: (formData) => {
        const file = formData.get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected file in attachment upload payload');
        }
        return buildMessageAttachment({
          id: 'att-image',
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          extractionStatus: 'ready',
        });
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread.',
    );
    const workspace = composer.closest('.talk-workspace');
    if (!workspace) {
      throw new Error('Expected talk workspace wrapper');
    }

    const file = new File([Uint8Array.from([1, 2, 3])], 'diagram.png', {
      type: 'image/png',
    });
    fireEvent.drop(workspace, { dataTransfer: createFileDataTransfer([file]) });

    const guardrail = await screen.findByText(
      /does not support image attachments/,
    );
    expect(guardrail).toBeTruthy();
  });

  it('renders concurrent live responses as separate streaming bubbles', async () => {
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1');
    await screen.findByPlaceholderText('Send a message to this thread');

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onRunStarted({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        triggerMessageId: 'msg-1',
        status: 'running',
      });
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'Claude reply',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });

      stream.onRunStarted({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-openai',
        triggerMessageId: 'msg-1',
        status: 'running',
      });
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-openai',
        agentId: 'agent-openai',
        agentNickname: 'GPT-5 Mini',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-openai',
        agentId: 'agent-openai',
        agentNickname: 'GPT-5 Mini',
        deltaText: 'OpenAI reply',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });
    });

    expect(screen.getByText('Claude reply')).toBeTruthy();
    expect(screen.getByText('OpenAI reply')).toBeTruthy();
    const statusPills = screen.getByRole('list', { name: 'Talk agent status' });
    expect(
      within(statusPills).getByText('Claude Sonnet 4.6 (General)'),
    ).toBeTruthy();
    expect(within(statusPills).getByText('GPT-5 Mini (Critic)')).toBeTruthy();

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    expect(within(targetGroup).getByText('Claude Sonnet 4.6')).toBeTruthy();
    expect(within(targetGroup).getByText('GPT-5 Mini')).toBeTruthy();
    expect(
      within(targetGroup).queryByText('Claude Sonnet 4.6 (General)'),
    ).toBeNull();
    expect(within(targetGroup).queryByText('GPT-5 Mini (Critic)')).toBeNull();
  });

  it('marks synthesis messages in the timeline', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Help me decide.',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-synthesis',
          role: 'assistant',
          content: 'Here is the synthesized recommendation.',
          createdAt: '2026-03-06T00:00:03.000Z',
          runId: 'run-synthesis',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
          metadata: { isSynthesis: true },
        }),
      ],
      runs: [
        buildRun({
          id: 'run-synthesis',
          status: 'completed',
          createdAt: '2026-03-06T00:00:01.000Z',
          completedAt: '2026-03-06T00:00:03.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          responseGroupId: 'group-synthesis-1',
          sequenceIndex: 1,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByText('Here is the synthesized recommendation.');
    expect(screen.getByText('Synthesis')).toBeTruthy();
  });

  it('labels ordered assistant messages with their step number', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Review the draft.',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-critic',
          role: 'assistant',
          content: 'The intro needs a stronger claim.',
          createdAt: '2026-03-06T00:00:03.000Z',
          runId: 'run-critic',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
        }),
        buildMessage({
          id: 'msg-synthesis',
          role: 'assistant',
          content: 'Rewrite the intro, then keep the rest.',
          createdAt: '2026-03-06T00:00:05.000Z',
          runId: 'run-synthesis',
          agentId: 'agent-openai',
          agentNickname: 'GPT-5 Mini',
          metadata: { isSynthesis: true },
        }),
      ],
      runs: [
        buildRun({
          id: 'run-critic',
          status: 'completed',
          createdAt: '2026-03-06T00:00:01.000Z',
          completedAt: '2026-03-06T00:00:03.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          responseGroupId: 'group-review-1',
          sequenceIndex: 0,
        }),
        buildRun({
          id: 'run-synthesis',
          status: 'completed',
          createdAt: '2026-03-06T00:00:01.100Z',
          completedAt: '2026-03-06T00:00:05.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-openai',
          targetAgentNickname: 'GPT-5 Mini',
          responseGroupId: 'group-review-1',
          sequenceIndex: 1,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByText('Rewrite the intro, then keep the rest.');
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    expect(screen.getByText('Step 2 of 2')).toBeTruthy();
  });

  it('uses the agent nickname as the assistant message header when available', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Review this.',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-gem',
          role: 'assistant',
          content: 'Independent review.',
          createdAt: '2026-03-06T00:00:03.000Z',
          runId: 'run-gem',
          agentId: 'agent-openai',
          agentNickname: 'Gem',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    const messageBody = await screen.findByText('Independent review.');
    const article = messageBody.closest('article');
    if (!article) {
      throw new Error('Expected assistant article wrapper');
    }

    expect(within(article).getByText('GPT-5 Mini (Critic)')).toBeTruthy();
    expect(within(article).queryByText(/^assistant$/i)).toBeNull();
  });

  it('strips internal tags from live streamed assistant responses', async () => {
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: '<internal>Thinking',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: ' through it</internal>Visible',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: ' answer',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
    });

    expect(screen.queryByText(/<internal>/)).toBeNull();
    expect(screen.getByText('Visible answer')).toBeTruthy();
  });

  it('strips internal tags from persisted assistant messages', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'What do you think?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-2',
          role: 'assistant',
          content: '<internal>Think first</internal>The visible answer',
          createdAt: '2026-03-06T00:00:10.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });

    expect(screen.queryByText(/<internal>/)).toBeNull();
    expect(await screen.findByText('The visible answer')).toBeTruthy();
  });

  it('keeps failed live responses in chronological order in the timeline', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Can we pull retention data?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-2',
          role: 'assistant',
          content: 'Later persisted answer',
          createdAt: '2026-03-06T00:00:10.000Z',
        }),
      ],
      runs: [
        buildRun({
          id: 'run-failed',
          status: 'failed',
          createdAt: '2026-03-06T00:00:05.000Z',
          startedAt: '2026-03-06T00:00:05.000Z',
          completedAt: '2026-03-06T00:00:08.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          errorCode: 'tool_capability',
          errorMessage:
            'Attached data connectors require a tool-capable model.',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });
    await screen.findByText('Can we pull retention data?');

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'Failed attempt preview',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onRunFailed({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        triggerMessageId: 'msg-1',
        errorCode: 'tool_capability',
        errorMessage: 'Attached data connectors require a tool-capable model.',
      });
    });

    const userArticle = screen
      .getByText('Can we pull retention data?')
      .closest('article');
    const failedArticle = screen
      .getByText('Failed attempt preview')
      .closest('article');
    const persistedArticle = screen
      .getByText('Later persisted answer')
      .closest('article');

    expect(userArticle).toBeTruthy();
    expect(failedArticle).toBeTruthy();
    expect(persistedArticle).toBeTruthy();
    expect(userArticle?.compareDocumentPosition(failedArticle as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      failedArticle?.compareDocumentPosition(persistedArticle as Node),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('does not recreate stale failed cards from replayed failure events', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Can we pull retention data?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
      ],
      runs: [
        buildRun({
          id: 'run-failed',
          status: 'failed',
          createdAt: '2026-03-06T00:00:05.000Z',
          startedAt: '2026-03-06T00:00:05.000Z',
          completedAt: '2026-03-06T00:00:08.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          errorCode: 'auth_failed',
          errorMessage: 'Anthropic API error: Unauthorized',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });
    await screen.findByText('Can we pull retention data?');

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onResponseFailed?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        errorCode: 'auth_failed',
        errorMessage: 'Anthropic API error: Unauthorized',
      });
      stream.onRunFailed({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        triggerMessageId: 'msg-1',
        errorCode: 'auth_failed',
        errorMessage: 'Anthropic API error: Unauthorized',
      });
    });

    expect(screen.queryByText('Anthropic API error: Unauthorized')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Open Run History' }),
    ).toBeNull();
  });

  it('[T1 REGRESSION] keeps the live response panel after RUN_COMPLETED until MESSAGE_APPENDED replaces it, and appends late deltas to the existing text', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Summarize the latest news.',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });
    await screen.findByText('Summarize the latest news.');

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-streamed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-streamed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'Yes — Thomas Mass',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onRunCompleted({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-streamed',
        triggerMessageId: 'msg-1',
        responseMessageId: null,
      });
      // Late delta after RUN_COMPLETED — with the new
      // keep-until-MESSAGE_APPENDED behavior, this APPENDS to the existing
      // panel rather than being dropped (which would have created a
      // truncated zombie under the old delete-on-completed semantics).
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-streamed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'ie did **not lose his seat immediately**…',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
    });

    // Panel persists with the full accumulated text and a "Done" pill.
    // It will be replaced by the persisted assistant message bubble when
    // MESSAGE_APPENDED arrives — the dedup at line 1141-1147 handles that.
    expect(
      screen.getByText(
        /Yes — Thomas Massie did \*\*not lose his seat immediately\*\*/,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();

    // MESSAGE_APPENDED replaces the panel with the persisted bubble.
    await act(async () => {
      stream.onMessageAppended({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        messageId: 'msg-final',
        runId: 'run-streamed',
        role: 'assistant',
        createdBy: null,
        content: 'Yes — Thomas Massie did **not lose his seat immediately**…',
        createdAt: '2026-03-06T00:00:05.000Z',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
      });
    });
    // After MESSAGE_APPENDED, "Done" pill is gone (panel was replaced).
    expect(screen.queryByText('Done')).toBeNull();
    // The persisted assistant bubble now shows the same text.
    expect(screen.getByText(/Thomas Massie did/)).toBeTruthy();
  });

  it('refetches the active thread when MESSAGE_APPENDED never lands after RUN_COMPLETED', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let listMessagesCallCount = 0;
      const userMsg = buildMessage({
        id: 'msg-1',
        role: 'user',
        content: 'What is the latest?',
        createdAt: '2026-03-06T00:00:00.000Z',
      });
      const assistantMsg = buildMessage({
        id: 'msg-assistant-late',
        role: 'assistant',
        content: 'Persisted answer recovered by refetch',
        createdAt: '2026-03-06T00:00:10.000Z',
        runId: 'run-streamed',
      });

      installTalkDetailFetch({
        messages: [userMsg],
        onListMessages: () => {
          listMessagesCallCount += 1;
          return listMessagesCallCount === 1
            ? [userMsg]
            : [userMsg, assistantMsg];
        },
      });

      renderDetailPage('/app/talks/talk-1');
      await screen.findByRole('heading', { name: /Cal Football/i });
      await screen.findByText('What is the latest?');

      if (!streamInput) {
        throw new Error('Expected talk stream input');
      }
      const stream = streamInput;

      await act(async () => {
        stream.onResponseStarted?.({
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          runId: 'run-streamed',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        });
        stream.onRunCompleted({
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          runId: 'run-streamed',
          triggerMessageId: 'msg-1',
          responseMessageId: 'msg-assistant-late',
        });
        // MESSAGE_APPENDED intentionally omitted to simulate a dropped event.
      });

      expect(
        screen.queryByText(/Persisted answer recovered by refetch/),
      ).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });

      await waitFor(() => {
        expect(
          screen.getByText(/Persisted answer recovered by refetch/),
        ).toBeTruthy();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears failed live responses when a new user message appends in the same thread', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Can we pull retention data?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });
    await screen.findByText('Can we pull retention data?');

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'Failed attempt preview',
      });
      stream.onRunFailed({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        triggerMessageId: 'msg-1',
        errorCode: 'execution_failed',
        errorMessage: 'Anthropic API error: Unauthorized',
      });
    });

    expect(screen.getByText('Failed attempt preview')).toBeTruthy();

    await act(async () => {
      stream.onMessageAppended({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        messageId: 'msg-2',
        runId: null,
        role: 'user',
        createdBy: 'owner-1',
        content: 'Try again with the same data.',
        createdAt: '2026-03-06T00:00:15.000Z',
      });
    });

    expect(screen.queryByText('Failed attempt preview')).toBeNull();
    expect(screen.getByText('Try again with the same data.')).toBeTruthy();
  });

  it('does not bulk-clear failed cards on assistant message appends', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Can we pull retention data?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });
    await screen.findByText('Can we pull retention data?');

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'Failed attempt preview',
      });
      stream.onRunFailed({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        triggerMessageId: 'msg-1',
        errorCode: 'execution_failed',
        errorMessage: 'Anthropic API error: Unauthorized',
      });
    });

    expect(screen.getByText('Failed attempt preview')).toBeTruthy();

    await act(async () => {
      stream.onMessageAppended({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        messageId: 'msg-2',
        runId: 'run-completed',
        role: 'assistant',
        createdBy: null,
        content: 'Here is a successful follow-up.',
        createdAt: '2026-03-06T00:00:20.000Z',
        agentId: 'agent-openai',
        agentNickname: 'GPT-5 Mini',
      });
    });

    expect(screen.getByText('Failed attempt preview')).toBeTruthy();
    expect(screen.getByText('Here is a successful follow-up.')).toBeTruthy();
  });

  it('keeps off-thread failures out of the active timeline while updating Run History', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          talkId: 'talk-1',
          title: 'Primary thread',
          isDefault: true,
          messageCount: 1,
          lastMessageAt: '2026-03-06T00:00:00.000Z',
        }),
        buildThread({
          id: 'thread-side',
          talkId: 'talk-1',
          title: 'Side thread',
          messageCount: 0,
          lastMessageAt: null,
        }),
      ],
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'What is the latest update?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onRunFailed({
        talkId: 'talk-1',
        threadId: 'thread-side',
        runId: 'run-side',
        triggerMessageId: null,
        errorCode: 'execution_failed',
        errorMessage: 'Side thread failed',
      });
    });

    expect(screen.queryByText('Side thread failed')).toBeNull();

    const tabs = within(
      screen.getByRole('navigation', { name: 'Talk sections' }),
    );
    await user.click(tabs.getByRole('link', { name: 'Run History' }));
    await screen.findByRole('heading', { name: 'Run History' });

    expect(screen.getByText('run-side')).toBeTruthy();
    expect(
      screen.getByText('execution_failed: Side thread failed'),
    ).toBeTruthy();
  });

  it('opens Run History from a failed inline card and scrolls to the run row', async () => {
    const user = userEvent.setup();
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    try {
      installTalkDetailFetch({
        messages: [
          buildMessage({
            id: 'msg-1',
            role: 'user',
            content: 'Can we pull retention data?',
            createdAt: '2026-03-06T00:00:00.000Z',
          }),
        ],
        runs: [
          buildRun({
            id: 'run-failed',
            status: 'running',
            createdAt: '2026-03-06T00:00:05.000Z',
            startedAt: '2026-03-06T00:00:05.000Z',
            triggerMessageId: 'msg-1',
            targetAgentId: 'agent-claude',
            targetAgentNickname: 'Claude Sonnet 4.6',
          }),
        ],
      });

      renderDetailPage('/app/talks/talk-1');
      await screen.findByRole('heading', { name: /Cal Football/i });

      if (!streamInput) {
        throw new Error('Expected talk stream input');
      }
      const stream = streamInput;

      await act(async () => {
        stream.onResponseStarted?.({
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          runId: 'run-failed',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
        });
        stream.onResponseDelta?.({
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          runId: 'run-failed',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
          deltaText: 'Failed attempt preview',
        });
        stream.onRunFailed({
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          runId: 'run-failed',
          triggerMessageId: 'msg-1',
          errorCode: 'execution_failed',
          errorMessage: 'Anthropic API error: Unauthorized',
        });
      });

      await user.click(
        screen.getByRole('button', { name: 'Open Run History' }),
      );

      await screen.findByRole('heading', { name: 'Run History' });
      expect(document.getElementById('run-run-failed')).toBeTruthy();
      expect(screen.getByText('run-failed')).toBeTruthy();
      expect(scrollIntoViewMock).toHaveBeenCalled();
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          'scrollIntoView',
          originalScrollIntoView,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('opens edit history from /edit and deletes selected messages', async () => {
    const user = userEvent.setup();

    const initialMessages = [
      buildMessage({
        id: 'msg-1',
        role: 'user',
        content: 'Old user prompt',
        createdAt: '2026-03-06T00:00:00.000Z',
      }),
      buildMessage({
        id: 'msg-2',
        role: 'assistant',
        content: 'Old assistant answer',
        createdAt: '2026-03-06T00:00:01.000Z',
      }),
      buildMessage({
        id: 'msg-3',
        role: 'user',
        content: 'Keep this latest note',
        createdAt: '2026-03-06T00:00:02.000Z',
      }),
    ];

    installTalkDetailFetch({
      messages: initialMessages,
      runs: [],
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );

    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();
    const removeOldUser = screen.getByLabelText(/You.*Old user prompt/i);
    const removeOldAssistant = screen.getByLabelText(
      /Assistant.*Old assistant answer/i,
    );
    await user.click(removeOldUser);
    await user.click(removeOldAssistant);
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(
      await screen.findByText('Deleted 2 messages from this Talk history.'),
    ).toBeTruthy();
    expect(screen.queryByText('Old user prompt')).toBeNull();
    expect(screen.queryByText('Old assistant answer')).toBeNull();
    expect(screen.getByText('Keep this latest note')).toBeTruthy();
  });

  it('keeps the Talk timeline in sync when a stale replay-gap snapshot resolves after deleting history', async () => {
    const user = userEvent.setup();
    const initialMessages = [
      buildMessage({
        id: 'msg-1',
        role: 'user',
        content: 'Old user prompt',
        createdAt: '2026-03-06T00:00:00.000Z',
      }),
      buildMessage({
        id: 'msg-2',
        role: 'assistant',
        content: 'Old assistant answer',
        createdAt: '2026-03-06T00:00:01.000Z',
      }),
      buildMessage({
        id: 'msg-3',
        role: 'user',
        content: 'Keep this latest note',
        createdAt: '2026-03-06T00:00:02.000Z',
      }),
    ];
    const staleReplay = createDeferred<TalkMessage[]>();
    let onListMessagesCallCount = 0;

    installTalkDetailFetch({
      messages: initialMessages,
      runs: [],
      onListMessages: ({ visibleMessages }) => {
        const callIndex = onListMessagesCallCount++;
        if (callIndex === 1) {
          return staleReplay.promise;
        }
        return visibleMessages;
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );

    expect(streamInput).toBeTruthy();
    act(() => {
      void streamInput?.onReplayGap?.();
    });

    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();

    await user.click(screen.getByLabelText(/You.*Old user prompt/i));
    await user.click(screen.getByLabelText(/Assistant.*Old assistant answer/i));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(
      await screen.findByText('Deleted 2 messages from this Talk history.'),
    ).toBeTruthy();

    staleReplay.resolve(initialMessages);
    await waitFor(() => {
      expect(screen.queryByText('Old user prompt')).toBeNull();
      expect(screen.queryByText('Old assistant answer')).toBeNull();
    });

    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Edit history' });
    expect(within(dialog).queryByText('Old user prompt')).toBeNull();
    expect(within(dialog).queryByText('Old assistant answer')).toBeNull();
    expect(within(dialog).getByText('Keep this latest note')).toBeTruthy();
  });

  it('ignores replayed deleted message events after sending the same prompt again', async () => {
    const user = userEvent.setup();
    const repeatedPrompt = 'can you try to access my linkedin again?';

    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: repeatedPrompt,
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-2',
          role: 'user',
          content: repeatedPrompt,
          createdAt: '2026-03-06T00:00:01.000Z',
        }),
        buildMessage({
          id: 'msg-3',
          role: 'user',
          content: 'Keep this latest note',
          createdAt: '2026-03-06T00:00:02.000Z',
        }),
      ],
      runs: [],
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );

    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();

    const repeatedRows = screen.getAllByLabelText(
      /You.*can you try to access my linkedin again\?/i,
    );
    await user.click(repeatedRows[0]!);
    await user.click(repeatedRows[1]!);
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(screen.queryByText(repeatedPrompt)).toBeNull();

    await user.type(composer, repeatedPrompt);
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getAllByText(repeatedPrompt)).toHaveLength(1),
    );

    expect(streamInput).toBeTruthy();
    act(() => {
      streamInput?.onMessageAppended({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        messageId: 'msg-1',
        runId: null,
        role: 'user',
        createdBy: 'user-1',
        content: repeatedPrompt,
        createdAt: '2026-03-06T00:00:00.000Z',
      });
      streamInput?.onMessageAppended({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        messageId: 'msg-2',
        runId: null,
        role: 'user',
        createdBy: 'user-1',
        content: repeatedPrompt,
        createdAt: '2026-03-06T00:00:01.000Z',
      });
    });

    await waitFor(() =>
      expect(screen.getAllByText(repeatedPrompt)).toHaveLength(1),
    );
  });

  it('keeps deleted prompt messages hidden when an execution resync returns stale rows', async () => {
    const user = userEvent.setup();
    const repeatedPrompt = 'can you try to access my linkedin again?';
    const deletedMessages = [
      buildMessage({
        id: 'msg-1',
        role: 'user',
        content: repeatedPrompt,
        createdAt: '2026-03-06T00:00:00.000Z',
      }),
      buildMessage({
        id: 'msg-2',
        role: 'user',
        content: repeatedPrompt,
        createdAt: '2026-03-06T00:00:01.000Z',
      }),
    ];
    let onListMessagesCallCount = 0;

    installTalkDetailFetch({
      messages: [
        ...deletedMessages,
        buildMessage({
          id: 'msg-3',
          role: 'user',
          content: 'Keep this latest note',
          createdAt: '2026-03-06T00:00:02.000Z',
        }),
      ],
      runs: [],
      onListMessages: ({ visibleMessages }) => {
        const callIndex = onListMessagesCallCount++;
        if (callIndex === 2) {
          return [...deletedMessages, ...visibleMessages];
        }
        return visibleMessages;
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );

    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();

    const repeatedRows = screen.getAllByLabelText(
      /You.*can you try to access my linkedin again\?/i,
    );
    await user.click(repeatedRows[0]!);
    await user.click(repeatedRows[1]!);
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(screen.queryByText(repeatedPrompt)).toBeNull();

    await user.type(composer, repeatedPrompt);
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getAllByText(repeatedPrompt)).toHaveLength(1),
    );

    expect(streamInput).toBeTruthy();
    act(() => {
      streamInput?.onMessageAppended({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        messageId: 'msg-run-sync',
        runId: 'run-sync',
        role: 'assistant',
        createdBy: 'agent-1',
      });
    });

    await waitFor(() =>
      expect(screen.getAllByText(repeatedPrompt)).toHaveLength(1),
    );
  });

  // ── PR-A A3: Hybrid MD+HTML doc-pane integration ──────────────────
  it('renders the doc modal with a format radio and POSTs format=html on submit', async () => {
    const user = userEvent.setup();
    const onCreateContent = vi.fn(({ title, format }) =>
      buildContent({
        id: 'content-new',
        threadId: DEFAULT_THREAD_ID,
        title,
        contentFormat: (format as Content['contentFormat']) ?? 'markdown',
      }),
    );
    installTalkDetailFetch({ onCreateContent });
    renderDetailPage('/app/talks/talk-1/talk', {
      sidebarContents: [],
    });

    await screen.findByPlaceholderText('Send a message to this thread');

    // Open the + Doc modal via the existing add-doc button.
    const addDocButton = await screen.findByRole('button', {
      name: /add a document|\+ doc/i,
    });
    await user.click(addDocButton);

    // Title input + format radio render.
    const titleInput = await screen.findByLabelText('Title');
    await user.type(titleInput, 'HTML Doc');
    const htmlRadio = screen.getByRole('radio', { name: 'HTML' });
    const mdRadio = screen.getByRole('radio', { name: 'Markdown' });
    expect(mdRadio).toBeChecked();
    await user.click(htmlRadio);
    expect(htmlRadio).toBeChecked();

    await user.click(screen.getByRole('button', { name: /create document/i }));

    await waitFor(() =>
      expect(onCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'HTML Doc', format: 'html' }),
      ),
    );
  });

  it('renders an HTML doc via SafeHtml in Preview mode', async () => {
    installTalkDetailFetch({
      contentByThreadId: {
        [DEFAULT_THREAD_ID]: buildContent({
          id: 'content-html',
          threadId: DEFAULT_THREAD_ID,
          title: 'My HTML',
          contentFormat: 'html',
          bodyHtml:
            '<p data-testid="html-body">Hello <strong>world</strong></p>',
        }),
      },
    });
    renderDetailPage('/app/talks/talk-1/talk?doc=1', {
      sidebarContents: [
        {
          id: 'content-html',
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          title: 'My HTML',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    });

    // SafeHtml renders the sanitized body as actual HTML.
    const para = await screen.findByTestId('html-body');
    expect(para.textContent).toContain('Hello');
    expect(para.querySelector('strong')?.textContent).toBe('world');
    // The format pill says HTML.
    expect(screen.getByText('HTML')).toBeInTheDocument();
  });

  it('toggles between Preview and Source mode for HTML docs', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      contentByThreadId: {
        [DEFAULT_THREAD_ID]: buildContent({
          id: 'content-html',
          threadId: DEFAULT_THREAD_ID,
          title: 'Mode toggle',
          contentFormat: 'html',
          bodyHtml: '<p>preview text</p>',
        }),
      },
    });
    renderDetailPage('/app/talks/talk-1/talk?doc=1', {
      sidebarContents: [
        {
          id: 'content-html',
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          title: 'Mode toggle',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    });

    // Doc loaded — both Preview and Source tabs are present.
    const sourceTab = await screen.findByRole('tab', { name: /source/i });
    await user.click(sourceTab);

    // Lazy-loaded CodeMirror swap (mocked as textarea) appears.
    const ta = await screen.findByTestId('cm-textarea');
    expect((ta as HTMLTextAreaElement).value).toBe('<p>preview text</p>');

    // Switch back to Preview — textarea unmounts, SafeHtml renders.
    const previewTab = screen.getByRole('tab', { name: /preview/i });
    await user.click(previewTab);
    await waitFor(() =>
      expect(screen.queryByTestId('cm-textarea')).not.toBeInTheDocument(),
    );
  });

  it('hides the doc pane via the hide button, shows it via the edge tab, and persists state in localStorage', async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    installTalkDetailFetch({
      contentByThreadId: {
        [DEFAULT_THREAD_ID]: buildContent({
          id: 'content-hide',
          threadId: DEFAULT_THREAD_ID,
          title: 'Hide me',
          contentFormat: 'markdown',
          bodyMarkdown: '',
        }),
      },
    });
    renderDetailPage('/app/talks/talk-1/talk?doc=1', {
      sidebarContents: [
        {
          id: 'content-hide',
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          title: 'Hide me',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    });

    const hideBtn = await screen.findByRole('button', {
      name: /hide document pane/i,
    });
    await user.click(hideBtn);

    // Edge tab appears with the doc title.
    const edgeTab = await screen.findByRole('button', {
      name: /show hide me document/i,
    });
    expect(edgeTab).toBeInTheDocument();

    // Persisted to localStorage.
    const raw = window.localStorage.getItem(
      `clawtalk_doc_state:${DEFAULT_THREAD_ID}`,
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ hidden: true });

    // Click edge tab restores the pane.
    await user.click(edgeTab);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /show hide me document/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it('auto-flips an empty HTML doc from Source to Preview on first content_edit_applied', async () => {
    installTalkDetailFetch({
      contentByThreadId: {
        [DEFAULT_THREAD_ID]: buildContent({
          id: 'content-empty-html',
          threadId: DEFAULT_THREAD_ID,
          title: 'Auto-flip',
          contentFormat: 'html',
          bodyHtml: '',
        }),
      },
    });
    window.localStorage.clear();
    renderDetailPage('/app/talks/talk-1/talk?doc=1', {
      sidebarContents: [
        {
          id: 'content-empty-html',
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          title: 'Auto-flip',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    });

    // Wait for the doc pane to render so we know the content has
    // hydrated; the empty-HTML auto-source effect runs in the same
    // commit batch.
    const doc = await screen.findByLabelText('Talk document');
    expect(doc).toBeInTheDocument();
    // Wait for loading to clear so the auto-source effect has had a
    // chance to run.
    await waitFor(() =>
      expect(within(doc).queryByText('Loading…')).not.toBeInTheDocument(),
    );
    // Empty HTML doc opens in Source — CodeMirror textarea is present.
    const ta = (await screen.findByTestId(
      'cm-textarea',
    )) as HTMLTextAreaElement;
    expect(ta).toBeInTheDocument();

    // Fire a content_edit_applied event — this is the first AI edit.
    await act(async () => {
      streamInput?.onContentEditApplied?.({
        contentId: 'content-empty-html',
        runId: 'run-edit-1',
        editIds: ['edit-1'],
        agentId: 'agent-1',
        agentNickname: 'Claude',
        messageId: null,
      });
    });

    // After the refetch completes the mode flipped to Preview, so the
    // editor mounts off and the SafeHtml div renders.
    await waitFor(() =>
      expect(screen.queryByTestId('cm-textarea')).not.toBeInTheDocument(),
    );
  });

  it('renders a markdown doc via PendingEditDocSurface (regression — no swap to SafeHtml)', async () => {
    installTalkDetailFetch({
      contentByThreadId: {
        [DEFAULT_THREAD_ID]: buildContent({
          id: 'content-md',
          threadId: DEFAULT_THREAD_ID,
          title: 'Markdown doc',
          contentFormat: 'markdown',
          bodyMarkdown: '# Hello',
        }),
      },
    });
    renderDetailPage('/app/talks/talk-1/talk?doc=1', {
      sidebarContents: [
        {
          id: 'content-md',
          talkId: 'talk-1',
          threadId: DEFAULT_THREAD_ID,
          title: 'Markdown doc',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    });

    // Format pill says MD; no Preview/Source toggle for markdown docs.
    expect(await screen.findByText('MD')).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /source/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /preview/i }),
    ).not.toBeInTheDocument();
  });

  it('resolves to the localStorage-saved thread when the URL has no ?thread= param', async () => {
    window.localStorage.setItem('clawtalk.lastThread:talk-1', 'thread-saved');
    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          title: 'Default thread',
          isDefault: true,
          lastMessageAt: '2026-03-06T02:00:00.000Z',
        }),
        buildThread({
          id: 'thread-saved',
          title: 'Saved thread',
          lastMessageAt: '2026-03-06T01:00:00.000Z',
        }),
      ],
    });
    renderDetailPage('/app/talks/talk-1');

    // Even though the default thread is most-recent-by-activity, the
    // routing effect prefers the localStorage-saved thread.
    const savedButton = await screen.findByRole('button', {
      name: /saved thread/i,
    });
    await waitFor(() =>
      expect(savedButton.className).toContain('talk-thread-item-active'),
    );
    const defaultButton = screen.getByRole('button', {
      name: /default thread/i,
    });
    expect(defaultButton.className).not.toContain('talk-thread-item-active');
  });

  it('persists the resolved thread for the current talk on initial render', async () => {
    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          title: 'Default thread',
          isDefault: true,
          lastMessageAt: '2026-03-06T02:00:00.000Z',
        }),
        buildThread({
          id: 'thread-explicit',
          title: 'Explicit thread',
          lastMessageAt: '2026-03-06T01:00:00.000Z',
        }),
      ],
    });
    renderDetailPage('/app/talks/talk-1/talk?thread=thread-explicit');

    // Wait until the URL-resolved thread is the active one.
    const explicitButton = await screen.findByRole('button', {
      name: /explicit thread/i,
    });
    await waitFor(() =>
      expect(explicitButton.className).toContain('talk-thread-item-active'),
    );

    // The routing-resolution effect must have keyed the save under
    // talk-1 — the current talk — never under some other talkId.
    expect(window.localStorage.getItem('clawtalk.lastThread:talk-1')).toBe(
      'thread-explicit',
    );
  });

  it('falls back to threads[0] when the localStorage-saved thread no longer exists', async () => {
    window.localStorage.setItem('clawtalk.lastThread:talk-1', 'thread-deleted');
    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          title: 'Default thread',
          isDefault: true,
          lastMessageAt: '2026-03-06T02:00:00.000Z',
        }),
        buildThread({
          id: 'thread-other',
          title: 'Other thread',
          lastMessageAt: '2026-03-06T01:00:00.000Z',
        }),
      ],
    });
    renderDetailPage('/app/talks/talk-1');

    // Saved thread is gone — falls through to the most-recent fallback.
    const defaultButton = await screen.findByRole('button', {
      name: /default thread/i,
    });
    await waitFor(() =>
      expect(defaultButton.className).toContain('talk-thread-item-active'),
    );
  });

  it('clears the doc pane when switching from a thread that has a doc to a sibling that does not', async () => {
    const user = userEvent.setup();
    const NO_DOC_THREAD_ID = 'thread-no-doc';
    installTalkDetailFetch({
      threads: [
        buildThread({
          id: DEFAULT_THREAD_ID,
          title: 'Default thread',
          isDefault: true,
          lastMessageAt: '2026-03-06T00:00:00.000Z',
        }),
        buildThread({
          id: NO_DOC_THREAD_ID,
          title: 'Sibling thread',
          lastMessageAt: '2026-03-06T01:00:00.000Z',
        }),
      ],
      contentByThreadId: {
        [DEFAULT_THREAD_ID]: buildContent({
          id: 'content-md',
          threadId: DEFAULT_THREAD_ID,
          title: 'Default doc',
          contentFormat: 'markdown',
          bodyMarkdown: '# Default doc body',
        }),
      },
    });
    renderDetailPage(
      `/app/talks/talk-1/talk?thread=${DEFAULT_THREAD_ID}&doc=1`,
      {
        sidebarContents: [
          {
            id: 'content-md',
            talkId: 'talk-1',
            threadId: DEFAULT_THREAD_ID,
            title: 'Default doc',
            updatedAt: '2026-03-06T00:00:00.000Z',
          },
        ],
      },
    );

    // Doc loads on the default thread.
    const doc = await screen.findByLabelText('Talk document');
    expect(doc).toBeInTheDocument();

    // Click the sibling thread (no doc).
    const siblingButton = await screen.findByRole('button', {
      name: /sibling thread/i,
    });
    await user.click(siblingButton);

    // The doc pane should unmount because the new thread has no doc row
    // in the sidebar.
    await waitFor(() =>
      expect(screen.queryByLabelText('Talk document')).not.toBeInTheDocument(),
    );
  });
});

function renderDetailPage(
  initialEntry: string,
  options?: { sidebarContents?: ContentSidebarItem[] },
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/app/talks/:talkId/*"
          element={
            <TalkDetailPage
              onUnauthorized={vi.fn()}
              renameDraft={null}
              onRenameDraftChange={vi.fn()}
              onRenameDraftCancel={vi.fn()}
              onRenameDraftCommit={vi.fn().mockResolvedValue(undefined)}
              onSidebarChanged={vi.fn().mockResolvedValue(undefined)}
              sidebarContents={options?.sidebarContents ?? []}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function renderDetailPageWithRenameHarness(
  initialEntry: string,
  options?: {
    onRenameDraftCommit?: (
      talkId: string,
      draft: string,
    ) => Promise<void> | void;
  },
): ReturnType<typeof render> {
  const onRenameDraftCommit =
    options?.onRenameDraftCommit ?? vi.fn().mockResolvedValue(undefined);

  function RenameHarness(): JSX.Element {
    const [renameDraft, setRenameDraft] = useState<{
      talkId: string;
      draft: string;
    } | null>(null);

    return (
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/app/talks/:talkId/*"
            element={
              <TalkDetailPage
                onUnauthorized={vi.fn()}
                renameDraft={renameDraft}
                onRenameDraftChange={(talkId, draft) =>
                  setRenameDraft({ talkId, draft })
                }
                onRenameDraftCancel={(talkId) =>
                  setRenameDraft((current) =>
                    current?.talkId === talkId ? null : current,
                  )
                }
                onRenameDraftCommit={async (talkId, draft) => {
                  await onRenameDraftCommit(talkId, draft);
                  setRenameDraft((current) =>
                    current?.talkId === talkId ? null : current,
                  );
                }}
                onSidebarChanged={vi.fn().mockResolvedValue(undefined)}
                sidebarContents={[]}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    );
  }

  return render(<RenameHarness />);
}

function buildTalk(): Talk {
  return {
    id: 'talk-1',
    ownerId: 'owner-1',
    title: 'Cal Football',
    orchestrationMode: 'ordered',
    agents: ['Claude'],
    status: 'active',
    folderId: null,
    sortOrder: 0,
    version: 1,
    createdAt: '2026-03-06T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
    accessRole: 'owner',
  };
}

function buildTalkWith(overrides: Partial<Talk>): Talk {
  return {
    ...buildTalk(),
    ...overrides,
  };
}

function buildTalkAgent(
  input: Partial<TalkAgent> & Pick<TalkAgent, 'id' | 'nickname'>,
): TalkAgent {
  return {
    id: input.id,
    nickname: input.nickname,
    nicknameMode: input.nicknameMode ?? 'auto',
    sourceKind: input.sourceKind ?? 'provider',
    role: input.role ?? 'assistant',
    isPrimary: input.isPrimary ?? false,
    displayOrder: input.displayOrder ?? 0,
    health: input.health ?? 'unknown',
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    modelDisplayName: input.modelDisplayName ?? null,
  };
}

function buildRegisteredAgent(
  input: Partial<RegisteredAgent> &
    Pick<RegisteredAgent, 'id' | 'name' | 'providerId' | 'modelId'>,
): RegisteredAgent {
  return {
    id: input.id,
    name: input.name,
    providerId: input.providerId,
    modelId: input.modelId,
    toolPermissions: input.toolPermissions ?? { web: true, connectors: true },
    personaRole: input.personaRole ?? 'assistant',
    systemPrompt: input.systemPrompt ?? null,
    description: input.description ?? null,
    enabled: input.enabled ?? true,
    credentialMode: input.credentialMode ?? null,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
    executionPreview: input.executionPreview ?? {
      surface: 'main',
      backend: 'direct_http',
      authPath: input.providerId === 'provider.anthropic' ? 'api_key' : null,
      selectedMode: input.providerId === 'provider.anthropic' ? 'api' : null,
      transport: input.providerId === 'provider.anthropic' ? 'direct' : null,
      reasonCode: null,
      routeReason: 'normal',
      ready: true,
      message: 'Main will use direct HTTP.',
    },
  };
}

function buildThread(
  input: Partial<TalkThread> & Pick<TalkThread, 'id'>,
): TalkThread {
  return {
    id: input.id,
    talkId: input.talkId ?? 'talk-1',
    title: input.title ?? null,
    isDefault: input.isDefault ?? false,
    isPinned: input.isPinned ?? false,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
    messageCount: input.messageCount ?? 0,
    lastMessageAt: input.lastMessageAt ?? null,
  };
}

function buildMessage(
  input: Partial<TalkMessage> &
    Pick<TalkMessage, 'id' | 'role' | 'content' | 'createdAt'>,
): TalkMessage {
  return {
    id: input.id,
    threadId: input.threadId ?? DEFAULT_THREAD_ID,
    role: input.role,
    content: input.content,
    createdBy: input.createdBy ?? 'owner-1',
    createdAt: input.createdAt,
    runId: input.runId ?? null,
    agentId: input.agentId ?? null,
    agentNickname: input.agentNickname ?? null,
    metadata: input.metadata ?? null,
    attachments: input.attachments ?? [],
  };
}

function buildMessageAttachment(
  input: Partial<TalkMessageAttachment> &
    Pick<
      TalkMessageAttachment,
      'id' | 'fileName' | 'fileSize' | 'mimeType' | 'extractionStatus'
    >,
): TalkMessageAttachment {
  return {
    id: input.id,
    fileName: input.fileName,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    extractionStatus: input.extractionStatus,
  };
}

function buildRun(
  input: Partial<TalkRun> & Pick<TalkRun, 'id' | 'status' | 'createdAt'>,
): TalkRun {
  return {
    id: input.id,
    threadId: input.threadId ?? DEFAULT_THREAD_ID,
    responseGroupId: input.responseGroupId ?? null,
    sequenceIndex: input.sequenceIndex ?? null,
    status: input.status,
    createdAt: input.createdAt,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    targetAgentNickname: input.targetAgentNickname ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    cancelReason: input.cancelReason ?? null,
    executorAlias: input.executorAlias ?? null,
    executorModel: input.executorModel ?? null,
    browserBlock: input.browserBlock ?? null,
    browserResume: input.browserResume ?? null,
    carriedBrowserSessions: input.carriedBrowserSessions ?? [],
    executionDecision: input.executionDecision ?? null,
  };
}

function createFileDataTransfer(files: File[]): DataTransfer {
  return {
    files,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    })),
    types: {
      0: 'Files',
      length: 1,
      contains: (value: string) => value === 'Files',
      item: (index: number) => (index === 0 ? 'Files' : null),
    },
    dropEffect: 'copy',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

function buildDataConnector(input: Partial<DataConnector> = {}): DataConnector {
  return {
    id: input.id ?? 'connector-1',
    name: input.name ?? 'FTUE PostHog',
    connectorKind: input.connectorKind ?? 'posthog',
    config: input.config ?? {
      hostUrl: 'https://us.posthog.com',
      projectId: '12345',
    },
    discovered: input.discovered ?? null,
    enabled: input.enabled ?? true,
    hasCredential: input.hasCredential ?? false,
    verificationStatus: input.verificationStatus ?? 'missing',
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    lastVerificationError: input.lastVerificationError ?? null,
    attachedTalkCount: input.attachedTalkCount ?? 0,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function toThreadApiRecord(thread: TalkThread) {
  return {
    id: thread.id,
    talk_id: thread.talkId,
    title: thread.title,
    is_default: thread.isDefault ? 1 : 0,
    is_pinned: thread.isPinned ? 1 : 0,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    message_count: thread.messageCount,
    last_message_at: thread.lastMessageAt,
  };
}

function buildTalkDataConnector(
  input: Partial<TalkDataConnector> = {},
): TalkDataConnector {
  const base = buildDataConnector(input);
  return {
    ...base,
    attachedAt: input.attachedAt ?? '2026-03-06T00:00:10.000Z',
    attachedBy: input.attachedBy ?? 'owner-1',
  };
}

function buildChannelConnection(
  input: Partial<ChannelConnection> = {},
): ChannelConnection {
  return {
    id: input.id ?? 'channel-conn:telegram:system',
    platform: input.platform ?? 'telegram',
    connectionMode: input.connectionMode ?? 'system_managed',
    accountKey: input.accountKey ?? 'telegram:system',
    displayName: input.displayName ?? 'Telegram (System Managed)',
    enabled: input.enabled ?? true,
    healthStatus: input.healthStatus ?? 'healthy',
    lastHealthCheckAt: input.lastHealthCheckAt ?? null,
    lastHealthError: input.lastHealthError ?? null,
    config: input.config ?? { managedBy: 'runtime' },
    tokenSource: input.tokenSource ?? 'db',
    envTokenAvailable: input.envTokenAvailable ?? false,
    hasStoredSecret: input.hasStoredSecret ?? true,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function buildChannelTarget(input: Partial<ChannelTarget> = {}): ChannelTarget {
  return {
    connectionId: input.connectionId ?? 'channel-conn:telegram:system',
    targetKind: input.targetKind ?? 'chat',
    targetId: input.targetId ?? 'tg:group:123',
    displayName: input.displayName ?? 'Cal Football Chat',
    metadata: input.metadata ?? null,
    approved: input.approved ?? true,
    registeredAt: input.registeredAt ?? '2026-03-06T00:00:00.000Z',
    registeredBy: input.registeredBy ?? 'owner-1',
    lastSeenAt: input.lastSeenAt ?? '2026-03-06T00:00:00.000Z',
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
    activeBindingId: input.activeBindingId ?? null,
    activeBindingTalkId: input.activeBindingTalkId ?? null,
    activeBindingTalkTitle: input.activeBindingTalkTitle ?? null,
    activeBindingTalkAccessible: input.activeBindingTalkAccessible ?? false,
  };
}

function buildChannelConnectionApiRecord(connection: ChannelConnection) {
  return {
    id: connection.id,
    platform: connection.platform,
    connection_mode: connection.connectionMode,
    account_key: connection.accountKey,
    display_name: connection.displayName,
    enabled: connection.enabled ? 1 : 0,
    health_status: connection.healthStatus,
    last_health_check_at: connection.lastHealthCheckAt,
    last_health_error: connection.lastHealthError,
    config_json: connection.config ? JSON.stringify(connection.config) : null,
    token_source: connection.tokenSource,
    env_token_available: connection.envTokenAvailable ? 1 : 0,
    has_stored_secret: connection.hasStoredSecret ? 1 : 0,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt,
  };
}

function buildChannelTargetApiRecord(target: ChannelTarget) {
  return {
    connection_id: target.connectionId,
    target_kind: target.targetKind,
    target_id: target.targetId,
    display_name: target.displayName,
    metadata_json: target.metadata ? JSON.stringify(target.metadata) : null,
    approved: target.approved ? 1 : 0,
    registered_at: target.registeredAt,
    registered_by: target.registeredBy,
    last_seen_at: target.lastSeenAt,
    created_at: target.createdAt,
    updated_at: target.updatedAt,
    active_binding_id: target.activeBindingId ?? null,
    active_binding_talk_id: target.activeBindingTalkId ?? null,
    active_binding_talk_title: target.activeBindingTalkTitle ?? null,
    active_binding_talk_accessible: target.activeBindingTalkAccessible ? 1 : 0,
  };
}

function buildTalkChannelBinding(
  input: Partial<TalkChannelBinding> = {},
): TalkChannelBinding {
  return {
    id: input.id ?? 'binding-1',
    talkId: input.talkId ?? 'talk-1',
    connectionId: input.connectionId ?? 'channel-conn:telegram:system',
    platform: input.platform ?? 'telegram',
    connectionDisplayName:
      input.connectionDisplayName ?? 'Telegram (System Managed)',
    connectionHealthStatus: input.connectionHealthStatus ?? 'healthy',
    targetKind: input.targetKind ?? 'chat',
    targetId: input.targetId ?? 'tg:group:123',
    displayName: input.displayName ?? 'Cal Football Chat',
    active: input.active ?? true,
    responseMode: input.responseMode ?? 'mentions',
    responderMode: input.responderMode ?? 'primary',
    responderAgentId: input.responderAgentId ?? null,
    deliveryMode: input.deliveryMode ?? 'reply',
    timezone: input.timezone ?? 'America/Los_Angeles',
    instructions: input.instructions ?? null,
    stateNamespace:
      input.stateNamespace ?? `channel.${input.id ?? 'binding-1'}.`,
    inboundRateLimitPerMinute: input.inboundRateLimitPerMinute ?? 10,
    maxPendingEvents: input.maxPendingEvents ?? 20,
    overflowPolicy: input.overflowPolicy ?? 'drop_oldest',
    maxDeferredAgeMinutes: input.maxDeferredAgeMinutes ?? 10,
    pendingIngressCount: input.pendingIngressCount ?? 1,
    deferredIngressCount: input.deferredIngressCount ?? 0,
    deadLetterCount: input.deadLetterCount ?? 0,
    unresolvedIngressCount: input.unresolvedIngressCount ?? 0,
    suppressedReplyCount: input.suppressedReplyCount ?? 0,
    lastSuppressedAt: input.lastSuppressedAt ?? null,
    lastSuppressionReason: input.lastSuppressionReason ?? null,
    lastIngressAt: input.lastIngressAt ?? null,
    lastDeliveryAt: input.lastDeliveryAt ?? null,
    lastIngressReasonCode: input.lastIngressReasonCode ?? null,
    lastDeliveryReasonCode: input.lastDeliveryReasonCode ?? null,
    healthQuarantined: input.healthQuarantined ?? false,
    healthQuarantineCode: input.healthQuarantineCode ?? null,
    diagnosis: input.diagnosis ?? {
      status: 'ok',
      headline: 'Working normally',
      detail: null,
      action: null,
    },
  };
}

function buildChannelQueueFailure(
  input: Partial<ChannelQueueFailure> = {},
): ChannelQueueFailure {
  return {
    id: input.id ?? 'failure-1',
    bindingId: input.bindingId ?? 'binding-1',
    talkId: input.talkId ?? 'talk-1',
    connectionId: input.connectionId ?? 'channel-conn:telegram:system',
    targetKind: input.targetKind ?? 'chat',
    targetId: input.targetId ?? 'tg:group:123',
    platformEventId: input.platformEventId ?? 'event-1',
    externalMessageId: input.externalMessageId ?? null,
    senderId: input.senderId ?? 'sender-1',
    senderName: input.senderName ?? 'Joe',
    runId: input.runId ?? null,
    talkMessageId: input.talkMessageId ?? null,
    payload: input.payload ?? { text: 'hello' },
    status: input.status ?? 'dead_letter',
    reasonCode: input.reasonCode ?? 'expired_while_busy',
    reasonDetail: input.reasonDetail ?? 'Talk stayed busy too long.',
    dedupeKey: input.dedupeKey ?? 'dedupe-1',
    availableAt: input.availableAt ?? '2026-03-06T00:00:00.000Z',
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
    attemptCount: input.attemptCount ?? 1,
  };
}

function buildContent(input: Partial<Content> = {}): Content {
  return {
    id: input.id ?? 'content-default',
    talkId: input.talkId ?? 'talk-1',
    threadId: input.threadId ?? DEFAULT_THREAD_ID,
    title: input.title ?? 'Untitled doc',
    contentKind: input.contentKind ?? 'document',
    contentFormat: input.contentFormat ?? 'markdown',
    bodyMarkdown: input.bodyMarkdown ?? '',
    bodyHtml:
      input.bodyHtml === undefined
        ? input.contentFormat === 'html'
          ? ''
          : null
        : input.bodyHtml,
    bodyVersion: input.bodyVersion ?? 1,
    anchorMap: input.anchorMap ?? {},
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
    createdByUserId: input.createdByUserId ?? null,
    updatedByUserId: input.updatedByUserId ?? null,
    updatedByRunId: input.updatedByRunId ?? null,
  };
}

function buildContextSource(input: Partial<ContextSource> = {}): ContextSource {
  return {
    id: input.id ?? 'source-1',
    sourceRef: input.sourceRef ?? 'S1',
    sourceType: input.sourceType ?? 'url',
    title: input.title ?? 'Saved URL',
    note: input.note ?? null,
    sourceUrl: input.sourceUrl ?? 'https://example.com/post',
    status: input.status ?? 'failed',
    extractedTextLength: input.extractedTextLength ?? null,
    isTruncated: input.isTruncated ?? false,
    extractionError: input.extractionError ?? 'fetch_http_error: HTTP 403',
    mimeType: input.mimeType ?? null,
    fileName: input.fileName ?? null,
    fileSize: input.fileSize ?? null,
    extractedAt: input.extractedAt ?? null,
    lastFetchedAt: input.lastFetchedAt ?? null,
    fetchStrategy: input.fetchStrategy ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function buildTalkContext(input?: Partial<TalkContext>): TalkContext {
  return {
    goal: input?.goal ?? null,
    rules: input?.rules ?? [],
    sources: input?.sources ?? [],
  };
}

function buildContextRule(input?: Partial<ContextRule>): ContextRule {
  return {
    id: input?.id ?? 'rule-1',
    ruleText: input?.ruleText ?? 'Be concise',
    isActive: input?.isActive ?? true,
    sortOrder: input?.sortOrder ?? 0,
    createdAt: input?.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input?.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function buildTalkStateEntry(input?: Partial<TalkStateEntry>): TalkStateEntry {
  return {
    id: input?.id ?? 'state-1',
    key: input?.key ?? 'decision',
    value: input?.value ?? { winner: 'Claude' },
    version: input?.version ?? 1,
    updatedAt: input?.updatedAt ?? '2026-03-06T00:00:00.000Z',
    updatedByUserId: input?.updatedByUserId ?? 'owner-1',
    updatedByRunId: input?.updatedByRunId ?? null,
  };
}

function buildTalkJob(input?: Partial<TalkJob>): TalkJob {
  return {
    id: input?.id ?? 'job-1',
    talkId: input?.talkId ?? 'talk-1',
    title: input?.title ?? 'Daily FTUE Brief',
    prompt: input?.prompt ?? 'Check FTUE metrics.',
    targetAgentId: input?.targetAgentId ?? 'agent-claude',
    targetAgentNickname: input?.targetAgentNickname ?? 'Claude Sonnet 4.6',
    status: input?.status ?? 'active',
    schedule: input?.schedule ?? {
      kind: 'weekly',
      weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
      hour: 9,
      minute: 0,
    },
    timezone: input?.timezone ?? 'America/Los_Angeles',
    sourceScope: input?.sourceScope ?? {
      connectorIds: [],
      channelBindingIds: [],
      allowWeb: false,
    },
    threadId: input?.threadId ?? 'thread-job-1',
    lastRunAt: input?.lastRunAt ?? null,
    lastRunStatus: input?.lastRunStatus ?? null,
    nextDueAt: input?.nextDueAt ?? '2026-03-07T17:00:00.000Z',
    runCount: input?.runCount ?? 0,
    createdAt: input?.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input?.updatedAt ?? '2026-03-06T00:00:00.000Z',
    createdBy: input?.createdBy ?? 'owner-1',
  };
}

function buildTalkJobRunSummary(
  input?: Partial<TalkJobRunSummary>,
): TalkJobRunSummary {
  return {
    id: input?.id ?? 'job-run-1',
    threadId: input?.threadId ?? 'thread-job-1',
    status: input?.status ?? 'completed',
    createdAt: input?.createdAt ?? '2026-03-06T09:00:00.000Z',
    startedAt: input?.startedAt ?? '2026-03-06T09:00:01.000Z',
    completedAt: input?.completedAt ?? '2026-03-06T09:00:10.000Z',
    triggerMessageId: input?.triggerMessageId ?? 'msg-job-1',
    responseExcerpt: input?.responseExcerpt ?? 'Daily summary complete.',
    errorCode: input?.errorCode ?? null,
    errorMessage: input?.errorMessage ?? null,
    cancelReason: input?.cancelReason ?? null,
    executorAlias: input?.executorAlias ?? null,
    executorModel: input?.executorModel ?? null,
  };
}

function buildAiAgentsData(): AiAgentsPageData {
  return {
    defaultClaudeModelId: 'claude-sonnet-4-6',
    claudeModelSuggestions: [
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
        supportsVision: true,
      },
      {
        modelId: 'claude-opus-4-6',
        displayName: 'Claude Opus 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
        supportsVision: true,
      },
    ],
    additionalProviders: [
      {
        id: 'provider.openai',
        name: 'OpenAI',
        providerKind: 'openai',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://api.openai.com/v1',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: true,
        credentialHint: '••••MINI',
        verificationStatus: 'verified',
        lastVerifiedAt: '2026-03-06T00:00:00.000Z',
        lastVerificationError: null,
        workspaceHasCredential: false,
        workspaceCredentialHint: null,
        workspaceVerificationStatus: 'missing',
        workspaceLastVerifiedAt: null,
        workspaceLastVerificationError: null,
        hasPersonalSubscription: false,
        personalSubscriptionExpiresAt: null,
        hasWorkspaceSubscription: false,
        workspaceSubscriptionExpiresAt: null,
        modelSuggestions: [
          {
            modelId: 'gpt-5-mini',
            displayName: 'GPT-5 Mini',
            contextWindowTokens: 128000,
            defaultMaxOutputTokens: 4096,
            supportsVision: true,
          },
        ],
      },
    ],
  };
}

function installTalkDetailFetch(input?: {
  talk?: Talk;
  threads?: TalkThread[];
  messages?: TalkMessage[];
  runs?: TalkRun[];
  runContextSnapshots?: Record<string, TalkRunContextSnapshot | null>;
  talkAgents?: TalkAgent[];
  registeredAgents?: RegisteredAgent[];
  context?: TalkContext;
  stateEntries?: TalkStateEntry[];
  jobs?: TalkJob[];
  jobRunsByJobId?: Record<string, TalkJobRunSummary[]>;
  rulePatchError?: {
    status: number;
    code?: string;
    message: string;
  };
  ruleDeleteError?: {
    status: number;
    code?: string;
    message: string;
  };
  dataConnectors?: DataConnector[];
  talkDataConnectors?: TalkDataConnector[];
  channelConnections?: ChannelConnection[];
  channelTargets?: ChannelTarget[];
  talkChannels?: TalkChannelBinding[];
  ingressFailures?: ChannelQueueFailure[];
  deliveryFailures?: ChannelQueueFailure[];
  aiAgents?: AiAgentsPageData;
  // Doc-pane integration: pre-existing content keyed by threadId, plus
  // optional spies so tests can assert on POST and PATCH bodies.
  contentByThreadId?: Record<string, Content>;
  onCreateContent?: (body: {
    talkId: string | null;
    threadId: string | null;
    title: string;
    format?: string;
  }) => Content;
  onPatchContent?: (body: {
    contentId: string;
    expectedVersion: number;
    title?: string;
    bodyMarkdown?: string;
    bodyHtml?: string;
  }) => Content;
  onPutAgents?: (body: SavedTalkAgentRequest) => TalkAgent[];
  onGetContext?: () => TalkContext;
  onCreateContextSource?: (body: {
    sourceType: ContextSource['sourceType'];
    title: string;
    sourceUrl?: string | null;
    extractedText?: string | null;
  }) => ContextSource;
  onRetryContextSource?: (sourceId: string) => ContextSource;
  onUploadAttachment?: (formData: FormData) => TalkMessageAttachment;
  onSendMessage?: (body: {
    content: string;
    targetAgentIds: string[];
    attachmentIds?: string[];
    threadId?: string | null;
  }) => { talkId: string; message: TalkMessage; runs: TalkRun[] };
  onTestChannel?: (
    bindingId: string,
  ) => { status: number; code?: string; message: string } | void;
  onSyncSlackWorkspace?: (input: {
    connectionId: string;
    channelConnections: ChannelConnection[];
    channelTargets: ChannelTarget[];
  }) => {
    channelConnections?: ChannelConnection[];
    channelTargets?: ChannelTarget[];
    syncedCount?: number;
    publicCount?: number;
    privateCount?: number;
  } | void;
  onListMessages?: (input: {
    threadId: string | null;
    visibleMessages: TalkMessage[];
  }) => Promise<TalkMessage[]> | TalkMessage[];
}) {
  const talk = input?.talk ?? buildTalk();
  let messages = input?.messages ?? [
    buildMessage({
      id: 'msg-1',
      role: 'user',
      content: 'How will Cal do next season?',
      createdAt: '2026-03-06T00:00:00.000Z',
    }),
  ];
  let threads = input?.threads ?? [
    buildThread({
      id: DEFAULT_THREAD_ID,
      talkId: 'talk-1',
      title: null,
      isDefault: true,
      messageCount: messages.filter(
        (message) => message.threadId === DEFAULT_THREAD_ID,
      ).length,
      lastMessageAt:
        messages
          .filter((message) => message.threadId === DEFAULT_THREAD_ID)
          .at(-1)?.createdAt ?? null,
    }),
  ];
  let runs = input?.runs ?? [
    buildRun({
      id: 'run-1',
      status: 'completed',
      createdAt: '2026-03-06T00:00:01.000Z',
      completedAt: '2026-03-06T00:00:03.000Z',
      triggerMessageId: 'msg-1',
      targetAgentId: 'agent-openai',
      targetAgentNickname: 'GPT-5 Mini',
    }),
  ];
  const runContextSnapshots = input?.runContextSnapshots ?? {};
  const talkAgents = input?.talkAgents ?? [
    buildTalkAgent({
      id: 'agent-claude',
      nickname: 'Claude Sonnet 4.6',
      sourceKind: 'claude_default',
      role: 'assistant',
      isPrimary: true,
      displayOrder: 0,
      health: 'ready',
      providerId: null,
      modelId: 'claude-sonnet-4-6',
      modelDisplayName: 'Claude Sonnet 4.6',
    }),
    buildTalkAgent({
      id: 'agent-openai',
      nickname: 'GPT-5 Mini',
      sourceKind: 'provider',
      role: 'critic',
      isPrimary: false,
      displayOrder: 1,
      health: 'invalid',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      modelDisplayName: 'GPT-5 Mini',
    }),
  ];
  const registeredAgents = input?.registeredAgents ?? [
    buildRegisteredAgent({
      id: 'agent-claude',
      name: 'Claude Sonnet 4.6',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
    }),
    buildRegisteredAgent({
      id: 'agent-claude-opus',
      name: 'Claude Opus 4.6',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
    }),
    buildRegisteredAgent({
      id: 'agent-openai',
      name: 'GPT-5 Mini',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      personaRole: 'critic',
    }),
  ];
  const dataConnectors = input?.dataConnectors ?? [
    buildDataConnector({
      id: 'connector-posthog',
      name: 'FTUE PostHog',
      connectorKind: 'posthog',
      hasCredential: true,
      verificationStatus: 'not_verified',
      attachedTalkCount: 1,
    }),
    buildDataConnector({
      id: 'connector-sheet',
      name: 'Economy Sheet',
      connectorKind: 'google_sheets',
      hasCredential: true,
      verificationStatus: 'verified',
    }),
  ];
  let talkDataConnectors = input?.talkDataConnectors ?? [
    buildTalkDataConnector({
      ...dataConnectors[0],
      attachedAt: '2026-03-06T00:00:10.000Z',
    }),
  ];
  let context = input?.context ?? buildTalkContext();
  let stateEntries = input?.stateEntries ?? [];
  let jobs = input?.jobs ?? [buildTalkJob()];
  let jobRunsByJobId = input?.jobRunsByJobId ?? {
    'job-1': [buildTalkJobRunSummary()],
  };
  let channelConnections = input?.channelConnections ?? [
    buildChannelConnection(),
  ];
  let channelTargets = input?.channelTargets ?? [buildChannelTarget()];
  let talkChannels = input?.talkChannels ?? [buildTalkChannelBinding()];
  let ingressFailures = input?.ingressFailures ?? [buildChannelQueueFailure()];
  let deliveryFailures = input?.deliveryFailures ?? [
    buildChannelQueueFailure({
      id: 'failure-delivery-1',
      reasonCode: 'delivery_retries_exhausted',
      reasonDetail: 'Telegram delivery exhausted retries.',
    }),
  ];
  const aiAgents = input?.aiAgents ?? buildAiAgentsData();
  const contentByThreadId: Record<string, Content> = {
    ...(input?.contentByThreadId ?? {}),
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request instanceof Request
              ? request.url
              : String(request);
      const method = init?.method || 'GET';
      const parsedUrl = new URL(url, 'http://localhost');
      const path = parsedUrl.pathname;

      if (path === '/api/v1/talks/talk-1' && method === 'GET') {
        return jsonResponse(200, { ok: true, data: { talk } });
      }

      if (path === '/api/v1/talks/talk-1' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          orchestrationMode?: Talk['orchestrationMode'];
        };
        if (body.orchestrationMode) {
          talk.orchestrationMode = body.orchestrationMode;
        }
        return jsonResponse(200, { ok: true, data: { talk } });
      }

      if (path === '/api/v1/talks/talk-1/threads' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            threads: threads.map(toThreadApiRecord),
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/threads' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          title?: string | null;
        };
        const created = buildThread({
          id: `thread-${threads.length + 1}`,
          talkId: 'talk-1',
          title: body.title?.trim() || null,
          isDefault: false,
          createdAt: '2026-03-06T00:00:12.000Z',
          updatedAt: '2026-03-06T00:00:12.000Z',
          messageCount: 0,
          lastMessageAt: null,
        });
        threads = [created, ...threads];
        return jsonResponse(201, {
          ok: true,
          data: {
            thread: toThreadApiRecord(created),
          },
        });
      }

      if (
        path.startsWith('/api/v1/talks/talk-1/threads/') &&
        method === 'PATCH'
      ) {
        const threadId = decodeURIComponent(path.split('/').pop() || '');
        const body = JSON.parse(String(init?.body || '{}')) as {
          title?: string | null;
          pinned?: boolean;
        };
        threads = threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                title: body.title?.trim() || thread.title,
                isPinned:
                  typeof body.pinned === 'boolean'
                    ? body.pinned
                    : thread.isPinned,
                updatedAt: '2026-03-06T00:00:13.000Z',
              }
            : thread,
        );
        const updated =
          threads.find((thread) => thread.id === threadId) || threads[0];
        return jsonResponse(200, {
          ok: true,
          data: {
            id: updated.id,
            talk_id: updated.talkId,
            title: updated.title,
            is_default: updated.isDefault ? 1 : 0,
            is_pinned: updated.isPinned ? 1 : 0,
            created_at: updated.createdAt,
            updated_at: updated.updatedAt,
          },
        });
      }

      if (
        path.startsWith('/api/v1/talks/talk-1/threads/') &&
        method === 'DELETE'
      ) {
        const threadId = decodeURIComponent(path.split('/').pop() || '');
        threads = threads.filter((thread) => thread.id !== threadId);
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (path === '/api/v1/talks/talk-1/messages/search' && method === 'GET') {
        const query = parsedUrl.searchParams.get('q')?.trim() || '';
        const limit = Number(parsedUrl.searchParams.get('limit') || '20');
        const lowered = query.toLowerCase();
        const results =
          query.length === 0
            ? []
            : messages
                .filter((message) =>
                  message.content.toLowerCase().includes(lowered),
                )
                .slice(0, Number.isFinite(limit) ? limit : 20)
                .map((message) => ({
                  messageId: message.id,
                  threadId: message.threadId,
                  threadTitle:
                    threads.find((thread) => thread.id === message.threadId)
                      ?.title ?? null,
                  role: message.role,
                  createdAt: message.createdAt,
                  preview: message.content.slice(0, 140),
                }));
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            query,
            results,
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/messages' && method === 'GET') {
        const threadId = parsedUrl.searchParams.get('threadId');
        const visibleMessages = threadId
          ? messages.filter((message) => message.threadId === threadId)
          : messages;
        const responseMessages = input?.onListMessages
          ? await input.onListMessages({ threadId, visibleMessages })
          : visibleMessages;
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            messages: responseMessages,
            page: {
              limit: 100,
              count: responseMessages.length,
              beforeCreatedAt: null,
            },
          },
        });
      }

      if (
        path === '/api/v1/talks/talk-1/messages/delete' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          messageIds?: string[];
          threadId?: string | null;
        };
        const deletedMessageIds = Array.isArray(body.messageIds)
          ? body.messageIds
          : [];
        messages = messages.filter(
          (message) =>
            !(
              deletedMessageIds.includes(message.id) &&
              message.threadId === body.threadId
            ),
        );
        threads = threads.map((thread) => {
          if (thread.id !== body.threadId) return thread;
          const threadMessages = messages.filter(
            (message) => message.threadId === thread.id,
          );
          return {
            ...thread,
            messageCount: threadMessages.length,
            lastMessageAt: threadMessages.at(-1)?.createdAt ?? null,
          };
        });
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            deletedCount: deletedMessageIds.length,
            deletedMessageIds,
          },
        });
      }

      if (
        url.endsWith('/api/v1/talks/talk-1/attachments') &&
        method === 'POST'
      ) {
        if (!(init?.body instanceof FormData)) {
          throw new Error('Expected attachment uploads to use FormData');
        }

        const file = init.body.get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected file payload for attachment upload');
        }

        const attachment =
          input?.onUploadAttachment?.(init.body) ??
          buildMessageAttachment({
            id: 'att-1',
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type,
            extractionStatus: 'ready',
          });

        return jsonResponse(201, {
          ok: true,
          data: { attachment },
        });
      }

      if (path === '/api/v1/talks/talk-1/runs' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            runs,
          },
        });
      }

      if (path === '/api/v1/browser/setup' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          siteKey?: string;
          accountLabel?: string | null;
          url?: string | null;
        };
        return jsonResponse(200, {
          ok: true,
          data: {
            status: 'ok',
            siteKey: body.siteKey ?? 'linkedin',
            accountLabel: body.accountLabel ?? null,
            sessionId: 'session-browser-1',
            url: body.url ?? 'https://www.linkedin.com/login',
            title: 'LinkedIn',
            reusedSession: false,
            createdProfile: false,
            message: 'Browser setup session opened.',
          },
        });
      }

      const browserTakeoverMatch = path.match(
        /^\/api\/v1\/browser\/sessions\/([^/]+)\/takeover$/,
      );
      if (browserTakeoverMatch && method === 'POST') {
        const sessionId = decodeURIComponent(browserTakeoverMatch[1] || '');
        return jsonResponse(200, {
          ok: true,
          data: {
            sessionId,
            siteKey: 'linkedin',
            accountLabel: null,
            headed: true,
            state: 'takeover',
            owner: 'user',
            blockedKind: 'human_step_required',
            blockedMessage: 'Complete the step manually.',
            currentUrl: 'https://www.linkedin.com/feed/',
            currentTitle: 'LinkedIn',
            lastUpdatedAt: '2026-03-20T20:40:00.000Z',
          },
        });
      }

      const browserResumeMatch = path.match(
        /^\/api\/v1\/browser\/runs\/([^/]+)\/resume$/,
      );
      if (browserResumeMatch && method === 'POST') {
        const runId = decodeURIComponent(browserResumeMatch[1] || '');
        runs = runs.map((run) =>
          run.id === runId
            ? {
                ...run,
                status: 'queued',
                browserBlock: null,
                browserResume: {
                  kind: 'human_step_completed',
                  resumedAt: '2026-03-20T20:41:00.000Z',
                  resumedBy: 'user-1',
                  sessionId: run.browserBlock?.sessionId ?? null,
                  confirmationId: run.browserBlock?.confirmationId ?? null,
                  note: null,
                  pendingToolCall: run.browserBlock?.pendingToolCall ?? null,
                },
              }
            : run,
        );
        return jsonResponse(200, {
          ok: true,
          data: {
            runId,
            resumed: true,
            browserResume: runs.find((run) => run.id === runId)?.browserResume,
          },
        });
      }

      const browserApproveMatch = path.match(
        /^\/api\/v1\/browser\/confirmations\/([^/]+)\/approve$/,
      );
      if (browserApproveMatch && method === 'POST') {
        const confirmationId = decodeURIComponent(browserApproveMatch[1] || '');
        const run = runs.find(
          (entry) => entry.browserBlock?.confirmationId === confirmationId,
        );
        if (run) {
          runs = runs.map((entry) =>
            entry.id === run.id
              ? {
                  ...entry,
                  status: 'queued',
                  browserBlock: null,
                  browserResume: {
                    kind: 'confirmation_approved',
                    resumedAt: '2026-03-20T20:42:00.000Z',
                    resumedBy: 'user-1',
                    sessionId: run.browserBlock?.sessionId ?? null,
                    confirmationId,
                    note: null,
                    pendingToolCall: run.browserBlock?.pendingToolCall ?? null,
                  },
                }
              : entry,
          );
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            confirmationId,
            runId: run?.id ?? 'run-missing',
            approved: true,
            browserResume: runs.find((entry) => entry.id === run?.id)
              ?.browserResume,
          },
        });
      }

      const browserRejectMatch = path.match(
        /^\/api\/v1\/browser\/confirmations\/([^/]+)\/reject$/,
      );
      if (browserRejectMatch && method === 'POST') {
        const confirmationId = decodeURIComponent(browserRejectMatch[1] || '');
        const run = runs.find(
          (entry) => entry.browserBlock?.confirmationId === confirmationId,
        );
        if (run) {
          runs = runs.map((entry) =>
            entry.id === run.id
              ? {
                  ...entry,
                  status: 'cancelled',
                  browserBlock: null,
                }
              : entry,
          );
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            confirmationId,
            runId: run?.id ?? 'run-missing',
            rejected: true,
          },
        });
      }

      const runContextMatch = path.match(
        /^\/api\/v1\/talks\/talk-1\/runs\/([^/]+)\/context$/,
      );
      if (runContextMatch && method === 'GET') {
        const runId = decodeURIComponent(runContextMatch[1] || '');
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            runId,
            contextSnapshot: Object.prototype.hasOwnProperty.call(
              runContextSnapshots,
              runId,
            )
              ? (runContextSnapshots[runId] ?? null)
              : null,
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/agents' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', agents: talkAgents },
        });
      }

      if (path === '/api/v1/registered-agents' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: registeredAgents,
        });
      }

      if (path === '/api/v1/talks/talk-1/context' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: input?.onGetContext?.() ?? context,
        });
      }

      if (
        path === '/api/v1/talks/talk-1/context/sources' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          sourceType?: ContextSource['sourceType'];
          title?: string;
          sourceUrl?: string | null;
          extractedText?: string | null;
        };
        const created =
          input?.onCreateContextSource?.({
            sourceType: body.sourceType ?? 'url',
            title: body.title?.trim() || 'New source',
            sourceUrl: body.sourceUrl,
            extractedText: body.extractedText,
          }) ??
          buildContextSource({
            id: `source-${context.sources.length + 1}`,
            sourceRef: `S${context.sources.length + 1}`,
            sourceType: body.sourceType ?? 'url',
            title: body.title?.trim() || 'New source',
            sourceUrl:
              body.sourceType === 'url'
                ? (body.sourceUrl?.trim() ?? 'https://example.com/source')
                : null,
            status: body.sourceType === 'text' ? 'ready' : 'pending',
            extractedTextLength:
              body.sourceType === 'text'
                ? (body.extractedText?.trim().length ?? 0)
                : null,
          });
        context = {
          ...context,
          sources: [...context.sources, created],
        };
        return jsonResponse(201, {
          ok: true,
          data: { source: created },
        });
      }

      if (path === '/api/v1/talks/talk-1/state' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { entries: stateEntries },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/state\/[^/]+$/.test(path) &&
        method === 'DELETE'
      ) {
        const key = decodeURIComponent(
          path.split('/api/v1/talks/talk-1/state/')[1],
        );
        const before = stateEntries.length;
        stateEntries = stateEntries.filter((entry) => entry.key !== key);
        if (stateEntries.length === before) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'State entry not found.' },
          });
        }
        return jsonResponse(200, { ok: true, data: { deleted: true } });
      }

      if (path === '/api/v1/talks/talk-1/jobs' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { jobs },
        });
      }

      if (path === '/api/v1/talks/talk-1/jobs' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          title?: string;
          prompt?: string;
          targetAgentId?: string;
          schedule?: TalkJob['schedule'];
          timezone?: string;
          sourceScope?: TalkJob['sourceScope'];
        };
        const created = buildTalkJob({
          id: `job-${jobs.length + 1}`,
          title: body.title?.trim() || 'Untitled Job',
          prompt: body.prompt?.trim() || '',
          targetAgentId: body.targetAgentId ?? 'agent-claude',
          schedule: body.schedule ?? {
            kind: 'weekly',
            weekdays: ['mon'],
            hour: 9,
            minute: 0,
          },
          timezone: body.timezone ?? 'America/Los_Angeles',
          sourceScope: body.sourceScope ?? {
            connectorIds: [],
            channelBindingIds: [],
            allowWeb: false,
          },
          threadId: `thread-job-${jobs.length + 1}`,
        });
        jobs = [created, ...jobs];
        jobRunsByJobId[created.id] = [];
        return jsonResponse(201, {
          ok: true,
          data: { job: created },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/jobs\/[^/]+$/.test(path) &&
        method === 'PATCH'
      ) {
        const jobId = path.split('/api/v1/talks/talk-1/jobs/')[1];
        const body = JSON.parse(String(init?.body || '{}')) as Partial<TalkJob>;
        jobs = jobs.map((job) =>
          job.id === jobId ? buildTalkJob({ ...job, ...body }) : job,
        );
        return jsonResponse(200, {
          ok: true,
          data: { job: jobs.find((job) => job.id === jobId) },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/jobs\/[^/]+$/.test(path) &&
        method === 'DELETE'
      ) {
        const jobId = path.split('/api/v1/talks/talk-1/jobs/')[1];
        jobs = jobs.filter((job) => job.id !== jobId);
        delete jobRunsByJobId[jobId];
        return jsonResponse(200, { ok: true, data: { deleted: true } });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/jobs\/[^/]+\/runs$/.test(path) &&
        method === 'GET'
      ) {
        const jobId = path
          .split('/api/v1/talks/talk-1/jobs/')[1]!
          .replace('/runs', '');
        return jsonResponse(200, {
          ok: true,
          data: { runs: jobRunsByJobId[jobId] ?? [] },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/jobs\/[^/]+\/pause$/.test(path) &&
        method === 'POST'
      ) {
        const jobId = path
          .split('/api/v1/talks/talk-1/jobs/')[1]!
          .replace('/pause', '');
        jobs = jobs.map((job) =>
          job.id === jobId ? { ...job, status: 'paused' } : job,
        );
        return jsonResponse(200, {
          ok: true,
          data: { job: jobs.find((job) => job.id === jobId) },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/jobs\/[^/]+\/resume$/.test(path) &&
        method === 'POST'
      ) {
        const jobId = path
          .split('/api/v1/talks/talk-1/jobs/')[1]!
          .replace('/resume', '');
        jobs = jobs.map((job) =>
          job.id === jobId ? { ...job, status: 'active' } : job,
        );
        return jsonResponse(200, {
          ok: true,
          data: { job: jobs.find((job) => job.id === jobId) },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/jobs\/[^/]+\/run-now$/.test(path) &&
        method === 'POST'
      ) {
        const jobId = path
          .split('/api/v1/talks/talk-1/jobs/')[1]!
          .replace('/run-now', '');
        const run = buildTalkJobRunSummary({
          id: `job-run-${(jobRunsByJobId[jobId] ?? []).length + 1}`,
          status: 'queued',
          responseExcerpt: null,
        });
        jobRunsByJobId = {
          ...jobRunsByJobId,
          [jobId]: [run, ...(jobRunsByJobId[jobId] ?? [])],
        };
        return jsonResponse(202, {
          ok: true,
          data: {
            job: jobs.find((job) => job.id === jobId),
            runId: run.id,
            triggerMessageId: 'msg-job-run',
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/context/rules' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          ruleText?: string;
        };
        const created = buildContextRule({
          id: `rule-${context.rules.length + 1}`,
          ruleText: body.ruleText?.trim() || 'New rule',
          sortOrder: context.rules.length,
        });
        context = {
          ...context,
          rules: [...context.rules, created],
        };
        return jsonResponse(201, {
          ok: true,
          data: { rule: created },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/context\/rules\/[^/]+$/.test(url) &&
        method === 'PATCH'
      ) {
        if (input?.rulePatchError) {
          return jsonResponse(input.rulePatchError.status, {
            ok: false,
            error: {
              code: input.rulePatchError.code,
              message: input.rulePatchError.message,
            },
          });
        }
        const ruleId = url.split('/api/v1/talks/talk-1/context/rules/')[1];
        const body = JSON.parse(String(init?.body || '{}')) as Partial<
          Pick<ContextRule, 'ruleText' | 'isActive' | 'sortOrder'>
        >;
        let updatedRule: ContextRule | undefined;
        context = {
          ...context,
          rules: context.rules.map((rule) => {
            if (rule.id !== ruleId) return rule;
            updatedRule = {
              ...rule,
              ...(body.ruleText === undefined
                ? null
                : { ruleText: body.ruleText.trim() }),
              ...(body.isActive === undefined
                ? null
                : { isActive: body.isActive }),
              ...(body.sortOrder === undefined
                ? null
                : { sortOrder: body.sortOrder }),
              updatedAt: '2026-03-06T00:00:30.000Z',
            };
            return updatedRule;
          }),
        };
        return jsonResponse(200, {
          ok: true,
          data: { rule: updatedRule },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/context\/rules\/[^/]+$/.test(url) &&
        method === 'DELETE'
      ) {
        if (input?.ruleDeleteError) {
          return jsonResponse(input.ruleDeleteError.status, {
            ok: false,
            error: {
              code: input.ruleDeleteError.code,
              message: input.ruleDeleteError.message,
            },
          });
        }
        const ruleId = url.split('/api/v1/talks/talk-1/context/rules/')[1];
        context = {
          ...context,
          rules: context.rules.filter((rule) => rule.id !== ruleId),
        };
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (url.endsWith('/api/v1/channel-connections') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            connections: channelConnections.map(
              buildChannelConnectionApiRecord,
            ),
          },
        });
      }

      if (
        /\/api\/v1\/channel-connectors\/slack\/workspaces\/[^/]+\/sync$/.test(
          path,
        ) &&
        method === 'POST'
      ) {
        const connectionId = decodeURIComponent(
          path
            .split('/api/v1/channel-connectors/slack/workspaces/')[1]
            .split('/sync')[0],
        );
        const syncResult = input?.onSyncSlackWorkspace?.({
          connectionId,
          channelConnections,
          channelTargets,
        });
        if (syncResult?.channelConnections) {
          channelConnections = syncResult.channelConnections;
        }
        if (syncResult?.channelTargets) {
          channelTargets = syncResult.channelTargets;
        }
        const syncedTargets = channelTargets.filter(
          (target) => target.connectionId === connectionId,
        );
        const publicCount = syncedTargets.filter(
          (target) => target.metadata?.isPrivate !== true,
        ).length;
        const privateCount = syncedTargets.length - publicCount;
        const syncedCount = syncedTargets.length;
        channelConnections = channelConnections.map((connection) =>
          connection.id === connectionId
            ? {
                ...connection,
                config: {
                  ...(connection.config ?? {}),
                  lastSyncedAt: '2026-03-21T23:45:00.000Z',
                  lastSyncTotalCount: syncResult?.syncedCount ?? syncedCount,
                  lastSyncPublicCount: syncResult?.publicCount ?? publicCount,
                  lastSyncPrivateCount:
                    syncResult?.privateCount ?? privateCount,
                },
              }
            : connection,
        );
        return jsonResponse(200, {
          ok: true,
          data: {
            syncedCount: syncResult?.syncedCount ?? syncedCount,
            publicCount: syncResult?.publicCount ?? publicCount,
            privateCount: syncResult?.privateCount ?? privateCount,
          },
        });
      }

      if (
        url.includes('/api/v1/channel-connections/') &&
        url.includes('/targets') &&
        method === 'GET'
      ) {
        const parsed = new URL(url, 'http://localhost');
        const connectionId = decodeURIComponent(
          url.split('/api/v1/channel-connections/')[1].split('/targets')[0],
        );
        const approval = parsed.searchParams.get('approval');
        const query = (parsed.searchParams.get('query') || '')
          .trim()
          .toLowerCase();
        const limit = Number(parsed.searchParams.get('limit') || '100');
        const offset = Number(parsed.searchParams.get('offset') || '0');
        let filtered = channelTargets.filter(
          (target) => target.connectionId === connectionId,
        );
        if (approval === 'approved') {
          filtered = filtered.filter((target) => target.approved);
        } else if (approval === 'discovered') {
          filtered = filtered.filter((target) => !target.approved);
        }
        if (query) {
          filtered = filtered.filter((target) => {
            const haystack = [
              target.displayName,
              target.targetId,
              target.connectionId,
            ]
              .join(' ')
              .toLowerCase();
            return haystack.includes(query);
          });
        }
        const pageTargets = filtered.slice(offset, offset + limit);
        return jsonResponse(200, {
          ok: true,
          data: {
            targets: pageTargets.map(buildChannelTargetApiRecord),
            totalCount: filtered.length,
            hasMore: offset + pageTargets.length < filtered.length,
            nextOffset:
              offset + pageTargets.length < filtered.length
                ? offset + pageTargets.length
                : null,
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/channels' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            bindings: talkChannels.filter(
              (binding) => binding.talkId === 'talk-1',
            ),
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/channels' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        const connectionId = String(
          body.connectionId || 'channel-conn:telegram:system',
        );
        const targetKind = String(body.targetKind || 'chat');
        const targetId = String(
          body.targetId || `tg:group:${talkChannels.length + 100}`,
        );
        const existingBinding = talkChannels.find(
          (binding) =>
            binding.connectionId === connectionId &&
            binding.targetKind === targetKind &&
            binding.targetId === targetId &&
            binding.active,
        );
        if (existingBinding) {
          return jsonResponse(409, {
            ok: false,
            error: {
              code: 'target_already_bound',
              message: `${existingBinding.displayName} is already bound.`,
            },
          });
        }
        const matchingConnection = channelConnections.find(
          (connection) => connection.id === connectionId,
        );
        const created = buildTalkChannelBinding({
          id: `binding-${talkChannels.length + 1}`,
          talkId: 'talk-1',
          connectionId,
          platform: matchingConnection?.platform ?? 'telegram',
          connectionDisplayName:
            matchingConnection?.displayName ?? 'Telegram (System Managed)',
          targetKind,
          targetId,
          displayName: String(
            body.displayName ||
              channelTargets.find(
                (target) =>
                  target.connectionId === connectionId &&
                  target.targetKind === targetKind &&
                  target.targetId === targetId,
              )?.displayName ||
              'New Channel Binding',
          ),
          responseMode:
            (body.responseMode as TalkChannelBinding['responseMode']) ??
            'mentions',
          responderMode:
            (body.responderMode as TalkChannelBinding['responderMode']) ??
            'primary',
          responderAgentId:
            body.responderAgentId == null
              ? null
              : String(body.responderAgentId),
          deliveryMode:
            (body.deliveryMode as TalkChannelBinding['deliveryMode']) ??
            'reply',
          timezone:
            body.timezone == null
              ? 'America/Los_Angeles'
              : String(body.timezone),
          instructions:
            body.instructions == null ? null : String(body.instructions),
          stateNamespace: `channel.binding-${talkChannels.length + 1}.`,
          inboundRateLimitPerMinute: Number(
            body.inboundRateLimitPerMinute || 10,
          ),
          maxPendingEvents: Number(body.maxPendingEvents || 20),
          overflowPolicy:
            (body.overflowPolicy as TalkChannelBinding['overflowPolicy']) ??
            'drop_oldest',
          maxDeferredAgeMinutes: Number(body.maxDeferredAgeMinutes || 10),
        });
        talkChannels = [...talkChannels, created];
        return jsonResponse(201, {
          ok: true,
          data: { binding: created },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+$/.test(url) &&
        method === 'PATCH'
      ) {
        const bindingId = url.split('/api/v1/talks/talk-1/channels/')[1];
        const patch = JSON.parse(
          String(init?.body || '{}'),
        ) as Partial<TalkChannelBinding>;
        talkChannels = talkChannels.map((binding) =>
          binding.id === bindingId
            ? {
                ...binding,
                ...patch,
                responseMode: patch.responseMode ?? binding.responseMode,
                timezone:
                  patch.timezone === undefined
                    ? binding.timezone
                    : patch.timezone == null
                      ? 'America/Los_Angeles'
                      : String(patch.timezone),
                instructions:
                  patch.instructions === undefined
                    ? binding.instructions
                    : patch.instructions,
              }
            : binding,
        );
        return jsonResponse(200, {
          ok: true,
          data: {
            binding: talkChannels.find((binding) => binding.id === bindingId),
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+$/.test(url) &&
        method === 'DELETE'
      ) {
        const bindingId = url.split('/api/v1/talks/talk-1/channels/')[1];
        talkChannels = talkChannels.filter(
          (binding) => binding.id !== bindingId,
        );
        ingressFailures = ingressFailures.filter(
          (failure) => failure.bindingId !== bindingId,
        );
        deliveryFailures = deliveryFailures.filter(
          (failure) => failure.bindingId !== bindingId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/test$/.test(url) &&
        method === 'POST'
      ) {
        const bindingId = url
          .split('/api/v1/talks/talk-1/channels/')[1]
          .split('/')[0];
        const testResult = input?.onTestChannel?.(bindingId);
        if (testResult) {
          return jsonResponse(testResult.status, {
            ok: false,
            error: {
              code: testResult.code ?? 'channel_test_failed',
              message: testResult.message,
            },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: { sent: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/state$/.test(url) &&
        method === 'GET'
      ) {
        const bindingId = url
          .split('/api/v1/talks/talk-1/channels/')[1]
          .split('/state')[0];
        const binding = talkChannels.find(
          (candidate) => candidate.id === bindingId,
        );
        const stateNamespace =
          binding?.stateNamespace ?? `channel.${bindingId}.`;
        return jsonResponse(200, {
          ok: true,
          data: {
            stateNamespace,
            entries: stateEntries
              .filter((entry) => entry.key.startsWith(stateNamespace))
              .map((entry) => ({
                id: entry.id,
                key: entry.key,
                keySuffix: entry.key.slice(stateNamespace.length),
                value: entry.value,
                version: entry.version,
                updatedAt: entry.updatedAt,
                updatedByUserId: entry.updatedByUserId,
                updatedByRunId: entry.updatedByRunId,
              })),
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/state$/.test(url) &&
        method === 'POST'
      ) {
        const bindingId = url
          .split('/api/v1/talks/talk-1/channels/')[1]
          .split('/state')[0];
        const binding = talkChannels.find(
          (candidate) => candidate.id === bindingId,
        );
        const stateNamespace =
          binding?.stateNamespace ?? `channel.${bindingId}.`;
        const body = JSON.parse(String(init?.body || '{}')) as {
          keySuffix?: string;
          value?: unknown;
        };
        const keySuffix = String(body.keySuffix || '');
        const key = `${stateNamespace}${keySuffix}`;
        const existing = stateEntries.find((entry) => entry.key === key);
        const updated = buildTalkStateEntry({
          id: existing?.id ?? `state-${stateEntries.length + 1}`,
          key,
          value: body.value ?? null,
          version: (existing?.version ?? 0) + 1,
        });
        stateEntries = [
          ...stateEntries.filter((entry) => entry.key !== key),
          updated,
        ];
        return jsonResponse(200, {
          ok: true,
          data: {
            entry: {
              id: updated.id,
              key: updated.key,
              keySuffix,
              value: updated.value,
              version: updated.version,
              updatedAt: updated.updatedAt,
              updatedByUserId: updated.updatedByUserId,
              updatedByRunId: updated.updatedByRunId,
            },
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/state$/.test(url) &&
        method === 'DELETE'
      ) {
        const bindingId = url
          .split('/api/v1/talks/talk-1/channels/')[1]
          .split('/state')[0];
        const binding = talkChannels.find(
          (candidate) => candidate.id === bindingId,
        );
        const stateNamespace =
          binding?.stateNamespace ?? `channel.${bindingId}.`;
        const body = JSON.parse(String(init?.body || '{}')) as {
          keySuffix?: string;
        };
        const keySuffix = String(body.keySuffix || '');
        stateEntries = stateEntries.filter(
          (entry) => entry.key !== `${stateNamespace}${keySuffix}`,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (
        path === '/api/v1/talks/talk-1/channel-instruction-review' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          instructions?: string;
          timezone?: string | null;
        };
        return jsonResponse(200, {
          ok: true,
          data: {
            review: {
              strengths: ['Clear scope and reply policy.'],
              missing:
                body.instructions?.includes('timezone') || body.timezone
                  ? []
                  : ['Add an explicit timezone or reset rule.'],
              removeOrSimplify: [],
              rewrittenInstructions: body.instructions
                ? `${String(body.instructions).trim()}\n\nUse list_state before creating new state keys.`
                : null,
            },
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/ingress-failures$/.test(
          url,
        ) &&
        method === 'GET'
      ) {
        const bindingId = url
          .split('/api/v1/talks/talk-1/channels/')[1]
          .split('/')[0];
        return jsonResponse(200, {
          ok: true,
          data: {
            failures: ingressFailures.filter(
              (failure) => failure.bindingId === bindingId,
            ),
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/delivery-failures$/.test(
          url,
        ) &&
        method === 'GET'
      ) {
        const bindingId = url
          .split('/api/v1/talks/talk-1/channels/')[1]
          .split('/')[0];
        return jsonResponse(200, {
          ok: true,
          data: {
            failures: deliveryFailures.filter(
              (failure) => failure.bindingId === bindingId,
            ),
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/ingress-failures\/[^/]+\/retry$/.test(
          url,
        ) &&
        method === 'POST'
      ) {
        const rowId = url.split('/ingress-failures/')[1].split('/')[0];
        ingressFailures = ingressFailures.filter(
          (failure) => failure.id !== rowId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { retried: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/delivery-failures\/[^/]+\/retry$/.test(
          url,
        ) &&
        method === 'POST'
      ) {
        const rowId = url.split('/delivery-failures/')[1].split('/')[0];
        deliveryFailures = deliveryFailures.filter(
          (failure) => failure.id !== rowId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { retried: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/ingress-failures\/[^/]+$/.test(
          url,
        ) &&
        method === 'DELETE'
      ) {
        const rowId = url.split('/ingress-failures/')[1];
        ingressFailures = ingressFailures.filter(
          (failure) => failure.id !== rowId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/delivery-failures\/[^/]+$/.test(
          url,
        ) &&
        method === 'DELETE'
      ) {
        const rowId = url.split('/delivery-failures/')[1];
        deliveryFailures = deliveryFailures.filter(
          (failure) => failure.id !== rowId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (path === '/api/v1/talks/talk-1/data-connectors' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', connectors: talkDataConnectors },
        });
      }

      if (
        path === '/api/v1/talks/talk-1/data-connectors' &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          connectorId: string;
        };
        const source = dataConnectors.find(
          (connector) => connector.id === body.connectorId,
        );
        if (!source) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'Data connector not found.' },
          });
        }
        const attached = buildTalkDataConnector({
          ...source,
          attachedAt: '2026-03-06T00:00:12.000Z',
        });
        talkDataConnectors = [...talkDataConnectors, attached];
        return jsonResponse(200, {
          ok: true,
          data: { connector: attached },
        });
      }

      if (
        url.includes('/api/v1/talks/talk-1/data-connectors/') &&
        method === 'DELETE'
      ) {
        const connectorId = url.split(
          '/api/v1/talks/talk-1/data-connectors/',
        )[1];
        talkDataConnectors = talkDataConnectors.filter(
          (connector) => connector.id !== connectorId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (url.endsWith('/api/v1/data-connectors') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { connectors: dataConnectors },
        });
      }

      if (url.endsWith('/api/v1/agents') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: aiAgents });
      }

      if (path === '/api/v1/talks/talk-1/agents' && method === 'PUT') {
        const body = JSON.parse(
          String(init?.body || '{}'),
        ) as SavedTalkAgentRequest;
        const saved =
          input?.onPutAgents?.(body) ??
          body.agents.map((agent, index) => ({
            ...agent,
            displayOrder: index,
            health:
              agent.sourceKind === 'claude_default'
                ? 'ready'
                : agent.providerId === 'provider.openai'
                  ? 'invalid'
                  : 'unknown',
          }));
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', agents: saved },
        });
      }

      if (path === '/api/v1/talks/talk-1/chat' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          content: string;
          targetAgentIds: string[];
          attachmentIds?: string[];
          threadId?: string | null;
        };
        const payload = input?.onSendMessage?.(body) ?? {
          talkId: 'talk-1',
          message: buildMessage({
            id: 'msg-posted',
            threadId: body.threadId ?? DEFAULT_THREAD_ID,
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: body.targetAgentIds.map((agentId, index, all) =>
            buildRun({
              id: `run-${index + 10}`,
              threadId: body.threadId ?? DEFAULT_THREAD_ID,
              responseGroupId: all.length > 1 ? 'group-default-send' : null,
              sequenceIndex: all.length > 1 ? index : null,
              status: 'queued',
              createdAt: `2026-03-06T00:00:0${index + 6}.000Z`,
              triggerMessageId: 'msg-posted',
              targetAgentId: agentId,
              targetAgentNickname:
                agentId === 'agent-claude' ? 'Claude Sonnet 4.6' : 'GPT-5 Mini',
            }),
          ),
        };
        const threadId = payload.message.threadId;
        const threadMessages = [...messages, payload.message]
          .filter((message) => message.threadId === threadId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        threads = threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                title: thread.title,
                messageCount: threadMessages.length,
                lastMessageAt: threadMessages.at(-1)?.createdAt ?? null,
              }
            : thread,
        );
        return jsonResponse(200, { ok: true, data: payload });
      }

      if (path === '/api/v1/talks/talk-1/chat/cancel' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          threadId?: string | null;
        };
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            cancelledRuns: body.threadId ? 1 : 2,
          },
        });
      }

      if (
        url.includes('/api/v1/talks/talk-1/context/sources/') &&
        url.endsWith('/retry') &&
        method === 'POST'
      ) {
        const sourceId = url
          .split('/api/v1/talks/talk-1/context/sources/')[1]
          .replace('/retry', '');
        const updated =
          input?.onRetryContextSource?.(sourceId) ??
          buildContextSource({
            id: sourceId,
            status: 'pending',
            extractionError: null,
          });
        context = {
          ...context,
          sources: context.sources.map((source) =>
            source.id === sourceId ? updated : source,
          ),
        };
        return jsonResponse(200, {
          ok: true,
          data: { source: updated },
        });
      }

      // ── Content (doc-pane) routes ────────────────────────────────
      if (path === '/api/v1/talks/talk-1/content' && method === 'GET') {
        // Talk-scoped GET resolves to the default thread's content.
        const content = contentByThreadId[DEFAULT_THREAD_ID] ?? null;
        return jsonResponse(200, {
          ok: true,
          data: { content, pendingEdits: [] },
        });
      }
      if (path === '/api/v1/talks/talk-1/content' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          title: string;
          format?: string;
        };
        const content =
          input?.onCreateContent?.({
            talkId: 'talk-1',
            threadId: null,
            title: body.title,
            format: body.format,
          }) ??
          buildContent({
            id: 'content-default',
            talkId: 'talk-1',
            threadId: DEFAULT_THREAD_ID,
            title: body.title,
            contentFormat:
              (body.format as Content['contentFormat']) ?? 'markdown',
          });
        contentByThreadId[content.threadId] = content;
        return jsonResponse(201, { ok: true, data: { content } });
      }
      const threadContentMatch = path.match(
        /^\/api\/v1\/threads\/([^/]+)\/content$/,
      );
      if (threadContentMatch && method === 'GET') {
        const threadId = decodeURIComponent(threadContentMatch[1]);
        const content = contentByThreadId[threadId] ?? null;
        return jsonResponse(200, {
          ok: true,
          data: { content, pendingEdits: [] },
        });
      }
      if (threadContentMatch && method === 'POST') {
        const threadId = decodeURIComponent(threadContentMatch[1]);
        const body = JSON.parse(String(init?.body || '{}')) as {
          title: string;
          format?: string;
        };
        const content =
          input?.onCreateContent?.({
            talkId: null,
            threadId,
            title: body.title,
            format: body.format,
          }) ??
          buildContent({
            id: `content-${threadId}`,
            talkId: 'talk-1',
            threadId,
            title: body.title,
            contentFormat:
              (body.format as Content['contentFormat']) ?? 'markdown',
          });
        contentByThreadId[threadId] = content;
        return jsonResponse(201, { ok: true, data: { content } });
      }
      const patchContentMatch = path.match(/^\/api\/v1\/contents\/([^/]+)$/);
      if (patchContentMatch && method === 'PATCH') {
        const contentId = decodeURIComponent(patchContentMatch[1]);
        const body = JSON.parse(String(init?.body || '{}')) as {
          expectedVersion: number;
          title?: string;
          bodyMarkdown?: string;
          bodyHtml?: string;
        };
        // Resolve the row by id and apply the patch in memory.
        const threadId = Object.keys(contentByThreadId).find(
          (tid) => contentByThreadId[tid].id === contentId,
        );
        if (!threadId) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'Content not found.' },
          });
        }
        const current = contentByThreadId[threadId];
        const next: Content = input?.onPatchContent?.({
          contentId,
          expectedVersion: body.expectedVersion,
          title: body.title,
          bodyMarkdown: body.bodyMarkdown,
          bodyHtml: body.bodyHtml,
        }) ?? {
          ...current,
          title: body.title ?? current.title,
          bodyMarkdown: body.bodyMarkdown ?? current.bodyMarkdown,
          bodyHtml:
            typeof body.bodyHtml === 'string'
              ? body.bodyHtml
              : current.bodyHtml,
          bodyVersion: current.bodyVersion + 1,
        };
        contentByThreadId[threadId] = next;
        return jsonResponse(200, {
          ok: true,
          data: { content: next, acceptedPendingEditIds: [] },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
