/**
 * RemoteClaw TUI App
 *
 * Main terminal user interface built with Ink (React for CLI)
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import type { RemoteClawOptions, Message, UsageStats, ModelStatus } from '../types.js';
import { StatusBar, ShortcutBar } from './components/StatusBar';
import { ChatView } from './components/ChatView.js';
import { InputArea } from './components/InputArea.js';
import { ModelPicker } from './components/ModelPicker.js';
import type { Model } from './components/ModelPicker.js';
import { TranscriptHub } from './components/TranscriptHub';
import { ChatService } from '../services/chat';
import type { ProviderInfo } from '../services/chat';
import { getStatus as getTailscaleStatus } from '../services/tailscale';
import type { TailscaleStatus } from '../services/tailscale';
import { SessionManager, getSessionManager } from '../services/sessions';
import { spawnNewTerminalWindow } from '../services/terminal.js';
import { loadConfig, getBillingForProvider } from '../config.js';
import type { BillingOverride } from '../config.js';
import {
  MODEL_REGISTRY,
  MODEL_BY_ID,
  ALIAS_TO_MODEL_ID,
  getModelAlias,
  getModelPricing,
  getProviderKey,
  formatPricingLabel,
  buildUnknownModelInfo,
} from '../models.js';
import type { ModelInfo } from '../models.js';

interface AppProps {
  options: RemoteClawOptions;
}

function App({ options }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [savedConfig, setSavedConfig] = useState(() => loadConfig());

  const [dimensions, setDimensions] = useState({
    width: stdout?.columns ?? 80,
    height: stdout?.rows ?? 24,
  });

  const [resizeKey, setResizeKey] = useState(0);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleResize = () => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = setTimeout(() => {
        const newWidth = stdout?.columns ?? 80;
        const newHeight = stdout?.rows ?? 24;
        setDimensions({ width: newWidth, height: newHeight });
        setResizeKey(k => k + 1);
      }, 100);
    };

    stdout?.on('resize', handleResize);
    return () => {
      stdout?.off('resize', handleResize);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, [stdout]);

  const terminalHeight = dimensions.height;
  const terminalWidth = dimensions.width;

  // Service refs
  const chatServiceRef = useRef<ChatService | null>(null);
  const sessionManagerRef = useRef<SessionManager | null>(null);

  // State
  const [currentModel, setCurrentModel] = useState(options.model ?? 'deepseek/deepseek-chat');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [gatewayStatus, setGatewayStatus] = useState<'online' | 'offline' | 'connecting'>('connecting');
  const [tailscaleStatus, setTailscaleStatus] = useState<TailscaleStatus | 'checking'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('Session 1');
  const [showTranscript, setShowTranscript] = useState(false);

  const [modelStatus, setModelStatus] = useState<ModelStatus>('unknown');
  const probeAbortRef = useRef<AbortController | null>(null);

  const [usage, setUsage] = useState<UsageStats>({
    todaySpend: 0,
    averageDailySpend: 0,
    modelPricing: {
      inputPer1M: 0.14,
      outputPer1M: 0.28,
    },
  });

  const probeCurrentModel = useCallback((modelId: string) => {
    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;

    setModelStatus('checking');

    chatServiceRef.current?.probeModel(modelId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setModelStatus('ok');
        const alias = getModelAlias(modelId);
        const msg: Message = {
          id: `probe-ok-${Date.now()}`,
          role: 'system',
          content: `${alias} is responding. Ready.`,
          timestamp: Date.now(),
        };
        setMessages(prev => [...prev, msg]);
      } else {
        setModelStatus({ error: result.reason });
        setError(result.reason);
        const msg: Message = {
          id: `probe-fail-${Date.now()}`,
          role: 'system',
          content: `Model probe failed: ${result.reason}`,
          timestamp: Date.now(),
        };
        setMessages(prev => [...prev, msg]);
      }
    });
  }, []);

  // Initialize services
  useEffect(() => {
    chatServiceRef.current = new ChatService({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      agentId: 'remoteclaw',
      model: currentModel,
    });

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
      session = sessionManagerRef.current.getActiveSession();
    }

    setMessages(session.messages);
    setCurrentModel(session.model);
    setSessionName(session.name);

    if (chatServiceRef.current && session.model) {
      chatServiceRef.current.setModel(session.model);
      chatServiceRef.current.setModelOverride(session.model).catch(() => {});
    }
  }, []);

  // Update model pricing when model changes
  useEffect(() => {
    if (chatServiceRef.current) {
      chatServiceRef.current.setModel(currentModel);

      const p = getModelPricing(currentModel);
      setUsage(prev => ({
        ...prev,
        modelPricing: {
          inputPer1M: p.input,
          outputPer1M: p.output,
        },
      }));
    }
  }, [currentModel]);

  // Available models
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>(MODEL_REGISTRY);

  // Check gateway status, discover models, fetch providers, fetch usage
  useEffect(() => {
    let modelsDiscovered = false;
    let initialProbed = false;
    let providersFetched = false;

    const checkGatewayAndUsage = async () => {
      if (!chatServiceRef.current) return;

      try {
        setTailscaleStatus(getTailscaleStatus());
      } catch {
        setTailscaleStatus('not-installed');
      }

      try {
        const healthy = await chatServiceRef.current.checkHealth();
        setGatewayStatus(healthy ? 'online' : 'offline');

        if (healthy) {
          if (!modelsDiscovered) {
            const gatewayModelIds = await chatServiceRef.current.listModels();
            if (gatewayModelIds && gatewayModelIds.length > 0) {
              const unknownIds = gatewayModelIds.filter(id => !MODEL_BY_ID[id]);
              if (unknownIds.length > 0) {
                const unknown = unknownIds.map(buildUnknownModelInfo);
                setAvailableModels([...MODEL_REGISTRY, ...unknown]);
              }
            }
            modelsDiscovered = true;
          }

          if (!providersFetched) {
            providersFetched = true;
            const providers = await chatServiceRef.current.getProviders();
            if (providers && providers.length > 0) {
              setSavedConfig(prev => {
                const localBilling = prev.billing ?? {};
                const gatewayBilling: Record<string, BillingOverride> = {};
                for (const p of providers) {
                  gatewayBilling[p.id] = p.billing;
                }
                // Local config overrides gateway (user can always manually override)
                return {
                  ...prev,
                  billing: { ...gatewayBilling, ...localBilling },
                };
              });
            }
          }

          if (!initialProbed) {
            initialProbed = true;
            probeCurrentModel(currentModel);
          }

          const todayUsage = await chatServiceRef.current.getCostUsage(1);
          const weekUsage = await chatServiceRef.current.getCostUsage(7);

          if (todayUsage || weekUsage) {
            setUsage(prev => ({
              ...prev,
              todaySpend: todayUsage?.totals?.totalCost ?? prev.todaySpend ?? 0,
              averageDailySpend: weekUsage?.totals?.totalCost
                ? weekUsage.totals.totalCost / 7
                : prev.averageDailySpend ?? 0,
            }));
          }
        }
      } catch {
        setGatewayStatus('offline');
      }
    };

    checkGatewayAndUsage();
    const interval = setInterval(checkGatewayAndUsage, 30000);
    return () => clearInterval(interval);
  }, []);

  // Build picker model list
  const pickerModels: Model[] = availableModels.map(m => {
    const providerBilling = getBillingForProvider(savedConfig, getProviderKey(m.id));
    return {
      id: m.id,
      label: `${m.emoji} ${m.name}`,
      preset: m.tier,
      provider: m.provider,
      pricingLabel: formatPricingLabel(m, providerBilling),
    };
  });

  // Keyboard shortcuts
  useInput((input, key) => {
    if (showModelPicker || showTranscript) return;

    if (input === 'c' && key.ctrl) {
      exit();
      return;
    }

    if ((input === 'o' || input === 'q') && key.ctrl) {
      setShowModelPicker(true);
      setTimeout(() => {
        setInputText(prev => prev.replace(/[qo]/g, ''));
      }, 10);
      return;
    }

    if (input === 'n' && key.ctrl) {
      // Spawn a new terminal window with fresh RemoteClaw instance
      spawnNewTerminalWindow(options);
      setTimeout(() => {
        setInputText(prev => prev.replace(/n/g, ''));
      }, 10);
      return;
    }

    if (input === 'l' && key.ctrl) {
      setMessages([]);
      sessionManagerRef.current?.clearActiveSession();
      setError(null);
      setTimeout(() => {
        setInputText(prev => prev.replace(/l/g, ''));
      }, 10);
      return;
    }

    if (input === 't' && key.ctrl) {
      setShowTranscript(prev => !prev);
      setTimeout(() => {
        setInputText(prev => prev.replace(/t/g, ''));
      }, 10);
      return;
    }

    // Generic Ctrl+key cleanup
    if (key.ctrl && input.match(/[a-z]/i)) {
      setTimeout(() => {
        setInputText(prev => prev.replace(new RegExp(input, 'g'), ''));
      }, 10);
      return;
    }
  });

  // Send message with streaming
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isProcessing || !chatServiceRef.current) return;

    const trimmedText = text.trim();

    // Handle /model command
    if (trimmedText.startsWith('/model')) {
      const modelArg = trimmedText.slice(6).trim();

      if (!modelArg) {
        setInputText('');
        setShowModelPicker(true);
        return;
      }

      const resolvedModel = ALIAS_TO_MODEL_ID[modelArg.toLowerCase()] ?? modelArg;

      setCurrentModel(resolvedModel);
      chatServiceRef.current.setModel(resolvedModel);
      sessionManagerRef.current?.setSessionModel(resolvedModel);

      const alias = getModelAlias(resolvedModel);
      const systemMsg: Message = {
        id: Date.now().toString(),
        role: 'system',
        content: `Switched to ${alias}. Checking connection...`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, systemMsg]);
      setInputText('');
      setError(null);

      chatServiceRef.current.setModelOverride(resolvedModel).catch(() => {});
      probeCurrentModel(resolvedModel);
      return;
    }

    setError(null);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: trimmedText,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    sessionManagerRef.current?.addMessage(userMessage);
    setInputText('');
    setIsProcessing(true);
    setStreamingContent('');

    try {
      let fullContent = '';

      for await (const chunk of chatServiceRef.current.streamMessage(trimmedText, messages)) {
        fullContent += chunk;
        setStreamingContent(fullContent);
      }

      const trimmedResponse = fullContent.trim();
      const isNoReply = !trimmedResponse ||
        trimmedResponse === 'NO_REPLY' ||
        trimmedResponse === 'NO_REPL' ||
        trimmedResponse === 'HEARTBEAT_OK' ||
        trimmedResponse.startsWith('NO_REP') ||
        trimmedResponse.startsWith('HEARTBEAT');

      if (!isNoReply) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: fullContent,
          timestamp: Date.now(),
          model: chatServiceRef.current?.lastResponseModel ?? currentModel,
        };

        setMessages(prev => [...prev, assistantMessage]);
        sessionManagerRef.current?.addMessage(assistantMessage);
      }
      setStreamingContent('');

      setUsage(prev => ({
        ...prev,
        todaySpend: (prev.todaySpend ?? 0) + 0.01,
      }));

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);

      const modelErrorPattern = /\b(40[1349]|429|5\d{2})\b/;
      if (modelErrorPattern.test(errorMessage)) {
        setModelStatus({ error: errorMessage });
      }

      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'system',
        content: `Error: ${errorMessage}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsProcessing(false);
      setStreamingContent('');
    }
  }, [isProcessing, messages, currentModel]);

  // Handle model selection from picker
  const selectModel = useCallback(async (modelId: string) => {
    setCurrentModel(modelId);
    chatServiceRef.current?.setModel(modelId);
    sessionManagerRef.current?.setSessionModel(modelId);
    setShowModelPicker(false);

    const alias = getModelAlias(modelId);
    const systemMsg: Message = {
      id: Date.now().toString(),
      role: 'system',
      content: `Switched to ${alias}. Checking connection...`,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, systemMsg]);
    setError(null);

    chatServiceRef.current?.setModelOverride(modelId).catch(() => {});
    probeCurrentModel(modelId);
  }, [currentModel, probeCurrentModel]);

  // Layout calculations
  const headerHeight = 3;
  const inputSeparatorHeight = 1;
  const shortcutBarHeight = 2;
  const errorHeight = error ? 1 : 0;

  // Dynamic input height: expand to fit wrapped text
  const inputPadding = 4; // paddingX=1 on outer box + paddingX=1 inside InputArea = 2+2
  const promptWidth = 2;  // "> "
  const availableInputWidth = Math.max(1, terminalWidth - inputPadding - promptWidth);
  const inputHeight = Math.max(1, Math.ceil((inputText.length + 1) / availableInputWidth));

  const chatHeight = Math.max(3, terminalHeight - headerHeight - inputSeparatorHeight - inputHeight - shortcutBarHeight - errorHeight);

  const layoutKey = `${terminalWidth}x${terminalHeight}-${resizeKey}`;

  return (
    <Box key={layoutKey} flexDirection="column" width={terminalWidth} height={terminalHeight}>
      <Box height={3}>
        <StatusBar
          gatewayStatus={gatewayStatus}
          tailscaleStatus={tailscaleStatus}
          model={currentModel}
          modelStatus={modelStatus}
          usage={usage}
          billing={getBillingForProvider(savedConfig, getProviderKey(currentModel))}
          sessionName={sessionName}
          terminalWidth={terminalWidth}
        />
      </Box>

      {error ? (
        <Box height={1} paddingX={1}>
          <Text color="red">! {error}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" height={chatHeight} paddingX={1}>
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
            currentMessages={messages}
            currentSessionName={sessionName}
            sessionManager={sessionManagerRef.current!}
            maxHeight={chatHeight}
            terminalWidth={terminalWidth}
            onClose={() => setShowTranscript(false)}
          />
        ) : (
          <ChatView
            messages={messages}
            isProcessing={isProcessing}
            streamingContent={streamingContent}
            modelAlias={getModelAlias(currentModel)}
            maxHeight={chatHeight}
            terminalWidth={terminalWidth}
          />
        )}
      </Box>

      <Box height={1}>
        <Text dimColor>{'─'.repeat(terminalWidth)}</Text>
      </Box>

      <Box height={inputHeight} paddingX={1}>
        <InputArea
          value={inputText}
          onChange={setInputText}
          onSubmit={sendMessage}
          disabled={isProcessing}
        />
      </Box>

      <Box height={2}>
        <ShortcutBar terminalWidth={terminalWidth} />
      </Box>
    </Box>
  );
}

export async function launchRemoteClaw(options: RemoteClawOptions): Promise<void> {
  const { waitUntilExit } = render(<App options={options} />);
  await waitUntilExit();
}
