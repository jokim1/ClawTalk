export type LlmApiFormat = 'anthropic_messages' | 'openai_chat_completions';

export type LlmCoreCompatibility = 'none' | 'claude_sdk_proxy';

export type LlmAuthScheme = 'x_api_key' | 'bearer';

export type LlmProviderKind =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'kimi'
  | 'nvidia'
  | 'custom';

export interface LlmProviderRecord {
  id: string;
  name: string;
  provider_kind: LlmProviderKind;
  api_format: LlmApiFormat;
  base_url: string;
  auth_scheme: LlmAuthScheme;
  enabled: number;
  core_compatibility: LlmCoreCompatibility;
  response_start_timeout_ms: number | null;
  stream_idle_timeout_ms: number | null;
  absolute_timeout_ms: number | null;
  updated_at: string;
  updated_by: string | null;
}

export interface LlmProviderModelRecord {
  provider_id: string;
  model_id: string;
  display_name: string;
  context_window_tokens: number;
  default_max_output_tokens: number;
  supports_tools: number;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
}

export interface LlmProviderSecretRecord {
  provider_id: string;
  ciphertext: string;
  updated_at: string;
  updated_by: string | null;
}

export type LlmProviderVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable';

export interface LlmProviderVerificationRecord {
  provider_id: string;
  status: LlmProviderVerificationStatus;
  last_verified_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface TalkRouteRecord {
  id: string;
  name: string;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
}

export interface TalkRouteStepRecord {
  route_id: string;
  position: number;
  provider_id: string;
  model_id: string;
}

export type TalkPersonaRole =
  | 'assistant'
  | 'analyst'
  | 'critic'
  | 'strategist'
  | 'devils-advocate'
  | 'synthesizer'
  | 'editor';

export type TalkAgentSourceKind = 'claude_default' | 'provider';
export type TalkAgentNicknameMode = 'auto' | 'custom';

export interface TalkAgentRecord {
  id: string;
  talk_id: string;
  name: string;
  nickname_mode: TalkAgentNicknameMode;
  source_kind: TalkAgentSourceKind;
  persona_role: TalkPersonaRole;
  route_id: string;
  registered_agent_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  is_primary: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface RegisteredAgentRecord {
  id: string;
  name: string;
  provider_id: string;
  model_id: string;
  route_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export type LlmAttemptStatus = 'success' | 'failed' | 'skipped' | 'cancelled';

export type LlmFailureClass =
  | 'timeout'
  | 'network'
  | 'upstream_5xx'
  | 'retryable_429'
  | 'quota_exhausted'
  | 'auth'
  | 'configuration'
  | 'invalid_request'
  | 'policy'
  | 'unknown';

export interface LlmAttemptRecord {
  id: number;
  run_id: string;
  talk_id: string;
  agent_id: string | null;
  route_id: string | null;
  route_step_position: number | null;
  provider_id: string | null;
  model_id: string | null;
  status: LlmAttemptStatus;
  failure_class: LlmFailureClass | null;
  latency_ms: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  created_at: string;
}

export interface TalkRouteUsageCounts {
  assignedAgentCount: number;
  assignedTalkCount: number;
}

export interface ProviderSecretPayload {
  apiKey: string;
  organizationId?: string;
}
