/**
 * Tool policy hook.
 *
 * Manages tool policy settings, Google auth profiles, catalog install/uninstall,
 * skills settings, and all related handlers extracted from app.tsx.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  Message,
  ToolMode,
  ToolExecutionMode,
  ToolExecutionModeOption,
  ToolFilesystemAccess,
  ToolNetworkAccess,
  ToolDescriptor,
  ToolCatalogEntry,
  GoogleAuthProfileSummary,
  SkillDescriptor,
  TalkToolPolicy,
} from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { TalkManager } from '../../services/talks.js';
import { createMessage } from '../helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXECUTION_MODE: ToolExecutionMode = 'openclaw';
const DEFAULT_EXECUTION_MODE_OPTIONS: ToolExecutionModeOption[] = [
  {
    value: 'openclaw',
    label: 'openclaw_agent',
    title: 'OpenClaw Agent',
    description: 'OpenClaw agent runtime, tools, and session behavior.',
  },
  {
    value: 'full_control',
    label: 'clawtalk_proxy',
    title: 'ClawTalk Proxy',
    description: 'Sends prompts directly with minimal OpenClaw runtime mediation.',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeGoogleAuthProfiles(
  profiles: GoogleAuthProfileSummary[] | undefined,
  authStatus: {
    profile?: string;
    hasClientId: boolean;
    hasClientSecret: boolean;
    hasRefreshToken: boolean;
    accessTokenReady: boolean;
    error?: string;
    accountEmail?: string;
    accountDisplayName?: string;
  } | null | undefined,
): GoogleAuthProfileSummary[] {
  const base = profiles ?? [];
  if (!authStatus?.profile) return base;
  let patched = false;
  const next = base.map((entry) => {
    if (entry.name !== authStatus.profile) return entry;
    patched = true;
    return {
      ...entry,
      hasClientId: authStatus.hasClientId,
      hasClientSecret: authStatus.hasClientSecret,
      hasRefreshToken: authStatus.hasRefreshToken,
      accessTokenReady: authStatus.accessTokenReady,
      error: authStatus.error,
      accountEmail: authStatus.accountEmail ?? entry.accountEmail,
      accountDisplayName: authStatus.accountDisplayName ?? entry.accountDisplayName,
    };
  });
  if (patched) return next;
  return [
    ...next,
    {
      name: authStatus.profile,
      hasClientId: authStatus.hasClientId,
      hasClientSecret: authStatus.hasClientSecret,
      hasRefreshToken: authStatus.hasRefreshToken,
      accessTokenReady: authStatus.accessTokenReady,
      error: authStatus.error,
      accountEmail: authStatus.accountEmail,
      accountDisplayName: authStatus.accountDisplayName,
    },
  ];
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface ToolPolicyState {
  mode: ToolMode;
  executionMode: ToolExecutionMode;
  executionModeOptions: ToolExecutionModeOption[];
  filesystemAccess: ToolFilesystemAccess;
  networkAccess: ToolNetworkAccess;
  effectiveTools: ToolDescriptor[];
  availableTools: ToolDescriptor[];
  enabledToolNames: string[];
  catalogEntries: ToolCatalogEntry[];
  installedToolNames: string[];
  talkGoogleAuthProfile?: string;
  googleAuthActiveProfile?: string;
  googleAuthProfiles: GoogleAuthProfileSummary[];
  googleAuthStatus?: {
    profile?: string;
    activeProfile?: string;
    accessTokenReady: boolean;
    error?: string;
  };
}

// ---------------------------------------------------------------------------
// Deps / Result interfaces
// ---------------------------------------------------------------------------

export interface UseToolPolicyDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  activeTalkIdRef: React.MutableRefObject<string | null>;
  gatewayTalkIdRef: React.MutableRefObject<string | null>;
  setError: (msg: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export interface UseToolPolicyResult {
  // State
  settingsToolPolicy: ToolPolicyState | null;
  setSettingsToolPolicy: React.Dispatch<React.SetStateAction<ToolPolicyState | null>>;
  settingsToolPolicyLoading: boolean;
  settingsToolPolicyError: string | null;
  setSettingsToolPolicyError: React.Dispatch<React.SetStateAction<string | null>>;
  settingsSkills: SkillDescriptor[] | null;
  settingsSkillsLoading: boolean;
  settingsSkillsError: string | null;
  settingsAllSkillsMode: boolean;

  // Command handlers (used by /tools commands)
  syncToolPolicyLocal: (
    mode?: ToolMode,
    executionMode?: ToolExecutionMode,
    filesystemAccess?: ToolFilesystemAccess,
    networkAccess?: ToolNetworkAccess,
    allow?: string[],
    deny?: string[],
    googleAuthProfile?: string,
  ) => void;
  handleListTools: () => void;
  handleSetToolsMode: (mode: ToolMode) => void;
  handleAddAllowedTool: (toolName: string) => void;
  handleRemoveAllowedTool: (toolName: string) => void;
  handleClearAllowedTools: () => void;
  handleAddDeniedTool: (toolName: string) => void;
  handleRemoveDeniedTool: (toolName: string) => void;
  handleClearDeniedTools: () => void;
  handleShowGoogleDocsAuthStatus: () => void;
  handleSetGoogleDocsRefreshToken: (token: string) => void;

  // Settings panel handlers
  refreshSettingsToolPolicy: () => void;
  refreshSettingsSkills: () => void;
  handleSettingsToggleSkill: (skillName: string) => void;
  handleSettingsResetSkillsToAll: () => void;
  handleSettingsSetToolMode: (mode: ToolMode) => void;
  handleSettingsSetExecutionMode: (executionMode: ToolExecutionMode) => void;
  handleSettingsSetFilesystemAccess: (filesystemAccess: ToolFilesystemAccess) => void;
  handleSettingsSetNetworkAccess: (networkAccess: ToolNetworkAccess) => void;
  handleSettingsSetToolEnabled: (toolName: string, enabled: boolean) => void;
  handleSettingsSetTalkGoogleAuthProfile: (profile: string | undefined) => void;
  handleSettingsStartGoogleOAuthConnect: (onOverlayMessage?: (msg: string) => void) => void;
  handleSettingsCatalogInstall: (catalogId: string) => void;
  handleSettingsCatalogUninstall: (catalogId: string) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useToolPolicy(deps: UseToolPolicyDeps): UseToolPolicyResult {
  const {
    chatServiceRef, talkManagerRef, activeTalkIdRef, gatewayTalkIdRef,
    setError, setMessages,
  } = deps;

  // ---- State ----

  const [settingsToolPolicy, setSettingsToolPolicy] = useState<ToolPolicyState | null>(null);
  const [settingsToolPolicyLoading, setSettingsToolPolicyLoading] = useState(false);
  const [settingsToolPolicyError, setSettingsToolPolicyError] = useState<string | null>(null);
  const [settingsSkills, setSettingsSkills] = useState<SkillDescriptor[] | null>(null);
  const [settingsSkillsLoading, setSettingsSkillsLoading] = useState(false);
  const [settingsSkillsError, setSettingsSkillsError] = useState<string | null>(null);
  const [settingsAllSkillsMode, setSettingsAllSkillsMode] = useState(true);

  // ---- Refs ----

  const googleOAuthPollRef = useRef<NodeJS.Timeout | null>(null);
  const googleOAuthSessionRef = useRef<string | null>(null);

  // Cleanup OAuth poll on unmount
  useEffect(() => {
    return () => {
      if (googleOAuthPollRef.current) {
        clearInterval(googleOAuthPollRef.current);
        googleOAuthPollRef.current = null;
      }
    };
  }, []);

  // ---- Local helper: build tool policy state from gateway response ----

  function buildToolPolicyState(
    policy: TalkToolPolicy,
    prev: ToolPolicyState | null,
    overrides?: { talkGoogleAuthProfile?: string },
  ): ToolPolicyState {
    return {
      mode: policy.toolMode,
      executionMode: policy.executionMode ?? prev?.executionMode ?? DEFAULT_EXECUTION_MODE,
      executionModeOptions: policy.executionModeOptions ?? prev?.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
      filesystemAccess: policy.filesystemAccess ?? prev?.filesystemAccess ?? 'full_host_access',
      networkAccess: policy.networkAccess ?? prev?.networkAccess ?? 'full_outbound',
      effectiveTools: policy.effectiveTools ?? policy.availableTools,
      availableTools: policy.availableTools,
      enabledToolNames: policy.enabledTools.map((tool) => tool.name),
      catalogEntries: prev?.catalogEntries ?? [],
      installedToolNames: prev?.installedToolNames ?? [],
      talkGoogleAuthProfile: overrides?.talkGoogleAuthProfile !== undefined
        ? overrides.talkGoogleAuthProfile
        : policy.googleAuthProfile,
      googleAuthActiveProfile: prev?.googleAuthActiveProfile,
      googleAuthProfiles: prev?.googleAuthProfiles ?? [],
      googleAuthStatus: prev?.googleAuthStatus,
    };
  }

  // ---- Command handlers ----

  const syncToolPolicyLocal = useCallback((
    mode?: ToolMode,
    executionMode?: ToolExecutionMode,
    filesystemAccess?: ToolFilesystemAccess,
    networkAccess?: ToolNetworkAccess,
    allow?: string[],
    deny?: string[],
    googleAuthProfile?: string,
  ) => {
    if (!activeTalkIdRef.current || !talkManagerRef.current) return;
    const talk = talkManagerRef.current.getTalk(activeTalkIdRef.current);
    if (!talk) return;
    talk.toolMode = mode ?? talk.toolMode;
    talk.executionMode = executionMode ?? talk.executionMode;
    talk.filesystemAccess = filesystemAccess ?? talk.filesystemAccess;
    talk.networkAccess = networkAccess ?? talk.networkAccess;
    talk.toolsAllow = allow ?? talk.toolsAllow;
    talk.toolsDeny = deny ?? talk.toolsDeny;
    if (googleAuthProfile !== undefined) {
      talk.googleAuthProfile = googleAuthProfile || undefined;
    }
    talk.updatedAt = Date.now();
    talkManagerRef.current.saveTalk(activeTalkIdRef.current);
  }, [activeTalkIdRef, talkManagerRef]);

  const handleListTools = useCallback(() => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      const sysMsg = createMessage('system', 'No active gateway talk. Open a saved talk first.');
      setMessages(prev => [...prev, sysMsg]);
      return;
    }
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) {
        const sysMsg = createMessage('system', 'Failed to load tool policy from gateway.');
        setMessages(prev => [...prev, sysMsg]);
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      const availableNames = policy.availableTools.map((t) => t.name).join(', ') || '(none)';
      const enabledNames = policy.enabledTools.map((t) => t.name).join(', ') || '(none)';
      const allow = policy.toolsAllow.join(', ') || '(all)';
      const deny = policy.toolsDeny.join(', ') || '(none)';
      const sysMsg = createMessage(
        'system',
        `Tool policy:\n` +
        `  mode: ${policy.toolMode}\n` +
        `  executionMode: ${policy.executionMode ?? DEFAULT_EXECUTION_MODE}\n` +
        `  filesystemAccess: ${policy.filesystemAccess ?? 'full_host_access'}\n` +
        `  networkAccess: ${policy.networkAccess ?? 'full_outbound'}\n` +
        `  allow: ${allow}\n` +
        `  deny: ${deny}\n` +
        `  googleAuthProfile: ${policy.googleAuthProfile ?? '(inherit active profile)'}\n` +
        `  available: ${availableNames}\n` +
        `  enabled: ${enabledNames}`,
      );
      setMessages(prev => [...prev, sysMsg]);
    });
  }, [chatServiceRef, gatewayTalkIdRef, setMessages, syncToolPolicyLocal]);

  const handleSetToolsMode = useCallback((mode: ToolMode) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.updateGatewayTalkTools(gwId, { toolMode: mode }).then((policy) => {
      if (!policy) {
        setError('Failed to update tool mode on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      const sysMsg = createMessage('system', `Tool mode set to ${policy.toolMode}.`);
      setMessages(prev => [...prev, sysMsg]);
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, setMessages, syncToolPolicyLocal]);

  const handleAddAllowedTool = useCallback((toolName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) return;
      const next = Array.from(new Set([...(policy.toolsAllow ?? []), toolName]));
      chatServiceRef.current?.updateGatewayTalkTools(gwId, { toolsAllow: next }).then((updated) => {
        if (!updated) { setError('Failed to update tool allow-list'); return; }
        syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
        setMessages(prev => [...prev, createMessage('system', `Allowed tool added: ${toolName}`)]);
      });
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, setMessages, syncToolPolicyLocal]);

  const handleRemoveAllowedTool = useCallback((toolName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) return;
      const next = (policy.toolsAllow ?? []).filter((name) => name.toLowerCase() !== toolName.toLowerCase());
      chatServiceRef.current?.updateGatewayTalkTools(gwId, { toolsAllow: next }).then((updated) => {
        if (!updated) { setError('Failed to update tool allow-list'); return; }
        syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
        setMessages(prev => [...prev, createMessage('system', `Allowed tool removed: ${toolName}`)]);
      });
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, setMessages, syncToolPolicyLocal]);

  const handleClearAllowedTools = useCallback(() => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.updateGatewayTalkTools(gwId, { toolsAllow: [] }).then((updated) => {
      if (!updated) { setError('Failed to clear tool allow-list'); return; }
      syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
      setMessages(prev => [...prev, createMessage('system', 'Tool allow-list cleared (all tools allowed unless denied).')]);
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, setMessages, syncToolPolicyLocal]);

  const handleAddDeniedTool = useCallback((toolName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) return;
      const next = Array.from(new Set([...(policy.toolsDeny ?? []), toolName]));
      chatServiceRef.current?.updateGatewayTalkTools(gwId, { toolsDeny: next }).then((updated) => {
        if (!updated) { setError('Failed to update tool deny-list'); return; }
        syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
        setMessages(prev => [...prev, createMessage('system', `Denied tool added: ${toolName}`)]);
      });
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, setMessages, syncToolPolicyLocal]);

  const handleRemoveDeniedTool = useCallback((toolName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) return;
      const next = (policy.toolsDeny ?? []).filter((name) => name.toLowerCase() !== toolName.toLowerCase());
      chatServiceRef.current?.updateGatewayTalkTools(gwId, { toolsDeny: next }).then((updated) => {
        if (!updated) { setError('Failed to update tool deny-list'); return; }
        syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
        setMessages(prev => [...prev, createMessage('system', `Denied tool removed: ${toolName}`)]);
      });
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, setMessages, syncToolPolicyLocal]);

  const handleClearDeniedTools = useCallback(() => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.updateGatewayTalkTools(gwId, { toolsDeny: [] }).then((updated) => {
      if (!updated) { setError('Failed to clear tool deny-list'); return; }
      syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
      setMessages(prev => [...prev, createMessage('system', 'Tool deny-list cleared.')]);
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, setMessages, syncToolPolicyLocal]);

  const handleShowGoogleDocsAuthStatus = useCallback(() => {
    if (!chatServiceRef.current) return;
    chatServiceRef.current.getGoogleDocsAuthStatus().then((status) => {
      if (!status) {
        setError('Failed to fetch Google Docs auth status');
        return;
      }
      const sysMsg = createMessage(
        'system',
        `Google Docs auth:\n` +
        `  profile: ${status.profile ?? '(default)'}\n` +
        `  activeProfile: ${status.activeProfile ?? '(unknown)'}\n` +
        `  tokenPath: ${status.tokenPath}\n` +
        `  hasClientId: ${status.hasClientId}\n` +
        `  hasClientSecret: ${status.hasClientSecret}\n` +
        `  hasRefreshToken: ${status.hasRefreshToken}\n` +
        `  accessTokenReady: ${status.accessTokenReady}\n` +
        `  accountEmail: ${status.accountEmail ?? '(unknown)'}\n` +
        `  accountDisplayName: ${status.accountDisplayName ?? '(unknown)'}\n` +
        `  identityError: ${status.identityError ?? '(none)'}\n` +
        `  error: ${status.error ?? '(none)'}`,
      );
      setMessages(prev => [...prev, sysMsg]);
    });
  }, [chatServiceRef, setError, setMessages]);

  const handleSetGoogleDocsRefreshToken = useCallback((token: string) => {
    if (!chatServiceRef.current) return;
    chatServiceRef.current.updateGoogleDocsAuthConfig({ refreshToken: token }).then((status) => {
      if (!status) {
        setError('Failed to update Google Docs refresh token');
        return;
      }
      const sysMsg = createMessage(
        'system',
        `Google Docs refresh token updated.\n` +
        `  accessTokenReady: ${status.accessTokenReady}\n` +
        `  error: ${status.error ?? '(none)'}`,
      );
      setMessages(prev => [...prev, sysMsg]);
    });
  }, [chatServiceRef, setError, setMessages]);

  // ---- Settings panel handlers ----

  const refreshSettingsToolPolicy = useCallback(() => {
    const talk = activeTalkIdRef.current ? talkManagerRef.current?.getTalk(activeTalkIdRef.current) : null;
    const gwId = gatewayTalkIdRef.current ?? talk?.gatewayTalkId ?? null;

    if (!chatServiceRef.current) {
      const mode: ToolMode = talk?.toolMode ?? 'auto';
      const executionMode: ToolExecutionMode = talk?.executionMode ?? DEFAULT_EXECUTION_MODE;
      setSettingsToolPolicy({
        mode,
        executionMode,
        executionModeOptions: DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: talk?.filesystemAccess ?? 'full_host_access',
        networkAccess: talk?.networkAccess ?? 'full_outbound',
        effectiveTools: [],
        availableTools: [],
        enabledToolNames: talk?.toolsAllow ?? [],
        catalogEntries: [],
        installedToolNames: [],
        talkGoogleAuthProfile: talk?.googleAuthProfile,
        googleAuthActiveProfile: undefined,
        googleAuthProfiles: [],
        googleAuthStatus: undefined,
      });
      setSettingsToolPolicyError('Gateway unavailable.');
      return;
    }

    setSettingsToolPolicyLoading(true);
    setSettingsToolPolicyError(null);
    if (!gwId) {
      Promise.all([
        chatServiceRef.current.getGatewayToolCatalog(),
        chatServiceRef.current.getGoogleDocsAuthProfiles(),
        chatServiceRef.current.getGoogleDocsAuthStatus(),
      ]).then(([catalog, profiles, authStatus]) => {
        const enrichedProfiles = mergeGoogleAuthProfiles(profiles?.profiles, authStatus);
        const mode: ToolMode = talk?.toolMode ?? 'auto';
        const executionMode: ToolExecutionMode = talk?.executionMode ?? DEFAULT_EXECUTION_MODE;
        setSettingsToolPolicy({
          mode,
          executionMode,
          executionModeOptions: DEFAULT_EXECUTION_MODE_OPTIONS,
          filesystemAccess: talk?.filesystemAccess ?? 'full_host_access',
          networkAccess: talk?.networkAccess ?? 'full_outbound',
          effectiveTools: [],
          availableTools: [],
          enabledToolNames: talk?.toolsAllow ?? [],
          catalogEntries: catalog?.catalog ?? [],
          installedToolNames: catalog?.installedTools.map((tool) => tool.name) ?? [],
          talkGoogleAuthProfile: talk?.googleAuthProfile,
          googleAuthActiveProfile: profiles?.activeProfile,
          googleAuthProfiles: enrichedProfiles,
          googleAuthStatus: authStatus ?? undefined,
        });
        setSettingsToolPolicyError(
          catalog
            ? 'No active gateway talk yet. Send one message first to configure talk-level tool policy.'
            : 'Failed to load tool catalog from gateway.',
        );
      }).finally(() => {
        setSettingsToolPolicyLoading(false);
      });
      return;
    }

    Promise.all([
      chatServiceRef.current.getGatewayTalkTools(gwId),
      chatServiceRef.current.getGatewayToolCatalog(),
      chatServiceRef.current.getGoogleDocsAuthProfiles(),
      chatServiceRef.current.getGoogleDocsAuthStatus(),
    ]).then(([policy, catalog, profiles, authStatus]) => {
      if (!policy) {
        setSettingsToolPolicyError('Failed to load talk tool policy from gateway.');
        return;
      }
      const enrichedProfiles = mergeGoogleAuthProfiles(profiles?.profiles, authStatus);
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy({
        mode: policy.toolMode,
        executionMode: policy.executionMode ?? talk?.executionMode ?? DEFAULT_EXECUTION_MODE,
        executionModeOptions: policy.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: policy.filesystemAccess ?? talk?.filesystemAccess ?? 'full_host_access',
        networkAccess: policy.networkAccess ?? talk?.networkAccess ?? 'full_outbound',
        effectiveTools: policy.effectiveTools ?? policy.availableTools,
        availableTools: policy.availableTools,
        enabledToolNames: policy.enabledTools.map((tool) => tool.name),
        catalogEntries: catalog?.catalog ?? [],
        installedToolNames: catalog?.installedTools.map((tool) => tool.name) ?? [],
        talkGoogleAuthProfile: policy.googleAuthProfile,
        googleAuthActiveProfile: profiles?.activeProfile,
        googleAuthProfiles: enrichedProfiles,
        googleAuthStatus: authStatus ?? undefined,
      });
      if (!catalog) {
        setSettingsToolPolicyError('Talk policy loaded, but tool catalog could not be loaded.');
      }
    }).finally(() => {
      setSettingsToolPolicyLoading(false);
    });
  }, [activeTalkIdRef, chatServiceRef, gatewayTalkIdRef, talkManagerRef, syncToolPolicyLocal]);

  const refreshSettingsSkills = useCallback(() => {
    const talk = activeTalkIdRef.current ? talkManagerRef.current?.getTalk(activeTalkIdRef.current) : null;
    const gwId = gatewayTalkIdRef.current ?? talk?.gatewayTalkId ?? null;
    if (!gwId || !chatServiceRef.current) {
      setSettingsSkillsError('No active gateway talk.');
      return;
    }
    setSettingsSkillsLoading(true);
    setSettingsSkillsError(null);
    chatServiceRef.current.getGatewayTalkSkills(gwId).then((result) => {
      if (!result) {
        setSettingsSkillsError('Failed to load skills from gateway.');
        return;
      }
      setSettingsSkills(result.skills);
      setSettingsAllSkillsMode(result.allSkillsMode);
    }).finally(() => {
      setSettingsSkillsLoading(false);
    });
  }, [activeTalkIdRef, chatServiceRef, gatewayTalkIdRef, talkManagerRef]);

  const handleSettingsToggleSkill = useCallback((skillName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;

    // Compute new skills list
    const currentSkills = settingsSkills ?? [];
    const currentAllMode = settingsAllSkillsMode;
    let newSkillNames: string[];

    if (currentAllMode) {
      // Switching from all-skills to explicit: enable all eligible except the toggled one
      newSkillNames = currentSkills
        .filter(s => s.eligible && s.name !== skillName)
        .map(s => s.name);
    } else {
      const skill = currentSkills.find(s => s.name === skillName);
      if (skill?.enabled) {
        // Disable: remove from list
        newSkillNames = currentSkills
          .filter(s => s.enabled && s.name !== skillName)
          .map(s => s.name);
      } else {
        // Enable: add to list
        newSkillNames = [
          ...currentSkills.filter(s => s.enabled).map(s => s.name),
          skillName,
        ];
      }
    }

    chatServiceRef.current.updateGatewayTalkSkills(gwId, { skills: newSkillNames }).then((result) => {
      if (result) {
        setSettingsSkills(result.skills);
        setSettingsAllSkillsMode(result.allSkillsMode);
      }
    });
  }, [chatServiceRef, gatewayTalkIdRef, settingsSkills, settingsAllSkillsMode]);

  const handleSettingsResetSkillsToAll = useCallback(() => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.updateGatewayTalkSkills(gwId, { skills: null }).then((result) => {
      if (result) {
        setSettingsSkills(result.skills);
        setSettingsAllSkillsMode(result.allSkillsMode);
      }
    });
  }, [chatServiceRef, gatewayTalkIdRef]);

  const handleSettingsSetToolMode = useCallback((mode: ToolMode) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy((prev) => prev ? { ...prev, mode } : prev);
      syncToolPolicyLocal(mode, undefined, undefined, undefined, undefined, undefined);
      return;
    }
    chatServiceRef.current.updateGatewayTalkTools(gwId, { toolMode: mode }).then((policy) => {
      if (!policy) {
        setError('Failed to update tool mode on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => buildToolPolicyState(policy, prev));
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, syncToolPolicyLocal]);

  const handleSettingsSetExecutionMode = useCallback((executionMode: ToolExecutionMode) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy((prev) => prev ? { ...prev, executionMode } : prev);
      syncToolPolicyLocal(undefined, executionMode, undefined, undefined, undefined, undefined);
      return;
    }
    chatServiceRef.current.updateGatewayTalkTools(gwId, { executionMode }).then((policy) => {
      if (!policy) {
        setError('Failed to update execution mode on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => buildToolPolicyState(policy, prev));
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, syncToolPolicyLocal]);

  const handleSettingsSetFilesystemAccess = useCallback((filesystemAccess: ToolFilesystemAccess) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy((prev) => prev ? { ...prev, filesystemAccess } : prev);
      syncToolPolicyLocal(undefined, undefined, filesystemAccess, undefined, undefined, undefined);
      return;
    }
    chatServiceRef.current.updateGatewayTalkTools(gwId, { filesystemAccess }).then((policy) => {
      if (!policy) {
        setError('Failed to update filesystem access on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => buildToolPolicyState(policy, prev));
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, syncToolPolicyLocal]);

  const handleSettingsSetNetworkAccess = useCallback((networkAccess: ToolNetworkAccess) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy((prev) => prev ? { ...prev, networkAccess } : prev);
      syncToolPolicyLocal(undefined, undefined, undefined, networkAccess, undefined, undefined);
      return;
    }
    chatServiceRef.current.updateGatewayTalkTools(gwId, { networkAccess }).then((policy) => {
      if (!policy) {
        setError('Failed to update network access on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => buildToolPolicyState(policy, prev));
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, syncToolPolicyLocal]);

  const handleSettingsSetToolEnabled = useCallback((toolName: string, enabled: boolean) => {
    const gwId = gatewayTalkIdRef.current;
    const current = settingsToolPolicy;
    if (!current) return;
    const currentSet = new Set(current.enabledToolNames);
    if (enabled) currentSet.add(toolName);
    else currentSet.delete(toolName);
    const nextEnabled = Array.from(currentSet);

    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy({ ...current, enabledToolNames: nextEnabled });
      syncToolPolicyLocal(undefined, undefined, undefined, undefined, nextEnabled, []);
      return;
    }

    chatServiceRef.current.updateGatewayTalkTools(gwId, {
      toolsAllow: nextEnabled,
      toolsDeny: [],
    }).then((policy) => {
      if (!policy) {
        setError('Failed to update enabled tools on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => buildToolPolicyState(policy, prev));
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, settingsToolPolicy, syncToolPolicyLocal]);

  const handleSettingsSetTalkGoogleAuthProfile = useCallback((profile: string | undefined) => {
    const gwId = gatewayTalkIdRef.current;
    const current = settingsToolPolicy;
    if (!current) return;

    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy({ ...current, talkGoogleAuthProfile: profile });
      syncToolPolicyLocal(undefined, undefined, undefined, undefined, undefined, undefined, profile ?? '');
      return;
    }

    chatServiceRef.current.updateGatewayTalkTools(gwId, {
      googleAuthProfile: profile ?? '',
    }).then((policy) => {
      if (!policy) {
        setError('Failed to update Google auth profile for this talk');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => buildToolPolicyState(policy, prev));
    });
  }, [chatServiceRef, gatewayTalkIdRef, setError, settingsToolPolicy, syncToolPolicyLocal]);

  const handleSettingsStartGoogleOAuthConnect = useCallback((onOverlayMessage?: (msg: string) => void) => {
    if (!chatServiceRef.current) {
      setError('Gateway unavailable.');
      return;
    }
    const requestedProfile = settingsToolPolicy?.talkGoogleAuthProfile;
    chatServiceRef.current.startGoogleOAuthConnect(requestedProfile).then((started) => {
      if (!started) {
        const failMsg = 'Failed to start Google OAuth flow.';
        onOverlayMessage?.(failMsg);
        setError(failMsg);
        return;
      }
      const redirectHint = started.redirectUri
        ? `\n\nIf you see redirect_uri_mismatch, add this URI in Google Cloud Console → Credentials → OAuth client:\n${started.redirectUri}`
        : '';
      const urlMsg = `Open in browser:\n${started.authUrl}`;
      onOverlayMessage?.(urlMsg);
      const sysMsg = createMessage(
        'system',
        `Google OAuth started.\nOpen this URL in your browser:\n${started.authUrl}\n\nAfter approval, ClawTalk will auto-refresh tools.${redirectHint}`,
      );
      setMessages((prev) => [...prev, sysMsg]);

      googleOAuthSessionRef.current = started.sessionId;
      if (googleOAuthPollRef.current) {
        clearInterval(googleOAuthPollRef.current);
        googleOAuthPollRef.current = null;
      }
      googleOAuthPollRef.current = setInterval(() => {
        const sessionId = googleOAuthSessionRef.current;
        if (!sessionId || !chatServiceRef.current) return;
        chatServiceRef.current.getGoogleOAuthConnectStatus(sessionId).then((status) => {
          if (!status?.found || status.status === 'pending') return;
          if (googleOAuthPollRef.current) {
            clearInterval(googleOAuthPollRef.current);
            googleOAuthPollRef.current = null;
          }
          googleOAuthSessionRef.current = null;
          if (status.status === 'success') {
            const successText = `Google OAuth connected.\nProfile: ${status.profile ?? '(unknown)'}\nAccount: ${status.accountEmail ?? '(unknown)'}`;
            onOverlayMessage?.(successText);
            const okMsg = createMessage('system', successText);
            setMessages((prev) => [...prev, okMsg]);
            refreshSettingsToolPolicy();
            return;
          }
          const failText = `Google OAuth failed: ${status.error ?? 'Unknown error'}`;
          onOverlayMessage?.(failText);
          const failMsg = createMessage('system', failText);
          setMessages((prev) => [...prev, failMsg]);
        });
      }, 2000);
    });
  }, [chatServiceRef, setError, setMessages, refreshSettingsToolPolicy, settingsToolPolicy?.talkGoogleAuthProfile]);

  const handleSettingsCatalogInstall = useCallback((catalogId: string) => {
    if (!chatServiceRef.current) return;
    chatServiceRef.current.installGatewayCatalogTool(catalogId).then((result) => {
      if (!result?.ok) {
        setError(`Failed to install catalog tool "${catalogId}"`);
        return;
      }
      if (result.authSetupRecommended) {
        const authMessages = result.auth?.requirements
          ?.filter((req) => !req.ready)
          .map((req) => `- ${req.id}: ${req.message ?? 'auth setup required'}`)
          .join('\n');
        const msg = createMessage(
          'system',
          `Installed "${catalogId}", but auth setup is required before use.\n`
          + `${authMessages || '- Missing auth configuration'}\n`
          + `Use: /tools auth status\n`
          + `Then configure with: /tools auth set-refresh <google-refresh-token>`,
        );
        setMessages((prev) => [...prev, msg]);
      }
      refreshSettingsToolPolicy();
    });
  }, [chatServiceRef, setError, setMessages, refreshSettingsToolPolicy]);

  const handleSettingsCatalogUninstall = useCallback((catalogId: string) => {
    if (!chatServiceRef.current) return;
    chatServiceRef.current.uninstallGatewayCatalogTool(catalogId).then((ok) => {
      if (!ok) {
        setError(`Failed to uninstall catalog tool "${catalogId}"`);
        return;
      }
      refreshSettingsToolPolicy();
    });
  }, [chatServiceRef, setError, refreshSettingsToolPolicy]);

  return {
    // State
    settingsToolPolicy,
    setSettingsToolPolicy,
    settingsToolPolicyLoading,
    settingsToolPolicyError,
    setSettingsToolPolicyError,
    settingsSkills,
    settingsSkillsLoading,
    settingsSkillsError,
    settingsAllSkillsMode,

    // Command handlers
    syncToolPolicyLocal,
    handleListTools,
    handleSetToolsMode,
    handleAddAllowedTool,
    handleRemoveAllowedTool,
    handleClearAllowedTools,
    handleAddDeniedTool,
    handleRemoveDeniedTool,
    handleClearDeniedTools,
    handleShowGoogleDocsAuthStatus,
    handleSetGoogleDocsRefreshToken,

    // Settings panel handlers
    refreshSettingsToolPolicy,
    refreshSettingsSkills,
    handleSettingsToggleSkill,
    handleSettingsResetSkillsToAll,
    handleSettingsSetToolMode,
    handleSettingsSetExecutionMode,
    handleSettingsSetFilesystemAccess,
    handleSettingsSetNetworkAccess,
    handleSettingsSetToolEnabled,
    handleSettingsSetTalkGoogleAuthProfile,
    handleSettingsStartGoogleOAuthConnect,
    handleSettingsCatalogInstall,
    handleSettingsCatalogUninstall,
  };
}
