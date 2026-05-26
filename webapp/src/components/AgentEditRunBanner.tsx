// Sticky banner that surfaces the active pending edit run on a Talk's
// attached doc. Mirrors the Google Docs Suggested Edits pattern: one
// banner per run, with bulk Accept all / Reject all on the right.
//
// Streaming state: when content_edit_run_started arrives but no
// content_edit_applied has landed yet, banner renders with a spinner
// and "Kimi is editing…". Once content_edit_applied arrives (or the
// page loads with pending edits already present), banner switches to
// the resolved state: agent monogram + change-count summary + buttons.
//
// Per plan D10: bulk runs hide the per-change gutter controls and only
// expose Accept all / Reject all here.

import { useMemo } from 'react';

import { Check, X } from 'lucide-react';

import {
  getPendingRunSummary,
  type ContentEditRow,
} from '../../../src/shared/rich-text/index.js';

export interface AgentEditRunBannerProps {
  pendingEdits: ContentEditRow[];
  runId: string;
  // Streaming state: present while content_edit_run_started fired but
  // no content_edit_applied yet. When non-null, render the spinner row.
  streamingAgentNickname?: string | null;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  isAcceptInFlight: boolean;
  isRejectInFlight: boolean;
}

function pluralize(n: number, singular: string, plural?: string): string {
  if (n === 1) return `${n} ${singular}`;
  return `${n} ${plural ?? `${singular}s`}`;
}

function summarizeCounts(counts: {
  insert: number;
  replace: number;
  delete: number;
  bulk: number;
}): string {
  const parts: string[] = [];
  if (counts.bulk > 0) parts.push('bulk rewrite');
  if (counts.insert > 0) parts.push(pluralize(counts.insert, 'added'));
  if (counts.replace > 0) parts.push(pluralize(counts.replace, 'rewritten'));
  if (counts.delete > 0) parts.push(pluralize(counts.delete, 'deleted'));
  return parts.join(' · ');
}

export function AgentEditRunBanner(
  props: AgentEditRunBannerProps,
): JSX.Element | null {
  const summary = useMemo(
    () => getPendingRunSummary(props.pendingEdits, props.runId),
    [props.pendingEdits, props.runId],
  );

  // Streaming state — no rows yet but agent has started.
  if (!summary && props.streamingAgentNickname) {
    return (
      <div
        className="agent-edit-run-banner agent-edit-run-banner--streaming"
        role="status"
        aria-live="polite"
      >
        <div className="agent-edit-run-banner-info">
          <span className="agent-edit-run-banner-spinner" aria-hidden="true" />
          <span className="agent-edit-run-banner-title">
            {props.streamingAgentNickname} is editing…
          </span>
        </div>
      </div>
    );
  }

  if (!summary || summary.counts.total === 0) return null;

  const totalLabel = pluralize(summary.counts.total, 'change');
  const countsLabel = summarizeCounts(summary.counts);
  const agentLabel = summary.agentNickname ?? 'Agent';
  const rationale = summary.rationale ?? null;
  const inFlight = props.isAcceptInFlight || props.isRejectInFlight;

  return (
    <div className="agent-edit-run-banner" role="region" aria-label="Agent edit run">
      <div className="agent-edit-run-banner-info">
        <span className="agent-edit-run-banner-monogram" aria-hidden="true">
          {agentLabel.slice(0, 1).toUpperCase()}
        </span>
        <span className="agent-edit-run-banner-title">
          {agentLabel} made {totalLabel}
        </span>
        {countsLabel ? (
          <span className="agent-edit-run-banner-counts">· {countsLabel}</span>
        ) : null}
        {rationale ? (
          <span
            className="agent-edit-run-banner-rationale"
            title={rationale}
          >
            · “{rationale}”
          </span>
        ) : null}
      </div>
      <div className="agent-edit-run-banner-actions">
        <button
          type="button"
          className="agent-edit-run-banner-button agent-edit-run-banner-button--primary"
          onClick={props.onAcceptAll}
          disabled={inFlight}
          aria-label="Accept all changes in this edit run"
        >
          <Check size={14} aria-hidden="true" />
          <span>Accept all</span>
        </button>
        <button
          type="button"
          className="agent-edit-run-banner-button"
          onClick={props.onRejectAll}
          disabled={inFlight}
          aria-label="Reject all changes in this edit run"
        >
          <X size={14} aria-hidden="true" />
          <span>Reject all</span>
        </button>
      </div>
    </div>
  );
}
