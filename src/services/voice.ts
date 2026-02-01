/**
 * Voice Service
 *
 * Handles audio recording (sox/rec), playback (sox/play), and
 * communication with moltbot gateway voice endpoints for STT/TTS.
 */

import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// --- Types ---

export interface VoiceCapabilities {
  stt: {
    available: boolean;
    provider?: string;
    model?: string;
    maxDurationSeconds?: number;
    maxFileSizeMB?: number;
  };
  tts: {
    available: boolean;
    provider?: string;
    model?: string;
    voices?: string[];
    defaultVoice?: string;
  };
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface VoiceServiceConfig {
  gatewayUrl: string;
  gatewayToken?: string;
}

// --- Service ---

export class VoiceService {
  private config: VoiceServiceConfig;
  private soxAvailable: boolean | null = null;
  private capabilities: VoiceCapabilities | null = null;
  private recordingProcess: ChildProcess | null = null;
  private recordingPath: string | null = null;
  private recordingStartTime: number = 0;
  private playbackProcess: ChildProcess | null = null;
  private tempFiles: string[] = [];

  constructor(config: VoiceServiceConfig) {
    this.config = config;
  }

  // --- Sox detection ---

  checkSoxInstalled(): boolean {
    if (this.soxAvailable !== null) return this.soxAvailable;
    try {
      execSync('which sox', { timeout: 3000, stdio: 'pipe' });
      execSync('which rec', { timeout: 3000, stdio: 'pipe' });
      this.soxAvailable = true;
    } catch {
      this.soxAvailable = false;
    }
    return this.soxAvailable;
  }

  // --- Capability discovery ---

  async fetchCapabilities(): Promise<VoiceCapabilities | null> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.gatewayToken) {
        headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
      }

      const response = await fetch(`${this.config.gatewayUrl}/api/voice/capabilities`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;
      this.capabilities = await response.json() as VoiceCapabilities;
      return this.capabilities;
    } catch {
      return null;
    }
  }

  get canRecord(): boolean {
    return (this.soxAvailable ?? false) && (this.capabilities?.stt.available ?? false);
  }

  get canPlayback(): boolean {
    return (this.soxAvailable ?? false) && (this.capabilities?.tts.available ?? false);
  }

  // --- Recording ---

  get isRecording(): boolean {
    return this.recordingProcess !== null;
  }

  startRecording(): { ok: true; tempPath: string } | { ok: false; error: string } {
    if (this.recordingProcess) {
      return { ok: false, error: 'Already recording' };
    }

    if (!this.checkSoxInstalled()) {
      return { ok: false, error: 'Voice requires sox. Install with: brew install sox' };
    }

    const tempPath = path.join(os.tmpdir(), `remoteclaw-voice-${Date.now()}.wav`);
    this.tempFiles.push(tempPath);

    const proc = spawn('rec', [
      '-q',           // quiet
      '-r', '16000',  // 16kHz
      '-c', '1',      // mono
      '-b', '16',     // 16-bit
      '-t', 'wav',    // WAV format
      tempPath,
      'trim', '0', '120',  // max 120 seconds
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrOutput = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on('error', () => {
      this.recordingProcess = null;
      this.recordingPath = null;
    });

    this.recordingProcess = proc;
    this.recordingPath = tempPath;
    this.recordingStartTime = Date.now();

    return { ok: true, tempPath };
  }

  stopRecording(): { ok: true; tempPath: string; durationMs: number } | { ok: false; error: string } {
    if (!this.recordingProcess || !this.recordingPath) {
      return { ok: false, error: 'Not recording' };
    }

    const tempPath = this.recordingPath;
    const durationMs = Date.now() - this.recordingStartTime;

    // Send SIGTERM to gracefully stop rec (it finalizes the WAV header)
    this.recordingProcess.kill('SIGTERM');
    this.recordingProcess = null;
    this.recordingPath = null;

    // Give rec a moment to finalize the file
    return { ok: true, tempPath, durationMs };
  }

  // --- Transcription (STT) ---

  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    // Wait briefly for rec to finalize the WAV file
    await new Promise(resolve => setTimeout(resolve, 300));

    if (!fs.existsSync(audioPath)) {
      throw new Error('Recording file not found');
    }

    const stat = fs.statSync(audioPath);
    if (stat.size < 100) {
      throw new Error('Recording too short — no audio captured');
    }

    const maxMB = this.capabilities?.stt.maxFileSizeMB ?? 25;
    if (stat.size > maxMB * 1024 * 1024) {
      throw new Error(`Recording too large (max ${maxMB}MB). Try a shorter message.`);
    }

    const headers: Record<string, string> = {};
    if (this.config.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
    }

    const audioData = fs.readFileSync(audioPath);
    const blob = new Blob([audioData], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', blob, 'recording.wav');
    formData.append('language', 'en');

    const response = await fetch(`${this.config.gatewayUrl}/api/voice/transcribe`, {
      method: 'POST',
      headers,
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 503) throw new Error('Speech-to-text not configured on gateway');
      throw new Error(`Transcription failed (${response.status}): ${body.slice(0, 120)}`);
    }

    return await response.json() as TranscriptionResult;
  }

  // --- Synthesis (TTS) ---

  async synthesize(text: string, voice?: string, speed?: number): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
    }

    const body: Record<string, unknown> = { text };
    if (voice) body.voice = voice;
    if (speed !== undefined) body.speed = speed;

    const response = await fetch(`${this.config.gatewayUrl}/api/voice/synthesize`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      if (response.status === 503) throw new Error('Text-to-speech not configured on gateway');
      throw new Error(`Synthesis failed (${response.status}): ${errorBody.slice(0, 120)}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const tempPath = path.join(os.tmpdir(), `remoteclaw-tts-${Date.now()}.mp3`);
    fs.writeFileSync(tempPath, Buffer.from(audioBuffer));
    this.tempFiles.push(tempPath);

    return tempPath;
  }

  // --- Playback ---

  get isPlaying(): boolean {
    return this.playbackProcess !== null;
  }

  async playAudio(audioPath: string): Promise<void> {
    if (!fs.existsSync(audioPath)) {
      throw new Error('Audio file not found');
    }

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('play', ['-q', audioPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.playbackProcess = proc;

      proc.on('close', (code) => {
        this.playbackProcess = null;
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Playback exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        this.playbackProcess = null;
        reject(err);
      });
    });
  }

  stopPlayback(): void {
    if (this.playbackProcess) {
      this.playbackProcess.kill('SIGTERM');
      this.playbackProcess = null;
    }
  }

  // --- Cleanup ---

  cleanup(): void {
    // Stop any active processes
    if (this.recordingProcess) {
      this.recordingProcess.kill('SIGTERM');
      this.recordingProcess = null;
    }
    if (this.playbackProcess) {
      this.playbackProcess.kill('SIGTERM');
      this.playbackProcess = null;
    }

    // Remove temp files
    for (const f of this.tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.tempFiles = [];
  }
}
