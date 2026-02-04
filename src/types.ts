/**
 * Type definitions for RemoteClaw
 */

export interface RemoteClawOptions {
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

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
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

export type RealtimeVoiceProvider = 'openai' | 'elevenlabs' | 'deepgram' | 'gemini';

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

export interface Talk {
  id: string;              // Same as session ID
  sessionId: string;       // Reference to underlying session
  topicTitle?: string;     // User-set via /topic
  isSaved: boolean;        // Explicitly saved via /save
  createdAt: number;
  updatedAt: number;
}
