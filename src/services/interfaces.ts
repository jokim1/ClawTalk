/**
 * Service interfaces
 *
 * Abstractions for core services, enabling dependency injection,
 * testing with mocks, and alternative implementations.
 */

import type { Message, Session, SearchResult, RateLimitInfo, RealtimeVoiceCapabilities, RealtimeVoiceState } from '../types.js';
import type { ChatResponse, ModelProbeResult, CostUsageResult, ProviderInfo } from './chat.js';
import type { VoiceCapabilities, TranscriptionResult } from './voice.js';
import type { RealtimeSessionConfig, RealtimeVoiceCallbacks } from './realtime-voice.js';

/** Gateway chat and model operations. */
export interface IChatService {
  lastResponseModel: string | undefined;
  lastResponseUsage: { promptTokens: number; completionTokens: number } | undefined;

  sendMessage(userMessage: string, history?: Message[]): Promise<ChatResponse>;
  streamMessage(userMessage: string, history?: Message[]): AsyncGenerator<string, void, unknown>;
  checkHealth(): Promise<boolean>;
  listModels(): Promise<string[] | null>;
  probeModel(model?: string, signal?: AbortSignal): Promise<ModelProbeResult>;
  setModel(model: string): void;
  setModelOverride(model: string): Promise<boolean>;
  getCostUsage(days?: number): Promise<CostUsageResult | null>;
  getRateLimits(provider?: string): Promise<RateLimitInfo | null>;
  getProviders(): Promise<ProviderInfo[] | null>;
}

/** Voice recording, transcription, and synthesis. */
export interface IVoiceService {
  readonly isRecording: boolean;
  readonly isPlaying: boolean;
  readonly canRecord: boolean;
  readonly canPlayback: boolean;

  checkSoxInstalled(): boolean;
  checkMicAvailable(): string | null;
  fetchCapabilities(): Promise<VoiceCapabilities | null>;
  startRecording(): { ok: true; tempPath: string } | { ok: false; error: string };
  stopRecording(): { ok: true; tempPath: string; durationMs: number } | { ok: false; error: string };
  getRecordingLevel(): number;
  getRecordingError(): string | null;
  transcribe(audioPath: string): Promise<TranscriptionResult>;
  synthesize(text: string, voice?: string, speed?: number): Promise<string>;
  playAudio(audioPath: string): Promise<void>;
  stopPlayback(): void;
  cleanup(): void;
}

/** Realtime voice streaming for bidirectional voice chat. */
export interface IRealtimeVoiceService {
  fetchCapabilities(): Promise<RealtimeVoiceCapabilities | null>;
  setCallbacks(callbacks: RealtimeVoiceCallbacks): void;
  getState(): RealtimeVoiceState;
  connect(sessionConfig: RealtimeSessionConfig): Promise<boolean>;
  disconnect(): void;
  startStreaming(): boolean;
  stopStreaming(): void;
  interrupt(): void;
  cleanup(): void;
}

/** Session persistence and retrieval. */
export interface ISessionManager {
  createSession(name?: string, model?: string): Session;
  getActiveSession(): Session;
  setActiveSession(sessionId: string): Session | null;
  listSessions(): Session[];
  addMessage(message: Message): void;
  setSessionModel(model: string): void;
  clearActiveSession(): void;
  deleteSession(sessionId: string): boolean;
  renameSession(sessionId: string, newName: string): boolean;
  getSession(sessionId: string): Session | null;
  getActiveSessionId(): string | null;
  getSessionDir(sessionId: string): string;
  deleteMessages(sessionId: string, messageIds: string[]): boolean;
  searchTranscripts(query: string): SearchResult[];
  getContextSummary(maxMessages?: number): string;
}
