/**
 * Edit Messages Component
 *
 * Scrollable message list for selectively deleting messages.
 * Modeled on the TalksHub navigation pattern.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Message } from '../../types';

interface EditMessagesProps {
  messages: Message[];
  maxHeight: number;
  terminalWidth: number;
  onClose: () => void;
  onConfirm: (messageIds: string[]) => void;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenTalks: () => void;
  onOpenSettings: () => void;
  onExit: () => void;
  setError: (error: string) => void;
}

export function EditMessages({
  messages,
  maxHeight,
  terminalWidth,
  onClose,
  onConfirm,
  onNewChat,
  onToggleTts,
  onOpenTalks,
  onOpenSettings,
  onExit,
  setError,
}: EditMessagesProps) {
  // Filter out system messages (not deletable)
  const editableMessages = useMemo(
    () => messages.filter(m => m.role !== 'system'),
    [messages],
  );

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [markedForDeletion, setMarkedForDeletion] = useState<Set<string>>(new Set());

  const visibleRows = Math.max(3, maxHeight - 5); // title + blank + footer + count + blank

  const ensureVisible = (idx: number) => {
    setScrollOffset(prev => {
      if (idx < prev) return idx;
      if (idx >= prev + visibleRows) return idx - visibleRows + 1;
      return prev;
    });
  };

  useInput((input, key) => {
    // Global shortcuts
    if (input === 't' && key.ctrl) { onOpenTalks(); return; }
    if (input === 'n' && key.ctrl) { onNewChat(); return; }
    if (input === 'v' && key.ctrl) { onToggleTts(); return; }
    if (input === 's' && key.ctrl) { onOpenSettings(); return; }
    if (input === 'x' && key.ctrl) { onExit(); return; }
    if ((input === 'c' || input === 'p') && key.ctrl) {
      setError('You can only use voice input in a Talk!');
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(prev => {
        const next = Math.max(0, prev - 1);
        ensureVisible(next);
        return next;
      });
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(prev => {
        const next = Math.min(editableMessages.length - 1, prev + 1);
        ensureVisible(next);
        return next;
      });
      return;
    }

    // Left/right arrow for page up/down
    if (key.leftArrow) {
      setSelectedIndex(prev => {
        const next = Math.max(0, prev - visibleRows);
        ensureVisible(next);
        return next;
      });
      return;
    }

    if (key.rightArrow) {
      setSelectedIndex(prev => {
        const next = Math.min(editableMessages.length - 1, prev + visibleRows);
        ensureVisible(next);
        return next;
      });
      return;
    }

    // 'd' toggles mark for deletion
    if (input === 'd' || input === 'D') {
      const msg = editableMessages[selectedIndex];
      if (msg) {
        setMarkedForDeletion(prev => {
          const next = new Set(prev);
          if (next.has(msg.id)) {
            next.delete(msg.id);
          } else {
            next.add(msg.id);
          }
          return next;
        });
      }
      return;
    }

    // Enter confirms deletion
    if (key.return) {
      if (markedForDeletion.size === 0) {
        setError('No messages marked for deletion. Press d to mark.');
        return;
      }
      onConfirm(Array.from(markedForDeletion));
      return;
    }
  });

  if (editableMessages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">Edit Messages</Text>
        <Box height={1} />
        <Text dimColor>No editable messages.</Text>
        <Box height={1} />
        <Text dimColor>  Esc Close</Text>
      </Box>
    );
  }

  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(editableMessages.length, scrollOffset + visibleRows);
  const hasMore = visibleEnd < editableMessages.length;
  const hasLess = scrollOffset > 0;
  const maxPreviewWidth = Math.max(20, terminalWidth - 30);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Edit Messages</Text>
      <Box height={1} />

      {hasLess && <Text dimColor>  {'\u25B2'} more</Text>}

      {Array.from({ length: visibleEnd - visibleStart }, (_, i) => {
        const actualIndex = visibleStart + i;
        const msg = editableMessages[actualIndex];
        if (!msg) return null;

        const isSelected = actualIndex === selectedIndex;
        const isMarked = markedForDeletion.has(msg.id);
        const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const role = msg.role === 'user' ? 'You' : msg.agentName ?? 'AI';
        const preview = msg.content.split('\n')[0];
        const truncated = preview.length > maxPreviewWidth
          ? preview.slice(0, maxPreviewWidth) + '...'
          : preview;

        return (
          <Box key={msg.id}>
            <Text color={isMarked ? 'red' : isSelected ? 'cyan' : undefined}>
              {isSelected ? '> ' : '  '}
              {isMarked ? 'x ' : '  '}
              <Text dimColor>{time}</Text>
              <Text> </Text>
              <Text bold={isSelected}>{role}:</Text>
              <Text> {truncated}</Text>
            </Text>
          </Box>
        );
      })}

      {hasMore && <Text dimColor>  {'\u25BC'} more</Text>}

      <Box height={1} />
      {markedForDeletion.size > 0 && (
        <Text color="yellow">  {markedForDeletion.size} message{markedForDeletion.size !== 1 ? 's' : ''} marked for deletion</Text>
      )}
      <Text dimColor>  {'\u2191\u2193'} Navigate  {'\u2190\u2192'} Page  d Mark/Unmark  Enter Delete Marked  Esc Cancel</Text>
    </Box>
  );
}
