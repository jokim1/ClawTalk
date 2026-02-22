/**
 * Settings Talk Tab — read-only talk configuration display.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { formatBindingScopeLabel } from '../formatters.js';

export interface TalkConfigInfo {
  objective?: string;
  directives: Array<{ text: string; active: boolean }>;
  platformBindings: Array<{
    platform: string;
    scope: string;
    displayScope?: string;
    accountId?: string;
    permission: string;
  }>;
  channelResponseSettings: Array<{
    connectionIndex: number;
    responseMode: 'off' | 'mentions' | 'all';
    agentName?: string;
    onMessagePrompt?: string;
  }>;
  jobs: Array<{ schedule: string; prompt: string; active: boolean }>;
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

      {/* Channel Connections */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Channel Connections</Text>
        {talkConfig.platformBindings.length > 0 ? (
          talkConfig.platformBindings.map((b, i) => (
            <Text key={i}>
              <Text dimColor>  {i + 1}. </Text>
              <Text>platform{i + 1}: </Text>
              <Text bold>{b.platform}</Text>
              <Text> {formatBindingScopeLabel(b)} </Text>
              <Text dimColor>({b.permission})</Text>
            </Text>
          ))
        ) : (
          <>
            <Text dimColor>  (none) — press ^B to add a channel connection</Text>
            <Text dimColor italic>  Slack full support (auto-response + connection)</Text>
            <Text dimColor italic>  Telegram/WhatsApp: connection + event jobs</Text>
            <Text dimColor italic>  Example: choose workspace "kimfamily", channel "#general", permission read+write</Text>
          </>
        )}
        <Text dimColor>  Manage via ^B Channel Config.</Text>
      </Box>

      {/* Channel Response Settings */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Channel Response Settings</Text>
        <Text dimColor>  Applies to Slack channel connections.</Text>
        {talkConfig.channelResponseSettings.length > 0 ? (
          talkConfig.channelResponseSettings.map((s) => (
            <Box key={s.connectionIndex} flexDirection="column">
              <Text>
                <Text dimColor>  {s.connectionIndex}. </Text>
                <Text>mode:</Text>
                <Text color={s.responseMode === 'off' ? 'yellow' : 'green'}>{s.responseMode}</Text>
                <Text> agent:{s.agentName ?? '(default)'}</Text>
              </Text>
              <Text dimColor>    prompt:</Text>
              {(s.onMessagePrompt?.trim() ? s.onMessagePrompt.split('\n') : ['(none)']).map((line, idx) => (
                <Text key={`settings-channel-prompt-${s.connectionIndex}-${idx}`} dimColor>
                  {'      '}
                  {line || ' '}
                </Text>
              ))}
            </Box>
          ))
        ) : (
          <Text dimColor>  (none) — add channel connections first</Text>
        )}
        <Text dimColor>  Manage via ^B Channel Config.</Text>
      </Box>

      {/* Automations */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Automations</Text>
        {talkConfig.jobs.length > 0 ? (
          talkConfig.jobs.map((j, i) => (
            <Box key={i} flexDirection="column">
              <Text>
                <Text dimColor>  {i + 1}. </Text>
                <Text color={j.active ? undefined : 'yellow'}>[{j.active ? 'active' : 'paused'}] </Text>
                <Text>"{j.schedule}"</Text>
              </Text>
              <Text dimColor>    prompt:</Text>
              {(j.prompt?.trim() ? j.prompt.split('\n') : ['(none)']).map((line, idx) => (
                <Text key={`settings-job-prompt-${i}-${idx}`} dimColor>
                  {'      '}
                  {line || ' '}
                </Text>
              ))}
            </Box>
          ))
        ) : (
          <>
            <Text dimColor>  (none) — press ^J to add an automation</Text>
            <Text dimColor italic>  Example: schedule "daily 9am", prompt "Summarize unresolved issues and owners"</Text>
          </>
        )}
        <Text dimColor>  Manage via ^J Jobs.</Text>
      </Box>
    </Box>
  );
}
