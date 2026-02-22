/**
 * Layout calculations for the ClawTalk TUI.
 *
 * Pure computation: measures terminal dimensions, calculates heights for
 * chat area, input area, scroll offsets, and overlay max heights.
 */

import { useMemo } from 'react';
import type { Message, PendingAttachment } from '../../types.js';
import type { TalkManager } from '../../services/talks.js';
import { countVisualLines, messageVisualLines } from '../lineCount.js';

export interface UseLayoutDeps {
  terminalWidth: number;
  terminalHeight: number;
  inputText: string;
  error: string | null;
  pendingClear: boolean;
  pendingAttachment: PendingAttachment | null;
  pendingDocument: { filename: string; text: string } | null;
  pendingFiles: Array<{ path: string; filename: string }>;
  messageQueue: string[];
  showCommandHints: boolean;
  commandHintsCount: number;
  isOverlayActive: boolean;
  grabTextMode: boolean;
  activeTalkId: string | null;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  messages: Message[];
}

export interface UseLayoutResult {
  contentWidth: number;
  chatHeight: number;
  inputLines: number;
  messageLinesArray: number[];
  totalMessageLines: number;
  scrollMaxOffset: number;
  overlayMaxHeight: number;
  showTitleBar: boolean;
  talkTitle: string | null;
  activeTalk: ReturnType<TalkManager['getTalk']>;
}

export function useLayout(deps: UseLayoutDeps): UseLayoutResult {
  const {
    terminalWidth, terminalHeight, inputText, error, pendingClear,
    pendingAttachment, pendingDocument, pendingFiles, messageQueue,
    showCommandHints, commandHintsCount, isOverlayActive, grabTextMode,
    activeTalkId, talkManagerRef, messages,
  } = deps;

  // Dynamic input height
  const inputContentWidth = Math.max(10, terminalWidth - 4);
  const inputVisualLines = inputText.length === 0
    ? 1
    : countVisualLines(inputText, inputContentWidth);
  const maxInputLines = Math.min(10, Math.floor(terminalHeight / 4));
  const inputLines = Math.min(maxInputLines, inputVisualLines);

  // Talk title / grab mode indicator
  const activeTalk = activeTalkId ? talkManagerRef.current?.getTalk(activeTalkId) : null;
  const talkTitle = activeTalk?.topicTitle ?? null;
  const showTitleBar = !isOverlayActive && (!!talkTitle || grabTextMode);
  const talkTitleLines = showTitleBar ? 2 : 0;

  // Height budget
  const errorLines = error ? 1 : 0;
  const clearPromptLines = pendingClear ? 1 : 0;
  const attachmentLines = (pendingAttachment ? 1 : 0) + (pendingDocument ? 1 : 0) + pendingFiles.length;
  const queuedLines = messageQueue.length > 0 ? messageQueue.length : 0;
  const hintsLines = showCommandHints ? commandHintsCount + 1 : 0;
  const chatHeight = Math.max(
    4,
    terminalHeight - 2 - talkTitleLines - errorLines - clearPromptLines - attachmentLines - 1 - inputLines - 3 - queuedLines - hintsLines - 1,
  );

  // Message line measurements
  const contentWidth = Math.max(10, terminalWidth - 2);
  const messageLinesArray = useMemo(
    () => messages.map(msg => messageVisualLines(msg, contentWidth)),
    [messages, contentWidth],
  );
  const totalMessageLines = useMemo(
    () => messageLinesArray.reduce((s, c) => s + c, 0),
    [messageLinesArray],
  );

  // Scroll offset cap
  const scrollMaxOffset = Math.max(0, totalMessageLines - chatHeight + 1);

  // Overlay max height
  const overlayMaxHeight = Math.max(6, terminalHeight - 4);

  return {
    contentWidth,
    chatHeight,
    inputLines,
    messageLinesArray,
    totalMessageLines,
    scrollMaxOffset,
    overlayMaxHeight,
    showTitleBar,
    talkTitle,
    activeTalk: activeTalk ?? null,
  };
}
