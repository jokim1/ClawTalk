/**
 * Chat message sending and streaming state hook
 *
 * Manages message history, streaming content, processing state,
 * session cost accumulation, and the sendMessage async function.
 */

import { useState, useCallback, useRef } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { Message, PendingAttachment, DocumentContent, TalkAgent, StreamChunk } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { SessionManager } from '../../services/sessions.js';
import { isGatewaySentinel } from '../../constants.js';
import { createMessage, parseJobBlocks } from '../helpers.js';

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export function useChat(
  chatServiceRef: MutableRefObject<ChatService | null>,
  sessionManagerRef: MutableRefObject<SessionManager | null>,
  currentModelRef: MutableRefObject<string>,
  setError: Dispatch<SetStateAction<string | null>>,
  speakResponseRef: MutableRefObject<((text: string) => void) | null>,
  onModelError: (error: string) => void,
  pricingRef: MutableRefObject<ModelPricing>,
  activeTalkIdRef: MutableRefObject<string | null>,
  /** Gateway talk ID — when set, messages route through /api/talks/:id/chat */
  gatewayTalkIdRef: MutableRefObject<string | null>,
  /** Primary agent — when set, used for speaker label on regular chat responses */
  primaryAgentRef: MutableRefObject<TalkAgent | null>,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [sessionCost, setSessionCost] = useState(0);

  // Refs for values needed inside the stable sendMessage callback
  const isProcessingRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const setErrorRef = useRef(setError);
  setErrorRef.current = setError;
  const onModelErrorRef = useRef(onModelError);
  onModelErrorRef.current = onModelError;

  const sendMessage = useCallback(async (text: string, attachment?: PendingAttachment, documentContent?: DocumentContent) => {
    const chatService = chatServiceRef.current;
    if (!text.trim() || isProcessingRef.current || !chatService) return;

    const trimmed = text.trim();
    setErrorRef.current(null);

    // Capture the talk ID and session ID at the start - these won't change during streaming
    const originTalkId = activeTalkIdRef.current;
    const originSessionId = sessionManagerRef.current?.getActiveSessionId() ?? null;

    // Capture history before adding the new user message
    const history = messagesRef.current;
    const userMsg = createMessage('user', trimmed);
    if (attachment) {
      userMsg.attachment = {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        width: attachment.width,
        height: attachment.height,
        sizeBytes: attachment.sizeBytes,
      };
    }
    if (documentContent) {
      userMsg.attachment = {
        filename: documentContent.filename,
        mimeType: 'application/octet-stream',
        width: 0,
        height: 0,
        sizeBytes: documentContent.text.length,
      };
    }
    setMessages(prev => [...prev, userMsg]);
    sessionManagerRef.current?.addMessage(userMsg);

    isProcessingRef.current = true;
    setIsProcessing(true);
    setStreamingContent('');

    // Helper to check if still on the same talk
    const isStillOnSameTalk = () => activeTalkIdRef.current === originTalkId;

    // Route through gateway Talk endpoint when available, otherwise direct
    const gwTalkId = gatewayTalkIdRef.current;

    // When document content is provided, embed it in the message sent to the LLM
    const llmText = documentContent
      ? `<file name="${documentContent.filename}">\n${documentContent.text}\n</file>\n\n${trimmed}`
      : trimmed;

    let fullContent = '';
    try {
      const imageParam = attachment ? { base64: attachment.base64, mimeType: attachment.mimeType } : undefined;

      if (gwTalkId) {
        // Gateway Talk streaming — handles StreamChunk (content + tool events)
        const stream = chatService.streamTalkMessage(gwTalkId, llmText, undefined, imageParam);
        for await (const chunk of stream) {
          if (chunk.type === 'content') {
            fullContent += chunk.text;
            if (isStillOnSameTalk()) {
              setStreamingContent(fullContent);
            }
          } else if (chunk.type === 'tool_start') {
            if (isStillOnSameTalk()) {
              const toolMsg = createMessage('system', `[Tool] ${chunk.name}(${chunk.arguments.slice(0, 100)}${chunk.arguments.length > 100 ? '...' : ''})`);
              setMessages(prev => [...prev, toolMsg]);
            }
          } else if (chunk.type === 'tool_end') {
            if (isStillOnSameTalk()) {
              const status = chunk.success ? 'OK' : 'ERROR';
              const preview = chunk.content.slice(0, 200) + (chunk.content.length > 200 ? '...' : '');
              const toolMsg = createMessage('system', `[Tool ${status}] ${chunk.name} (${chunk.durationMs}ms): ${preview}`);
              setMessages(prev => [...prev, toolMsg]);
            }
          }
        }
      } else {
        // Direct streaming — yields plain strings
        const stream = chatService.streamMessage(llmText, history);
        for await (const chunk of stream) {
          fullContent += chunk;
          if (isStillOnSameTalk()) {
            setStreamingContent(fullContent);
          }
        }
      }

      // If streaming yielded no content, fall back to non-streaming (only for direct mode)
      if (!fullContent.trim() && !gwTalkId) {
        if (isStillOnSameTalk()) {
          setStreamingContent('retrying...');
        }
        try {
          const fallbackResponse = await chatService.sendMessage(trimmed, history);
          if (fallbackResponse.content) {
            fullContent = fallbackResponse.content;
            if (isStillOnSameTalk()) {
              setStreamingContent(fullContent);
            }
          }
        } catch (fallbackErr) {
          // Non-streaming fallback failed - throw to outer catch
          throw fallbackErr;
        }
      }

      // Detect error-like responses from gateway
      const looksLikeError = /^(Connection error|Error:|Failed to|Cannot connect|Timeout)/i.test(fullContent.trim());
      if (looksLikeError) {
        if (isStillOnSameTalk()) {
          const sysMsg = createMessage('system', `Gateway error: ${fullContent}`);
          setMessages(prev => [...prev, sysMsg]);

          setStreamingContent('');
        }
        return;
      }

      if (!isGatewaySentinel(fullContent)) {
        const model = chatService.lastResponseModel ?? currentModelRef.current;
        const primary = primaryAgentRef.current;
        const assistantMsg = createMessage(
          'assistant', fullContent, model,
          primary?.name, primary?.role,
        );

        // Save to local session when not using gateway (gateway persists its own history)
        if (!gwTalkId && originSessionId) {
          sessionManagerRef.current?.addMessageToSession(originSessionId, assistantMsg);
        }

        // Only update UI and speak if still on the same talk
        if (isStillOnSameTalk()) {
          setMessages(prev => [...prev, assistantMsg]);

          // Show confirmation for any auto-created jobs
          const jobBlocks = parseJobBlocks(fullContent);
          for (const { schedule, prompt } of jobBlocks) {
            const isOneOff = /^(in\s|at\s)/i.test(schedule);
            const label = isOneOff ? 'Job Scheduled' : 'Recurring Job Scheduled';
            const jobMsg = createMessage('system', `[${label}] "${prompt}" — ${schedule}`);
            setMessages(prev => [...prev, jobMsg]);
          }

          speakResponseRef.current?.(fullContent);
        }
      } else if (!fullContent.trim()) {
        // Gateway returned empty response even after fallback
        if (isStillOnSameTalk()) {
          const sysMsg = createMessage('system', 'No response received from AI. The model may be unavailable or the connection was interrupted.');
          setMessages(prev => [...prev, sysMsg]);

        }
      }

      // Accumulate session cost from token usage
      const usage = chatService.lastResponseUsage;
      if (usage) {
        const pricing = pricingRef.current;
        const cost =
          (usage.promptTokens * pricing.inputPer1M / 1_000_000) +
          (usage.completionTokens * pricing.outputPer1M / 1_000_000);
        setSessionCost(prev => prev + cost);
      }

      if (isStillOnSameTalk()) {
        setStreamingContent('');
      }
    } catch (err) {
      // --- Retry on transient errors for gateway Talk mode (max 1 retry) ---
      const { isTransientError, GatewayStreamError } = await import('../../services/chat.js');
      if (gwTalkId && isTransientError(err)) {
        const partialContent = err instanceof GatewayStreamError ? err.partialContent : fullContent;

        if (isStillOnSameTalk()) {
          setStreamingContent(partialContent + '\n\n[retrying...]');
        }

        try {
          let retryContent = '';
          const recoveryMsg = partialContent
            ? 'Your previous response was interrupted. Continue from where you left off.'
            : llmText;

          const retryStream = chatService.streamTalkMessage(gwTalkId, recoveryMsg, undefined, undefined, true);
          for await (const chunk of retryStream) {
            if (chunk.type === 'content') {
              retryContent += chunk.text;
              if (isStillOnSameTalk()) {
                setStreamingContent(partialContent + retryContent);
              }
            }
          }

          // Merge partial + retry as a single response
          fullContent = partialContent + retryContent;

          if (fullContent.trim() && isStillOnSameTalk()) {
            const model = chatService.lastResponseModel ?? currentModelRef.current;
            const primary = primaryAgentRef.current;
            const assistantMsg = createMessage(
              'assistant', fullContent, model,
              primary?.name, primary?.role,
            );
            setMessages(prev => [...prev, assistantMsg]);
            speakResponseRef.current?.(fullContent);
          }

          // Accumulate session cost
          const usage = chatService.lastResponseUsage;
          if (usage) {
            const pricing = pricingRef.current;
            const cost =
              (usage.promptTokens * pricing.inputPer1M / 1_000_000) +
              (usage.completionTokens * pricing.outputPer1M / 1_000_000);
            setSessionCost(prev => prev + cost);
          }

          if (isStillOnSameTalk()) {
            setStreamingContent('');
          }
          return; // Recovery succeeded — skip the error handling below
        } catch {
          // Retry also failed — fall through to normal error handling
        }
      }

      const rawMessage = err instanceof Error ? err.message : 'Unknown error';

      // Map low-level errors to user-friendly messages
      let errorMessage = rawMessage;
      if (/\bterminated\b|aborted|abort/i.test(rawMessage)) {
        errorMessage = 'Request was interrupted. Please try again.';
      } else if (/fetch failed|network error|connection refused|econnrefused/i.test(rawMessage)) {
        errorMessage = 'Connection failed. Please check your network and gateway status.';
      } else if (/timeout/i.test(rawMessage)) {
        errorMessage = 'Request timed out. The model may be overloaded or unavailable.';
      }

      if (isStillOnSameTalk()) {
        setErrorRef.current(errorMessage);
        const sysMsg = createMessage('system', `Error: ${errorMessage}`);
        setMessages(prev => [...prev, sysMsg]);
      }

      if (/\b(40[1349]|429|5\d{2})\b/.test(rawMessage)) {
        onModelErrorRef.current(rawMessage);
      }
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      if (isStillOnSameTalk()) {
        setStreamingContent('');
      }
    }
  }, []);

  // Stable ref for voice hook to call sendMessage without stale closures
  const sendMessageRef = useRef(sendMessage);

  /** Clear streaming state — call when switching talks to avoid cross-talk bleed */
  const clearStreaming = useCallback(() => {
    setStreamingContent('');
  }, []);

  return {
    messages,
    setMessages,
    isProcessing,
    streamingContent,
    clearStreaming,
    sendMessage,
    sendMessageRef,
    sessionCost,
  };
}
