/**
 * ClawTalk TUI App
 *
 * Main terminal user interface built with Ink (React for CLI).
 * Full-screen layout with pinned status bar (top), pinned input/shortcuts (bottom),
 * and scrollable message history in the middle.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import type { ClawTalkOptions, ModelStatus, Message } from '../types.js';
import type { Talk } from '../types.js';
import { StatusBar, ShortcutBar } from './components/StatusBar';
import { InputArea } from './components/InputArea.js';
import { ChatView } from './components/ChatView.js';
import { ModelPicker } from './components/ModelPicker.js';
import type { Model } from './components/ModelPicker.js';
import { TranscriptHub } from './components/TranscriptHub';
import { TalksHub } from './components/TalksHub';
import { SettingsPicker } from './components/SettingsPicker.js';
import { ChatService } from '../services/chat';
import { getSessionManager } from '../services/sessions';
import type { SessionManager } from '../services/sessions';
import { getTalkManager } from '../services/talks';
import type { TalkManager } from '../services/talks';
import { spawnNewTerminalWindow } from '../services/terminal.js';
import { VoiceService } from '../services/voice.js';
import { RealtimeVoiceService } from '../services/realtime-voice.js';
import { AnthropicRateLimitService } from '../services/anthropic-ratelimit.js';
import { loadConfig, getBillingForProvider } from '../config.js';
import {
  getModelAlias,
  getModelPricing,
  getProviderKey,
  formatPricingLabel,
} from '../models.js';
import { DEFAULT_MODEL, RESIZE_DEBOUNCE_MS } from '../constants.js';
import { createMessage, cleanInputChar } from './helpers.js';
import { dispatchCommand, getCommandCompletions } from './commands.js';
import { CommandHints } from './components/CommandHints.js';
import { useGateway } from './hooks/useGateway.js';
import { useChat } from './hooks/useChat.js';
import { useVoice } from './hooks/useVoice.js';
import { useRealtimeVoice } from './hooks/useRealtimeVoice.js';
import { useMouseScroll } from './hooks/useMouseScroll.js';
import { countVisualLines, messageVisualLines } from './lineCount.js';

interface AppProps {
  options: ClawTalkOptions;
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
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleResize = () => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(() => {
        setDimensions({ width: stdout?.columns ?? 80, height: stdout?.rows ?? 24 });
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
  const talkManagerRef = useRef<TalkManager | null>(null);
  const voiceServiceRef = useRef<VoiceService | null>(null);
  const realtimeVoiceServiceRef = useRef<RealtimeVoiceService | null>(null);
  const anthropicRLRef = useRef<AnthropicRateLimitService | null>(null);

  // --- Shared state ---

  const [currentModel, setCurrentModel] = useState(options.model ?? DEFAULT_MODEL);
  const currentModelRef = useRef(currentModel);
  useEffect(() => { currentModelRef.current = currentModel; }, [currentModel]);

  const [modelStatus, setModelStatus] = useState<ModelStatus>('unknown');
  const probeAbortRef = useRef<AbortController | null>(null);
  const probeSuppressedRef = useRef(false); // Synchronous flag to suppress initial probe
  const modelOverrideAbortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-dismiss errors after 5 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 25000);
    return () => clearTimeout(timer);
  }, [error]);

  const [inputText, setInputText] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showTalks, setShowTalks] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionName, setSessionName] = useState('Session 1');
  const [activeTalkId, setActiveTalkId] = useState<string | null>(null);
  const activeTalkIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeTalkIdRef.current = activeTalkId;
    setError(null); // Clear error when switching talks
  }, [activeTalkId]);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [processingStartTime, setProcessingStartTime] = useState<number | null>(null);
  const [hintSelectedIndex, setHintSelectedIndex] = useState(0);
  const [pendingClear, setPendingClear] = useState(false);

  // --- TTS bridge ref (useChat → useVoice) ---

  const speakResponseRef = useRef<((text: string) => void) | null>(null);

  // --- Pricing ref (kept current for session cost calculation) ---

  const pricingRef = useRef({ inputPer1M: 0.14, outputPer1M: 0.28 });

  // --- Gateway Talk ID ref (used by useChat to route through /api/talks/:id/chat) ---

  const gatewayTalkIdRef = useRef<string | null>(null);

  // --- Hooks ---

  const chat = useChat(
    chatServiceRef, sessionManagerRef, currentModelRef,
    setError, speakResponseRef,
    (err) => setModelStatus({ error: err }),
    pricingRef,
    activeTalkIdRef,
    gatewayTalkIdRef,
  );

  // Track when processing starts/stops for timer display
  useEffect(() => {
    if (chat.isProcessing && !processingStartTime) {
      setProcessingStartTime(Date.now());
    } else if (!chat.isProcessing && processingStartTime) {
      setProcessingStartTime(null);
    }
  }, [chat.isProcessing, processingStartTime]);

  // Tick timer every second while processing (for "Waiting for Xs" display)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!processingStartTime) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [processingStartTime]);

  const gateway = useGateway(
    chatServiceRef, voiceServiceRef, realtimeVoiceServiceRef, anthropicRLRef, currentModelRef,
    {
      onInitialProbe: (model) => {
        // Skip if a Talk was already selected (ref is synchronous, unlike React state)
        if (probeSuppressedRef.current) return;
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

  const realtimeVoice = useRealtimeVoice({
    realtimeServiceRef: realtimeVoiceServiceRef,
    capabilities: gateway.realtimeVoiceCaps,
    setError,
  });

  // Wire TTS: when chat receives an assistant response, speak it
  speakResponseRef.current = voice.speakResponse;

  // --- Scroll state ---

  const isOverlayActive = showModelPicker || showTranscript || showTalks || showSettings;

  // --- Command hints ---

  // Compute command completions when input starts with "/"
  const commandHints = React.useMemo(() => {
    if (!inputText.startsWith('/')) return [];
    const prefix = inputText.slice(1).split(' ')[0]; // only match the command name part
    // Don't show hints if user already typed a space (entering args)
    if (inputText.includes(' ')) return [];
    return getCommandCompletions(prefix);
  }, [inputText]);

  const showCommandHints = commandHints.length > 0 && !isOverlayActive;

  // Reset selection when hints change
  useEffect(() => {
    setHintSelectedIndex(0);
  }, [commandHints.length, inputText]);

  // --- Dynamic input height ---
  // Calculate how many visual lines the input text occupies
  const inputContentWidth = Math.max(10, terminalWidth - 4); // matches InputArea's inputWidth
  const inputVisualLines = inputText.length === 0
    ? 1
    : countVisualLines(inputText, inputContentWidth);
  const maxInputLines = Math.min(10, Math.floor(terminalHeight / 4));
  const inputLines = Math.min(maxInputLines, inputVisualLines);

  // Calculate available height for the chat area:
  // Total - StatusBar(2) - error(0-1) - clearPrompt(0-1) - separator(1) - input - shortcuts(3) - queued - hints - margin(1)
  const errorLines = error ? 1 : 0;
  const clearPromptLines = pendingClear ? 1 : 0;
  const queuedLines = messageQueue.length > 0 ? messageQueue.length : 0;
  const hintsLines = showCommandHints ? commandHints.length + 1 : 0; // +1 for separator line
  const chatHeight = Math.max(4, terminalHeight - 2 - errorLines - clearPromptLines - 1 - inputLines - 3 - queuedLines - hintsLines - 1);

  // --- Line-based scroll ---
  // Pre-compute visual line counts for all messages (recomputes on messages or width change)
  const contentWidth = Math.max(10, terminalWidth - 2); // account for paddingX={1} in ChatView
  const messageLinesArray = useMemo(
    () => chat.messages.map(msg => messageVisualLines(msg, contentWidth)),
    [chat.messages, contentWidth],
  );
  const totalMessageLines = useMemo(
    () => messageLinesArray.reduce((s, c) => s + c, 0),
    [messageLinesArray],
  );

  // maxOffset = total visual lines - viewport height (can't scroll past first message)
  // +1 accounts for the "more below" indicator line shown when scrolled to the top
  const scrollMaxOffset = Math.max(0, totalMessageLines - chatHeight + 1);

  const mouseScroll = useMouseScroll({
    maxOffset: scrollMaxOffset,
    enabled: !isOverlayActive,
  });

  // Auto-scroll to bottom when new messages arrive (if already at bottom)
  const prevMessageCountRef = useRef(chat.messages.length);
  useEffect(() => {
    if (chat.messages.length > prevMessageCountRef.current && mouseScroll.scrollOffset === 0) {
      // Already at bottom, stay there (no-op since offset is already 0)
    } else if (chat.messages.length > prevMessageCountRef.current && !mouseScroll.isScrolledUp) {
      mouseScroll.scrollToBottom();
    }
    prevMessageCountRef.current = chat.messages.length;
  }, [chat.messages.length]);

  // --- Service initialization ---

  useEffect(() => {
    chatServiceRef.current = new ChatService({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      agentId: 'clawtalk',
      model: currentModel,
    });

    voiceServiceRef.current = new VoiceService({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
    });

    realtimeVoiceServiceRef.current = new RealtimeVoiceService({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
    });

    if (options.anthropicApiKey) {
      anthropicRLRef.current = new AnthropicRateLimitService(options.anthropicApiKey);
    }

    sessionManagerRef.current = getSessionManager();
    talkManagerRef.current = getTalkManager();

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

    // Create a talk for this session and persist the initial model
    const talk = talkManagerRef.current.createTalk(session.id);
    talkManagerRef.current.setModel(talk.id, session.model || options.model || DEFAULT_MODEL);
    setActiveTalkId(talk.id);

    // Gateway talk is created lazily on first message send (see handleSubmit)

    // Batch state updates
    const msgs = session.messages;
    const model = session.model;
    const name = session.name;

    queueMicrotask(() => {
      chat.setMessages(msgs);
      setCurrentModel(model);
      setSessionName(name);
    });

    if (chatServiceRef.current && session.model) {
      chatServiceRef.current.setModel(session.model);
      modelOverrideAbortRef.current?.abort();
      const controller = new AbortController();
      modelOverrideAbortRef.current = controller;
      chatServiceRef.current.setModelOverride(session.model, controller.signal).catch(() => {});
    }

    return () => {
      voiceServiceRef.current?.cleanup();
      realtimeVoiceServiceRef.current?.cleanup();
    };
  }, []);

  // --- Model management ---

  const probeCurrentModel = useCallback((modelId: string, previousModel?: string, skipCheckingState?: boolean) => {
    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;

    if (!skipCheckingState) {
      setModelStatus('checking');
    }

    chatServiceRef.current?.probeModel(modelId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setModelStatus('ok');
        const sysMsg = createMessage('system', `${getModelAlias(modelId)} is responding. Ready.`);
        chat.setMessages(prev => [...prev, sysMsg]);
      } else {
        setModelStatus({ error: result.reason });
        setError(result.reason);
        const sysMsg = createMessage('system', `Model probe failed: ${result.reason}`);
        chat.setMessages(prev => [...prev, sysMsg]);
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

    if (activeTalkIdRef.current && talkManagerRef.current) {
      talkManagerRef.current.setModel(activeTalkIdRef.current, modelId);
    }
    // Update gateway talk model
    if (gatewayTalkIdRef.current) {
      chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { model: modelId });
    }

    const sysMsg = createMessage('system', `Switching to ${getModelAlias(modelId)}. Checking connection...`);
    chat.setMessages(prev => [...prev, sysMsg]);
    setError(null);

    modelOverrideAbortRef.current?.abort();
    const controller = new AbortController();
    modelOverrideAbortRef.current = controller;
    chatServiceRef.current?.setModelOverride(modelId, controller.signal).catch(() => {});
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

  // --- Talk handlers ---

  const handleSaveTalk = useCallback((title?: string) => {
    if (activeTalkId && talkManagerRef.current) {
      const success = talkManagerRef.current.saveTalk(activeTalkId);
      if (success) {
        const text = title ? `Chat saved as "${title}"` : 'Chat saved to Talks.';
        if (title) {
          talkManagerRef.current.setTopicTitle(activeTalkId, title);
          // Sync title to gateway
          if (gatewayTalkIdRef.current) {
            chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { topicTitle: title });
          }
        }
        const sysMsg = createMessage('system', text);
        chat.setMessages(prev => [...prev, sysMsg]);
      } else {
        setError('Failed to save talk');
      }
    }
  }, [activeTalkId]);

  const handleSetTopicTitle = useCallback((title: string) => {
    if (activeTalkId && talkManagerRef.current) {
      const success = talkManagerRef.current.setTopicTitle(activeTalkId, title);
      if (success) {
        // Sync title to gateway
        if (gatewayTalkIdRef.current) {
          chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { topicTitle: title });
        }
        const sysMsg = createMessage('system', `Topic set to: ${title}`);
        chat.setMessages(prev => [...prev, sysMsg]);
      } else {
        setError('Failed to set topic');
      }
    }
  }, [activeTalkId]);

  // --- Pin handlers ---

  const handlePinMessage = useCallback((fromBottom?: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    // Find target: last assistant message, or N-th from bottom
    const assistantMsgs = chat.messages.filter(m => m.role === 'assistant');
    if (assistantMsgs.length === 0) {
      setError('No assistant messages to pin');
      return;
    }
    const idx = fromBottom ? assistantMsgs.length - fromBottom : assistantMsgs.length - 1;
    const target = assistantMsgs[idx];
    if (!target) {
      setError(`No assistant message at position ${fromBottom}`);
      return;
    }
    const success = talkManagerRef.current.addPin(activeTalkId, target.id);
    if (success) {
      // Sync pin to gateway
      if (gatewayTalkIdRef.current) {
        chatServiceRef.current?.pinGatewayMessage(gatewayTalkIdRef.current, target.id);
      }
      const preview = target.content.slice(0, 50) + (target.content.length > 50 ? '...' : '');
      const sysMsg = createMessage('system', `Pinned: "${preview}"`);
      chat.setMessages(prev => [...prev, sysMsg]);
    } else {
      setError('Message is already pinned');
    }
  }, [activeTalkId, chat.messages]);

  const handleUnpinMessage = useCallback((fromBottom?: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const pinnedIds = talkManagerRef.current.getPinnedMessageIds(activeTalkId);
    if (pinnedIds.length === 0) {
      setError('No pinned messages');
      return;
    }
    const idx = fromBottom ? fromBottom - 1 : pinnedIds.length - 1;
    const targetId = pinnedIds[idx];
    if (!targetId) {
      setError(`No pin at position ${fromBottom}`);
      return;
    }
    const success = talkManagerRef.current.removePin(activeTalkId, targetId);
    if (success) {
      // Sync unpin to gateway
      if (gatewayTalkIdRef.current) {
        chatServiceRef.current?.unpinGatewayMessage(gatewayTalkIdRef.current, targetId);
      }
      const sysMsg = createMessage('system', 'Pin removed.');
      chat.setMessages(prev => [...prev, sysMsg]);
    } else {
      setError('Failed to remove pin');
    }
  }, [activeTalkId]);

  const handleListPins = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const pinnedIds = talkManagerRef.current.getPinnedMessageIds(activeTalkId);
    if (pinnedIds.length === 0) {
      const sysMsg = createMessage('system', 'No pinned messages.');
      chat.setMessages(prev => [...prev, sysMsg]);
      return;
    }
    const lines = pinnedIds.map((id, i) => {
      const msg = chat.messages.find(m => m.id === id);
      const preview = msg ? msg.content.slice(0, 60) + (msg.content.length > 60 ? '...' : '') : '(message not found)';
      return `  ${i + 1}. ${preview}`;
    });
    const sysMsg = createMessage('system', `Pinned messages:\n${lines.join('\n')}`);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId, chat.messages]);

  // --- Job handlers ---

  const handleAddJob = useCallback((schedule: string, prompt: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    // Auto-save the talk when adding a job
    talkManagerRef.current.saveTalk(activeTalkId);

    const gwId = gatewayTalkIdRef.current;
    if (gwId && chatServiceRef.current) {
      chatServiceRef.current.createGatewayJob(gwId, schedule, prompt).then(job => {
        if (job) {
          // Update local cache
          talkManagerRef.current?.addJob(activeTalkId, schedule, prompt);
          const sysMsg = createMessage('system', `Job created: "${schedule}" — ${prompt}`);
          chat.setMessages(prev => [...prev, sysMsg]);
        } else {
          setError('Failed to create job on gateway');
        }
      });
    } else {
      // Fallback to local-only
      const job = talkManagerRef.current.addJob(activeTalkId, schedule, prompt);
      if (job) {
        const sysMsg = createMessage('system', `Job created: "${schedule}" — ${prompt}`);
        chat.setMessages(prev => [...prev, sysMsg]);
      } else {
        setError('Failed to create job');
      }
    }
  }, [activeTalkId]);

  const handleListJobs = useCallback(() => {
    if (!activeTalkId) return;

    const gwId = gatewayTalkIdRef.current;
    if (gwId && chatServiceRef.current) {
      chatServiceRef.current.listGatewayJobs(gwId).then(jobs => {
        if (jobs.length === 0) {
          const sysMsg = createMessage('system', 'No jobs for this talk.');
          chat.setMessages(prev => [...prev, sysMsg]);
          return;
        }
        const lines = jobs.map((j, i) => {
          const status = j.active ? 'active' : 'paused';
          const lastRun = j.lastRunAt ? ` (last: ${new Date(j.lastRunAt).toLocaleString()})` : '';
          return `  ${i + 1}. [${status}] "${j.schedule}" — ${j.prompt}${lastRun}`;
        });
        const sysMsg = createMessage('system', `Jobs:\n${lines.join('\n')}`);
        chat.setMessages(prev => [...prev, sysMsg]);
      });
    } else if (talkManagerRef.current) {
      const jobs = talkManagerRef.current.getJobs(activeTalkId);
      if (jobs.length === 0) {
        const sysMsg = createMessage('system', 'No jobs for this talk.');
        chat.setMessages(prev => [...prev, sysMsg]);
        return;
      }
      const lines = jobs.map((j, i) => {
        const status = j.active ? 'active' : 'paused';
        return `  ${i + 1}. [${status}] "${j.schedule}" — ${j.prompt}`;
      });
      const sysMsg = createMessage('system', `Jobs:\n${lines.join('\n')}`);
      chat.setMessages(prev => [...prev, sysMsg]);
    }
  }, [activeTalkId]);

  /** Helper: resolve job ID by 1-based index via gateway. */
  const resolveGatewayJobByIndex = useCallback(async (index: number): Promise<{ jobId: string; jobs: import('../types.js').Job[] } | null> => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return null;
    const jobs = await chatServiceRef.current.listGatewayJobs(gwId);
    const job = jobs[index - 1];
    if (!job) return null;
    return { jobId: job.id, jobs };
  }, []);

  const handlePauseJob = useCallback((index: number) => {
    if (!activeTalkId) return;

    const gwId = gatewayTalkIdRef.current;
    if (gwId && chatServiceRef.current) {
      resolveGatewayJobByIndex(index).then(result => {
        if (!result) { setError(`No job at position ${index}`); return; }
        chatServiceRef.current?.updateGatewayJob(gwId, result.jobId, { active: false }).then(ok => {
          if (ok) {
            talkManagerRef.current?.pauseJob(activeTalkId, index);
            const sysMsg = createMessage('system', `Job #${index} paused.`);
            chat.setMessages(prev => [...prev, sysMsg]);
          } else {
            setError(`Failed to pause job #${index}`);
          }
        });
      });
    } else if (talkManagerRef.current) {
      const success = talkManagerRef.current.pauseJob(activeTalkId, index);
      if (success) {
        const sysMsg = createMessage('system', `Job #${index} paused.`);
        chat.setMessages(prev => [...prev, sysMsg]);
      } else {
        setError(`No job at position ${index}`);
      }
    }
  }, [activeTalkId, resolveGatewayJobByIndex]);

  const handleResumeJob = useCallback((index: number) => {
    if (!activeTalkId) return;

    const gwId = gatewayTalkIdRef.current;
    if (gwId && chatServiceRef.current) {
      resolveGatewayJobByIndex(index).then(result => {
        if (!result) { setError(`No job at position ${index}`); return; }
        chatServiceRef.current?.updateGatewayJob(gwId, result.jobId, { active: true }).then(ok => {
          if (ok) {
            talkManagerRef.current?.resumeJob(activeTalkId, index);
            const sysMsg = createMessage('system', `Job #${index} resumed.`);
            chat.setMessages(prev => [...prev, sysMsg]);
          } else {
            setError(`Failed to resume job #${index}`);
          }
        });
      });
    } else if (talkManagerRef.current) {
      const success = talkManagerRef.current.resumeJob(activeTalkId, index);
      if (success) {
        const sysMsg = createMessage('system', `Job #${index} resumed.`);
        chat.setMessages(prev => [...prev, sysMsg]);
      } else {
        setError(`No job at position ${index}`);
      }
    }
  }, [activeTalkId, resolveGatewayJobByIndex]);

  const handleDeleteJob = useCallback((index: number) => {
    if (!activeTalkId) return;

    const gwId = gatewayTalkIdRef.current;
    if (gwId && chatServiceRef.current) {
      resolveGatewayJobByIndex(index).then(result => {
        if (!result) { setError(`No job at position ${index}`); return; }
        chatServiceRef.current?.deleteGatewayJob(gwId, result.jobId).then(ok => {
          if (ok) {
            talkManagerRef.current?.deleteJob(activeTalkId, index);
            const sysMsg = createMessage('system', `Job #${index} deleted.`);
            chat.setMessages(prev => [...prev, sysMsg]);
          } else {
            setError(`Failed to delete job #${index}`);
          }
        });
      });
    } else if (talkManagerRef.current) {
      const success = talkManagerRef.current.deleteJob(activeTalkId, index);
      if (success) {
        const sysMsg = createMessage('system', `Job #${index} deleted.`);
        chat.setMessages(prev => [...prev, sysMsg]);
      } else {
        setError(`No job at position ${index}`);
      }
    }
  }, [activeTalkId, resolveGatewayJobByIndex]);

  // --- Objective handlers ---

  const handleSetObjective = useCallback((text: string | undefined) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.setObjective(activeTalkId, text);
    // Update gateway talk objective
    if (gatewayTalkIdRef.current) {
      chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { objective: text ?? '' });
    }
    if (text) {
      const sysMsg = createMessage('system', `Objective set: ${text}`);
      chat.setMessages(prev => [...prev, sysMsg]);
    } else {
      const sysMsg = createMessage('system', 'Objective cleared.');
      chat.setMessages(prev => [...prev, sysMsg]);
    }
  }, [activeTalkId]);

  const handleShowObjective = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const objective = talkManagerRef.current.getObjective(activeTalkId);
    const text = objective
      ? `Current objective: ${objective}`
      : 'No objective set. Use /objective <text> to set one.';
    const sysMsg = createMessage('system', text);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId]);

  // --- Reports handler ---

  const handleViewReports = useCallback((jobIndex?: number) => {
    // Try ref first, fall back to TalkManager's stored gateway ID
    const gwId = gatewayTalkIdRef.current
      ?? (activeTalkIdRef.current ? talkManagerRef.current?.getGatewayTalkId(activeTalkIdRef.current) : null)
      ?? null;
    if (!gwId || !chatServiceRef.current) {
      setError('Reports not available — this talk is not synced to the server');
      return;
    }

    // If jobIndex is given, resolve the job ID first
    if (jobIndex !== undefined) {
      resolveGatewayJobByIndex(jobIndex).then(result => {
        if (!result) {
          setError(`No job at position ${jobIndex}`);
          return;
        }
        chatServiceRef.current?.fetchGatewayReports(gwId, result.jobId, 10).then(reports => {
          if (reports.length === 0) {
            const sysMsg = createMessage('system', `No reports for job #${jobIndex}.`);
            chat.setMessages(prev => [...prev, sysMsg]);
            return;
          }
          const lines = reports.map(r => {
            const ts = new Date(r.runAt).toLocaleString();
            const icon = r.status === 'success' ? '✓' : '✗';
            return `  ${icon} [${ts}] ${r.summary}`;
          });
          const sysMsg = createMessage('system', `Reports for job #${jobIndex}:\n${lines.join('\n')}`);
          chat.setMessages(prev => [...prev, sysMsg]);
        });
      });
    } else {
      chatServiceRef.current.fetchGatewayReports(gwId, undefined, 10).then(reports => {
        if (reports.length === 0) {
          const sysMsg = createMessage('system', 'No job reports for this talk.');
          chat.setMessages(prev => [...prev, sysMsg]);
          return;
        }
        const lines = reports.map(r => {
          const ts = new Date(r.runAt).toLocaleString();
          const icon = r.status === 'success' ? '✓' : '✗';
          return `  ${icon} [${ts}] ${r.summary}`;
        });
        const sysMsg = createMessage('system', `Job reports:\n${lines.join('\n')}`);
        chat.setMessages(prev => [...prev, sysMsg]);
      });
    }
  }, [resolveGatewayJobByIndex]);

  // --- TalksHub rename/delete (syncs both local + gateway) ---

  const handleRenameTalk = useCallback((talkId: string, title: string) => {
    if (!talkManagerRef.current) return;
    talkManagerRef.current.setTopicTitle(talkId, title);
    // Sync to gateway
    const gwId = talkManagerRef.current.getGatewayTalkId(talkId);
    if (gwId) {
      chatServiceRef.current?.updateGatewayTalk(gwId, { topicTitle: title });
    }
  }, []);

  const handleDeleteTalk = useCallback((talkId: string) => {
    if (!talkManagerRef.current) return;
    // Delete from gateway
    const gwId = talkManagerRef.current.getGatewayTalkId(talkId);
    if (gwId) {
      chatServiceRef.current?.deleteGatewayTalk(gwId);
    }
    talkManagerRef.current.unsaveTalk(talkId);
  }, []);

  // Sync gateway talks into local TalkManager when TalksHub opens
  useEffect(() => {
    if (!showTalks || !chatServiceRef.current || !talkManagerRef.current) return;
    chatServiceRef.current.listGatewayTalks().then(gwTalks => {
      if (!talkManagerRef.current) return;
      for (const gwTalk of gwTalks) {
        talkManagerRef.current.importGatewayTalk({
          id: gwTalk.id,
          topicTitle: gwTalk.topicTitle,
          objective: gwTalk.objective,
          model: gwTalk.model,
          pinnedMessageIds: gwTalk.pinnedMessageIds,
          jobs: gwTalk.jobs,
          createdAt: gwTalk.createdAt,
          updatedAt: gwTalk.updatedAt,
        });
      }
    });
  }, [showTalks]);

  const handleNewChat = useCallback(() => {
    const session = sessionManagerRef.current?.createSession(undefined, currentModel);
    if (session) {
      const talk = talkManagerRef.current?.createTalk(session.id);
      if (talk) {
        talkManagerRef.current?.setModel(talk.id, currentModel);
        setActiveTalkId(talk.id);
      }

      // Gateway talk is created lazily on first message send
      gatewayTalkIdRef.current = null;

      chat.clearStreaming();
      chat.setMessages([]);
      setSessionName(session.name);
      const sysMsg = createMessage('system', 'New chat started.');
      chat.setMessages(prev => [...prev, sysMsg]);
      mouseScroll.scrollToBottom();
    }
  }, [activeTalkId, chat.messages, currentModel]);

  const handleSelectTalk = useCallback((talk: Talk) => {
    // Try to load local session; may be null for gateway-only talks
    const session = sessionManagerRef.current?.setActiveSession(talk.sessionId);

    // Show local messages immediately (or empty for gateway-only talks)
    chat.clearStreaming();
    chat.setMessages(session?.messages ?? []);
    setSessionName(session?.name ?? talk.topicTitle ?? 'Talk');
    setActiveTalkId(talk.id);
    talkManagerRef.current?.setActiveTalk(talk.id);
    talkManagerRef.current?.touchTalk(talk.id);
    mouseScroll.scrollToBottom();

    // Set gateway talk ID from local mapping
    const gwId = talk.gatewayTalkId;
    if (gwId) {
      gatewayTalkIdRef.current = gwId;
      // Load messages from gateway (source of truth) in background
      chatServiceRef.current?.fetchGatewayMessages(gwId).then(msgs => {
        if (msgs.length > 0 && activeTalkIdRef.current === talk.id) {
          chat.setMessages(msgs);
        }
      });
    } else {
      // Gateway talk will be created lazily on first message send
      gatewayTalkIdRef.current = null;
    }

    // Suppress gateway's initial probe immediately (synchronous ref, no React delay)
    probeSuppressedRef.current = true;
    probeAbortRef.current?.abort(); // Cancel any in-flight probe

    // Always restore model to gateway — even if client model matches,
    // the gateway may have a different active model.
    modelOverrideAbortRef.current?.abort();
    const modelToRestore = talk.model || session?.model;
    if (modelToRestore) {
      currentModelRef.current = modelToRestore;
      setCurrentModel(modelToRestore);
      chatServiceRef.current?.setModel(modelToRestore);
      sessionManagerRef.current?.setSessionModel(modelToRestore);
      const controller = new AbortController();
      modelOverrideAbortRef.current = controller;
      chatServiceRef.current?.setModelOverride(modelToRestore, controller.signal).catch(() => {});
    }
    setModelStatus('ok');

    setShowTalks(false);
  }, [activeTalkId, chat.messages]);

  // --- Submit handler (command registry + chat) ---

  const executeClear = useCallback(() => {
    chat.setMessages([]);
    sessionManagerRef.current?.clearActiveSession();
    setError(null);
    setPendingClear(false);
    const sysMsg = createMessage('system', 'Chat cleared.');
    chat.setMessages([sysMsg]);
  }, [chat]);

  const commandCtx = useRef({
    switchModel,
    openModelPicker: () => setShowModelPicker(true),
    clearSession: () => { setPendingClear(true); },
    setError,
    saveTalk: handleSaveTalk,
    setTopicTitle: handleSetTopicTitle,
    pinMessage: handlePinMessage,
    unpinMessage: handleUnpinMessage,
    listPins: handleListPins,
    addJob: handleAddJob,
    listJobs: handleListJobs,
    pauseJob: handlePauseJob,
    resumeJob: handleResumeJob,
    deleteJob: handleDeleteJob,
    setObjective: handleSetObjective,
    showObjective: handleShowObjective,
    viewReports: handleViewReports,
  });
  commandCtx.current = {
    switchModel,
    openModelPicker: () => setShowModelPicker(true),
    clearSession: () => { setPendingClear(true); },
    setError,
    saveTalk: handleSaveTalk,
    setTopicTitle: handleSetTopicTitle,
    pinMessage: handlePinMessage,
    unpinMessage: handleUnpinMessage,
    listPins: handleListPins,
    addJob: handleAddJob,
    listJobs: handleListJobs,
    pauseJob: handlePauseJob,
    resumeJob: handleResumeJob,
    deleteJob: handleDeleteJob,
    setObjective: handleSetObjective,
    showObjective: handleShowObjective,
    viewReports: handleViewReports,
  };

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (dispatchCommand(trimmed, commandCtx.current)) {
      setInputText('');
      return;
    }

    setInputText('');
    mouseScroll.scrollToBottom();

    // Lazy gateway talk creation + auto-save on first user message
    if (!gatewayTalkIdRef.current && chatServiceRef.current) {
      // Auto-save: this talk now has activity
      if (activeTalkIdRef.current) {
        talkManagerRef.current?.saveTalk(activeTalkIdRef.current);
      }
      chatServiceRef.current.createGatewayTalk(currentModelRef.current).then(gwId => {
        if (gwId) {
          gatewayTalkIdRef.current = gwId;
          if (activeTalkIdRef.current) {
            talkManagerRef.current?.setGatewayTalkId(activeTalkIdRef.current, gwId);
          }
        }
      });
    }

    // If already processing, queue the message
    if (chat.isProcessing) {
      setMessageQueue(prev => [...prev, trimmed]);
      return;
    }

    await chat.sendMessage(trimmed);
  }, [chat.sendMessage, chat.isProcessing]);

  // Process queued messages when AI finishes responding
  useEffect(() => {
    if (!chat.isProcessing && messageQueue.length > 0) {
      const nextMessage = messageQueue[0];
      setMessageQueue(prev => prev.slice(1));
      chat.sendMessage(nextMessage);
    }
  }, [chat.isProcessing, messageQueue, chat.sendMessage]);

  // --- Keyboard shortcuts ---

  useInput((input, key) => {
    if (showModelPicker || showTranscript || showTalks || showSettings) return;

    // Clear confirmation mode
    if (pendingClear) {
      if (input === 'c' && !key.ctrl) {
        executeClear();
      } else {
        setPendingClear(false);
      }
      return;
    }

    // Command hints navigation (when "/" popup is visible)
    if (showCommandHints) {
      if (key.upArrow) {
        setHintSelectedIndex(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setHintSelectedIndex(prev => Math.min(commandHints.length - 1, prev + 1));
        return;
      }
      if (key.tab) {
        const selected = commandHints[hintSelectedIndex];
        if (selected) {
          setInputText('/' + selected.name + ' ');
        }
        return;
      }
    }

    if (key.escape) {
      if (voice.handleEscape()) return;
      setShowTalks(true);
      return;
    }

    // ^X Exit
    if (input === 'x' && key.ctrl) {
      voiceServiceRef.current?.cleanup();
      exit();
      return;
    }

    // ^T Talks (open saved conversations list)
    if (input === 't' && key.ctrl) {
      setShowTalks(true);
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
      } else if (realtimeVoice.isActive) {
        realtimeVoice.endSession();
      } else if (voice.voiceMode === 'liveChat') {
        voice.handleLiveTalk?.();
      } else if (gateway.realtimeVoiceCaps?.available) {
        realtimeVoice.startSession().then(success => {
          if (!success) {
            voice.handleLiveTalk?.();
          }
        });
      } else {
        voice.handleLiveTalk?.();
      }
      cleanInputChar(setInputText, 'c');
      return;
    }

    // ^H History (transcripts)
    const isCtrlH = input === '\x08' || key.backspace || (input === '\b');
    if (isCtrlH && inputText.length === 0) {
      setShowTranscript(true);
      return;
    }

    // ^V AI Voice (toggle TTS responses)
    if (input === 'v' && key.ctrl) {
      voice.handleTtsToggle?.();
      cleanInputChar(setInputText, 'v');
      return;
    }

    // ^N New Chat
    if (input === 'n' && key.ctrl) {
      handleNewChat();
      cleanInputChar(setInputText, 'n');
      return;
    }

    // ^Y New Terminal
    if (input === 'y' && key.ctrl) {
      spawnNewTerminalWindow(options);
      cleanInputChar(setInputText, 'y');
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

  const overlayMaxHeight = Math.max(6, terminalHeight - 6);

  // --- Render ---

  // Show loading state until gateway is initialized
  if (!gateway.isInitialized) {
    return (
      <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
        <Box paddingX={1}>
          <Text dimColor>Starting ClawTalk...</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={terminalHeight} width={terminalWidth}>
      {/* Status bar pinned at top (2 lines) */}
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
        ttsEnabled={voice.ttsEnabled}
      />

      {/* Error line */}
      {error && (
        <Box paddingX={1}>
          <Text color="red">! {error}</Text>
        </Box>
      )}

      {/* Clear confirmation prompt */}
      {pendingClear && (
        <Box paddingX={1}>
          <Text color="yellow">Clear will remove all message history and cannot be undone. Press </Text>
          <Text color="yellow" bold>c</Text>
          <Text color="yellow"> to confirm or any other key to abort.</Text>
        </Box>
      )}

      {/* Middle area: overlay or chat view */}
      {showModelPicker ? (
        <Box flexGrow={1} paddingX={1}>
          <ModelPicker
            models={pickerModels}
            currentModel={currentModel}
            onSelect={selectModel}
            onClose={() => setShowModelPicker(false)}
            maxHeight={overlayMaxHeight}
          />
        </Box>
      ) : showTranscript ? (
        <Box flexGrow={1} paddingX={1}>
          <TranscriptHub
            currentMessages={chat.messages}
            currentSessionName={sessionName}
            sessionManager={sessionManagerRef.current!}
            maxHeight={overlayMaxHeight}
            terminalWidth={terminalWidth}
            onClose={() => setShowTranscript(false)}
            onNewChat={() => { setShowTranscript(false); handleNewChat(); }}
            onToggleTts={() => { voice.handleTtsToggle?.(); }}
            onOpenTalks={() => { setShowTranscript(false); setShowTalks(true); }}
            onOpenSettings={() => { setShowTranscript(false); setShowSettings(true); }}
            onExit={() => { voiceServiceRef.current?.cleanup(); exit(); }}
            setError={setError}
          />
        </Box>
      ) : showTalks ? (
        <Box flexGrow={1} paddingX={1}>
          <TalksHub
            talkManager={talkManagerRef.current!}
            sessionManager={sessionManagerRef.current!}
            maxHeight={overlayMaxHeight}
            terminalWidth={terminalWidth}
            onClose={() => setShowTalks(false)}
            onSelectTalk={handleSelectTalk}
            onNewChat={() => { setShowTalks(false); handleNewChat(); }}
            onToggleTts={() => { voice.handleTtsToggle?.(); }}
            onOpenHistory={() => { setShowTalks(false); setShowTranscript(true); }}
            onOpenSettings={() => { setShowTalks(false); setShowSettings(true); }}
            onOpenModelPicker={() => { setShowTalks(false); setShowModelPicker(true); }}
            onNewTerminal={() => { spawnNewTerminalWindow(options); }}
            onExit={() => { voiceServiceRef.current?.cleanup(); exit(); }}
            setError={setError}
            onRenameTalk={handleRenameTalk}
            onDeleteTalk={handleDeleteTalk}
          />
        </Box>
      ) : showSettings ? (
        <Box flexGrow={1} paddingX={1}>
          <SettingsPicker
            onClose={() => setShowSettings(false)}
            onNewChat={() => { setShowSettings(false); handleNewChat(); }}
            onToggleTts={() => { voice.handleTtsToggle?.(); }}
            onOpenTalks={() => { setShowSettings(false); setShowTalks(true); }}
            onOpenHistory={() => { setShowSettings(false); setShowTranscript(true); }}
            onExit={() => { voiceServiceRef.current?.cleanup(); realtimeVoiceServiceRef.current?.cleanup(); exit(); }}
            setError={setError}
            voiceCaps={{
              sttProviders: gateway.voiceCaps.sttProviders ?? [],
              sttActiveProvider: gateway.voiceCaps.sttProvider,
              ttsProviders: gateway.voiceCaps.ttsProviders ?? [],
              ttsActiveProvider: gateway.voiceCaps.ttsProvider,
            }}
            onSttProviderChange={async (provider) => {
              const success = await voiceServiceRef.current?.setSttProvider(provider);
              if (success) {
                voiceServiceRef.current?.fetchCapabilities();
              }
              return success ?? false;
            }}
            onTtsProviderChange={async (provider) => {
              const success = await voiceServiceRef.current?.setTtsProvider(provider);
              if (success) {
                voiceServiceRef.current?.fetchCapabilities();
              }
              return success ?? false;
            }}
            realtimeVoiceCaps={gateway.realtimeVoiceCaps}
            realtimeProvider={realtimeVoice.provider}
            onRealtimeProviderChange={realtimeVoice.setProvider}
          />
        </Box>
      ) : (
        <ChatView
          messages={chat.messages}
          messageLinesArray={messageLinesArray}
          streamingContent={chat.streamingContent}
          isProcessing={chat.isProcessing}
          processingStartTime={processingStartTime}
          scrollOffset={mouseScroll.scrollOffset}
          availableHeight={chatHeight}
          width={terminalWidth}
          currentModel={currentModel}
          pinnedMessageIds={activeTalkId && talkManagerRef.current
            ? talkManagerRef.current.getPinnedMessageIds(activeTalkId) : []}
        />
      )}

      {/* Separator */}
      <Text dimColor>{'─'.repeat(terminalWidth)}</Text>

      {/* Queued messages */}
      {messageQueue.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {messageQueue.map((msg, idx) => (
            <Box key={idx}>
              <Text dimColor>queued: </Text>
              <Text color="gray">{msg.length > 60 ? msg.slice(0, 60) + '...' : msg}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Command hints popup (above input when typing "/") */}
      {showCommandHints && (
        <CommandHints
          commands={commandHints}
          selectedIndex={hintSelectedIndex}
          width={terminalWidth}
        />
      )}

      {/* Input area */}
      <Box paddingX={1}>
        <InputArea
          value={inputText}
          onChange={setInputText}
          onSubmit={handleSubmit}
          disabled={chat.isProcessing}
          voiceMode={realtimeVoice.isActive ? 'liveChat' : voice.voiceMode}
          volumeLevel={realtimeVoice.isActive ? realtimeVoice.volumeLevel : voice.volumeLevel}
          width={terminalWidth - 2}
          isActive={!isOverlayActive}
          maxVisibleLines={inputLines}
          realtimeState={realtimeVoice.state}
          userTranscript={realtimeVoice.userTranscript}
          aiTranscript={realtimeVoice.aiTranscript}
        />
      </Box>

      {/* Shortcut bar pinned at bottom (2 lines) */}
      <ShortcutBar terminalWidth={terminalWidth} ttsEnabled={voice.ttsEnabled} />
    </Box>
  );
}

export async function launchClawTalk(options: ClawTalkOptions): Promise<void> {
  // Suppress all stdout/stderr output during TUI operation.
  const origDebug = console.debug;
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const noop = () => {};
  console.debug = noop;
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  process.stderr.write = (() => true) as typeof process.stderr.write;

  // Enter alternate screen buffer for full-screen layout
  process.stdout.write('\x1b[?1049h');

  const { waitUntilExit } = render(<App options={options} />, {
    exitOnCtrlC: false,
    patchConsole: false,
  });

  try {
    await waitUntilExit();
  } finally {
    // Restore console, stderr, and terminal state
    console.debug = origDebug;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    process.stderr.write = origStderrWrite;

    // Disable mouse mode (in case cleanup didn't run)
    process.stdout.write('\x1b[?1000l');
    process.stdout.write('\x1b[?1006l');

    // Exit alternate screen buffer
    process.stdout.write('\x1b[?1049l');

    // Show cursor
    process.stdout.write('\x1b[?25h');
  }
}
