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
  SkillDescriptor,
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
    responseMode: 'off' | 'mentions' | 'all';
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
  // Skills props
  skills?: SkillDescriptor[];
  skillsLoading?: boolean;
  skillsError?: string | null;
  allSkillsMode?: boolean;
  onToggleSkill?: (skillName: string) => void;
  onResetSkillsToAll?: () => void;
}

type SettingsTab = 'speech' | 'talk' | 'tools' | 'skills';

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

function normalizeExecutionMode(raw: unknown): ToolExecutionMode {
  return raw === 'full_control' ? 'full_control' : 'openclaw';
}

function normalizeExecutionModeOptions(raw: unknown): ToolExecutionModeOption[] {
  if (!Array.isArray(raw)) {
    return [
      { value: 'openclaw', label: 'openclaw_agent', title: 'OpenClaw Agent', description: 'OpenClaw agent runtime, tools, and session behavior.' },
      { value: 'full_control', label: 'clawtalk_proxy', title: 'ClawTalk Proxy', description: 'Sends prompts directly via proxy.' },
    ];
  }

  const parsed = raw
    .map((entry) => {
      if (typeof entry !== 'object' || !entry) return null;
      const rec = entry as Record<string, unknown>;
      const value = normalizeExecutionMode(rec.value);
      const label = rec.label === 'clawtalk_proxy' ? 'clawtalk_proxy' : 'openclaw_agent';
      const title = typeof rec.title === 'string' ? rec.title : (value === 'full_control' ? 'ClawTalk Proxy' : 'OpenClaw Agent');
      const description = typeof rec.description === 'string'
        ? rec.description
        : (value === 'full_control' ? 'Sends prompts directly via proxy.' : 'OpenClaw agent runtime, tools, and session behavior.');
      return { value, label, title, description } as ToolExecutionModeOption;
    })
    .filter((entry): entry is ToolExecutionModeOption => Boolean(entry));

  return parsed.length > 0
    ? parsed
    : [
      { value: 'openclaw', label: 'openclaw_agent', title: 'OpenClaw Agent', description: 'OpenClaw agent runtime, tools, and session behavior.' },
      { value: 'full_control', label: 'clawtalk_proxy', title: 'ClawTalk Proxy', description: 'Sends prompts directly via proxy.' },
    ];
}

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
  skills: skillsProp,
  skillsLoading,
  skillsError,
  allSkillsMode,
  onToggleSkill,
  onResetSkillsToAll,
}: SettingsPickerProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? (hideTalkConfig ? 'speech' : 'talk'));
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [activeSttProvider, setActiveSttProvider] = useState<string | undefined>(voiceCaps?.sttActiveProvider);
  const [activeTtsProvider, setActiveTtsProvider] = useState<string | undefined>(voiceCaps?.ttsActiveProvider);

  // Available providers
  const sttProviders = voiceCaps?.sttProviders ?? [];
  const ttsProviders = voiceCaps?.ttsProviders ?? [];
  const realtimeProviders = realtimeVoiceCaps?.providers ?? [];

  // Speech tab: unified section offsets for continuous cursor navigation
  const speechMicEnd = devices.length;
  const speechSttEnd = speechMicEnd + sttProviders.length;
  const speechTtsEnd = speechSttEnd + ttsProviders.length;
  const speechRowCount = speechTtsEnd + realtimeProviders.length;
  const resolveSpeechSection = (index: number): { section: 'mic' | 'stt' | 'tts' | 'realtime'; localIndex: number } => {
    if (index < speechMicEnd) return { section: 'mic', localIndex: index };
    if (index < speechSttEnd) return { section: 'stt', localIndex: index - speechMicEnd };
    if (index < speechTtsEnd) return { section: 'tts', localIndex: index - speechSttEnd };
    return { section: 'realtime', localIndex: index - speechTtsEnd };
  };

  const toolRows = toolPolicy?.effectiveTools ?? toolPolicy?.availableTools ?? [];
  const catalogRows = toolPolicy?.catalogEntries ?? [];
  const authProfiles = googleAuthProfiles ?? [];
  const profileRowCount = 1 + authProfiles.length; // inherit + explicit profiles
  const executionModeOptions: ToolExecutionModeOption[] = normalizeExecutionModeOptions(toolPolicy?.executionModeOptions);
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
  const padCell = (value: string, width: number): string => {
    if (value.length >= width) return value.slice(0, width);
    return value.padEnd(width, ' ');
  };
  const buildDivider = (widths: number[]): string => `  ${'-'.repeat(widths.reduce((sum, width) => sum + width, 0) + ((widths.length - 1) * 2))}`;
  const toolNameColWidth = 28;
  const toolStatusColWidth = 8;
  const toolClawtalkColWidth = 8;
  const toolOpenclawColWidth = 8;
  const toolHeader = `  ${padCell('Tool', toolNameColWidth)}  ${padCell('Status', toolStatusColWidth)}  ${padCell('ClawTalk', toolClawtalkColWidth)}  ${padCell('OpenClaw', toolOpenclawColWidth)}`;
  const toolDivider = buildDivider([toolNameColWidth, toolStatusColWidth, toolClawtalkColWidth, toolOpenclawColWidth]);
  const catalogNameColWidth = 34;
  const catalogStateColWidth = 12;
  const catalogVersionColWidth = 10;
  const catalogHeader = `  ${padCell('Package', catalogNameColWidth)}  ${padCell('State', catalogStateColWidth)}  ${padCell('Version', catalogVersionColWidth)}`;
  const catalogDivider = buildDivider([catalogNameColWidth, catalogStateColWidth, catalogVersionColWidth]);

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
      ? ['tools', 'skills', 'speech']
      : ['talk', 'tools', 'skills', 'speech'];
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
      const maxIndex = tab === 'speech' ? Math.max(0, speechRowCount - 1)
        : tab === 'tools' ? Math.max(0, executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount + profileRowCount + toolRows.length + catalogRows.length - 1)
        : tab === 'skills' ? Math.max(0, skillsRowCount - 1)
        : tab === 'talk' ? 0
        : 0;
      setSelectedIndex(prev => Math.min(maxIndex, prev + 1));
      return;
    }

    // Select with Enter
    if (key.return) {
      if (tab === 'speech') {
        const { section, localIndex } = resolveSpeechSection(selectedIndex);
        if (section === 'mic' && devices[localIndex]) {
          const device = devices[localIndex];
          if (setInputDevice(device.name)) {
            setDevices(prev => prev.map(d => ({ ...d, isDefault: d.name === device.name })));
            setMessage(`Switched to: ${device.name}`);
            onMicChange?.(device.name);
            setTimeout(() => setMessage(null), 2000);
          } else {
            setMessage('Failed to switch device');
            setTimeout(() => setMessage(null), 2000);
          }
        } else if (section === 'stt' && sttProviders[localIndex]) {
          const provider = sttProviders[localIndex];
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
        } else if (section === 'tts' && ttsProviders[localIndex]) {
          const provider = ttsProviders[localIndex];
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
        } else if (section === 'realtime' && realtimeProviders[localIndex]) {
          const provider = realtimeProviders[localIndex];
          onRealtimeProviderChange?.(provider);
          setMessage(`Realtime provider: ${PROVIDER_LABELS[provider]}`);
          setTimeout(() => setMessage(null), 2000);
        }
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
      } else if (tab === 'skills') {
        if (selectedIndex === 0) {
          // First row: toggle mode (all skills / explicit)
          if (allSkillsMode) {
            // No-op: already in all mode, user needs to toggle individual skills to switch
            setMessage('Toggle individual skills below to switch to explicit mode.');
            setTimeout(() => setMessage(null), 2000);
          } else {
            onResetSkillsToAll?.();
            setMessage('Reset to all skills mode.');
            setTimeout(() => setMessage(null), 2000);
          }
        } else {
          const skillIndex = selectedIndex - 1;
          const skill = eligibleSkills[skillIndex];
          if (skill) {
            onToggleSkill?.(skill.name);
            setMessage(`${skill.enabled && !allSkillsMode ? 'Disabled' : 'Enabled'} ${skill.name}`);
            setTimeout(() => setMessage(null), 2000);
          }
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
      if (tab === 'speech' && idx < speechRowCount) {
        setSelectedIndex(idx);
      } else if (tab === 'tools') {
        const max = executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount + profileRowCount + toolRows.length + catalogRows.length;
        if (idx < max) setSelectedIndex(idx);
      }
    }
  });

  const eligibleSkills = (skillsProp ?? []).filter(s => s.eligible);
  const skillsRowCount = allSkillsMode ? eligibleSkills.length + 1 : eligibleSkills.length + 1; // +1 for reset/mode row

  const tabs: SettingsTab[] = hideTalkConfig
    ? ['tools', 'skills', 'speech']
    : ['talk', 'tools', 'skills', 'speech'];
  const tabLabels: Record<SettingsTab, string> = {
    speech: 'Speech',
    talk: 'Talk Config',
    tools: 'Tools',
    skills: 'OpenClaw Skills',
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
      {tab === 'speech' && (
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
                      {rowIndex === selectedIndex ? '▸ ' : '  '}
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
                      {rowIndex === selectedIndex ? '▸ ' : '  '}
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
                      {rowIndex === selectedIndex ? '▸ ' : '  '}
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
                      {rowIndex === selectedIndex ? '▸ ' : '  '}
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
                );
              })
            )}
          </Box>

          <Box marginTop={1}>
            <Text dimColor>Use ^V to toggle AI Voice | ^C to start Live Chat</Text>
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
                  const active = normalizeExecutionMode(toolPolicy?.executionMode) === mode.value;
                  const modeTitle = typeof mode.title === 'string' ? mode.title : String(mode.value);
                  const modeDescription = typeof mode.description === 'string' ? mode.description : '';
                  return (
                    <Box key={mode.value}>
                      <Text color={idx === selectedIndex ? 'cyan' : undefined}>
                        {idx === selectedIndex ? '▸ ' : '  '}
                      </Text>
                      <Text dimColor>{idx + 1}. </Text>
                      <Text color={active ? 'green' : undefined} bold={active}>
                        {modeTitle}
                      </Text>
                      {modeDescription.length > 0 && <Text dimColor> ({modeDescription})</Text>}
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
                  const hasOAuthConfig = profile.hasClientId && profile.hasClientSecret && profile.hasRefreshToken;
                  const profileReadinessKnown = typeof profile.accessTokenReady === 'boolean';
                  const needsReauth = !isInherit
                    && (
                      profile.accessTokenReady === false
                      || (
                        !profileReadinessKnown
                        && profile.name === (googleAuthStatus?.profile ?? googleAuthStatus?.activeProfile)
                        && googleAuthStatus?.accessTokenReady === false
                      )
                    );
                  const readiness = isInherit
                    ? `active: ${googleAuthActiveProfile ?? '(none)'}`
                    : (!hasOAuthConfig
                        ? 'incomplete'
                        : (needsReauth ? 'reauth required' : 'ready'));
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
                <Text dimColor>{toolHeader}</Text>
                <Text dimColor>{toolDivider}</Text>
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
                    const paddedName = padCell(tool.name, toolNameColWidth);
                    const ctStatus = tool.clawtalkStatus === 'on' ? 'on' : '---';
                    const ctColor: 'green' | 'yellow' = tool.clawtalkStatus === 'on' ? 'green' : 'yellow';
                    const ocStatus = tool.openclawStatus === 'on' ? 'on' : '---';
                    const ocColor: 'green' | 'yellow' = tool.openclawStatus === 'on' ? 'green' : 'yellow';
                    return (
                      <Box key={tool.name}>
                        <Text color={selected ? 'cyan' : undefined}>{selected ? '▸ ' : '  '}</Text>
                        <Text>{paddedName}</Text>
                        <Text>  </Text>
                        <Text color={statusColor}>{padCell(status, toolStatusColWidth)}</Text>
                        <Text>  </Text>
                        <Text color={ctColor}>{padCell(ctStatus, toolClawtalkColWidth)}</Text>
                        <Text>  </Text>
                        <Text color={ocColor}>{padCell(ocStatus, toolOpenclawColWidth)}</Text>
                      </Box>
                    );
                  })
                )}
              </Box>

              <Box marginTop={2} flexDirection="column">
                <Text bold>Tool Catalog</Text>
                <Text dimColor>{catalogHeader}</Text>
                <Text dimColor>{catalogDivider}</Text>
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
                    const paddedName = padCell(entry.name, catalogNameColWidth);
                    return (
                      <Box key={entry.id}>
                        <Text color={selected ? 'cyan' : undefined}>{selected ? '▸ ' : '  '}</Text>
                        <Text>{paddedName}</Text>
                        <Text>  </Text>
                        <Text color={stateColor}>{padCell(state, catalogStateColWidth)}</Text>
                        <Text>  </Text>
                        <Text dimColor>{padCell(entry.version, catalogVersionColWidth)}</Text>
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

      {tab === 'skills' && (
        <Box flexDirection="column">
          {skillsLoading ? (
            <Text dimColor>Loading OpenClaw skills...</Text>
          ) : (
            <>
              <Text dimColor>OpenClaw skills available to managed agents. Toggle to enable/disable per-talk.</Text>
              <Box marginTop={1} flexDirection="column">
                <Box>
                  <Text color={selectedIndex === 0 ? 'cyan' : undefined}>
                    {selectedIndex === 0 ? '▸ ' : '  '}
                  </Text>
                  <Text color={allSkillsMode ? 'green' : 'yellow'} bold>
                    {allSkillsMode ? 'All Skills Mode (active)' : 'Reset to All Skills'}
                  </Text>
                  <Text dimColor>
                    {allSkillsMode
                      ? ' — all eligible skills are loaded'
                      : ' — press Enter to enable all skills'}
                  </Text>
                </Box>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text bold>Eligible Skills</Text>
                {eligibleSkills.length === 0 ? (
                  <Text dimColor>  (no eligible skills found)</Text>
                ) : (
                  eligibleSkills.map((skill, idx) => {
                    const rowIndex = idx + 1;
                    const selected = rowIndex === selectedIndex;
                    const enabled = allSkillsMode || skill.enabled;
                    return (
                      <Box key={skill.name}>
                        <Text color={selected ? 'cyan' : undefined}>
                          {selected ? '▸ ' : '  '}
                        </Text>
                        <Text>{skill.emoji ? `${skill.emoji} ` : ''}</Text>
                        <Text bold={enabled} color={enabled ? 'green' : undefined}>
                          {skill.name}
                        </Text>
                        <Text dimColor> — {skill.description.length > 60 ? skill.description.slice(0, 57) + '...' : skill.description}</Text>
                        <Text color={enabled ? 'green' : 'yellow'}> [{enabled ? 'ON' : 'OFF'}]</Text>
                      </Box>
                    );
                  })
                )}
              </Box>
              {skillsError && (
                <Box marginTop={1}>
                  <Text color="yellow">{skillsError}</Text>
                </Box>
              )}
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
                    <Box key={s.connectionIndex} flexDirection="column">
                      <Text>
                        <Text dimColor>  {s.connectionIndex}. </Text>
                        <Text>mode:</Text>
                        <Text color={s.responseMode === 'off' ? 'yellow' : 'green'}>{s.responseMode}</Text>
                        <Text> agent:{s.agentName ?? '(default)'}</Text>
                      </Text>
                      <Text dimColor>    prompt:</Text>
                      {(s.onMessagePrompt?.trim() ? s.onMessagePrompt.split('\n') : ['(none)']).map((line, idx) => (
                        <Text key={`settings-channel-prompt-${s.connectionIndex}-${idx}`} dimColor>
                          {'      '}
                          {line || ' '}
                        </Text>
                      ))}
                    </Box>
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
                    <Box key={i} flexDirection="column">
                      <Text>
                        <Text dimColor>  {i + 1}. </Text>
                        <Text color={j.active ? undefined : 'yellow'}>[{j.active ? 'active' : 'paused'}] </Text>
                        <Text>"{j.schedule}"</Text>
                      </Text>
                      <Text dimColor>    prompt:</Text>
                      {(j.prompt?.trim() ? j.prompt.split('\n') : ['(none)']).map((line, idx) => (
                        <Text key={`settings-job-prompt-${i}-${idx}`} dimColor>
                          {'      '}
                          {line || ' '}
                        </Text>
                      ))}
                    </Box>
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
          ) : tab === 'skills' ? (
            <Text dimColor>↑/↓ navigate  Enter toggle skill  Esc close</Text>
          ) : (
            <Text dimColor>↑/↓ navigate  Enter/1-9 select  Esc close</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
