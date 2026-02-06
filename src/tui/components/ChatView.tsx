/**
 * ChatView Component
 *
 * Scrollable message area with accurate line counting.
 * Renders visible messages based on scroll offset and available height.
 * Uses wrap-ansi for accurate word-wrap-aware line counting.
 */

import React, { useMemo, memo } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../../types.js';
import { getModelAlias } from '../../models.js';
import { formatElapsed } from '../utils.js';

// wrap-ansi v6 is a CJS dependency of Ink, available in node_modules
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wrapAnsi = require('wrap-ansi') as (input: string, columns: number, options?: { hard?: boolean; wordWrap?: boolean; trim?: boolean }) => string;

interface ChatViewProps {
  messages: Message[];
  streamingContent: string;
  isProcessing: boolean;
  processingStartTime: number | null;
  scrollOffset: number;
  availableHeight: number;
  width: number;
  currentModel: string;
  pinnedMessageIds?: string[];
}

/**
 * Count how many visual terminal lines a string occupies when wrapped to `width`.
 * Uses wrap-ansi for accurate ANSI-aware word wrapping (same as Ink uses internally).
 */
function countVisualLines(text: string, width: number): number {
  if (!text || width <= 0) return 0;
  const wrapped = wrapAnsi(text, width, { hard: true, wordWrap: true, trim: false });
  const lines = wrapped.split('\n');
  return lines.length;
}

/** How many visual lines a message occupies (speaker line + indented content) */
function messageVisualLines(msg: Message, width: number): number {
  const speakerName = msg.role === 'user'
    ? 'You'
    : msg.role === 'system'
      ? 'System'
      : getModelAlias(msg.model ?? '');

  // Speaker line: "Name:" — always 1 line
  const speakerLines = countVisualLines(`${speakerName}:`, width);

  // Content indented by 2 chars
  const contentWidth = Math.max(10, width - 2);
  const content = msg.content || ' ';
  const contentLines = countVisualLines(content, contentWidth);

  return speakerLines + contentLines;
}

interface VisibleSlice {
  /** Index of the first visible message in the array */
  startIndex: number;
  /** The messages to render */
  messages: Message[];
  /** Number of messages above the visible area */
  hiddenAbove: number;
  /** Number of messages below the visible area (when scrolled up) */
  hiddenBelow: number;
  /** Lines consumed by visible messages */
  linesUsed: number;
  /** Lines to skip from the top of the first visible message (when it overflows) */
  firstMessageSkipLines: number;
}

/**
 * Compute which messages are visible given the scroll position and available height.
 *
 * scrollOffset is measured in messages (not lines) — 0 means "show the bottom".
 * We walk from the bottom up, fitting messages into the available height.
 */
function computeVisibleMessages(
  messages: Message[],
  scrollOffset: number,
  availableHeight: number,
  width: number,
): VisibleSlice {
  if (messages.length === 0 || availableHeight <= 0) {
    return { startIndex: 0, messages: [], hiddenAbove: 0, hiddenBelow: 0, linesUsed: 0, firstMessageSkipLines: 0 };
  }

  // Bottom boundary: skip the last `scrollOffset` messages
  const bottomIndex = messages.length - scrollOffset;
  if (bottomIndex <= 0) {
    // Scrolled past all messages
    return { startIndex: 0, messages: [], hiddenAbove: 0, hiddenBelow: messages.length, linesUsed: 0, firstMessageSkipLines: 0 };
  }

  // Walk backwards from bottomIndex, accumulating lines
  let linesUsed = 0;
  let startIndex = bottomIndex;
  let firstMessageSkipLines = 0;

  for (let i = bottomIndex - 1; i >= 0; i--) {
    const msgLines = messageVisualLines(messages[i], width);
    if (linesUsed + msgLines > availableHeight) {
      if (linesUsed === 0) {
        // Single message exceeds viewport — show bottom portion
        firstMessageSkipLines = msgLines - availableHeight;
        linesUsed = availableHeight;
        startIndex = i;
      } else {
        // Fill remaining viewport with partial view of this message
        const remaining = availableHeight - linesUsed;
        if (remaining >= 2) {
          firstMessageSkipLines = msgLines - remaining;
          linesUsed = availableHeight;
          startIndex = i;
        }
      }
      break;
    }
    linesUsed += msgLines;
    startIndex = i;
  }

  const effectiveLinesUsed = Math.min(linesUsed, availableHeight);

  const visibleMessages = messages.slice(startIndex, bottomIndex);
  const hiddenAbove = startIndex + (firstMessageSkipLines > 0 ? 1 : 0); // partially visible counts as hidden
  const hiddenBelow = scrollOffset;

  return {
    startIndex,
    messages: visibleMessages,
    hiddenAbove,
    hiddenBelow,
    linesUsed: effectiveLinesUsed,
    firstMessageSkipLines,
  };
}

