/**
 * Realtime Voice Hook
 *
 * Manages real-time bidirectional voice chat state.
 * Handles connection to gateway, audio streaming, and transcript updates.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type {
  RealtimeVoiceProvider,
  RealtimeVoiceCapabilities,
  RealtimeVoiceState,
} from '../../types.js';
import type { RealtimeVoiceService } from '../../services/realtime-voice.js';

export interface UseRealtimeVoiceOpts {
  realtimeServiceRef: MutableRefObject<RealtimeVoiceService | null>;
  capabilities: RealtimeVoiceCapabilities | null;
  setError: Dispatch<SetStateAction<string | null>>;
}

export interface RealtimeVoiceHookResult {
  isActive: boolean;
  state: RealtimeVoiceState;
  userTranscript: string;
  aiTranscript: string;
  provider: RealtimeVoiceProvider | null;
  setProvider: (provider: RealtimeVoiceProvider) => void;
  startSession: (systemPrompt?: string) => Promise<boolean>;
  endSession: () => void;
  interrupt: () => void;
}

const READINESS_HINTS: Record<string, string> = {
  'no-capabilities': 'Realtime voice not available — gateway has no realtime voice providers configured.',
  'no-service': 'Realtime voice service not initialized. Try restarting.',
  'connection-failed': 'Failed to connect to realtime voice. Check gateway connection.',
};

export function useRealtimeVoice(opts: UseRealtimeVoiceOpts): RealtimeVoiceHookResult {
  const [state, setState] = useState<RealtimeVoiceState>('disconnected');
  const [userTranscript, setUserTranscript] = useState('');
  const [aiTranscript, setAiTranscript] = useState('');
  const [provider, setProviderState] = useState<RealtimeVoiceProvider | null>(null);

  // Keep opts current via ref for stable callbacks
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Set default provider when capabilities load
  useEffect(() => {
    if (opts.capabilities?.available && opts.capabilities.providers.length > 0) {
      if (!provider) {
        setProviderState(opts.capabilities.defaultProvider || opts.capabilities.providers[0]);
      }
    }
  }, [opts.capabilities, provider]);

  // Setup callbacks when service is available
  useEffect(() => {
    const service = opts.realtimeServiceRef.current;
    if (!service) return;

    service.setCallbacks({
      onStateChange: (newState) => {
        setState(newState);
      },
      onUserTranscript: (text, isFinal) => {
        setUserTranscript(text);
        // Clear after a moment if final
        if (isFinal) {
          setTimeout(() => setUserTranscript(''), 3000);
        }
      },
      onAITranscript: (text, isFinal) => {
        setAiTranscript(text);
        // Clear after a moment if final
        if (isFinal) {
          setTimeout(() => setAiTranscript(''), 3000);
        }
      },
      onError: (error) => {
        optsRef.current.setError(error);
      },
      onSessionEnd: () => {
        setState('disconnected');
        setUserTranscript('');
        setAiTranscript('');
      },
    });
  }, [opts.realtimeServiceRef.current]);

  const setProvider = useCallback((newProvider: RealtimeVoiceProvider) => {
    setProviderState(newProvider);
  }, []);

  const startSession = useCallback(async (systemPrompt?: string): Promise<boolean> => {
    const { realtimeServiceRef, capabilities, setError } = optsRef.current;

    // Check capabilities
    if (!capabilities?.available || capabilities.providers.length === 0) {
      setError(READINESS_HINTS['no-capabilities']);
      return false;
    }

    const service = realtimeServiceRef.current;
    if (!service) {
      setError(READINESS_HINTS['no-service']);
      return false;
    }

    const selectedProvider = provider || capabilities.defaultProvider || capabilities.providers[0];
    const defaultVoice = capabilities.voices?.[selectedProvider]?.[0];

    // Clear previous transcripts
    setUserTranscript('');
    setAiTranscript('');

    // Connect to gateway
    const connected = await service.connect({
      provider: selectedProvider,
      voice: defaultVoice,
      systemPrompt,
    });

    if (!connected) {
      setError(READINESS_HINTS['connection-failed']);
      return false;
    }

    // Start streaming audio
    const started = service.startStreaming();
    if (!started) {
      service.disconnect();
      return false;
    }

    return true;
  }, [provider]);

  const endSession = useCallback(() => {
    const service = optsRef.current.realtimeServiceRef.current;
    service?.disconnect();
    setUserTranscript('');
    setAiTranscript('');
  }, []);

  const interrupt = useCallback(() => {
    const service = optsRef.current.realtimeServiceRef.current;
    service?.interrupt();
    setAiTranscript('');
  }, []);

  return {
    isActive: state !== 'disconnected',
    state,
    userTranscript,
    aiTranscript,
    provider,
    setProvider,
    startSession,
    endSession,
    interrupt,
  };
}
