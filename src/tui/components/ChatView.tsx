/**
 * Chat View Component
 *
 * Displays conversation history using Ink's Static component for terminal scrollback.
 * Completed messages go into terminal scrollback (scroll up to see full history).
 * Only the current streaming response stays in the dynamic area.
 */

import React, { useRef, useEffect } from 'react';
import { Box, Text, Static } from 'ink';
import type { Message } from '../../types';
import { getModelAlias } from '../../models.js';

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

/** Render a single message */
function MessageItem({ msg }: { msg: Message }) {
  const speakerName = msg.role === 'user'
    ? 'You'
    : msg.role === 'system'
      ? 'System'
      : getModelAlias(msg.model ?? '');
  const speakerColor = msg.role === 'user' ? 'green' : msg.role === 'system' ? 'yellow' : 'cyan';

  return (
    <Box marginY={0} flexDirection="column">
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
}

export function ChatView({
  messages,
  isProcessing,
  streamingContent,
  modelAlias,
  maxHeight = 20,
}: ChatViewProps) {
  const currentAiName = modelAlias || 'AI';

  // Track which messages have been rendered to Static (by ID)
  const renderedIdsRef = useRef<Set<string>>(new Set());

  // Determine which messages are "completed" and should go to Static
  // All messages except the very last one during streaming
  const completedMessages = isProcessing ? messages : messages;

  // Find new messages that haven't been rendered to Static yet
  const newMessages = completedMessages.filter(msg => !renderedIdsRef.current.has(msg.id));

  // Update rendered IDs after this render
  useEffect(() => {
    for (const msg of completedMessages) {
      renderedIdsRef.current.add(msg.id);
    }
  }, [completedMessages]);

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
        <Text dimColor>Scroll up in terminal to see full chat history.</Text>
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

  return (
    <Box flexDirection="column" height={maxHeight} justifyContent="flex-end">
      {/* Static: Messages go into terminal scrollback - scroll up to see full history */}
      <Static items={newMessages}>
        {(msg) => (
          <Box key={msg.id}>
            <MessageItem msg={msg} />
          </Box>
        )}
      </Static>

      {/* Dynamic: Shows streaming content while AI is responding */}
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
