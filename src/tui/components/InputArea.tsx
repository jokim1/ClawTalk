/**
 * Input Area Component
 *
 * Text input with > prompt, or voice recording/processing indicator
 */

import React from 'react';
import { Box, Text } from 'ink';
import { MultiLineInput } from './MultiLineInput.js';
import type { VoiceMode, RealtimeVoiceState } from '../../types.js';

interface InputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  voiceMode?: VoiceMode;
  volumeLevel?: number;
  width?: number;
  isActive?: boolean;
  // Realtime voice props
  realtimeState?: RealtimeVoiceState;
  userTranscript?: string;
  aiTranscript?: string;
}

function VolumeMeter({ level }: { level: number }) {
  const barWidth = 12;
  const filled = Math.min(barWidth, Math.round((level / 100) * barWidth));
  const empty = barWidth - filled;
  const color = level > 90 ? 'red' : level > 70 ? 'yellow' : 'green';
  return (
    <>
      <Text dimColor>  [</Text>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text dimColor>]</Text>
    </>
  );
}

export function InputArea({
  value,
  onChange,
  onSubmit,
  disabled,
  voiceMode,
  volumeLevel,
  width = 80,
  isActive = true,
  realtimeState,
  userTranscript,
  aiTranscript,
}: InputAreaProps) {
  // Realtime live chat mode with transcripts
  if (voiceMode === 'liveChat') {
    const isAISpeaking = realtimeState === 'aiSpeaking';
    const dotColor = isAISpeaking ? 'cyan' : 'green';

    return (
      <Box flexDirection="column">
        {/* Live transcripts */}
        {userTranscript && (
          <Box paddingX={1}>
            <Text color="green" bold>You: </Text>
            <Text color="green">{userTranscript}</Text>
          </Box>
        )}
        {aiTranscript && (
          <Box paddingX={1}>
            <Text color="cyan" bold>AI: </Text>
            <Text color="cyan">{aiTranscript}</Text>
          </Box>
        )}
        {/* Status bar */}
        <Box paddingX={1}>
          <Text color={dotColor}>● </Text>
          <Text color="cyan" bold>Live Chat...</Text>
          <VolumeMeter level={volumeLevel ?? 0} />
          <Text dimColor>  ^C to end</Text>
        </Box>
      </Box>
    );
  }

  if (voiceMode === 'recording') {
    return (
      <Box paddingX={1}>
        <Text color="red">● </Text>
        <Text color="red" bold>Recording...</Text>
        <VolumeMeter level={volumeLevel ?? 0} />
        <Text dimColor>  ^P to send  Esc cancel</Text>
      </Box>
    );
  }

  if (voiceMode === 'transcribing') {
    return (
      <Box paddingX={1}>
        <Text color="yellow">◐ </Text>
        <Text color="yellow">Transcribing...</Text>
      </Box>
    );
  }

  if (voiceMode === 'synthesizing') {
    return (
      <Box paddingX={1}>
        <Text color="yellow">◐ </Text>
        <Text color="yellow">Generating speech...</Text>
      </Box>
    );
  }

  if (voiceMode === 'playing') {
    return (
      <Box paddingX={1}>
        <Text color="magenta">♪ </Text>
        <Text color="magenta">Speaking...</Text>
        <Text dimColor>  ^V stop</Text>
      </Box>
    );
  }

  if (disabled) {
    return (
      <Box paddingX={1}>
        <Text color="yellow">&gt; </Text>
        <Text dimColor>Waiting for response...</Text>
      </Box>
    );
  }

  // Calculate available width for input (subtract padding and prompt)
  const inputWidth = Math.max(10, width - 4);

  return (
    <Box paddingX={1}>
      <Text color="green">&gt; </Text>
      <MultiLineInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        width={inputWidth}
        isActive={isActive}
      />
    </Box>
  );
}
