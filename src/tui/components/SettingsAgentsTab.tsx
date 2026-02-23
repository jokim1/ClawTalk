/**
 * Settings Agents Tab — read-only agents display.
 *
 * Extracted from SettingsTalkTab. Shows agent list with name, role, model,
 * and primary badge. Displays slash-command hints for agent management.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface AgentsTabInfo {
  agents: Array<{ name: string; role: string; model: string; isPrimary: boolean }>;
}

interface SettingsAgentsTabProps {
  agentsInfo: AgentsTabInfo | null | undefined;
}

export function SettingsAgentsTab({ agentsInfo }: SettingsAgentsTabProps) {
  if (!agentsInfo) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No active talk. Open or create a talk first.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Agents</Text>
      {agentsInfo.agents.length > 0 ? (
        agentsInfo.agents.map((a, i) => (
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
      <Box height={1} />
      <Text dimColor>  Commands:</Text>
      <Text dimColor italic>  /agent add — add agent from model picker</Text>
      <Text dimColor italic>  /agent remove {'<name>'} — remove an agent</Text>
      <Text dimColor italic>  /agent role {'<name>'} — change agent role</Text>
    </Box>
  );
}
