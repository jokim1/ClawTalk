/**
 * Settings Talk Tab — read-only talk configuration fallback display.
 *
 * Shown when the interactive TalkConfigPicker is not available
 * (e.g. no active talk or settings opened from Talks Hub).
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface TalkConfigInfo {
  objective?: string;
  directives: Array<{ text: string; active: boolean }>;
}

interface SettingsTalkTabProps {
  talkConfig: TalkConfigInfo | null | undefined;
}

export function SettingsTalkTab({ talkConfig }: SettingsTalkTabProps) {
  if (!talkConfig) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No active talk. Open or create a talk first.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Objective */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Objective</Text>
        {talkConfig.objective ? (
          <Text>  {talkConfig.objective}</Text>
        ) : (
          <Text dimColor>  (none)</Text>
        )}
      </Box>

      {/* Rules */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Rules</Text>
        {talkConfig.directives.length > 0 ? (
          talkConfig.directives.map((d, i) => (
            <Text key={i}>
              <Text dimColor>  {i + 1}. </Text>
              <Text color={d.active ? undefined : 'yellow'}>[{d.active ? 'active' : 'paused'}] </Text>
              <Text>{d.text}</Text>
            </Text>
          ))
        ) : (
          <Text dimColor>  (none)</Text>
        )}
      </Box>
    </Box>
  );
}
