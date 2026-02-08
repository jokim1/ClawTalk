/**
 * ChatView Component
 *
 * Scrollable message area with line-based scrolling.
 * scrollOffset is measured in visual LINES (not messages).
 * All text is pre-wrapped to guarantee line count === rendered lines.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Message, AgentRole } from '../../types.js';
import { getModelAlias } from '../../models.js';
import { formatElapsed } from '../utils.js';
import { preWrapText, countVisualLines, getSpeakerName } from '../lineCount.js';

/** Map agent roles to speaker colors */
const ROLE_COLORS: Record<AgentRole, string> = {
  analyst: 'cyan',
  critic: 'red',
  strategist: 'blue',
  'devils-advocate': 'magenta',
  synthesizer: 'green',
  editor: 'yellow',
};

interface ChatViewProps {
  messages: Message[];
  /** Pre-computed visual line count for each message (same length as messages) */
  messageLinesArray: number[];
  streamingContent: string;
  isProcessing: boolean;
  processingStartTime: number | null;
  /** Scroll offset in visual lines (0 = bottom) */
  scrollOffset: number;
  availableHeight: number;
  width: number;
  currentModel: string;
  pinnedMessageIds?: string[];
  /** Agent name to show during streaming (for multi-agent) */
  streamingAgentName?: string;
}

interface VisibleSlice {
  startIndex: number;
  endIndex: number;
  messages: Message[];
  /** Number of messages fully hidden above the visible area */
  hiddenAbove: number;
  /** Whether there's content hidden below the visible area */
  hasContentBelow: boolean;
  /** Lines to skip from the top of the first visible message */
  firstMessageSkipLines: number;
  /** Lines to show from the last visible message (0 = show all) */
  lastMessageShowLines: number;
  /** Total visual lines that will be rendered */
  linesUsed: number;
}

/**
 * Compute which messages are visible given a LINE-BASED scroll offset.
 *
 * scrollOffset = number of visual lines scrolled up from the bottom.
 * We compute the visible "window" of lines and map it back to messages.
 */
function computeVisibleMessages(
  messages: Message[],
  lineCounts: number[],
  scrollOffset: number,
  availableHeight: number,
): VisibleSlice {
  const empty: VisibleSlice = {
    startIndex: 0, endIndex: 0, messages: [],
    hiddenAbove: 0, hasContentBelow: false,
    firstMessageSkipLines: 0, lastMessageShowLines: 0, linesUsed: 0,
  };

  if (messages.length === 0 || availableHeight <= 0) return empty;

  const totalLines = lineCounts.reduce((s, c) => s + c, 0);
  if (totalLines === 0) return empty;

  // The visible window in terms of absolute line positions:
  // bottomLine = last visible line (exclusive), topLine = first visible line (inclusive)
  const bottomLine = Math.max(0, totalLines - scrollOffset);
  const topLine = Math.max(0, bottomLine - availableHeight);

  if (bottomLine <= 0) return empty;

  // Walk through messages to find which ones overlap [topLine, bottomLine)
  let cumulative = 0;
  let startMsgIdx = -1;
  let endMsgIdx = -1;
  let firstMessageSkipLines = 0;
  let lastMessageShowLines = 0;

  for (let i = 0; i < messages.length; i++) {
    const msgStart = cumulative;
    const msgEnd = cumulative + lineCounts[i];

    // Does this message overlap the visible window?
    if (msgEnd > topLine && msgStart < bottomLine) {
      if (startMsgIdx === -1) {
        startMsgIdx = i;
        firstMessageSkipLines = Math.max(0, topLine - msgStart);
      }
      endMsgIdx = i + 1;

      // If this message extends past bottomLine, we can only show part of it
      if (msgEnd > bottomLine) {
        lastMessageShowLines = bottomLine - msgStart;
      } else {
        lastMessageShowLines = 0; // show all lines of this message
      }
    }

    cumulative += lineCounts[i];
    if (msgStart >= bottomLine) break;
  }

  if (startMsgIdx === -1) return empty;

  // Count fully hidden messages above (not counting partially visible first message)
  const hiddenAbove = startMsgIdx;
  const hasContentBelow = scrollOffset > 0;

  // Calculate actual lines used
  let linesUsed = 0;
  for (let i = startMsgIdx; i < endMsgIdx; i++) {
    let msgLines = lineCounts[i];

    // Subtract skipped lines from first message
    if (i === startMsgIdx && firstMessageSkipLines > 0) {
      msgLines -= firstMessageSkipLines;
    }

    // Subtract hidden bottom lines from last message
    if (i === endMsgIdx - 1 && lastMessageShowLines > 0) {
      // lastMessageShowLines = total lines from msg start to show
      // But we may have also skipped some from the top (if same message)
      const fullMsgLines = lineCounts[i];
      const hiddenBottom = fullMsgLines - lastMessageShowLines;
      msgLines -= hiddenBottom;
    }

    linesUsed += msgLines;
  }
  linesUsed = Math.max(0, Math.min(linesUsed, availableHeight));

  return {
    startIndex: startMsgIdx,
    endIndex: endMsgIdx,
    messages: messages.slice(startMsgIdx, endMsgIdx),
    hiddenAbove,
    hasContentBelow,
    firstMessageSkipLines,
    lastMessageShowLines,
    linesUsed,
  };
}

