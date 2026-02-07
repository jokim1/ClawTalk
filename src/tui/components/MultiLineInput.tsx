/**
 * Multi-Line Text Input Component
 *
 * Custom text input that properly handles cursor navigation in wrapped text.
 * Unlike ink-text-input, this tracks cursor position correctly across visual lines.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

interface MultiLineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  width: number;
  isActive?: boolean;
  /** Maximum visible lines. When text exceeds this, show the portion around the cursor. */
  maxVisibleLines?: number;
}

export function MultiLineInput({
  value,
  onChange,
  onSubmit,
  width,
  isActive = true,
  maxVisibleLines,
}: MultiLineInputProps) {
  const [cursorPos, setCursorPos] = useState(value.length);

  // Keep cursor in bounds when value changes externally
  useEffect(() => {
    if (cursorPos > value.length) {
      setCursorPos(value.length);
    }
  }, [value, cursorPos]);

  useInput(
    (input, key) => {
      if (!isActive) return;

      // Submit on Enter
      if (key.return) {
        onSubmit(value);
        return;
      }

      // Handle backspace
      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          const newValue = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
          onChange(newValue);
          setCursorPos(cursorPos - 1);
        }
        return;
      }

      // Arrow keys for navigation
      if (key.leftArrow) {
        setCursorPos(Math.max(0, cursorPos - 1));
        return;
      }

      if (key.rightArrow) {
        setCursorPos(Math.min(value.length, cursorPos + 1));
        return;
      }

      // Up/Down arrows move by visual line width
      if (key.upArrow) {
        const newPos = cursorPos - width;
        setCursorPos(Math.max(0, newPos));
        return;
      }

      if (key.downArrow) {
        const newPos = cursorPos + width;
        setCursorPos(Math.min(value.length, newPos));
        return;
      }

      // Home/End keys (Ctrl+A / Ctrl+E)
      if (input === 'a' && key.ctrl) {
        setCursorPos(0);
        return;
      }

      if (input === 'e' && key.ctrl) {
        setCursorPos(value.length);
        return;
      }

      // Delete character at cursor (Ctrl+D)
      if (input === 'd' && key.ctrl) {
        if (cursorPos < value.length) {
          const newValue = value.slice(0, cursorPos) + value.slice(cursorPos + 1);
          onChange(newValue);
        }
        return;
      }

      // Kill line from cursor (Ctrl+K)
      if (input === 'k' && key.ctrl) {
        const newValue = value.slice(0, cursorPos);
        onChange(newValue);
        return;
      }

      // Clear line (Ctrl+U)
      if (input === 'u' && key.ctrl) {
        onChange('');
        setCursorPos(0);
        return;
      }

      // Regular character input (including pasted text)
      // Filter out control characters but allow normal typing and paste
      if (input && !key.ctrl && !key.meta) {
        // Filter out any control characters from the input
        const printable = input.split('').filter(c => c.charCodeAt(0) >= 32).join('');
        if (printable.length > 0) {
          const newValue = value.slice(0, cursorPos) + printable + value.slice(cursorPos);
          onChange(newValue);
          setCursorPos(cursorPos + printable.length);
        }
      }
    },
    { isActive }
  );

  // Render the text with cursor
  const beforeCursor = value.slice(0, cursorPos);
  const atCursor = value[cursorPos] || ' ';
  const afterCursor = value.slice(cursorPos + 1);

  // When maxVisibleLines is set, Ink's Box height clips the overflow.
  // The dynamic inputLines calculation in app.tsx handles growing/shrinking.
  if (maxVisibleLines) {
    return (
      <Box height={maxVisibleLines}>
        <Text wrap="wrap">
          {beforeCursor}
          <Text inverse>{atCursor}</Text>
          {afterCursor}
        </Text>
      </Box>
    );
  }

  return (
    <Text wrap="wrap">
      {beforeCursor}
      <Text inverse>{atCursor}</Text>
      {afterCursor}
    </Text>
  );
}
