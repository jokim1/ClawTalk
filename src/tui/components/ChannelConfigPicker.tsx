/**
 * Channel Config Picker
 *
 * Keyboard-first modal for configuring talk channel bindings and response behavior.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { PlatformBehavior, PlatformBinding, PlatformPermission, TalkAgent } from '../../types';
import type { SlackAccountOption, SlackChannelOption, SlackProxySetupStatus } from '../../services/chat';
import {
  buildVisualLayout,
  computeVisibleWindow,
  moveCursorByVisualRow,
  sanitizePromptInput,
  wrapForTerminal,
} from './promptEditorUtils.js';

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
}

type PickerMode =
  | 'list'
  | 'edit-connection'
  | 'add-platform'
  | 'add-workspace'
  | 'slack-proxy-setup'
  | 'add-scope'
  | 'add-permission'
  | 'add-response'
  | 'add-posting'
  | 'add-prompt'
  | 'add-review'
  | 'edit-prompt'
  | 'confirm-delete';

type EditField = 'scope' | 'permission' | 'response' | 'posting' | 'mirror' | 'agent' | 'prompt';

const EDIT_FIELDS: EditField[] = ['scope', 'permission', 'response', 'posting', 'mirror', 'agent', 'prompt'];
const PLATFORM_OPTIONS = ['slack', 'telegram', 'whatsapp'] as const;
const PERMISSION_OPTIONS: PlatformPermission[] = ['read', 'write', 'read+write'];
const RESPONSE_MODE_OPTIONS: Array<'off' | 'mentions' | 'all'> = ['off', 'mentions', 'all'];
const MIRROR_TO_TALK_OPTIONS: Array<'off' | 'inbound' | 'full'> = ['off', 'inbound', 'full'];
type PostingPriorityOption = 'adaptive' | 'channel' | 'reply';
const POSTING_PRIORITY_OPTIONS: PostingPriorityOption[] = ['adaptive', 'channel', 'reply'];

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

function toPostingPriority(mode: 'thread' | 'channel' | 'adaptive' | undefined): PostingPriorityOption {
  if (mode === 'channel') return 'channel';
  if (mode === 'thread') return 'reply';
  return 'adaptive';
}

function toDeliveryMode(priority: PostingPriorityOption): 'thread' | 'channel' | 'adaptive' {
  if (priority === 'channel') return 'channel';
  if (priority === 'reply') return 'thread';
  return 'adaptive';
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
}: ChannelConfigPickerProps) {
  const [mode, setMode] = useState<PickerMode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Slack proxy setup state
  const [proxySetupStatus, setProxySetupStatus] = useState<SlackProxySetupStatus | null>(null);
  const [proxySetupLoading, setProxySetupLoading] = useState(false);
  const [signingSecretInput, setSigningSecretInput] = useState('');
  const [signingSecretSaving, setSigningSecretSaving] = useState(false);
  const [proxySetupError, setProxySetupError] = useState<string | null>(null);

  const [platformSelection, setPlatformSelection] = useState(0);
  const [pendingPlatform, setPendingPlatform] = useState<string>(PLATFORM_OPTIONS[0]);
  const [workspaceSelection, setWorkspaceSelection] = useState(0);
  const [pendingSlackAccountId, setPendingSlackAccountId] = useState<string | undefined>(undefined);
  const [scopeInput, setScopeInput] = useState('');
  const [scopeSuggestionSelection, setScopeSuggestionSelection] = useState(0);
  const [scopeSuggestionPage, setScopeSuggestionPage] = useState(0);
  const [pendingScope, setPendingScope] = useState('');
  const [permissionSelection, setPermissionSelection] = useState(2);
  const [pendingPermission, setPendingPermission] = useState<PlatformPermission>('read+write');
  const [responseSelection, setResponseSelection] = useState(2);
  const [pendingResponseMode, setPendingResponseMode] = useState<'off' | 'mentions' | 'all'>('all');
  const [deliverySelection, setDeliverySelection] = useState(0);
  const [pendingDeliveryMode, setPendingDeliveryMode] = useState<'thread' | 'channel' | 'adaptive'>('adaptive');
  const [pendingPrompt, setPendingPrompt] = useState('');

  const [editFieldIndex, setEditFieldIndex] = useState(0);
  const [editValueMode, setEditValueMode] = useState(false);
  const [promptInput, setPromptInput] = useState('');
  const [promptCursor, setPromptCursor] = useState(0);
  const [promptPreferredCol, setPromptPreferredCol] = useState<number | null>(null);

  const behaviorByBindingId = new Map<string, PlatformBehavior>();
  for (const behavior of behaviors) {
    behaviorByBindingId.set(behavior.platformBindingId, behavior);
  }

  const rows = bindings.map((binding, idx) => {
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
  const selectedWorkspace = slackAccounts[workspaceSelection];
  const channelsForSelectedWorkspace = pendingSlackAccountId
    ? (slackChannelsByAccount[pendingSlackAccountId] ?? [])
    : [];
  const suggestedSlackChannels = useMemo(
    () => [...channelsForSelectedWorkspace].sort((a, b) => {
      const aDisplay = (a.displayScope ?? '').trim();
      const bDisplay = (b.displayScope ?? '').trim();
      const byDisplay = aDisplay.localeCompare(bDisplay, undefined, { sensitivity: 'base' });
      if (byDisplay !== 0) return byDisplay;
      const byScope = (a.scope ?? '').localeCompare((b.scope ?? ''), undefined, { sensitivity: 'base' });
      if (byScope !== 0) return byScope;
      return (a.id ?? '').localeCompare((b.id ?? ''), undefined, { sensitivity: 'base' });
    }),
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

  const scopeSuggestionPageSize = Math.max(4, maxHeight - 29);
  const scopeSuggestionPageCount = Math.max(1, Math.ceil(slackScopeSuggestions.length / scopeSuggestionPageSize));

  useEffect(() => {
    if (scopeSuggestionPage > scopeSuggestionPageCount - 1) {
      setScopeSuggestionPage(0);
    }
  }, [scopeSuggestionPage, scopeSuggestionPageCount]);

  useEffect(() => {
    if (mode !== 'add-scope' || pendingPlatform !== 'slack') return;
    if (slackScopeSuggestions.length === 0) {
      if (scopeSuggestionPage !== 0) setScopeSuggestionPage(0);
      return;
    }
    const targetPage = Math.floor(scopeSuggestionSelection / scopeSuggestionPageSize);
    if (targetPage !== scopeSuggestionPage) {
      setScopeSuggestionPage(targetPage);
    }
  }, [
    mode,
    pendingPlatform,
    scopeSuggestionSelection,
    scopeSuggestionPageSize,
    scopeSuggestionPage,
    slackScopeSuggestions.length,
  ]);

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
    const normalized = sanitizePromptInput(selectedRow.prompt ?? '');
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

    if (field === 'response') {
      const currentIdx = RESPONSE_MODE_OPTIONS.findIndex((mode) => mode === selectedRow.responseMode);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, RESPONSE_MODE_OPTIONS.length, direction);
      const nextMode = RESPONSE_MODE_OPTIONS[nextIdx];
      if (selectedRow.responseMode !== nextMode) {
        onSetResponseMode(selectedRow.index, nextMode);
      }
      setStatusMessage(`Connection #${selectedRow.index} response mode: ${nextMode}.`);
      return;
    }

    if (field === 'mirror') {
      if (selectedRow.binding.platform !== 'slack') {
        setStatusMessage('Slack Message Mirroring applies to Slack connections only.');
        return;
      }
      const currentIdx = MIRROR_TO_TALK_OPTIONS.findIndex((mode) => mode === selectedRow.mirrorToTalk);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, MIRROR_TO_TALK_OPTIONS.length, direction);
      const nextMode = MIRROR_TO_TALK_OPTIONS[nextIdx];
      if (selectedRow.mirrorToTalk !== nextMode) {
        onSetMirrorToTalk(selectedRow.index, nextMode);
      }
      setStatusMessage(`Connection #${selectedRow.index} Slack Message Mirroring: ${nextMode}.`);
      return;
    }

    if (field === 'posting') {
      if (selectedRow.binding.platform !== 'slack') {
        setStatusMessage('Posting Priority applies to Slack connections only.');
        return;
      }
      const currentPriority = toPostingPriority(selectedRow.deliveryMode);
      const currentIdx = POSTING_PRIORITY_OPTIONS.findIndex((mode) => mode === currentPriority);
      const nextIdx = cycleIndex(currentIdx >= 0 ? currentIdx : 0, POSTING_PRIORITY_OPTIONS.length, direction);
      const nextPriority = POSTING_PRIORITY_OPTIONS[nextIdx];
      const nextMode = toDeliveryMode(nextPriority);
      if (selectedRow.deliveryMode !== nextMode) {
        onSetDeliveryMode(selectedRow.index, nextMode);
      }
      setStatusMessage(`Connection #${selectedRow.index} Posting Priority: ${nextPriority}.`);
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
      setStatusMessage('Press Enter to edit Response Prompt text.');
    }
  };

  // Check Slack proxy setup and transition to setup mode if needed,
  // or proceed directly to scope selection if already configured.
  const checkAndMaybeShowProxySetup = async (
    afterSetup: () => void,
  ): Promise<void> => {
    if (!onCheckSlackProxySetup) {
      afterSetup();
      return;
    }
    setProxySetupLoading(true);
    setProxySetupError(null);
    try {
      const status = await onCheckSlackProxySetup();
      setProxySetupStatus(status);
      if (status && !status.signingSecretConfigured) {
        // Need signing secret — show setup wizard step
        setSigningSecretInput('');
        setMode('slack-proxy-setup');
      } else {
        // Already configured — proceed
        afterSetup();
      }
    } catch {
      // On error, just proceed (don't block the wizard)
      afterSetup();
    } finally {
      setProxySetupLoading(false);
    }
  };

  const proceedToScopeFromProxy = (): void => {
    const knownChannels = pendingSlackAccountId
      ? (slackChannelsByAccount[pendingSlackAccountId] ?? [])
      : [];
    const firstScope = knownChannels[0]?.displayScope ?? '#';
    setScopeInput(firstScope);
    setScopeSuggestionSelection(0);
    setScopeSuggestionPage(0);
    setMode('add-scope');
  };

  useInput((input, key) => {
    const isBackspaceKey =
      key.backspace ||
      input === '\u0008' || // Ctrl+H
      input === '\u007f';   // DEL (common Backspace on many terminals)

    if (input === 'b' && key.ctrl) {
      onClose();
      return;
    }

    if (key.escape) {
      if (mode === 'edit-prompt') {
        setMode('edit-connection');
        setPromptPreferredCol(null);
        return;
      }
      if (mode === 'add-prompt') {
        setMode(pendingPlatform === 'slack' ? 'add-posting' : 'add-response');
        setPromptPreferredCol(null);
        return;
      }
      if (mode === 'add-posting') {
        setMode('add-response');
        setPromptPreferredCol(null);
        return;
      }
      if (mode === 'list') onClose();
      else setMode('list');
      return;
    }

    if (mode === 'edit-prompt') {
      if (key.ctrl && input.toLowerCase() === 's') {
        const trimmed = sanitizePromptInput(promptInput).trim();
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
      const isDeleteAsBackspace = key.delete && promptCursor >= promptInput.length;
      if (isBackspaceKey || isDeleteAsBackspace) {
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
        const moved = moveCursorByVisualRow(
          promptInput,
          promptCursor,
          Math.max(10, terminalWidth - 12),
          key.upArrow ? -1 : 1,
          promptPreferredCol,
        );
        setPromptCursor(moved.cursor);
        setPromptPreferredCol(moved.preferredCol);
        return;
      }
      if (input) {
        const safeInput = sanitizePromptInput(input);
        if (!safeInput) return;
        const next = `${promptInput.slice(0, promptCursor)}${safeInput}${promptInput.slice(promptCursor)}`;
        setPromptInput(next);
        setPromptCursor(promptCursor + safeInput.length);
        setPromptPreferredCol(null);
      }
      return;
    }

    if (mode === 'add-scope') {
      const pageStart = scopeSuggestionPage * scopeSuggestionPageSize;
      const pageEndExclusive = Math.min(
        slackScopeSuggestions.length,
        pageStart + scopeSuggestionPageSize,
      );
      const pageLength = Math.max(0, pageEndExclusive - pageStart);
      if (pendingPlatform === 'slack' && key.leftArrow && scopeSuggestionPageCount > 1) {
        const relative = Math.max(0, scopeSuggestionSelection - pageStart);
        const nextPage = Math.max(0, scopeSuggestionPage - 1);
        const nextStart = nextPage * scopeSuggestionPageSize;
        const nextEndExclusive = Math.min(
          slackScopeSuggestions.length,
          nextStart + scopeSuggestionPageSize,
        );
        const nextLength = Math.max(1, nextEndExclusive - nextStart);
        const nextIndex = nextStart + Math.min(relative, nextLength - 1);
        setScopeSuggestionPage(nextPage);
        setScopeSuggestionSelection(nextIndex);
        setScopeInput(slackScopeSuggestions[nextIndex] ?? '');
        return;
      }
      if (pendingPlatform === 'slack' && key.rightArrow && scopeSuggestionPageCount > 1) {
        const relative = Math.max(0, scopeSuggestionSelection - pageStart);
        const nextPage = Math.min(scopeSuggestionPageCount - 1, scopeSuggestionPage + 1);
        const nextStart = nextPage * scopeSuggestionPageSize;
        const nextEndExclusive = Math.min(
          slackScopeSuggestions.length,
          nextStart + scopeSuggestionPageSize,
        );
        const nextLength = Math.max(1, nextEndExclusive - nextStart);
        const nextIndex = nextStart + Math.min(relative, nextLength - 1);
        setScopeSuggestionPage(nextPage);
        setScopeSuggestionSelection(nextIndex);
        setScopeInput(slackScopeSuggestions[nextIndex] ?? '');
        return;
      }
      if (pendingPlatform === 'slack' && key.upArrow && slackScopeSuggestions.length > 0) {
        const inPageIndex =
          scopeSuggestionSelection >= pageStart && scopeSuggestionSelection < pageEndExclusive
            ? scopeSuggestionSelection - pageStart
            : 0;
        const next = pageStart + cycleIndex(inPageIndex, pageLength || 1, -1);
        setScopeSuggestionSelection(next);
        setScopeInput(slackScopeSuggestions[next] ?? '');
        return;
      }
      if (pendingPlatform === 'slack' && key.downArrow && slackScopeSuggestions.length > 0) {
        const inPageIndex =
          scopeSuggestionSelection >= pageStart && scopeSuggestionSelection < pageEndExclusive
            ? scopeSuggestionSelection - pageStart
            : 0;
        const next = pageStart + cycleIndex(inPageIndex, pageLength || 1, 1);
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
        setPendingPermission('read+write');
        setResponseSelection(2);
        setPendingResponseMode('all');
        setDeliverySelection(0);
        setPendingDeliveryMode('adaptive');
        setPendingPrompt('');
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
        const nextMode = selectedRow.responseMode === 'off' ? 'all' : 'off';
        onSetResponseMode(selectedRow.index, nextMode);
        setStatusMessage(`Connection #${selectedRow.index} response mode: ${nextMode}.`);
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
        if (chosen === 'slack') {
          // For Slack without workspace accounts, check proxy setup first
          void checkAndMaybeShowProxySetup(() => {
            setScopeInput('#');
            setScopeSuggestionSelection(0);
            setScopeSuggestionPage(0);
            setMode('add-scope');
          });
        } else {
          setScopeInput('');
          setScopeSuggestionSelection(0);
          setScopeSuggestionPage(0);
          setMode('add-scope');
        }
      }
      return;
    }

    if (mode === 'add-workspace') {
      if (slackAccounts.length === 0) {
        setPendingSlackAccountId(undefined);
        void checkAndMaybeShowProxySetup(() => {
          setScopeInput('#');
          setScopeSuggestionSelection(0);
          setScopeSuggestionPage(0);
          setMode('add-scope');
        });
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
        // After workspace selection, check proxy setup before proceeding to scope
        void checkAndMaybeShowProxySetup(() => {
          const knownChannels = chosen?.id ? (slackChannelsByAccount[chosen.id] ?? []) : [];
          const firstScope = knownChannels[0]?.displayScope ?? '#';
          setScopeInput(firstScope);
          setScopeSuggestionSelection(0);
          setScopeSuggestionPage(0);
          setMode('add-scope');
        });
      }
      return;
    }

    if (mode === 'slack-proxy-setup') {
      // Signing secret input is handled by TextInput's onSubmit.
      // Only handle Escape here to go back.
      if (key.escape) {
        setMode('add-platform');
        return;
      }
      // 's' key to skip setup (proceed without signing secret)
      if (input === 's' && !signingSecretInput) {
        setStatusMessage('Skipping Slack signing secret setup (can be configured later).');
        proceedToScopeFromProxy();
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
        setPendingPermission(permission);
        setResponseSelection(2);
        setPendingResponseMode('all');
        setMode('add-response');
      }
      return;
    }

    if (mode === 'add-response') {
      if (key.upArrow) {
        setResponseSelection((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setResponseSelection((prev) => Math.min(RESPONSE_MODE_OPTIONS.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const nextMode = RESPONSE_MODE_OPTIONS[responseSelection];
        setPendingResponseMode(nextMode);
        if (pendingPlatform === 'slack') {
          setDeliverySelection(0);
          setPendingDeliveryMode('adaptive');
          setMode('add-posting');
        } else {
          const normalized = sanitizePromptInput(pendingPrompt);
          setPromptInput(normalized);
          setPromptCursor(normalized.length);
          setPromptPreferredCol(null);
          setMode('add-prompt');
        }
      }
      return;
    }

    if (mode === 'add-posting') {
      if (key.upArrow) {
        setDeliverySelection((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setDeliverySelection((prev) => Math.min(POSTING_PRIORITY_OPTIONS.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const nextPriority = POSTING_PRIORITY_OPTIONS[deliverySelection];
        const nextMode = toDeliveryMode(nextPriority);
        setPendingDeliveryMode(nextMode);
        const normalized = sanitizePromptInput(pendingPrompt);
        setPromptInput(normalized);
        setPromptCursor(normalized.length);
        setPromptPreferredCol(null);
        setMode('add-prompt');
      }
      return;
    }

    if (mode === 'add-prompt') {
      if (key.ctrl && input.toLowerCase() === 's') {
        setPendingPrompt(sanitizePromptInput(promptInput));
        setMode('add-review');
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
      const isDeleteAsBackspace = key.delete && promptCursor >= promptInput.length;
      if (isBackspaceKey || isDeleteAsBackspace) {
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
        const moved = moveCursorByVisualRow(
          promptInput,
          promptCursor,
          Math.max(10, terminalWidth - 12),
          key.upArrow ? -1 : 1,
          promptPreferredCol,
        );
        setPromptCursor(moved.cursor);
        setPromptPreferredCol(moved.preferredCol);
        return;
      }
      if (input) {
        const safeInput = sanitizePromptInput(input);
        if (!safeInput) return;
        const next = `${promptInput.slice(0, promptCursor)}${safeInput}${promptInput.slice(promptCursor)}`;
        setPromptInput(next);
        setPromptCursor(promptCursor + safeInput.length);
        setPromptPreferredCol(null);
      }
      return;
    }

    if (mode === 'add-review') {
      if (key.return) {
        const newZeroBasedIndex = rows.length;
        onAddBinding(pendingPlatform, pendingScope, pendingPermission);
        onSetResponseMode(newZeroBasedIndex + 1, pendingResponseMode);
        if (pendingPlatform === 'slack') {
          onSetDeliveryMode(newZeroBasedIndex + 1, pendingDeliveryMode);
        }
        const trimmedPrompt = sanitizePromptInput(pendingPrompt).trim();
        if (trimmedPrompt) onSetPrompt(newZeroBasedIndex + 1, trimmedPrompt);
        setMode('list');
        setSelectedIndex(newZeroBasedIndex);
        ensureVisible(newZeroBasedIndex);
        setStatusMessage(`Added ${pendingPlatform} ${pendingScope} (${pendingPermission}).`);
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
  const promptEditorWidth = Math.max(10, terminalWidth - 12);
  const promptEditorMaxLines = Math.max(4, Math.min(14, maxHeight - 24));
  const promptLayout = buildVisualLayout(promptInput, promptCursor, promptEditorWidth);
  const promptWindow = computeVisibleWindow(
    promptLayout.lines.length,
    promptLayout.cursorRow,
    promptEditorMaxLines,
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={terminalWidth}>
      <Text bold color="cyan">Channel Config</Text>
      <Text dimColor>
        Channels are specific external messaging platforms like Slack, Telegram, Discord, etc. that you can configure ClawTalk agents to interact with.
      </Text>
      <Box height={1} />
      <Text dimColor>Workflow: configure all fields, review, then save.</Text>

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
          <Text bold>Configuration</Text>
          {selectedRow ? (
            <>
              <Text>  platform: {selectedRow.binding.platform}</Text>
              <Text>  scope: {formatBindingScopeLabel(selectedRow.binding)}</Text>
              <Text>  permission: {selectedRow.binding.permission}</Text>
              <Text>  response mode: {selectedRow.responseMode}</Text>
              <Text>
                {'  Posting Priority: '}
                {selectedRow.binding.platform === 'slack' ? toPostingPriority(selectedRow.deliveryMode) : '(n/a)'}
              </Text>
              {selectedRow.binding.platform === 'slack' && (
                <Text dimColor>
                  {'    Controls where replies are posted (not response wording).'}
                </Text>
              )}
              <Text>
                {'  Slack Message Mirroring: '}
                {selectedRow.binding.platform === 'slack' ? selectedRow.mirrorToTalk : '(n/a)'}
              </Text>
              {selectedRow.binding.platform === 'slack' && (
                <Text dimColor>
                  {'    Mirrors Slack transcript to Talk history: off | inbound | full'}
                </Text>
              )}
              <Text>  responder agent: {selectedRow.agentName ?? '(default primary)'}</Text>
              <Text>  Response Prompt:</Text>
              {wrapForTerminal(selectedRow.prompt || '(none)', Math.max(10, terminalWidth - 10)).map((line, idx) => (
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
              <Text color={activeEditField === 'response' ? 'cyan' : undefined}>
                {activeEditField === 'response' ? '▸ ' : '  '}
                response mode: {selectedRow.responseMode}
              </Text>
              <Text color={activeEditField === 'posting' ? 'cyan' : undefined}>
                {activeEditField === 'posting' ? '▸ ' : '  '}
                Posting Priority: {selectedRow.binding.platform === 'slack' ? toPostingPriority(selectedRow.deliveryMode) : '(n/a)'}
              </Text>
              <Text color={activeEditField === 'mirror' ? 'cyan' : undefined}>
                {activeEditField === 'mirror' ? '▸ ' : '  '}
                Slack Message Mirroring: {selectedRow.binding.platform === 'slack' ? selectedRow.mirrorToTalk : '(n/a)'}
              </Text>
              <Text color={activeEditField === 'agent' ? 'cyan' : undefined}>
                {activeEditField === 'agent' ? '▸ ' : '  '}
                responder agent: {selectedRow.agentName ?? '(default primary)'}
              </Text>
              <Text color={activeEditField === 'prompt' ? 'cyan' : undefined}>
                {activeEditField === 'prompt' ? '▸ ' : '  '}
                {selectedRow.binding.platform === 'slack' && selectedRow.deliveryMode === 'adaptive'
                  ? 'Response Prompt (adaptive):'
                  : 'Response Prompt:'}
              </Text>
              {(selectedRow.prompt?.trim()
                ? wrapForTerminal(selectedRow.prompt, Math.max(10, terminalWidth - 12))
                : ['(none)']
              ).map((line, idx) => (
                <Text key={`edit-connection-prompt-line-${idx}`} dimColor>
                  {'    '}
                  {line || ' '}
                </Text>
              ))}
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
                {PLATFORM_LABELS[platform]}
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

      {mode === 'slack-proxy-setup' && (
        <>
          <Box height={1} />
          <Text bold>Slack Event Proxy Setup</Text>
          <Box height={1} />
          {proxySetupLoading ? (
            <Text dimColor>Checking Slack event proxy configuration...</Text>
          ) : (
            <>
              <Text>ClawTalk needs a Slack Signing Secret to receive messages from Slack.</Text>
              <Box height={1} />
              <Text dimColor>To find your signing secret:</Text>
              <Text dimColor>  1. Go to https://api.slack.com/apps and select your app</Text>
              <Text dimColor>  2. Click "Basic Information" in the sidebar</Text>
              <Text dimColor>  3. Under "App Credentials", copy the "Signing Secret"</Text>
              <Box height={1} />
              {proxySetupError && (
                <Text color="red">{proxySetupError}</Text>
              )}
              {signingSecretSaving ? (
                <Text dimColor>Saving signing secret...</Text>
              ) : (
                <Box>
                  <Text>Signing Secret: </Text>
                  <TextInput
                    value={signingSecretInput}
                    onChange={setSigningSecretInput}
                    onSubmit={async (value) => {
                      const secret = value.trim();
                      if (!secret) {
                        setProxySetupError('Signing secret cannot be empty. Press s to skip.');
                        return;
                      }
                      if (!onSaveSlackSigningSecret) {
                        proceedToScopeFromProxy();
                        return;
                      }
                      setSigningSecretSaving(true);
                      setProxySetupError(null);
                      try {
                        const result = await onSaveSlackSigningSecret(secret);
                        if (result.ok) {
                          setStatusMessage('Slack signing secret saved. Remember to restart OpenClaw for changes to take effect.');
                          proceedToScopeFromProxy();
                        } else {
                          setProxySetupError(result.error ?? 'Failed to save signing secret');
                        }
                      } catch (err) {
                        setProxySetupError(String(err));
                      } finally {
                        setSigningSecretSaving(false);
                      }
                    }}
                  />
                </Box>
              )}
              <Box height={1} />
              {proxySetupStatus?.gatewayProxyUrl && (
                <>
                  <Text dimColor>After saving, set your Slack app's Event Request URL to:</Text>
                  <Text color="cyan">  {proxySetupStatus.gatewayProxyUrl}</Text>
                  <Box height={1} />
                </>
              )}
              <Text color="yellow">Note: Restart OpenClaw after setup for config changes to take effect.</Text>
              <Box height={1} />
              <Text dimColor>Enter save  s skip  Esc back</Text>
            </>
          )}
        </>
      )}

      {mode === 'add-scope' && (
        <>
          <Box height={1} />
          <Text bold>Step {pendingPlatform === 'slack' ? '3' : '2'}: Select Channel</Text>
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
                  {suggestedSlackChannels
                    .slice(
                      scopeSuggestionPage * scopeSuggestionPageSize,
                      Math.min(
                        suggestedSlackChannels.length,
                        (scopeSuggestionPage + 1) * scopeSuggestionPageSize,
                      ),
                    )
                    .map((channel, idx) => {
                      const absoluteIdx = (scopeSuggestionPage * scopeSuggestionPageSize) + idx;
                      return (
                        <Text key={channel.id} color={absoluteIdx === scopeSuggestionSelection ? 'cyan' : undefined}>
                          {absoluteIdx === scopeSuggestionSelection ? '▸ ' : '  '}
                          {channel.displayScope}  ({channel.scope})
                        </Text>
                      );
                    })}
                  {scopeSuggestionPageCount > 1 && (
                    <Text dimColor>
                      Page {scopeSuggestionPage + 1}/{scopeSuggestionPageCount}
                    </Text>
                  )}
                </>
              ) : (
                <Text dimColor>No channel suggestions found. You can still enter scope manually.</Text>
              )}
            </>
          ) : (
            <Text dimColor>Examples: group:-1001234567890, group:1203630...</Text>
          )}

          <Box>
            <Text>channel: </Text>
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
                setPendingPermission('read+write');
                setMode('add-permission');
              }}
            />
          </Box>
          <Text dimColor>↑/↓ pick channel  ←/→ page  Enter continue  Esc cancel</Text>
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
          <Text dimColor>Enter continue  Esc cancel</Text>
        </>
      )}

      {mode === 'add-response' && (
        <>
          <Box height={1} />
          <Text bold>Step {pendingPlatform === 'slack' ? '5' : '4'}: Agent Response</Text>
          <Text dimColor>{pendingPlatform} {pendingScope}</Text>
          {RESPONSE_MODE_OPTIONS.map((mode, idx) => (
            <Text key={mode} color={idx === responseSelection ? 'cyan' : undefined}>
              {idx === responseSelection ? '▸ ' : '  '}
              {mode}
            </Text>
          ))}
          <Box height={1} />
          <Text dimColor>Enter continue  Esc cancel</Text>
        </>
      )}

      {mode === 'add-posting' && (
        <>
          <Box height={1} />
          <Text bold>Step 6: Posting Priority</Text>
          <Text dimColor>{pendingPlatform} {pendingScope}</Text>
          <Text dimColor>
            Controls where Slack auto-responses are posted (not what they say).
          </Text>
          {POSTING_PRIORITY_OPTIONS.map((mode, idx) => (
            <Text key={mode} color={idx === deliverySelection ? 'cyan' : undefined}>
              {idx === deliverySelection ? '▸ ' : '  '}
              {mode}
            </Text>
          ))}
          <Box height={1} />
          <Text dimColor>Hints:</Text>
          <Text dimColor>  adaptive: infers whether to post in channel or reply in thread.</Text>
          <Text dimColor>  channel: prioritizes posting top-level messages to the channel.</Text>
          <Text dimColor>  reply: prioritizes replying in-thread when a thread is available.</Text>
          <Box height={1} />
          <Text dimColor>Enter continue  Esc cancel</Text>
        </>
      )}

      {mode === 'add-prompt' && (
        <>
          <Box height={1} />
          <Text bold>Step {pendingPlatform === 'slack' ? '7' : '5'}: Response Prompt</Text>
          <Text dimColor>Optional instruction for inbound responses on this channel.</Text>
          {pendingPlatform === 'slack' && (
            <Text dimColor>Shapes response content/style. Posting Priority controls routing.</Text>
          )}
          <Text dimColor>Example:</Text>
          <Text dimColor>  You are the channel assistant.</Text>
          <Text dimColor>  For each inbound message:</Text>
          <Text dimColor>  1) Identify whether it asks for action, status, or clarification.</Text>
          <Text dimColor>  2) If unclear, ask one short clarifying question.</Text>
          <Text dimColor>  3) If clear, reply with concise next steps and owners/dates when relevant.</Text>
          <Text dimColor>  4) Keep responses under 5 bullets unless detail is requested.</Text>
          <Box height={1} />
          <Text>
            Multi-line editor. <Text color="black">Ctrl+S SAVE and CONTINUE</Text>  Enter newline  Esc back
          </Text>
          <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
            {promptWindow.start > 0 && <Text dimColor>▲ more</Text>}
            {promptLayout.lines.slice(promptWindow.start, promptWindow.end).map((line, idx) => {
              const row = promptWindow.start + idx;
              if (row !== promptLayout.cursorRow) {
                return <Text key={`add-prompt-editor-${row}`}>{line.text || ' '}</Text>;
              }
              const col = Math.max(0, Math.min(promptLayout.cursorCol, line.text.length));
              const before = line.text.slice(0, col);
              const hasChar = col < line.text.length;
              const at = hasChar ? line.text[col] : ' ';
              const after = hasChar ? line.text.slice(col + 1) : '';
              return (
                <Text key={`add-prompt-editor-${row}`}>
                  {before}
                  <Text inverse>{at}</Text>
                  {after}
                </Text>
              );
            })}
            {promptWindow.end < promptLayout.lines.length && <Text dimColor>▼ more</Text>}
          </Box>
        </>
      )}

      {mode === 'add-review' && (
        <>
          <Box height={1} />
          <Text bold>Step {pendingPlatform === 'slack' ? '8' : '6'}: Review</Text>
          <Text>  platform: {pendingPlatform}</Text>
          <Text>  scope: {pendingScope}</Text>
          <Text>  permission: {pendingPermission}</Text>
          <Text>  response mode: {pendingResponseMode}</Text>
          {pendingPlatform === 'slack' && (
            <Text>  Posting Priority: {toPostingPriority(pendingDeliveryMode)}</Text>
          )}
          {pendingPlatform === 'slack' && (
            <>
              <Text>  Slack Message Mirroring: off</Text>
              <Text dimColor>    Controls transcript syncing to Talk history; does not affect Slack replies.</Text>
            </>
          )}
          <Text>  Response Prompt:</Text>
          {(pendingPrompt.trim()
            ? wrapForTerminal(pendingPrompt.trim(), Math.max(10, terminalWidth - 10))
            : ['(none)']
          ).map((line, idx) => (
            <Text key={`review-prompt-line-${idx}`} dimColor>
              {'    '}
              {line || ' '}
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
            {promptWindow.start > 0 && <Text dimColor>▲ more</Text>}
            {promptLayout.lines.slice(promptWindow.start, promptWindow.end).map((line, idx) => {
              const row = promptWindow.start + idx;
              if (row !== promptLayout.cursorRow) {
                return <Text key={`editor-line-${row}`}>{line.text || ' '}</Text>;
              }
              const col = Math.max(0, Math.min(promptLayout.cursorCol, line.text.length));
              const before = line.text.slice(0, col);
              const hasChar = col < line.text.length;
              const at = hasChar ? line.text[col] : ' ';
              const after = hasChar ? line.text.slice(col + 1) : '';
              return (
                <Text key={`editor-line-${row}`}>
                  {before}
                  <Text inverse>{at}</Text>
                  {after}
                </Text>
              );
            })}
            {promptWindow.end < promptLayout.lines.length && <Text dimColor>▼ more</Text>}
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
