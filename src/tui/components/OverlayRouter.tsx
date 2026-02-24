/**
 * Overlay Router Component
 *
 * Conditionally renders exactly one overlay (ModelPicker, RolePicker, EditMessages,
 * TalksHub, ChannelConfigPicker, JobsConfigPicker, SettingsPicker) or the ChatView.
 * Extracted from the middle-area if/else chain in app.tsx.
 */

import React from 'react';
import { Box } from 'ink';

import type { Message } from '../../types.js';
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
import type { RoleTemplate } from '../../agent-roles.js';
import type { TalkManager } from '../../services/talks.js';
import type { SessionManager } from '../../services/sessions.js';
import type { Model } from './ModelPicker.js';

import { ModelPicker } from './ModelPicker.js';
import { RolePicker } from './RolePicker.js';
import { EditMessages } from './EditMessages.js';
import { TalksHub } from './TalksHub.js';
import { SettingsPicker } from './SettingsPicker.js';
import type { ChannelConfigEmbedProps, JobsConfigEmbedProps } from './SettingsPicker.js';
import { ChatView } from './ChatView.js';

// ── Sub-prop interfaces ──────────────────────────────────────────────

interface ModelPickerOverlayProps {
  models: Model[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
  maxHeight: number;
  onAddAgent: ((modelId: string) => void) | undefined;
  title: string | undefined;
  modelValidity: Record<string, 'valid' | 'invalid' | 'unknown'> | undefined;
  isRefreshing: boolean;
  lastRefreshedAt: number | null | undefined;
}

interface RolePickerOverlayProps {
  roles: RoleTemplate[];
  onSelect: (role: RoleTemplate) => void;
  onClose: () => void;
  modelName: string;
  maxHeight: number;
}

interface EditMessagesOverlayProps {
  messages: Message[];
  maxHeight: number;
  terminalWidth: number;
  onClose: () => void;
  onConfirm: (messageIds: string[]) => void;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenTalks: () => void;
  onOpenSettings: () => void;
  onExit: () => void;
  setError: (error: string) => void;
}

interface TalksHubOverlayProps {
  talkManager: TalkManager;
  sessionManager: SessionManager;
  maxHeight: number;
  terminalWidth: number;
  onClose: () => void;
  onSelectTalk: (talk: import('../../types.js').Talk) => void;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenSettings: () => void;
  onOpenModelPicker: () => void;
  exportDir: string | undefined;
  onNewTerminal: () => void;
  onExit: () => void;
  setError: (error: string) => void;
  onRenameTalk: ((talkId: string, title: string) => void) | undefined;
  onDeleteTalk: ((talkId: string) => void) | undefined;
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
}

interface SettingsOverlayProps {
  onClose: () => void;
  initialTab: 'speech' | 'talk' | 'channels' | 'jobs' | 'tools' | 'skills';
  hideTalkConfig: boolean;
  channelConfig?: ChannelConfigEmbedProps;
  jobsConfig?: JobsConfigEmbedProps;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenTalks: () => void;
  onExit: () => void;
  setError: (error: string) => void;
  voiceCaps: VoiceCapsInfo;
  onSttProviderChange: (provider: string) => Promise<boolean>;
  onTtsProviderChange: (provider: string) => Promise<boolean>;
  realtimeVoiceCaps: RealtimeVoiceCapabilities | null | undefined;
  realtimeProvider: RealtimeVoiceProvider | null | undefined;
  onRealtimeProviderChange: (provider: RealtimeVoiceProvider) => void;
  toolPolicy: {
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
  } | null | undefined;
  toolPolicyLoading: boolean;
  toolPolicyError: string | null | undefined;
  onRefreshToolPolicy: () => void;
  onSetToolMode: (mode: ToolMode) => void;
  onSetExecutionMode: (mode: ToolExecutionMode) => void;
  onSetFilesystemAccess: (mode: ToolFilesystemAccess) => void;
  onSetNetworkAccess: (mode: ToolNetworkAccess) => void;
  onSetToolEnabled: (toolName: string, enabled: boolean) => void;
  talkGoogleAuthProfile: string | undefined;
  googleAuthActiveProfile: string | undefined;
  googleAuthProfiles: GoogleAuthProfileSummary[];
  googleAuthStatus: {
    profile?: string;
    activeProfile?: string;
    accessTokenReady: boolean;
    accountEmail?: string;
    accountDisplayName?: string;
    identityError?: string;
    error?: string;
  } | undefined;
  onStartGoogleOAuthConnect: ((onOverlayMessage?: (msg: string) => void) => void) | undefined;
  onSetTalkGoogleAuthProfile: ((profile: string | undefined) => void) | undefined;
  onInstallCatalogTool: ((catalogId: string) => void) | undefined;
  onUninstallCatalogTool: ((catalogId: string) => void) | undefined;
  skills: SkillDescriptor[] | undefined;
  skillsLoading: boolean;
  skillsError: string | null | undefined;
  allSkillsMode: boolean | undefined;
  onToggleSkill: ((skillName: string) => void) | undefined;
  onResetSkillsToAll: (() => void) | undefined;
  onRefreshSkills: (() => void) | undefined;
  talkConfig: TalkConfigInfo | null;
}

interface ChatViewOverlayProps {
  messages: Message[];
  messageLinesArray: number[];
  streamingContent: string;
  isProcessing: boolean;
  processingStartTime: number | null;
  scrollOffset: number;
  availableHeight: number;
  width: number;
  currentModel: string;
  pinnedMessageIds: string[];
  streamingAgentName: string | undefined;
  remoteProcessing: boolean | undefined;
}

// ── Main Props ───────────────────────────────────────────────────────

export interface OverlayRouterProps {
  /** Overlay visibility flags — exactly one should be true, or all false for ChatView */
  showModelPicker: boolean;
  showRolePicker: boolean;
  showEditMessages: boolean;
  showTalks: boolean;
  showSettings: boolean;

