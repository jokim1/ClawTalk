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
  ttsEnabled?: boolean;
}

export function StatusBar({ model, modelStatus, usage, gatewayStatus, tailscaleStatus, billing, sessionName, terminalWidth = 80, voiceMode, voiceReadiness, ttsEnabled = true }: StatusBarProps) {
  const modelName = getModelAlias(model);
  const modelIndicator = modelStatus === 'checking' ? ' ◐' : '';
  const isSubscription = billing?.mode === 'subscription';

  const gateway = gatewayStatus === 'online' ? '●' : gatewayStatus === 'connecting' ? '◐' : '○';
  const tsIcon = tailscaleStatus === 'connected' ? '●' : '○';
  const micIcon = voiceReadiness === 'ready' ? '●' : voiceReadiness === 'checking' ? '◐' : '○';
  const isVoiceActive = voiceMode === 'playing' || voiceMode === 'synthesizing';
  const ttsIcon = isVoiceActive ? (voiceMode === 'playing' ? '♪' : '◐') : ttsEnabled ? '●' : '○';

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

  // Build fixed-width line: pad to exact terminal width to prevent layout shifts
  const leftPart = `GW:${gateway} TS:${tsIcon} M:${modelName}${modelIndicator}  ${billingText}`;
  const rightPart = `V:${ttsIcon} Mic:${micIcon}  ${sessionName ?? ''}`;
  const gap = Math.max(2, terminalWidth - leftPart.length - rightPart.length - 2);

  // Create exact-width string (prevents Yoga from recalculating layout)
  let fullLine = ' ' + leftPart + ' '.repeat(gap) + rightPart + ' ';
  if (fullLine.length > terminalWidth) {
    fullLine = fullLine.slice(0, terminalWidth);
  } else if (fullLine.length < terminalWidth) {
    fullLine = fullLine + ' '.repeat(terminalWidth - fullLine.length);
  }

  const separator = '─'.repeat(terminalWidth);

  // Render as raw text lines - no flexbox, no dynamic layout
  // Using a single Text with newlines is more stable than multiple Box elements
  return (
    <Box width={terminalWidth} height={3}>
      <Text>{'\n' + fullLine + '\n' + separator}</Text>
    </Box>
  );
}

interface ShortcutBarProps {
  terminalWidth?: number;
  ttsEnabled?: boolean;
}

export function ShortcutBar({ terminalWidth = 80, ttsEnabled = true }: ShortcutBarProps) {
  const shortcuts = [
    { key: '^T', label: 'Talks' },
    { key: '^C', label: 'Chat' },
    { key: '^P', label: 'PTT' },
    { key: '^V', label: ttsEnabled ? 'Voice OFF' : 'Voice ON' },
    { key: '^H', label: 'History' },
    { key: '^S', label: 'Settings' },
    { key: '^X', label: 'Exit' },
  ];

  // Calculate total content width and distribute spacing evenly
  const items = shortcuts.map(s => ({ key: s.key, label: s.label, width: s.key.length + 2 + 1 + s.label.length })); // "[^T] Label"
  const totalContentWidth = items.reduce((sum, i) => sum + i.width, 0);
  const numGaps = shortcuts.length + 1; // gaps on both ends and between items
  const totalSpacing = Math.max(0, terminalWidth - totalContentWidth);
  const gapSize = Math.floor(totalSpacing / numGaps);
  const extraSpaces = totalSpacing - (gapSize * numGaps);

  // Build evenly distributed shortcut line
  let shortcutLine = ' '.repeat(gapSize + (extraSpaces > 0 ? 1 : 0));
  let extraUsed = extraSpaces > 0 ? 1 : 0;
  items.forEach((item, i) => {
    shortcutLine += `[${item.key}] ${item.label}`;
    if (i < items.length - 1) {
      const extra = extraUsed < extraSpaces ? 1 : 0;
      if (extra) extraUsed++;
      shortcutLine += ' '.repeat(gapSize + extra);
    }
  });
  // Pad to exact width
  if (shortcutLine.length < terminalWidth) {
    shortcutLine += ' '.repeat(terminalWidth - shortcutLine.length);
  }

  const separator = '─'.repeat(terminalWidth);

  return (
    <Box width={terminalWidth} height={2}>
      <Text dimColor>{separator + '\n' + shortcutLine}</Text>
    </Box>
  );
}
