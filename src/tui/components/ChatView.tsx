/**
 * Chat View Component
 *
 * Displays conversation history with scrolling support.
 * Shows all messages - use arrow keys/Page Up/Down to scroll.
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

/** Streaming text component that shows only the tail end fitting within maxHeight */
function StreamingText({ content, width, maxHeight }: { content: string; width: number; maxHeight: number }) {
  // Split content into lines and only show what fits
  const lines = content.split('\n');
  const displayLines: string[] = [];
  let lineCount = 0;

  // Work backwards from the end to show most recent content
  for (let i = lines.length - 1; i >= 0 && lineCount < maxHeight; i--) {
    const line = lines[i];
    const wrappedLines = Math.max(1, Math.ceil(line.length / Math.max(1, width)));
    if (lineCount + wrappedLines <= maxHeight) {
      displayLines.unshift(line);
      lineCount += wrappedLines;
    } else if (lineCount < maxHeight) {
      // Partial line - truncate from beginning
      const charsToShow = (maxHeight - lineCount) * width;
      displayLines.unshift('...' + line.slice(-charsToShow));
      break;
    }
  }

  const displayContent = displayLines.join('\n');
  return <Text wrap="wrap">{displayContent}<Text color="cyan">▌</Text></Text>;
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
      onScroll(Math.min(scrollOffset + 3, maxScrollOffset));
    } else if (key.downArrow) {
      onScroll(Math.max(scrollOffset - 3, 0));
    } else if (key.pageUp) {
      onScroll(Math.min(scrollOffset + maxHeight, maxScrollOffset));
    } else if (key.pageDown) {
      onScroll(Math.max(scrollOffset - maxHeight, 0));
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
      return { visibleMessages: messages.slice(-3), hiddenAbove: Math.max(0, messages.length - 3), hiddenBelow: 0 };
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
      const msgLines = messageLineInfo[i]?.lines ?? 3;
      if (skipLines >= msgLines) {
        skipLines -= msgLines;
        endIdx = i;
      } else {
        break;
      }
    }

    // Reserve space for "newer messages" indicator if we've scrolled up
    const hasNewerMessages = endIdx < messages.length;
    if (hasNewerMessages) {
      linesUsed += 1;
    }

    // Now collect messages that fit in the view
    const result: Message[] = [];
    let startIdx = endIdx;

    for (let i = endIdx - 1; i >= 0; i--) {
      const msgLines = messageLineInfo[i]?.lines ?? 3;

      // Reserve 1 line for "earlier messages" indicator only if this isn't the first message
      const needsTopIndicator = i > 0;
      const indicatorLine = needsTopIndicator ? 1 : 0;
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
  const systemMessages = messages.filter(m => m.role === 'system');

  if (!hasUserInput && !isProcessing) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {/* Show welcome text first */}
        <Text dimColor>Welcome to RemoteClaw by Opus4.5 and Joseph Kim (@jokim1)</Text>
        <Text dimColor>Type a message to start chatting.</Text>
        <Text> </Text>
        <Text dimColor>Additional Shortcuts: ^A Change AI Model  ^Y New Terminal</Text>
        <Text> </Text>
        <Text dimColor>Scroll: ↑/↓ arrows, Page Up/Down, g/G for top/bottom</Text>
        <Text> </Text>
        <Text dimColor>Talk Commands: /save to save chat to Talks, /topic "name" to set topic</Text>
        <Text> </Text>
        <Text dimColor>^T Talks - List of saved discussion topics</Text>
        <Text dimColor>^N New Chat - Start fresh with new context</Text>
        <Text dimColor>^C Live Chat - Streamed real-time voice conversation</Text>
        <Text dimColor>^P PTT - Push to Talk, send voice memos to AI</Text>
        <Text dimColor>^V Voice ON/OFF - Toggle AI voice responses</Text>
        <Text dimColor>^H History - See transcript of past talks</Text>
        <Text dimColor>^S Settings - Modify terminal settings</Text>
        <Text> </Text>
        {/* Show system messages (like "Model is ready") at the bottom */}
        {systemMessages.map((msg) => (
          <Box key={msg.id}>
            <Text color="yellow">{msg.content}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  const showProcessing = isProcessing && scrollOffset === 0;

  return (
    <Box flexDirection="column" height={maxHeight} justifyContent="flex-end">
      {hiddenAbove > 0 && (
        <Box>
          <Text dimColor>↑ {hiddenAbove} earlier message{hiddenAbove > 1 ? 's' : ''} (↑/PgUp to scroll)</Text>
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
            <Box paddingLeft={2}>
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
              <StreamingText content={streamingContent} width={terminalWidth - 6} maxHeight={maxHeight - 3} />
            ) : (
              <Text color="gray">thinking...</Text>
            )}
          </Box>
        </Box>
      )}

      {hiddenBelow > 0 && (
        <Box>
          <Text dimColor>↓ {hiddenBelow} newer message{hiddenBelow > 1 ? 's' : ''} (↓/PgDn to scroll)</Text>
        </Box>
      )}
    </Box>
  );
}
