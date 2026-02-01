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

export type VoiceMode = 'idle' | 'recording' | 'transcribing' | 'synthesizing' | 'playing';

export type VoiceReadiness = 'checking' | 'ready' | 'no-sox' | 'no-gateway' | 'no-stt';

export interface VoiceState {
  mode: VoiceMode;
  readiness: VoiceReadiness;
  sttAvailable: boolean;
  ttsAvailable: boolean;
  autoSend: boolean;
  autoPlay: boolean;
  error?: string;
}
