/**
 * Service interfaces
 *
 * Abstractions for core services, enabling dependency injection,
 * testing with mocks, and alternative implementations.
 */

import type { Message, Session, SearchResult, RateLimitInfo } from '../types.js';
import type { ChatResponse, ModelProbeResult, CostUsageResult, ProviderInfo } from './chat.js';
import type { VoiceCapabilities, TranscriptionResult } from './voice.js';

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
  fetchCapabilities(): Promise<VoiceCapabilities | null>;
  startRecording(): { ok: true; tempPath: string } | { ok: false; error: string };
  stopRecording(): { ok: true; tempPath: string; durationMs: number } | { ok: false; error: string };
  transcribe(audioPath: string): Promise<TranscriptionResult>;
  synthesize(text: string, voice?: string, speed?: number): Promise<string>;
  playAudio(audioPath: string): Promise<void>;
  stopPlayback(): void;
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
  searchTranscripts(query: string): SearchResult[];
  getContextSummary(maxMessages?: number): string;
}
