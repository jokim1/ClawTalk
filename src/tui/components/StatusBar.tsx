/**
 * Status Bar Component
 *
 * Nano-style: info at top, shortcuts at bottom
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { UsageStats, ModelStatus, RateLimitWindow, VoiceMode } from '../../types';
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
  voiceEnabled?: boolean;
}

export function StatusBar({ model, modelStatus, usage, gatewayStatus, tailscaleStatus, billing, sessionName, terminalWidth = 80, voiceMode, voiceEnabled }: StatusBarProps) {
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

  const todayCost = usage.todaySpend !== undefined ? `$${usage.todaySpend.toFixed(2)}` : '$0.00';
  const avgCost = usage.averageDailySpend !== undefined ? `$${usage.averageDailySpend.toFixed(2)}` : '$0.00';

  const hasApiCost = usage.modelPricing !== undefined && !isSubscription;
  const apiCost = hasApiCost
    ? `$${usage.modelPricing!.inputPer1M}/$${usage.modelPricing!.outputPer1M} per 1M`
    : null;

  return (
    <Box flexDirection="column" width="100%">
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          <Text dimColor>GW:</Text><Text color={gatewayColor}>{gateway} </Text>
          <Text dimColor>TS:</Text><Text color={tsColor}>{tsIcon} </Text>
          <Text dimColor>M:</Text><Text color={modelColor} bold>{modelName}{modelIndicator}</Text>

          {voiceEnabled ? (
            <Text>
              <Text dimColor>  V:</Text>
              <Text color={
                voiceMode === 'recording' ? 'red' :
                voiceMode === 'transcribing' || voiceMode === 'synthesizing' ? 'yellow' :
                voiceMode === 'playing' ? 'magenta' :
                'green'
              }>
                {voiceMode === 'recording' ? '● REC' :
                 voiceMode === 'transcribing' ? '◐ STT' :
                 voiceMode === 'synthesizing' ? '◐ TTS' :
                 voiceMode === 'playing' ? '♪ PLAY' :
                 '●'}
              </Text>
            </Text>
          ) : null}

          {isSubscription ? (
            (() => {
              const rl = usage.rateLimits;
              const weekly = rl?.weekly;
              const session = rl?.session;

              if (weekly || session) {
                const primary = weekly ?? session!;
                const pct = primary.limit > 0 ? Math.round((primary.used / primary.limit) * 100) : 0;
                const barWidth = 10;
                const filled = Math.min(barWidth, Math.round((pct / 100) * barWidth));
                const empty = barWidth - filled;
                const barColor = pct > 90 ? 'red' : pct > 70 ? 'yellow' : 'green';
                const resetLabel = formatResetTime(primary.resetsAt);
                const windowLabel = weekly ? 'wk' : 'sess';

                return (
                  <>
                    <Text dimColor>  {billing?.plan ?? 'Sub'}  </Text>
                    <Text color={barColor}>{'█'.repeat(filled)}</Text>
                    <Text dimColor>{'░'.repeat(empty)}</Text>
                    <Text> </Text>
                    <Text color={barColor}>{pct}% {windowLabel}</Text>
                    {pct >= 100 ? (
                      <Text color="red" bold>  PAUSED</Text>
                    ) : null}
                    <Text dimColor>  Resets {resetLabel}</Text>
                  </>
                );
              }

              return (
                <>
                  <Text dimColor>  {billing?.plan ?? 'Sub'} </Text>
                  <Text>${billing?.monthlyPrice ?? '?'}/mo</Text>
                </>
              );
            })()
          ) : (
            <>
              {hasApiCost ? (
                <>
                  <Text dimColor>  API: </Text>
                  <Text>{apiCost}</Text>
                </>
              ) : null}
              <Text dimColor>  Today: </Text>
              <Text>{todayCost}</Text>
              <Text dimColor> (Avg {avgCost})</Text>
            </>
          )}
        </Box>

        <Box>
          {sessionName ? (
            <Text dimColor>{sessionName}</Text>
          ) : null}
        </Box>
      </Box>

      <Box>
        <Text dimColor>{'─'.repeat(Math.max(1, terminalWidth))}</Text>
      </Box>
    </Box>
  );
}

interface ShortcutBarProps {
  terminalWidth?: number;
  voiceEnabled?: boolean;
}

export function ShortcutBar({ terminalWidth = 80, voiceEnabled }: ShortcutBarProps) {
  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text dimColor>{'─'.repeat(Math.max(1, terminalWidth))}</Text>
      </Box>

      <Box paddingX={1} justifyContent="space-between">
        <Box>
          <Text inverse> ^Q </Text>
          <Text> Model  </Text>
        </Box>
        <Box>
          <Text inverse> ^N </Text>
          <Text> New  </Text>
        </Box>
        <Box>
          <Text inverse> ^L </Text>
          <Text> Clear  </Text>
        </Box>
        <Box>
          <Text inverse> ^T </Text>
          <Text> Transcript  </Text>
        </Box>
        {voiceEnabled ? (
          <Box>
            <Text inverse> ^V </Text>
            <Text> Voice  </Text>
          </Box>
        ) : null}
        <Box>
          <Text inverse> ^C </Text>
          <Text> Exit</Text>
        </Box>
      </Box>
    </Box>
  );
}
