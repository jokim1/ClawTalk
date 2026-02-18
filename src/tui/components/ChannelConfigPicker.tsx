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
  onUpdateBinding: (
    index: number,
    updates: Partial<Pick<PlatformBinding, 'platform' | 'scope' | 'permission'>>,
  ) => void;
  onRemoveBinding: (index: number) => void;
  onSetAutoRespond: (index: number, enabled: boolean) => void;
  onSetPrompt: (index: number, prompt: string) => void;
  onSetAgentChoice: (index: number, agentName?: string) => void;
  onClearBehavior: (index: number) => void;
}

type PickerMode =
  | 'list'
  | 'edit-connection'
  | 'add-platform'
  | 'add-workspace'
  | 'add-scope'
  | 'add-permission'
  | 'edit-prompt'
  | 'confirm-delete';

type EditField = 'scope' | 'permission' | 'capability' | 'auto' | 'agent' | 'prompt';

const EDIT_FIELDS: EditField[] = ['scope', 'permission', 'capability', 'auto', 'agent', 'prompt'];
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
  const accountId = binding.accountId?.trim();
  if (accountId) {
    const prefixed = `${accountId}:`;
    if (scopeLabel.toLowerCase().startsWith(prefixed.toLowerCase())) {
      return scopeLabel;
    }
    return `${accountId}:${scopeLabel}`;
  }
  return scopeLabel;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function getLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function getLineIndexForCursor(lineStarts: number[], cursor: number): number {
  for (let i = lineStarts.length - 1; i >= 0; i -= 1) {
    if (cursor >= lineStarts[i]) return i;
  }
  return 0;
}

function getLineEnd(text: string, lineStarts: number[], lineIndex: number): number {
  if (lineIndex >= lineStarts.length - 1) return text.length;
  return lineStarts[lineIndex + 1] - 1;
}

function sanitizeEditorInput(raw: string): string {
  return raw
    .replace(/\u001b\[200~/g, '')
    .replace(/\u001b\[201~/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '  ');
}

function wrapLineByWidth(line: string, width: number): string[] {
  if (width <= 0) return [line];
  if (line.length <= width) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += width) {
    out.push(line.slice(i, i + width));
  }
  return out;
}

function wrapTextForDisplay(text: string, width: number): string[] {
  const normalized = sanitizeEditorInput(text);
  return normalized.split('\n').flatMap((line) => wrapLineByWidth(line, width));
}

function platformCapability(platform: string): string {
  if (platform === 'slack') return 'Inbound auto-response + event jobs';
  if (platform === 'telegram') return 'Connection + event jobs';
  if (platform === 'whatsapp') return 'Connection + event jobs';
  return 'Connection + event jobs';
}

function parseSlackAccountPrefix(scope: string): string | undefined {
  const trimmed = scope.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^([a-z0-9._-]+):/i);
  if (!match?.[1]) return undefined;
  const prefix = match[1].toLowerCase();
  if (prefix === 'slack' || prefix === 'channel' || prefix === 'user' || prefix === 'account') {
    return undefined;
  }
  return match[1];
}

function hasSlackAccountPrefix(scope: string): boolean {
  const trimmed = scope.trim();
  if (!trimmed) return false;
  if (/^account:[a-z0-9._-]+:/i.test(trimmed)) return true;
  return Boolean(parseSlackAccountPrefix(trimmed));
}

function maybePrefixSlackAccount(scope: string, accountId: string | undefined): string {
  const trimmed = scope.trim();
  if (!trimmed || !accountId) return trimmed;
  if (hasSlackAccountPrefix(trimmed)) return trimmed;
  return `${accountId}:${trimmed}`;
}

