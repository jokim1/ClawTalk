/**
 * Type definitions for ClawTalk
 */

export interface ClawTalkOptions {
  gatewayUrl: string;
  gatewayToken?: string;
  model?: string;
  sessionName?: string;
  anthropicApiKey?: string;
}

export interface Session {
  id: string;
  name: string;
  model: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export type AgentRole = 'analyst' | 'critic' | 'strategist' | 'devils-advocate' | 'synthesizer' | 'editor';

export interface TalkAgent {
  name: string;
  model: string;
  role: AgentRole;
  isPrimary: boolean;
}

export interface ImageAttachmentMeta {
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface PendingAttachment extends ImageAttachmentMeta {
  base64: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  agentName?: string;
  agentRole?: AgentRole;
  attachment?: ImageAttachmentMeta;
}

export interface DocumentContent {
  filename: string;
  text: string;
}

export type ModelStatus = 'unknown' | 'checking' | 'ok' | { error: string };

export interface SearchResult {
  sessionId: string;
  sessionName: string;
  sessionUpdatedAt: number;
  message: Message;
  matchIndex: number;
}

export interface RateLimitWindow {
  used: number;
  limit: number;
  resetsAt: string; // ISO timestamp
}

export interface RateLimitInfo {
  provider: string;
  session?: RateLimitWindow;
  weekly?: RateLimitWindow;
  perModel?: Record<string, RateLimitWindow>;
}

export interface UsageStats {
  quotaUsed?: number;
  quotaTotal?: number;
  quotaResetAt?: number;
  todaySpend?: number;
  weeklySpend?: number;
  monthlyEstimate?: number;
  averageDailySpend?: number;
  sessionCost?: number;
  modelPricing?: {
    inputPer1M: number;
    outputPer1M: number;
  };
  rateLimits?: RateLimitInfo;
}

export type VoiceMode = 'idle' | 'recording' | 'liveChat' | 'transcribing' | 'synthesizing' | 'playing';

export type VoiceReadiness = 'checking' | 'ready' | 'no-sox' | 'no-mic' | 'no-gateway' | 'no-stt';

// --- Realtime Voice Types ---

export type RealtimeVoiceProvider = 'openai' | 'elevenlabs' | 'deepgram' | 'gemini' | 'cartesia';

export interface RealtimeVoiceCapabilities {
  available: boolean;
  providers: RealtimeVoiceProvider[];
  defaultProvider?: RealtimeVoiceProvider;
  voices?: Record<RealtimeVoiceProvider, string[]>;
}

export interface RealtimeVoiceConfig {
  provider: RealtimeVoiceProvider;
  voice?: string;
  systemPrompt?: string;
}

// WebSocket message types for realtime voice protocol

/** Client → Gateway messages */
export type RealtimeClientMessage =
  | { type: 'audio'; data: string }           // base64 PCM audio chunk
  | { type: 'config'; voice?: string; systemPrompt?: string }
  | { type: 'interrupt' }                      // barge-in (cancel AI response)
  | { type: 'end' };                           // end session

/** Gateway → Client messages */
export type RealtimeServerMessage =
  | { type: 'audio'; data: string }            // base64 PCM audio chunk
  | { type: 'transcript.user'; text: string; isFinal: boolean }
  | { type: 'transcript.ai'; text: string; isFinal: boolean }
  | { type: 'error'; message: string }
  | { type: 'session.start' }
  | { type: 'session.end' };

export type RealtimeVoiceState = 'disconnected' | 'connecting' | 'listening' | 'aiSpeaking';

export interface VoiceState {
  mode: VoiceMode;
  readiness: VoiceReadiness;
  sttAvailable: boolean;
  ttsAvailable: boolean;
  autoSend: boolean;
  autoPlay: boolean;
  error?: string;
}

export interface Job {
  id: string;
  schedule: string;        // Cron expression or human-readable schedule
  prompt: string;          // What the job should do
  active: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: string;
}

export interface JobReport {
  id: string;
  jobId: string;
  talkId: string;
  runAt: number;
  status: 'success' | 'error';
  summary: string;
  fullOutput: string;
  tokenUsage?: { input: number; output: number };
}

export interface Talk {
  id: string;              // Same as session ID
  sessionId: string;       // Reference to underlying session
  topicTitle?: string;     // User-set via /topic
  isSaved: boolean;        // Explicitly saved via /save
  model?: string;          // Last used AI model for this talk
  objective?: string;          // System prompt prepended to every AI request
  pinnedMessageIds?: string[];  // Pinned message IDs for stable context
  jobs?: Job[];            // Background jobs for this talk
  agents?: TalkAgent[];    // Multi-agent configuration
  gatewayTalkId?: string;  // Corresponding gateway-side talk ID
  createdAt: number;
  updatedAt: number;
}
