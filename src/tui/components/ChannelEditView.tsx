/**
 * Channel Edit View — edit-connection field display and edit-prompt rendering.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TalkAgent } from '../../types.js';
import { formatBindingScopeLabel, formatPostingPriority } from '../formatters.js';
import { wrapForTerminal } from './promptEditorUtils.js';
import { PromptEditor } from './PromptEditor.js';
import type { ChannelRow } from './ChannelListView.js';

type EditField = 'scope' | 'permission' | 'response' | 'posting' | 'mirror' | 'agent' | 'prompt';

interface ChannelEditConnectionProps {
  selectedRow: ChannelRow | undefined;
  activeEditField: EditField;
  editValueMode: boolean;
  editableSlackScopes: string[];
  agents: TalkAgent[];
  terminalWidth: number;
}

export function ChannelEditConnection({
  selectedRow,
  activeEditField,
  editValueMode,
  editableSlackScopes,
  agents,
  terminalWidth,
}: ChannelEditConnectionProps) {
  return (
    <>
      <Box height={1} />
      <Text bold color="cyan">Edit Connection #{selectedRow?.index ?? '?'}</Text>
      <Text dimColor>
        {editValueMode
          ? 'Value mode: \u2191/\u2193 change value  Enter done  Esc back'
          : 'Field mode: \u2191/\u2193 choose field  Enter edit field  \u2190/\u2192 choose field  Esc back'}
      </Text>
      {selectedRow ? (
        <>
          <Text color={activeEditField === 'scope' ? 'cyan' : undefined}>
            {activeEditField === 'scope' ? '\u25B8 ' : '  '}
            scope: {formatBindingScopeLabel(selectedRow.binding)}
          </Text>
          <Text color={activeEditField === 'permission' ? 'cyan' : undefined}>
            {activeEditField === 'permission' ? '\u25B8 ' : '  '}
            permission: {selectedRow.binding.permission}
          </Text>
          <Text color={activeEditField === 'response' ? 'cyan' : undefined}>
            {activeEditField === 'response' ? '\u25B8 ' : '  '}
            response mode: {selectedRow.responseMode}
          </Text>
          <Text color={activeEditField === 'posting' ? 'cyan' : undefined}>
            {activeEditField === 'posting' ? '\u25B8 ' : '  '}
            Posting Priority: {selectedRow.binding.platform === 'slack' ? formatPostingPriority(selectedRow.deliveryMode) : '(n/a)'}
          </Text>
          <Text color={activeEditField === 'mirror' ? 'cyan' : undefined}>
            {activeEditField === 'mirror' ? '\u25B8 ' : '  '}
            Slack Message Mirroring: {selectedRow.binding.platform === 'slack' ? selectedRow.mirrorToTalk : '(n/a)'}
          </Text>
          <Text color={activeEditField === 'agent' ? 'cyan' : undefined}>
            {activeEditField === 'agent' ? '\u25B8 ' : '  '}
            responder agent: {selectedRow.agentName ?? '(default primary)'}
          </Text>
          <Text color={activeEditField === 'prompt' ? 'cyan' : undefined}>
            {activeEditField === 'prompt' ? '\u25B8 ' : '  '}
            {selectedRow.binding.platform === 'slack' && selectedRow.deliveryMode === 'adaptive'
              ? 'Response Prompt (adaptive):'
              : 'Response Prompt:'}
          </Text>
          {(selectedRow.prompt?.trim()
            ? wrapForTerminal(selectedRow.prompt, Math.max(10, terminalWidth - 12))
            : ['(none)']
          ).map((line, idx) => (
            <Text key={`edit-connection-prompt-line-${idx}`} dimColor>
              {'    '}
              {line || ' '}
            </Text>
          ))}
          {selectedRow.binding.platform === 'slack' && editableSlackScopes.length > 1 && (
            <Text dimColor>Slack scopes discovered for arrows: {editableSlackScopes.length}</Text>
          )}
          {activeEditField === 'agent' && agents.length === 0 && (
            <Text dimColor>No agents configured; default primary responder is used.</Text>
          )}
        </>
      ) : (
        <Text dimColor>No selected connection.</Text>
      )}
    </>
  );
}

interface ChannelEditPromptProps {
  selectedRow: ChannelRow | undefined;
  editorWidth: number;
  maxVisibleLines: number;
  onSave: (text: string) => void;
  onCancel: () => void;
}

export function ChannelEditPrompt({
  selectedRow,
  editorWidth,
  maxVisibleLines,
  onSave,
  onCancel,
}: ChannelEditPromptProps) {
  return (
    <>
      <Box height={1} />
      <Text bold>Set Response Prompt</Text>
      {selectedRow ? (
        <Text dimColor>
          Connection #{selectedRow.index}: {selectedRow.binding.platform} {formatBindingScopeLabel(selectedRow.binding)}
        </Text>
      ) : (
        <Text dimColor>No selected connection.</Text>
      )}
      <Text dimColor>Multi-line editor (paste supported). Ctrl+S save  Enter newline  Esc cancel</Text>
      <PromptEditor
        initialValue={selectedRow?.prompt ?? ''}
        editorWidth={editorWidth}
        maxVisibleLines={maxVisibleLines}
        onSave={onSave}
        onCancel={onCancel}
        keyPrefix="edit-prompt-editor"
      />
    </>
  );
}
