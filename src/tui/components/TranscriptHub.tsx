/**
 * Transcript Hub Component
 *
 * Three-mode overlay: session list, scrollable transcript viewer, cross-session search.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Message, Session, SearchResult } from '../../types';
import type { SessionManager } from '../../services/sessions';
import type { TalkManager } from '../../services/talks';
import { formatRelativeTime, formatSessionTime, exportTranscript, exportTranscriptMd, exportTranscriptDocx } from '../utils.js';

/** Truncate text content to fit within maxLines at given width */
function truncateContent(text: string, maxLines: number, width: number): { content: string; truncated: boolean } {
  if (!text || maxLines <= 0) return { content: '', truncated: false };

  const usableWidth = Math.max(10, width - 6);
  const lines: string[] = [];

  for (const para of text.split('\n')) {
    if (lines.length >= maxLines) break;

    if (!para) {
      lines.push('');
      continue;
    }

    // Count visual lines for this paragraph
    const visualLines = Math.ceil(para.length / usableWidth) || 1;

    if (lines.length + visualLines <= maxLines) {
      lines.push(para);
    } else {
      // Partial fit - truncate
      const remainingLines = maxLines - lines.length;
      const maxChars = remainingLines * usableWidth;
      if (maxChars > 0) {
        lines.push(para.slice(0, maxChars));
      }
      break;
    }
  }

  const result = lines.join('\n');
  return { content: result, truncated: result.length < text.length };
}

/** Count actual visual lines text will occupy */
function countVisualLines(text: string, width: number): number {
  if (!text) return 1;
  const usableWidth = Math.max(10, width - 6);
  let count = 0;
  for (const line of text.split('\n')) {
    count += Math.ceil(line.length / usableWidth) || 1;
  }
  return count;
}

type HubMode = 'list' | 'transcript' | 'search';

interface TranscriptHubProps {
  currentMessages: Message[];
  currentSessionName: string;
  sessionManager: SessionManager;
  talkManager?: TalkManager;
  maxHeight: number;
  terminalWidth: number;
  onClose: () => void;
  onNewChat: () => void;
  onToggleTts: () => void;
  onOpenTalks: () => void;
  onOpenSettings: () => void;
  onExit: () => void;
  setError: (error: string) => void;
}

