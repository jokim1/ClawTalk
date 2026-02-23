/**
 * Channel Config Picker
 *
 * Keyboard-first modal for configuring talk channel bindings and response behavior.
 * Delegates rendering to ChannelListView, ChannelEditView, and ChannelAddFlow.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PlatformBehavior, PlatformBinding, PlatformPermission, TalkAgent } from '../../types.js';
import type { SlackAccountOption, SlackChannelOption, SlackProxySetupStatus } from '../../services/chat.js';
import { formatBindingScopeLabel, formatPostingPriority, toDeliveryMode } from '../formatters.js';
import type { PostingPriority } from '../formatters.js';
import { ChannelListView, ChannelConfirmDelete } from './ChannelListView.js';
import type { ChannelRow } from './ChannelListView.js';
import { ChannelEditConnection, ChannelEditPrompt } from './ChannelEditView.js';
import { ChannelAddFlow } from './ChannelAddFlow.js';
import type { ChannelAddResult } from './ChannelAddFlow.js';

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
  onSetResponseMode: (index: number, mode: 'off' | 'mentions' | 'all') => void;
  onSetMirrorToTalk: (index: number, mode: 'off' | 'inbound' | 'full') => void;
  onSetDeliveryMode: (index: number, mode: 'thread' | 'channel' | 'adaptive') => void;
  onSetPrompt: (index: number, prompt: string) => void;
  onSetAgentChoice: (index: number, agentName?: string) => void;
  onClearBehavior: (index: number) => void;
  onCheckSlackProxySetup?: () => Promise<SlackProxySetupStatus | null>;
  onSaveSlackSigningSecret?: (secret: string) => Promise<{ ok: boolean; error?: string }>;
  onTabLeft?: () => void;
  onTabRight?: () => void;
  embedded?: boolean;
}

type PickerMode = 'list' | 'edit-connection' | 'edit-prompt' | 'confirm-delete' | 'adding';

type EditField = 'scope' | 'permission' | 'response' | 'posting' | 'mirror' | 'agent' | 'prompt';
const EDIT_FIELDS: EditField[] = ['scope', 'permission', 'response', 'posting', 'mirror', 'agent', 'prompt'];
const PERMISSION_OPTIONS: PlatformPermission[] = ['read', 'write', 'read+write'];
const RESPONSE_MODE_OPTIONS: Array<'off' | 'mentions' | 'all'> = ['off', 'mentions', 'all'];
const MIRROR_TO_TALK_OPTIONS: Array<'off' | 'inbound' | 'full'> = ['off', 'inbound', 'full'];
const POSTING_PRIORITY_OPTIONS: PostingPriority[] = ['adaptive', 'channel', 'reply'];

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

function maybePrefixSlackAccount(scope: string, accountId: string | undefined): string {
  const trimmed = scope.trim();
  if (!trimmed || !accountId) return trimmed;
  // Check for existing account prefix
  const existing = parseSlackAccountPrefix(trimmed);
  if (existing) return trimmed;
  if (/^account:[a-z0-9._-]+:/i.test(trimmed)) return trimmed;
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
  onSetResponseMode,
  onSetMirrorToTalk,
  onSetDeliveryMode,
  onSetPrompt,
  onSetAgentChoice,
  onClearBehavior,
  onCheckSlackProxySetup,
  onSaveSlackSigningSecret,
  onTabLeft,
  onTabRight,
  embedded,
}: ChannelConfigPickerProps) {
  const [mode, setMode] = useState<PickerMode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [editFieldIndex, setEditFieldIndex] = useState(0);
  const [editValueMode, setEditValueMode] = useState(false);

  const behaviorByBindingId = new Map<string, PlatformBehavior>();
  for (const behavior of behaviors) {
    behaviorByBindingId.set(behavior.platformBindingId, behavior);
  }

  const rows: ChannelRow[] = bindings.map((binding, idx) => {
    const behavior = behaviorByBindingId.get(binding.id);
    return {
      index: idx + 1,
      binding,
      responseMode: behavior?.responseMode ?? (behavior?.autoRespond === false ? 'off' : 'all'),
      deliveryMode: behavior?.deliveryMode ?? 'adaptive',
      mirrorToTalk: behavior?.mirrorToTalk ?? 'off',
      agentName: behavior?.agentName,
      prompt: behavior?.onMessagePrompt,
    };
  });

  const selectedRow = rows[selectedIndex];

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
    if (accountId) { pushChoice(`${accountId}:*`); } else { pushChoice('*'); }
    return choices;
  }, [selectedRow, slackChannelsByAccount]);

  // --- Effects ---

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
    if (mode !== 'edit-connection') setEditValueMode(false);
  }, [mode]);

  const visibleRows = Math.max(3, maxHeight - 20);
  const ensureVisible = (idx: number) => {
    setScrollOffset((prev) => {
      if (idx < prev) return idx;
      if (idx >= prev + visibleRows) return idx - visibleRows + 1;
      return prev;
    });
  };

  useEffect(() => {
    if (mode !== 'list' || rows.length === 0) return;
    const maxIdx = rows.length - 1;
    const idx = Math.max(0, Math.min(selectedIndex, maxIdx));
    setScrollOffset((prev) => {
      if (idx < prev) return idx;
      if (idx >= prev + visibleRows) return idx - visibleRows + 1;
      return prev;
    });
  }, [mode, rows.length, selectedIndex, visibleRows]);

  // --- Helpers ---

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
    if (!selectedRow) { setStatusMessage('No channel connection selected.'); return; }
    setEditValueMode(false);
    setMode('edit-prompt');
  };

  const adjustEditField = (direction: -1 | 1) => {
    if (!selectedRow) { setStatusMessage('No channel connection selected.'); return; }
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
      const currentIdx = editableSlackScopes.findIndex((s) => s.toLowerCase() === currentScope);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, editableSlackScopes.length, direction);
      onUpdateBinding(selectedRow.index, { scope: editableSlackScopes[nextIdx] });
      setStatusMessage(`Connection #${selectedRow.index} scope: ${editableSlackScopes[nextIdx]}.`);
      return;
    }
    if (field === 'permission') {
      const currentIdx = PERMISSION_OPTIONS.findIndex((p) => p === selectedRow.binding.permission);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, PERMISSION_OPTIONS.length, direction);
      onUpdateBinding(selectedRow.index, { permission: PERMISSION_OPTIONS[nextIdx] });
      setStatusMessage(`Connection #${selectedRow.index} permission: ${PERMISSION_OPTIONS[nextIdx]}.`);
      return;
    }
    if (field === 'response') {
      const currentIdx = RESPONSE_MODE_OPTIONS.findIndex((m) => m === selectedRow.responseMode);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, RESPONSE_MODE_OPTIONS.length, direction);
      const nextMode = RESPONSE_MODE_OPTIONS[nextIdx];
      if (selectedRow.responseMode !== nextMode) onSetResponseMode(selectedRow.index, nextMode);
      setStatusMessage(`Connection #${selectedRow.index} response mode: ${nextMode}.`);
      return;
    }
    if (field === 'mirror') {
      if (selectedRow.binding.platform !== 'slack') {
        setStatusMessage('Slack Message Mirroring applies to Slack connections only.');
        return;
      }
      const currentIdx = MIRROR_TO_TALK_OPTIONS.findIndex((m) => m === selectedRow.mirrorToTalk);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, MIRROR_TO_TALK_OPTIONS.length, direction);
      const nextMode = MIRROR_TO_TALK_OPTIONS[nextIdx];
      if (selectedRow.mirrorToTalk !== nextMode) onSetMirrorToTalk(selectedRow.index, nextMode);
      setStatusMessage(`Connection #${selectedRow.index} Slack Message Mirroring: ${nextMode}.`);
      return;
    }
    if (field === 'posting') {
      if (selectedRow.binding.platform !== 'slack') {
        setStatusMessage('Posting Priority applies to Slack connections only.');
        return;
      }
      const currentPriority = formatPostingPriority(selectedRow.deliveryMode);
      const currentIdx = POSTING_PRIORITY_OPTIONS.findIndex((m) => m === currentPriority);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, POSTING_PRIORITY_OPTIONS.length, direction);
      const nextPriority = POSTING_PRIORITY_OPTIONS[nextIdx];
      const nextMode = toDeliveryMode(nextPriority);
      if (selectedRow.deliveryMode !== nextMode) onSetDeliveryMode(selectedRow.index, nextMode);
      setStatusMessage(`Connection #${selectedRow.index} Posting Priority: ${nextPriority}.`);
      return;
    }
    if (field === 'agent') {
      const choices: Array<string | undefined> = [undefined, ...agents.map((a) => a.name)];
      const currentIdx = selectedRow.agentName
        ? choices.findIndex((c) => c?.toLowerCase() === selectedRow.agentName?.toLowerCase())
        : 0;
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, choices.length, direction);
      onSetAgentChoice(selectedRow.index, choices[nextIdx]);
      setStatusMessage(`Connection #${selectedRow.index} responder: ${choices[nextIdx] ?? '(default primary)'}.`);
      return;
    }
    if (field === 'prompt') {
      setStatusMessage('Press Enter to edit Response Prompt text.');
    }
  };

  // --- Keyboard input ---

  useInput((input, key) => {
    // ChannelAddFlow and PromptEditor handle their own input
    if (mode === 'adding' || mode === 'edit-prompt') {
      return;
    }

    if (key.escape) {
      if (mode === 'list') onClose();
      else setMode('list');
      return;
    }

    if (mode === 'list') {
      if (key.leftArrow) { onTabLeft?.(); return; }
      if (key.rightArrow) { onTabRight?.(); return; }
      if (key.upArrow) { cycleSelectedConnection(-1); return; }
      if (key.downArrow) { cycleSelectedConnection(1); return; }
      if (key.return) {
        if (!selectedRow) { setStatusMessage('No channel connection selected.'); return; }
        setEditFieldIndex(0); setEditValueMode(false); setMode('edit-connection');
        return;
      }
      if (input === 'a') { setMode('adding'); return; }
      if (input === 'r') { onRefreshSlackHints(); setStatusMessage('Refreshing Slack workspaces/channels...'); return; }
      if (input === 'd') {
        if (!selectedRow) { setStatusMessage('No channel connection selected.'); return; }
        setMode('confirm-delete');
        return;
      }
      if (input === 't') {
        if (!selectedRow) { setStatusMessage('No channel connection selected.'); return; }
        const nextMode = selectedRow.responseMode === 'off' ? 'all' : 'off';
        onSetResponseMode(selectedRow.index, nextMode);
        setStatusMessage(`Connection #${selectedRow.index} response mode: ${nextMode}.`);
        return;
      }
      if (input === 'p') { openPromptEditor(); return; }
      if (input === 'c') {
        if (!selectedRow) { setStatusMessage('No channel connection selected.'); return; }
        onClearBehavior(selectedRow.index);
        setStatusMessage(`Cleared response settings for connection #${selectedRow.index}.`);
      }
      return;
    }

    if (mode === 'edit-connection') {
      if (key.leftArrow) {
        if (editValueMode) { setStatusMessage('Press Enter to stop editing this field first.'); return; }
        setEditFieldIndex((prev) => cycleIndex(prev, EDIT_FIELDS.length, -1));
        return;
      }
      if (key.rightArrow) {
        if (editValueMode) { setStatusMessage('Press Enter to stop editing this field first.'); return; }
        setEditFieldIndex((prev) => cycleIndex(prev, EDIT_FIELDS.length, 1));
        return;
      }
      if (key.upArrow) {
        if (editValueMode) adjustEditField(-1);
        else setEditFieldIndex((prev) => cycleIndex(prev, EDIT_FIELDS.length, -1));
        return;
      }
      if (key.downArrow) {
        if (editValueMode) adjustEditField(1);
        else setEditFieldIndex((prev) => cycleIndex(prev, EDIT_FIELDS.length, 1));
        return;
      }
      if (key.return) {
        const field = EDIT_FIELDS[editFieldIndex];
        if (field === 'prompt') { openPromptEditor(); return; }
        if (editValueMode) { setEditValueMode(false); setStatusMessage(`Stopped editing ${field}.`); }
        else { setEditValueMode(true); setStatusMessage(`Editing ${field}. Use \u2191/\u2193 to change value, Enter when done.`); }
        return;
      }
      if (input === 'p') { openPromptEditor(); return; }
      if (input === 'd') {
        if (!selectedRow) { setStatusMessage('No channel connection selected.'); return; }
        setMode('confirm-delete');
        return;
      }
      if (input === 'c') {
        if (!selectedRow) { setStatusMessage('No channel connection selected.'); return; }
        onClearBehavior(selectedRow.index);
        setStatusMessage(`Cleared response settings for connection #${selectedRow.index}.`);
        return;
      }
      if (input === 'r') { onRefreshSlackHints(); setStatusMessage('Refreshing Slack workspaces/channels...'); return; }
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
      if (input.toLowerCase() === 'n') setMode('list');
    }
  });

  // --- Add flow callbacks ---

  const handleAddComplete = (result: ChannelAddResult) => {
    const newZeroBasedIndex = rows.length;
    onAddBinding(result.platform, result.scope, result.permission);
    onSetResponseMode(newZeroBasedIndex + 1, result.responseMode);
    if (result.platform === 'slack') {
      onSetDeliveryMode(newZeroBasedIndex + 1, result.deliveryMode);
    }
    if (result.prompt) onSetPrompt(newZeroBasedIndex + 1, result.prompt);
    setMode('list');
    setSelectedIndex(newZeroBasedIndex);
    ensureVisible(newZeroBasedIndex);
    setStatusMessage(`Added ${result.platform} ${result.scope} (${result.permission}).`);
  };

  const handleAddCancel = () => { setMode('list'); };

  // --- Rendering ---

  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(rows.length, scrollOffset + visibleRows);
  const activeEditField = EDIT_FIELDS[editFieldIndex];
  const promptEditorWidth = Math.max(10, terminalWidth - 12);
  const promptEditorMaxLines = Math.max(4, Math.min(14, maxHeight - 24));

  return (
    <Box flexDirection="column" {...(embedded ? {} : { borderStyle: 'round' as const, borderColor: 'cyan', paddingX: 1, width: terminalWidth })}>
      {!embedded && (
        <>
          <Text bold color="cyan">Channel Config</Text>
          <Text dimColor>
            Channels are specific external messaging platforms like Slack, Telegram, Discord, etc. that you can configure ClawTalk agents to interact with.
          </Text>
          <Box height={1} />
        </>
      )}
      <Text dimColor>Workflow: configure all fields, review, then save.</Text>

      {mode === 'list' && (
        <ChannelListView
          rows={rows}
          selectedIndex={selectedIndex}
          visibleStart={visibleStart}
          visibleEnd={visibleEnd}
          terminalWidth={terminalWidth}
        />
      )}

      {mode === 'edit-connection' && (
        <ChannelEditConnection
          selectedRow={selectedRow}
          activeEditField={activeEditField}
          editValueMode={editValueMode}
          editableSlackScopes={editableSlackScopes}
          agents={agents}
          terminalWidth={terminalWidth}
        />
      )}

      {mode === 'edit-prompt' && (
        <ChannelEditPrompt
          selectedRow={selectedRow}
          editorWidth={promptEditorWidth}
          maxVisibleLines={promptEditorMaxLines}
          onSave={(text) => {
            const trimmed = text.trim();
            if (!selectedRow) { setMode('list'); return; }
            if (!trimmed) {
              setStatusMessage('Prompt cannot be empty. Use "c" to clear response settings.');
              return;
            }
            onSetPrompt(selectedRow.index, trimmed);
            setStatusMessage(`Updated prompt for connection #${selectedRow.index}.`);
            setMode('edit-connection');
          }}
          onCancel={() => setMode('edit-connection')}
        />
      )}

      {mode === 'adding' && (
        <ChannelAddFlow
          maxHeight={maxHeight}
          terminalWidth={terminalWidth}
          slackAccounts={slackAccounts}
          slackChannelsByAccount={slackChannelsByAccount}
          slackHintsLoading={slackHintsLoading}
          slackHintsError={slackHintsError}
          onRefreshSlackHints={onRefreshSlackHints}
          onComplete={handleAddComplete}
          onCancel={handleAddCancel}
          onCheckSlackProxySetup={onCheckSlackProxySetup}
          onSaveSlackSigningSecret={onSaveSlackSigningSecret}
        />
      )}

      {mode === 'confirm-delete' && (
        <ChannelConfirmDelete rowIndex={selectedRow?.index} />
      )}

      {mode !== 'adding' && statusMessage && (
        <>
          <Box height={1} />
          <Text color="green">{statusMessage}</Text>
        </>
      )}
    </Box>
  );
}
