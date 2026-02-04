/**
 * Realtime Voice Service
 *
 * WebSocket-based real-time voice streaming for bidirectional voice chat.
 * Connects to gateway's realtime voice endpoint which proxies to providers
 * like OpenAI Realtime API, ElevenLabs Conversational AI, etc.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import WebSocket from 'ws';
import type {
  RealtimeVoiceProvider,
  RealtimeVoiceCapabilities,
  RealtimeClientMessage,
  RealtimeServerMessage,
  RealtimeVoiceState,
} from '../types.js';

export interface RealtimeVoiceServiceConfig {
  gatewayUrl: string;
  gatewayToken?: string;
}

export interface RealtimeSessionConfig {
  provider: RealtimeVoiceProvider;
  voice?: string;
  systemPrompt?: string;
}

export interface RealtimeVoiceCallbacks {
  onStateChange?: (state: RealtimeVoiceState) => void;
  onUserTranscript?: (text: string, isFinal: boolean) => void;
  onAITranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  onSessionEnd?: () => void;
}

// Audio format for realtime streaming (matches OpenAI Realtime API requirements)
const SAMPLE_RATE = 24000;  // 24kHz
const CHANNELS = 1;         // Mono
const BIT_DEPTH = 16;       // 16-bit

export class RealtimeVoiceService {
  private config: RealtimeVoiceServiceConfig;
  private ws: WebSocket | null = null;
  private recProcess: ChildProcess | null = null;
  private playProcess: ChildProcess | null = null;
  private playbackQueue: Buffer[] = [];
  private playbackInterval: NodeJS.Timeout | null = null;
  private state: RealtimeVoiceState = 'disconnected';
  private callbacks: RealtimeVoiceCallbacks = {};

  constructor(config: RealtimeVoiceServiceConfig) {
    this.config = config;
  }

  /** Fetch realtime voice capabilities from gateway. */
  async fetchCapabilities(): Promise<RealtimeVoiceCapabilities | null> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.gatewayToken) {
        headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
      }

      const response = await fetch(`${this.config.gatewayUrl}/api/realtime-voice/capabilities`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { available: false, providers: [] };
      }

      const data = await response.json() as {
        providers?: RealtimeVoiceProvider[];
        defaultProvider?: RealtimeVoiceProvider;
        voices?: Record<RealtimeVoiceProvider, string[]>;
      };
      return {
        available: true,
        providers: data.providers || [],
        defaultProvider: data.defaultProvider,
        voices: data.voices,
      };
    } catch {
      return null;
    }
  }

  /** Set callbacks for realtime events. */
  setCallbacks(callbacks: RealtimeVoiceCallbacks): void {
    this.callbacks = callbacks;
  }

  /** Get current connection state. */
  getState(): RealtimeVoiceState {
    return this.state;
  }

  private setState(state: RealtimeVoiceState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  /** Connect to gateway's realtime voice WebSocket endpoint. */
  async connect(sessionConfig: RealtimeSessionConfig): Promise<boolean> {
    if (this.ws) {
      this.disconnect();
    }

    this.setState('connecting');

    // Build WebSocket URL
    const wsProtocol = this.config.gatewayUrl.startsWith('https') ? 'wss' : 'ws';
    const baseUrl = this.config.gatewayUrl.replace(/^https?/, wsProtocol);
    const wsUrl = `${baseUrl}/api/realtime-voice/stream?provider=${sessionConfig.provider}`;

    return new Promise((resolve) => {
      try {
        const headers: Record<string, string> = {};
        if (this.config.gatewayToken) {
          headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
        }

        this.ws = new WebSocket(wsUrl, { headers });

        this.ws.on('open', () => {
          // Send initial config
          this.send({
            type: 'config',
            voice: sessionConfig.voice,
            systemPrompt: sessionConfig.systemPrompt,
          });
          this.setState('listening');
          resolve(true);
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error: Error) => {
          this.callbacks.onError?.(error.message || 'WebSocket error');
          this.setState('disconnected');
          resolve(false);
        });

        this.ws.on('close', () => {
          this.stopStreaming();
          this.setState('disconnected');
          this.callbacks.onSessionEnd?.();
        });

        // Timeout for connection
        setTimeout(() => {
          if (this.state === 'connecting') {
            this.disconnect();
            this.callbacks.onError?.('Connection timeout');
            resolve(false);
          }
        }, 10000);
      } catch (err) {
        this.callbacks.onError?.(err instanceof Error ? err.message : 'Failed to connect');
        this.setState('disconnected');
        resolve(false);
      }
    });
  }

  /** Disconnect and cleanup. */
  disconnect(): void {
    this.stopStreaming();
    this.stopPlayback();

    if (this.ws) {
      this.send({ type: 'end' });
      this.ws.close();
      this.ws = null;
    }

    this.setState('disconnected');
  }

  /** Start streaming audio from microphone. */
  startStreaming(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.callbacks.onError?.('Not connected');
      return false;
    }

    if (this.recProcess) {
      return true; // Already streaming
    }

    // Stream raw PCM audio directly to WebSocket
    // Using SoX 'rec' to capture at 24kHz 16-bit mono
    this.recProcess = spawn('rec', [
      '-q',                      // Quiet (no progress)
      '-r', String(SAMPLE_RATE), // 24kHz
      '-c', String(CHANNELS),    // Mono
      '-b', String(BIT_DEPTH),   // 16-bit
      '-t', 'raw',               // Raw PCM output
      '-',                       // Output to stdout
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.recProcess.stdout?.on('data', (chunk: Buffer) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({
          type: 'audio',
          data: chunk.toString('base64'),
        });
      }
    });

    this.recProcess.on('error', (err) => {
      this.callbacks.onError?.(`Mic error: ${err.message}`);
      this.recProcess = null;
    });

    this.recProcess.on('close', () => {
      this.recProcess = null;
    });

    return true;
  }

  /** Stop streaming audio from microphone. */
  stopStreaming(): void {
    if (this.recProcess) {
      this.recProcess.kill('SIGTERM');
      this.recProcess = null;
    }
  }

  /** Interrupt the AI response (barge-in). */
  interrupt(): void {
    this.send({ type: 'interrupt' });
    this.stopPlayback();
    this.setState('listening');
  }

  /** Send a message to the gateway. */
  private send(message: RealtimeClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Handle incoming message from gateway. */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as RealtimeServerMessage;

      switch (message.type) {
        case 'audio':
          this.handleAudioChunk(message.data);
          break;

        case 'transcript.user':
          this.callbacks.onUserTranscript?.(message.text, message.isFinal);
          break;

        case 'transcript.ai':
          this.callbacks.onAITranscript?.(message.text, message.isFinal);
          if (!message.isFinal) {
            this.setState('aiSpeaking');
          }
          break;

        case 'error':
          this.callbacks.onError?.(message.message);
          break;

        case 'session.start':
          this.setState('listening');
          break;

        case 'session.end':
          this.callbacks.onSessionEnd?.();
          this.disconnect();
          break;
      }
    } catch {
      // Invalid message format, ignore
    }
  }

  /** Handle incoming audio chunk. */
  private handleAudioChunk(base64Audio: string): void {
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    this.playbackQueue.push(audioBuffer);

    if (!this.playProcess) {
      this.startPlayback();
    }
  }

  /** Start audio playback from queue. */
  private startPlayback(): void {
    // Play raw PCM from stdin using SoX 'play'
    this.playProcess = spawn('play', [
      '-q',                      // Quiet
      '-r', String(SAMPLE_RATE), // 24kHz
      '-c', String(CHANNELS),    // Mono
      '-b', String(BIT_DEPTH),   // 16-bit
      '-t', 'raw',               // Raw PCM input
      '-',                       // Input from stdin
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.playProcess.on('error', () => {
      this.playProcess = null;
    });

    this.playProcess.on('close', () => {
      this.playProcess = null;
      if (this.state === 'aiSpeaking') {
        this.setState('listening');
      }
    });

    // Continuously write queued chunks
    this.playbackInterval = setInterval(() => {
      while (this.playbackQueue.length > 0 && this.playProcess?.stdin?.writable) {
        const chunk = this.playbackQueue.shift()!;
        this.playProcess.stdin.write(chunk);
      }
    }, 50);
  }

  /** Stop audio playback. */
  private stopPlayback(): void {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }

    if (this.playProcess) {
      this.playProcess.stdin?.end();
      this.playProcess.kill('SIGTERM');
      this.playProcess = null;
    }

    this.playbackQueue = [];
  }

  /** Cleanup resources. */
  cleanup(): void {
    this.disconnect();
  }
}
