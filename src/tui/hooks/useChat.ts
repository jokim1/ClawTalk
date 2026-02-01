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

    // Capture history before adding the new user message
    const history = messagesRef.current;
    const userMsg = createMessage('user', trimmed);
    setMessages(prev => [...prev, userMsg]);
    sessionManagerRef.current?.addMessage(userMsg);

    isProcessingRef.current = true;
    setIsProcessing(true);
    setStreamingContent('');

    try {
      let fullContent = '';
      for await (const chunk of chatService.streamMessage(trimmed, history)) {
        fullContent += chunk;
        setStreamingContent(fullContent);
      }

      if (!isGatewaySentinel(fullContent)) {
        const model = chatService.lastResponseModel ?? currentModelRef.current;
        const assistantMsg = createMessage('assistant', fullContent, model);
        setMessages(prev => [...prev, assistantMsg]);
        sessionManagerRef.current?.addMessage(assistantMsg);
        speakResponseRef.current?.(fullContent);
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

      setStreamingContent('');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setErrorRef.current(errorMessage);

      if (/\b(40[1349]|429|5\d{2})\b/.test(errorMessage)) {
        onModelErrorRef.current(errorMessage);
      }

      setMessages(prev => [...prev, createMessage('system', `Error: ${errorMessage}`)]);
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      setStreamingContent('');
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
