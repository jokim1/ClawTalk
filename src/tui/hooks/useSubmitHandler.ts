/**
 * Submit handler hook.
 *
 * Handles message submission (command dispatch + chat), file uploads,
 * agent routing, message queue processing, and command context assembly.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Message, PendingAttachment, TalkAgent } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { TalkManager } from '../../services/talks.js';
import { readFileForUpload } from '../../services/file.js';
import { processFile } from '../../services/file.js';
import { dispatchCommand } from '../commands.js';
import { createMessage } from '../helpers.js';

export interface UseSubmitHandlerDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  activeTalkIdRef: React.MutableRefObject<string | null>;
  gatewayTalkIdRef: React.MutableRefObject<string | null>;
  primaryAgentRef: React.MutableRefObject<TalkAgent | null>;
  // Chat
  sendMessage: (text: string, attachment?: PendingAttachment, documentContent?: { filename: string; text: string }) => Promise<void>;
  isProcessing: boolean;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  // Attachments
  pendingAttachment: PendingAttachment | null;
  setPendingAttachment: React.Dispatch<React.SetStateAction<PendingAttachment | null>>;
  pendingDocument: { filename: string; text: string } | null;
  setPendingDocument: React.Dispatch<React.SetStateAction<{ filename: string; text: string } | null>>;
  pendingFiles: Array<{ path: string; filename: string }>;
  setPendingFiles: React.Dispatch<React.SetStateAction<Array<{ path: string; filename: string }>>>;
  setFileIndicatorSelected: React.Dispatch<React.SetStateAction<boolean>>;
  // UI
  setInputText: React.Dispatch<React.SetStateAction<string>>;
  setStreamingAgentName: React.Dispatch<React.SetStateAction<string | undefined>>;
  setError: (msg: string | null) => void;
  scrollToBottom: () => void;
  // Queue
  messageQueue: string[];
  setMessageQueue: React.Dispatch<React.SetStateAction<string[]>>;
  // Navigation
  ensureGatewayTalk: () => Promise<string | null>;
  sendMultiAgentMessage: (text: string, targetAgents: TalkAgent[], allAgents: TalkAgent[]) => Promise<void>;
  // Command context parts
  commandCtxHandlers: CommandCtxHandlers;
}

/** All slash command handler functions needed by the command dispatcher. */
export interface CommandCtxHandlers {
  switchModel: (modelId: string) => void;
  openModelPicker: () => void;
  clearSession: () => void;
  setError: (msg: string | null) => void;
  addSystemMessage: (text: string) => void;
  saveTalk: (title?: string) => void;
  setTopicTitle: (title: string) => void;
  pinMessage: (fromBottom?: number) => void;
  unpinMessage: (fromBottom?: number) => void;
  listPins: () => void;
  addJob: (schedule: string, prompt: string) => Promise<boolean>;
  listJobs: () => void;
  pauseJob: (index: number) => void;
  resumeJob: (index: number) => void;
  deleteJob: (index: number) => void;
  setObjective: (text: string | undefined) => void;
  showObjective: () => void;
  viewReports: (jobIndex?: number) => void;
  addAgent: (modelAlias: string, roleId: string) => void;
  removeAgent: (name: string) => void;
  changeAgentRole: (name: string, roleId: string) => void;
  listAgents: () => void;
  askAgent: (name: string, message: string) => Promise<void>;
  debateAll: (topic: string) => Promise<void>;
  reviewLast: () => Promise<void>;
  attachFile: (filePath: string, message?: string) => Promise<void>;
  exportTalk: (format?: string, lastN?: number) => void;
  editMessages: () => void;
  addDirective: (text: string) => void;
  removeDirective: (index: number) => void;
  toggleDirective: (index: number) => void;
  listDirectives: () => void;
  addPlatformBinding: (platform: string, scope: string, permission: string) => void;
  removePlatformBinding: (index: number) => void;
  listPlatformBindings: () => void;
  listChannelResponses: () => void;
  setChannelResponseEnabled: (index: number, enabled: boolean) => void;
  setChannelResponsePrompt: (index: number, prompt: string) => void;
  setChannelResponseAgent: (index: number, agentName: string) => void;
  clearChannelResponse: (index: number) => void;
  listTools: () => void;
  setToolsMode: (mode: any) => void;
  addAllowedTool: (toolName: string) => void;
  removeAllowedTool: (toolName: string) => void;
  clearAllowedTools: () => void;
  addDeniedTool: (toolName: string) => void;
  removeDeniedTool: (toolName: string) => void;
  clearDeniedTools: () => void;
  showGoogleDocsAuthStatus: () => void;
  setGoogleDocsRefreshToken: (token: string) => void;
  openToolsSettings: () => void;
  showPlaybook: () => void;
}

export interface UseSubmitHandlerResult {
  handleSubmit: (text: string) => Promise<void>;
  executeClear: () => void;
}

