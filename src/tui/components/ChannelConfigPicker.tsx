/**
 * Channel Config Picker
 *
 * Keyboard-first modal for configuring talk channel bindings and response behavior.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { PlatformBehavior, PlatformBinding, PlatformPermission, TalkAgent } from '../../types';

interface ChannelConfigPickerProps {
  maxHeight: number;
  terminalWidth: number;
  bindings: PlatformBinding[];
  behaviors: PlatformBehavior[];
  agents: TalkAgent[];
  onClose: () => void;
  onAddBinding: (platform: string, scope: string, permission: PlatformPermission) => void;
  onRemoveBinding: (index: number) => void;
  onSetAutoRespond: (index: number, enabled: boolean) => void;
  onSetPrompt: (index: number, prompt: string) => void;
  onSetAgent: (index: number, agentName: string) => void;
  onClearBehavior: (index: number) => void;
}

type PickerMode =
  | 'list'
  | 'add-platform'
  | 'add-scope'
  | 'add-permission'
  | 'edit-prompt'
  | 'pick-agent'
  | 'confirm-delete';

const PLATFORM_OPTIONS = ['slack', 'telegram', 'whatsapp'] as const;
const PERMISSION_OPTIONS: PlatformPermission[] = ['read', 'write', 'read+write'];

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
  return text.slice(0, Math.max(0, maxLen - 3)) + '...';
}

export function ChannelConfigPicker({
  maxHeight,
  terminalWidth,
  bindings,
  behaviors,
  agents,
  onClose,
  onAddBinding,
  onRemoveBinding,
  onSetAutoRespond,
  onSetPrompt,
  onSetAgent,
  onClearBehavior,
}: ChannelConfigPickerProps) {
  const [mode, setMode] = useState<PickerMode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [platformSelection, setPlatformSelection] = useState(0);
  const [pendingPlatform, setPendingPlatform] = useState<string>(PLATFORM_OPTIONS[0]);
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

  const visibleRows = Math.max(4, maxHeight - 13);

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
      if (key.upArrow) {
        setSelectedIndex((prev) => {
          const next = Math.max(0, prev - 1);
          ensureVisible(next);
          return next;
        });
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) => {
          const next = Math.min(Math.max(rows.length - 1, 0), prev + 1);
          ensureVisible(next);
          return next;
        });
        return;
      }

      if (input === 'a') {
        setPlatformSelection(0);
        setPendingPlatform(PLATFORM_OPTIONS[0]);
        setScopeInput('');
        setPermissionSelection(2);
        setMode('add-platform');
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

      if (key.return) {
        const chosen = PLATFORM_OPTIONS[platformSelection];
        setPendingPlatform(chosen);
        setScopeInput('');
        setMode('add-scope');
        return;
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
        return;
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
        onSetAgent(selectedRow.index, chosen.name);
        setStatusMessage(`Connection #${selectedRow.index} responder: ${chosen.name}.`);
        setMode('list');
        return;
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
        return;
      }
    }
  });

  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(rows.length, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={terminalWidth}>
      <Text bold color="cyan">Channel Config</Text>
      <Text dimColor>Slack supports inbound auto-response. Telegram/WhatsApp are currently event-job oriented.</Text>

      {mode === 'list' && (
        <>
          <Text dimColor>↑/↓ select  a add  d delete  t auto  g agent  p prompt  c clear  Esc/^B close</Text>
          <Box height={1} />

          {rows.length === 0 ? (
            <Text dimColor>No channel connections yet. Press "a" to add one.</Text>
          ) : (
            <>
              {Array.from({ length: visibleEnd - visibleStart }, (_, offset) => {
                const idx = visibleStart + offset;
                const row = rows[idx];
                if (!row) return null;
                const isSelected = idx === selectedIndex;
                const promptLabel = row.prompt ? `"${truncate(row.prompt, 40)}"` : '(none)';
                return (
                  <Text key={row.binding.id} color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '▸ ' : '  '}
                    {row.index}. {row.binding.platform} {formatBindingScopeLabel(row.binding)} ({row.binding.permission})
                    {'  '}auto:{row.autoRespond ? 'on' : 'off'}
                    {'  '}agent:{row.agentName ?? '(default)'}
                    {'  '}prompt:{promptLabel}
                  </Text>
                );
              })}
              {visibleEnd < rows.length && <Text dimColor>▼ more</Text>}
            </>
          )}
        </>
      )}

      {mode === 'add-platform' && (
        <>
          <Box height={1} />
          <Text bold>Select Platform</Text>
          {PLATFORM_OPTIONS.map((platform, idx) => (
            <Text key={platform} color={idx === platformSelection ? 'cyan' : undefined}>
              {idx === platformSelection ? '▸ ' : '  '}
              {platform}
            </Text>
          ))}
          <Box height={1} />
          <Text dimColor>Enter continue  Esc cancel</Text>
        </>
      )}

      {mode === 'add-scope' && (
        <>
          <Box height={1} />
          <Text bold>Add Scope</Text>
          <Text dimColor>Platform: {pendingPlatform}</Text>
          <Text dimColor>Examples: channel:C123, #general, group:-10012345</Text>
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
                setPendingScope(trimmed);
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
          <Text bold>Select Permission</Text>
          <Text dimColor>
            {pendingPlatform} {pendingScope}
          </Text>
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
