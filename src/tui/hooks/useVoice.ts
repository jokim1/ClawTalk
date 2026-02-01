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
  'no-gateway': 'Voice not available — gateway did not respond to /api/voice/capabilities. Is the RemoteClawGateway plugin installed?',
  'no-stt': 'Voice not available — gateway has no speech-to-text provider configured. Set OPENAI_API_KEY on the gateway server.',
};

const VOLUME_POLL_MS = 150;

export function useVoice(opts: UseVoiceOpts) {
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('idle');
  const [volumeLevel, setVolumeLevel] = useState(0);
  const voiceModeRef = useRef(voiceMode);
  voiceModeRef.current = voiceMode;

  // Keep opts current via ref for stable callbacks
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Poll volume level during recording
  useEffect(() => {
    if (voiceMode !== 'recording') {
      setVolumeLevel(0);
      return;
    }
    const interval = setInterval(() => {
      const level = optsRef.current.voiceServiceRef.current?.getRecordingLevel() ?? 0;
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

    if (mode === 'idle') {
      const result = voiceServiceRef.current?.startRecording();
      if (result?.ok) {
        setVoiceMode('recording');
        setError(null);
      } else {
        setError(result?.error ?? 'Failed to start recording');
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

    if (mode === 'recording') {
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

  /** Speak an assistant response via TTS if autoPlay is enabled. */
  const speakResponse = useCallback((text: string) => {
    const { voiceServiceRef, ttsAvailable, voiceConfig } = optsRef.current;
    const voiceService = voiceServiceRef.current;
    const shouldPlay = (voiceConfig?.autoPlay ?? true) && ttsAvailable && voiceService?.canPlayback;
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
  }, []);

  return {
    voiceMode,
    volumeLevel,
    autoSend: opts.voiceConfig?.autoSend ?? true,
    autoPlay: opts.voiceConfig?.autoPlay ?? true,
    handleVoiceToggle,
    handleEscape,
    speakResponse,
  };
}
