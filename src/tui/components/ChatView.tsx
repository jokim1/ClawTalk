/**
 * Chat View Component
 *
 * Displays conversation history with scrolling support
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
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
  scrollOffset?: number;
  onScroll?: (offset: number) => void;
  isActive?: boolean;
}

export function ChatView({
  messages,
  isProcessing,
  streamingContent,
  modelAlias,
  maxHeight = 20,
  terminalWidth = 80,
  scrollOffset = 0,
  onScroll,
  isActive = true,
}: ChatViewProps) {
  const currentAiName = modelAlias || 'AI';

  // Calculate line info for all messages
  const messageLineInfo = useMemo(() => {
    return messages.map(msg => ({
      msg,
      lines: estimateMessageLines(msg.content, terminalWidth),
    }));
  }, [messages, terminalWidth]);

  // Total content height
  const totalContentLines = useMemo(() => {
    let total = messageLineInfo.reduce((sum, info) => sum + info.lines, 0);
    if (isProcessing) total += 3; // Processing indicator
    return total;
  }, [messageLineInfo, isProcessing]);

  // Maximum scroll offset (0 = bottom, positive = scrolled up)
  const maxScrollOffset = Math.max(0, totalContentLines - maxHeight);

  // Handle keyboard input for scrolling
  useInput((input, key) => {
    if (!isActive || !onScroll) return;

    if (key.upArrow) {
      onScroll(Math.min(scrollOffset + 1, maxScrollOffset));
    } else if (key.downArrow) {
      onScroll(Math.max(scrollOffset - 1, 0));
    } else if (key.pageUp) {
      onScroll(Math.min(scrollOffset + Math.floor(maxHeight / 2), maxScrollOffset));
    } else if (key.pageDown) {
      onScroll(Math.max(scrollOffset - Math.floor(maxHeight / 2), 0));
    } else if (input === 'g' && key.shift) {
      // Shift+G: scroll to top (oldest messages)
      onScroll(maxScrollOffset);
    } else if (input === 'g') {
      // g: scroll to bottom (newest messages)
      onScroll(0);
    }
  }, { isActive });

  // Calculate which messages to show based on scroll offset
  const { visibleMessages, hiddenAbove, hiddenBelow } = useMemo(() => {
    if (!maxHeight || maxHeight < 5) {
      return { visibleMessages: messages.slice(-3), hiddenAbove: messages.length - 3, hiddenBelow: 0 };
    }

    // We render from bottom up, so scrollOffset=0 means showing the latest messages
    // scrollOffset>0 means we've scrolled up to see older messages

    const availableHeight = maxHeight;
    let linesUsed = 0;

    // Account for processing indicator if showing bottom (scrollOffset=0) and processing
    const showProcessing = isProcessing && scrollOffset === 0;
    if (showProcessing) {
      linesUsed += 3;
    }

    // Start from the end and work backwards, skipping messages covered by scrollOffset
    let skipLines = scrollOffset;
    let endIdx = messages.length;

    // Skip lines from the bottom based on scroll offset
    for (let i = messages.length - 1; i >= 0 && skipLines > 0; i--) {
      const msgLines = messageLineInfo[i].lines;
      if (skipLines >= msgLines) {
        skipLines -= msgLines;
        endIdx = i;
      } else {
        // Partial message skip - for simplicity, include the whole message
        break;
      }
    }

    // Now collect messages that fit in the view
    const result: Message[] = [];
    let startIdx = endIdx;

    for (let i = endIdx - 1; i >= 0; i--) {
      const msgLines = messageLineInfo[i].lines;

      // Reserve 1 line for scroll indicator if we'd hide messages
      const indicatorLine = (i > 0 || scrollOffset > 0) ? 1 : 0;
      if (linesUsed + msgLines + indicatorLine > availableHeight) {
        break;
      }

      linesUsed += msgLines;
      result.unshift(messages[i]);
      startIdx = i;
    }

    return {
      visibleMessages: result,
      hiddenAbove: startIdx,
      hiddenBelow: messages.length - endIdx,
    };
  }, [messages, messageLineInfo, maxHeight, isProcessing, scrollOffset]);

  // Show welcome text until there's user input (not just system messages)
  const hasUserInput = messages.some(m => m.role === 'user');
  if (!hasUserInput && !isProcessing) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingY={1}>
        <Text dimColor>Welcome to RemoteClaw by Opus4.5 and Joseph Kim (@jokim1)</Text>
        <Text dimColor>Type a message to start chatting.</Text>
        <Box height={1} />
        <Text dimColor>Shortcuts: ^T Talks  ^C Chat  ^P PTT  ^V Voice  ^H History  ^S Settings  ^X Exit</Text>
        <Text dimColor>Also: ^A AI Model  ^N New Terminal</Text>
        <Text dimColor>Scroll: ↑/↓ arrows, Page Up/Down, g/G for top/bottom</Text>
      </Box>
    );
  }

  const showProcessing = isProcessing && scrollOffset === 0;

  return (
    <Box flexDirection="column" height={maxHeight} justifyContent="flex-end">
      {hiddenAbove > 0 && (
        <Box>
          <Text dimColor>↑ {hiddenAbove} earlier message{hiddenAbove > 1 ? 's' : ''} (scroll up to see)</Text>
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

      {showProcessing && (
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

      {hiddenBelow > 0 && (
        <Box>
          <Text dimColor>↓ {hiddenBelow} newer message{hiddenBelow > 1 ? 's' : ''} (scroll down to see)</Text>
        </Box>
      )}
    </Box>
  );
}
