/**
 * Voice recording, transcription, and TTS state management hook
 *
 * Manages the voice mode state machine (idle → recording → transcribing → idle)
 * and TTS playback (synthesizing → playing → idle).
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { VoiceMode, VoiceReadiness } from '../../types.js';
import type { VoiceService } from '../../services/voice.js';
import type { VoiceConfig } from '../../config.js';

export interface UseVoiceOpts {
  voiceServiceRef: MutableRefObject<VoiceService | null>;
  readiness: VoiceReadiness;
  ttsAvailable: boolean;
  voiceConfig?: VoiceConfig;
  sendMessageRef: MutableRefObject<((text: string) => Promise<void>) | null>;
  onInputText: (text: string) => void;
  setError: Dispatch<SetStateAction<string | null>>;
}

const READINESS_HINTS: Record<string, string> = {
  checking: 'Voice is still initializing, try again in a moment.',
  'no-sox': 'Voice requires SoX. Install with: brew install sox (macOS) or apt install sox (Linux)',
  'no-mic': 'No working microphone detected. Set REMOTECLAW_MIC to your device name, or check System Preferences → Sound → Input.',
  'no-gateway': 'Voice not available — gateway did not respond to /api/voice/capabilities. Is the RemoteClawGateway plugin installed?',
  'no-stt': 'Voice not available — gateway has no speech-to-text provider configured. Set OPENAI_API_KEY on the gateway server.',
};

const VOLUME_POLL_MS = 150;

import * as fs from 'fs';
import * as path from 'path';

const TTS_PREF_PATH = path.join(process.env.HOME || '~', '.remoteclaw', 'tts_enabled');

// Load ttsEnabled preference from file (persists across sessions)
function loadTtsEnabled(): boolean {
  try {
    if (fs.existsSync(TTS_PREF_PATH)) {
      const saved = fs.readFileSync(TTS_PREF_PATH, 'utf-8').trim();
      return saved !== 'false';
    }
    return true; // Default to enabled
  } catch {
    return true;
  }
}

function saveTtsEnabled(enabled: boolean): void {
  try {
    const dir = path.dirname(TTS_PREF_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(TTS_PREF_PATH, String(enabled));
  } catch {
    // Ignore file errors
  }
}

export function useVoice(opts: UseVoiceOpts) {
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('idle');
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [ttsEnabled, setTtsEnabled] = useState(loadTtsEnabled);
  const voiceModeRef = useRef(voiceMode);
  voiceModeRef.current = voiceMode;

  // Keep opts current via ref for stable callbacks
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Poll volume level during recording/liveChat, and detect early recording failure
  useEffect(() => {
    if (voiceMode !== 'recording' && voiceMode !== 'liveChat') {
      setVolumeLevel(0);
      return;
    }
    const interval = setInterval(() => {
      const voiceService = optsRef.current.voiceServiceRef.current;
      // Check if recording failed after starting (e.g., mic permission denied)
      const recordingError = voiceService?.getRecordingError?.();
      if (recordingError) {
        setVoiceMode('idle');
        optsRef.current.setError(recordingError);
        return;
      }
      const level = voiceService?.getRecordingLevel() ?? 0;
      setVolumeLevel(level);
    }, VOLUME_POLL_MS);
    return () => clearInterval(interval);
  }, [voiceMode]);

  const stopAndTranscribe = useCallback(async () => {
    const { voiceServiceRef, sendMessageRef, onInputText, setError, voiceConfig } = optsRef.current;
    const voiceService = voiceServiceRef.current;
    if (!voiceService) return;

    const stopResult = voiceService.stopRecording();
    if (!stopResult.ok) {
      setVoiceMode('idle');
      setError(stopResult.error);
      return;
    }

    setVoiceMode('transcribing');

    try {
      const result = await voiceService.transcribe(stopResult.tempPath);
      if (!result.text.trim()) {
        setVoiceMode('idle');
        setError('No speech detected');
        return;
      }

      setVoiceMode('idle');

      if (voiceConfig?.autoSend ?? true) {
        sendMessageRef.current?.(result.text);
      } else {
        onInputText(result.text);
      }
    } catch (err) {
      setVoiceMode('idle');
      setError(err instanceof Error ? err.message : 'Transcription failed');
    }
  }, []);

  /** Handle Ctrl+V: toggle recording or stop playback. */
  const handleVoiceToggle = useCallback(() => {
    const { voiceServiceRef, readiness, setError } = optsRef.current;
    const mode = voiceModeRef.current;

    // Show diagnostic if voice isn't ready
    if (readiness !== 'ready') {
      setError(READINESS_HINTS[readiness] ?? 'Voice is not available.');
      return;
    }

    if (!voiceServiceRef.current) {
      setError('Voice service not initialized. Try restarting.');
      return;
    }

    if (mode === 'idle') {
      const result = voiceServiceRef.current.startRecording();
      if (result.ok) {
        setVoiceMode('recording');
        setError(null);
      } else {
        setError(result.error);
      }
    } else if (mode === 'recording') {
      stopAndTranscribe();
    } else if (mode === 'playing') {
      voiceServiceRef.current?.stopPlayback();
      setVoiceMode('idle');
    }
  }, [stopAndTranscribe]);

  /** Handle Escape for voice cancellation. Returns true if handled. */
  const handleEscape = useCallback((): boolean => {
    const { voiceServiceRef } = optsRef.current;
    const mode = voiceModeRef.current;

    if (mode === 'recording' || mode === 'liveChat') {
      voiceServiceRef.current?.stopRecording();
      setVoiceMode('idle');
      return true;
    }
    if (mode === 'playing') {
      voiceServiceRef.current?.stopPlayback();
      setVoiceMode('idle');
      return true;
    }
    return false;
  }, []);

  /** Speak an assistant response via TTS if enabled. */
  const speakResponse = useCallback((text: string) => {
    const { voiceServiceRef, ttsAvailable, voiceConfig } = optsRef.current;
    const voiceService = voiceServiceRef.current;
    const shouldPlay = ttsEnabled && (voiceConfig?.autoPlay ?? true) && ttsAvailable && voiceService?.canPlayback;
    if (!shouldPlay || !voiceService) return;

    setVoiceMode('synthesizing');
    voiceService.synthesize(text, voiceConfig?.ttsVoice, voiceConfig?.ttsSpeed)
      .then(audioPath => {
        setVoiceMode('playing');
        return voiceService.playAudio(audioPath);
      })
      .then(() => setVoiceMode('idle'))
      .catch(() => {
        // TTS errors are non-fatal — text response is already visible
        setVoiceMode('idle');
      });
  }, [ttsEnabled]);

  /** Toggle TTS (AI Voice) on/off. Stops playback immediately if turning off while playing. */
  const handleTtsToggle = useCallback(() => {
    setTtsEnabled(prev => {
      // If turning off and currently playing, stop playback immediately
      if (prev && voiceModeRef.current === 'playing') {
        optsRef.current.voiceServiceRef.current?.stopPlayback();
        setVoiceMode('idle');
      }
      const newValue = !prev;
      saveTtsEnabled(newValue); // Persist preference
      return newValue;
    });
  }, []);

  /** Start/stop live talk mode (real-time bidirectional voice chat). */
  const handleLiveTalk = useCallback(() => {
    const { voiceServiceRef, readiness, setError } = optsRef.current;

    if (readiness !== 'ready') {
      setError(READINESS_HINTS[readiness] ?? 'Voice is not available.');
      return;
    }

    if (!voiceServiceRef.current) {
      setError('Voice service not initialized. Try restarting.');
      return;
    }

    const mode = voiceModeRef.current;
    if (mode === 'idle') {
      // Start live talk mode
      const result = voiceServiceRef.current.startRecording();
      if (result.ok) {
        setVoiceMode('liveChat');
        setError(null);
      } else {
        setError(result.error);
      }
    } else if (mode === 'liveChat') {
      // End live talk - transcribe and send
      stopAndTranscribe();
    } else if (mode === 'playing') {
      voiceServiceRef.current?.stopPlayback();
      setVoiceMode('idle');
    }
  }, [stopAndTranscribe]);

  return {
    voiceMode,
    volumeLevel,
    ttsEnabled,
    autoSend: opts.voiceConfig?.autoSend ?? true,
    autoPlay: opts.voiceConfig?.autoPlay ?? true,
    handleVoiceToggle,
    handleEscape,
    speakResponse,
    handleTtsToggle,
    handleLiveTalk,
  };
}
