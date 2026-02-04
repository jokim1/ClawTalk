/**
 * Talks Hub Component
 *
 * WhatsApp-style saved conversations list.
 * Shows explicitly saved talks (via /save command) sorted by updatedAt.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Talk, Message, Session } from '../../types';
import type { TalkManager } from '../../services/talks';
import type { SessionManager } from '../../services/sessions';
import { formatRelativeTime, formatSessionTime, formatUpdatedTime } from '../utils.js';

interface TalksHubProps {
  talkManager: TalkManager;
  sessionManager: SessionManager;
  maxHeight: number;
  terminalWidth: number;
  onClose: () => void;
  onSelectTalk: (talk: Talk) => void;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onOpenModelPicker: () => void;
  onNewTerminal: () => void;
  onExit: () => void;
  setError: (error: string) => void;
}

export function TalksHub({
  talkManager,
  sessionManager,
  maxHeight,
  terminalWidth,
  onClose,
  onSelectTalk,
  onNewChat,
  onToggleTts,
  onOpenHistory,
  onOpenSettings,
  onOpenModelPicker,
  onNewTerminal,
  onExit,
  setError,
}: TalksHubProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [renameIndex, setRenameIndex] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);

  const talks = useMemo(() => talkManager.listSavedTalks(), [talkManager, refreshKey]);

  // Calculate visible rows
  const visibleRows = Math.max(3, maxHeight - 4); // title + blank + footer + blank

  const ensureVisible = (idx: number) => {
    setScrollOffset(prev => {
      if (idx < prev) return idx;
      if (idx >= prev + visibleRows) return idx - visibleRows + 1;
      return prev;
    });
  };

  // Get first line preview from session messages
  const getPreview = (talk: Talk): string => {
    const session = sessionManager.getSession(talk.sessionId);
    if (!session || session.messages.length === 0) return 'No messages';
    const firstUserMsg = session.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return 'No messages';
    const preview = firstUserMsg.content.split('\n')[0];
    return preview.length > 40 ? preview.slice(0, 40) + '...' : preview;
  };

  // Keyboard handling
  useInput((input, key) => {
    // ^T always closes
    if (input === 't' && key.ctrl) {
      onClose();
      return;
    }

    // ^N starts new chat
    if (input === 'n' && key.ctrl) {
      onNewChat();
      return;
    }

    // ^V toggle TTS
    if (input === 'v' && key.ctrl) {
      onToggleTts();
      return;
    }

    // ^H open history
    if (input === 'h' && key.ctrl) {
      onOpenHistory();
      return;
    }

    // ^S open settings
    if (input === 's' && key.ctrl) {
      onOpenSettings();
      return;
    }

    // ^A open model picker
    if (input === 'a' && key.ctrl) {
      onOpenModelPicker();
      return;
    }

    // ^Y new terminal
    if (input === 'y' && key.ctrl) {
      onNewTerminal();
      return;
    }

    // ^X exit
    if (input === 'x' && key.ctrl) {
      onExit();
      return;
    }

    // ^C and ^P - voice not available in Talks screen
    if ((input === 'c' || input === 'p') && key.ctrl) {
      setError('You can only use voice input in a Talk!');
      return;
    }

    // Handle rename mode
    if (renameIndex !== null) {
      if (key.return) {
        const talk = talks[renameIndex];
        if (talk && renameValue.trim()) {
          talkManager.setTopicTitle(talk.id, renameValue.trim());
          setRefreshKey(k => k + 1);
        }
        setRenameIndex(null);
        setRenameValue('');
        return;
      }
      if (key.escape) {
        setRenameIndex(null);
        setRenameValue('');
        return;
      }
      return;
    }

    // Handle delete confirmation mode
    if (confirmDeleteIndex !== null) {
      if (key.escape) {
        setConfirmDeleteIndex(null);
        return;
      }
      // Confirm delete on second 'd' press
      if (input === 'd' || input === 'D') {
        const talk = talks[confirmDeleteIndex];
        if (talk) {
          talkManager.unsaveTalk(talk.id);
          setRefreshKey(k => k + 1);
          // Adjust selection if we deleted the last item
          if (selectedIndex >= talks.length - 1 && selectedIndex > 0) {
            setSelectedIndex(selectedIndex - 1);
          }
        }
        setConfirmDeleteIndex(null);
        return;
      }
      // Any other key cancels
      setConfirmDeleteIndex(null);
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
        const next = Math.min(talks.length - 1, prev + 1);
        ensureVisible(next);
        return next;
      });
      return;
    }

    if (key.return && talks.length > 0) {
      const talk = talks[selectedIndex];
      if (talk) {
        onSelectTalk(talk);
      }
      return;
    }

    // 'r' to rename
    if ((input === 'r' || input === 'R') && talks.length > 0) {
      const talk = talks[selectedIndex];
      setRenameIndex(selectedIndex);
      setRenameValue(talk.topicTitle || '');
      return;
    }

    // 'd' to delete (unsave) - enter confirmation mode
    if ((input === 'd' || input === 'D') && talks.length > 0) {
      setConfirmDeleteIndex(selectedIndex);
      return;
    }
  });

  const visibleTalks = talks.slice(scrollOffset, scrollOffset + visibleRows);
  const hasMore = scrollOffset + visibleRows < talks.length;
  const hasLess = scrollOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Saved Talks</Text>
      <Box height={1} />

      {talks.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>No saved talks yet.</Text>
          <Text dimColor>Use /save to save the current chat.</Text>
        </Box>
      ) : (
        <>
          {hasLess && <Text dimColor>  {'\u25B2'} more</Text>}
          {visibleTalks.map((talk, i) => {
            const actualIndex = scrollOffset + i;
            const isSelected = actualIndex === selectedIndex;
            const isRenaming = actualIndex === renameIndex;
            const session = sessionManager.getSession(talk.sessionId);
            const msgCount = session?.messages.length ?? 0;

            // Rename mode renders differently (TextInput can't be inside Text)
            if (isRenaming) {
              return (
                <Box key={talk.id}>
                  <Text color="cyan">{isSelected ? '> ' : '  '}</Text>
                  <Text>Topic: </Text>
                  <TextInput
                    value={renameValue}
                    onChange={setRenameValue}
                    onSubmit={() => {
                      if (renameValue.trim()) {
                        talkManager.setTopicTitle(talk.id, renameValue.trim());
                        setRefreshKey(k => k + 1);
                      }
                      setRenameIndex(null);
                      setRenameValue('');
                    }}
                  />
                </Box>
              );
            }

            // Normal display: Topic Title OR (date/time + first line preview)
            const updatedTime = formatUpdatedTime(talk.updatedAt);
            if (talk.topicTitle) {
              return (
                <Box key={talk.id}>
                  <Text color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '> ' : '  '}
                    <Text bold={isSelected}>{talk.topicTitle}</Text>
                    <Text dimColor> ({msgCount} msg{msgCount !== 1 ? 's' : ''}) | {updatedTime}</Text>
                  </Text>
                </Box>
              );
            }

            const sessionTime = formatSessionTime(talk.createdAt);
            const preview = getPreview(talk);
            return (
              <Box key={talk.id}>
                <Text color={isSelected ? 'cyan' : undefined}>
                  {isSelected ? '> ' : '  '}
                  <Text dimColor>{sessionTime}</Text>
                  <Text> </Text>
                  <Text>{preview}</Text>
                  <Text dimColor> ({msgCount} msg{msgCount !== 1 ? 's' : ''}) | {updatedTime}</Text>
                </Text>
              </Box>
            );
          })}
          {hasMore && <Text dimColor>  {'\u25BC'} more</Text>}
        </>
      )}

      <Box height={1} />
      {renameIndex !== null ? (
        <Text dimColor>  Enter Save  Esc Cancel</Text>
      ) : confirmDeleteIndex !== null ? (
        <Text>
          <Text color="yellow">  Delete "{talks[confirmDeleteIndex]?.topicTitle || 'Talk'}"?</Text>
          <Text dimColor>  d Confirm  Esc Cancel</Text>
        </Text>
      ) : (
        <Text dimColor>  {'\u2191\u2193'} Navigate  Enter Continue  r Rename  d Delete  Esc Close</Text>
      )}
    </Box>
  );
}
