/**
 * Settings Picker Component
 *
 * Coordinator for settings tabs: Talk, Tools, Skills, Speech.
 * Owns shared state (tab, selectedIndex, message) and keyboard handling.
 * Tab rendering is delegated to SettingsTalkTab, SettingsToolsTab,
 * SettingsSkillsTab, and SettingsSpeechTab.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { execSync, spawn } from 'child_process';
import type {
  GoogleAuthProfileSummary,
  Job,
  PlatformBinding,
  PlatformBehavior,
  PlatformPermission,
  RealtimeVoiceCapabilities,
  RealtimeVoiceProvider,
  SkillDescriptor,
  TalkAgent,
  ToolCatalogEntry,
  ToolDescriptor,
  ToolExecutionMode,
  ToolExecutionModeOption,
  ToolFilesystemAccess,
  ToolNetworkAccess,
  ToolMode,
} from '../../types.js';
import type { SlackAccountOption, SlackChannelOption, SlackProxySetupStatus } from '../../services/chat.js';
import { SettingsTalkTab } from './SettingsTalkTab.js';
import type { TalkConfigInfo } from './SettingsTalkTab.js';
import { SettingsSpeechTab } from './SettingsSpeechTab.js';
import type { AudioDevice } from './SettingsSpeechTab.js';
import { SettingsSkillsTab } from './SettingsSkillsTab.js';
import { SettingsToolsTab, normalizeExecutionModeOptions } from './SettingsToolsTab.js';
import { ChannelConfigPicker } from './ChannelConfigPicker.js';
import { JobsConfigPicker } from './JobsConfigPicker.js';
import { TalkConfigPicker } from './TalkConfigPicker.js';
import type { TalkConfigEmbedProps } from './TalkConfigPicker.js';
import { AgentsConfigPicker } from './SettingsAgentsTab.js';
import type { AgentsConfigEmbedProps } from './SettingsAgentsTab.js';

interface VoiceCapsInfo {
  sttProviders: string[];
  sttActiveProvider?: string;
  ttsProviders: string[];
  ttsActiveProvider?: string;
}

export interface ChannelConfigEmbedProps {
  maxHeight: number;
  terminalWidth: number;
  bindings: PlatformBinding[];
  behaviors: PlatformBehavior[];
  agents: TalkAgent[];
  slackAccounts: SlackAccountOption[];
  slackChannelsByAccount: Record<string, SlackChannelOption[]>;
  slackHintsLoading: boolean;
  slackHintsError: string | null;
  onRefreshSlackHints: () => void;
  onAddBinding: (platform: string, scope: string, permission: PlatformPermission) => void;
  onUpdateBinding: (
    index: number,
    updates: Partial<Pick<PlatformBinding, 'platform' | 'scope' | 'permission'>>,
  ) => void;
  onRemoveBinding: (index: number) => void;
  onSetResponseMode: (index: number, mode: 'off' | 'mentions' | 'all') => void;
  onSetMirrorToTalk: (index: number, mode: 'off' | 'inbound' | 'full') => void;
  onSetDeliveryMode: (index: number, mode: 'thread' | 'channel' | 'adaptive') => void;
  onSetPrompt: (index: number, prompt: string) => void;
  onSetAgentChoice: (index: number, agentName?: string) => void;
  onClearBehavior: (index: number) => void;
  onCheckSlackProxySetup?: () => Promise<SlackProxySetupStatus | null>;
  onSaveSlackSigningSecret?: (secret: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface JobsConfigEmbedProps {
  maxHeight: number;
  terminalWidth: number;
  jobs: Job[];
  platformBindings: PlatformBinding[];
  gatewayConnected: boolean;
  onRefreshJobs: () => Promise<Job[]>;
  onAddJob: (schedule: string, prompt: string) => Promise<boolean>;
  onSetJobActive: (index: number, active: boolean) => Promise<boolean>;
  onSetJobSchedule: (index: number, schedule: string) => Promise<boolean>;
  onSetJobPrompt: (index: number, prompt: string) => Promise<boolean>;
  onDeleteJob: (index: number) => Promise<boolean>;
  onViewReports: (index: number) => void;
}

interface SettingsPickerProps {
  onClose: () => void;
  onMicChange?: (device: string) => void;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenTalks: () => void;
  onExit: () => void;
  setError: (error: string) => void;
  voiceCaps?: VoiceCapsInfo;
  onSttProviderChange?: (provider: string) => Promise<boolean>;
  onTtsProviderChange?: (provider: string) => Promise<boolean>;
  realtimeVoiceCaps?: RealtimeVoiceCapabilities | null;
  realtimeProvider?: RealtimeVoiceProvider | null;
  onRealtimeProviderChange?: (provider: RealtimeVoiceProvider) => void;
  talkConfig?: TalkConfigInfo | null;
  hideTalkConfig?: boolean;
  initialTab?: SettingsTab;
  channelConfig?: ChannelConfigEmbedProps;
  jobsConfig?: JobsConfigEmbedProps;
  talkConfigEmbed?: TalkConfigEmbedProps;
  agentsConfig?: AgentsConfigEmbedProps;
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
  onStartGoogleOAuthConnect?: (onOverlayMessage?: (msg: string) => void) => void;
  onSetTalkGoogleAuthProfile?: (profile: string | undefined) => void;
  onInstallCatalogTool?: (catalogId: string) => void;
  onUninstallCatalogTool?: (catalogId: string) => void;
  skills?: SkillDescriptor[];
  skillsLoading?: boolean;
  skillsError?: string | null;
  allSkillsMode?: boolean;
  onToggleSkill?: (skillName: string) => void;
  onResetSkillsToAll?: () => void;
  onRefreshSkills?: () => void;
}

type SettingsTab = 'speech' | 'talk' | 'agents' | 'channels' | 'jobs' | 'tools' | 'skills';

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

const PROVIDER_LABELS: Record<RealtimeVoiceProvider, string> = {
  openai: 'OpenAI Realtime',
  elevenlabs: 'ElevenLabs Conversational AI',
  deepgram: 'Deepgram + LLM + TTS',
  gemini: 'Google Gemini Live',
  cartesia: 'Cartesia',
};

function getInputDevices(): AudioDevice[] {
  try {
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

function tryOpenUrl(url: string): boolean {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function normalizeExecutionMode(raw: unknown): ToolExecutionMode {
  return raw === 'full_control' ? 'full_control' : 'openclaw';
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
  channelConfig,
  jobsConfig,
  talkConfigEmbed,
  agentsConfig,
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
  onRefreshSkills,
}: SettingsPickerProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? (hideTalkConfig ? 'speech' : 'talk'));
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [activeSttProvider, setActiveSttProvider] = useState<string | undefined>(voiceCaps?.sttActiveProvider);
  const [activeTtsProvider, setActiveTtsProvider] = useState<string | undefined>(voiceCaps?.ttsActiveProvider);
  const [skillsScrollX, setSkillsScrollX] = useState(0);
  const { stdout } = useStdout();

  // Voice provider lists
  const sttProviders = voiceCaps?.sttProviders ?? [];
  const ttsProviders = voiceCaps?.ttsProviders ?? [];
  const realtimeProviders = realtimeVoiceCaps?.providers ?? [];

  // Speech tab section offsets
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

  // Tools tab row counts (used for cursor bounds and Enter routing)
  const toolRows = toolPolicy?.effectiveTools ?? toolPolicy?.availableTools ?? [];
  const catalogRows = toolPolicy?.catalogEntries ?? [];
  const authProfiles = googleAuthProfiles ?? [];
  const profileRowCount = 1 + authProfiles.length;
  const executionModeOptions = normalizeExecutionModeOptions(toolPolicy?.executionModeOptions);
  const filesystemOptions: ToolFilesystemAccess[] = toolPolicy?.filesystemAccessOptions?.length
    ? toolPolicy.filesystemAccessOptions
    : ['workspace_sandbox', 'full_host_access'];
  const networkOptions: ToolNetworkAccess[] = toolPolicy?.networkAccessOptions?.length
    ? toolPolicy.networkAccessOptions
    : ['restricted', 'full_outbound'];
  const toolModes: ToolMode[] = ['off', 'confirm', 'auto'];
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

  // Skills tab
  const eligibleSkills = (skillsProp ?? []).filter(s => s.eligible);
  const skillsRowCount = eligibleSkills.length + 1; // +1 for reset/mode row

  useEffect(() => {
    const devs = getInputDevices();
    setDevices(devs);
    const defaultIdx = devs.findIndex(d => d.isDefault);
    if (defaultIdx >= 0) setSelectedIndex(defaultIdx);
  }, []);

  useEffect(() => {
    if (tab === 'tools') onRefreshToolPolicy?.();
  }, [tab, onRefreshToolPolicy]);

  useEffect(() => {
    if (tab === 'skills') onRefreshSkills?.();
  }, [tab, onRefreshSkills]);

  useEffect(() => {
    if (tab === 'channels') channelConfig?.onRefreshSlackHints();
  }, [tab]);

  // Compute tab list once for reuse
  const tabs: SettingsTab[] = (() => {
    const base: SettingsTab[] = hideTalkConfig ? [] : ['talk'];
    if (agentsConfig) base.push('agents');
    if (channelConfig) base.push('channels');
    if (jobsConfig) base.push('jobs');
    base.push('tools', 'skills', 'speech');
    return base;
  })();

  const tabLabels: Record<SettingsTab, string> = {
    speech: 'Speech',
    talk: 'Talk Config',
    agents: 'Agents',
    channels: 'Channels',
    jobs: 'Jobs',
    tools: 'Tools',
    skills: 'OpenClaw Skills',
  };

  const switchTab = (dir: -1 | 1) => {
    setTab(prev => {
      const idx = tabs.indexOf(prev);
      return tabs[(idx + dir + tabs.length) % tabs.length];
    });
    setSelectedIndex(0);
    setSkillsScrollX(0);
  };

  useInput((input, key) => {
    // Global shortcuts (available from every tab)
    if (input === 't' && key.ctrl) { onOpenTalks(); return; }
    if (input === 'n' && key.ctrl) { onNewChat(); return; }
    if (input === 'v' && key.ctrl) { onToggleTts(); return; }
    if (input === 'x' && key.ctrl) { onExit(); return; }

    // When channels/jobs/talk-config-embed tab is active, delegate all input to
    // the embedded picker except for global ctrl shortcuts handled above.
    if (tab === 'channels' || tab === 'jobs' || tab === 'agents' || (tab === 'talk' && talkConfigEmbed)) return;

    if (input === 's' && key.ctrl) { onClose(); return; }
    if ((input === 'c' || input === 'p') && key.ctrl) {
      setError('You can only use voice input in a Talk!');
      return;
    }
    if (key.escape) { onClose(); return; }

    // Tab-specific shortcuts
    if (tab === 'tools' && input.toLowerCase() === 'r') {
      onRefreshToolPolicy?.();
      setMessage('Refreshing tools...');
      setTimeout(() => setMessage(null), 1200);
      return;
    }
    if (tab === 'tools' && input.toLowerCase() === 'c') {
      setMessage('Starting Google OAuth...');
      onStartGoogleOAuthConnect?.((msg) => {
        const urlMatch = msg.match(/https?:\/\/\S+/);
        if (urlMatch && tryOpenUrl(urlMatch[0])) {
          setMessage('Opened Google OAuth in browser. Complete authorization there.');
        } else {
          setMessage(msg);
        }
      });
      return;
    }
    if (tab === 'skills' && input === '>') {
      setSkillsScrollX(prev => Math.min(prev + 8, 2 + 24 + 2 + 6));
      return;
    }
    if (tab === 'skills' && input === '<') {
      setSkillsScrollX(prev => Math.max(0, prev - 8));
      return;
    }

    // Tab navigation
    if (key.leftArrow) { switchTab(-1); return; }
    if (key.rightArrow) { switchTab(1); return; }

    // Item navigation
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      const maxIndex = tab === 'speech' ? Math.max(0, speechRowCount - 1)
        : tab === 'tools' ? Math.max(0, executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount + profileRowCount + toolRows.length + catalogRows.length - 1)
        : tab === 'skills' ? Math.max(0, skillsRowCount - 1)
        : 0;
      setSelectedIndex(prev => Math.min(maxIndex, prev + 1));
      return;
    }

    // Enter handler
    if (key.return) {
      if (tab === 'speech') {
        const { section, localIndex } = resolveSpeechSection(selectedIndex);
        if (section === 'mic' && devices[localIndex]) {
          const device = devices[localIndex];
          if (setInputDevice(device.name)) {
            setDevices(prev => prev.map(d => ({ ...d, isDefault: d.name === device.name })));
            setMessage(`Switched to: ${device.name}`);
            onMicChange?.(device.name);
          } else {
            setMessage('Failed to switch device');
          }
          setTimeout(() => setMessage(null), 2000);
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
            setMessage(`Filesystem access: ${mode === 'workspace_sandbox' ? 'Workspace Sandbox' : 'Full Host Access'}`);
            setTimeout(() => setMessage(null), 2000);
          }
          return;
        }
        if (selectedIndex < executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount) {
          const mode = networkOptions[selectedIndex - executionRowCount - toolApprovalRowCount - filesystemRowCount];
          if (mode) {
            onSetNetworkAccess?.(mode);
            setMessage(`Network access: ${mode === 'restricted' ? 'Restricted' : 'Full Outbound'}`);
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
          if (allSkillsMode) {
            setMessage('Toggle individual skills below to switch to explicit mode.');
          } else {
            onResetSkillsToAll?.();
            setMessage('Reset to all skills mode.');
          }
          setTimeout(() => setMessage(null), 2000);
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

    // Space toggle for tools
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
        <SettingsSpeechTab
          devices={devices}
          sttProviders={sttProviders}
          ttsProviders={ttsProviders}
          realtimeProviders={realtimeProviders}
          activeSttProvider={activeSttProvider}
          activeTtsProvider={activeTtsProvider}
          realtimeProvider={realtimeProvider}
          selectedIndex={selectedIndex}
          speechMicEnd={speechMicEnd}
          speechSttEnd={speechSttEnd}
          speechTtsEnd={speechTtsEnd}
        />
      )}

      {tab === 'tools' && (
        <SettingsToolsTab
          toolPolicy={toolPolicy}
          toolPolicyLoading={toolPolicyLoading}
          toolPolicyError={toolPolicyError}
          selectedIndex={selectedIndex}
          talkGoogleAuthProfile={talkGoogleAuthProfile}
          googleAuthActiveProfile={googleAuthActiveProfile}
          googleAuthProfiles={googleAuthProfiles}
          googleAuthStatus={googleAuthStatus}
        />
      )}

      {tab === 'skills' && (
        <SettingsSkillsTab
          skills={skillsProp ?? []}
          skillsLoading={skillsLoading}
          skillsError={skillsError}
          allSkillsMode={allSkillsMode}
          selectedIndex={selectedIndex}
          skillsScrollX={skillsScrollX}
          terminalColumns={stdout?.columns ?? 120}
        />
      )}

      {tab === 'talk' && talkConfigEmbed && (
        <TalkConfigPicker
          {...talkConfigEmbed}
          onClose={onClose}
          onTabLeft={() => switchTab(-1)}
          onTabRight={() => switchTab(1)}
          embedded
        />
      )}

      {tab === 'talk' && !talkConfigEmbed && (
        <SettingsTalkTab talkConfig={talkConfig} />
      )}

      {tab === 'agents' && agentsConfig && (
        <AgentsConfigPicker
          {...agentsConfig}
          onClose={onClose}
          onTabLeft={() => switchTab(-1)}
          onTabRight={() => switchTab(1)}
          embedded
        />
      )}

      {tab === 'channels' && channelConfig && (
        <ChannelConfigPicker
          {...channelConfig}
          onClose={onClose}
          onTabLeft={() => switchTab(-1)}
          onTabRight={() => switchTab(1)}
          embedded
        />
      )}

      {tab === 'jobs' && jobsConfig && (
        <JobsConfigPicker
          {...jobsConfig}
          onClose={onClose}
          onTabLeft={() => switchTab(-1)}
          onTabRight={() => switchTab(1)}
          embedded
        />
      )}

      {/* Status message (not shown for tabs with embedded pickers — they have their own) */}
      {message && tab !== 'channels' && tab !== 'jobs' && tab !== 'agents' && !(tab === 'talk' && talkConfigEmbed) && (
        <Box marginTop={1}>
          <Text color="green">{message}</Text>
        </Box>
      )}

      {/* Help */}
      {tab !== 'talk' && tab !== 'agents' && tab !== 'channels' && tab !== 'jobs' && (
        <Box marginTop={1}>
          {tab === 'tools' ? (
            <Text dimColor>↑/↓ navigate  Enter select/install  Space toggle tool  r refresh  Esc close</Text>
          ) : tab === 'skills' ? (
            <Text dimColor>↑/↓ navigate  Enter toggle skill  &lt;/&gt; scroll  Esc close</Text>
          ) : (
            <Text dimColor>↑/↓ navigate  Enter/1-9 select  Esc close</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