export function ChatView({
  messages,
  messageLinesArray,
  streamingContent,
  isProcessing,
  processingStartTime,
  scrollOffset,
  availableHeight,
  width,
  currentModel,
  pinnedMessageIds = [],
  streamingAgentName,
}: ChatViewProps) {
  const pinnedSet = useMemo(() => new Set(pinnedMessageIds), [pinnedMessageIds]);
  const contentWidth = Math.max(10, width - 2); // account for paddingX={1}

  const totalMessageLines = useMemo(
    () => messageLinesArray.reduce((s, c) => s + c, 0),
    [messageLinesArray],
  );

  // --- Compute height budget in a single stable pass ---

  let heightBudget = availableHeight;

  // Streaming reservation (only when processing and at bottom)
  let streamReservedLines = 0;
  if (isProcessing && scrollOffset === 0) {
    const streamWidth = Math.max(10, contentWidth - 2);
    const streamLines = streamingContent
      ? 1 + countVisualLines(streamingContent, streamWidth)
      : 2; // speaker + "thinking..."
    const timerLine = processingStartTime ? 1 : 0;
    streamReservedLines = streamLines + timerLine;
    heightBudget = Math.max(0, heightBudget - streamReservedLines);
  }

  // Welcome: show only if all messages + welcome fit and we're at the bottom
  const welcomeLines = 3;
  const showWelcome = scrollOffset === 0 && totalMessageLines + welcomeLines + streamReservedLines <= availableHeight;
  if (showWelcome) {
    heightBudget = Math.max(0, heightBudget - welcomeLines);
  }

  // Pre-determine scroll indicators to avoid two-pass oscillation.
  // needDown is purely scroll-position based.
  // needUp accounts for the down indicator's line when checking if content is hidden above.
  const needDown = scrollOffset > 0;
  const needUp = totalMessageLines > scrollOffset + (heightBudget - (needDown ? 1 : 0));
  const indicatorLines = (needDown ? 1 : 0) + (needUp ? 1 : 0);
  const messageBudget = Math.max(0, heightBudget - indicatorLines);

  // Single-pass computation (no recompute needed)
  const slice = useMemo(
    () => computeVisibleMessages(messages, messageLinesArray, scrollOffset, messageBudget),
    [messages, messageLinesArray, scrollOffset, messageBudget],
  );

  const showUpIndicator = needUp;
  const showDownIndicator = needDown;

  // Cap streaming display to remaining space
  const remainingForStream = Math.max(0, availableHeight - slice.linesUsed - indicatorLines - (showWelcome ? welcomeLines : 0));
  const maxStreamLines = Math.max(1, Math.min(remainingForStream, streamReservedLines));
  const cappedStreaming = useMemo(() => {
    if (!streamingContent) return '';
    const streamWidth = Math.max(10, contentWidth - 4);
    const wrapped = preWrapText(streamingContent, streamWidth);
    const lines = wrapped.split('\n');
    if (lines.length <= maxStreamLines) return wrapped;
    return lines.slice(-maxStreamLines).join('\n');
  }, [streamingContent, maxStreamLines, contentWidth]);

  // hiddenAbove count for display: include partial first message
  const displayHiddenAbove = slice.hiddenAbove + (slice.firstMessageSkipLines > 0 ? 1 : 0);

  return (
    <Box flexDirection="column" height={availableHeight} paddingX={1}>
      {/* Welcome header (only when all messages fit on screen) */}
      {showWelcome && (
        <Box flexDirection="column">
          <Text dimColor>Welcome to ClawTalk by Opus4.5 and Joseph Kim (@jokim1)</Text>
          <Text dimColor>Type a message to start chatting.</Text>
          <Text> </Text>
        </Box>
      )}

      {/* Scroll-up indicator */}
      {showUpIndicator && (
        <Text dimColor> {'\u25b2'} {displayHiddenAbove} earlier message{displayHiddenAbove !== 1 ? 's' : ''}</Text>
      )}

      {/* Visible messages */}
      {slice.messages.map((msg, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === slice.messages.length - 1;
        const skipLines = isFirst ? slice.firstMessageSkipLines : 0;
        const showLines = isLast && slice.lastMessageShowLines > 0
          ? slice.lastMessageShowLines
          : 0;

        return (
          <MessageBlock
            key={msg.id}
            message={msg}
            isPinned={pinnedSet.has(msg.id)}
            skipLines={skipLines}
            showLines={showLines}
            contentWidth={contentWidth}
          />
        );
      })}

      {/* Streaming content (only when at bottom and processing) */}
      {isProcessing && scrollOffset === 0 && (
        <Box flexDirection="column">
          <Text color="cyan" bold>{streamingAgentName ?? getModelAlias(currentModel)}:</Text>
          <Box paddingLeft={2}>
            {cappedStreaming ? (
              <Text>{cappedStreaming}<Text color="cyan">{'\u258c'}</Text></Text>
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

      {/* Spacer to push down indicator to bottom */}
      <Box flexGrow={1} />

      {/* Scroll-down indicator */}
      {showDownIndicator && (
        <Text dimColor> {'\u25bc'} more below</Text>
      )}
    </Box>
  );
}

/**
 * Render a single message with pre-wrapped text.
 *
 * skipLines: lines to skip from the START of the message (top clipping)
 * showLines: total lines from message START to show (bottom clipping, 0 = show all)
 *
 * When both apply (single message spans entire viewport):
 *   visible = lines from skipLines to showLines
 */
function MessageBlock({ message, isPinned, skipLines = 0, showLines = 0, contentWidth = 80 }: {
  message: Message;
  isPinned?: boolean;
  skipLines?: number;
  showLines?: number;
  contentWidth?: number;
}) {
  const speakerName = getSpeakerName(message);

  const speakerColor = message.role === 'user'
    ? 'green'
    : message.role === 'system'
      ? 'yellow'
      : (message.agentRole ? ROLE_COLORS[message.agentRole] : 'cyan');

  const innerWidth = Math.max(10, contentWidth - 2);

  // Pre-wrap content to exact width (guarantees line count matches rendering)
  const fullWrapped = useMemo(
    () => preWrapText(message.content || ' ', innerWidth),
    [message.content, innerWidth],
  );

  const rendered = useMemo(() => {
    const speakerLineCount = countVisualLines(`${speakerName}:`, contentWidth);
    const contentLines = fullWrapped.split('\n');

    // Determine visible range in terms of absolute message lines (speaker + content)
    // line 0..speakerLineCount-1 = speaker, speakerLineCount..end = content
    const visibleStart = skipLines; // first visible line from message start
    const visibleEnd = showLines > 0 ? showLines : speakerLineCount + contentLines.length;

    // Speaker visibility
    const showSpeaker = visibleStart < speakerLineCount;

    // Content line range
    const contentStart = Math.max(0, visibleStart - speakerLineCount);
    const contentEnd = Math.max(0, visibleEnd - speakerLineCount);
    const clampedStart = Math.min(contentStart, contentLines.length);
    const clampedEnd = Math.min(contentEnd, contentLines.length);

    const text = clampedEnd > clampedStart
      ? contentLines.slice(clampedStart, clampedEnd).join('\n')
      : '';

    return { text, showSpeaker };
  }, [fullWrapped, skipLines, showLines, speakerName, contentWidth]);

  return (
    <Box flexDirection="column">
      {rendered.showSpeaker && (
        <Text color={speakerColor} bold>{speakerName}:{isPinned ? ' \uD83D\uDCCC' : ''}</Text>
      )}
      {rendered.text.length > 0 && (
        <Box paddingLeft={2}>
          <Text>{rendered.text}</Text>
        </Box>
      )}
    </Box>
  );
}
