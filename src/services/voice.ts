/**
 * Voice Service
 *
 * Handles audio recording (sox/rec), playback (sox/play), and
 * communication with moltbot gateway voice endpoints for STT/TTS.
 */

import type { IVoiceService } from './interfaces.js';
import { validateVoiceCapabilities, validateTranscription } from './validation.js';
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
    providers?: string[];  // All configured STT providers
    model?: string;
    maxDurationSeconds?: number;
    maxFileSizeMB?: number;
  };
  tts: {
    available: boolean;
    provider?: string;
    providers?: string[];  // All configured TTS providers
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

export class VoiceService implements IVoiceService {
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
    this.cleanStaleTempFiles();
  }

  /** Remove orphaned temp files from previous sessions/crashes. */
  private cleanStaleTempFiles(): void {
    try {
      const tmpDir = os.tmpdir();
      const entries = fs.readdirSync(tmpDir);
      for (const entry of entries) {
        if (entry.startsWith('clawtalk-voice-') || entry.startsWith('clawtalk-tts-')) {
          try {
            fs.unlinkSync(path.join(tmpDir, entry));
          } catch (err) {
            console.debug('Stale temp file removal failed:', err);
          }
        }
      }
    } catch (err) {
      console.debug('Stale temp file scan failed:', err);
    }
  }

  // --- Sox detection ---

  checkSoxInstalled(): boolean {
    // Only cache positive results — retry on failure so installing sox mid-session works
    if (this.soxAvailable === true) return true;
    try {
      execSync('which sox', { timeout: 3000, stdio: 'pipe' });
      execSync('which rec', { timeout: 3000, stdio: 'pipe' });
      this.soxAvailable = true;
    } catch (err) {
      console.debug('SoX not found:', err);
      this.soxAvailable = false;
    }
    return this.soxAvailable;
  }

  /**
   * Test if microphone is actually working by doing a brief test recording.
   * Returns null if mic works, or an error message if it doesn't.
   */
  checkMicAvailable(): string | null {
    if (!this.checkSoxInstalled()) {
      return 'SoX not installed';
    }

    const testPath = path.join(os.tmpdir(), `clawtalk-mic-test-${Date.now()}.wav`);
    try {
      // Try a very brief recording (0.5 seconds) to test mic access
      execSync(`rec -q -r 16000 -c 1 -b 16 -t wav "${testPath}" trim 0 0.5`, {
        timeout: 5000,
        stdio: 'pipe',
      });

      // Check if file was created and has audio data
      const stat = fs.statSync(testPath);
      fs.unlinkSync(testPath); // Clean up

      // WAV header is 44 bytes, so file should be larger if audio was captured
      // 0.5 sec at 16kHz 16-bit mono = 16000 bytes + 44 header = ~16044 bytes
      if (stat.size < 1000) {
        return 'No audio captured. Check System Preferences → Sound → Input and select your microphone.';
      }

      return null; // Success
    } catch (err) {
      try { fs.unlinkSync(testPath); } catch { /* ignore */ }
      return 'Mic test failed. Check microphone permissions and device settings.';
    }
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
      const raw = validateVoiceCapabilities(await response.json());
      if (!raw) return null;
      this.capabilities = raw as VoiceCapabilities;
      return this.capabilities;
    } catch (err) {
      console.debug('Voice capability fetch failed:', err);
      return null;
    }
  }

  get canRecord(): boolean {
    return (this.soxAvailable ?? false) && (this.capabilities?.stt.available ?? false);
  }

  get canPlayback(): boolean {
    return (this.soxAvailable ?? false) && (this.capabilities?.tts.available ?? false);
  }

  /** Get current capabilities (cached from last fetch). */
  getCapabilities(): VoiceCapabilities | null {
    return this.capabilities;
  }

  /** Switch the active STT provider on the gateway. */
  async setSttProvider(provider: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.gatewayToken) {
        headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
      }

      const response = await fetch(`${this.config.gatewayUrl}/api/voice/stt/provider`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok && this.capabilities) {
        this.capabilities.stt.provider = provider;
      }
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Switch the active TTS provider on the gateway. */
  async setTtsProvider(provider: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.gatewayToken) {
        headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
      }

      const response = await fetch(`${this.config.gatewayUrl}/api/voice/tts/provider`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok && this.capabilities) {
        this.capabilities.tts.provider = provider;
      }
      return response.ok;
    } catch {
      return false;
    }
  }

  // --- Recording ---

  get isRecording(): boolean {
    return this.recordingProcess !== null;
  }

  private recordingError: string | null = null;

  startRecording(): { ok: true; tempPath: string } | { ok: false; error: string } {
    if (this.recordingProcess) {
      return { ok: false, error: 'Already recording' };
    }

    if (!this.checkSoxInstalled()) {
      return { ok: false, error: 'Voice requires sox. Install with: brew install sox' };
    }

    const tempPath = path.join(os.tmpdir(), `clawtalk-voice-${Date.now()}.wav`);
    this.tempFiles.push(tempPath);
    this.recordingError = null;

    const proc = spawn('rec', [
      '-q',           // quiet (suppress progress output)
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

    proc.on('error', (err) => {
      this.recordingError = err.message;
      this.recordingProcess = null;
      this.recordingPath = null;
    });

    // Detect early exit (e.g., mic permission denied, no audio device)
    // If rec exits within the first second, it's likely a failure
    const startTime = Date.now();
    proc.on('close', (code) => {
      if (this.recordingProcess === proc) {
        const elapsed = Date.now() - startTime;
        // Process exited while we thought we were still recording
        if (code !== 0) {
          // Filter out warnings, look for actual errors
          const errorLines = stderrOutput.split('\n')
            .filter(line => !line.includes('WARN') && line.trim())
            .join('\n').trim();
          this.recordingError = errorLines || `Recording failed (exit code ${code})`;
        } else if (elapsed < 1000) {
          // Process exited too quickly with success - might be a silent failure
          // Check if file exists and has content
          try {
            const stat = fs.statSync(tempPath);
            if (stat.size < 100) {
              this.recordingError = 'No audio captured. Check microphone permissions in System Preferences → Privacy & Security → Microphone.';
            }
          } catch {
            this.recordingError = 'Recording failed - no audio file created. Check microphone permissions.';
          }
        }
        this.recordingProcess = null;
        this.recordingPath = null;
      }
    });

    this.recordingProcess = proc;
    this.recordingPath = tempPath;
    this.recordingStartTime = Date.now();

    return { ok: true, tempPath };
  }

  /** Check if recording failed after starting (e.g., mic permission denied). */
  getRecordingError(): string | null {
    return this.recordingError;
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

  // --- Volume level ---

  /** Read the tail of the active WAV file and compute RMS volume (0-100). */
  getRecordingLevel(): number {
    if (!this.recordingPath) return 0;
    try {
      const fd = fs.openSync(this.recordingPath, 'r');
      const stat = fs.fstatSync(fd);
      const WAV_HEADER = 44;
      // Read last ~3200 bytes (100ms of 16kHz 16-bit mono)
      const bytesToRead = 3200;
      const start = Math.max(WAV_HEADER, stat.size - bytesToRead);
      const length = stat.size - start;
      if (length < 4) { fs.closeSync(fd); return 0; }

      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      fs.closeSync(fd);

      // Parse 16-bit signed LE samples and compute RMS
      const sampleCount = Math.floor(length / 2);
      let sumSquares = 0;
      for (let i = 0; i < sampleCount; i++) {
        const sample = buf.readInt16LE(i * 2);
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / sampleCount);
      // Use dB scale (like a real audio meter) — linear amplitude is
      // perceptually wrong because speech RMS is only ~3-10% of 16-bit max.
      // Map -50 dBFS → 0%, 0 dBFS → 100%
      if (rms < 1) return 0;
      const dBFS = 20 * Math.log10(rms / 32768);
      return Math.min(100, Math.max(0, Math.round((dBFS + 50) * 2)));
    } catch {
      return 0;
    }
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

    const result = validateTranscription(await response.json());
    if (!result) throw new Error('Invalid transcription response');
    return result as TranscriptionResult;
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
    const tempPath = path.join(os.tmpdir(), `clawtalk-tts-${Date.now()}.mp3`);
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
      } catch (err) {
        console.debug('Temp file cleanup failed:', err);
      }
    }
    this.tempFiles = [];
  }
}