export function ChatView({
  messages,
  streamingContent,
  isProcessing,
  processingStartTime,
  scrollOffset,
  availableHeight,
  width,
  currentModel,
  pinnedMessageIds = [],
}: ChatViewProps) {
  const pinnedSet = useMemo(() => new Set(pinnedMessageIds), [pinnedMessageIds]);
  const contentWidth = Math.max(10, width - 2); // account for paddingX={1}

  // Welcome header: 3 lines (welcome + instructions + blank line)
  // Shown when not scrolled past it
  const welcomeLines = 3;

  // Reserve lines for streaming content and indicators
  let reservedLines = welcomeLines;

  // If processing and at bottom (scrollOffset === 0), reserve space for streaming
  if (isProcessing && scrollOffset === 0) {
    // Speaker line (1) + streaming content + processing timer (1)
    const streamLines = streamingContent
      ? 1 + countVisualLines(streamingContent, contentWidth - 2) // -2 for inner padding
      : 1 + 1; // speaker + "thinking..."
    const timerLine = processingStartTime ? 1 : 0;
    reservedLines += streamLines + timerLine;
  }

  const heightForMessages = Math.max(0, availableHeight - reservedLines);

  const slice = useMemo(
    () => computeVisibleMessages(messages, scrollOffset, heightForMessages, contentWidth),
    [messages, scrollOffset, heightForMessages, contentWidth],
  );

  // Adjust available height accounting for indicators
  const showUpIndicator = slice.hiddenAbove > 0;
  const showDownIndicator = slice.hiddenBelow > 0;
  const indicatorLines = (showUpIndicator ? 1 : 0) + (showDownIndicator ? 1 : 0);

  // If indicators would push us over, recompute with less space
  // (This is a minor edge case — usually indicators fit within the flexGrow area)

  // Cap streaming display
  const maxStreamLines = Math.max(4, availableHeight - slice.linesUsed - indicatorLines - 2);
  const cappedStreaming = useMemo(() => {
    if (!streamingContent) return '';
    const streamWidth = Math.max(10, contentWidth - 4); // paddingX + paddingLeft
    const wrapped = wrapAnsi(streamingContent, streamWidth, { hard: true, wordWrap: true, trim: false });
    const lines = wrapped.split('\n');
    if (lines.length <= maxStreamLines) return streamingContent;
    return lines.slice(-maxStreamLines).join('\n');
  }, [streamingContent, maxStreamLines, contentWidth]);

  // Only show welcome header when all messages fit on screen (not scrolled past it)
  const showWelcome = slice.hiddenAbove === 0;

  return (
    <Box flexDirection="column" height={availableHeight} paddingX={1}>
      {/* Welcome header (persistent at top when not scrolled) */}
      {showWelcome && (
        <Box flexDirection="column">
          <Text dimColor>Welcome to ClawTalk by Opus4.5 and Joseph Kim (@jokim1)</Text>
          <Text dimColor>Type a message to start chatting.</Text>
          <Text> </Text>
        </Box>
      )}

      {/* Scroll-up indicator */}
      {showUpIndicator && (
        <Text dimColor> {'\u25b2'} {slice.hiddenAbove} earlier message{slice.hiddenAbove !== 1 ? 's' : ''}</Text>
      )}

      {/* Visible messages */}
      {slice.messages.map((msg, idx) => (
        <MessageBlock
          key={msg.id}
          message={msg}
          isPinned={pinnedSet.has(msg.id)}
          skipLines={idx === 0 ? slice.firstMessageSkipLines : 0}
          contentWidth={contentWidth}
        />
      ))}

      {/* Streaming content (only when at bottom and processing) */}
      {isProcessing && scrollOffset === 0 && (
        <Box flexDirection="column">
          <Text color="cyan" bold>{getModelAlias(currentModel)}:</Text>
          <Box paddingLeft={2}>
            {cappedStreaming ? (
              <Text wrap="wrap">{cappedStreaming}<Text color="cyan">{'\u258c'}</Text></Text>
            ) : (
              <Text color="gray">thinking...</Text>
            )}
          </Box>
        </Box>
      )}

      {/* Processing timer */}
      {processingStartTime && scrollOffset === 0 && (
        <Text dimColor>* Waiting for {formatElapsed(processingStartTime)}</Text>
      )}

      {/* Spacer to push content up when there's extra space */}
      <Box flexGrow={1} />

      {/* Scroll-down indicator */}
      {showDownIndicator && (
        <Text dimColor> {'\u25bc'} scrolled up {slice.hiddenBelow} message{slice.hiddenBelow !== 1 ? 's' : ''}</Text>
      )}
    </Box>
  );
}

/** Render a single message (speaker + indented content) */
function MessageBlock({ message, isPinned, skipLines = 0, contentWidth = 80 }: {
  message: Message;
  isPinned?: boolean;
  skipLines?: number;
  contentWidth?: number;
}) {
  const speakerName = message.role === 'user'
    ? 'You'
    : message.role === 'system'
      ? 'System'
      : getModelAlias(message.model ?? '');

  const speakerColor = message.role === 'user'
    ? 'green'
    : message.role === 'system'
      ? 'yellow'
      : 'cyan';

  // When skipLines > 0, truncate content from the top to fit available space
  const content = useMemo(() => {
    if (skipLines <= 0) return message.content || ' ';
    const innerWidth = Math.max(10, contentWidth - 2);
    const wrapped = wrapAnsi(message.content || ' ', innerWidth, { hard: true, wordWrap: true, trim: false });
    const lines = wrapped.split('\n');
    // Skip speaker line(s) first, then content lines
    const speakerLineCount = countVisualLines(`${speakerName}:`, contentWidth);
    const contentSkip = Math.max(0, skipLines - speakerLineCount);
    if (contentSkip >= lines.length) return lines[lines.length - 1] || ' ';
    return lines.slice(contentSkip).join('\n');
  }, [message.content, skipLines, contentWidth, speakerName]);

  // Hide speaker line if it's entirely within the skipped region
  const speakerLineCount = skipLines > 0 ? countVisualLines(`${speakerName}:`, contentWidth) : 0;
  const showSpeaker = skipLines < speakerLineCount || skipLines === 0;

  return (
    <Box flexDirection="column">
      {showSpeaker && (
        <Text color={speakerColor} bold>{speakerName}:{isPinned ? ' \uD83D\uDCCC' : ''}</Text>
      )}
      <Box paddingLeft={2}>
        <Text wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}
