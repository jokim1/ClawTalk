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
import { sanitizeForTerminal } from '../textSanitize.js';

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
  directiveCount?: number;
  platformBindingCount?: number;
}

export function StatusBar({ model, modelStatus, usage, gatewayStatus, tailscaleStatus, billing, sessionName, terminalWidth = 80, voiceMode, voiceReadiness, ttsEnabled = true, agents, directiveCount = 0, platformBindingCount = 0 }: StatusBarProps) {
  const modelName = sanitizeForTerminal(getModelAlias(model));
  const modelIndicator = modelStatus === 'checking' ? ' ◐' : '';

  // Build model display: single model or agent list
  const singleAssistant = agents && agents.length === 1 && agents[0].role === 'assistant';
  const modelDisplay = agents && agents.length > 0 && !singleAssistant
      ? agents.map(a => {
        const alias = sanitizeForTerminal(getModelAlias(a.model));
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

  // Build cost/billing section as parts (for progressive truncation when space is tight)
  let billingParts: string[] = [];
  if (isSubscription) {
    const rl = usage.rateLimits;
    const primary = rl?.weekly ?? rl?.session;
    if (primary) {
      const pct = primary.limit > 0 ? Math.round((primary.used / primary.limit) * 100) : 0;
      const filled = Math.min(10, Math.round((pct / 100) * 10));
      const resetLabel = formatResetTime(primary.resetsAt);
      const windowLabel = rl?.weekly ? 'wk' : 'sess';
      const pausedText = pct >= 100 ? ' PAUSED' : '';
      billingParts = [`${billing?.plan ?? 'Sub'} ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${pct}% ${windowLabel}${pausedText} Resets ${resetLabel}`];
    } else {
      billingParts = [`${billing?.plan ?? 'Sub'} $${billing?.monthlyPrice ?? '?'}/mo`];
    }
  } else {
    const hasApiCost = usage.modelPricing !== undefined;
    if (hasApiCost) billingParts.push(`$${usage.modelPricing!.inputPer1M}/$${usage.modelPricing!.outputPer1M}`);
    billingParts.push(`Today $${(usage.todaySpend ?? 0).toFixed(2)}`);
    billingParts.push(`Wk $${(usage.weeklySpend ?? 0).toFixed(2)}`);
    billingParts.push(`~Mo $${Math.round(usage.monthlyEstimate ?? 0)}`);
    if ((usage.sessionCost ?? 0) > 0) billingParts.push(`Sess $${(usage.sessionCost ?? 0).toFixed(2)}`);
  }
  const billingText = billingParts.join('  ');

  // Calculate padding for right-alignment, truncating billing to preserve agent display
  const safeModelDisplay = sanitizeForTerminal(modelDisplay);
  const safeSessionName = sanitizeForTerminal(sessionName ?? '');
  const directiveExtra = directiveCount > 0 ? ` R:${directiveCount}` : '';
  const bindingExtra = platformBindingCount > 0 ? ` C:${platformBindingCount}` : '';
  const fixedLeft = `GW:${gwIcon} TS:${tsIcon} M:${safeModelDisplay}${directiveExtra}${bindingExtra}  `;
  const rightContent = `V:${ttsIcon} Mic:${micIcon}  ${safeSessionName}`;
  const minPadding = 2;
  const availableForBilling = terminalWidth - fixedLeft.length - rightContent.length - minPadding;

  // Progressively drop billing parts from the right until it fits
  let safeBillingText = sanitizeForTerminal(billingText);
  if (availableForBilling < safeBillingText.length && billingParts.length > 0) {
    let parts = [...billingParts];
    while (parts.length > 0 && parts.join('  ').length > availableForBilling) {
      parts.pop();
    }
    safeBillingText = sanitizeForTerminal(parts.join('  '));
  }

  const leftContent = `${fixedLeft}${safeBillingText}`;
  const padding = Math.max(1, terminalWidth - leftContent.length - rightContent.length);

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
        <Text color={modelColor} bold>{safeModelDisplay}</Text>
        {directiveCount > 0 && <Text dimColor> R:{directiveCount}</Text>}
        {platformBindingCount > 0 && <Text dimColor> C:{platformBindingCount}</Text>}
        <Text>  </Text>
        <Text dimColor>{safeBillingText}</Text>
        <Text>{' '.repeat(padding)}</Text>
        <Text dimColor>V:</Text>
        <Text color={ttsColor}>{ttsIcon}</Text>
        <Text> </Text>
        <Text dimColor>Mic:</Text>
        <Text color={micColor}>{micIcon}</Text>
        <Text dimColor>  {safeSessionName}</Text>
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
  grabTextMode?: boolean;
  inTalks?: boolean;
}

export function ShortcutBar({ terminalWidth = 80, ttsEnabled = true, grabTextMode = false, inTalks = false }: ShortcutBarProps) {
  const row1 = [
    { key: '^T', label: 'Talks' },
    { key: '^L', label: 'Live Chat' },
    { key: '^P', label: 'Push2Talk' },
    { key: '^V', label: ttsEnabled ? 'Voice ON' : 'Voice OFF' },
  ];
  const row2 = [
    { key: '^K', label: 'AI Model' },
    { key: '^E', label: grabTextMode ? 'End Select' : 'Select Text' },
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
