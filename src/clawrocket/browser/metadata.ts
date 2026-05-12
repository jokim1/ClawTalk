import type { BrowserBlockedKind, BrowserSessionState } from './service.js';
import type {
  ExecutionBackend,
  ExecutionCredentialSource,
  ExecutionRouteReason,
} from '../agents/execution-planner.js';

export interface BrowserBlockArtifact {
  attachmentId?: string | null;
  path?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  label?: string | null;
}

export interface BrowserPendingToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface BrowserBlockMetadata {
  kind: BrowserBlockedKind;
  sessionId: string | null;
  siteKey: string;
  accountLabel: string | null;
  conflictingRunId?: string | null;
  conflictingSessionId?: string | null;
  conflictingRunSummary?: string | null;
  url: string;
  title: string;
  message: string;
  riskReason: string | null;
  setupCommand: string | null;
  artifacts: BrowserBlockArtifact[];
  confirmationId: string | null;
  pendingToolCall: BrowserPendingToolCall | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserResumeMetadata {
  kind:
    | 'auth_completed'
    | 'confirmation_approved'
    | 'confirmation_rejected'
    | 'human_step_completed';
  resumedAt: string;
  resumedBy: string | null;
  sessionId: string | null;
  confirmationId: string | null;
  note: string | null;
  pendingToolCall: BrowserPendingToolCall | null;
}

export interface ExecutionDecisionMetadata {
  backend: ExecutionBackend;
  authPath: 'api_key' | 'subscription' | 'host_login' | 'none';
  credentialSource: ExecutionCredentialSource;
  routeReason: ExecutionRouteReason;
  plannerReason: string;
  providerId: string;
  modelId: string;
}

export type MainRunLeaseState =
  | 'cold_boot'
  | 'warm_reuse'
  | 'recovered_cold_boot'
  | 'one_shot_fallback';

export interface MainRunTimingMetadata {
  queueStartedAt?: string | null;
  executorStartedAt?: string | null;
  leaseRequestedAt?: string | null;
  leaseReadyAt?: string | null;
  taskDispatchedAt?: string | null;
  firstProviderEventAt?: string | null;
  firstTokenAt?: string | null;
  firstBrowserEventAt?: string | null;
  firstPageReadyAt?: string | null;
  blockedAt?: string | null;
  completedAt?: string | null;
}

export interface CarriedBrowserSessionMetadata {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  lastKnownState: BrowserSessionState;
  blockedKind: BrowserBlockedKind | null;
  lastKnownUrl: string;
  lastKnownTitle: string;
  lastUpdatedAt: string;
}
