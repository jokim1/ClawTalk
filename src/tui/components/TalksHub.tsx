/**
 * Talks Hub Component
 *
 * WhatsApp-style saved conversations list with search and export.
 * Shows explicitly saved talks (via /save command) sorted by updatedAt.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Talk, Message, Session } from '../../types';
import type { TalkManager } from '../../services/talks';
import type { SessionManager } from '../../services/sessions';
import { formatRelativeTime, formatSessionTime, formatUpdatedTime, exportTranscript, exportTranscriptMd, exportTranscriptDocx } from '../utils.js';

interface TalksHubProps {
  talkManager: TalkManager;
  sessionManager: SessionManager;
  maxHeight: number;
  terminalWidth: number;
  onClose: () => void;
  onSelectTalk: (talk: Talk) => void;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenSettings: () => void;
  onOpenModelPicker: () => void;
  onNewTerminal: () => void;
  onExit: () => void;
  setError: (error: string) => void;
  onRenameTalk?: (talkId: string, title: string) => void;
  onDeleteTalk?: (talkId: string) => void;
  exportDir?: string;
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
  onOpenSettings,
  onOpenModelPicker,
  onNewTerminal,
  onExit,
  setError,
  onRenameTalk,
  onDeleteTalk,
  exportDir,
}: TalksHubProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [renameIndex, setRenameIndex] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);

  // Search state
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInputActive, setSearchInputActive] = useState(true);

  // Export picker state
  const [exportPickerIndex, setExportPickerIndex] = useState<number | null>(null);

  const allTalks = useMemo(() => talkManager.listSavedTalks(), [talkManager, refreshKey]);

  // Search filtering
  const talks = useMemo(() => {
    if (!searchMode || !searchQuery.trim()) return allTalks;
    const query = searchQuery.toLowerCase();
    return allTalks.filter(talk => {
      // Match topic title
      if (talk.topicTitle?.toLowerCase().includes(query)) return true;
      // Match message content
      const session = sessionManager.getSession(talk.sessionId);
      if (session) {
        return session.messages.some(m => m.content.toLowerCase().includes(query));
      }
      return false;
    });
  }, [allTalks, searchMode, searchQuery, sessionManager]);

  // Calculate visible rows
  const visibleRows = Math.max(3, maxHeight - (searchMode ? 6 : 4)); // title + blank + footer + blank (+ search input + blank in search mode)

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
    if (!session || session.messages.length === 0) {
      if (talk.objective) return talk.objective.slice(0, 40) + (talk.objective.length > 40 ? '...' : '');
      return 'Gateway talk';
    }
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

    // ^V - TTS not available in Talks screen
    if (input === 'v' && key.ctrl) {
      setError('You can only toggle TTS in a Talk!');
      return;
    }

    // ^S open settings
    if (input === 's' && key.ctrl) {
      onOpenSettings();
      return;
    }

    // ^K open model picker
    if (input === 'k' && key.ctrl) {
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

    // --- Search mode ---
    if (searchMode) {
      if (searchInputActive) {
        // Esc exits search mode
        if (key.escape) {
          setSearchMode(false);
          setSearchQuery('');
          setSearchInputActive(true);
          setSelectedIndex(0);
          setScrollOffset(0);
          return;
        }
        // Down/Enter moves focus to results
        if ((key.downArrow || key.return) && talks.length > 0) {
          setSearchInputActive(false);
          setSelectedIndex(0);
          setScrollOffset(0);
          return;
        }
        return;
      }

      // Navigating search results
      if (key.escape) {
        setSearchInputActive(true);
        return;
      }

      if (key.upArrow) {
        if (selectedIndex === 0) {
          setSearchInputActive(true);
          return;
        }
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
      return;
    }

    // --- Export picker mode ---
    if (exportPickerIndex !== null) {
      if (key.escape) {
        setExportPickerIndex(null);
        return;
      }
      const talk = talks[exportPickerIndex - 1];
      if (!talk) { setExportPickerIndex(null); return; }

      const session = sessionManager.getSession(talk.sessionId);
      const msgs = session?.messages ?? [];
      const name = talk.topicTitle ?? session?.name ?? 'Talk';

      if ((input === 't' || input === 'T') && msgs.length > 0) {
        try {
          const filepath = exportTranscript(msgs, name, exportDir);
          setError(`Exported: ${filepath}`);
        } catch (err) {
          setError(`Export failed: ${err instanceof Error ? err.message : 'Failed'}`);
        }
        setExportPickerIndex(null);
        return;
      }
      if ((input === 'm' || input === 'M') && msgs.length > 0) {
        try {
          const filepath = exportTranscriptMd(msgs, name, exportDir);
          setError(`Exported: ${filepath}`);
        } catch (err) {
          setError(`Export failed: ${err instanceof Error ? err.message : 'Failed'}`);
        }
        setExportPickerIndex(null);
        return;
      }
      if ((input === 'd' || input === 'D') && msgs.length > 0) {
        exportTranscriptDocx(msgs, name, exportDir).then(filepath => {
          setError(`Exported: ${filepath}`);
        }).catch(err => {
          setError(`Export failed: ${err instanceof Error ? err.message : 'Failed'}`);
        });
        setExportPickerIndex(null);
        return;
      }
      return;
    }

    // Handle rename mode
    if (renameIndex !== null) {
      if (key.return) {
        const talk = talks[renameIndex - 1];
        if (talk && renameValue.trim()) {
          if (onRenameTalk) {
            onRenameTalk(talk.id, renameValue.trim());
          } else {
            talkManager.setTopicTitle(talk.id, renameValue.trim());
          }
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
        const talk = talks[confirmDeleteIndex - 1];
        if (talk) {
          if (onDeleteTalk) {
            onDeleteTalk(talk.id);
          } else {
            talkManager.unsaveTalk(talk.id);
          }
          setRefreshKey(k => k + 1);
          // Adjust selection if we deleted the last item
          if (selectedIndex > talks.length - 1 && selectedIndex > 0) {
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
        const next = Math.min(talks.length, prev + 1);
        ensureVisible(next);
        return next;
      });
      return;
    }

    if (key.return) {
      if (selectedIndex === 0) {
        onNewChat();
      } else {
        const talk = talks[selectedIndex - 1];
        if (talk) {
          onSelectTalk(talk);
        }
      }
      return;
    }

    // '/' enters search mode (only when selectedIndex >= 0)
    if (input === '/' && selectedIndex >= 0) {
      setSearchMode(true);
      setSearchQuery('');
      setSearchInputActive(true);
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }

    // 'e' to export (only for saved talks)
    if ((input === 'e' || input === 'E') && selectedIndex > 0) {
      setExportPickerIndex(selectedIndex);
      return;
    }

    // 'r' to rename (only for saved talks, not New Talk)
    if ((input === 'r' || input === 'R') && selectedIndex > 0) {
      const talk = talks[selectedIndex - 1];
      setRenameIndex(selectedIndex);
      setRenameValue(talk.topicTitle || '');
      return;
    }

    // 'd' to delete (unsave) - enter confirmation mode (only for saved talks)
    if ((input === 'd' || input === 'D') && selectedIndex > 0) {
      setConfirmDeleteIndex(selectedIndex);
      return;
    }
  });

  // --- Search mode render ---
  if (searchMode) {
    const visibleStart = scrollOffset;
    const visibleEnd = Math.min(talks.length, scrollOffset + visibleRows);
    const hasMore = visibleEnd < talks.length;
    const hasLess = scrollOffset > 0;

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">Search Talks</Text>
        <Box>
          <Text dimColor>Search: </Text>
          {searchInputActive ? (
            <TextInput
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={() => {
                if (talks.length > 0) {
                  setSearchInputActive(false);
                  setSelectedIndex(0);
                }
              }}
            />
          ) : (
            <Text>{searchQuery}<Text dimColor> ({'\u2191'} to edit)</Text></Text>
          )}
        </Box>
        <Box height={1} />

        {searchQuery.trim() && talks.length === 0 ? (
          <Text dimColor>No matches found.</Text>
        ) : talks.length > 0 ? (
          <>
            {hasLess && <Text dimColor>  {'\u25B2'} more</Text>}
            {Array.from({ length: visibleEnd - visibleStart }, (_, i) => {
              const actualIndex = visibleStart + i;
              const talk = talks[actualIndex];
              if (!talk) return null;

              const isSelected = !searchInputActive && actualIndex === selectedIndex;
              const session = sessionManager.getSession(talk.sessionId);
              const msgCount = session?.messages.length ?? 0;
              const updatedTime = formatUpdatedTime(talk.updatedAt);
              const displayName = talk.topicTitle ?? getPreview(talk);

              return (
                <Box key={talk.id}>
                  <Text color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '> ' : '  '}
                    <Text bold={isSelected}>{displayName}</Text>
                    <Text dimColor> ({msgCount} msg{msgCount !== 1 ? 's' : ''}) | {updatedTime}</Text>
                  </Text>
                </Box>
              );
            })}
            {hasMore && <Text dimColor>  {'\u25BC'} more</Text>}
          </>
        ) : !searchQuery.trim() ? (
          <Text dimColor>Type to search across all talks.</Text>
        ) : null}

        <Box height={1} />
        <Text dimColor>  {'\u2191\u2193'} Navigate  Enter Open  Esc {searchInputActive ? 'Cancel' : 'Back to input'}</Text>
      </Box>
    );
  }

  // --- Normal mode render ---
  const totalItems = 1 + talks.length;
  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(totalItems, scrollOffset + visibleRows);
  const hasMore = visibleEnd < totalItems;
  const hasLess = scrollOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Talks</Text>
      <Box height={1} />

      {hasLess && <Text dimColor>  {'\u25B2'} more</Text>}

      {/* Render visible items: index 0 = New Talk, 1+ = saved talks */}
      {Array.from({ length: visibleEnd - visibleStart }, (_, i) => {
        const actualIndex = visibleStart + i;
        const isSelected = actualIndex === selectedIndex;

        // Index 0: "New Talk" row
        if (actualIndex === 0) {
          return (
            <Box key="__new_talk__">
              <Text color={isSelected ? 'green' : 'green'}>
                {isSelected ? '> ' : '  '}
                <Text bold={isSelected}>+ New Talk</Text>
              </Text>
            </Box>
          );
        }

        // Index 1+: saved talks
        const talk = talks[actualIndex - 1];
        if (!talk) return null;

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
                    if (onRenameTalk) {
                      onRenameTalk(talk.id, renameValue.trim());
                    } else {
                      talkManager.setTopicTitle(talk.id, renameValue.trim());
                    }
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
        const hasJobs = (talk.jobs ?? []).some(j => j.active);
        const hasConfig = (talk.directives ?? []).length > 0 || (talk.platformBindings ?? []).length > 0;
        const jobIndicator = hasJobs ? '\u23F0 ' : '';
        const configIndicator = hasConfig ? '\u2699 ' : '';
        if (talk.topicTitle) {
          return (
            <Box key={talk.id}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '> ' : '  '}
                {configIndicator}{jobIndicator}<Text bold={isSelected}>{talk.topicTitle}</Text>
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
              {configIndicator}{jobIndicator}<Text dimColor>{sessionTime}</Text>
              <Text> </Text>
              <Text>{preview}</Text>
              <Text dimColor> ({msgCount} msg{msgCount !== 1 ? 's' : ''}) | {updatedTime}</Text>
            </Text>
          </Box>
        );
      })}
      {hasMore && <Text dimColor>  {'\u25BC'} more</Text>}

      <Box height={1} />
      {renameIndex !== null ? (
        <Text dimColor>  Enter Save  Esc Cancel</Text>
      ) : confirmDeleteIndex !== null ? (
        <Text>
          <Text color="yellow">  Delete "{talks[confirmDeleteIndex - 1]?.topicTitle || 'Talk'}"?</Text>
          <Text dimColor>  d Confirm  Esc Cancel</Text>
        </Text>
      ) : exportPickerIndex !== null ? (
        <Text>  <Text bold>Export:</Text> <Text dimColor>t .txt  m .md  d .docx  Esc Cancel</Text></Text>
      ) : (
        <Text dimColor>  {'\u2191\u2193'} Navigate  Enter {selectedIndex === 0 ? 'New Talk' : 'Continue'}  / Search  {selectedIndex > 0 ? 'e Export  r Rename  d Delete  ' : ''}Esc Close</Text>
      )}
    </Box>
  );
}