  /** Per-overlay props */
  modelPicker: ModelPickerOverlayProps;
  rolePicker: RolePickerOverlayProps;
  editMessages: EditMessagesOverlayProps;
  talksHub: TalksHubOverlayProps;
  settings: SettingsOverlayProps;
  chatView: ChatViewOverlayProps;
}

// ── Component ────────────────────────────────────────────────────────

export function OverlayRouter({
  showModelPicker,
  showRolePicker,
  showEditMessages,
  showTalks,
  showSettings,
  modelPicker: mp,
  rolePicker: rp,
  editMessages: em,
  talksHub: th,
  settings: sp,
  chatView: cv,
}: OverlayRouterProps) {
  if (showModelPicker) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <ModelPicker
          models={mp.models}
          currentModel={mp.currentModel}
          onSelect={mp.onSelect}
          onClose={mp.onClose}
          maxHeight={mp.maxHeight}
          onAddAgent={mp.onAddAgent}
          title={mp.title}
          modelValidity={mp.modelValidity}
          isRefreshing={mp.isRefreshing}
          lastRefreshedAt={mp.lastRefreshedAt}
        />
      </Box>
    );
  }

  if (showRolePicker) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <RolePicker
          roles={rp.roles}
          onSelect={rp.onSelect}
          onClose={rp.onClose}
          modelName={rp.modelName}
          maxHeight={rp.maxHeight}
        />
      </Box>
    );
  }

  if (showEditMessages) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <EditMessages
          messages={em.messages}
          maxHeight={em.maxHeight}
          terminalWidth={em.terminalWidth}
          onClose={em.onClose}
          onConfirm={em.onConfirm}
          onNewChat={em.onNewChat}
          onToggleTts={em.onToggleTts}
          onOpenTalks={em.onOpenTalks}
          onOpenSettings={em.onOpenSettings}
          onExit={em.onExit}
          setError={em.setError}
        />
      </Box>
    );
  }

  if (showTalks) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <TalksHub
          talkManager={th.talkManager}
          sessionManager={th.sessionManager}
          maxHeight={th.maxHeight}
          terminalWidth={th.terminalWidth}
          onClose={th.onClose}
          onSelectTalk={th.onSelectTalk}
          onNewChat={th.onNewChat}
          onToggleTts={th.onToggleTts}
          onOpenSettings={th.onOpenSettings}
          onOpenModelPicker={th.onOpenModelPicker}
          exportDir={th.exportDir}
          onNewTerminal={th.onNewTerminal}
          onExit={th.onExit}
          setError={th.setError}
          onRenameTalk={th.onRenameTalk}
          onDeleteTalk={th.onDeleteTalk}
        />
      </Box>
    );
  }

  if (showSettings) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <SettingsPicker
          onClose={sp.onClose}
          initialTab={sp.initialTab}
          hideTalkConfig={sp.hideTalkConfig}
          channelConfig={sp.channelConfig}
          jobsConfig={sp.jobsConfig}
          onNewChat={sp.onNewChat}
          onToggleTts={sp.onToggleTts}
          onOpenTalks={sp.onOpenTalks}
          onExit={sp.onExit}
          setError={sp.setError}
          voiceCaps={sp.voiceCaps}
          onSttProviderChange={sp.onSttProviderChange}
          onTtsProviderChange={sp.onTtsProviderChange}
          realtimeVoiceCaps={sp.realtimeVoiceCaps}
          realtimeProvider={sp.realtimeProvider}
          onRealtimeProviderChange={sp.onRealtimeProviderChange}
          toolPolicy={sp.toolPolicy}
          toolPolicyLoading={sp.toolPolicyLoading}
          toolPolicyError={sp.toolPolicyError}
          onRefreshToolPolicy={sp.onRefreshToolPolicy}
          onSetToolMode={sp.onSetToolMode}
          onSetExecutionMode={sp.onSetExecutionMode}
          onSetFilesystemAccess={sp.onSetFilesystemAccess}
          onSetNetworkAccess={sp.onSetNetworkAccess}
          onSetToolEnabled={sp.onSetToolEnabled}
          talkGoogleAuthProfile={sp.talkGoogleAuthProfile}
          googleAuthActiveProfile={sp.googleAuthActiveProfile}
          googleAuthProfiles={sp.googleAuthProfiles}
          googleAuthStatus={sp.googleAuthStatus}
          onStartGoogleOAuthConnect={sp.onStartGoogleOAuthConnect}
          onSetTalkGoogleAuthProfile={sp.onSetTalkGoogleAuthProfile}
          onInstallCatalogTool={sp.onInstallCatalogTool}
          onUninstallCatalogTool={sp.onUninstallCatalogTool}
          skills={sp.skills}
          skillsLoading={sp.skillsLoading}
          skillsError={sp.skillsError}
          allSkillsMode={sp.allSkillsMode}
          onToggleSkill={sp.onToggleSkill}
          onResetSkillsToAll={sp.onResetSkillsToAll}
          onRefreshSkills={sp.onRefreshSkills}
          talkConfig={sp.talkConfig}
        />
      </Box>
    );
  }

  // No overlay active — render chat view
  return (
    <ChatView
      messages={cv.messages}
      messageLinesArray={cv.messageLinesArray}
      streamingContent={cv.streamingContent}
      isProcessing={cv.isProcessing}
      processingStartTime={cv.processingStartTime}
      scrollOffset={cv.scrollOffset}
      availableHeight={cv.availableHeight}
      width={cv.width}
      currentModel={cv.currentModel}
      pinnedMessageIds={cv.pinnedMessageIds}
      streamingAgentName={cv.streamingAgentName}
      remoteProcessing={cv.remoteProcessing}
    />
  );
}
