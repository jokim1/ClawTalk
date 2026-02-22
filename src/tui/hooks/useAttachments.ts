/**
 * Attachment state and handlers hook.
 *
 * Manages pending attachments (images, documents, files), file path detection
 * from input text, and the file attachment command handler.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Message, PendingAttachment } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import { processFile } from '../../services/file.js';
import { detectFilePaths } from '../../services/file.js';
import { createMessage } from '../helpers.js';

export interface UseAttachmentsDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  isOverlayActive: boolean;
  inputText: string;
  setInputText: React.Dispatch<React.SetStateAction<string>>;
  setError: (msg: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  sendMessage: (text: string, attachment?: PendingAttachment, documentContent?: { filename: string; text: string }) => Promise<void>;
  /** Ref-based to break circular dependency with useTalkNavigation. */
  ensureGatewayTalkRef: React.MutableRefObject<(() => Promise<string | null>) | null>;
}

export interface UseAttachmentsResult {
  pendingAttachment: PendingAttachment | null;
  setPendingAttachment: React.Dispatch<React.SetStateAction<PendingAttachment | null>>;
  pendingDocument: { filename: string; text: string } | null;
  setPendingDocument: React.Dispatch<React.SetStateAction<{ filename: string; text: string } | null>>;
  pendingFiles: Array<{ path: string; filename: string }>;
  setPendingFiles: React.Dispatch<React.SetStateAction<Array<{ path: string; filename: string }>>>;
  fileIndicatorSelected: boolean;
  setFileIndicatorSelected: React.Dispatch<React.SetStateAction<boolean>>;
  handleAttachFile: (filePath: string, message?: string) => Promise<void>;
}

export function useAttachments(deps: UseAttachmentsDeps): UseAttachmentsResult {
  const {
    chatServiceRef, isOverlayActive, inputText, setInputText,
    setError, setMessages, sendMessage, ensureGatewayTalkRef,
  } = deps;

  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [pendingDocument, setPendingDocument] = useState<{ filename: string; text: string } | null>(null);
  const [pendingFiles, setPendingFiles] = useState<Array<{ path: string; filename: string }>>([]);
  const [fileIndicatorSelected, setFileIndicatorSelected] = useState(false);

  // Extract file paths from input and stage them as pending files
  useEffect(() => {
    if (isOverlayActive) return;
    const detected = detectFilePaths(inputText);
    if (detected.length === 0) return;
    let newInput = inputText;
    const newFiles: Array<{ path: string; filename: string }> = [];
    for (let i = detected.length - 1; i >= 0; i--) {
      const det = detected[i];
      newFiles.unshift({ path: det.path, filename: det.path.split('/').pop() || 'file' });
      newInput = newInput.slice(0, det.start) + newInput.slice(det.end);
    }
    newInput = newInput.replace(/\s{2,}/g, ' ').trim();
    setPendingFiles(prev => [...prev, ...newFiles]);
    setInputText(newInput);
  }, [inputText, isOverlayActive, setInputText]);

  const handleAttachFile = useCallback(async (filePath: string, message?: string) => {
    const sysMsg = createMessage('system', 'Processing file...');
    setMessages(prev => [...prev, sysMsg]);

    try {
      const result = await processFile(filePath);

      if (result.type === 'image') {
        const attachment = result.attachment;
        const sizeKB = Math.round(attachment.sizeBytes / 1024);

        if (message) {
          setMessages(prev => prev.filter(m => m.id !== sysMsg.id));
          const confirmMsg = createMessage('system', `[attached] ${attachment.filename} (${attachment.width}x${attachment.height}, ${sizeKB}KB)`);
          setMessages(prev => [...prev, confirmMsg]);
          const gwTalkId = await ensureGatewayTalkRef.current?.();
          if (!gwTalkId) return;
          await sendMessage(message, attachment);
        } else {
          setPendingAttachment(attachment);
          setMessages(prev => {
            const filtered = prev.filter(m => m.id !== sysMsg.id);
            const confirmMsg = createMessage('system', `[attached] ${attachment.filename} (${attachment.width}x${attachment.height}, ${sizeKB}KB) — type a message to send`);
            return [...filtered, confirmMsg];
          });
        }
      } else {
        const sizeKB = Math.round(result.sizeBytes / 1024);
        const pageInfo = result.pageCount ? `, ${result.pageCount} pages` : '';
        const charCount = result.text.length;

        setMessages(prev => prev.filter(m => m.id !== sysMsg.id));
        const confirmMsg = createMessage('system', `[attached] ${result.filename} (${sizeKB}KB${pageInfo}, ${charCount} chars)`);
        setMessages(prev => [...prev, confirmMsg]);

        if (message) {
          const gwTalkId = await ensureGatewayTalkRef.current?.();
          if (!gwTalkId) return;
          await sendMessage(message, undefined, { filename: result.filename, text: result.text });
        } else {
          setPendingDocument({ filename: result.filename, text: result.text });
        }
      }
    } catch (err) {
      setMessages(prev => prev.filter(m => m.id !== sysMsg.id));
      const errMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`File error: ${errMessage}`);
    }
  }, [sendMessage, ensureGatewayTalkRef, setMessages, setError]);

  return {
    pendingAttachment,
    setPendingAttachment,
    pendingDocument,
    setPendingDocument,
    pendingFiles,
    setPendingFiles,
    fileIndicatorSelected,
    setFileIndicatorSelected,
    handleAttachFile,
  };
}
