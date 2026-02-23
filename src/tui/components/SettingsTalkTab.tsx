/**
 * Settings Talk Tab — read-only talk configuration display.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface TalkConfigInfo {
  objective?: string;
  directives: Array<{ text: string; active: boolean }>;
  agents: Array<{ name: string; role: string; model: string; isPrimary: boolean }>;
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
      {/* Objectives */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Objectives</Text>
        {talkConfig.objective ? (
          <Text>  {talkConfig.objective}</Text>
        ) : (
          <>
            <Text dimColor>  (none) — /objectives {'<text>'} to set</Text>
            <Text dimColor italic>  e.g. /objectives Help me produce 3 high quality blog posts per week in my voice</Text>
          </>
        )}
        <Text dimColor>  Commands:</Text>
        <Text dimColor italic>  /objectives Ship the Q2 onboarding improvements with fewer support tickets</Text>
        <Text dimColor italic>  /objective Keep responses short and decision-focused for this project</Text>
        <Text dimColor italic>  /objective clear</Text>
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
          <>
            <Text dimColor>  (none) — /rule {'<text>'} to add</Text>
            <Text dimColor italic>  e.g. /rule Be positive and encouraging</Text>
            <Text dimColor italic>  e.g. /rule Answer Slack messages in real time</Text>
          </>
        )}
        <Text dimColor>  Commands:</Text>
        <Text dimColor italic>  /rule Keep answers under 5 bullets unless I ask for detail</Text>
        <Text dimColor italic>  /rule Include risks and assumptions in every plan</Text>
        <Text dimColor italic>  /rules   /rule toggle 1   /rule delete 2</Text>
      </Box>

      {/* Agents */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Agents</Text>
        {talkConfig.agents.length > 0 ? (
          talkConfig.agents.map((a, i) => (
            <Text key={i}>
              <Text dimColor>  {i + 1}. </Text>
              <Text bold>{a.name}</Text>
              <Text> ({a.role}) </Text>
              <Text dimColor>{a.model}</Text>
              {a.isPrimary && <Text color="cyan"> [primary]</Text>}
            </Text>
          ))
        ) : (
          <Text dimColor>  (none)</Text>
        )}
      </Box>
    </Box>
  );
}
