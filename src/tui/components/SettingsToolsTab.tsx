/**
 * Settings Tools Tab — execution mode, tool approval, filesystem/network access,
 * Google Auth profiles, installed tools, and tool catalog.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type {
  GoogleAuthProfileSummary,
  ToolCatalogEntry,
  ToolDescriptor,
  ToolExecutionMode,
  ToolExecutionModeOption,
  ToolFilesystemAccess,
  ToolMode,
  ToolNetworkAccess,
} from '../../types.js';

function normalizeExecutionMode(raw: unknown): ToolExecutionMode {
  return raw === 'full_control' ? 'full_control' : 'openclaw';
}

export function normalizeExecutionModeOptions(raw: unknown): ToolExecutionModeOption[] {
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

interface ToolPolicy {
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
}

interface SettingsToolsTabProps {
  toolPolicy: ToolPolicy | null | undefined;
  toolPolicyLoading?: boolean;
  toolPolicyError?: string | null;
  selectedIndex: number;
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
}

function padCell(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value.padEnd(width, ' ');
}

function buildDivider(widths: number[]): string {
  return `  ${'-'.repeat(widths.reduce((sum, width) => sum + width, 0) + ((widths.length - 1) * 2))}`;
}

const TOOL_NAME_COL = 28;
const TOOL_STATUS_COL = 8;
const TOOL_CT_COL = 8;
const TOOL_OC_COL = 8;
const CATALOG_NAME_COL = 34;
const CATALOG_STATE_COL = 12;
const CATALOG_VERSION_COL = 10;

const TOOL_MODES: ToolMode[] = ['off', 'confirm', 'auto'];
const TOOL_MODE_DESCRIPTIONS: Record<ToolMode, string> = {
  off: 'model cannot use tools',
  confirm: 'approval required',
  auto: 'no approval',
};

const FILESYSTEM_DESCRIPTIONS: Record<ToolFilesystemAccess, string> = {
  workspace_sandbox: 'Workspace Sandbox',
  full_host_access: 'Full Host Access',
};

const NETWORK_DESCRIPTIONS: Record<ToolNetworkAccess, string> = {
  restricted: 'Restricted',
  full_outbound: 'Full Outbound',
};

export function SettingsToolsTab({
  toolPolicy,
  toolPolicyLoading,
  toolPolicyError,
  selectedIndex,
  talkGoogleAuthProfile,
  googleAuthActiveProfile,
  googleAuthProfiles,
  googleAuthStatus,
}: SettingsToolsTabProps) {
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
  const toolEnabledSet = new Set(toolPolicy?.enabledToolNames ?? []);
  const effectiveGoogleProfile = talkGoogleAuthProfile || googleAuthActiveProfile;
  const selectedGoogleProfile = authProfiles.find((p) => p.name === effectiveGoogleProfile);

  const executionRowCount = executionModeOptions.length;
  const toolApprovalRowCount = TOOL_MODES.length;
  const filesystemRowCount = filesystemOptions.length;
  const networkRowCount = networkOptions.length;
  const profileStartIndex = executionRowCount + toolApprovalRowCount + filesystemRowCount + networkRowCount;
  const toolsStartIndex = profileStartIndex + profileRowCount;
  const catalogStartIndex = toolsStartIndex + toolRows.length;

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

  const toolHeader = `  ${padCell('Tool', TOOL_NAME_COL)}  ${padCell('Status', TOOL_STATUS_COL)}  ${padCell('ClawTalk', TOOL_CT_COL)}  ${padCell('OpenClaw', TOOL_OC_COL)}`;
  const toolDivider = buildDivider([TOOL_NAME_COL, TOOL_STATUS_COL, TOOL_CT_COL, TOOL_OC_COL]);
  const catalogHeader = `  ${padCell('Package', CATALOG_NAME_COL)}  ${padCell('State', CATALOG_STATE_COL)}  ${padCell('Version', CATALOG_VERSION_COL)}`;
  const catalogDivider = buildDivider([CATALOG_NAME_COL, CATALOG_STATE_COL, CATALOG_VERSION_COL]);

  if (toolPolicyLoading) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading tool settings...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
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
                {idx === selectedIndex ? '\u25B8 ' : '  '}
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
        {TOOL_MODES.map((mode, idx) => {
          const rowIndex = executionRowCount + idx;
          const active = toolPolicy?.mode === mode;
          return (
            <Box key={mode}>
              <Text color={rowIndex === selectedIndex ? 'cyan' : undefined}>
                {rowIndex === selectedIndex ? '\u25B8 ' : '  '}
              </Text>
              <Text dimColor>{idx + 1}. </Text>
              <Text color={active ? 'green' : undefined} bold={active}>
                {mode}
              </Text>
              <Text dimColor> ({TOOL_MODE_DESCRIPTIONS[mode]})</Text>
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
                {rowIndex === selectedIndex ? '\u25B8 ' : '  '}
              </Text>
              <Text dimColor>{idx + 1}. </Text>
              <Text color={active ? 'green' : undefined} bold={active}>
                {FILESYSTEM_DESCRIPTIONS[mode]}
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
                {rowIndex === selectedIndex ? '\u25B8 ' : '  '}
              </Text>
              <Text dimColor>{idx + 1}. </Text>
              <Text color={active ? 'green' : undefined} bold={active}>
                {NETWORK_DESCRIPTIONS[mode]}
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
              <Text color={selected ? 'cyan' : undefined}>{selected ? '\u25B8 ' : '  '}</Text>
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
            const paddedName = padCell(tool.name, TOOL_NAME_COL);
            const ctStatus = tool.clawtalkStatus === 'on' ? 'on' : '---';
            const ctColor: 'green' | 'yellow' = tool.clawtalkStatus === 'on' ? 'green' : 'yellow';
            const ocStatus = tool.openclawStatus === 'on' ? 'on' : '---';
            const ocColor: 'green' | 'yellow' = tool.openclawStatus === 'on' ? 'green' : 'yellow';
            return (
              <Box key={tool.name}>
                <Text color={selected ? 'cyan' : undefined}>{selected ? '\u25B8 ' : '  '}</Text>
                <Text>{paddedName}</Text>
                <Text>  </Text>
                <Text color={statusColor}>{padCell(status, TOOL_STATUS_COL)}</Text>
                <Text>  </Text>
                <Text color={ctColor}>{padCell(ctStatus, TOOL_CT_COL)}</Text>
                <Text>  </Text>
                <Text color={ocColor}>{padCell(ocStatus, TOOL_OC_COL)}</Text>
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
            const paddedName = padCell(entry.name, CATALOG_NAME_COL);
            return (
              <Box key={entry.id}>
                <Text color={selected ? 'cyan' : undefined}>{selected ? '\u25B8 ' : '  '}</Text>
                <Text>{paddedName}</Text>
                <Text>  </Text>
                <Text color={stateColor}>{padCell(state, CATALOG_STATE_COL)}</Text>
                <Text>  </Text>
                <Text dimColor>{padCell(entry.version, CATALOG_VERSION_COL)}</Text>
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
    </Box>
  );
}
