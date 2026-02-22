/**
 * Channel Add Flow — self-contained wizard for adding a new channel connection.
 *
 * Manages all add-specific state and keyboard input internally.
 * Calls onComplete() with final values or onCancel() to abort.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { PlatformPermission } from '../../types.js';
import type { SlackAccountOption, SlackChannelOption, SlackProxySetupStatus } from '../../services/chat.js';
import { formatPostingPriority, toDeliveryMode } from '../formatters.js';
import type { PostingPriority } from '../formatters.js';
import { sanitizePromptInput, wrapForTerminal } from './promptEditorUtils.js';
import { PromptEditor } from './PromptEditor.js';

type AddMode =
  | 'add-platform'
  | 'add-workspace'
  | 'slack-proxy-setup'
  | 'add-scope'
  | 'add-permission'
  | 'add-response'
  | 'add-posting'
  | 'add-prompt'
  | 'add-review';

const PLATFORM_OPTIONS = ['slack', 'telegram', 'whatsapp'] as const;
const PERMISSION_OPTIONS: PlatformPermission[] = ['read', 'write', 'read+write'];
const RESPONSE_MODE_OPTIONS: Array<'off' | 'mentions' | 'all'> = ['off', 'mentions', 'all'];
const POSTING_PRIORITY_OPTIONS: PostingPriority[] = ['adaptive', 'channel', 'reply'];

const PLATFORM_LABELS: Record<(typeof PLATFORM_OPTIONS)[number], string> = {
  slack: 'Slack',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

function cycleIndex(current: number, max: number, direction: -1 | 1): number {
  if (max <= 0) return 0;
  if (direction < 0) return current <= 0 ? max - 1 : current - 1;
  return current >= max - 1 ? 0 : current + 1;
}

function maybePrefixSlackAccount(scope: string, accountId: string | undefined): string {
  const trimmed = scope.trim();
  if (!trimmed || !accountId) return trimmed;
  if (hasSlackAccountPrefix(trimmed)) return trimmed;
  return `${accountId}:${trimmed}`;
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

export interface ChannelAddResult {
  platform: string;
  scope: string;
  permission: PlatformPermission;
  responseMode: 'off' | 'mentions' | 'all';
  deliveryMode: 'thread' | 'channel' | 'adaptive';
  prompt: string;
}

interface ChannelAddFlowProps {
  maxHeight: number;
  terminalWidth: number;
  slackAccounts: SlackAccountOption[];
  slackChannelsByAccount: Record<string, SlackChannelOption[]>;
  slackHintsLoading: boolean;
  slackHintsError: string | null;
  onRefreshSlackHints: () => void;
  onComplete: (result: ChannelAddResult) => void;
  onCancel: () => void;
  onCheckSlackProxySetup?: () => Promise<SlackProxySetupStatus | null>;
  onSaveSlackSigningSecret?: (secret: string) => Promise<{ ok: boolean; error?: string }>;
}

export function ChannelAddFlow({
  maxHeight,
  terminalWidth,
  slackAccounts,
  slackChannelsByAccount,
  slackHintsLoading,
  slackHintsError,
  onRefreshSlackHints,
  onComplete,
  onCancel,
  onCheckSlackProxySetup,
  onSaveSlackSigningSecret,
}: ChannelAddFlowProps) {
  const [mode, setMode] = useState<AddMode>('add-platform');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Platform selection
  const [platformSelection, setPlatformSelection] = useState(0);
  const [pendingPlatform, setPendingPlatform] = useState<string>(PLATFORM_OPTIONS[0]);

  // Workspace selection
  const [workspaceSelection, setWorkspaceSelection] = useState(0);
  const [pendingSlackAccountId, setPendingSlackAccountId] = useState<string | undefined>(undefined);

  // Slack proxy setup
  const [proxySetupStatus, setProxySetupStatus] = useState<SlackProxySetupStatus | null>(null);
  const [proxySetupLoading, setProxySetupLoading] = useState(false);
  const [signingSecretInput, setSigningSecretInput] = useState('');
  const [signingSecretSaving, setSigningSecretSaving] = useState(false);
  const [proxySetupError, setProxySetupError] = useState<string | null>(null);

  // Scope selection
  const [scopeInput, setScopeInput] = useState('');
  const [scopeSuggestionSelection, setScopeSuggestionSelection] = useState(0);
  const [scopeSuggestionPage, setScopeSuggestionPage] = useState(0);
  const [pendingScope, setPendingScope] = useState('');

  // Permission, response, delivery
  const [permissionSelection, setPermissionSelection] = useState(2);
  const [pendingPermission, setPendingPermission] = useState<PlatformPermission>('read+write');
  const [responseSelection, setResponseSelection] = useState(2);
  const [pendingResponseMode, setPendingResponseMode] = useState<'off' | 'mentions' | 'all'>('all');
  const [deliverySelection, setDeliverySelection] = useState(0);
  const [pendingDeliveryMode, setPendingDeliveryMode] = useState<'thread' | 'channel' | 'adaptive'>('adaptive');
  const [pendingPrompt, setPendingPrompt] = useState('');

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

  const scopeSuggestionPageSize = Math.max(4, maxHeight - 29);
  const scopeSuggestionPageCount = Math.max(1, Math.ceil(slackScopeSuggestions.length / scopeSuggestionPageSize));

  // Effects for scope suggestion bounds
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
  }, [mode, pendingPlatform, scopeSuggestionSelection, scopeSuggestionPageSize, scopeSuggestionPage, slackScopeSuggestions.length]);

  useEffect(() => {
    if (mode !== 'add-scope' || pendingPlatform !== 'slack') return;
    const normalized = scopeInput.trim().toLowerCase();
    if (!normalized) return;
    const matchIdx = slackScopeSuggestions.findIndex((c) => c.toLowerCase() === normalized);
    if (matchIdx >= 0 && matchIdx !== scopeSuggestionSelection) {
      setScopeSuggestionSelection(matchIdx);
    }
  }, [mode, pendingPlatform, scopeInput, slackScopeSuggestions, scopeSuggestionSelection]);

  const checkAndMaybeShowProxySetup = async (afterSetup: () => void): Promise<void> => {
    if (!onCheckSlackProxySetup) { afterSetup(); return; }
    setProxySetupLoading(true);
    setProxySetupError(null);
    try {
      const status = await onCheckSlackProxySetup();
      setProxySetupStatus(status);
      if (status && !status.signingSecretConfigured) {
        setSigningSecretInput('');
        setMode('slack-proxy-setup');
      } else {
        afterSetup();
      }
    } catch {
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

  const promptEditorWidth = Math.max(10, terminalWidth - 12);
  const promptEditorMaxLines = Math.max(4, Math.min(14, maxHeight - 24));

  useInput((input, key) => {
    // PromptEditor handles its own input in add-prompt mode
    if (mode === 'add-prompt') return;

    if (key.escape) {
      if (mode === 'add-posting') { setMode('add-response'); return; }
      onCancel();
      return;
    }

    if (mode === 'add-scope') {
      const pageStart = scopeSuggestionPage * scopeSuggestionPageSize;
      const pageEndExclusive = Math.min(slackScopeSuggestions.length, pageStart + scopeSuggestionPageSize);
      const pageLength = Math.max(0, pageEndExclusive - pageStart);
      if (pendingPlatform === 'slack' && key.leftArrow && scopeSuggestionPageCount > 1) {
        const relative = Math.max(0, scopeSuggestionSelection - pageStart);
        const nextPage = Math.max(0, scopeSuggestionPage - 1);
        const nextStart = nextPage * scopeSuggestionPageSize;
        const nextEndExclusive = Math.min(slackScopeSuggestions.length, nextStart + scopeSuggestionPageSize);
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
        const nextEndExclusive = Math.min(slackScopeSuggestions.length, nextStart + scopeSuggestionPageSize);
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
            ? scopeSuggestionSelection - pageStart : 0;
        const next = pageStart + cycleIndex(inPageIndex, pageLength || 1, -1);
        setScopeSuggestionSelection(next);
        setScopeInput(slackScopeSuggestions[next] ?? '');
        return;
      }
      if (pendingPlatform === 'slack' && key.downArrow && slackScopeSuggestions.length > 0) {
        const inPageIndex =
          scopeSuggestionSelection >= pageStart && scopeSuggestionSelection < pageEndExclusive
            ? scopeSuggestionSelection - pageStart : 0;
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

    if (mode === 'add-platform') {
      if (key.upArrow) { setPlatformSelection((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setPlatformSelection((p) => Math.min(PLATFORM_OPTIONS.length - 1, p + 1)); return; }
      if (input === 'r') { onRefreshSlackHints(); setStatusMessage('Refreshing Slack workspaces/channels...'); return; }
      if (key.return) {
        const chosen = PLATFORM_OPTIONS[platformSelection];
        setPendingPlatform(chosen);
        if (chosen === 'slack' && slackAccounts.length > 0) {
          const firstValidIdx = slackAccounts.findIndex((a) => a.hasBotToken);
          const nextIndex = firstValidIdx >= 0 ? firstValidIdx : 0;
          setWorkspaceSelection(nextIndex);
          setPendingSlackAccountId(slackAccounts[nextIndex]?.id);
          setMode('add-workspace');
          return;
        }
        setPendingSlackAccountId(undefined);
        if (chosen === 'slack') {
          void checkAndMaybeShowProxySetup(() => {
            setScopeInput('#'); setScopeSuggestionSelection(0); setScopeSuggestionPage(0); setMode('add-scope');
          });
        } else {
          setScopeInput(''); setScopeSuggestionSelection(0); setScopeSuggestionPage(0); setMode('add-scope');
        }
      }
      return;
    }

    if (mode === 'add-workspace') {
      if (slackAccounts.length === 0) {
        setPendingSlackAccountId(undefined);
        void checkAndMaybeShowProxySetup(() => {
          setScopeInput('#'); setScopeSuggestionSelection(0); setScopeSuggestionPage(0); setMode('add-scope');
        });
        return;
      }
      if (key.upArrow) { setWorkspaceSelection((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setWorkspaceSelection((p) => Math.min(slackAccounts.length - 1, p + 1)); return; }
      if (input === 'r') { onRefreshSlackHints(); setStatusMessage('Refreshing Slack workspaces/channels...'); return; }
      if (key.return) {
        const chosen = selectedWorkspace;
        setPendingSlackAccountId(chosen?.id);
        void checkAndMaybeShowProxySetup(() => {
          const knownChannels = chosen?.id ? (slackChannelsByAccount[chosen.id] ?? []) : [];
          const firstScope = knownChannels[0]?.displayScope ?? '#';
          setScopeInput(firstScope); setScopeSuggestionSelection(0); setScopeSuggestionPage(0); setMode('add-scope');
        });
      }
      return;
    }

    if (mode === 'slack-proxy-setup') {
      if (key.escape) { setMode('add-platform'); return; }
      if (input === 's' && !signingSecretInput) {
        setStatusMessage('Skipping Slack signing secret setup (can be configured later).');
        proceedToScopeFromProxy();
      }
      return;
    }

    if (mode === 'add-permission') {
      if (key.upArrow) { setPermissionSelection((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setPermissionSelection((p) => Math.min(PERMISSION_OPTIONS.length - 1, p + 1)); return; }
      if (key.return) {
        setPendingPermission(PERMISSION_OPTIONS[permissionSelection]);
        setResponseSelection(2); setPendingResponseMode('all'); setMode('add-response');
      }
      return;
    }

    if (mode === 'add-response') {
      if (key.upArrow) { setResponseSelection((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setResponseSelection((p) => Math.min(RESPONSE_MODE_OPTIONS.length - 1, p + 1)); return; }
      if (key.return) {
        const nextMode = RESPONSE_MODE_OPTIONS[responseSelection];
        setPendingResponseMode(nextMode);
        if (pendingPlatform === 'slack') {
          setDeliverySelection(0); setPendingDeliveryMode('adaptive'); setMode('add-posting');
        } else {
          setMode('add-prompt');
        }
      }
      return;
    }

    if (mode === 'add-posting') {
      if (key.upArrow) { setDeliverySelection((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setDeliverySelection((p) => Math.min(POSTING_PRIORITY_OPTIONS.length - 1, p + 1)); return; }
      if (key.return) {
        const nextPriority = POSTING_PRIORITY_OPTIONS[deliverySelection];
        setPendingDeliveryMode(toDeliveryMode(nextPriority));
        setMode('add-prompt');
      }
      return;
    }

    if (mode === 'add-review') {
      if (key.return) {
        const trimmedPrompt = sanitizePromptInput(pendingPrompt).trim();
        onComplete({
          platform: pendingPlatform,
          scope: pendingScope,
          permission: pendingPermission,
          responseMode: pendingResponseMode,
          deliveryMode: pendingDeliveryMode,
          prompt: trimmedPrompt,
        });
      }
    }
  });

  return (
    <>
      {mode === 'add-platform' && (
        <>
          <Box height={1} />
          <Text bold>Step 1: Choose Platform</Text>
          {PLATFORM_OPTIONS.map((platform, idx) => (
            <Text key={platform} color={idx === platformSelection ? 'cyan' : undefined}>
              {idx === platformSelection ? '\u25B8 ' : '  '}
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
                {idx === workspaceSelection ? '\u25B8 ' : '  '}
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
              <Text dimColor>{'  2. Click "Basic Information" in the sidebar'}</Text>
              <Text dimColor>{'  3. Under "App Credentials", copy the "Signing Secret"'}</Text>
              <Box height={1} />
              {proxySetupError && <Text color="red">{proxySetupError}</Text>}
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
                      if (!secret) { setProxySetupError('Signing secret cannot be empty. Press s to skip.'); return; }
                      if (!onSaveSlackSigningSecret) { proceedToScopeFromProxy(); return; }
                      setSigningSecretSaving(true); setProxySetupError(null);
                      try {
                        const result = await onSaveSlackSigningSecret(secret);
                        if (result.ok) {
                          setStatusMessage('Slack signing secret saved. Remember to restart OpenClaw for changes to take effect.');
                          proceedToScopeFromProxy();
                        } else {
                          setProxySetupError(result.error ?? 'Failed to save signing secret');
                        }
                      } catch (err) { setProxySetupError(String(err)); }
                      finally { setSigningSecretSaving(false); }
                    }}
                  />
                </Box>
              )}
              <Box height={1} />
              {proxySetupStatus?.gatewayProxyUrl && (
                <>
                  <Text dimColor>{"After saving, set your Slack app's Event Request URL to:"}</Text>
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
                      Math.min(suggestedSlackChannels.length, (scopeSuggestionPage + 1) * scopeSuggestionPageSize),
                    )
                    .map((channel, idx) => {
                      const absoluteIdx = (scopeSuggestionPage * scopeSuggestionPageSize) + idx;
                      return (
                        <Text key={channel.id} color={absoluteIdx === scopeSuggestionSelection ? 'cyan' : undefined}>
                          {absoluteIdx === scopeSuggestionSelection ? '\u25B8 ' : '  '}
                          {channel.displayScope}  ({channel.scope})
                        </Text>
                      );
                    })}
                  {scopeSuggestionPageCount > 1 && (
                    <Text dimColor>Page {scopeSuggestionPage + 1}/{scopeSuggestionPageCount}</Text>
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
                const fallbackScope = pendingPlatform === 'slack' ? slackScopeSuggestions[scopeSuggestionSelection] ?? '' : '';
                const resolvedScope = typed || fallbackScope;
                if (!resolvedScope) { setStatusMessage('Scope cannot be empty.'); return; }
                const finalScope = pendingPlatform === 'slack'
                  ? maybePrefixSlackAccount(resolvedScope, pendingSlackAccountId) : resolvedScope;
                setPendingScope(finalScope);
                setPermissionSelection(2); setPendingPermission('read+write'); setMode('add-permission');
              }}
            />
          </Box>
          <Text dimColor>{'\u2191/\u2193 pick channel  \u2190/\u2192 page  Enter continue  Esc cancel'}</Text>
        </>
      )}

      {mode === 'add-permission' && (
        <>
          <Box height={1} />
          <Text bold>Step {pendingPlatform === 'slack' ? '4' : '3'}: Choose Permission</Text>
          <Text dimColor>{pendingPlatform} {pendingScope}</Text>
          {PERMISSION_OPTIONS.map((permission, idx) => (
            <Text key={permission} color={idx === permissionSelection ? 'cyan' : undefined}>
              {idx === permissionSelection ? '\u25B8 ' : '  '}
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
          {RESPONSE_MODE_OPTIONS.map((m, idx) => (
            <Text key={m} color={idx === responseSelection ? 'cyan' : undefined}>
              {idx === responseSelection ? '\u25B8 ' : '  '}
              {m}
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
          <Text dimColor>Controls where Slack auto-responses are posted (not what they say).</Text>
          {POSTING_PRIORITY_OPTIONS.map((m, idx) => (
            <Text key={m} color={idx === deliverySelection ? 'cyan' : undefined}>
              {idx === deliverySelection ? '\u25B8 ' : '  '}
              {m}
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
          <PromptEditor
            initialValue={pendingPrompt}
            editorWidth={promptEditorWidth}
            maxVisibleLines={promptEditorMaxLines}
            onSave={(text) => { setPendingPrompt(text); setMode('add-review'); }}
            onCancel={() => setMode(pendingPlatform === 'slack' ? 'add-posting' : 'add-response')}
            keyPrefix="add-prompt-editor"
          />
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
            <Text>  Posting Priority: {formatPostingPriority(pendingDeliveryMode)}</Text>
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

      {statusMessage && (
        <>
          <Box height={1} />
          <Text color="green">{statusMessage}</Text>
        </>
      )}
    </>
  );
}
