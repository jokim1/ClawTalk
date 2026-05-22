import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bodyFallback,
  formatElapsed,
  LiveResponsePanel,
  pillClassForState,
  pillLabelForState,
  resolvePillState,
  truncateNickname,
  type LiveResponsePanelProps,
  type PillState,
} from './LiveResponsePanel';
import type { LiveResponseView, RunView } from '../pages/TalkDetailPage';

afterEach(() => {
  cleanup();
});

function makeResponse(
  overrides: Partial<LiveResponseView> = {},
): LiveResponseView {
  return {
    runId: 'run-1',
    rawText: '',
    text: '',
    queuedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    pendingStatus: 'queued',
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunView> = {}): RunView {
  const base = {
    id: 'run-1',
    talkId: 'talk-1',
    threadId: 'thread-1',
    status: 'queued',
    createdAt: '2026-05-21T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    targetAgentId: 'agent-1',
    targetAgentNickname: 'Sonnet',
    triggerMessageId: 'msg-1',
    responseGroupId: null,
    sequenceIndex: null,
    errorCode: null,
    errorMessage: null,
    cancelReason: null,
    executorAlias: null,
    executorModel: null,
    runKind: 'conversation',
    updatedAt: 0,
  } as unknown as RunView;
  return { ...base, ...overrides };
}

function makeProps(
  overrides: Partial<LiveResponsePanelProps> = {},
): LiveResponsePanelProps {
  const response = overrides.response ?? makeResponse();
  return {
    response,
    run: overrides.run ?? makeRun(),
    agentLabel: 'Sonnet',
    isDense: false,
    now: 1_700_000_003_000,
    canRetryAgent: false,
    retryPosting: false,
    retryError: null,
    onRetry: () => {},
    onOpenRunHistory: () => {},
    panelKey: 'run-1',
    ...overrides,
  };
}

describe('LiveResponsePanel helpers', () => {
  it('pillLabelForState maps every state to a utility label', () => {
    const cases: Array<[PillState, string]> = [
      ['queued', 'Queued'],
      ['running', 'Running'],
      ['reconnecting', 'Reconnecting'],
      ['completed', 'Done'],
      ['failed', 'Failed'],
      ['cancelled', 'Cancelled'],
    ];
    for (const [state, label] of cases) {
      expect(pillLabelForState(state)).toBe(label);
    }
  });

  it('pillClassForState reuses .run-history-status-* classes', () => {
    expect(pillClassForState('queued')).toContain('run-history-status-queued');
    expect(pillClassForState('reconnecting')).toContain(
      'run-history-status-queued',
    );
    expect(pillClassForState('running')).toContain('run-history-status-running');
    expect(pillClassForState('completed')).toContain(
      'run-history-status-completed',
    );
    expect(pillClassForState('failed')).toContain('run-history-status-failed');
    expect(pillClassForState('cancelled')).toContain(
      'run-history-status-cancelled',
    );
  });

  it('formatElapsed switches to M:SS at 60s with zero-padded seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(3_000)).toBe('3s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(272_000)).toBe('4:32');
  });

  it('bodyFallback prefers text > progressMessage > status-aware copy', () => {
    expect(bodyFallback('queued', makeResponse({ text: 'hello' }))).toBe(
      'hello',
    );
    expect(
      bodyFallback('running', makeResponse({ progressMessage: 'thinking' })),
    ).toBe('thinking');
    expect(bodyFallback('queued', makeResponse())).toBe('Queued for dispatch');
    expect(bodyFallback('running', makeResponse())).toBe('Starting up…');
    expect(bodyFallback('reconnecting', makeResponse())).toBe(
      'Reconnecting to stream…',
    );
    expect(bodyFallback('failed', makeResponse())).toBeNull();
    expect(bodyFallback('cancelled', makeResponse())).toBeNull();
  });

  it('truncateNickname keeps short labels and truncates long ones with ellipsis', () => {
    expect(truncateNickname('Sonnet')).toEqual({
      display: 'Sonnet',
      full: 'Sonnet',
    });
    const longName = 'Claude Sonnet 4.6 (extended thinking, 1M context)';
    const result = truncateNickname(longName);
    expect(result.full).toBe(longName);
    expect(result.display.length).toBeLessThanOrEqual(18);
    expect(result.display.endsWith('…')).toBe(true);
  });

  it('resolvePillState gives terminal precedence over pendingStatus', () => {
    expect(
      resolvePillState(
        makeResponse({ pendingStatus: 'running', terminalStatus: 'failed' }),
        undefined,
      ),
    ).toBe('failed');
    expect(
      resolvePillState(
        makeResponse({ pendingStatus: 'queued' }),
        makeRun({ status: 'cancelled' }),
      ),
    ).toBe('cancelled');
    expect(
      resolvePillState(
        makeResponse({ pendingStatus: 'reconnecting' }),
        undefined,
      ),
    ).toBe('reconnecting');
  });
});