function cycleIndex(current: number, max: number, direction: -1 | 1): number {
  if (max <= 0) return 0;
  if (direction < 0) return current <= 0 ? max - 1 : current - 1;
  return current >= max - 1 ? 0 : current + 1;
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
  onUpdateBinding,
  onRemoveBinding,
  onSetAutoRespond,
  onSetPrompt,
  onSetAgentChoice,
  onClearBehavior,
}: ChannelConfigPickerProps) {
  const [mode, setMode] = useState<PickerMode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [platformSelection, setPlatformSelection] = useState(0);
  const [pendingPlatform, setPendingPlatform] = useState<string>(PLATFORM_OPTIONS[0]);
  const [workspaceSelection, setWorkspaceSelection] = useState(0);
  const [pendingSlackAccountId, setPendingSlackAccountId] = useState<string | undefined>(undefined);
  const [scopeInput, setScopeInput] = useState('');
  const [scopeSuggestionSelection, setScopeSuggestionSelection] = useState(0);
  const [pendingScope, setPendingScope] = useState('');
  const [permissionSelection, setPermissionSelection] = useState(2);

  const [editFieldIndex, setEditFieldIndex] = useState(0);
  const [editValueMode, setEditValueMode] = useState(false);
  const [promptInput, setPromptInput] = useState('');
  const [promptCursor, setPromptCursor] = useState(0);
  const [promptPreferredCol, setPromptPreferredCol] = useState<number | null>(null);

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
  const suggestedSlackChannels = useMemo(
    () => channelsForSelectedWorkspace,
    [channelsForSelectedWorkspace],
  );
  const slackScopeSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const scopes: string[] = [];
    for (const channel of suggestedSlackChannels) {
      const next = channel.displayScope?.trim();
      if (!next || seen.has(next.toLowerCase())) continue;
      seen.add(next.toLowerCase());
      scopes.push(next);
    }
    return scopes;
  }, [suggestedSlackChannels]);

  const editableSlackScopes = useMemo(() => {
    if (!selectedRow || selectedRow.binding.platform !== 'slack') return [selectedRow?.binding.scope ?? ''];
    const accountId = selectedRow.binding.accountId ?? parseSlackAccountPrefix(selectedRow.binding.scope);
    const accountChannels = accountId ? (slackChannelsByAccount[accountId] ?? []) : [];
    const choices: string[] = [];
    const seen = new Set<string>();
    const pushChoice = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      choices.push(trimmed);
    };

    pushChoice(selectedRow.binding.scope);
    for (const channel of accountChannels) {
      pushChoice(maybePrefixSlackAccount(channel.displayScope, accountId));
    }
    if (accountId) {
      pushChoice(`${accountId}:*`);
    } else {
      pushChoice('*');
    }

    return choices;
  }, [selectedRow, slackChannelsByAccount]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedIndex(0);
      setScrollOffset(0);
      if (mode === 'edit-connection' || mode === 'confirm-delete' || mode === 'edit-prompt') {
        setMode('list');
      }
      return;
    }
    if (selectedIndex > rows.length - 1) {
      setSelectedIndex(rows.length - 1);
    }
  }, [mode, rows.length, selectedIndex]);

  useEffect(() => {
    if (mode !== 'edit-connection') {
      setEditValueMode(false);
    }
  }, [mode]);

  useEffect(() => {
    if (workspaceSelection > slackAccounts.length - 1) {
      setWorkspaceSelection(0);
    }
  }, [slackAccounts.length, workspaceSelection]);

  useEffect(() => {
    if (scopeSuggestionSelection > slackScopeSuggestions.length - 1) {
      setScopeSuggestionSelection(0);
    }
  }, [scopeSuggestionSelection, slackScopeSuggestions.length]);

  useEffect(() => {
    if (mode !== 'add-scope' || pendingPlatform !== 'slack') return;
    const normalized = scopeInput.trim().toLowerCase();
    if (!normalized) return;
    const matchIdx = slackScopeSuggestions.findIndex((candidate) => candidate.toLowerCase() === normalized);
    if (matchIdx >= 0 && matchIdx !== scopeSuggestionSelection) {
      setScopeSuggestionSelection(matchIdx);
    }
  }, [mode, pendingPlatform, scopeInput, slackScopeSuggestions, scopeSuggestionSelection]);

  const visibleRows = Math.max(3, maxHeight - 20);
  const ensureVisible = (idx: number) => {
    setScrollOffset((prev) => {
      if (idx < prev) return idx;
      if (idx >= prev + visibleRows) return idx - visibleRows + 1;
      return prev;
    });
  };

  const cycleSelectedConnection = (direction: -1 | 1) => {
    setSelectedIndex((prev) => {
      const next = direction < 0
        ? Math.max(0, prev - 1)
        : Math.min(Math.max(rows.length - 1, 0), prev + 1);
      ensureVisible(next);
      return next;
    });
  };

  const openPromptEditor = () => {
    if (!selectedRow) {
      setStatusMessage('No channel connection selected.');
      return;
    }
    setEditValueMode(false);
    const normalized = sanitizeEditorInput(selectedRow.prompt ?? '');
    setPromptInput(normalized);
    setPromptCursor(normalized.length);
    setPromptPreferredCol(null);
    setMode('edit-prompt');
  };

  const adjustEditField = (direction: -1 | 1) => {
    if (!selectedRow) {
      setStatusMessage('No channel connection selected.');
      return;
    }
    const field = EDIT_FIELDS[editFieldIndex];

    if (field === 'scope') {
      if (selectedRow.binding.platform !== 'slack') {
        setStatusMessage('Scope arrows are currently supported for Slack channel suggestions.');
        return;
      }
      if (editableSlackScopes.length <= 1) {
        setStatusMessage('No alternate Slack channels discovered for this workspace.');
        return;
      }
      const currentScope = selectedRow.binding.scope.trim().toLowerCase();
      const currentIdx = editableSlackScopes.findIndex((scope) => scope.toLowerCase() === currentScope);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, editableSlackScopes.length, direction);
      const nextScope = editableSlackScopes[nextIdx];
      onUpdateBinding(selectedRow.index, { scope: nextScope });
      setStatusMessage(`Connection #${selectedRow.index} scope: ${nextScope}.`);
      return;
    }

    if (field === 'permission') {
      const currentIdx = PERMISSION_OPTIONS.findIndex((permission) => permission === selectedRow.binding.permission);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, PERMISSION_OPTIONS.length, direction);
      const nextPermission = PERMISSION_OPTIONS[nextIdx];
      onUpdateBinding(selectedRow.index, { permission: nextPermission });
      setStatusMessage(`Connection #${selectedRow.index} permission: ${nextPermission}.`);
      return;
    }

    if (field === 'capability') {
      const currentIdx = PLATFORM_OPTIONS.findIndex((platform) => platform === selectedRow.binding.platform);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, PLATFORM_OPTIONS.length, direction);
      const nextPlatform = PLATFORM_OPTIONS[nextIdx];
      onUpdateBinding(selectedRow.index, { platform: nextPlatform });
      setStatusMessage(
        `Connection #${selectedRow.index} capability: ${platformCapability(nextPlatform)} (${nextPlatform}).`,
      );
      return;
    }

    if (field === 'auto') {
      const nextEnabled = direction < 0;
      if (selectedRow.autoRespond !== nextEnabled) {
        onSetAutoRespond(selectedRow.index, nextEnabled);
      }
      setStatusMessage(`Connection #${selectedRow.index} auto-response ${nextEnabled ? 'enabled' : 'disabled'}.`);
      return;
    }

    if (field === 'agent') {
      const choices: Array<string | undefined> = [undefined, ...agents.map((agent) => agent.name)];
      const currentIdx = selectedRow.agentName
        ? choices.findIndex((choice) => choice?.toLowerCase() === selectedRow.agentName?.toLowerCase())
        : 0;
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, choices.length, direction);
      const nextChoice = choices[nextIdx];
      onSetAgentChoice(selectedRow.index, nextChoice);
      setStatusMessage(`Connection #${selectedRow.index} responder: ${nextChoice ?? '(default primary)'}.`);
      return;
    }

    if (field === 'prompt') {
      setStatusMessage('Press Enter to edit prompt text.');
    }
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

    if (mode === 'edit-prompt') {
      if (key.escape) {
        setMode('edit-connection');
        setPromptPreferredCol(null);
        return;
      }
      if (key.ctrl && input.toLowerCase() === 's') {
        const trimmed = sanitizeEditorInput(promptInput).trim();
        if (!selectedRow) {
          setMode('list');
          return;
        }
        if (!trimmed) {
          setStatusMessage('Prompt cannot be empty. Use "c" to clear response settings.');
          return;
        }
        onSetPrompt(selectedRow.index, trimmed);
        setStatusMessage(`Updated prompt for connection #${selectedRow.index}.`);
        setMode('edit-connection');
        setPromptPreferredCol(null);
        return;
      }
      if (key.return) {
        const next = `${promptInput.slice(0, promptCursor)}\n${promptInput.slice(promptCursor)}`;
        setPromptInput(next);
        setPromptCursor(promptCursor + 1);
        setPromptPreferredCol(null);
        return;
      }
      if (key.backspace) {
        if (promptCursor <= 0) return;
        const next = `${promptInput.slice(0, promptCursor - 1)}${promptInput.slice(promptCursor)}`;
        setPromptInput(next);
        setPromptCursor(promptCursor - 1);
        setPromptPreferredCol(null);
        return;
      }
      if (key.delete) {
        if (promptCursor >= promptInput.length) return;
        const next = `${promptInput.slice(0, promptCursor)}${promptInput.slice(promptCursor + 1)}`;
        setPromptInput(next);
        setPromptPreferredCol(null);
        return;
      }
      if (key.leftArrow) {
        setPromptCursor((prev) => Math.max(0, prev - 1));
        setPromptPreferredCol(null);
        return;
      }
      if (key.rightArrow) {
        setPromptCursor((prev) => Math.min(promptInput.length, prev + 1));
        setPromptPreferredCol(null);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const starts = getLineStarts(promptInput);
        const lineIdx = getLineIndexForCursor(starts, promptCursor);
        const lineStart = starts[lineIdx] ?? 0;
        const currentCol = promptCursor - lineStart;
        const preferred = promptPreferredCol ?? currentCol;
        const targetLineIdx = key.upArrow ? lineIdx - 1 : lineIdx + 1;
        if (targetLineIdx < 0 || targetLineIdx >= starts.length) return;
        const targetStart = starts[targetLineIdx] ?? 0;
        const targetEnd = getLineEnd(promptInput, starts, targetLineIdx);
        setPromptCursor(Math.min(targetStart + preferred, targetEnd));
        setPromptPreferredCol(preferred);
        return;
      }
      if (input) {
        const safeInput = sanitizeEditorInput(input);
        if (!safeInput) return;
        const next = `${promptInput.slice(0, promptCursor)}${safeInput}${promptInput.slice(promptCursor)}`;
        setPromptInput(next);
        setPromptCursor(promptCursor + safeInput.length);
        setPromptPreferredCol(null);
      }
      return;
    }

    if (mode === 'add-scope') {
      if (pendingPlatform === 'slack' && key.upArrow && slackScopeSuggestions.length > 0) {
        const next = cycleIndex(scopeSuggestionSelection, slackScopeSuggestions.length, -1);
        setScopeSuggestionSelection(next);
        setScopeInput(slackScopeSuggestions[next] ?? '');
        return;
      }
      if (pendingPlatform === 'slack' && key.downArrow && slackScopeSuggestions.length > 0) {
        const next = cycleIndex(scopeSuggestionSelection, slackScopeSuggestions.length, 1);
        setScopeSuggestionSelection(next);
        setScopeInput(slackScopeSuggestions[next] ?? '');
        return;
      }
      if (input === 'r') {
        onRefreshSlackHints();
        setStatusMessage('Refreshing Slack workspaces/channels...');
        return;
      }
      return;
    }

    if (mode === 'list') {
      if (key.upArrow) {
        cycleSelectedConnection(-1);
        return;
      }
      if (key.downArrow) {
        cycleSelectedConnection(1);
        return;
      }
      if (key.return) {
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        setEditFieldIndex(0);
        setEditValueMode(false);
        setMode('edit-connection');
        return;
      }
      if (input === 'a') {
        setPlatformSelection(0);
        setPendingPlatform(PLATFORM_OPTIONS[0]);
        setPendingSlackAccountId(undefined);
        setScopeInput('');
        setScopeSuggestionSelection(0);
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
        openPromptEditor();
        return;
      }
      if (input === 'c') {
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        onClearBehavior(selectedRow.index);
        setStatusMessage(`Cleared response settings for connection #${selectedRow.index}.`);
      }
      return;
    }

    if (mode === 'edit-connection') {
      if (key.leftArrow) {
        if (editValueMode) {
          setStatusMessage('Press Enter to stop editing this field first.');
          return;
        }
        setEditFieldIndex((prev) => cycleIndex(prev, EDIT_FIELDS.length, -1));
        return;
      }
      if (key.rightArrow) {
        if (editValueMode) {
          setStatusMessage('Press Enter to stop editing this field first.');
          return;
        }
        setEditFieldIndex((prev) => cycleIndex(prev, EDIT_FIELDS.length, 1));
        return;
      }
      if (key.upArrow) {
        if (editValueMode) {
          adjustEditField(-1);
        } else {
          setEditFieldIndex((prev) => cycleIndex(prev, EDIT_FIELDS.length, -1));
        }
        return;
      }
      if (key.downArrow) {
        if (editValueMode) {
          adjustEditField(1);
        } else {
          setEditFieldIndex((prev) => cycleIndex(prev, EDIT_FIELDS.length, 1));
        }
        return;
      }
      if (key.return) {
        const field = EDIT_FIELDS[editFieldIndex];
        if (field === 'prompt') {
          openPromptEditor();
          return;
        }
        if (editValueMode) {
          setEditValueMode(false);
          setStatusMessage(`Stopped editing ${field}.`);
        } else {
          setEditValueMode(true);
          setStatusMessage(`Editing ${field}. Use ↑/↓ to change value, Enter when done.`);
        }
        return;
      }
      if (input === 'p') {
        openPromptEditor();
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
      if (input === 'c') {
        if (!selectedRow) {
          setStatusMessage('No channel connection selected.');
          return;
        }
        onClearBehavior(selectedRow.index);
        setStatusMessage(`Cleared response settings for connection #${selectedRow.index}.`);
        return;
      }
      if (input === 'r') {
        onRefreshSlackHints();
        setStatusMessage('Refreshing Slack workspaces/channels...');
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
        setScopeSuggestionSelection(0);
        setMode('add-scope');
      }
      return;
    }

    if (mode === 'add-workspace') {
      if (slackAccounts.length === 0) {
        setPendingSlackAccountId(undefined);
        setScopeInput('#');
        setScopeSuggestionSelection(0);
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
        const knownChannels = chosen?.id ? (slackChannelsByAccount[chosen.id] ?? []) : [];
        const firstScope = knownChannels[0]?.displayScope ?? '#';
        setScopeInput(firstScope);
        setScopeSuggestionSelection(0);
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
  const activeEditField = EDIT_FIELDS[editFieldIndex];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={terminalWidth}>
      <Text bold color="cyan">Channel Config</Text>
      <Text dimColor>Workflow: add connection, then tune how that channel responds.</Text>

      {mode === 'list' && (
        <>
          <Text dimColor>↑/↓ select connection  Enter edit  a add  d delete  p prompt  c clear  r refresh Slack  Esc/^B close</Text>
          <Box height={1} />

          <Text bold color="cyan">Connections</Text>
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
              <Text>  auto-response: {selectedRow.autoRespond ? 'on' : 'off'}</Text>
              <Text>  responder agent: {selectedRow.agentName ?? '(default primary)'}</Text>
              <Text>  prompt:</Text>
              {wrapTextForDisplay(selectedRow.prompt || '(none)', Math.max(10, terminalWidth - 8)).map((line, idx) => (
                <Text key={`prompt-line-${idx}`} dimColor>
                  {'    '}
                  {line || ' '}
                </Text>
              ))}
            </>
          ) : (
            <Text dimColor>  No connection selected.</Text>
          )}
        </>
      )}

      {mode === 'edit-connection' && (
        <>
          <Box height={1} />
          <Text bold color="cyan">Edit Connection #{selectedRow?.index ?? '?'}</Text>
          <Text dimColor>
            {editValueMode
              ? 'Value mode: ↑/↓ change value  Enter done  Esc back'
              : 'Field mode: ↑/↓ choose field  Enter edit field  ←/→ choose field  Esc back'}
          </Text>
          {selectedRow ? (
            <>
              <Text color={activeEditField === 'scope' ? 'cyan' : undefined}>
                {activeEditField === 'scope' ? '▸ ' : '  '}
                scope: {formatBindingScopeLabel(selectedRow.binding)}
              </Text>
              <Text color={activeEditField === 'permission' ? 'cyan' : undefined}>
                {activeEditField === 'permission' ? '▸ ' : '  '}
                permission: {selectedRow.binding.permission}
              </Text>
              <Text color={activeEditField === 'capability' ? 'cyan' : undefined}>
                {activeEditField === 'capability' ? '▸ ' : '  '}
                capability: {platformCapability(selectedRow.binding.platform)}
              </Text>
              <Text color={activeEditField === 'auto' ? 'cyan' : undefined}>
                {activeEditField === 'auto' ? '▸ ' : '  '}
                auto-response: {selectedRow.autoRespond ? 'on' : 'off'}
              </Text>
              <Text color={activeEditField === 'agent' ? 'cyan' : undefined}>
                {activeEditField === 'agent' ? '▸ ' : '  '}
                responder agent: {selectedRow.agentName ?? '(default primary)'}
              </Text>
              <Text color={activeEditField === 'prompt' ? 'cyan' : undefined}>
                {activeEditField === 'prompt' ? '▸ ' : '  '}
                prompt: {selectedRow.prompt ? truncate(selectedRow.prompt, Math.max(30, terminalWidth - 20)) : '(none)'}
              </Text>
              {selectedRow.binding.platform === 'slack' && editableSlackScopes.length > 1 && (
                <Text dimColor>Slack scopes discovered for arrows: {editableSlackScopes.length}</Text>
              )}
              {activeEditField === 'agent' && agents.length === 0 && (
                <Text dimColor>No agents configured; default primary responder is used.</Text>
              )}
            </>
          ) : (
            <Text dimColor>No selected connection.</Text>
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
              {suggestedSlackChannels.length > 0 ? (
                <>
                  <Text>Known channels for this workspace:</Text>
                  {suggestedSlackChannels.map((channel, idx) => (
                    <Text key={channel.id} color={idx === scopeSuggestionSelection ? 'cyan' : undefined}>
                      {idx === scopeSuggestionSelection ? '▸ ' : '  '}
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
                const typed = value.trim();
                const fallbackScope = pendingPlatform === 'slack'
                  ? slackScopeSuggestions[scopeSuggestionSelection] ?? ''
                  : '';
                const resolvedScope = typed || fallbackScope;
                if (!resolvedScope) {
                  setStatusMessage('Scope cannot be empty.');
                  return;
                }
                const finalScope = pendingPlatform === 'slack'
                  ? maybePrefixSlackAccount(resolvedScope, pendingSlackAccountId)
                  : resolvedScope;
                setPendingScope(finalScope);
                setPermissionSelection(2);
                setMode('add-permission');
              }}
            />
          </Box>
          <Text dimColor>↑/↓ pick channel  Enter continue  Esc cancel</Text>
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
          <Text dimColor>Multi-line editor (paste supported). Ctrl+S save  Enter newline  Esc cancel</Text>
          <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
            {wrapTextForDisplay(promptInput.slice(0, promptCursor) + '█' + promptInput.slice(promptCursor), Math.max(10, terminalWidth - 8)).map((line, idx) => (
              <Text key={`editor-line-${idx}`}>{line || ' '}</Text>
            ))}
          </Box>
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
