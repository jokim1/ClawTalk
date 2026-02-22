/**
 * Settings Speech Tab — microphone, STT/TTS provider, and realtime voice provider selection.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { RealtimeVoiceProvider } from '../../types.js';

export interface AudioDevice {
  name: string;
  isDefault: boolean;
}

const STT_PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI Whisper',
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
  google: 'Google Cloud Speech',
  azure: 'Azure Speech',
};

const TTS_PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
  cartesia: 'Cartesia',
  google: 'Google Cloud TTS',
  azure: 'Azure Speech',
};

const REALTIME_PROVIDER_LABELS: Record<RealtimeVoiceProvider, string> = {
  openai: 'OpenAI Realtime',
  elevenlabs: 'ElevenLabs Conversational AI',
  deepgram: 'Deepgram + LLM + TTS',
  gemini: 'Google Gemini Live',
  cartesia: 'Cartesia',
};

interface SettingsSpeechTabProps {
  devices: AudioDevice[];
  sttProviders: string[];
  ttsProviders: string[];
  realtimeProviders: RealtimeVoiceProvider[];
  activeSttProvider?: string;
  activeTtsProvider?: string;
  realtimeProvider?: RealtimeVoiceProvider | null;
  selectedIndex: number;
  speechMicEnd: number;
  speechSttEnd: number;
  speechTtsEnd: number;
}

export function SettingsSpeechTab({
  devices,
  sttProviders,
  ttsProviders,
  realtimeProviders,
  activeSttProvider,
  activeTtsProvider,
  realtimeProvider,
  selectedIndex,
  speechMicEnd,
  speechSttEnd,
  speechTtsEnd,
}: SettingsSpeechTabProps) {
  return (
    <Box flexDirection="column">
      {/* Microphone section */}
      <Box flexDirection="column">
        <Text bold>Microphone</Text>
        {devices.length === 0 ? (
          <Text dimColor>  No audio devices found. Install: brew install switchaudio-osx</Text>
        ) : (
          devices.map((device, idx) => {
            const rowIndex = idx;
            return (
              <Box key={device.name}>
                <Text color={rowIndex === selectedIndex ? 'cyan' : undefined}>
                  {rowIndex === selectedIndex ? '\u25B8 ' : '  '}
                </Text>
                <Text dimColor>{idx + 1}. </Text>
                <Text color={device.isDefault ? 'green' : undefined} bold={device.isDefault}>
                  {device.name}
                </Text>
                {device.isDefault && <Text color="green"> (active)</Text>}
              </Box>
            );
          })
        )}
      </Box>

      {/* Speech-to-Text section */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Speech-to-Text</Text>
        {sttProviders.length === 0 ? (
          <Text dimColor>  Current provider: {activeSttProvider || 'Unknown'}</Text>
        ) : (
          sttProviders.map((provider, idx) => {
            const rowIndex = speechMicEnd + idx;
            return (
              <Box key={provider}>
                <Text color={rowIndex === selectedIndex ? 'cyan' : undefined}>
                  {rowIndex === selectedIndex ? '\u25B8 ' : '  '}
                </Text>
                <Text dimColor>{idx + 1}. </Text>
                <Text
                  color={provider === activeSttProvider ? 'green' : undefined}
                  bold={provider === activeSttProvider}
                >
                  {STT_PROVIDER_LABELS[provider] || provider}
                </Text>
                {provider === activeSttProvider && <Text color="green"> (active)</Text>}
              </Box>
            );
          })
        )}
      </Box>

      {/* Text-to-Speech section */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Text-to-Speech</Text>
        {ttsProviders.length === 0 ? (
          <Text dimColor>  Current provider: {activeTtsProvider || 'Unknown'}</Text>
        ) : (
          ttsProviders.map((provider, idx) => {
            const rowIndex = speechSttEnd + idx;
            return (
              <Box key={provider}>
                <Text color={rowIndex === selectedIndex ? 'cyan' : undefined}>
                  {rowIndex === selectedIndex ? '\u25B8 ' : '  '}
                </Text>
                <Text dimColor>{idx + 1}. </Text>
                <Text
                  color={provider === activeTtsProvider ? 'green' : undefined}
                  bold={provider === activeTtsProvider}
                >
                  {TTS_PROVIDER_LABELS[provider] || provider}
                </Text>
                {provider === activeTtsProvider && <Text color="green"> (active)</Text>}
              </Box>
            );
          })
        )}
      </Box>

      {/* Live Chat section */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Live Chat</Text>
        {realtimeProviders.length === 0 ? (
          <Text dimColor>  No realtime voice providers configured on gateway.</Text>
        ) : (
          realtimeProviders.map((provider, idx) => {
            const rowIndex = speechTtsEnd + idx;
            return (
              <Box key={provider}>
                <Text color={rowIndex === selectedIndex ? 'cyan' : undefined}>
                  {rowIndex === selectedIndex ? '\u25B8 ' : '  '}
                </Text>
                <Text dimColor>{idx + 1}. </Text>
                <Text
                  color={provider === realtimeProvider ? 'green' : undefined}
                  bold={provider === realtimeProvider}
                >
                  {REALTIME_PROVIDER_LABELS[provider]}
                </Text>
                {provider === realtimeProvider && <Text color="green"> (active)</Text>}
              </Box>
            );
          })
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Use ^V to toggle AI Voice | ^C to start Live Chat</Text>
      </Box>
    </Box>
  );
}
