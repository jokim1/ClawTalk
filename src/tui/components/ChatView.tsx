/**
 * Chat View Component
 *
 * Uses Ink's Static component to output messages to terminal scrollback.
 * Scroll up in your terminal to see full chat history.
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
    <Box flexDirection="column">
      <Text color={speakerColor} bold>{speakerName}:</Text>
      <Box paddingLeft={2}>
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
}: ChatViewProps) {
  const currentAiName = modelAlias || 'AI';

  // Track which messages have been output to Static
  const outputCountRef = useRef(0);

  // Get new messages that haven't been output yet
  const newMessages = messages.slice(outputCountRef.current);

  // Update count after render
  useEffect(() => {
    outputCountRef.current = messages.length;
  }, [messages.length]);

  // Show welcome text until there's user input
  const hasUserInput = messages.some(m => m.role === 'user');
  const systemMessages = messages.filter(m => m.role === 'system');

  if (!hasUserInput && !isProcessing) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text dimColor>Welcome to RemoteClaw by Opus4.5 and Joseph Kim (@jokim1)</Text>
        <Text dimColor>Type a message to start chatting.</Text>
        <Text> </Text>
        <Text dimColor>Scroll up in your terminal to see full chat history.</Text>
        <Text> </Text>
        <Text dimColor>^T Talks  ^N New  ^C Chat  ^P PTT  ^V Voice  ^H History  ^S Settings</Text>
        <Text> </Text>
        {systemMessages.map((msg) => (
          <Box key={msg.id}>
            <Text color="yellow">{msg.content}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Static: Messages output to terminal scrollback - scroll up to see history */}
      <Static items={newMessages}>
        {(msg) => (
          <Box key={msg.id}>
            <MessageItem msg={msg} />
          </Box>
        )}
      </Static>

      {/* Dynamic: Current streaming response */}
      {isProcessing && (
        <Box flexDirection="column">
          <Text color="cyan" bold>{currentAiName}:</Text>
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
