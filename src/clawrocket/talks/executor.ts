export interface TalkJobExecutionPolicy {
  jobId: string;
  allowedConnectorIds: string[];
  allowedChannelBindingIds: string[];
  allowWeb: boolean;
  allowStateMutation: boolean;
  allowOutputWrite: boolean;
}

export interface TalkExecutorInput {
  runId: string;
  talkId: string;
  threadId: string;
  requestedBy: string;
  triggerMessageId: string;
  triggerContent: string;
  jobId?: string | null;
  targetAgentId?: string | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
}

export interface TalkExecutionUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export interface TalkResponseCompletionMetadata {
  completionStatus: 'complete' | 'incomplete';
  providerStopReason?: string | null;
  incompleteReason?: 'truncated' | 'empty' | 'unknown' | null;
}

export type TalkExecutionEvent =
  | {
      type: 'talk_response_started';
      runId: string;
      talkId: string;
      threadId?: string | null;
      agentId?: string | null;
      agentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
    }
  | {
      type: 'talk_response_delta';
      runId: string;
      talkId: string;
      threadId?: string | null;
      agentId?: string | null;
      agentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
      deltaText: string;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
    }
  | {
      type: 'talk_progress_update';
      runId: string;
      talkId: string;
      threadId?: string | null;
      agentId?: string | null;
      agentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
      message: string;
    }
  | {
      type: 'talk_response_usage';
      runId: string;
      talkId: string;
      threadId?: string | null;
      agentId?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
      usage: TalkExecutionUsage;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
    }
  | {
      type: 'talk_response_completed';
      runId: string;
      talkId: string;
      threadId?: string | null;
      agentId?: string | null;
      agentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
      usage?: TalkExecutionUsage;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
      completion?: TalkResponseCompletionMetadata;
    }
  | {
      type: 'talk_response_failed';
      runId: string;
      talkId: string;
      threadId?: string | null;
      agentId?: string | null;
      agentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
      errorCode: string;
      errorMessage: string;
      completion?: TalkResponseCompletionMetadata;
    }
  | {
      type: 'talk_response_cancelled';
      runId: string;
      talkId: string;
      threadId?: string | null;
      agentId?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    };

export interface TalkExecutorOutput {
  content: string;
  metadataJson?: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  usage?: TalkExecutionUsage;
  responseSequenceInRun?: number | null;
  completion?: TalkResponseCompletionMetadata | null;
}

export class TalkExecutorError extends Error {
  readonly code: string;
  readonly sourceMessage: string;
  readonly metadata: Record<string, unknown> | null;

  constructor(
    code: string,
    message: string,
    options?: {
      sourceMessage?: string;
      metadata?: Record<string, unknown> | null;
    },
  ) {
    super(message);
    this.code = code;
    this.sourceMessage = options?.sourceMessage || message;
    this.metadata = options?.metadata ?? null;
    this.name = 'TalkExecutorError';
  }
}

export interface TalkExecutor {
  execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput>;
}