describe('LiveResponsePanel render', () => {
  it('shows Queued pill with elapsed seconds when state is queued', () => {
    render(
      <LiveResponsePanel
        {...makeProps({
          response: makeResponse({ pendingStatus: 'queued' }),
          now: 1_700_000_003_000,
        })}
      />,
    );
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText(/3s/)).toBeTruthy();
  });

  it('shows M:SS format past 60s with tabular-nums on the elapsed span', () => {
    const { container } = render(
      <LiveResponsePanel
        {...makeProps({
          response: makeResponse({ pendingStatus: 'running' }),
          run: makeRun({ status: 'running' }),
          now: 1_700_000_000_000 + 65_000,
        })}
      />,
    );
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText(/1:05/)).toBeTruthy();
    // elapsed span must be aria-hidden and use the .elapsed class (CSS
    // applies tabular-nums there).
    const elapsedSpan = container.querySelector('span.elapsed');
    expect(elapsedSpan).toBeTruthy();
    expect(elapsedSpan?.getAttribute('aria-hidden')).toBe('true');
  });

  it('hides body and adds is-dense class when isDense is true and not terminal', () => {
    const { container } = render(
      <LiveResponsePanel
        {...makeProps({
          response: makeResponse({ pendingStatus: 'queued' }),
          isDense: true,
        })}
      />,
    );
    expect(container.querySelector('article.is-dense')).toBeTruthy();
    // Body would say "Queued for dispatch" if rendered; the CSS hides it
    // via .message-live.is-dense p { display: none }, but the React tree
    // still includes the <p>. Assert the CSS class is set so the rule applies.
    expect(container.querySelector('article.message-live')).toBeTruthy();
  });

  it('terminal state never uses is-dense even when isDense=true', () => {
    const { container } = render(
      <LiveResponsePanel
        {...makeProps({
          response: makeResponse({ terminalStatus: 'completed' }),
          run: makeRun({ status: 'completed' }),
          isDense: true,
        })}
      />,
    );
    expect(container.querySelector('article.is-dense')).toBeNull();
  });

  it('truncates long agent label and keeps full name in title attribute', () => {
    const longName = 'Claude Sonnet 4.6 (extended thinking, 1M context)';
    render(<LiveResponsePanel {...makeProps({ agentLabel: longName })} />);
    const labelEl = screen.getByText(/Claude Sonnet/);
    expect(labelEl.getAttribute('title')).toBe(longName);
    expect(labelEl.textContent?.endsWith('…')).toBe(true);
  });

  it('shows Failed pill with retained elapsed and surfaces Retry + Open Run History when retry-eligible', () => {
    render(
      <LiveResponsePanel
        {...makeProps({
          response: makeResponse({
            terminalStatus: 'failed',
            errorMessage: 'Queue retries exhausted; run failed.',
          }),
          run: makeRun({ status: 'failed', errorCode: 'incomplete_response' }),
          now: 1_700_000_000_000 + 12_000,
          canRetryAgent: true,
        })}
      />,
    );
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText(/12s/)).toBeTruthy();
    expect(
      screen.getByText('Queue retries exhausted; run failed.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry agent' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Open Run History' }),
    ).toBeTruthy();
  });

  it('aria-label reflects state and updates when state changes, not on every tick', () => {
    const baseResponse = makeResponse({ pendingStatus: 'queued' });
    const { rerender, container } = render(
      <LiveResponsePanel
        {...makeProps({ response: baseResponse, now: 1_700_000_000_000 })}
      />,
    );
    const article = container.querySelector('article');
    const initialAria = article?.getAttribute('aria-label');
    expect(initialAria?.toLowerCase()).toContain('queued');

    // Tick `now` forward — pill text changes, but for queued state with no
    // sub-second granularity we expect no aria-label change because the
    // label is derived from state, not from elapsed.
    rerender(
      <LiveResponsePanel
        {...makeProps({ response: baseResponse, now: 1_700_000_005_000 })}
      />,
    );
    expect(article?.getAttribute('aria-label')).toBe(initialAria);

    // State change → aria-label must update.
    rerender(
      <LiveResponsePanel
        {...makeProps({
          response: makeResponse({ pendingStatus: 'running' }),
          run: makeRun({ status: 'running' }),
          now: 1_700_000_005_000,
        })}
      />,
    );
    expect(article?.getAttribute('aria-label')?.toLowerCase()).toContain(
      'running',
    );
  });
});
