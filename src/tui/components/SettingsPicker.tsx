/**
 * Settings Picker Component
 *
 * Modal for configuring voice settings: microphone, STT provider, etc.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { execSync } from 'child_process';
import type { RealtimeVoiceCapabilities, RealtimeVoiceProvider } from '../../types.js';

interface AudioDevice {
  name: string;
  isDefault: boolean;
}

interface VoiceCapsInfo {
  sttProviders: string[];
  sttActiveProvider?: string;
  ttsProviders: string[];
  ttsActiveProvider?: string;
}

interface SettingsPickerProps {
  onClose: () => void;
  onMicChange?: (device: string) => void;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenTalks: () => void;
  onExit: () => void;
  setError: (error: string) => void;
  // Voice provider props
  voiceCaps?: VoiceCapsInfo;
  onSttProviderChange?: (provider: string) => Promise<boolean>;
  onTtsProviderChange?: (provider: string) => Promise<boolean>;
  // Realtime voice props
  realtimeVoiceCaps?: RealtimeVoiceCapabilities | null;
  realtimeProvider?: RealtimeVoiceProvider | null;
  onRealtimeProviderChange?: (provider: RealtimeVoiceProvider) => void;
}

type SettingsTab = 'mic' | 'stt' | 'tts' | 'realtime';

const PROVIDER_LABELS: Record<RealtimeVoiceProvider, string> = {
  openai: 'OpenAI Realtime',
  elevenlabs: 'ElevenLabs Conversational AI',
  deepgram: 'Deepgram + LLM + TTS',
  gemini: 'Google Gemini Live',
  cartesia: 'Cartesia',
};

function getInputDevices(): AudioDevice[] {
  try {
    // Use SwitchAudioSource to list input devices
    const output = execSync('SwitchAudioSource -a -t input', { encoding: 'utf-8', timeout: 3000 });
    const current = execSync('SwitchAudioSource -c -t input', { encoding: 'utf-8', timeout: 3000 }).trim();

    return output.trim().split('\n').filter(Boolean).map(name => ({
      name,
      isDefault: name === current,
    }));
  } catch {
    return [];
  }
}

function setInputDevice(name: string): boolean {
  try {
    execSync(`SwitchAudioSource -s "${name}" -t input`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// Provider display labels
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

export function SettingsPicker({
  onClose,
  onMicChange,
  onNewChat,
  onToggleTts,
  onOpenTalks,
  onExit,
  setError,
  voiceCaps,
  onSttProviderChange,
  onTtsProviderChange,
  realtimeVoiceCaps,
  realtimeProvider,
  onRealtimeProviderChange,
}: SettingsPickerProps) {
  const [tab, setTab] = useState<SettingsTab>('mic');
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [activeSttProvider, setActiveSttProvider] = useState<string | undefined>(voiceCaps?.sttActiveProvider);
  const [activeTtsProvider, setActiveTtsProvider] = useState<string | undefined>(voiceCaps?.ttsActiveProvider);

  // Available providers
  const sttProviders = voiceCaps?.sttProviders ?? [];
  const ttsProviders = voiceCaps?.ttsProviders ?? [];
  const realtimeProviders = realtimeVoiceCaps?.providers ?? [];

  useEffect(() => {
    const devs = getInputDevices();
    setDevices(devs);
    // Select the current default device
    const defaultIdx = devs.findIndex(d => d.isDefault);
    if (defaultIdx >= 0) setSelectedIndex(defaultIdx);
  }, []);

  useInput((input, key) => {
    // Global shortcuts
    if (input === 't' && key.ctrl) {
      onOpenTalks();
      return;
    }
    if (input === 'n' && key.ctrl) {
      onNewChat();
      return;
    }
    if (input === 'v' && key.ctrl) {
      onToggleTts();
      return;
    }
    if (input === 's' && key.ctrl) {
      onClose(); // Already in Settings
      return;
    }
    if (input === 'x' && key.ctrl) {
      onExit();
      return;
    }
    // ^C and ^P - voice not available outside Talk
    if ((input === 'c' || input === 'p') && key.ctrl) {
      setError('You can only use voice input in a Talk!');
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }

    // Tab navigation with left/right
    const allTabs: SettingsTab[] = ['mic', 'stt', 'tts', 'realtime'];
    if (key.leftArrow) {
      setTab(prev => {
        const idx = allTabs.indexOf(prev);
        return allTabs[(idx - 1 + allTabs.length) % allTabs.length];
      });
      setSelectedIndex(0);
      return;
    }
    if (key.rightArrow) {
      setTab(prev => {
        const idx = allTabs.indexOf(prev);
        return allTabs[(idx + 1) % allTabs.length];
      });
      setSelectedIndex(0);
      return;
    }

    // Item navigation with up/down
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      const maxIndex = tab === 'mic' ? devices.length - 1
        : tab === 'stt' ? sttProviders.length - 1
        : tab === 'tts' ? ttsProviders.length - 1
        : tab === 'realtime' ? realtimeProviders.length - 1
        : 0;
      setSelectedIndex(prev => Math.min(maxIndex, prev + 1));
      return;
    }

    // Select with Enter
    if (key.return) {
      if (tab === 'mic' && devices[selectedIndex]) {
        const device = devices[selectedIndex];
        if (setInputDevice(device.name)) {
          setDevices(prev => prev.map(d => ({ ...d, isDefault: d.name === device.name })));
          setMessage(`Switched to: ${device.name}`);
          onMicChange?.(device.name);
          setTimeout(() => setMessage(null), 2000);
        } else {
          setMessage('Failed to switch device');
          setTimeout(() => setMessage(null), 2000);
        }
      } else if (tab === 'stt' && sttProviders[selectedIndex]) {
        const provider = sttProviders[selectedIndex];
        setMessage('Switching STT provider...');
        onSttProviderChange?.(provider).then(success => {
          if (success) {
            setActiveSttProvider(provider);
            setMessage(`STT: ${STT_PROVIDER_LABELS[provider] || provider}`);
          } else {
            setMessage('Failed to switch STT provider');
          }
          setTimeout(() => setMessage(null), 2000);
        });
      } else if (tab === 'tts' && ttsProviders[selectedIndex]) {
        const provider = ttsProviders[selectedIndex];
        setMessage('Switching TTS provider...');
        onTtsProviderChange?.(provider).then(success => {
          if (success) {
            setActiveTtsProvider(provider);
            setMessage(`TTS: ${TTS_PROVIDER_LABELS[provider] || provider}`);
          } else {
            setMessage('Failed to switch TTS provider');
          }
          setTimeout(() => setMessage(null), 2000);
        });
      } else if (tab === 'realtime' && realtimeProviders[selectedIndex]) {
        const provider = realtimeProviders[selectedIndex];
        onRealtimeProviderChange?.(provider);
        setMessage(`Realtime provider: ${PROVIDER_LABELS[provider]}`);
        setTimeout(() => setMessage(null), 2000);
      }
      return;
    }

    // Number keys for quick selection
    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= 9) {
      const idx = num - 1;
      if (tab === 'mic' && idx < devices.length) {
        setSelectedIndex(idx);
        const device = devices[idx];
        if (setInputDevice(device.name)) {
          setDevices(prev => prev.map(d => ({ ...d, isDefault: d.name === device.name })));
          setMessage(`Switched to: ${device.name}`);
          onMicChange?.(device.name);
          setTimeout(() => setMessage(null), 2000);
        }
      } else if (tab === 'stt' && idx < sttProviders.length) {
        setSelectedIndex(idx);
        const provider = sttProviders[idx];
        onSttProviderChange?.(provider).then(success => {
          if (success) {
            setActiveSttProvider(provider);
            setMessage(`STT: ${STT_PROVIDER_LABELS[provider] || provider}`);
          } else {
            setMessage('Failed to switch STT provider');
          }
          setTimeout(() => setMessage(null), 2000);
        });
      } else if (tab === 'tts' && idx < ttsProviders.length) {
        setSelectedIndex(idx);
        const provider = ttsProviders[idx];
        onTtsProviderChange?.(provider).then(success => {
          if (success) {
            setActiveTtsProvider(provider);
            setMessage(`TTS: ${TTS_PROVIDER_LABELS[provider] || provider}`);
          } else {
            setMessage('Failed to switch TTS provider');
          }
          setTimeout(() => setMessage(null), 2000);
        });
      } else if (tab === 'realtime' && idx < realtimeProviders.length) {
        setSelectedIndex(idx);
        const provider = realtimeProviders[idx];
        onRealtimeProviderChange?.(provider);
        setMessage(`Realtime provider: ${PROVIDER_LABELS[provider]}`);
        setTimeout(() => setMessage(null), 2000);
      }
    }
  });

  const tabs: SettingsTab[] = ['mic', 'stt', 'tts', 'realtime'];
  const tabLabels: Record<SettingsTab, string> = {
    mic: 'Microphone',
    stt: 'Speech-to-Text',
    tts: 'Text-to-Speech',
    realtime: 'Live Chat',
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="cyan">Settings</Text>
      </Box>

      {/* Tab bar */}
      <Box marginBottom={1}>
        {tabs.map((t, i) => (
          <React.Fragment key={t}>
            {i > 0 && <Text dimColor> │ </Text>}
            <Text
              color={tab === t ? 'cyan' : undefined}
              bold={tab === t}
              dimColor={tab !== t}
            >
              {tabLabels[t]}
            </Text>
          </React.Fragment>
        ))}
        <Text dimColor>  (←/→ to switch tabs)</Text>
      </Box>

      {/* Tab content */}
      {tab === 'mic' && (
        <Box flexDirection="column">
          {devices.length === 0 ? (
            <Text dimColor>No audio devices found. Install: brew install switchaudio-osx</Text>
          ) : (
            devices.map((device, idx) => (
              <Box key={device.name}>
                <Text color={idx === selectedIndex ? 'cyan' : undefined}>
                  {idx === selectedIndex ? '▸ ' : '  '}
                </Text>
                <Text dimColor>{idx + 1}. </Text>
                <Text color={device.isDefault ? 'green' : undefined} bold={device.isDefault}>
                  {device.name}
                </Text>
                {device.isDefault && <Text color="green"> (active)</Text>}
              </Box>
            ))
          )}
        </Box>
      )}

      {tab === 'stt' && (
        <Box flexDirection="column">
          {sttProviders.length === 0 ? (
            <>
              <Text dimColor>Speech-to-Text is configured on the gateway server.</Text>
              <Text dimColor>Current provider: {activeSttProvider || 'Unknown'}</Text>
            </>
          ) : (
            sttProviders.map((provider, idx) => (
              <Box key={provider}>
                <Text color={idx === selectedIndex ? 'cyan' : undefined}>
                  {idx === selectedIndex ? '▸ ' : '  '}
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
            ))
          )}
        </Box>
      )}

      {tab === 'tts' && (
        <Box flexDirection="column">
          {ttsProviders.length === 0 ? (
            <>
              <Text dimColor>Text-to-Speech is configured on the gateway server.</Text>
              <Text dimColor>Current provider: {activeTtsProvider || 'Unknown'}</Text>
              <Text dimColor>Use ^V to toggle AI Voice on/off.</Text>
            </>
          ) : (
            <>
              {ttsProviders.map((provider, idx) => (
                <Box key={provider}>
                  <Text color={idx === selectedIndex ? 'cyan' : undefined}>
                    {idx === selectedIndex ? '▸ ' : '  '}
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
              ))}
              <Box marginTop={1}>
                <Text dimColor>Use ^V to toggle AI Voice on/off.</Text>
              </Box>
            </>
          )}
        </Box>
      )}

      {tab === 'realtime' && (
        <Box flexDirection="column">
          <Box marginBottom={1}><Text bold>Realtime Voice Provider</Text></Box>
          {realtimeProviders.length === 0 ? (
            <Text dimColor>No realtime voice providers configured on gateway.</Text>
          ) : (
            realtimeProviders.map((provider, idx) => (
              <Box key={provider}>
                <Text color={idx === selectedIndex ? 'cyan' : undefined}>
                  {idx === selectedIndex ? '▸ ' : '  '}
                </Text>
                <Text dimColor>{idx + 1}. </Text>
                <Text
                  color={provider === realtimeProvider ? 'green' : undefined}
                  bold={provider === realtimeProvider}
                >
                  {PROVIDER_LABELS[provider]}
                </Text>
                {provider === realtimeProvider && <Text color="green"> (active)</Text>}
              </Box>
            ))
          )}
          <Box marginTop={1}>
            <Text dimColor>Use ^C to start Live Chat with the selected provider.</Text>
          </Box>
        </Box>
      )}

      {/* Status message */}
      {message && (
        <Box marginTop={1}>
          <Text color="green">{message}</Text>
        </Box>
      )}

      {/* Help */}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate  Enter/1-9 select  Esc close</Text>
      </Box>
    </Box>
  );
}