export function useSubmitHandler(deps: UseSubmitHandlerDeps): UseSubmitHandlerResult {
  const {
    chatServiceRef, talkManagerRef, activeTalkIdRef, gatewayTalkIdRef, primaryAgentRef,
    sendMessage, isProcessing, setMessages,
    pendingAttachment, setPendingAttachment,
    pendingDocument, setPendingDocument,
    pendingFiles, setPendingFiles, setFileIndicatorSelected,
    setInputText, setStreamingAgentName, setError, scrollToBottom,
    messageQueue, setMessageQueue,
    ensureGatewayTalk, sendMultiAgentMessage,
    commandCtxHandlers,
  } = deps;

  // Keep command context ref always current
  const commandCtx = useRef(commandCtxHandlers);
  commandCtx.current = commandCtxHandlers;

  const executeClear = useCallback(() => {
    setMessages([]);
    // Note: sessionManager.clearActiveSession is called via the command context
    setError(null);
    const sysMsg = createMessage('system', 'Chat cleared.');
    setMessages([sysMsg]);
  }, [setMessages, setError]);

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (dispatchCommand(trimmed, commandCtx.current)) {
      setInputText('');
      return;
    }

    setInputText('');
    scrollToBottom();

    // If already processing, queue the message
    if (isProcessing) {
      setMessageQueue(prev => [...prev, trimmed]);
      return;
    }

    const gwTalkId = await ensureGatewayTalk();
    if (!gwTalkId) return;

    // Process staged pending files before routing
    let finalMessage = trimmed;
    let fileAttachment: PendingAttachment | undefined;
    let fileDoc: { filename: string; text: string } | undefined;

    if (pendingFiles.length > 0) {
      const files = [...pendingFiles];
      setPendingFiles([]);
      setFileIndicatorSelected(false);

      const uploadNotes: string[] = [];

      for (const file of files) {
        if (chatServiceRef.current) {
          const uploadMsg = createMessage('system', `[uploading] ${file.filename}...`);
          setMessages(prev => [...prev, uploadMsg]);
          try {
            const uploadData = await readFileForUpload(file.path);
            const uploadResult = await chatServiceRef.current.uploadFile(uploadData.filename, uploadData.base64);
            const sizeKB = Math.round(uploadResult.sizeBytes / 1024);
            const preferredPath = uploadResult.agentPath || uploadResult.workspacePath || uploadResult.serverPath;
            uploadNotes.push(`[File "${file.filename}" uploaded to server: ${preferredPath}]`);
            setMessages(prev => {
              const filtered = prev.filter(m => m.id !== uploadMsg.id);
              return [...filtered, createMessage('system', `[uploaded] ${uploadResult.filename} (${sizeKB}KB) → ${preferredPath}`)];
            });
          } catch (uploadErr) {
            setMessages(prev => prev.filter(m => m.id !== uploadMsg.id));
            const errMsg = uploadErr instanceof Error ? uploadErr.message : 'Unknown error';
            setMessages(prev => [...prev, createMessage('system', `[upload failed] ${file.filename}: ${errMsg}`)]);
          }
        }

        try {
          const result = await processFile(file.path);
          if (result.type === 'image' && !fileAttachment) {
            fileAttachment = result.attachment;
          } else if (result.type === 'document') {
            if (!fileDoc) fileDoc = { filename: result.filename, text: result.text };
            else fileDoc.text += `\n\n--- ${result.filename} ---\n${result.text}`;
          }
        } catch { /* upload note still provides server path */ }
      }

      const prefix = uploadNotes.length > 0 ? uploadNotes.join('\n') + '\n\n' : '';
      finalMessage = `${prefix}${trimmed}`;
    }

    // When agents are configured, route through multi-agent
    const talkId = activeTalkIdRef.current;
    if (talkId && talkManagerRef.current) {
      const allAgents = talkManagerRef.current.getAgents(talkId);
      if (allAgents.length > 0) {
        const mentionPattern = /(?:^|\s)@(\w+)/g;
        const mentionedAgents: TalkAgent[] = [];
        let match;
        while ((match = mentionPattern.exec(finalMessage)) !== null) {
          const agent = talkManagerRef.current.findAgent(talkId, match[1]);
          if (agent && !mentionedAgents.includes(agent)) {
            mentionedAgents.push(agent);
          }
        }

        const targets = mentionedAgents.length > 0
          ? mentionedAgents
          : allAgents.filter(a => a.isPrimary);

        if (targets.length > 0) {
          await sendMultiAgentMessage(finalMessage, targets, allAgents);
          return;
        }
      }
    }

    // No agents configured — send through regular chat path
    const attachment = fileAttachment ?? pendingAttachment ?? undefined;
    if (pendingAttachment) {
      setPendingAttachment(null);
    }

    const docContent = fileDoc ?? pendingDocument ?? undefined;
    if (pendingDocument) {
      setPendingDocument(null);
    }

    const primaryName = primaryAgentRef.current?.name;
    if (primaryName) setStreamingAgentName(primaryName);

    await sendMessage(finalMessage, attachment, docContent);

    if (primaryName) setStreamingAgentName(undefined);
  }, [sendMessage, isProcessing, sendMultiAgentMessage, pendingAttachment, pendingDocument, pendingFiles, ensureGatewayTalk, chatServiceRef, talkManagerRef, activeTalkIdRef, primaryAgentRef, setInputText, scrollToBottom, setMessageQueue, setPendingFiles, setFileIndicatorSelected, setMessages, setPendingAttachment, setPendingDocument, setStreamingAgentName]);

  // Process queued messages when AI finishes responding
  useEffect(() => {
    if (!isProcessing && messageQueue.length > 0) {
      const timer = setTimeout(() => {
        const nextMessage = messageQueue[0];
        if (nextMessage) {
          setMessageQueue(prev => prev.slice(1));
          void (async () => {
            const gwTalkId = await ensureGatewayTalk();
            if (!gwTalkId) return;
            await sendMessage(nextMessage);
          })();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isProcessing, messageQueue, sendMessage, ensureGatewayTalk, setMessageQueue]);

  return {
    handleSubmit,
    executeClear,
  };
}
