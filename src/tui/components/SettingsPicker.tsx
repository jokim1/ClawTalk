/**
 * Settings Picker Component
 *
 * Modal for configuring voice settings: microphone, STT provider, etc.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { execSync } from 'child_process';
import type {
  GoogleAuthProfileSummary,
  RealtimeVoiceCapabilities,
  RealtimeVoiceProvider,
  ToolCatalogEntry,
  ToolDescriptor,
  ToolExecutionMode,
  ToolExecutionModeOption,
  ToolFilesystemAccess,
  ToolNetworkAccess,
  ToolMode,
} from '../../types.js';

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

interface TalkConfigInfo {
  objective?: string;
  directives: Array<{ text: string; active: boolean }>;
  platformBindings: Array<{
    platform: string;
    scope: string;
    displayScope?: string;
    accountId?: string;
    permission: string;
  }>;
  channelResponseSettings: Array<{
    connectionIndex: number;
    autoRespond: boolean;
    agentName?: string;
    onMessagePrompt?: string;
  }>;
  jobs: Array<{ schedule: string; prompt: string; active: boolean }>;
  agents: Array<{ name: string; role: string; model: string; isPrimary: boolean }>;
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
  // Talk config
  talkConfig?: TalkConfigInfo | null;
  hideTalkConfig?: boolean;
  initialTab?: SettingsTab;
  toolPolicy?: {
    mode: ToolMode;
    executionMode: ToolExecutionMode;
    executionModeOptions: ToolExecutionModeOption[];
    filesystemAccess: ToolFilesystemAccess;
    filesystemAccessOptions?: ToolFilesystemAccess[];
    networkAccess: ToolNetworkAccess;
    networkAccessOptions?: ToolNetworkAccess[];
    availableTools: ToolDescriptor[];
    effectiveTools?: ToolDescriptor[];
    enabledToolNames: string[];
    catalogEntries?: ToolCatalogEntry[];
    installedToolNames?: string[];
  } | null;
  toolPolicyLoading?: boolean;
  toolPolicyError?: string | null;
  onRefreshToolPolicy?: () => void;
  onSetToolMode?: (mode: ToolMode) => void;
  onSetExecutionMode?: (mode: ToolExecutionMode) => void;
  onSetFilesystemAccess?: (mode: ToolFilesystemAccess) => void;
  onSetNetworkAccess?: (mode: ToolNetworkAccess) => void;
  onSetToolEnabled?: (toolName: string, enabled: boolean) => void;
  talkGoogleAuthProfile?: string;
  googleAuthActiveProfile?: string;
  googleAuthProfiles?: GoogleAuthProfileSummary[];
  googleAuthStatus?: {
    profile?: string;
    activeProfile?: string;
    accessTokenReady: boolean;
    accountEmail?: string;
    accountDisplayName?: string;
    identityError?: string;
    error?: string;
  };
  onStartGoogleOAuthConnect?: () => void;
  onSetTalkGoogleAuthProfile?: (profile: string | undefined) => void;
  onInstallCatalogTool?: (catalogId: string) => void;
  onUninstallCatalogTool?: (catalogId: string) => void;
}

type SettingsTab = 'mic' | 'stt' | 'tts' | 'realtime' | 'talk' | 'tools';

const PROVIDER_LABELS: Record<RealtimeVoiceProvider, string> = {
  openai: 'OpenAI Realtime',
  elevenlabs: 'ElevenLabs Conversational AI',
  deepgram: 'Deepgram + LLM + TTS',
  gemini: 'Google Gemini Live',
  cartesia: 'Cartesia',
};

function formatBindingScopeLabel(binding: {
  scope: string;
  displayScope?: string;
  accountId?: string;
}): string {
  const scopeLabel = binding.displayScope?.trim() || binding.scope;
  if (binding.accountId?.trim()) {
    return `${binding.accountId}:${scopeLabel}`;
  }
  return scopeLabel;
}

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
  talkConfig,
  hideTalkConfig,
  initialTab,
  toolPolicy,
  toolPolicyLoading,
  toolPolicyError,
  onRefreshToolPolicy,
  onSetToolMode,
  onSetExecutionMode,
  onSetFilesystemAccess,
  onSetNetworkAccess,
  onSetToolEnabled,
  talkGoogleAuthProfile,
  googleAuthActiveProfile,
  googleAuthProfiles,
  googleAuthStatus,
  onStartGoogleOAuthConnect,
  onSetTalkGoogleAuthProfile,
  onInstallCatalogTool,
  onUninstallCatalogTool,
}: SettingsPickerProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? (hideTalkConfig ? 'mic' : 'talk'));
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [activeSttProvider, setActiveSttProvider] = useState<string | undefined>(voiceCaps?.sttActiveProvider);
  const [activeTtsProvider, setActiveTtsProvider] = useState<string | undefined>(voiceCaps?.ttsActiveProvider);

  // Available providers
  const sttProviders = voiceCaps?.sttProviders ?? [];
  const ttsProviders = voiceCaps?.ttsProviders ?? [];
  const realtimeProviders = realtimeVoiceCaps?.providers ?? [];
  const toolRows = toolPolicy?.effectiveTools ?? toolPolicy?.availableTools ?? [];
  const catalogRows = toolPolicy?.catalogEntries ?? [];
  const authProfiles = googleAuthProfiles ?? [];
  const profileRowCount = 1 + authProfiles.length; // inherit + explicit profiles
  const executionModeOptions: ToolExecutionModeOption[] = toolPolicy?.executionModeOptions?.length
    ? toolPolicy.executionModeOptions
    : [
      { value: 'openclaw', label: 'openclaw_agent', title: 'OpenClaw Agent', description: 'Uses OpenClaw runtime capabilities.' },
      { value: 'full_control', label: 'clawtalk_proxy', title: 'ClawTalk Proxy', description: 'Sends prompts directly via proxy.' },
    ];
  const filesystemOptions: ToolFilesystemAccess[] = toolPolicy?.filesystemAccessOptions?.length
    ? toolPolicy.filesystemAccessOptions
    : ['workspace_sandbox', 'full_host_access'];
  const filesystemDescriptions: Record<ToolFilesystemAccess, string> = {
    workspace_sandbox: 'Workspace Sandbox',
    full_host_access: 'Full Host Access',
  };
  const networkOptions: ToolNetworkAccess[] = toolPolicy?.networkAccessOptions?.length
    ? toolPolicy.networkAccessOptions
    : ['restricted', 'full_outbound'];
  const networkDescriptions: Record<ToolNetworkAccess, string> = {
    restricted: 'Restricted',
    full_outbound: 'Full Outbound',
  };
  const toolModes: ToolMode[] = ['off', 'confirm', 'auto'];
  const toolModeDescriptions: Record<ToolMode, string> = {
    off: 'model cannot use tools',
    confirm: 'approval required',
    auto: 'no approval',
  };
  const executionRowCount = executionModeOptions.length;
  const toolApprovalRowCount = toolModes.length;
  const filesystemRowCount = filesystemOptions.length;
  const networkRowCount = networkOptions.length;
  const profileStartIndex = executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount;
  const toolsStartIndex = profileStartIndex + profileRowCount;
  const catalogStartIndex = toolsStartIndex + toolRows.length;
  const toolEnabledSet = new Set(toolPolicy?.enabledToolNames ?? []);
  const effectiveGoogleProfile = talkGoogleAuthProfile || googleAuthActiveProfile;
  const selectedGoogleProfile = authProfiles.find((profile) => profile.name === effectiveGoogleProfile);
  const toolBlockReasonByName = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const tool of toolRows) {
      let reason: string | undefined;
      if (tool.capability && tool.capability.runnable === false) {
        reason = tool.capability.reason || 'not runnable in this environment';
      }
      if (!reason && typeof tool.reason === 'string' && tool.reason.trim()) {
        reason = tool.reason.trim();
      }
      if (!reason && tool.name.toLowerCase().startsWith('google_')) {
        if (!effectiveGoogleProfile) {
          reason = 'no Google profile selected';
        } else if (!selectedGoogleProfile) {
          reason = `Google profile "${effectiveGoogleProfile}" not found`;
        } else if (!selectedGoogleProfile.hasClientId || !selectedGoogleProfile.hasClientSecret || !selectedGoogleProfile.hasRefreshToken) {
          reason = `Google profile "${effectiveGoogleProfile}" is incomplete`;
        } else if (
          googleAuthStatus?.accessTokenReady === false
          && (googleAuthStatus.profile ?? googleAuthStatus.activeProfile) === effectiveGoogleProfile
        ) {
          reason = `Google profile "${effectiveGoogleProfile}" needs re-auth`;
        }
      }
      if (reason) reasons.set(tool.name, reason);
    }
    return reasons;
  }, [effectiveGoogleProfile, googleAuthStatus?.accessTokenReady, googleAuthStatus?.activeProfile, googleAuthStatus?.profile, selectedGoogleProfile, toolRows]);

  useEffect(() => {
    const devs = getInputDevices();
    setDevices(devs);
    // Select the current default device
    const defaultIdx = devs.findIndex(d => d.isDefault);
    if (defaultIdx >= 0) setSelectedIndex(defaultIdx);
  }, []);

  useEffect(() => {
    if (tab === 'tools') {
      onRefreshToolPolicy?.();
    }
  }, [tab, onRefreshToolPolicy]);

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

    if (tab === 'tools' && input.toLowerCase() === 'r') {
      onRefreshToolPolicy?.();
      setMessage('Refreshing tools...');
      setTimeout(() => setMessage(null), 1200);
      return;
    }

    if (tab === 'tools' && input.toLowerCase() === 'c') {
      onStartGoogleOAuthConnect?.();
      setMessage('Starting Google OAuth in browser...');
      setTimeout(() => setMessage(null), 1500);
      return;
    }

    // Tab navigation with left/right
    const allTabs: SettingsTab[] = hideTalkConfig
      ? ['tools', 'mic', 'stt', 'tts', 'realtime']
      : ['talk', 'tools', 'mic', 'stt', 'tts', 'realtime'];
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
        : tab === 'tools' ? Math.max(0, executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount + profileRowCount + toolRows.length + catalogRows.length - 1)
        : tab === 'talk' ? 0
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
      } else if (tab === 'tools') {
        if (selectedIndex < executionRowCount) {
          const mode = executionModeOptions[selectedIndex]?.value;
          if (!mode) return;
          onSetExecutionMode?.(mode);
          setMessage(`Execution mode: ${mode}`);
          setTimeout(() => setMessage(null), 2000);
          return;
        }
        if (selectedIndex < executionRowCount + toolApprovalRowCount) {
          const mode = toolModes[selectedIndex - executionRowCount];
          onSetToolMode?.(mode);
          setMessage(`Tool approval: ${mode}`);
          setTimeout(() => setMessage(null), 2000);
          return;
        }
        if (selectedIndex < executionRowCount + toolApprovalRowCount + filesystemRowCount) {
          const mode = filesystemOptions[selectedIndex - executionRowCount - toolApprovalRowCount];
          if (mode) {
            onSetFilesystemAccess?.(mode);
            setMessage(`Filesystem access: ${filesystemDescriptions[mode]}`);
            setTimeout(() => setMessage(null), 2000);
          }
          return;
        }
        if (selectedIndex < executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount) {
          const mode = networkOptions[selectedIndex - executionRowCount - toolApprovalRowCount - filesystemRowCount];
          if (mode) {
            onSetNetworkAccess?.(mode);
            setMessage(`Network access: ${networkDescriptions[mode]}`);
            setTimeout(() => setMessage(null), 2000);
          }
          return;
        }
        const profileIndex = selectedIndex - profileStartIndex;
        if (profileIndex >= 0 && profileIndex < profileRowCount) {
          if (profileIndex === 0) {
            onSetTalkGoogleAuthProfile?.(undefined);
            setMessage('Talk profile: inherit active');
          } else {
            const profile = authProfiles[profileIndex - 1];
            if (profile) {
              onSetTalkGoogleAuthProfile?.(profile.name);
              setMessage(`Talk profile: ${profile.name}`);
            }
          }
          setTimeout(() => setMessage(null), 2000);
          return;
        }

        const toolIndex = selectedIndex - toolsStartIndex;
        const tool = toolRows[toolIndex] ?? null;
        if (tool) {
          const blockedReason = toolBlockReasonByName.get(tool.name);
          if (blockedReason) {
            setMessage(`Cannot enable ${tool.name}: ${blockedReason}`);
            setTimeout(() => setMessage(null), 2200);
            return;
          }
          const currentlyEnabled = toolEnabledSet.has(tool.name);
          onSetToolEnabled?.(tool.name, !currentlyEnabled);
          setMessage(`${!currentlyEnabled ? 'Enabled' : 'Disabled'} ${tool.name}`);
          setTimeout(() => setMessage(null), 2000);
          return;
        }

        const catalogIndex = toolIndex - toolRows.length;
        const catalog = catalogRows[catalogIndex];
        if (catalog) {
          if (catalog.installed) {
            onUninstallCatalogTool?.(catalog.id);
            setMessage(`Uninstalling ${catalog.name}...`);
          } else if (catalog.canInstall) {
            onInstallCatalogTool?.(catalog.id);
            setMessage(`Installing ${catalog.name}...`);
          } else {
            setMessage(`${catalog.name} is not installable in this build.`);
          }
          setTimeout(() => setMessage(null), 2000);
        }
      }
      return;
    }

    if (tab === 'tools' && input === ' ') {
      if (selectedIndex >= toolsStartIndex && selectedIndex < catalogStartIndex) {
        const toolIndex = selectedIndex - toolsStartIndex;
        const tool = toolRows[toolIndex];
        if (tool) {
          const blockedReason = toolBlockReasonByName.get(tool.name);
          if (blockedReason) {
            setMessage(`Cannot enable ${tool.name}: ${blockedReason}`);
            setTimeout(() => setMessage(null), 2200);
            return;
          }
          const currentlyEnabled = toolEnabledSet.has(tool.name);
          onSetToolEnabled?.(tool.name, !currentlyEnabled);
          setMessage(`${!currentlyEnabled ? 'Enabled' : 'Disabled'} ${tool.name}`);
          setTimeout(() => setMessage(null), 2000);
        }
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
      } else if (tab === 'tools') {
        const max = executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount + profileRowCount + toolRows.length + catalogRows.length;
        if (idx < max) setSelectedIndex(idx);
      }
    }
  });

  const tabs: SettingsTab[] = hideTalkConfig
    ? ['tools', 'mic', 'stt', 'tts', 'realtime']
    : ['talk', 'tools', 'mic', 'stt', 'tts', 'realtime'];
  const tabLabels: Record<SettingsTab, string> = {
    mic: 'Microphone',
    stt: 'Speech-to-Text',
    tts: 'Text-to-Speech',
    realtime: 'Live Chat',
    talk: 'Talk Config',
    tools: 'Tools',
  };

  return (
    <Box flexDirection="column" width="100%" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="cyan">Settings</Text>
        <Text dimColor>  ({'\u2190'}/{'\u2192'} to switch tabs)</Text>
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

      {tab === 'tools' && (
        <Box flexDirection="column">
          {toolPolicyLoading ? (
            <Text dimColor>Loading tool settings...</Text>
          ) : (
            <>
              <Text dimColor>Tool Approval controls whether the model can call tools automatically.</Text>
              <Text dimColor>Execution Mode controls routing path. Filesystem/Network Access apply policy restrictions.</Text>
              <Text dimColor>Press c to connect another Google account in browser OAuth flow.</Text>
              <Box marginTop={1} flexDirection="column">
                <Text bold>Execution Mode</Text>
                {executionModeOptions.map((mode, idx) => {
                  const active = (toolPolicy?.executionMode ?? 'openclaw') === mode.value;
                  return (
                    <Box key={mode.value}>
                      <Text color={idx === selectedIndex ? 'cyan' : undefined}>
                        {idx === selectedIndex ? '▸ ' : '  '}
                      </Text>
                      <Text dimColor>{idx + 1}. </Text>
                      <Text color={active ? 'green' : undefined} bold={active}>
                        {mode.title}
                      </Text>
                      <Text dimColor> ({mode.description})</Text>
                      {active && <Text color="green"> (active)</Text>}
                    </Box>
                  );
                })}
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text bold>Tool Approval</Text>
                {toolModes.map((mode, idx) => {
                  const rowIndex = executionRowCount + idx;
                  const active = toolPolicy?.mode === mode;
                  return (
                    <Box key={mode}>
                      <Text color={rowIndex === selectedIndex ? 'cyan' : undefined}>
                        {rowIndex === selectedIndex ? '▸ ' : '  '}
                      </Text>
                      <Text dimColor>{idx + 1}. </Text>
                      <Text color={active ? 'green' : undefined} bold={active}>
                        {mode}
                      </Text>
                      <Text dimColor> ({toolModeDescriptions[mode]})</Text>
                      {active && <Text color="green"> (active)</Text>}
                    </Box>
                  );
                })}
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text bold>Filesystem Access</Text>
                {filesystemOptions.map((mode, idx) => {
                  const rowIndex = executionRowCount + toolApprovalRowCount + idx;
                  const active = (toolPolicy?.filesystemAccess ?? 'full_host_access') === mode;
                  return (
                    <Box key={mode}>
                      <Text color={rowIndex === selectedIndex ? 'cyan' : undefined}>
                        {rowIndex === selectedIndex ? '▸ ' : '  '}
                      </Text>
                      <Text dimColor>{idx + 1}. </Text>
                      <Text color={active ? 'green' : undefined} bold={active}>
                        {filesystemDescriptions[mode]}
                      </Text>
                      {active && <Text color="green"> (active)</Text>}
                    </Box>
                  );
                })}
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text bold>Network Access</Text>
                {networkOptions.map((mode, idx) => {
                  const rowIndex = executionRowCount + toolApprovalRowCount + filesystemRowCount + idx;
                  const active = (toolPolicy?.networkAccess ?? 'full_outbound') === mode;
                  return (
                    <Box key={mode}>
                      <Text color={rowIndex === selectedIndex ? 'cyan' : undefined}>
                        {rowIndex === selectedIndex ? '▸ ' : '  '}
                      </Text>
                      <Text dimColor>{idx + 1}. </Text>
                      <Text color={active ? 'green' : undefined} bold={active}>
                        {networkDescriptions[mode]}
                      </Text>
                      {active && <Text color="green"> (active)</Text>}
                    </Box>
                  );
                })}
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text bold>Google Profile For This Talk</Text>
                {[{ name: '__inherit__', hasClientId: false, hasClientSecret: false, hasRefreshToken: false }, ...authProfiles].map((profile, idx) => {
                  const rowIndex = profileStartIndex + idx;
                  const selected = rowIndex === selectedIndex;
                  const isInherit = idx === 0;
                  const isActive = isInherit
                    ? !talkGoogleAuthProfile
                    : talkGoogleAuthProfile === profile.name;
                  const readiness = isInherit
                    ? `active: ${googleAuthActiveProfile ?? '(none)'}`
                    : (profile.hasClientId && profile.hasClientSecret && profile.hasRefreshToken ? 'ready' : 'incomplete');
                  const needsReauth = !isInherit
                    && profile.name === (googleAuthStatus?.profile ?? googleAuthStatus?.activeProfile)
                    && googleAuthStatus?.accessTokenReady === false;
                  const readinessLabel = needsReauth ? 'reauth required' : readiness;
                  const identity = !isInherit
                    ? (profile.accountEmail
                      ? `${profile.accountEmail}${profile.accountDisplayName ? ` (${profile.accountDisplayName})` : ''}`
                      : profile.name)
                    : '';
                  const label = isInherit ? 'inherit active profile' : identity;
                  return (
                    <Box key={label}>
                      <Text color={selected ? 'cyan' : undefined}>{selected ? '▸ ' : '  '}</Text>
                      <Text dimColor>{idx + 1}. </Text>
                      <Text color={isActive ? 'green' : undefined} bold={isActive}>{label}</Text>
                      {!isInherit && profile.accountEmail && profile.name !== profile.accountEmail && (
                        <Text dimColor> [{profile.name}]</Text>
                      )}
                      <Text dimColor> ({readinessLabel})</Text>
                      {isActive && <Text color="green"> (selected)</Text>}
                    </Box>
                  );
                })}
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text bold>Installed Tools</Text>
                <Text dimColor>  Tool                               Status   Source</Text>
                <Text dimColor>  ----------------------------------------------------</Text>
                {toolRows.length === 0 ? (
                  <Text dimColor>  (none installed)</Text>
                ) : (
                  toolRows.map((tool, idx) => {
                    const rowIndex = toolsStartIndex + idx;
                    const enabled = tool.enabled ?? toolEnabledSet.has(tool.name);
                    const blockedReason = toolBlockReasonByName.get(tool.name);
                    const status = blockedReason ? 'blocked' : (enabled ? 'on' : 'off');
                    const statusColor: 'green' | 'yellow' = blockedReason ? 'yellow' : (enabled ? 'green' : 'yellow');
                    const selected = rowIndex === selectedIndex;
                    const paddedName = tool.name.padEnd(34, ' ').slice(0, 34);
                    return (
                      <Box key={tool.name}>
                        <Text color={selected ? 'cyan' : undefined}>{selected ? '▸ ' : '  '}</Text>
                        <Text>{paddedName}</Text>
                        <Text>  </Text>
                        <Text color={statusColor}>{status.padEnd(7, ' ')}</Text>
                        <Text>      </Text>
                        <Text dimColor>{tool.builtin ? 'builtin' : 'gateway'}</Text>
                        {blockedReason && <Text dimColor> ({blockedReason})</Text>}
                      </Box>
                    );
                  })
                )}
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text bold>Tool Catalog</Text>
                <Text dimColor>  Package                             State          Version</Text>
                <Text dimColor>  -------------------------------------------------------------</Text>
                {catalogRows.length === 0 ? (
                  <Text dimColor>  (catalog unavailable)</Text>
                ) : (
                  catalogRows.map((entry, idx) => {
                    const rowIndex = catalogStartIndex + idx;
                    const selected = rowIndex === selectedIndex;
                    const state = entry.installed
                      ? 'installed'
                      : entry.canInstall
                        ? 'installable'
                        : entry.status === 'planned'
                          ? 'planned'
                          : 'unavailable';
                    const stateColor = state === 'installed'
                      ? 'green'
                      : state === 'installable'
                        ? 'cyan'
                        : 'yellow';
                    const paddedName = entry.name.padEnd(34, ' ').slice(0, 34);
                    return (
                      <Box key={entry.id}>
                        <Text color={selected ? 'cyan' : undefined}>{selected ? '▸ ' : '  '}</Text>
                        <Text>{paddedName}</Text>
                        <Text>  </Text>
                        <Text color={stateColor}>{state.padEnd(11, ' ')}</Text>
                        <Text>  </Text>
                        <Text dimColor>{entry.version}</Text>
                      </Box>
                    );
                  })
                )}
                {catalogRows.length > 0 && (
                  <Text dimColor>  Enter on a catalog row to install/uninstall.</Text>
                )}
              </Box>

              {toolPolicyError && (
                <Box marginTop={1}>
                  <Text color="yellow">{toolPolicyError}</Text>
                </Box>
              )}
              {googleAuthStatus?.accessTokenReady === false && (
                <Box marginTop={1} flexDirection="column">
                  <Text color="yellow">
                    Google auth requires re-auth for profile {googleAuthStatus.profile ?? googleAuthStatus.activeProfile ?? '(unknown)'}.
                  </Text>
                  <Text dimColor>
                    {googleAuthStatus.error?.split('\n')[0] ?? 'Refresh token invalid or expired.'}
                  </Text>
                </Box>
              )}
              <Box marginTop={1}>
                <Text dimColor>Tip: choose a profile above to route Google Docs/Drive tool calls for this talk.</Text>
              </Box>
            </>
          )}
        </Box>
      )}

      {tab === 'talk' && (
        <Box flexDirection="column">
          {!talkConfig ? (
            <Text dimColor>No active talk. Open or create a talk first.</Text>
          ) : (
            <>
              {/* Objectives */}
              <Box marginBottom={1} flexDirection="column">
                <Text bold>Objectives</Text>
                {talkConfig.objective ? (
                  <Text>  {talkConfig.objective}</Text>
                ) : (
                  <>
                    <Text dimColor>  (none) — /objectives {'<text>'} to set</Text>
                    <Text dimColor italic>  e.g. /objectives Help me produce 3 high quality blog posts per week in my voice</Text>
                  </>
                )}
                <Text dimColor>  Commands:</Text>
                <Text dimColor italic>  /objectives Ship the Q2 onboarding improvements with fewer support tickets</Text>
                <Text dimColor italic>  /objective Keep responses short and decision-focused for this project</Text>
                <Text dimColor italic>  /objective clear</Text>
              </Box>

              {/* Rules */}
              <Box marginBottom={1} flexDirection="column">
                <Text bold>Rules</Text>
                {talkConfig.directives.length > 0 ? (
                  talkConfig.directives.map((d, i) => (
                    <Text key={i}>
                      <Text dimColor>  {i + 1}. </Text>
                      <Text color={d.active ? undefined : 'yellow'}>[{d.active ? 'active' : 'paused'}] </Text>
                      <Text>{d.text}</Text>
                    </Text>
                  ))
                ) : (
                  <>
                    <Text dimColor>  (none) — /rule {'<text>'} to add</Text>
                    <Text dimColor italic>  e.g. /rule Be positive and encouraging</Text>
                    <Text dimColor italic>  e.g. /rule Answer Slack messages in real time</Text>
                  </>
                )}
                <Text dimColor>  Commands:</Text>
                <Text dimColor italic>  /rule Keep answers under 5 bullets unless I ask for detail</Text>
                <Text dimColor italic>  /rule Include risks and assumptions in every plan</Text>
                <Text dimColor italic>  /rules   /rule toggle 1   /rule delete 2</Text>
              </Box>

              {/* Channel Connections */}
              <Box marginBottom={1} flexDirection="column">
                <Text bold>Channel Connections</Text>
                {talkConfig.platformBindings.length > 0 ? (
                  talkConfig.platformBindings.map((b, i) => (
                    <Text key={i}>
                      <Text dimColor>  {i + 1}. </Text>
                      <Text>platform{i + 1}: </Text>
                      <Text bold>{b.platform}</Text>
                      <Text> {formatBindingScopeLabel(b)} </Text>
                      <Text dimColor>({b.permission})</Text>
                    </Text>
                  ))
                ) : (
                  <>
                    <Text dimColor>  (none) — press ^B to add a channel connection</Text>
                    <Text dimColor italic>  Slack full support (auto-response + connection)</Text>
                    <Text dimColor italic>  Telegram/WhatsApp: connection + event jobs</Text>
                    <Text dimColor italic>  Example: choose workspace "kimfamily", channel "#general", permission read+write</Text>
                  </>
                )}
                <Text dimColor>  Manage via ^B Channel Config.</Text>
              </Box>

              {/* Channel Response Settings */}
              <Box marginBottom={1} flexDirection="column">
                <Text bold>Channel Response Settings</Text>
                <Text dimColor>  Applies to Slack channel connections.</Text>
                {talkConfig.channelResponseSettings.length > 0 ? (
                  talkConfig.channelResponseSettings.map((s) => (
                    <Text key={s.connectionIndex}>
                      <Text dimColor>  {s.connectionIndex}. </Text>
                      <Text>auto:</Text>
                      <Text color={s.autoRespond ? 'green' : 'yellow'}>{s.autoRespond ? 'on' : 'off'}</Text>
                      <Text> agent:{s.agentName ?? '(default)'} </Text>
                      <Text>prompt:{s.onMessagePrompt ? `"${s.onMessagePrompt}"` : '(none)'}</Text>
                    </Text>
                  ))
                ) : (
                  <Text dimColor>  (none) — add channel connections first</Text>
                )}
                <Text dimColor>  Manage via ^B Channel Config.</Text>
              </Box>

              {/* Automations */}
              <Box marginBottom={1} flexDirection="column">
                <Text bold>Automations</Text>
                {talkConfig.jobs.length > 0 ? (
                  talkConfig.jobs.map((j, i) => (
                    <Text key={i}>
                      <Text dimColor>  {i + 1}. </Text>
                      <Text color={j.active ? undefined : 'yellow'}>[{j.active ? 'active' : 'paused'}] </Text>
                      <Text>"{j.schedule}" — {j.prompt}</Text>
                    </Text>
                  ))
                ) : (
                  <>
                    <Text dimColor>  (none) — press ^J to add an automation</Text>
                    <Text dimColor italic>  Example: schedule "daily 9am", prompt "Summarize unresolved issues and owners"</Text>
                  </>
                )}
                <Text dimColor>  Manage via ^J Jobs.</Text>
              </Box>
            </>
          )}
        </Box>
      )}

      {/* Status message */}
      {message && (
        <Box marginTop={1}>
          <Text color="green">{message}</Text>
        </Box>
      )}

      {/* Help */}
      {tab !== 'talk' && (
        <Box marginTop={1}>
          {tab === 'tools' ? (
            <Text dimColor>↑/↓ navigate  Enter select/install  Space toggle tool  r refresh  Esc close</Text>
          ) : (
            <Text dimColor>↑/↓ navigate  Enter/1-9 select  Esc close</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
