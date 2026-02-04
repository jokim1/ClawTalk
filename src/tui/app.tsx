/**
 * RemoteClaw TUI App
 *
 * Main terminal user interface built with Ink (React for CLI).
 * Composes custom hooks for gateway, chat, voice, and model management.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import type { RemoteClawOptions, ModelStatus } from '../types.js';
import { StatusBar, ShortcutBar } from './components/StatusBar';
import { ChatView } from './components/ChatView.js';
import { InputArea } from './components/InputArea.js';
import { ModelPicker } from './components/ModelPicker.js';
import type { Model } from './components/ModelPicker.js';
import { TranscriptHub } from './components/TranscriptHub';
import { SettingsPicker } from './components/SettingsPicker.js';
import { ChatService } from '../services/chat';
import { getSessionManager } from '../services/sessions';
import type { SessionManager } from '../services/sessions';
import { spawnNewTerminalWindow } from '../services/terminal.js';
import { VoiceService } from '../services/voice.js';
import { AnthropicRateLimitService } from '../services/anthropic-ratelimit.js';
import { loadConfig, getBillingForProvider } from '../config.js';
import type { BillingOverride } from '../config.js';
import {
  getModelAlias,
  getModelPricing,
  getProviderKey,
  formatPricingLabel,
} from '../models.js';
import { DEFAULT_MODEL, RESIZE_DEBOUNCE_MS } from '../constants.js';
import { createMessage, cleanInputChar } from './helpers.js';
import { dispatchCommand } from './commands.js';
import { useGateway } from './hooks/useGateway.js';
import { useChat } from './hooks/useChat.js';
import { useVoice } from './hooks/useVoice.js';

interface AppProps {
  options: RemoteClawOptions;
}

function App({ options }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [savedConfig, setSavedConfig] = useState(() => loadConfig());

  // --- Resize handling ---

  const [dimensions, setDimensions] = useState({
    width: stdout?.columns ?? 80,
    height: stdout?.rows ?? 24,
  });
  const [resizeKey, setResizeKey] = useState(0);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleResize = () => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(() => {
        setDimensions({ width: stdout?.columns ?? 80, height: stdout?.rows ?? 24 });
        setResizeKey(k => k + 1);
      }, RESIZE_DEBOUNCE_MS);
    };
    stdout?.on('resize', handleResize);
    return () => {
      stdout?.off('resize', handleResize);
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    };
  }, [stdout]);

  const terminalHeight = dimensions.height;
  const terminalWidth = dimensions.width;

  // --- Service refs ---

  const chatServiceRef = useRef<ChatService | null>(null);
  const sessionManagerRef = useRef<SessionManager | null>(null);
  const voiceServiceRef = useRef<VoiceService | null>(null);
  const anthropicRLRef = useRef<AnthropicRateLimitService | null>(null);

  // --- Shared state ---

  const [currentModel, setCurrentModel] = useState(options.model ?? DEFAULT_MODEL);
  const currentModelRef = useRef(currentModel);
  useEffect(() => { currentModelRef.current = currentModel; }, [currentModel]);

  const [modelStatus, setModelStatus] = useState<ModelStatus>('unknown');
  const probeAbortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionName, setSessionName] = useState('Session 1');
  const [chatScrollOffset, setChatScrollOffset] = useState(0);

  // --- TTS bridge ref (useChat → useVoice) ---

  const speakResponseRef = useRef<((text: string) => void) | null>(null);

  // --- Pricing ref (kept current for session cost calculation) ---

  const pricingRef = useRef({ inputPer1M: 0.14, outputPer1M: 0.28 });

  // --- Hooks ---

  const chat = useChat(
    chatServiceRef, sessionManagerRef, currentModelRef,
    setError, speakResponseRef,
    (err) => setModelStatus({ error: err }),
    pricingRef,
  );

  const gateway = useGateway(
    chatServiceRef, voiceServiceRef, anthropicRLRef, currentModelRef,
    {
      onInitialProbe: (model) => {
        // Skip if a probe was already triggered (e.g., by switchModel)
        if (modelStatus !== 'unknown') return;
        // Skip 'checking' state during initial probe to prevent layout shift
        probeCurrentModel(model, undefined, true);
      },
      onBillingDiscovered: (billing) => {
        setSavedConfig(prev => ({
          ...prev,
          billing: { ...billing, ...prev.billing },
        }));
      },
    },
  );

  const voice = useVoice({
    voiceServiceRef,
    readiness: gateway.voiceCaps.readiness,
    ttsAvailable: gateway.voiceCaps.ttsAvailable,
    voiceConfig: savedConfig.voice,
    sendMessageRef: chat.sendMessageRef,
    onInputText: setInputText,
    setError,
  });

  // Wire TTS: when chat receives an assistant response, speak it
  speakResponseRef.current = voice.speakResponse;

  // Auto-scroll to bottom when new messages arrive
  const prevMessageCountRef = useRef(chat.messages.length);
  useEffect(() => {
    if (chat.messages.length > prevMessageCountRef.current) {
      setChatScrollOffset(0); // Scroll to bottom
    }
    prevMessageCountRef.current = chat.messages.length;
  }, [chat.messages.length]);

  // --- Service initialization ---

  useEffect(() => {
    chatServiceRef.current = new ChatService({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      agentId: 'remoteclaw',
      model: currentModel,
    });

    voiceServiceRef.current = new VoiceService({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
    });

    if (options.anthropicApiKey) {
      anthropicRLRef.current = new AnthropicRateLimitService(options.anthropicApiKey);
    }

    sessionManagerRef.current = getSessionManager();

    let session;
    if (options.sessionName) {
      const existing = sessionManagerRef.current.listSessions().find(s => s.name === options.sessionName);
      if (existing) {
        session = sessionManagerRef.current.setActiveSession(existing.id) || sessionManagerRef.current.getActiveSession();
      } else {
        session = sessionManagerRef.current.createSession(options.sessionName, options.model);
      }
    } else {
      session = sessionManagerRef.current.createSession(undefined, options.model);
    }

    // Batch state updates by deferring to next tick (allows React to batch)
    // This prevents multiple re-renders during initialization
    const msgs = session.messages;
    const model = session.model;
    const name = session.name;

    // Use a micro-task to batch these updates
    queueMicrotask(() => {
      chat.setMessages(msgs);
      setCurrentModel(model);
      setSessionName(name);
    });

    if (chatServiceRef.current && session.model) {
      chatServiceRef.current.setModel(session.model);
      chatServiceRef.current.setModelOverride(session.model).catch(() => {});
    }

    return () => { voiceServiceRef.current?.cleanup(); };
  }, []);

  // --- Model management ---

  const probeCurrentModel = useCallback((modelId: string, previousModel?: string, skipCheckingState?: boolean) => {
    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;

    // Skip 'checking' state during initial probe to prevent layout shift
    if (!skipCheckingState) {
      setModelStatus('checking');
    }

    chatServiceRef.current?.probeModel(modelId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setModelStatus('ok');
        chat.setMessages(prev => [...prev, createMessage('system', `${getModelAlias(modelId)} is responding. Ready.`)]);
      } else {
        setModelStatus({ error: result.reason });
        setError(result.reason);
        chat.setMessages(prev => [...prev, createMessage('system', `Model probe failed: ${result.reason}`)]);
        // Revert to previous model on probe failure
        if (previousModel) {
          setCurrentModel(previousModel);
          chatServiceRef.current?.setModel(previousModel);
          sessionManagerRef.current?.setSessionModel(previousModel);
        }
      }
    });
  }, []);

  // Update model pricing when model changes
  useEffect(() => {
    if (chatServiceRef.current) {
      chatServiceRef.current.setModel(currentModel);
      const p = getModelPricing(currentModel);
      pricingRef.current = { inputPer1M: p.input, outputPer1M: p.output };
      gateway.setUsage(prev => ({
        ...prev,
        modelPricing: { inputPer1M: p.input, outputPer1M: p.output },
      }));
    }
  }, [currentModel]);

  const switchModel = useCallback((modelId: string) => {
    const previousModel = chatServiceRef.current?.getModel();
    setCurrentModel(modelId);
    chatServiceRef.current?.setModel(modelId);
    sessionManagerRef.current?.setSessionModel(modelId);

    chat.setMessages(prev => [...prev, createMessage('system', `Switched to ${getModelAlias(modelId)}. Checking connection...`)]);
    setError(null);

    chatServiceRef.current?.setModelOverride(modelId).catch(() => {});
    probeCurrentModel(modelId, previousModel);
  }, [probeCurrentModel]);

  const selectModel = useCallback((modelId: string) => {
    setShowModelPicker(false);
    switchModel(modelId);
  }, [switchModel]);

  // Build picker model list
  const pickerModels: Model[] = gateway.availableModels.map(m => {
    const providerBilling = getBillingForProvider(savedConfig, getProviderKey(m.id));
    return {
      id: m.id,
      label: `${m.emoji} ${m.name}`,
      preset: m.tier,
      provider: m.provider,
      pricingLabel: formatPricingLabel(m, providerBilling),
    };
  });

  // --- Submit handler (command registry + chat) ---

  const commandCtx = useRef({
    switchModel,
    openModelPicker: () => setShowModelPicker(true),
    clearSession: () => {
      chat.setMessages([]);
      sessionManagerRef.current?.clearActiveSession();
      setError(null);
    },
    setError,
  });
  commandCtx.current = { switchModel, openModelPicker: () => setShowModelPicker(true), clearSession: () => { chat.setMessages([]); sessionManagerRef.current?.clearActiveSession(); setError(null); }, setError };

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (dispatchCommand(trimmed, commandCtx.current)) {
      setInputText('');
      return;
    }

    setInputText('');
    await chat.sendMessage(trimmed);
  }, [chat.sendMessage]);

  // --- Keyboard shortcuts ---

  useInput((input, key) => {
    if (showModelPicker || showTranscript || showSettings) return;

    if (key.escape) {
      if (voice.handleEscape()) return;
    }

    // ^X Exit
    if (input === 'x' && key.ctrl) {
      voiceServiceRef.current?.cleanup();
      exit();
      return;
    }

    // ^T Talk Live (real-time voice chat)
    if (input === 't' && key.ctrl) {
      if (chat.isProcessing) {
        setError('Cannot start live talk while processing');
      } else {
        voice.handleLiveTalk?.();
      }
      cleanInputChar(setInputText, 't');
      return;
    }

    // ^A AI Model (opens model picker)
    if (input === 'a' && key.ctrl) {
      setShowModelPicker(true);
      cleanInputChar(setInputText, 'a');
      return;
    }

    // ^P Push-to-Talk (voice recording)
    if (input === 'p' && key.ctrl) {
      if (chat.isProcessing) {
        setError('Cannot record while processing');
      } else {
        voice.handleVoiceToggle();
      }
      cleanInputChar(setInputText, 'p');
      return;
    }

    // ^C Chat (realtime voice)
    if (input === 'c' && key.ctrl) {
      if (chat.isProcessing) {
        setError('Cannot start chat while processing');
      } else {
        voice.handleLiveTalk?.();
      }
      cleanInputChar(setInputText, 'c');
      return;
    }

    // ^H History (transcripts) - Ctrl+H sends ASCII 8 (backspace) in terminals
    if (input === '\x08' || (input === 'h' && key.ctrl)) {
      setShowTranscript(true);
      return;
    }

    // ^V AI Voice (toggle TTS responses)
    if (input === 'v' && key.ctrl) {
      voice.handleTtsToggle?.();
      cleanInputChar(setInputText, 'v');
      return;
    }

    // ^N New terminal window
    if (input === 'n' && key.ctrl) {
      spawnNewTerminalWindow(options);
      cleanInputChar(setInputText, 'n');
      return;
    }

    // ^S Settings
    if (input === 's' && key.ctrl) {
      setShowSettings(true);
      cleanInputChar(setInputText, 's');
      return;
    }

    // Generic Ctrl+key cleanup
    if (key.ctrl && input.match(/[a-z]/i)) {
      cleanInputChar(setInputText, input);
      return;
    }
  });

  // --- Layout ---

  const headerHeight = 3;
  const inputSeparatorHeight = 1;
  const shortcutBarHeight = 2;
  // Always reserve 1 line for error to prevent layout shifts
  const errorHeight = 1;

  const inputPadding = 4;
  const promptWidth = 2;
  const availableInputWidth = Math.max(1, terminalWidth - inputPadding - promptWidth);
  const inputHeight = Math.max(1, Math.ceil((inputText.length + 1) / availableInputWidth));

  const chatHeight = Math.max(3, terminalHeight - headerHeight - inputSeparatorHeight - inputHeight - shortcutBarHeight - errorHeight);
  const layoutKey = `${terminalWidth}x${terminalHeight}-${resizeKey}`;

  // --- Render ---

  // Show loading state until gateway is initialized to prevent layout shifts
  // The multiple state updates during startup cause re-renders that shift the UI
  if (!gateway.isInitialized) {
    return (
      <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
        <Box height={3} paddingX={1}>
          <Text dimColor>Starting RemoteClaw...</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
      <Box height={3} flexShrink={0}>
        <StatusBar
          gatewayStatus={gateway.gatewayStatus}
          tailscaleStatus={gateway.tailscaleStatus}
          model={currentModel}
          modelStatus={modelStatus}
          usage={{ ...gateway.usage, sessionCost: chat.sessionCost }}
          billing={getBillingForProvider(savedConfig, getProviderKey(currentModel))}
          sessionName={sessionName}
          terminalWidth={terminalWidth}
          voiceMode={voice.voiceMode}
          voiceReadiness={gateway.voiceCaps.readiness}
        />
      </Box>

      <Box height={1} flexShrink={0} paddingX={1}>
        {error ? <Text color="red">! {error}</Text> : null}
      </Box>

      <Box flexDirection="column" height={chatHeight} flexGrow={1} flexShrink={1} paddingX={1}>
        {showModelPicker ? (
          <ModelPicker
            models={pickerModels}
            currentModel={currentModel}
            onSelect={selectModel}
            onClose={() => setShowModelPicker(false)}
            maxHeight={chatHeight}
          />
        ) : showTranscript ? (
          <TranscriptHub
            currentMessages={chat.messages}
            currentSessionName={sessionName}
            sessionManager={sessionManagerRef.current!}
            maxHeight={chatHeight}
            terminalWidth={terminalWidth}
            onClose={() => setShowTranscript(false)}
          />
        ) : showSettings ? (
          <SettingsPicker
            onClose={() => setShowSettings(false)}
          />
        ) : (
          <ChatView
            messages={chat.messages}
            isProcessing={chat.isProcessing}
            streamingContent={chat.streamingContent}
            modelAlias={getModelAlias(currentModel)}
            maxHeight={chatHeight}
            terminalWidth={terminalWidth}
            scrollOffset={chatScrollOffset}
            onScroll={setChatScrollOffset}
            isActive={!showModelPicker && !showTranscript && !showSettings}
          />
        )}
      </Box>

      <Box height={1} flexShrink={0}>
        <Text dimColor>{'─'.repeat(terminalWidth)}</Text>
      </Box>

      <Box height={inputHeight} flexShrink={0} paddingX={1}>
        <InputArea
          value={inputText}
          onChange={setInputText}
          onSubmit={handleSubmit}
          disabled={chat.isProcessing}
          voiceMode={voice.voiceMode}
          volumeLevel={voice.volumeLevel}
        />
      </Box>

      <Box height={2} flexShrink={0}>
        <ShortcutBar terminalWidth={terminalWidth} ttsEnabled={voice.ttsEnabled} />
      </Box>
    </Box>
  );
}

export async function launchRemoteClaw(options: RemoteClawOptions): Promise<void> {
  const { waitUntilExit } = render(<App options={options} />, { exitOnCtrlC: false });
  await waitUntilExit();
}
