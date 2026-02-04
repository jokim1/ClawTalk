/**
 * Chat message sending and streaming state hook
 *
 * Manages message history, streaming content, processing state,
 * session cost accumulation, and the sendMessage async function.
 */

import { useState, useCallback, useRef } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { Message } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { SessionManager } from '../../services/sessions.js';
import { isGatewaySentinel } from '../../constants.js';
import { createMessage } from '../helpers.js';

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

  const sendMessage = useCallback(async (text: string) => {
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
    setMessages(prev => [...prev, userMsg]);
    sessionManagerRef.current?.addMessage(userMsg);

    isProcessingRef.current = true;
    setIsProcessing(true);
    setStreamingContent('');

    // Helper to check if still on the same talk
    const isStillOnSameTalk = () => activeTalkIdRef.current === originTalkId;

    try {
      let fullContent = '';
      for await (const chunk of chatService.streamMessage(trimmed, history)) {
        fullContent += chunk;
        // Only update streaming UI if still on the same talk
        if (isStillOnSameTalk()) {
          setStreamingContent(fullContent);
        }
      }

      // If streaming yielded no content, fall back to non-streaming
      if (!fullContent.trim()) {
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
          setMessages(prev => [...prev, createMessage('system', `Gateway error: ${fullContent}`)]);
          setStreamingContent('');
        }
        return;
      }

      if (!isGatewaySentinel(fullContent)) {
        const model = chatService.lastResponseModel ?? currentModelRef.current;
        const assistantMsg = createMessage('assistant', fullContent, model);

        // Always save to the original session (even if user switched talks)
        if (originSessionId) {
          sessionManagerRef.current?.addMessageToSession(originSessionId, assistantMsg);
        }

        // Only update UI and speak if still on the same talk
        if (isStillOnSameTalk()) {
          setMessages(prev => [...prev, assistantMsg]);
          speakResponseRef.current?.(fullContent);
        }
      } else if (!fullContent.trim()) {
        // Gateway returned empty response even after fallback
        if (isStillOnSameTalk()) {
          setMessages(prev => [...prev, createMessage('system', 'No response received from AI. The model may be unavailable or the connection was interrupted.')]);
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
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';

      if (isStillOnSameTalk()) {
        setErrorRef.current(errorMessage);
        setMessages(prev => [...prev, createMessage('system', `Error: ${errorMessage}`)]);
      }

      if (/\b(40[1349]|429|5\d{2})\b/.test(errorMessage)) {
        onModelErrorRef.current(errorMessage);
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

  return {
    messages,
    setMessages,
    isProcessing,
    streamingContent,
    sendMessage,
    sendMessageRef,
    sessionCost,
  };
}
