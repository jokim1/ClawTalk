import { memo } from 'react';

import type { LiveResponseView, RunView } from '../pages/TalkDetailPage';
import { ExecutionDecisionSummary } from './ExecutionDecisionSummary';

const NICKNAME_MAX_CHARS = 18;

export type PillState =
  | 'queued'
  | 'running'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export function resolvePillState(
  response: LiveResponseView,
  run: RunView | undefined,
): PillState {
  if (response.terminalStatus === 'failed' || run?.status === 'failed') {
    return 'failed';
  }
  if (response.terminalStatus === 'cancelled' || run?.status === 'cancelled') {
    return 'cancelled';
  }
  if (response.terminalStatus === 'completed' || run?.status === 'completed') {
    return 'completed';
  }
  if (response.pendingStatus === 'reconnecting') return 'reconnecting';
  if (response.pendingStatus === 'queued' || run?.status === 'queued') {
    return 'queued';
  }
  return 'running';
}

export function pillLabelForState(state: PillState): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'reconnecting':
      return 'Reconnecting';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function pillClassForState(state: PillState): string {
  switch (state) {
    case 'queued':
    case 'reconnecting':
      return 'run-history-status run-history-status-queued';
    case 'running':
      return 'run-history-status run-history-status-running';
    case 'completed':
      return 'run-history-status run-history-status-completed';
    case 'failed':
      return 'run-history-status run-history-status-failed';
    case 'cancelled':
      return 'run-history-status run-history-status-cancelled';
  }
}

export function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function bodyFallback(
  state: PillState,
  response: LiveResponseView,
): string | null {
  if (response.text) return response.text;
  if (response.progressMessage) return response.progressMessage;
  switch (state) {
    case 'queued':
      return 'Queued for dispatch';
    case 'running':
      return 'Starting up…';
    case 'reconnecting':
      return 'Reconnecting to stream…';
    case 'completed':
      return 'Done';
    case 'failed':
    case 'cancelled':
      return null;
  }
}

export function truncateNickname(label: string): {
  display: string;
  full: string;
} {
  if (label.length <= NICKNAME_MAX_CHARS) {
    return { display: label, full: label };
  }
  return { display: `${label.slice(0, NICKNAME_MAX_CHARS - 1)}…`, full: label };
}

export interface LiveResponsePanelProps {
  response: LiveResponseView;
  run: RunView | undefined;
  agentLabel: string;
  isDense: boolean;
  now: number;
  canRetryAgent: boolean;
  retryPosting: boolean;
  retryError: string | null;
  onRetry: () => void;
  onOpenRunHistory: () => void;
  panelKey: string;
}

function LiveResponsePanelImpl(props: LiveResponsePanelProps): JSX.Element {
  const {
    response,
    run,
    agentLabel,
    isDense,
    now,
    canRetryAgent,
    retryPosting,
    retryError,
    onRetry,
    onOpenRunHistory,
  } = props;

  const state = resolvePillState(response, run);
  const isTerminal =
    state === 'completed' || state === 'failed' || state === 'cancelled';
  const elapsedMs = now - response.queuedAt;
  const elapsedLabel = formatElapsed(elapsedMs);
  const pillLabel = pillLabelForState(state);
  const pillClass = pillClassForState(state);
  const body = bodyFallback(state, response);
  const { display: displayLabel, full: fullLabel } = truncateNickname(
    agentLabel,
  );

  const articleClass = [
    'message message-assistant message-live',
    state === 'failed' ? 'message-error' : '',
    isDense && !isTerminal ? 'is-dense' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const ariaLabel = `${fullLabel}, ${pillLabel.toLowerCase()}`;

  return (
    <article
      className={articleClass}
      aria-label={ariaLabel}
      aria-live="polite"
    >
      <header>
        <strong title={fullLabel} className="message-live-label">
          {displayLabel}
        </strong>
        <span className={pillClass}>
          {pillLabel}
          <span aria-hidden="true" className="elapsed">
            {' · '}
            {elapsedLabel}
          </span>
        </span>
      </header>
      {body ? <p>{body}</p> : null}
      {response.errorMessage ? (
        <p className="run-history-error">{response.errorMessage}</p>
      ) : null}
      {state === 'failed' ? (
        <ExecutionDecisionSummary executionDecision={run?.executionDecision} />
      ) : null}
      {state === 'failed' ? (
        <div className="run-history-links">
          {canRetryAgent ? (
            <button
              type="button"
              className="run-history-link"
              onClick={onRetry}
              disabled={retryPosting}
            >
              {retryPosting ? 'Retrying…' : 'Retry agent'}
            </button>
          ) : null}
          <button
            type="button"
            className="run-history-link"
            onClick={onOpenRunHistory}
          >
            Open Run History
          </button>
        </div>
      ) : null}
      {retryError ? <p className="run-history-error">{retryError}</p> : null}
    </article>
  );
}

export const LiveResponsePanel = memo(
  LiveResponsePanelImpl,
  (prev, next): boolean => {
    // Re-render whenever response/run identity changes.
    if (prev.response !== next.response) return false;
    if (prev.run !== next.run) return false;
    if (prev.agentLabel !== next.agentLabel) return false;
    if (prev.isDense !== next.isDense) return false;
    if (prev.canRetryAgent !== next.canRetryAgent) return false;
    if (prev.retryPosting !== next.retryPosting) return false;
    if (prev.retryError !== next.retryError) return false;
    if (prev.onRetry !== next.onRetry) return false;
    if (prev.onOpenRunHistory !== next.onOpenRunHistory) return false;
    // Tick `now` only forces re-render when the panel is non-terminal —
    // terminal panels freeze their elapsed display.
    const prevState = resolvePillState(prev.response, prev.run);
    const prevTerminal =
      prevState === 'completed' ||
      prevState === 'failed' ||
      prevState === 'cancelled';
    if (prevTerminal) return true;
    return prev.now === next.now;
  },
);
