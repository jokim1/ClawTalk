/**
 * Channel Config Picker
 *
 * Keyboard-first modal for configuring talk channel bindings and response behavior.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { PlatformBehavior, PlatformBinding, PlatformPermission, TalkAgent } from '../../types';
import type { SlackAccountOption, SlackChannelOption } from '../../services/chat';

interface ChannelConfigPickerProps {
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
  onClose: () => void;
  onAddBinding: (platform: string, scope: string, permission: PlatformPermission) => void;
  onRemoveBinding: (index: number) => void;
  onSetAutoRespond: (index: number, enabled: boolean) => void;
  onSetPrompt: (index: number, prompt: string) => void;
  onSetAgentChoice: (index: number, agentName?: string) => void;
  onClearBehavior: (index: number) => void;
}

type PickerMode =
  | 'list'
  | 'add-platform'
  | 'add-workspace'
  | 'add-scope'
  | 'add-permission'
  | 'edit-prompt'
  | 'pick-agent'
  | 'confirm-delete';

type ListFocus = 'connections' | 'auto' | 'agent';

const PLATFORM_OPTIONS = ['slack', 'telegram', 'whatsapp'] as const;
const PERMISSION_OPTIONS: PlatformPermission[] = ['read', 'write', 'read+write'];

const PLATFORM_LABELS: Record<(typeof PLATFORM_OPTIONS)[number], string> = {
  slack: 'Slack',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
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

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function platformCapability(platform: string): string {
  if (platform === 'slack') return 'Inbound auto-response + event jobs';
  if (platform === 'telegram') return 'Connection + event jobs';
  if (platform === 'whatsapp') return 'Connection + event jobs';
  return 'Connection + event jobs';
}

function hasSlackAccountPrefix(scope: string): boolean {
  const trimmed = scope.trim();
  if (!trimmed) return false;
  if (/^account:[a-z0-9._-]+:/i.test(trimmed)) return true;
  const prefixMatch = trimmed.match(/^([a-z0-9._-]+):/i);
  if (!prefixMatch?.[1]) return false;
  const prefix = prefixMatch[1].toLowerCase();
  if (prefix === 'slack' || prefix === 'channel' || prefix === 'user') return false;
  return true;
}

function maybePrefixSlackAccount(scope: string, accountId: string | undefined): string {
  const trimmed = scope.trim();
  if (!trimmed || !accountId) return trimmed;
  if (hasSlackAccountPrefix(trimmed)) return trimmed;
  return `${accountId}:${trimmed}`;
}

export function ChannelConfigPicker({
  maxHeight,
  terminalWidth,
  bindings,
  behaviors,
  agents,
  slackAccounts,
  slackChannelsByAccount,
  slackHintsLoading,
  slackHintsError,
  onRefreshSlackHints,
  onClose,
  onAddBinding,
  onRemoveBinding,
  onSetAutoRespond,
  onSetPrompt,
  onSetAgentChoice,
  onClearBehavior,
}: ChannelConfigPickerProps) {
  const [mode, setMode] = useState<PickerMode>('list');
  const [listFocus, setListFocus] = useState<ListFocus>('connections');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [platformSelection, setPlatformSelection] = useState(0);
  const [pendingPlatform, setPendingPlatform] = useState<string>(PLATFORM_OPTIONS[0]);
  const [workspaceSelection, setWorkspaceSelection] = useState(0);
  const [pendingSlackAccountId, setPendingSlackAccountId] = useState<string | undefined>(undefined);
  const [scopeInput, setScopeInput] = useState('');
  const [pendingScope, setPendingScope] = useState('');
  const [permissionSelection, setPermissionSelection] = useState(2);

  const [promptInput, setPromptInput] = useState('');
  const [agentSelection, setAgentSelection] = useState(0);

  const behaviorByBindingId = useMemo(() => {
    const map = new Map<string, PlatformBehavior>();
    for (const behavior of behaviors) {
      map.set(behavior.platformBindingId, behavior);
    }
    return map;
  }, [behaviors]);

  const rows = useMemo(() => {
    return bindings.map((binding, idx) => {
      const behavior = behaviorByBindingId.get(binding.id);
      return {
        index: idx + 1,
        binding,
        autoRespond: behavior?.autoRespond !== false,
        agentName: behavior?.agentName,
        prompt: behavior?.onMessagePrompt,
      };
    });
  }, [bindings, behaviorByBindingId]);

  const selectedRow = rows[selectedIndex];
  const selectedWorkspace = slackAccounts[workspaceSelection];
  const channelsForSelectedWorkspace = pendingSlackAccountId
    ? (slackChannelsByAccount[pendingSlackAccountId] ?? [])
    : [];

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
    if (selectedIndex > rows.length - 1) {
      setSelectedIndex(rows.length - 1);
    }
  }, [rows.length, selectedIndex]);

  useEffect(() => {
    if (workspaceSelection > slackAccounts.length - 1) {
      setWorkspaceSelection(0);
    }
  }, [slackAccounts.length, workspaceSelection]);

  const visibleRows = Math.max(3, maxHeight - 20);
  const ensureVisible = (idx: number) => {
    setScrollOffset((prev) => {
      if (idx < prev) return idx;
      if (idx >= prev + visibleRows) return idx - visibleRows + 1;
      return prev;
    });
  };

  useInput((input, key) => {
    if (input === 'b' && key.ctrl) {
      onClose();
      return;
    }

    if (key.escape) {
      if (mode === 'list') onClose();
      else setMode('list');
      return;
    }

    if (mode === 'add-scope' || mode === 'edit-prompt') {
      return;
    }

    if (mode === 'list') {
      if (key.leftArrow || key.rightArrow) {
        const order: ListFocus[] = ['connections', 'auto', 'agent'];
        const current = order.indexOf(listFocus);
        const next = key.rightArrow
          ? order[(current + 1) % order.length]
          : order[(current - 1 + order.length) % order.length];
        setListFocus(next);
        return;
      }

      if (key.upArrow) {
        if (listFocus === 'connections') {
          setSelectedIndex((prev) => {
            const next = Math.max(0, prev - 1);
            ensureVisible(next);
            return next;
          });
          return;
        }
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        if (listFocus === 'auto') {
          if (!selectedRow.autoRespond) {
            onSetAutoRespond(selectedRow.index, true);
            setStatusMessage(`Connection #${selectedRow.index} auto-response enabled.`);
          }
          return;
        }
        if (listFocus === 'agent') {
          const choices: Array<string | undefined> = [undefined, ...agents.map((agent) => agent.name)];
          const currentIdx = selectedRow.agentName
            ? choices.findIndex((choice) => choice?.toLowerCase() === selectedRow.agentName?.toLowerCase())
            : 0;
          const nextIdx = currentIdx <= 0 ? choices.length - 1 : currentIdx - 1;
          const nextChoice = choices[nextIdx];
          onSetAgentChoice(selectedRow.index, nextChoice);
          setStatusMessage(
            `Connection #${selectedRow.index} responder: ${nextChoice ?? '(default primary)'}.`,
          );
          return;
        }
        return;
      }
      if (key.downArrow) {
        if (listFocus === 'connections') {
          setSelectedIndex((prev) => {
            const next = Math.min(Math.max(rows.length - 1, 0), prev + 1);
            ensureVisible(next);
            return next;
          });
          return;
        }
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        if (listFocus === 'auto') {
          if (selectedRow.autoRespond) {
            onSetAutoRespond(selectedRow.index, false);
            setStatusMessage(`Connection #${selectedRow.index} auto-response disabled.`);
          }
          return;
        }
        if (listFocus === 'agent') {
          const choices: Array<string | undefined> = [undefined, ...agents.map((agent) => agent.name)];
          const currentIdx = selectedRow.agentName
            ? choices.findIndex((choice) => choice?.toLowerCase() === selectedRow.agentName?.toLowerCase())
            : 0;
          const nextIdx = currentIdx >= choices.length - 1 ? 0 : currentIdx + 1;
          const nextChoice = choices[nextIdx];
          onSetAgentChoice(selectedRow.index, nextChoice);
          setStatusMessage(
            `Connection #${selectedRow.index} responder: ${nextChoice ?? '(default primary)'}.`,
          );
          return;
        }
        return;
      }

      if (input === 'a') {
        setPlatformSelection(0);
        setPendingPlatform(PLATFORM_OPTIONS[0]);
        setPendingSlackAccountId(undefined);
        setScopeInput('');
        setPermissionSelection(2);
        setMode('add-platform');
        return;
      }
      if (input === 'r') {
        onRefreshSlackHints();
        setStatusMessage('Refreshing Slack workspaces/channels...');
        return;
      }
      if (input === 'd') {
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        setMode('confirm-delete');
        return;
      }
      if (input === 't') {
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        onSetAutoRespond(selectedRow.index, !selectedRow.autoRespond);
        setStatusMessage(
          `Connection #${selectedRow.index} auto-response ${selectedRow.autoRespond ? 'disabled' : 'enabled'}.`,
        );
        return;
      }
      if (input === 'p') {
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        setPromptInput(selectedRow.prompt ?? '');
        setMode('edit-prompt');
        return;
      }
      if (input === 'g') {
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        if (agents.length === 0) {
          setStatusMessage('No agents configured. Add an agent first.');
          return;
        }
        const currentAgentIndex = selectedRow.agentName
          ? agents.findIndex((agent) => agent.name.toLowerCase() === selectedRow.agentName?.toLowerCase())
          : -1;
        setAgentSelection(currentAgentIndex >= 0 ? currentAgentIndex : 0);
        setMode('pick-agent');
        return;
      }
      if (input === 'c') {
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        onClearBehavior(selectedRow.index);
        setStatusMessage(`Cleared response settings for connection #${selectedRow.index}.`);
        return;
      }
      return;
    }

    if (mode === 'add-platform') {
      if (key.upArrow) {
        setPlatformSelection((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setPlatformSelection((prev) => Math.min(PLATFORM_OPTIONS.length - 1, prev + 1));
        return;
      }
      if (input === 'r') {
        onRefreshSlackHints();
        setStatusMessage('Refreshing Slack workspaces/channels...');
        return;
      }
      if (key.return) {
        const chosen = PLATFORM_OPTIONS[platformSelection];
        setPendingPlatform(chosen);

        if (chosen === 'slack' && slackAccounts.length > 0) {
          const firstValidIdx = slackAccounts.findIndex((account) => account.hasBotToken);
          const nextIndex = firstValidIdx >= 0 ? firstValidIdx : 0;
          setWorkspaceSelection(nextIndex);
          setPendingSlackAccountId(slackAccounts[nextIndex]?.id);
          setMode('add-workspace');
          return;
        }

        setPendingSlackAccountId(undefined);
        setScopeInput(chosen === 'slack' ? '#' : '');
        setMode('add-scope');
      }
      return;
    }

    if (mode === 'add-workspace') {
      if (slackAccounts.length === 0) {
        setPendingSlackAccountId(undefined);
        setScopeInput('#');
        setMode('add-scope');
        return;
      }
      if (key.upArrow) {
        setWorkspaceSelection((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setWorkspaceSelection((prev) => Math.min(slackAccounts.length - 1, prev + 1));
        return;
      }
      if (input === 'r') {
        onRefreshSlackHints();
        setStatusMessage('Refreshing Slack workspaces/channels...');
        return;
      }
      if (key.return) {
        const chosen = selectedWorkspace;
        setPendingSlackAccountId(chosen?.id);
        setScopeInput('#');
        setMode('add-scope');
      }
      return;
    }

    if (mode === 'add-permission') {
      if (key.upArrow) {
        setPermissionSelection((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setPermissionSelection((prev) => Math.min(PERMISSION_OPTIONS.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const permission = PERMISSION_OPTIONS[permissionSelection];
        onAddBinding(pendingPlatform, pendingScope, permission);
        setMode('list');
        setSelectedIndex(rows.length);
        setStatusMessage(`Added ${pendingPlatform} ${pendingScope} (${permission}).`);
      }
      return;
    }

    if (mode === 'pick-agent') {
      if (agents.length === 0) {
        setMode('list');
        return;
      }
      if (key.upArrow) {
        setAgentSelection((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setAgentSelection((prev) => Math.min(agents.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        if (!selectedRow) {
          setMode('list');
          return;
        }
        const chosen = agents[agentSelection];
        if (!chosen) return;
        onSetAgentChoice(selectedRow.index, chosen.name);
        setStatusMessage(`Connection #${selectedRow.index} responder: ${chosen.name}.`);
        setMode('list');
      }
      return;
    }

    if (mode === 'confirm-delete') {
      if (key.return || input.toLowerCase() === 'y') {
        if (selectedRow) {
          onRemoveBinding(selectedRow.index);
          setStatusMessage(`Removed connection #${selectedRow.index}.`);
        }
        setMode('list');
        return;
      }
      if (input.toLowerCase() === 'n') {
        setMode('list');
      }
    }
  });

  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(rows.length, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={terminalWidth}>
      <Text bold color="cyan">Channel Config</Text>
      <Text dimColor>Workflow: add connection, then tune how that channel responds.</Text>

      {mode === 'list' && (
        <>
          <Text dimColor>↑/↓ adjust focus target  ←/→ move focus (list/auto/agent)  a add  d delete  p prompt  c clear  r refresh Slack  Esc/^B close</Text>
          <Box height={1} />

          <Text bold color={listFocus === 'connections' ? 'cyan' : undefined}>Connections</Text>
          {rows.length === 0 ? (
            <Text dimColor>  No channel connections yet. Press "a" to add one.</Text>
          ) : (
            <>
              {Array.from({ length: visibleEnd - visibleStart }, (_, offset) => {
                const idx = visibleStart + offset;
                const row = rows[idx];
                if (!row) return null;
                const isSelected = idx === selectedIndex;
                return (
                  <Text key={row.binding.id} color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '▸ ' : '  '}
                    {row.index}. {row.binding.platform} {formatBindingScopeLabel(row.binding)}
                  </Text>
                );
              })}
              {visibleEnd < rows.length && <Text dimColor>  ▼ more</Text>}
            </>
          )}

          <Box height={1} />
          <Text bold>Selected Details</Text>
          {selectedRow ? (
            <>
              <Text>  platform: {selectedRow.binding.platform}</Text>
              <Text>  scope: {formatBindingScopeLabel(selectedRow.binding)}</Text>
              <Text>  permission: {selectedRow.binding.permission}</Text>
              <Text>  capability: {platformCapability(selectedRow.binding.platform)}</Text>
              <Text color={listFocus === 'auto' ? 'cyan' : undefined}>
                {listFocus === 'auto' ? '▸ ' : '  '}auto-response: {selectedRow.autoRespond ? 'on' : 'off'}
              </Text>
              <Text color={listFocus === 'agent' ? 'cyan' : undefined}>
                {listFocus === 'agent' ? '▸ ' : '  '}responder agent: {selectedRow.agentName ?? '(default primary)'}
              </Text>
              <Text>  prompt:</Text>
              <Text dimColor>
                {'    '}
                {selectedRow.prompt ? truncate(selectedRow.prompt, Math.max(40, terminalWidth - 10)) : '(none)'}
              </Text>
            </>
          ) : (
            <Text dimColor>  No connection selected.</Text>
          )}
        </>
      )}

      {mode === 'add-platform' && (
        <>
          <Box height={1} />
          <Text bold>Step 1: Choose Platform</Text>
          {PLATFORM_OPTIONS.map((platform, idx) => (
            <Text key={platform} color={idx === platformSelection ? 'cyan' : undefined}>
              {idx === platformSelection ? '▸ ' : '  '}
              {PLATFORM_LABELS[platform]}  <Text dimColor>({platformCapability(platform)})</Text>
            </Text>
          ))}
          <Box height={1} />
          <Text dimColor>Enter continue  Esc cancel  r refresh Slack data</Text>
        </>
      )}

      {mode === 'add-workspace' && (
        <>
          <Box height={1} />
          <Text bold>Step 2: Choose Slack Workspace</Text>
          {slackHintsLoading && <Text dimColor>Loading Slack workspace/channel discovery...</Text>}
          {slackHintsError && <Text color="yellow">{slackHintsError}</Text>}
          {slackAccounts.length === 0 ? (
            <Text dimColor>No Slack workspaces discovered. Continuing with manual scope entry.</Text>
          ) : (
            slackAccounts.map((account, idx) => (
              <Text key={account.id} color={idx === workspaceSelection ? 'cyan' : undefined}>
                {idx === workspaceSelection ? '▸ ' : '  '}
                {account.id}
                {account.isDefault ? ' (default)' : ''}
                {!account.hasBotToken ? ' [no token]' : ''}
              </Text>
            ))
          )}
          <Box height={1} />
          <Text dimColor>Enter continue  Esc cancel  r refresh</Text>
        </>
      )}

      {mode === 'add-scope' && (
        <>
          <Box height={1} />
          <Text bold>Step {pendingPlatform === 'slack' ? '3' : '2'}: Enter Scope</Text>
          <Text dimColor>Platform: {pendingPlatform}</Text>
          {pendingPlatform === 'slack' && pendingSlackAccountId && (
            <Text dimColor>Workspace: {pendingSlackAccountId}</Text>
          )}
          {pendingPlatform === 'slack' ? (
            <>
              <Text dimColor>Examples: #general, channel:C12345678, user:U12345678, *</Text>
              {slackHintsLoading && <Text dimColor>Loading channel suggestions...</Text>}
              {slackHintsError && <Text color="yellow">{slackHintsError}</Text>}
              {channelsForSelectedWorkspace.length > 0 ? (
                <>
                  <Text>Known channels for this workspace:</Text>
                  {channelsForSelectedWorkspace.slice(0, 8).map((channel) => (
                    <Text key={channel.id} dimColor>
                      {'  '}
                      {channel.displayScope}  ({channel.scope})
                    </Text>
                  ))}
                </>
              ) : (
                <Text dimColor>No channel suggestions found. You can still enter scope manually.</Text>
              )}
            </>
          ) : (
            <Text dimColor>Examples: group:-1001234567890, group:1203630...</Text>
          )}

          <Box>
            <Text>scope: </Text>
            <TextInput
              value={scopeInput}
              onChange={setScopeInput}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setStatusMessage('Scope cannot be empty.');
                  return;
                }
                const finalScope = pendingPlatform === 'slack'
                  ? maybePrefixSlackAccount(trimmed, pendingSlackAccountId)
                  : trimmed;
                setPendingScope(finalScope);
                setPermissionSelection(2);
                setMode('add-permission');
              }}
            />
          </Box>
          <Text dimColor>Enter continue  Esc cancel</Text>
        </>
      )}

      {mode === 'add-permission' && (
        <>
          <Box height={1} />
          <Text bold>Step {pendingPlatform === 'slack' ? '4' : '3'}: Choose Permission</Text>
          <Text dimColor>{pendingPlatform} {pendingScope}</Text>
          {PERMISSION_OPTIONS.map((permission, idx) => (
            <Text key={permission} color={idx === permissionSelection ? 'cyan' : undefined}>
              {idx === permissionSelection ? '▸ ' : '  '}
              {permission}
            </Text>
          ))}
          <Box height={1} />
          <Text dimColor>Enter save  Esc cancel</Text>
        </>
      )}

      {mode === 'edit-prompt' && (
        <>
          <Box height={1} />
          <Text bold>Set Response Prompt</Text>
          {selectedRow ? (
            <Text dimColor>
              Connection #{selectedRow.index}: {selectedRow.binding.platform} {formatBindingScopeLabel(selectedRow.binding)}
            </Text>
          ) : (
            <Text dimColor>No selected connection.</Text>
          )}
          <Box>
            <Text>prompt: </Text>
            <TextInput
              value={promptInput}
              onChange={setPromptInput}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!selectedRow) {
                  setMode('list');
                  return;
                }
                if (!trimmed) {
                  setStatusMessage('Prompt cannot be empty. Use "c" in list mode to clear settings.');
                  return;
                }
                onSetPrompt(selectedRow.index, trimmed);
                setStatusMessage(`Updated prompt for connection #${selectedRow.index}.`);
                setMode('list');
              }}
            />
          </Box>
          <Text dimColor>Enter save  Esc cancel</Text>
        </>
      )}

      {mode === 'pick-agent' && (
        <>
          <Box height={1} />
          <Text bold>Select Responder Agent</Text>
          {agents.length === 0 ? (
            <Text dimColor>No agents configured.</Text>
          ) : (
            agents.map((agent, idx) => (
              <Text key={agent.name} color={idx === agentSelection ? 'cyan' : undefined}>
                {idx === agentSelection ? '▸ ' : '  '}
                {agent.name} [{agent.role}]
              </Text>
            ))
          )}
          <Box height={1} />
          <Text dimColor>Enter save  Esc cancel</Text>
        </>
      )}

      {mode === 'confirm-delete' && (
        <>
          <Box height={1} />
          <Text color="yellow">
            Delete connection #{selectedRow?.index ?? '?'}? Press Enter or y to confirm, n to cancel.
          </Text>
        </>
      )}

      {statusMessage && (
        <>
          <Box height={1} />
          <Text color="green">{statusMessage}</Text>
        </>
      )}
    </Box>
  );
}
