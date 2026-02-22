/**
 * Multi-line prompt editor component.
 *
 * Keyboard-driven text editor with word-wrap, cursor movement across visual rows,
 * and a scrollable visible window. Used by ChannelConfigPicker and JobsConfigPicker
 * for editing response prompts and job prompts.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  buildVisualLayout,
  computeVisibleWindow,
  moveCursorByVisualRow,
  sanitizePromptInput,
} from './promptEditorUtils.js';

interface PromptEditorProps {
  initialValue: string;
  editorWidth: number;
  maxVisibleLines: number;
  onSave: (text: string) => void;
  onCancel: () => void;
  keyPrefix: string;
}

export function PromptEditor({
  initialValue,
  editorWidth,
  maxVisibleLines,
  onSave,
  onCancel,
  keyPrefix,
}: PromptEditorProps) {
  const [promptInput, setPromptInput] = useState(() => sanitizePromptInput(initialValue));
  const [promptCursor, setPromptCursor] = useState(() => sanitizePromptInput(initialValue).length);
  const [promptPreferredCol, setPromptPreferredCol] = useState<number | null>(null);

  useInput((input, key) => {
    const isBackspaceKey =
      key.backspace ||
      input === '\u0008' ||
      input === '\u007f';

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.ctrl && input.toLowerCase() === 's') {
      onSave(sanitizePromptInput(promptInput));
      return;
    }

    if (key.return) {
      const next = `${promptInput.slice(0, promptCursor)}\n${promptInput.slice(promptCursor)}`;
      setPromptInput(next);
      setPromptCursor(promptCursor + 1);
      setPromptPreferredCol(null);
      return;
    }

    const isDeleteAsBackspace = key.delete && promptCursor >= promptInput.length;
    if (isBackspaceKey || isDeleteAsBackspace) {
      if (promptCursor <= 0) return;
      const next = `${promptInput.slice(0, promptCursor - 1)}${promptInput.slice(promptCursor)}`;
      setPromptInput(next);
      setPromptCursor(promptCursor - 1);
      setPromptPreferredCol(null);
      return;
    }

    if (key.delete) {
      if (promptCursor >= promptInput.length) return;
      const next = `${promptInput.slice(0, promptCursor)}${promptInput.slice(promptCursor + 1)}`;
      setPromptInput(next);
      setPromptPreferredCol(null);
      return;
    }

    if (key.leftArrow) {
      setPromptCursor((prev) => Math.max(0, prev - 1));
      setPromptPreferredCol(null);
      return;
    }

    if (key.rightArrow) {
      setPromptCursor((prev) => Math.min(promptInput.length, prev + 1));
      setPromptPreferredCol(null);
      return;
    }

    if (key.upArrow || key.downArrow) {
      const moved = moveCursorByVisualRow(
        promptInput,
        promptCursor,
        editorWidth,
        key.upArrow ? -1 : 1,
        promptPreferredCol,
      );
      setPromptCursor(moved.cursor);
      setPromptPreferredCol(moved.preferredCol);
      return;
    }

    if (input) {
      const safeInput = sanitizePromptInput(input);
      if (!safeInput) return;
      const next = `${promptInput.slice(0, promptCursor)}${safeInput}${promptInput.slice(promptCursor)}`;
      setPromptInput(next);
      setPromptCursor(promptCursor + safeInput.length);
      setPromptPreferredCol(null);
    }
  });

  const layout = buildVisualLayout(promptInput, promptCursor, editorWidth);
  const window = computeVisibleWindow(layout.lines.length, layout.cursorRow, maxVisibleLines);

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      {window.start > 0 && <Text dimColor>{'\u25B2'} more</Text>}
      {layout.lines.slice(window.start, window.end).map((line, idx) => {
        const row = window.start + idx;
        if (row !== layout.cursorRow) {
          return <Text key={`${keyPrefix}-${row}`}>{line.text || ' '}</Text>;
        }
        const col = Math.max(0, Math.min(layout.cursorCol, line.text.length));
        const before = line.text.slice(0, col);
        const hasChar = col < line.text.length;
        const at = hasChar ? line.text[col] : ' ';
        const after = hasChar ? line.text.slice(col + 1) : '';
        return (
          <Text key={`${keyPrefix}-${row}`}>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        );
      })}
      {window.end < layout.lines.length && <Text dimColor>{'\u25BC'} more</Text>}
    </Box>
  );
}
