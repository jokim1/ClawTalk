/**
 * Status Bar Component
 *
 * Nano-style: info at top, shortcuts at bottom
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { UsageStats, ModelStatus, VoiceMode, VoiceReadiness, TalkAgent } from '../../types';
import type { TailscaleStatus } from '../../services/tailscale';
import type { BillingOverride } from '../../config.js';
import { getModelAlias } from '../../models.js';
import { ROLE_BY_ID } from '../../agent-roles.js';

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
  ttsEnabled?: boolean;
  agents?: TalkAgent[];
}

export function StatusBar({ model, modelStatus, usage, gatewayStatus, tailscaleStatus, billing, sessionName, terminalWidth = 80, voiceMode, voiceReadiness, ttsEnabled = true, agents }: StatusBarProps) {
  const modelName = getModelAlias(model);
  const modelIndicator = modelStatus === 'checking' ? ' ◐' : '';

  // Build model display: single model or agent list
  const modelDisplay = agents && agents.length > 0
    ? agents.map(a => {
        const alias = getModelAlias(a.model);
        const roleShort = ROLE_BY_ID[a.role]?.shortLabel ?? '?';
        const prefix = a.isPrimary ? '' : '@';
        return `${prefix}${alias}(${roleShort})`;
      }).join(' ')
    : `${modelName}${modelIndicator}`;
  const isSubscription = billing?.mode === 'subscription';

  // Icons with colors
  const gwIcon = gatewayStatus === 'online' ? '●' : gatewayStatus === 'connecting' ? '◐' : '○';
  const gwColor = gatewayStatus === 'online' ? 'green' : gatewayStatus === 'connecting' ? 'yellow' : 'red';

  const tsIcon = tailscaleStatus === 'connected' ? '●' : '○';
  const tsColor = tailscaleStatus === 'connected' ? 'green' : tailscaleStatus === 'checking' ? 'yellow' : 'red';

  const modelColor = modelStatus === 'checking' ? 'yellow' : modelStatus === 'ok' ? 'green'
    : typeof modelStatus === 'object' ? 'red' : 'cyan';

  const micIcon = voiceReadiness === 'ready' ? '●' : voiceReadiness === 'checking' ? '◐' : '○';
  const micColor = voiceReadiness === 'ready' ? 'green' : voiceReadiness === 'checking' ? 'yellow' : 'red';

  const isVoiceActive = voiceMode === 'playing' || voiceMode === 'synthesizing';
  const ttsIcon = isVoiceActive ? (voiceMode === 'playing' ? '♪' : '◐') : ttsEnabled ? '●' : '○';
  const ttsColor = isVoiceActive ? (voiceMode === 'playing' ? 'magenta' : 'yellow') : ttsEnabled ? 'green' : 'white';

  // Build cost/billing section
  let billingText = '';
  if (isSubscription) {
    const rl = usage.rateLimits;
    const primary = rl?.weekly ?? rl?.session;
    if (primary) {
      const pct = primary.limit > 0 ? Math.round((primary.used / primary.limit) * 100) : 0;
      const filled = Math.min(10, Math.round((pct / 100) * 10));
      const resetLabel = formatResetTime(primary.resetsAt);
      const windowLabel = rl?.weekly ? 'wk' : 'sess';
      const pausedText = pct >= 100 ? ' PAUSED' : '';
      billingText = `${billing?.plan ?? 'Sub'} ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${pct}% ${windowLabel}${pausedText} Resets ${resetLabel}`;
    } else {
      billingText = `${billing?.plan ?? 'Sub'} $${billing?.monthlyPrice ?? '?'}/mo`;
    }
  } else {
    const hasApiCost = usage.modelPricing !== undefined;
    const parts = [];
    if (hasApiCost) parts.push(`$${usage.modelPricing!.inputPer1M}/$${usage.modelPricing!.outputPer1M}`);
    parts.push(`Today $${(usage.todaySpend ?? 0).toFixed(2)}`);
    parts.push(`Wk $${(usage.weeklySpend ?? 0).toFixed(2)}`);
    parts.push(`~Mo $${Math.round(usage.monthlyEstimate ?? 0)}`);
    if ((usage.sessionCost ?? 0) > 0) parts.push(`Sess $${(usage.sessionCost ?? 0).toFixed(2)}`);
    billingText = parts.join('  ');
  }

  // Calculate padding for right-alignment
  const leftContent = `GW:${gwIcon} TS:${tsIcon} M:${modelDisplay}  ${billingText}`;
  const rightContent = `V:${ttsIcon} Mic:${micIcon}  ${sessionName ?? ''}`;
  const padding = Math.max(1, terminalWidth - leftContent.length - rightContent.length - 2);

  const separator = '─'.repeat(terminalWidth);

  return (
    <Box flexDirection="column" width={terminalWidth} height={2}>
      <Box height={1}>
        <Text dimColor>GW:</Text>
        <Text color={gwColor}>{gwIcon}</Text>
        <Text> </Text>
        <Text dimColor>TS:</Text>
        <Text color={tsColor}>{tsIcon}</Text>
        <Text> </Text>
        <Text dimColor>M:</Text>
        <Text color={modelColor} bold>{modelDisplay}</Text>
        <Text>  </Text>
        <Text dimColor>{billingText}</Text>
        <Text>{' '.repeat(padding)}</Text>
        <Text dimColor>V:</Text>
        <Text color={ttsColor}>{ttsIcon}</Text>
        <Text> </Text>
        <Text dimColor>Mic:</Text>
        <Text color={micColor}>{micIcon}</Text>
        <Text dimColor>  {sessionName ?? ''}</Text>
      </Box>
      <Box height={1}>
        <Text dimColor>{separator}</Text>
      </Box>
    </Box>
  );
}

interface ShortcutBarProps {
  terminalWidth?: number;
  ttsEnabled?: boolean;
}

export function ShortcutBar({ terminalWidth = 80, ttsEnabled = true }: ShortcutBarProps) {
  const row1 = [
    { key: '^T', label: 'Talks List' },
    { key: '^N', label: 'New Talk' },
    { key: '^C', label: 'Live Chat' },
    { key: '^P', label: 'Push2Talk' },
    { key: '^V', label: ttsEnabled ? 'Voice OFF' : 'Voice ON' },
  ];
  const row2 = [
    { key: '^K', label: 'AI Model' },
    { key: '^Y', label: 'New Terminal' },
    { key: '^S', label: 'Settings' },
    { key: '^X', label: 'Exit' },
  ];

  const colWidth = Math.floor(terminalWidth / Math.max(row1.length, row2.length));

  const renderRow = (items: { key: string; label: string }[]) => (
    <Box height={1}>
      {items.map((s) => (
        <Box key={s.key} width={colWidth}>
          <Text inverse bold> {s.key} </Text>
          <Text> {s.label}</Text>
        </Box>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" width={terminalWidth} height={3}>
      <Box height={1}>
        <Text dimColor>{'─'.repeat(terminalWidth)}</Text>
      </Box>
      {renderRow(row1)}
      {renderRow(row2)}
    </Box>
  );
}
