/**
 * Chat View Component
 *
 * Displays conversation history with proper overflow handling
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../../types';
import { getModelAlias } from '../../models.js';
import { estimateMessageLines } from '../utils.js';

interface ChatViewProps {
  messages: Message[];
  isProcessing: boolean;
  streamingContent?: string;
  modelAlias?: string;
  maxHeight?: number;
  terminalWidth?: number;
}

export function ChatView({ messages, isProcessing, streamingContent, modelAlias, maxHeight = 20, terminalWidth = 80 }: ChatViewProps) {
  const currentAiName = modelAlias || 'AI';

  const visibleMessages = useMemo(() => {
    if (!maxHeight || maxHeight < 5) return messages.slice(-3);

    let totalLines = 0;
    const processingLines = isProcessing ? 3 : 0;
    totalLines += processingLines;

    const availableHeight = maxHeight;

    const result: Message[] = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgLines = estimateMessageLines(msg.content, terminalWidth);

      // Reserve 1 line for the "... N earlier messages ..." indicator if we'd skip messages
      const indicatorLine = (i > 0) ? 1 : 0;
      if (totalLines + msgLines + indicatorLine > availableHeight) {
        break;
      }

      totalLines += msgLines;
      result.unshift(msg);
    }

    return result;
  }, [messages, maxHeight, terminalWidth, isProcessing]);

  if (messages.length === 0 && !isProcessing) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingY={1}>
        <Text dimColor>Welcome to RemoteClaw by Opus4.5 and Joseph Kim (@jokim1)</Text>
        <Text dimColor>Type a message to start chatting.</Text>
        <Box height={1} />
        <Text dimColor>Shortcuts: ^Q Model  ^N New Session  ^L Clear  ^T Transcript  ^C Exit</Text>
      </Box>
    );
  }

  const hiddenCount = messages.length - visibleMessages.length;

  return (
    <Box flexDirection="column" height={maxHeight} justifyContent="flex-end">
      {hiddenCount > 0 && (
        <Box>
          <Text dimColor>... {hiddenCount} earlier message{hiddenCount > 1 ? 's' : ''} ...</Text>
        </Box>
      )}

      {visibleMessages.map((msg) => {
        const speakerName = msg.role === 'user'
          ? 'You'
          : msg.role === 'system'
            ? 'System'
            : getModelAlias(msg.model ?? '');
        const speakerColor = msg.role === 'user' ? 'green' : msg.role === 'system' ? 'yellow' : 'cyan';

        return (
          <Box key={msg.id} marginY={0} flexDirection="column">
            <Box>
              <Text color={speakerColor} bold>
                {speakerName}:
              </Text>
            </Box>
            <Box paddingLeft={2} marginBottom={1}>
              <Text wrap="wrap">{msg.content || ' '}</Text>
            </Box>
          </Box>
        );
      })}

      {isProcessing && (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan" bold>{currentAiName}:</Text>
          </Box>
          <Box paddingLeft={2}>
            {streamingContent && streamingContent.length > 0 ? (
              <Text wrap="wrap">{streamingContent}<Text color="cyan">▌</Text></Text>
            ) : (
              <Text color="gray">thinking...</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
