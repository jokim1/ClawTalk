/**
 * Input Area Component
 *
 * Text input with > prompt, or voice recording/processing indicator
 */

import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { VoiceMode } from '../../types.js';

interface InputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  voiceMode?: VoiceMode;
  volumeLevel?: number;
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

export function InputArea({ value, onChange, onSubmit, disabled, voiceMode, volumeLevel }: InputAreaProps) {
  if (voiceMode === 'recording') {
    return (
      <Box paddingX={1}>
        <Text color="red">● </Text>
        <Text color="red" bold>Recording...</Text>
        <VolumeMeter level={volumeLevel ?? 0} />
        <Text dimColor>  ^V send  Esc cancel</Text>
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

  return (
    <Box paddingX={1}>
      <Text color="green">&gt; </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
}
