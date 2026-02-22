/**
 * Channel List View — connection list and confirm-delete rendering.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { PlatformBinding } from '../../types.js';
import { formatBindingScopeLabel, formatPostingPriority } from '../formatters.js';
import { wrapForTerminal } from './promptEditorUtils.js';

export interface ChannelRow {
  index: number;
  binding: PlatformBinding;
  responseMode: string;
  deliveryMode: 'thread' | 'channel' | 'adaptive' | undefined;
  mirrorToTalk: string;
  agentName?: string;
  prompt?: string;
}

interface ChannelListViewProps {
  rows: ChannelRow[];
  selectedIndex: number;
  visibleStart: number;
  visibleEnd: number;
  terminalWidth: number;
}

export function ChannelListView({
  rows,
  selectedIndex,
  visibleStart,
  visibleEnd,
  terminalWidth,
}: ChannelListViewProps) {
  const selectedRow = rows[selectedIndex];

  return (
    <>
      <Text dimColor>{'↑/↓ select connection  Enter edit  a add  d delete  p prompt  c clear  r refresh Slack  Esc/^B close'}</Text>
      <Box height={1} />

      <Text bold color="cyan">Connections</Text>
      {rows.length === 0 ? (
        <Text dimColor>{'  No channel connections yet. Press "a" to add one.'}</Text>
      ) : (
        <>
          {Array.from({ length: visibleEnd - visibleStart }, (_, offset) => {
            const idx = visibleStart + offset;
            const row = rows[idx];
            if (!row) return null;
            const isSelected = idx === selectedIndex;
            return (
              <Text key={row.binding.id} color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '\u25B8 ' : '  '}
                {row.index}. {row.binding.platform} {formatBindingScopeLabel(row.binding)}
              </Text>
            );
          })}
          {visibleEnd < rows.length && <Text dimColor>{'  \u25BC more'}</Text>}
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
            {selectedRow.binding.platform === 'slack' ? formatPostingPriority(selectedRow.deliveryMode) : '(n/a)'}
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
  );
}

interface ChannelConfirmDeleteProps {
  rowIndex: number | undefined;
}

export function ChannelConfirmDelete({ rowIndex }: ChannelConfirmDeleteProps) {
  return (
    <>
      <Box height={1} />
      <Text color="yellow">
        Delete connection #{rowIndex ?? '?'}? Press Enter or y to confirm, n to cancel.
      </Text>
    </>
  );
}