export function TranscriptHub({
  currentMessages,
  currentSessionName,
  sessionManager,
  talkManager,
  maxHeight,
  terminalWidth,
  onClose,
  onNewChat,
  onToggleTts,
  onOpenTalks,
  onOpenSettings,
  onExit,
  setError,
}: TranscriptHubProps) {
  const [mode, setMode] = useState<HubMode>('list');
  const [previousMode, setPreviousMode] = useState<HubMode>('list');

  // Session list state
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);
  const [listScrollOffset, setListScrollOffset] = useState(0);

  // Transcript view state
  const [viewingSession, setViewingSession] = useState<Session | null>(null);
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const [exported, setExported] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);
  const [searchScrollOffset, setSearchScrollOffset] = useState(0);
  const [isSearchInputActive, setIsSearchInputActive] = useState(true);
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const sessions = useMemo(() => sessionManager.listSessions(), [sessionManager, mode, refreshKey]);
  const activeSessionId = sessionManager.getActiveSessionId();

  // Determine messages for transcript view
  const transcriptMessages = useMemo(() => {
    if (!viewingSession) return [];
    const isActive = viewingSession.id === activeSessionId;
    return isActive ? currentMessages : viewingSession.messages;
  }, [viewingSession, activeSessionId, currentMessages]);

  // Debounced search
  useEffect(() => {
    if (mode !== 'search') return;
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      const results = sessionManager.searchTranscripts(searchQuery.trim());
      setSearchResults(results);
      setSelectedResultIndex(0);
      setSearchScrollOffset(0);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery, mode]);

  // Build grouped search render list
  const searchRenderList = useMemo(() => {
    const items: Array<
      | { type: 'header'; sessionName: string; relativeTime: string }
      | { type: 'result'; result: SearchResult; flatIndex: number }
    > = [];
    const resultIndices: number[] = [];
    let currentSessionId: string | null = null;
    let flatIndex = 0;

    for (const result of searchResults) {
      if (result.sessionId !== currentSessionId) {
        items.push({
          type: 'header',
          sessionName: result.sessionName,
          relativeTime: formatRelativeTime(result.sessionUpdatedAt),
        });
        currentSessionId = result.sessionId;
      }
      resultIndices.push(items.length);
      items.push({ type: 'result', result, flatIndex });
      flatIndex++;
    }

    return { items, resultIndices };
  }, [searchResults]);

  // Session list scrolling helpers
  // title(1) + blank(1) + footer(1) + blank(1) + up to 2 scroll indicators = 6
  const listVisibleRows = Math.max(3, maxHeight - 6);

  const ensureListVisible = (idx: number) => {
    setListScrollOffset(prev => {
      if (idx < prev) return idx;
      if (idx >= prev + listVisibleRows) return idx - listVisibleRows + 1;
      return prev;
    });
  };

  // Transcript scrolling helpers
  // Account for: title (1) + path (1) + blank (1) + footer (1) + blank before footer (1) = 5 lines
  const transcriptHeaderLines = 5;
  const transcriptVisibleRows = Math.max(3, maxHeight - transcriptHeaderLines);

  // Search scrolling helpers
  const searchHeaderLines = 4; // title + input + blank + footer
  const searchVisibleRows = Math.max(3, maxHeight - searchHeaderLines);

  const ensureSearchVisible = (idx: number) => {
    const renderPos = searchRenderList.resultIndices[idx] ?? 0;
    setSearchScrollOffset(prev => {
      if (renderPos < prev) return renderPos;
      if (renderPos >= prev + searchVisibleRows) return renderPos - searchVisibleRows + 1;
      return prev;
    });
  };

  // Keyboard handling
  useInput((input, key) => {
    // Global shortcuts
    if (input === 't' && key.ctrl) {
      onOpenTalks();
      return;
    }
    if (input === 'n' && key.ctrl) {
      onNewChat();
      return;
    }
    if (input === 'v' && key.ctrl) {
      onToggleTts();
      return;
    }
    if (input === 'h' && key.ctrl) {
      onClose(); // Already in History
      return;
    }
    if (input === 's' && key.ctrl) {
      onOpenSettings();
      return;
    }
    if (input === 'x' && key.ctrl) {
      onExit();
      return;
    }
    // ^C and ^P - voice not available outside Talk
    if ((input === 'c' || input === 'p') && key.ctrl) {
      setError('You can only use voice input in a Talk!');
      return;
    }

    if (mode === 'list') {
      if (deleteConfirmSessionId) {
        if (key.return) {
          sessionManager.deleteSession(deleteConfirmSessionId);
          setDeleteConfirmSessionId(null);
          setRefreshKey(k => k + 1);
          setSelectedSessionIndex(prev => Math.min(prev, Math.max(0, sessions.length - 2)));
          return;
        }
        if (key.escape) {
          setDeleteConfirmSessionId(null);
          return;
        }
        return;
      }
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow) {
        setSelectedSessionIndex(prev => {
          const next = Math.max(0, prev - 1);
          ensureListVisible(next);
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setSelectedSessionIndex(prev => {
          const next = Math.min(sessions.length - 1, prev + 1);
          ensureListVisible(next);
          return next;
        });
        return;
      }
      if (key.return && sessions.length > 0) {
        const session = sessions[selectedSessionIndex];
        setViewingSession(session);
        setTranscriptScrollOffset(0);
        setExported(null);
        setMode('transcript');
        return;
      }
      if (input === '/') {
        setPreviousMode('list');
        setSearchQuery('');
        setSearchResults([]);
        setIsSearchInputActive(true);
        setMode('search');
        return;
      }
      if (input === 'x' || input === 'X') {
        if (sessions.length > 0) {
          setDeleteConfirmSessionId(sessions[selectedSessionIndex].id);
        }
        return;
      }
      return;
    }

    if (mode === 'transcript') {
      if (key.escape) {
        setMode('list');
        return;
      }
      if (key.upArrow) {
        setTranscriptScrollOffset(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        const maxOffset = Math.max(0, transcriptMessages.length - 1);
        setTranscriptScrollOffset(prev => Math.min(maxOffset, prev + 1));
        return;
      }
      if (input === '/' ) {
        setPreviousMode('transcript');
        setSearchQuery('');
        setSearchResults([]);
        setIsSearchInputActive(true);
        setMode('search');
        return;
      }
      if ((input === 'e' || input === 'E') && transcriptMessages.length > 0) {
        const talk = talkManager?.getTalk(viewingSession?.id ?? '');
        const name = talk?.topicTitle ?? viewingSession?.name ?? currentSessionName;
        try {
          const filepath = exportTranscriptMd(transcriptMessages, name);
          setExported(filepath);
        } catch (err) {
          setExported(`Error: ${err instanceof Error ? err.message : 'Failed to export'}`);
        }
        return;
      }
      if ((input === 'd' || input === 'D') && transcriptMessages.length > 0) {
        const talk = talkManager?.getTalk(viewingSession?.id ?? '');
        const name = talk?.topicTitle ?? viewingSession?.name ?? currentSessionName;
        exportTranscriptDocx(transcriptMessages, name).then(filepath => {
          setExported(filepath);
        }).catch(err => {
          setExported(`Error: ${err instanceof Error ? err.message : 'Failed to export'}`);
        });
        return;
      }
      return;
    }

    if (mode === 'search') {
      if (key.escape) {
        if (!isSearchInputActive && searchResults.length > 0) {
          setIsSearchInputActive(true);
          return;
        }
        setMode(previousMode);
        return;
      }

      if (isSearchInputActive) {
        // When input is active, only handle Enter and Down to shift focus to results
        if (key.return && searchResults.length > 0) {
          setIsSearchInputActive(false);
          return;
        }
        if (key.downArrow && searchResults.length > 0) {
          setIsSearchInputActive(false);
          return;
        }
        return;
      }

      // Navigating results
      if (key.upArrow) {
        if (selectedResultIndex === 0) {
          setIsSearchInputActive(true);
          return;
        }
        setSelectedResultIndex(prev => {
          const next = Math.max(0, prev - 1);
          ensureSearchVisible(next);
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setSelectedResultIndex(prev => {
          const next = Math.min(searchResults.length - 1, prev + 1);
          ensureSearchVisible(next);
          return next;
        });
        return;
      }
      if (key.return && searchResults.length > 0) {
        const result = searchResults[selectedResultIndex];
        const session = sessionManager.getSession(result.sessionId);
        if (session) {
          setViewingSession(session);
          setTranscriptScrollOffset(0);
          setExported(null);
          setMode('transcript');
        }
        return;
      }
      return;
    }
  });

  // ─── Renderers ──────────────────────────────────────

  if (mode === 'list') {
    const visibleSessions = sessions.slice(listScrollOffset, listScrollOffset + listVisibleRows);
    const hasMore = listScrollOffset + listVisibleRows < sessions.length;
    const hasLess = listScrollOffset > 0;

    return (
      <Box flexDirection="column" paddingX={1} height={maxHeight}>
        <Text bold color="cyan">Transcript History</Text>
        <Box height={1} />

        {sessions.length === 0 ? (
          <Text dimColor>No sessions yet.</Text>
        ) : (
          <>
            {hasLess && <Text dimColor>  ▲ more</Text>}
            {visibleSessions.map((session, i) => {
              const actualIndex = listScrollOffset + i;
              const isSelected = actualIndex === selectedSessionIndex;
              const isActive = session.id === activeSessionId;
              const isDeleting = session.id === deleteConfirmSessionId;
              const msgCount = isActive ? currentMessages.length : session.messages.length;
              const sessionTime = formatSessionTime(session.createdAt);
              const talk = talkManager?.getTalk(session.id);
              const displayName = talk?.topicTitle ?? session.name;

              return (
                <Box key={session.id}>
                  <Text color={isDeleting ? 'red' : isSelected ? 'cyan' : undefined}>
                    {isSelected ? '> ' : '  '}
                    <Text color={isDeleting ? 'red' : isActive ? 'green' : undefined}>
                      {isActive ? '\u25CF ' : '  '}
                    </Text>
                    <Text bold={isSelected}>
                      {displayName}
                    </Text>
                    <Text dimColor> ({msgCount} msg{msgCount !== 1 ? 's' : ''}) | {sessionTime}</Text>
                  </Text>
                </Box>
              );
            })}
            {hasMore && <Text dimColor>  ▼ more</Text>}
          </>
        )}

        <Box height={1} />
        {deleteConfirmSessionId ? (
          <Text>  <Text color="red">Delete &quot;{sessions.find(s => s.id === deleteConfirmSessionId)?.name}&quot;?</Text>  <Text dimColor>  Enter confirm  Esc cancel</Text></Text>
        ) : (
          <Text dimColor>  ↑↓ Navigate  Enter View  / Search  x Delete  Esc Close</Text>
        )}
      </Box>
    );
  }

  if (mode === 'transcript') {
    const talkForView = talkManager?.getTalk(viewingSession?.id ?? '');
    const sessionName = talkForView?.topicTitle ?? viewingSession?.name ?? currentSessionName;
    const sessionDir = viewingSession ? sessionManager.getSessionDir(viewingSession.id) : '';
    const messages = transcriptMessages;

    const hasAbove = transcriptScrollOffset > 0;
    // Fixed overhead: title(1) + path(1) + blank(1) + footer(1) + indicators(2) = 6 lines
    const fixedOverhead = 6;
    const availableForMessages = Math.max(3, transcriptVisibleRows - fixedOverhead);

    // Compute visible messages with truncation budgets
    type VisibleMsg = { msg: Message; maxLines: number };
    const visibleMessages: VisibleMsg[] = [];
    let linesRemaining = availableForMessages;

    for (let i = transcriptScrollOffset; i < messages.length && linesRemaining > 1; i++) {
      const msg = messages[i];
      const headerLine = 1; // [time] Role:
      const contentLines = countVisualLines(msg.content, terminalWidth);
      const totalLines = headerLine + contentLines;

      if (totalLines <= linesRemaining) {
        // Full message fits
        visibleMessages.push({ msg, maxLines: contentLines });
        linesRemaining -= totalLines;
      } else if (linesRemaining > headerLine) {
        // Partial fit - truncate content
        const availableContent = linesRemaining - headerLine;
        visibleMessages.push({ msg, maxLines: availableContent });
        linesRemaining = 0;
      }
    }

    const hasBelow = transcriptScrollOffset + visibleMessages.length < messages.length;

    return (
      <Box flexDirection="column" paddingX={1} height={maxHeight}>
        <Text bold color="cyan">{sessionName} ({messages.length} message{messages.length !== 1 ? 's' : ''})</Text>
        <Text dimColor>  {sessionDir}/</Text>

        {exported && (
          <Text color={exported.startsWith('Error') ? 'red' : 'green'}>  {exported}</Text>
        )}

        <Box height={1} />

        {messages.length === 0 ? (
          <Text dimColor>No messages in this session.</Text>
        ) : (
          <Box flexDirection="column">
            {hasAbove && <Text dimColor>  ▲ {transcriptScrollOffset} earlier message{transcriptScrollOffset !== 1 ? 's' : ''}</Text>}
            {!hasAbove && <Text> </Text>}

            {visibleMessages.map(({ msg, maxLines }) => {
              const time = new Date(msg.timestamp).toLocaleTimeString();
              const role = msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'AI';
              const roleColor = msg.role === 'user' ? 'green' : msg.role === 'system' ? 'yellow' : 'cyan';
              const modelLabel = msg.model ? ` (${msg.model.split('/').pop()})` : '';
              const { content, truncated } = truncateContent(msg.content, maxLines, terminalWidth);

              return (
                <Box key={msg.id} flexDirection="column">
                  <Text>
                    <Text dimColor>[{time}] </Text>
                    <Text color={roleColor} bold>{role}{modelLabel}:</Text>
                  </Text>
                  <Box paddingLeft={2}>
                    <Text wrap="wrap">{content}{truncated ? <Text dimColor>...</Text> : null}</Text>
                  </Box>
                </Box>
              );
            })}

            {hasBelow && <Text dimColor>  ▼ more messages below</Text>}
            {!hasBelow && <Text> </Text>}
          </Box>
        )}

        <Text dimColor>  ↑↓ Scroll  / Search  E Markdown  D Docx  Esc Back</Text>
      </Box>
    );
  }

  // mode === 'search'
  const { items: searchItems, resultIndices } = searchRenderList;
  const visibleSearchItems = searchItems.slice(searchScrollOffset, searchScrollOffset + searchVisibleRows);
  const hasSearchMore = searchScrollOffset + searchVisibleRows < searchItems.length;
  const hasSearchLess = searchScrollOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1} height={maxHeight}>
      <Text bold color="cyan">Search Transcripts</Text>
      <Box>
        <Text dimColor>Search: </Text>
        {isSearchInputActive ? (
          <TextInput
            value={searchQuery}
            onChange={setSearchQuery}
            onSubmit={() => {
              if (searchResults.length > 0) setIsSearchInputActive(false);
            }}
          />
        ) : (
          <Text>{searchQuery}<Text dimColor> (press ↑ to edit)</Text></Text>
        )}
      </Box>
      <Box height={1} />

      {searchQuery.trim() && searchResults.length === 0 ? (
        <Text dimColor>No matches found.</Text>
      ) : searchResults.length > 0 ? (
        <>
          {hasSearchLess && <Text dimColor>  ▲ more</Text>}
          {visibleSearchItems.map((item, i) => {
            if (item.type === 'header') {
              return (
                <Box key={`hdr-${item.sessionName}-${i}`} marginTop={i > 0 ? 1 : 0}>
                  <Text bold dimColor>  {item.sessionName}</Text>
                  <Text dimColor> ({item.relativeTime})</Text>
                </Box>
              );
            }

            const { result, flatIndex } = item;
            const isSelected = !isSearchInputActive && flatIndex === selectedResultIndex;
            const time = new Date(result.message.timestamp).toLocaleTimeString();
            const role = result.message.role === 'user' ? 'You' : 'AI';
            const snippet = getSnippet(result.message.content, result.matchIndex, searchQuery);

            return (
              <Box key={`${result.sessionId}-${result.message.id}-${flatIndex}`} paddingLeft={2}>
                <Text color={isSelected ? 'cyan' : undefined}>
                  {isSelected ? '> ' : '  '}
                  <Text dimColor>[{time}] {role}: </Text>
                  <Text>{snippet.before}</Text>
                  <Text color="yellow" bold>{snippet.match}</Text>
                  <Text>{snippet.after}</Text>
                </Text>
              </Box>
            );
          })}
          {hasSearchMore && <Text dimColor>  ▼ more</Text>}
        </>
      ) : !searchQuery.trim() ? (
        <Text dimColor>Type to search across all sessions.</Text>
      ) : null}

      <Box height={1} />
      <Text dimColor>  ↑↓ Navigate  Enter View  Esc {isSearchInputActive ? 'Cancel' : 'Back to input'}</Text>
    </Box>
  );
}

function getSnippet(
  content: string,
  matchIndex: number,
  query: string,
): { before: string; match: string; after: string } {
  const queryLen = query.length;
  const start = Math.max(0, matchIndex - 30);
  const end = Math.min(content.length, matchIndex + queryLen + 30);
  const before = (start > 0 ? '...' : '') + content.slice(start, matchIndex);
  const match = content.slice(matchIndex, matchIndex + queryLen);
  const after = content.slice(matchIndex + queryLen, end) + (end < content.length ? '...' : '');
  return { before, match, after };
}
