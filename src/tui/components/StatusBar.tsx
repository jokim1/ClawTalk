/**
 * Status Bar Component
 *
 * Nano-style: info at top, shortcuts at bottom
 *
 * IMPORTANT: These components use simple Text rendering instead of flexbox
 * space-between to avoid Ink/Yoga layout jitter that causes screen shifting.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { UsageStats, ModelStatus, VoiceMode, VoiceReadiness } from '../../types';
import type { TailscaleStatus } from '../../services/tailscale';
import type { BillingOverride } from '../../config.js';
import { getModelAlias } from '../../models.js';

function formatResetTime(isoTimestamp: string): string {
  const now = Date.now();
  const reset = new Date(isoTimestamp).getTime();
  const diffMs = reset - now;

  if (diffMs <= 0) return 'now';

  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

interface StatusBarProps {
  model: string;
  modelStatus?: ModelStatus;
  usage: UsageStats;
  gatewayStatus: 'online' | 'offline' | 'connecting';
  tailscaleStatus: TailscaleStatus | 'checking';
  billing?: BillingOverride;
  sessionName?: string;
  terminalWidth?: number;
  voiceMode?: VoiceMode;
  voiceReadiness?: VoiceReadiness;
}

export function StatusBar({ model, modelStatus, usage, gatewayStatus, tailscaleStatus, billing, sessionName, terminalWidth = 80, voiceMode, voiceReadiness }: StatusBarProps) {
  const modelName = getModelAlias(model);

  const modelColor: string = modelStatus === 'checking' ? 'yellow'
    : modelStatus === 'ok' ? 'green'
    : typeof modelStatus === 'object' && modelStatus !== null ? 'red'
    : 'cyan';
  const modelIndicator = modelStatus === 'checking' ? ' ◐' : '';

  const isSubscription = billing?.mode === 'subscription';

  const gateway = gatewayStatus === 'online' ? '●' : gatewayStatus === 'connecting' ? '◐' : '○';
  const gatewayColor = gatewayStatus === 'online' ? 'green' : gatewayStatus === 'connecting' ? 'yellow' : 'red';

  const tsIcon = tailscaleStatus === 'connected' ? '●' : '○';
  const tsColor = tailscaleStatus === 'connected' ? 'green' : tailscaleStatus === 'checking' ? 'yellow' : 'red';

  const todayCost = `$${(usage.todaySpend ?? 0).toFixed(2)}`;
  const weeklyCost = `$${(usage.weeklySpend ?? 0).toFixed(2)}`;
  const monthlyCost = `$${Math.round(usage.monthlyEstimate ?? 0)}`;
  const sessCost = `$${(usage.sessionCost ?? 0).toFixed(2)}`;

  const hasApiCost = usage.modelPricing !== undefined && !isSubscription;
  const apiCost = hasApiCost
    ? `$${usage.modelPricing!.inputPer1M}/$${usage.modelPricing!.outputPer1M}`
    : null;

  const voiceStatus = voiceReadiness === 'checking' ? '◐' :
    voiceReadiness !== 'ready' ? '○' :
    voiceMode === 'liveTalk' ? '● LIVE' :
    voiceMode === 'recording' ? '● REC' :
    voiceMode === 'transcribing' ? '◐ STT' :
    voiceMode === 'synthesizing' ? '◐ TTS' :
    voiceMode === 'playing' ? '♪ PLAY' : '●';

  const voiceColor = voiceReadiness === 'checking' ? 'yellow' :
    voiceReadiness !== 'ready' ? 'red' :
    voiceMode === 'liveTalk' ? 'cyan' :
    voiceMode === 'recording' ? 'red' :
    voiceMode === 'transcribing' || voiceMode === 'synthesizing' ? 'yellow' :
    voiceMode === 'playing' ? 'magenta' : 'green';

  const micColor = voiceReadiness === 'ready' ? 'green' :
    voiceReadiness === 'checking' ? 'yellow' : 'red';
  const micIcon = voiceReadiness === 'ready' ? '●' : voiceReadiness === 'checking' ? '◐' : '○';

  // Build cost/billing section as plain text
  let billingText = '';
  if (isSubscription) {
    const rl = usage.rateLimits;
    const weekly = rl?.weekly;
    const session = rl?.session;

    if (weekly || session) {
      const primary = weekly ?? session!;
      const pct = primary.limit > 0 ? Math.round((primary.used / primary.limit) * 100) : 0;
      const barWidth = 10;
      const filled = Math.min(barWidth, Math.round((pct / 100) * barWidth));
      const empty = barWidth - filled;
      const resetLabel = formatResetTime(primary.resetsAt);
      const windowLabel = weekly ? 'wk' : 'sess';
      const pausedText = pct >= 100 ? ' PAUSED' : '';
      billingText = `  ${billing?.plan ?? 'Sub'}  ${'█'.repeat(filled)}${'░'.repeat(empty)} ${pct}% ${windowLabel}${pausedText}  Resets ${resetLabel}`;
    } else {
      billingText = `  ${billing?.plan ?? 'Sub'} $${billing?.monthlyPrice ?? '?'}/mo`;
    }
  } else {
    const costParts = [];
    if (hasApiCost) costParts.push(apiCost);
    costParts.push(`Today ${todayCost}`);
    costParts.push(`Wk ${weeklyCost}`);
    costParts.push(`~Mo ${monthlyCost}`);
    if ((usage.sessionCost ?? 0) > 0) costParts.push(`Sess ${sessCost}`);
    billingText = '  ' + costParts.join('  ');
  }

  // Build right side content
  const rightContent = `Mic:${micIcon}  ${sessionName ?? ''}`;
  const rightLen = rightContent.length;

  // Calculate left content (will be truncated if needed)
  // We use terminalWidth - 2 (for padding) - rightLen - 2 (for gap)
  const maxLeftWidth = terminalWidth - 2 - rightLen - 2;

  // Build the full line with padding to push right content to the edge
  const leftContent = `GW:${gateway} TS:${tsIcon} M:${modelName}${modelIndicator}  V:${voiceStatus}${billingText}`;
  const leftTruncated = leftContent.length > maxLeftWidth
    ? leftContent.slice(0, maxLeftWidth - 1) + '…'
    : leftContent;
  const padding = Math.max(0, terminalWidth - 2 - leftTruncated.length - rightLen);

  return (
    <Box flexDirection="column" width={terminalWidth} height={3}>
      <Box height={2}>
        <Text> </Text>
        <Text dimColor>GW:</Text><Text color={gatewayColor}>{gateway} </Text>
        <Text dimColor>TS:</Text><Text color={tsColor}>{tsIcon} </Text>
        <Text dimColor>M:</Text><Text color={modelColor} bold>{modelName}{modelIndicator}</Text>
        <Text dimColor>  V:</Text><Text color={voiceColor}>{voiceStatus}</Text>
        <Text dimColor>{billingText}</Text>
        <Text>{' '.repeat(Math.max(1, padding))}</Text>
        <Text dimColor>Mic:</Text><Text color={micColor}>{micIcon}</Text>
        <Text dimColor>  {sessionName ?? ''} </Text>
      </Box>
      <Box height={1}>
        <Text dimColor>{'─'.repeat(terminalWidth)}</Text>
      </Box>
    </Box>
  );
}

interface ShortcutBarProps {
  terminalWidth?: number;
  ttsEnabled?: boolean;
}

export function ShortcutBar({ terminalWidth = 80, ttsEnabled = true }: ShortcutBarProps) {
  // Build shortcuts as a single line without flexbox space-between
  // This prevents Ink/Yoga layout jitter
  const shortcuts = [
    { key: '^T', label: 'Talks' },
    { key: '^C', label: 'Chat' },
    { key: '^P', label: 'PTT' },
    { key: '^V', label: ttsEnabled ? 'Voice OFF' : 'Voice ON' },
    { key: '^H', label: 'History' },
    { key: '^S', label: 'Settings' },
    { key: '^X', label: 'Exit' },
  ];

  return (
    <Box flexDirection="column" width={terminalWidth} height={2}>
      <Box height={1}>
        <Text dimColor>{'─'.repeat(terminalWidth)}</Text>
      </Box>
      <Box height={1}>
        <Text> </Text>
        {shortcuts.map((s, i) => (
          <Text key={s.key}>
            <Text inverse> {s.key} </Text>
            <Text> {s.label}{i < shortcuts.length - 1 ? '  ' : ''}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
