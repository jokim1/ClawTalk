/**
 * Talk Config Picker
 *
 * Interactive editor for talk objective and rules (directives).
 * Embeds into SettingsPicker as the "Talk Config" tab content.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PromptEditor } from './PromptEditor.js';
import { wrapForTerminal } from './promptEditorUtils.js';

export interface TalkConfigEmbedProps {
  maxHeight: number;
  terminalWidth: number;
  objective: string | undefined;
  directives: Array<{ text: string; active: boolean }>;
  onSetObjective: (text: string | undefined) => void;
  onAddDirective: (text: string) => void;
  onEditDirective: (index: number, text: string) => void;
  onToggleDirective: (index: number) => void;
  onRemoveDirective: (index: number) => void;
}

interface TalkConfigPickerProps extends TalkConfigEmbedProps {
  onClose: () => void;
  onTabLeft: () => void;
  onTabRight: () => void;
  embedded?: boolean;
}

type Mode = 'list' | 'edit-objective' | 'edit-rule' | 'add-rule' | 'confirm-delete';

export function TalkConfigPicker({
  maxHeight,
  terminalWidth,
  objective,
  directives,
  onSetObjective,
  onAddDirective,
  onEditDirective,
  onToggleDirective,
  onRemoveDirective,
  onClose,
  onTabLeft,
  onTabRight,
}: TalkConfigPickerProps) {
  const [mode, setMode] = useState<Mode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);

  // index 0 = objective, index 1+ = rules (1-based directive index = selectedIndex)
  const totalItems = 1 + directives.length;

  const isObjectiveSelected = selectedIndex === 0;
  const selectedRuleIndex = selectedIndex; // 1-based directive index when selectedIndex >= 1

  const promptEditorWidth = Math.max(10, terminalWidth - 12);
  const promptEditorMaxLines = Math.max(4, maxHeight - 12);

  useInput((input, key) => {
    // Editor modes handle their own input
    if (mode === 'edit-objective' || mode === 'edit-rule' || mode === 'add-rule') {
      return;
    }

    if (key.escape) {
      if (mode === 'list') onClose();
      else setMode('list');
      return;
    }

    if (input === 's' && key.ctrl) {
      onClose();
      return;
    }

    if (mode === 'confirm-delete') {
      if (key.return || input.toLowerCase() === 'y') {
        onRemoveDirective(selectedRuleIndex);
        setStatusMessage(`Rule #${selectedRuleIndex} deleted.`);
        // Adjust cursor if we deleted the last item
        if (selectedIndex >= totalItems - 1 && selectedIndex > 0) {
          setSelectedIndex(selectedIndex - 1);
        }
        setMode('list');
        return;
      }
      if (input.toLowerCase() === 'n') {
        setMode('list');
      }
      return;
    }

    // list mode
    if (key.leftArrow) { onTabLeft(); return; }
    if (key.rightArrow) { onTabRight(); return; }

    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(totalItems - 1, prev + 1));
      return;
    }

    if (key.return) {
      if (isObjectiveSelected) {
        setEditorKey(prev => prev + 1);
        setMode('edit-objective');
      } else {
        setEditorKey(prev => prev + 1);
        setMode('edit-rule');
      }
      return;
    }

    if (input === 'a') {
      setEditorKey(prev => prev + 1);
      setMode('add-rule');
      return;
    }

    if ((input === 't' || input === ' ') && !isObjectiveSelected) {
      onToggleDirective(selectedRuleIndex);
      const d = directives[selectedRuleIndex - 1];
      const nextStatus = d?.active ? 'paused' : 'active';
      setStatusMessage(`Rule #${selectedRuleIndex} ${nextStatus}.`);
      return;
    }

    if (input === 'd' && !isObjectiveSelected) {
      setMode('confirm-delete');
      return;
    }

    if (input === 'x' && isObjectiveSelected) {
      onSetObjective(undefined);
      setStatusMessage('Objective cleared.');
      return;
    }
  });

  // --- Rendering ---

  if (mode === 'edit-objective') {
    return (
      <Box flexDirection="column">
        <Text bold>Edit Objective</Text>
        <Text dimColor>Ctrl+S save  Esc cancel  (empty saves clears objective)</Text>
        <PromptEditor
          key={`obj-editor-${editorKey}`}
          initialValue={objective ?? ''}
          editorWidth={promptEditorWidth}
          maxVisibleLines={promptEditorMaxLines}
          onSave={(text) => {
            const trimmed = text.trim();
            onSetObjective(trimmed || undefined);
            setStatusMessage(trimmed ? 'Objective updated.' : 'Objective cleared.');
            setMode('list');
          }}
          onCancel={() => setMode('list')}
          keyPrefix="obj-editor"
        />
      </Box>
    );
  }

  if (mode === 'edit-rule') {
    const rule = directives[selectedRuleIndex - 1];
    return (
      <Box flexDirection="column">
        <Text bold>Edit Rule #{selectedRuleIndex}</Text>
        <Text dimColor>Ctrl+S save  Esc cancel</Text>
        <PromptEditor
          key={`rule-editor-${editorKey}`}
          initialValue={rule?.text ?? ''}
          editorWidth={promptEditorWidth}
          maxVisibleLines={promptEditorMaxLines}
          onSave={(text) => {
            const trimmed = text.trim();
            if (!trimmed) {
              setStatusMessage('Rule text cannot be empty. Use "d" to delete.');
              return;
            }
            onEditDirective(selectedRuleIndex, trimmed);
            setStatusMessage(`Rule #${selectedRuleIndex} updated.`);
            setMode('list');
          }}
          onCancel={() => setMode('list')}
          keyPrefix="rule-editor"
        />
      </Box>
    );
  }

  if (mode === 'add-rule') {
    return (
      <Box flexDirection="column">
        <Text bold>Add Rule</Text>
        <Text dimColor>Ctrl+S save  Esc cancel</Text>
        <PromptEditor
          key={`add-rule-editor-${editorKey}`}
          initialValue=""
          editorWidth={promptEditorWidth}
          maxVisibleLines={promptEditorMaxLines}
          onSave={(text) => {
            const trimmed = text.trim();
            if (!trimmed) {
              setStatusMessage('Rule text cannot be empty.');
              return;
            }
            onAddDirective(trimmed);
            setStatusMessage('Rule added.');
            setMode('list');
            setSelectedIndex(1 + directives.length); // select the newly added rule
          }}
          onCancel={() => setMode('list')}
          keyPrefix="add-rule-editor"
        />
      </Box>
    );
  }

  // list mode (and confirm-delete overlay)
  const objectiveLines = objective
    ? wrapForTerminal(objective, Math.max(10, terminalWidth - 10))
    : [];
  const maxObjectiveDisplayLines = 3;

  return (
    <Box flexDirection="column">
      <Text dimColor>{'\u2191'}/{'\u2193'} select  {'\u2190'}/{'\u2192'} tabs  Enter edit  a add  t toggle  d delete  x clear obj  Esc close</Text>
      <Box height={1} />

      {/* Objective */}
      <Text bold>Objective</Text>
      <Text color={isObjectiveSelected ? 'cyan' : undefined}>
        {isObjectiveSelected ? '\u25B8 ' : '  '}
        {objective
          ? objectiveLines.slice(0, maxObjectiveDisplayLines).join('\n  ') +
            (objectiveLines.length > maxObjectiveDisplayLines ? '...' : '')
          : '(none)'}
      </Text>
      <Box height={1} />

      {/* Rules */}
      <Text bold>Rules</Text>
      {directives.length > 0 ? (
        directives.map((d, i) => {
          const ruleIdx = i + 1;
          const isSelected = selectedIndex === ruleIdx;
          return (
            <Text key={i} color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '\u25B8 ' : '  '}
              {ruleIdx}. <Text color={d.active ? undefined : 'yellow'}>[{d.active ? 'active' : 'paused'}]</Text> {d.text}
            </Text>
          );
        })
      ) : (
        <Text dimColor>  (none) — press "a" to add a rule</Text>
      )}

      {mode === 'confirm-delete' && (
        <>
          <Box height={1} />
          <Text color="yellow">Delete rule #{selectedRuleIndex}? Press Enter or y to confirm, n to cancel.</Text>
        </>
      )}

      {statusMessage && (
        <>
          <Box height={1} />
          <Text color="green">{statusMessage}</Text>
        </>
      )}
    </Box>
  );
}
