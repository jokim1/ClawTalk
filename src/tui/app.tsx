/**
 * ClawTalk TUI App
 *
 * Main terminal user interface built with Ink (React for CLI).
 * Full-screen layout with pinned status bar (top), pinned input/shortcuts (bottom),
 * and scrollable message history in the middle.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import type {
  ClawTalkOptions,
  ModelStatus,
  Message,
  TalkAgent,
  AgentRole,
  PendingAttachment,
  Directive,
  PlatformBinding,
  PlatformBehavior,
  PlatformPermission,
  Job,
  ToolMode,
  ToolExecutionMode,
  ToolExecutionModeOption,
  ToolFilesystemAccess,
  ToolNetworkAccess,
  ToolDescriptor,
  ToolCatalogEntry,
  GoogleAuthProfileSummary,
} from '../types.js';
import type { Talk } from '../types.js';
import { AGENT_ROLES, ROLE_BY_ID, AGENT_PREAMBLE, generateAgentName } from '../agent-roles.js';
import type { RoleTemplate } from '../agent-roles.js';
import { StatusBar, ShortcutBar } from './components/StatusBar';
import { InputArea } from './components/InputArea.js';
import { ChatView } from './components/ChatView.js';
import { ModelPicker } from './components/ModelPicker.js';
import type { Model } from './components/ModelPicker.js';
import { RolePicker } from './components/RolePicker.js';
import { TalksHub } from './components/TalksHub';
import { EditMessages } from './components/EditMessages';
import { ChannelConfigPicker } from './components/ChannelConfigPicker';
import { JobsConfigPicker } from './components/JobsConfigPicker';
import { SettingsPicker } from './components/SettingsPicker.js';
import { ChatService } from '../services/chat';
import type { SlackAccountOption, SlackChannelOption } from '../services/chat';
import { getSessionManager } from '../services/sessions';
import type { SessionManager } from '../services/sessions';
import { getTalkManager } from '../services/talks';
import type { TalkManager } from '../services/talks';
import { spawnNewTerminalWindow } from '../services/terminal.js';
import { VoiceService } from '../services/voice.js';
import { RealtimeVoiceService } from '../services/realtime-voice.js';
import { AnthropicRateLimitService } from '../services/anthropic-ratelimit.js';
import { processImage } from '../services/image.js';
import { processFile, detectFilePaths, readFileForUpload } from '../services/file.js';
import { loadConfig, saveConfig, getBillingForProvider } from '../config.js';
import {
  getModelAlias,
  getModelPricing,
  getProviderKey,
  formatPricingLabel,
  ALIAS_TO_MODEL_ID,
} from '../models.js';
import { DEFAULT_MODEL, RESIZE_DEBOUNCE_MS } from '../constants.js';
import { createMessage, cleanInputChar } from './helpers.js';
import { exportTranscript, exportTranscriptMd, exportTranscriptDocx } from './utils.js';
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

const DEFAULT_EXECUTION_MODE: ToolExecutionMode = 'openclaw';
const DEFAULT_EXECUTION_MODE_OPTIONS: ToolExecutionModeOption[] = [
  {
    value: 'openclaw',
    label: 'openclaw_agent',
    title: 'OpenClaw Agent',
    description: 'OpenClaw agent runtime, tools, and session behavior.',
  },
  {
    value: 'full_control',
    label: 'clawtalk_proxy',
    title: 'ClawTalk Proxy',
    description: 'Sends prompts directly with minimal OpenClaw runtime mediation.',
  },
];

function formatBindingScopeLabel(binding: {
  scope: string;
  displayScope?: string;
  accountId?: string;
}): string {
  const scopeLabel = binding.displayScope?.trim() || binding.scope;
  const accountId = binding.accountId?.trim();
  if (accountId) {
    const prefixed = `${accountId}:`;
    if (scopeLabel.toLowerCase().startsWith(prefixed.toLowerCase())) {
      return scopeLabel;
    }
    return `${binding.accountId}:${scopeLabel}`;
  }
  return scopeLabel;
}

function formatPostingPriority(mode: 'thread' | 'channel' | 'adaptive' | undefined): 'reply' | 'channel' | 'adaptive' {
  if (mode === 'thread') return 'reply';
  if (mode === 'channel') return 'channel';
  return 'adaptive';
}

function mergeGoogleAuthProfiles(
  profiles: GoogleAuthProfileSummary[] | undefined,
  authStatus: {
    profile?: string;
    hasClientId: boolean;
    hasClientSecret: boolean;
    hasRefreshToken: boolean;
    accessTokenReady: boolean;
    error?: string;
    accountEmail?: string;
    accountDisplayName?: string;
  } | null | undefined,
): GoogleAuthProfileSummary[] {
  const base = profiles ?? [];
  if (!authStatus?.profile) return base;
  let patched = false;
  const next = base.map((entry) => {
    if (entry.name !== authStatus.profile) return entry;
    patched = true;
    return {
      ...entry,
      hasClientId: authStatus.hasClientId,
      hasClientSecret: authStatus.hasClientSecret,
      hasRefreshToken: authStatus.hasRefreshToken,
      accessTokenReady: authStatus.accessTokenReady,
      error: authStatus.error,
      accountEmail: authStatus.accountEmail ?? entry.accountEmail,
      accountDisplayName: authStatus.accountDisplayName ?? entry.accountDisplayName,
    };
  });
  if (patched) return next;
  return [
    ...next,
    {
      name: authStatus.profile,
      hasClientId: authStatus.hasClientId,
      hasClientSecret: authStatus.hasClientSecret,
      hasRefreshToken: authStatus.hasRefreshToken,
      accessTokenReady: authStatus.accessTokenReady,
      error: authStatus.error,
      accountEmail: authStatus.accountEmail,
      accountDisplayName: authStatus.accountDisplayName,
    },
  ];
}

function normalizeJobScheduleForBindings(
  schedule: string,
  bindings: PlatformBinding[],
): { schedule: string; error?: string } {
  const trimmed = schedule.trim();
  if (!trimmed) return { schedule: trimmed, error: 'Schedule cannot be empty.' };

  const eventMatch = trimmed.match(/^on\s+(.+)$/i);
  if (!eventMatch?.[1]) return { schedule: trimmed };

  const target = eventMatch[1].trim();
  if (!target) return { schedule: trimmed, error: 'Event target cannot be empty.' };

  const aliasMatch = target.match(/^(platform|channel|connection)(\d+)$/i);
  if (aliasMatch) {
    const idx = parseInt(aliasMatch[2], 10);
    if (idx < 1 || idx > bindings.length) {
      return {
        schedule: trimmed,
        error: `No channel connection at position ${idx}.`,
      };
    }
    const resolved = bindings[idx - 1]?.scope?.trim();
    if (!resolved) {
      return {
        schedule: trimmed,
        error: `Channel connection #${idx} has no valid scope.`,
      };
    }
    return { schedule: `on ${resolved}` };
  }

  const directScope = bindings.find((binding) => binding.scope.toLowerCase() === target.toLowerCase());
  if (directScope) {
    return { schedule: `on ${directScope.scope}` };
  }

  const formattedMatches = bindings.filter(
    (binding) => formatBindingScopeLabel(binding).toLowerCase() === target.toLowerCase(),
  );
  if (formattedMatches.length === 1 && formattedMatches[0]) {
    return { schedule: `on ${formattedMatches[0].scope}` };
  }

  const displayScopeMatches = bindings.filter(
    (binding) => (binding.displayScope?.trim().toLowerCase() ?? '') === target.toLowerCase(),
  );
  if (displayScopeMatches.length === 1 && displayScopeMatches[0]) {
    return { schedule: `on ${displayScopeMatches[0].scope}` };
  }
  if (displayScopeMatches.length > 1) {
    return {
      schedule: trimmed,
      error: `Multiple channel connections match "${target}". Use full connection label.`,
    };
  }

  return { schedule: trimmed };
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
  const [modelPickerMode, setModelPickerMode] = useState<'switch' | 'default'>('switch');
  const [showRolePicker, setShowRolePicker] = useState(false);
  const [pendingAgentModelId, setPendingAgentModelId] = useState<string | null>(null);
  const [rolePickerPhase, setRolePickerPhase] = useState<'primary' | 'new-agent'>('new-agent');
  const [streamingAgentName, setStreamingAgentName] = useState<string | undefined>(undefined);
  // Pending agent from /agent add command — created after primary role is selected
  const [pendingSlashAgent, setPendingSlashAgent] = useState<{ model: string; role: AgentRole } | null>(null);
  const [grabTextMode, setGrabTextMode] = useState(false);
  const [showEditMessages, setShowEditMessages] = useState(false);
  const [showTalks, setShowTalks] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'talk' | 'tools' | 'mic' | 'stt' | 'tts' | 'realtime'>('talk');
  const [showChannelConfig, setShowChannelConfig] = useState(false);
  const [showJobsConfig, setShowJobsConfig] = useState(false);
  const [settingsFromTalks, setSettingsFromTalks] = useState(false);
  const [slackAccountHints, setSlackAccountHints] = useState<SlackAccountOption[]>([]);
  const [slackChannelsByAccount, setSlackChannelsByAccount] = useState<Record<string, SlackChannelOption[]>>({});
  const [slackHintsLoading, setSlackHintsLoading] = useState(false);
  const [slackHintsError, setSlackHintsError] = useState<string | null>(null);
  const [settingsToolPolicy, setSettingsToolPolicy] = useState<{
    mode: ToolMode;
    executionMode: ToolExecutionMode;
    executionModeOptions: ToolExecutionModeOption[];
    filesystemAccess: ToolFilesystemAccess;
    networkAccess: ToolNetworkAccess;
    effectiveTools: ToolDescriptor[];
    availableTools: ToolDescriptor[];
    enabledToolNames: string[];
    catalogEntries: ToolCatalogEntry[];
    installedToolNames: string[];
    talkGoogleAuthProfile?: string;
    googleAuthActiveProfile?: string;
    googleAuthProfiles: GoogleAuthProfileSummary[];
    googleAuthStatus?: {
      profile?: string;
      activeProfile?: string;
      accessTokenReady: boolean;
      error?: string;
    };
  } | null>(null);
  const [settingsToolPolicyLoading, setSettingsToolPolicyLoading] = useState(false);
  const [settingsToolPolicyError, setSettingsToolPolicyError] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('Session 1');
  const [activeTalkId, setActiveTalkId] = useState<string | null>(null);
  const activeTalkIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeTalkIdRef.current = activeTalkId;
    setError(null); // Clear error when switching talks
    setSettingsToolPolicy(null);
    setSettingsToolPolicyError(null);
    // Keep primary agent ref in sync
    const agents = activeTalkId ? talkManagerRef.current?.getAgents(activeTalkId) : [];
    primaryAgentRef.current = agents?.find(a => a.isPrimary) ?? null;
  }, [activeTalkId]);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [queueSelectedIndex, setQueueSelectedIndex] = useState<number | null>(null);
  const [processingStartTime, setProcessingStartTime] = useState<number | null>(null);
  const [hintSelectedIndex, setHintSelectedIndex] = useState(0);
  const [pendingClear, setPendingClear] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [pendingDocument, setPendingDocument] = useState<{ filename: string; text: string } | null>(null);
  const [pendingFiles, setPendingFiles] = useState<Array<{ path: string; filename: string }>>([]);
  const [fileIndicatorSelected, setFileIndicatorSelected] = useState(false);
  const [remoteProcessing, setRemoteProcessing] = useState(false);

  // --- TTS bridge ref (useChat → useVoice) ---

  const speakResponseRef = useRef<((text: string) => void) | null>(null);

  // --- Pricing ref (kept current for session cost calculation) ---

  const pricingRef = useRef({ inputPer1M: 0.14, outputPer1M: 0.28 });

  // --- Gateway Talk ID ref (used by useChat to route through /api/talks/:id/chat) ---

  const gatewayTalkIdRef = useRef<string | null>(null);
  const creatingGatewayTalkRef = useRef<Promise<string | null> | null>(null);
  const googleOAuthPollRef = useRef<NodeJS.Timeout | null>(null);
  const googleOAuthSessionRef = useRef<string | null>(null);

  // --- Primary agent ref (used by useChat for speaker labels) ---

  const primaryAgentRef = useRef<TalkAgent | null>(null);

  useEffect(() => {
    return () => {
      if (googleOAuthPollRef.current) {
        clearInterval(googleOAuthPollRef.current);
        googleOAuthPollRef.current = null;
      }
    };
  }, []);

  // --- Hooks ---

  const chat = useChat(
    chatServiceRef, sessionManagerRef, currentModelRef,
    setError, speakResponseRef,
    (err) => setModelStatus({ error: err }),
    pricingRef,
    activeTalkIdRef,
    gatewayTalkIdRef,
    primaryAgentRef,
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
      onNewReports: (reports) => {
        for (const report of reports) {
          const icon = report.status === 'success' ? '\u2713' : '\u2717';
          const sysMsg = createMessage('system', `[Job Report] ${icon} ${report.summary}`);
          chat.setMessages(prev => [...prev, sysMsg]);
        }
      },
    },
    gatewayTalkIdRef,
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

  const isOverlayActive = showModelPicker || showRolePicker || showEditMessages || showTalks || showChannelConfig || showJobsConfig || showSettings;

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

  // Reset queue selection when queue becomes empty
  useEffect(() => {
    if (messageQueue.length === 0) {
      setQueueSelectedIndex(null);
    } else if (queueSelectedIndex !== null && queueSelectedIndex >= messageQueue.length) {
      setQueueSelectedIndex(messageQueue.length - 1);
    }
  }, [messageQueue.length, queueSelectedIndex]);

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
  }, [inputText, isOverlayActive]);

  // --- Dynamic input height ---
  // Calculate how many visual lines the input text occupies
  const inputContentWidth = Math.max(10, terminalWidth - 4); // matches InputArea's inputWidth
  const inputVisualLines = inputText.length === 0
    ? 1
    : countVisualLines(inputText, inputContentWidth);
  const maxInputLines = Math.min(10, Math.floor(terminalHeight / 4));
  const inputLines = Math.min(maxInputLines, inputVisualLines);

  // Talk title / grab mode indicator (shown below status bar)
  const activeTalk = activeTalkId ? talkManagerRef.current?.getTalk(activeTalkId) : null;
  const talkTitle = activeTalk?.topicTitle ?? null;
  const showTitleBar = !isOverlayActive && (talkTitle || grabTextMode);
  const talkTitleLines = showTitleBar ? 2 : 0; // title/indicator + separator

  // Calculate available height for the chat area:
  // Total - StatusBar(2) - talkTitle(0-2) - error(0-1) - clearPrompt(0-1) - separator(1) - input - shortcuts(3) - queued - hints - margin(1)
  const errorLines = error ? 1 : 0;
  const clearPromptLines = pendingClear ? 1 : 0;
  const attachmentLines = (pendingAttachment ? 1 : 0) + (pendingDocument ? 1 : 0) + pendingFiles.length;
  const queuedLines = messageQueue.length > 0 ? messageQueue.length : 0;
  const hintsLines = showCommandHints ? commandHints.length + 1 : 0; // +1 for separator line
  const chatHeight = Math.max(4, terminalHeight - 2 - talkTitleLines - errorLines - clearPromptLines - attachmentLines - 1 - inputLines - 3 - queuedLines - hintsLines - 1);

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
    enabled: !isOverlayActive && !grabTextMode,
  });

  // Toggle mouse capture for grab text mode
  useEffect(() => {
    if (!stdout) return;
    if (grabTextMode) {
      stdout.write('\x1b[?1000l');
      stdout.write('\x1b[?1006l');
    } else {
      stdout.write('\x1b[?1000h');
      stdout.write('\x1b[?1006h');
    }
  }, [grabTextMode, stdout]);

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

  const selectDefaultModel = useCallback((modelId: string) => {
    setShowModelPicker(false);
    setShowTalks(true);
    // Save to config as the default model for new talks
    const config = loadConfig();
    config.defaultModel = modelId;
    saveConfig(config);
    setSavedConfig(prev => ({ ...prev, defaultModel: modelId }));
    // Also update current model so next new talk uses it immediately
    setCurrentModel(modelId);
    chatServiceRef.current?.setModel(modelId);
    setError(`Default model set to ${getModelAlias(modelId)}`);
  }, []);

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

  useEffect(() => {
    if (!showModelPicker) return;
    void gateway.refreshModelCatalog();
  }, [showModelPicker, gateway.refreshModelCatalog]);

  // --- Agent management ---

  /** Sync agents to gateway after any mutation. */
  const syncAgentsToGateway = useCallback((agents: TalkAgent[]) => {
    primaryAgentRef.current = agents.find(a => a.isPrimary) ?? null;
    const gwId = gatewayTalkIdRef.current;
    if (gwId && chatServiceRef.current) {
      chatServiceRef.current.updateGatewayTalk(gwId, { agents })
        .then(result => { if (!result.ok) setError(`Agent sync failed: ${result.error}`); })
        .catch(err => setError(`Agent sync failed: ${err instanceof Error ? err.message : err}`));
    }
  }, []);

  /** Handle "Add as Talk agent" request from ModelPicker. */
  const handleAddAgentRequest = useCallback((modelId: string) => {
    setShowModelPicker(false);
    setPendingAgentModelId(modelId);

    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const existingAgents = talkManagerRef.current.getAgents(talkId);
    if (existingAgents.length === 0) {
      // First time: need to assign a role to the current/primary model first
      setRolePickerPhase('primary');
    } else {
      setRolePickerPhase('new-agent');
    }
    setShowRolePicker(true);
  }, []);

  /** Handle role selection from RolePicker. */
  const handleRoleSelected = useCallback((role: RoleTemplate) => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    if (rolePickerPhase === 'primary') {
      // Create primary agent from current model + selected role
      const primaryAlias = getModelAlias(currentModel);
      const primaryAgent: TalkAgent = {
        name: generateAgentName(primaryAlias, role.id),
        model: currentModel,
        role: role.id,
        isPrimary: true,
      };
      talkManagerRef.current.addAgent(talkId, primaryAgent);

      // If there's a pending slash command agent, create it now and finish
      if (pendingSlashAgent) {
        const alias = getModelAlias(pendingSlashAgent.model);
        const newAgent: TalkAgent = {
          name: generateAgentName(alias, pendingSlashAgent.role),
          model: pendingSlashAgent.model,
          role: pendingSlashAgent.role,
          isPrimary: false,
        };
        talkManagerRef.current.addAgent(talkId, newAgent);
        talkManagerRef.current.saveTalk(talkId);

        const agents = talkManagerRef.current.getAgents(talkId);
        syncAgentsToGateway(agents);

        setShowRolePicker(false);
        setPendingAgentModelId(null);
        setPendingSlashAgent(null);

        const newAlias = getModelAlias(pendingSlashAgent.model);
        const sysMsg = createMessage('system', `Agents created: ${primaryAgent.name} (${role.label}) + ${newAgent.name} (${ROLE_BY_ID[pendingSlashAgent.role].label}). Use @${newAlias} in any message to ask ${newAgent.name} directly.`);
        chat.setMessages(prev => [...prev, sysMsg]);
        return;
      }

      // Otherwise (^K flow), show role picker again for the new agent model
      setRolePickerPhase('new-agent');
      // Don't dismiss — RolePicker stays open for the new agent
      return;
    }

    // new-agent phase: create agent from pendingAgentModelId
    if (!pendingAgentModelId) {
      setShowRolePicker(false);
      return;
    }

    const newAlias = getModelAlias(pendingAgentModelId);
    const newAgent: TalkAgent = {
      name: generateAgentName(newAlias, role.id),
      model: pendingAgentModelId,
      role: role.id,
      isPrimary: false,
    };
    talkManagerRef.current.addAgent(talkId, newAgent);

    // Auto-save the talk
    talkManagerRef.current.saveTalk(talkId);

    // Sync to gateway
    const agents = talkManagerRef.current.getAgents(talkId);
    syncAgentsToGateway(agents);

    // Dismiss and confirm
    setShowRolePicker(false);
    setPendingAgentModelId(null);

    const sysMsg = createMessage('system', `Agent added: ${newAgent.name} (${role.label}). Use @${newAlias} in any message to ask directly.`);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, [rolePickerPhase, pendingAgentModelId, pendingSlashAgent, currentModel, syncAgentsToGateway]);

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

  // --- Automation handlers ---

  const getGatewayTalkIdForActiveTalk = useCallback((): string | null => {
    if (gatewayTalkIdRef.current) return gatewayTalkIdRef.current;
    if (!activeTalkId || !talkManagerRef.current) return null;
    return talkManagerRef.current.getGatewayTalkId(activeTalkId) ?? null;
  }, [activeTalkId]);

  const refreshJobsFromSource = useCallback(async (): Promise<Job[]> => {
    if (!activeTalkId || !talkManagerRef.current) return [];

    const gwId = getGatewayTalkIdForActiveTalk();
    if (gwId && chatServiceRef.current) {
      const jobs = await chatServiceRef.current.listGatewayJobs(gwId);
      talkManagerRef.current.replaceJobs(activeTalkId, jobs);
      return jobs;
    }

    return talkManagerRef.current.getJobs(activeTalkId);
  }, [activeTalkId, getGatewayTalkIdForActiveTalk]);

  /** Helper: resolve automation ID by 1-based index via gateway. */
  const resolveGatewayJobByIndex = useCallback(async (index: number): Promise<{ jobId: string; jobs: Job[] } | null> => {
    const gwId = getGatewayTalkIdForActiveTalk();
    if (!gwId || !chatServiceRef.current) return null;
    const jobs = await refreshJobsFromSource();
    const job = jobs[index - 1];
    if (!job?.id) return null;
    return { jobId: job.id, jobs };
  }, [getGatewayTalkIdForActiveTalk, refreshJobsFromSource]);

  const updateJobByIndex = useCallback(async (
    index: number,
    updates: Partial<Pick<Job, 'active' | 'schedule' | 'prompt'>>,
  ): Promise<boolean> => {
    if (!activeTalkId || !talkManagerRef.current) return false;

    const bindings = talkManagerRef.current.getPlatformBindings(activeTalkId);
    let normalizedUpdates = { ...updates };
    if (updates.schedule !== undefined) {
      const normalized = normalizeJobScheduleForBindings(updates.schedule, bindings);
      if (normalized.error) {
        setError(normalized.error);
        return false;
      }
      normalizedUpdates.schedule = normalized.schedule;
    }

    const gwId = getGatewayTalkIdForActiveTalk();
    if (gwId && chatServiceRef.current) {
      const result = await resolveGatewayJobByIndex(index);
      if (!result) {
        setError(`No automation at position ${index}`);
        return false;
      }
      const ok = await chatServiceRef.current.updateGatewayJob(gwId, result.jobId, normalizedUpdates);
      if (!ok) return false;
      await refreshJobsFromSource();
      return true;
    }

    const ok = talkManagerRef.current.updateJobByIndex(activeTalkId, index, normalizedUpdates);
    if (!ok) {
      setError(`No automation at position ${index}`);
      return false;
    }
    return true;
  }, [activeTalkId, getGatewayTalkIdForActiveTalk, refreshJobsFromSource, resolveGatewayJobByIndex]);

  const deleteJobByIndex = useCallback(async (index: number): Promise<boolean> => {
    if (!activeTalkId || !talkManagerRef.current) return false;

    const gwId = getGatewayTalkIdForActiveTalk();
    if (gwId && chatServiceRef.current) {
      const result = await resolveGatewayJobByIndex(index);
      if (!result) {
        setError(`No automation at position ${index}`);
        return false;
      }
      const ok = await chatServiceRef.current.deleteGatewayJob(gwId, result.jobId);
      if (!ok) return false;
      await refreshJobsFromSource();
      return true;
    }

    const ok = talkManagerRef.current.deleteJob(activeTalkId, index);
    if (!ok) {
      setError(`No automation at position ${index}`);
      return false;
    }
    return true;
  }, [activeTalkId, getGatewayTalkIdForActiveTalk, refreshJobsFromSource, resolveGatewayJobByIndex]);

  const handleAddJob = useCallback(async (schedule: string, prompt: string): Promise<boolean> => {
    if (!activeTalkId || !talkManagerRef.current) return false;
    talkManagerRef.current.saveTalk(activeTalkId);

    const bindings = talkManagerRef.current.getPlatformBindings(activeTalkId);
    const scheduleResolution = normalizeJobScheduleForBindings(schedule, bindings);
    if (scheduleResolution.error) {
      setError(scheduleResolution.error);
      return false;
    }
    const normalizedSchedule = scheduleResolution.schedule.trim();
    const normalizedPrompt = prompt.trim();
    if (!normalizedSchedule || !normalizedPrompt) {
      setError('Automation schedule and prompt are required.');
      return false;
    }

    const isEvent = /^on\s+/i.test(normalizedSchedule);
    const isOneOff = /^(in\s|at\s)/i.test(normalizedSchedule);
    const label = isEvent ? 'Event Automation Created' : isOneOff ? 'Automation Scheduled' : 'Recurring Automation Scheduled';

    const gwId = getGatewayTalkIdForActiveTalk();
    if (!gwId || !chatServiceRef.current) {
      const sysMsg = createMessage('system', 'Cannot create automation: no gateway connection. Automations run server-side — connect to a gateway first.');
      chat.setMessages(prev => [...prev, sysMsg]);
      return false;
    }

    try {
      const result = await chatServiceRef.current.createGatewayJob(gwId, normalizedSchedule, normalizedPrompt);
      if (typeof result === 'string') {
        setError(`Automation failed: ${result}`);
        return false;
      }

      await refreshJobsFromSource();
      const resolvedSchedule = result.schedule ?? normalizedSchedule;
      const promptLines = normalizedPrompt.split('\n').map((line) => `    ${line || ' '}`).join('\n');
      const sysMsg = createMessage(
        'system',
        `[${label}] schedule: ${resolvedSchedule}\n` +
        `  prompt:\n${promptLines}`,
      );
      chat.setMessages(prev => [...prev, sysMsg]);
      return true;
    } catch (err) {
      setError(`Automation failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }, [activeTalkId, getGatewayTalkIdForActiveTalk, refreshJobsFromSource]);

  const handleListJobs = useCallback(() => {
    if (!activeTalkId) return;

    void (async () => {
      const jobs = await refreshJobsFromSource();
      if (jobs.length === 0) {
        const sysMsg = createMessage('system', 'No automations for this talk.');
        chat.setMessages(prev => [...prev, sysMsg]);
        return;
      }

      const lines = jobs.map((j, i) => {
        const status = j.active ? 'active' : 'paused';
        const lastRun = j.lastRunAt ? ` (last: ${new Date(j.lastRunAt).toLocaleString()})` : '';
        const promptLines = (j.prompt?.trim() ? j.prompt : '(none)')
          .split('\n')
          .map((line) => `      ${line || ' '}`)
          .join('\n');
        return `  ${i + 1}. [${status}] "${j.schedule}"${lastRun}\n` +
          `    prompt:\n${promptLines}`;
      });
      const sysMsg = createMessage('system', `Automations:\n${lines.join('\n')}`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, refreshJobsFromSource]);

  const handleSetJobActive = useCallback(async (index: number, active: boolean): Promise<boolean> => {
    const ok = await updateJobByIndex(index, { active });
    if (!ok) {
      if (!error) {
        setError(`Failed to ${active ? 'resume' : 'pause'} automation #${index}`);
      }
      return false;
    }
    return true;
  }, [error, updateJobByIndex]);

  const handleSetJobSchedule = useCallback(async (index: number, schedule: string): Promise<boolean> => {
    const ok = await updateJobByIndex(index, { schedule });
    if (!ok) {
      if (!error) {
        setError(`Failed to update schedule for automation #${index}`);
      }
      return false;
    }
    return true;
  }, [error, updateJobByIndex]);

  const handleSetJobPrompt = useCallback(async (index: number, prompt: string): Promise<boolean> => {
    const ok = await updateJobByIndex(index, { prompt });
    if (!ok) {
      if (!error) {
        setError(`Failed to update prompt for automation #${index}`);
      }
      return false;
    }
    return true;
  }, [error, updateJobByIndex]);

  const handleDeleteJob = useCallback((index: number) => {
    void (async () => {
      const ok = await deleteJobByIndex(index);
      if (!ok) {
        if (!error) {
          setError(`Failed to delete automation #${index}`);
        }
        return;
      }
      const sysMsg = createMessage('system', `Automation #${index} deleted.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [deleteJobByIndex, error]);

  const handleDeleteJobForPicker = useCallback(async (index: number): Promise<boolean> => {
    const ok = await deleteJobByIndex(index);
    if (!ok) {
      if (!error) {
        setError(`Failed to delete automation #${index}`);
      }
      return false;
    }
    return true;
  }, [deleteJobByIndex, error]);

  const handlePauseJob = useCallback((index: number) => {
    void (async () => {
      const ok = await handleSetJobActive(index, false);
      if (!ok) return;
      const sysMsg = createMessage('system', `Automation #${index} paused.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [handleSetJobActive]);

  const handleResumeJob = useCallback((index: number) => {
    void (async () => {
      const ok = await handleSetJobActive(index, true);
      if (!ok) return;
      const sysMsg = createMessage('system', `Automation #${index} resumed.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [handleSetJobActive]);

  // --- Objective handlers ---

  const handleSetObjective = useCallback((text: string | undefined) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.setObjective(activeTalkId, text);
    // Update gateway talk objective
    if (gatewayTalkIdRef.current) {
      chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { objective: text ?? '' });
    }
    if (text) {
      const sysMsg = createMessage('system', `Objectives set: ${text}`);
      chat.setMessages(prev => [...prev, sysMsg]);
    } else {
      const sysMsg = createMessage('system', 'Objectives cleared.');
      chat.setMessages(prev => [...prev, sysMsg]);
    }
  }, [activeTalkId]);

  const handleShowObjective = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const objective = talkManagerRef.current.getObjective(activeTalkId);
    const text = objective
      ? `Current objectives: ${objective}`
      : 'No objectives set. Use /objective <text> (or /objectives <text>) to set one.';
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

    // If jobIndex is given, resolve the automation ID first
    if (jobIndex !== undefined) {
      resolveGatewayJobByIndex(jobIndex).then(result => {
        if (!result) {
          setError(`No automation at position ${jobIndex}`);
          return;
        }
        chatServiceRef.current?.fetchGatewayReports(gwId, result.jobId, 10).then(reports => {
          if (reports.length === 0) {
          const sysMsg = createMessage('system', `No reports for automation #${jobIndex}.`);
            chat.setMessages(prev => [...prev, sysMsg]);
            return;
          }
          const lines = reports.map(r => {
            const ts = new Date(r.runAt).toLocaleString();
            const icon = r.status === 'success' ? '✓' : '✗';
            return `  ${icon} [${ts}] ${r.summary}`;
          });
          const sysMsg = createMessage('system', `Reports for automation #${jobIndex}:\n${lines.join('\n')}`);
          chat.setMessages(prev => [...prev, sysMsg]);
        });
      });
    } else {
      chatServiceRef.current.fetchGatewayReports(gwId, undefined, 10).then(reports => {
        if (reports.length === 0) {
          const sysMsg = createMessage('system', 'No automation reports for this talk.');
          chat.setMessages(prev => [...prev, sysMsg]);
          return;
        }
        const lines = reports.map(r => {
          const ts = new Date(r.runAt).toLocaleString();
          const icon = r.status === 'success' ? '✓' : '✗';
          return `  ${icon} [${ts}] ${r.summary}`;
        });
        const sysMsg = createMessage('system', `Automation reports:\n${lines.join('\n')}`);
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

  // --- Export / Edit handlers ---

  const handleExportTalk = useCallback((format?: string, lastN?: number) => {
    const session = sessionManagerRef.current?.getActiveSession();
    if (!session || chat.messages.length === 0) {
      setError('No messages to export');
      return;
    }
    const talk = activeTalkId ? talkManagerRef.current?.getTalk(activeTalkId) : null;
    const name = talk?.topicTitle ?? session.name ?? 'Chat';
    const msgs = lastN ? chat.messages.slice(-lastN) : chat.messages;

    // Normalize format aliases
    const fmt = format === 't' ? 'txt' : format === 'm' ? 'md' : format === 'd' ? 'docx' : (format || 'md');

    try {
      if (fmt === 'docx') {
        exportTranscriptDocx(msgs, name, savedConfig.exportDir).then(filepath => {
          addSystemMessage(`Exported: ${filepath}`);
        }).catch(err => {
          setError(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        });
      } else if (fmt === 'txt') {
        const filepath = exportTranscript(msgs, name, savedConfig.exportDir);
        addSystemMessage(`Exported: ${filepath}`);
      } else {
        const filepath = exportTranscriptMd(msgs, name, savedConfig.exportDir);
        addSystemMessage(`Exported: ${filepath}`);
      }
    } catch (err) {
      setError(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [activeTalkId, chat.messages, savedConfig.exportDir]);

  const handleEditMessages = useCallback(() => {
    const editable = chat.messages.filter(m => m.role !== 'system');
    if (editable.length === 0) {
      setError('No messages to edit');
      return;
    }
    setShowEditMessages(true);
  }, [chat.messages]);

  // --- Directive handlers ---

  const handleAddDirective = useCallback((text: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);

    const directive = talkManagerRef.current.addDirective(activeTalkId, text);
    if (!directive) { setError('Failed to add rule'); return; }

    const sysMsg = createMessage('system', `Rule added: ${text}`);
    chat.setMessages(prev => [...prev, sysMsg]);

    // Sync to gateway
    if (gatewayTalkIdRef.current && chatServiceRef.current) {
      const directives = talkManagerRef.current.getDirectives(activeTalkId);
      chatServiceRef.current.updateGatewayTalk(gatewayTalkIdRef.current, { directives });
    }
  }, [activeTalkId]);

  const handleRemoveDirective = useCallback((index: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;

    const success = talkManagerRef.current.removeDirective(activeTalkId, index);
    if (!success) { setError(`No rule at position ${index}`); return; }

    const sysMsg = createMessage('system', `Rule #${index} deleted.`);
    chat.setMessages(prev => [...prev, sysMsg]);

    if (gatewayTalkIdRef.current && chatServiceRef.current) {
      const directives = talkManagerRef.current.getDirectives(activeTalkId);
      chatServiceRef.current.updateGatewayTalk(gatewayTalkIdRef.current, { directives });
    }
  }, [activeTalkId]);

  const handleToggleDirective = useCallback((index: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;

    const success = talkManagerRef.current.toggleDirective(activeTalkId, index);
    if (!success) { setError(`No rule at position ${index}`); return; }

    const directives = talkManagerRef.current.getDirectives(activeTalkId);
    const d = directives[index - 1];
    const status = d?.active ? 'active' : 'paused';
    const sysMsg = createMessage('system', `Rule #${index} ${status}.`);
    chat.setMessages(prev => [...prev, sysMsg]);

    if (gatewayTalkIdRef.current && chatServiceRef.current) {
      chatServiceRef.current.updateGatewayTalk(gatewayTalkIdRef.current, { directives });
    }
  }, [activeTalkId]);

  const handleListDirectives = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const directives = talkManagerRef.current.getDirectives(activeTalkId);
    if (directives.length === 0) {
      const sysMsg = createMessage('system', 'No rules for this talk. Use /rule <text> to add one.');
      chat.setMessages(prev => [...prev, sysMsg]);
      return;
    }
    const lines = directives.map((d, i) => {
      const status = d.active ? 'active' : 'paused';
      return `  ${i + 1}. [${status}] ${d.text}`;
    });
    const sysMsg = createMessage('system', `Rules:\n${lines.join('\n')}`);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId]);

  // --- Platform binding handlers ---

  const syncTalkBindingsToGateway = useCallback(async (talkId: string): Promise<boolean> => {
    if (!chatServiceRef.current || !talkManagerRef.current) {
      return true;
    }

    const ensureGatewayTalkForSync = async (): Promise<string | null> => {
      if (gatewayTalkIdRef.current) return gatewayTalkIdRef.current;
      const created = await chatServiceRef.current!.createGatewayTalk(currentModelRef.current);
      if (!created.ok || !created.data) {
        setError(`Failed to create gateway talk: ${created.error ?? 'Unknown error'}`);
        return null;
      }
      gatewayTalkIdRef.current = created.data;
      talkManagerRef.current?.setGatewayTalkId(talkId, created.data);
      return created.data;
    };

    let gatewayTalkId = await ensureGatewayTalkForSync();
    if (!gatewayTalkId) return false;

    const bindings = talkManagerRef.current.getPlatformBindings(talkId);
    const behaviors = talkManagerRef.current.getPlatformBehaviors(talkId);
    let result = await chatServiceRef.current.updateGatewayTalk(gatewayTalkId, {
      platformBindings: bindings,
      platformBehaviors: behaviors,
    });

    // Recover from stale gateway talk IDs (e.g. gateway restart + local mapping still cached).
    if (!result.ok && /Gateway error \(404\):/i.test(result.error ?? '')) {
      gatewayTalkIdRef.current = null;
      const recovered = await ensureGatewayTalkForSync();
      if (recovered) {
        gatewayTalkId = recovered;
        result = await chatServiceRef.current.updateGatewayTalk(gatewayTalkId, {
          platformBindings: bindings,
          platformBehaviors: behaviors,
        });
      }
    }

    if (!result.ok) {
      setError(result.error ?? 'Failed to sync channel settings to gateway');
      return false;
    }

    const gwTalk = await chatServiceRef.current.getGatewayTalk(gatewayTalkId);
    if (gwTalk) {
      talkManagerRef.current.importGatewayTalk({
        id: gwTalk.id,
        topicTitle: gwTalk.topicTitle,
        objective: gwTalk.objective,
        objectives: gwTalk.objectives,
        model: gwTalk.model,
        pinnedMessageIds: gwTalk.pinnedMessageIds,
        jobs: [],
        agents: gwTalk.agents,
        directives: gwTalk.directives,
        rules: gwTalk.rules,
        platformBindings: gwTalk.platformBindings,
        channelConnections: gwTalk.channelConnections,
        platformBehaviors: gwTalk.platformBehaviors,
        channelResponseSettings: gwTalk.channelResponseSettings,
        toolMode: gwTalk.toolMode,
        executionMode: gwTalk.executionMode,
        filesystemAccess: gwTalk.filesystemAccess,
        networkAccess: gwTalk.networkAccess,
        toolsAllow: gwTalk.toolsAllow,
        toolsDeny: gwTalk.toolsDeny,
        googleAuthProfile: gwTalk.googleAuthProfile,
        processing: gwTalk.processing,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return true;
  }, []);

  const restoreTalkRoutingState = useCallback((talkId: string, bindings: PlatformBinding[], behaviors: PlatformBehavior[]) => {
    if (!talkManagerRef.current) return;
    const talk = talkManagerRef.current.getTalk(talkId);
    if (!talk) return;
    talk.platformBindings = bindings;
    talk.platformBehaviors = behaviors;
    talk.updatedAt = Date.now();
    talkManagerRef.current.saveTalk(talkId);
  }, []);

  const handleAddPlatformBinding = useCallback((platform: string, scope: string, permission: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);

    const binding = talkManagerRef.current.addPlatformBinding(activeTalkId, platform, scope, permission as PlatformPermission);
    if (!binding) { setError('Failed to add channel connection'); return; }

    void (async () => {
      const ok = await syncTalkBindingsToGateway(activeTalkId);
      if (!ok) {
        talkManagerRef.current?.removePlatformBindingById(activeTalkId, binding.id);
        const failMsg = createMessage('system', 'Failed to save channel connection to gateway; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
        return;
      }

      const latest = talkManagerRef.current?.getPlatformBindings(activeTalkId).find((row) => row.id === binding.id) ?? binding;
      const sysMsg = createMessage(
        'system',
        `Channel connection added: ${latest.platform} ${formatBindingScopeLabel(latest)} (${latest.permission})`,
      );
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, syncTalkBindingsToGateway]);

  const handleRemovePlatformBinding = useCallback((index: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;

    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));
    const success = talkManagerRef.current.removePlatformBinding(activeTalkId, index);
    if (!success) { setError(`No channel connection at position ${index}`); return; }

    void (async () => {
      const ok = await syncTalkBindingsToGateway(activeTalkId);
      if (!ok) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to remove channel connection on gateway; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
        return;
      }

      const sysMsg = createMessage('system', `Channel connection #${index} removed.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway]);

  const handleUpdatePlatformBinding = useCallback((
    index: number,
    updates: Partial<Pick<PlatformBinding, 'platform' | 'scope' | 'permission'>>,
  ) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);

    const success = talkManagerRef.current.updatePlatformBindingByIndex(activeTalkId, index, updates);
    if (!success) {
      setError(`No channel connection at position ${index}`);
      return;
    }

    if (gatewayTalkIdRef.current && chatServiceRef.current) {
      const bindings = talkManagerRef.current.getPlatformBindings(activeTalkId);
      const behaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId);
      chatServiceRef.current.updateGatewayTalk(gatewayTalkIdRef.current, {
        platformBindings: bindings,
        platformBehaviors: behaviors,
      });
    }
  }, [activeTalkId]);

  const handleListPlatformBindings = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const bindings = talkManagerRef.current.getPlatformBindings(activeTalkId);
    if (bindings.length === 0) {
      const sysMsg = createMessage(
        'system',
        'No channel connections for this talk. Press ^B to open Channel Config (Slack full support; Telegram/WhatsApp for event jobs).',
      );
      chat.setMessages(prev => [...prev, sysMsg]);
      return;
    }
    const lines = bindings.map((b, i) =>
      `  ${i + 1}. platform${i + 1}: ${b.platform} ${formatBindingScopeLabel(b)} (${b.permission})`
    );
    const sysMsg = createMessage('system', `Channel connections:\n${lines.join('\n')}`);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId]);

  // --- Channel response settings handlers ---

  const handleListChannelResponses = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const bindings = talkManagerRef.current.getPlatformBindings(activeTalkId);
    if (bindings.length === 0) {
      const sysMsg = createMessage('system', 'No channel connections yet. Press ^B to add one.');
      chat.setMessages(prev => [...prev, sysMsg]);
      return;
    }

    const behaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId);
    const responseModeFor = (behavior?: { responseMode?: string; autoRespond?: boolean }) =>
      behavior?.responseMode ?? (behavior?.autoRespond === false ? 'off' : 'all');
    const lines = bindings.map((binding, i) => {
      const behavior = behaviors.find((entry) => entry.platformBindingId === binding.id);
      const mode = responseModeFor(behavior);
      const mirror = behavior?.mirrorToTalk ?? 'off';
      const posting = formatPostingPriority(behavior?.deliveryMode);
      const promptLines = (behavior?.onMessagePrompt?.trim() ? behavior.onMessagePrompt : '(none)')
        .split('\n')
        .map((line) => `      ${line || ' '}`)
        .join('\n');
      const agent = behavior?.agentName ?? '(default)';
      return `  ${i + 1}. ${binding.platform} ${formatBindingScopeLabel(binding)} -> mode:${mode}, posting:${posting}, mirror:${mirror}, agent:${agent}\n` +
        `    response_prompt:\n${promptLines}`;
    });
    const sysMsg = createMessage('system', `Channel response settings:\n${lines.join('\n')}`);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId]);

  const handleSetChannelResponseMode = useCallback((index: number, mode: 'off' | 'mentions' | 'all') => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));
    const ok = talkManagerRef.current.upsertPlatformBehaviorByBindingIndex(activeTalkId, index, {
      responseMode: mode,
    });
    if (!ok) {
      setError(`No channel connection at position ${index}`);
      return;
    }
    void (async () => {
      const synced = await syncTalkBindingsToGateway(activeTalkId);
      if (!synced) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to save channel response settings; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
        return;
      }
      const sysMsg = createMessage('system', `Channel response #${index} mode set to ${mode}.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway]);

  const handleSetChannelMirrorToTalk = useCallback((index: number, mirrorToTalk: 'off' | 'inbound' | 'full') => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));
    const ok = talkManagerRef.current.upsertPlatformBehaviorByBindingIndex(activeTalkId, index, {
      mirrorToTalk,
    });
    if (!ok) {
      setError(`No channel connection at position ${index}`);
      return;
    }
    void (async () => {
      const synced = await syncTalkBindingsToGateway(activeTalkId);
      if (!synced) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to save channel response settings; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
        return;
      }
      const sysMsg = createMessage('system', `Channel response #${index} Slack Message Mirroring set to ${mirrorToTalk}.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway]);

  const handleSetChannelDeliveryMode = useCallback((index: number, deliveryMode: 'thread' | 'channel' | 'adaptive') => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));
    const ok = talkManagerRef.current.upsertPlatformBehaviorByBindingIndex(activeTalkId, index, {
      deliveryMode,
    });
    if (!ok) {
      setError(`No channel connection at position ${index}`);
      return;
    }
    void (async () => {
      const synced = await syncTalkBindingsToGateway(activeTalkId);
      if (!synced) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to save channel response settings; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
        return;
      }
      const sysMsg = createMessage(
        'system',
        `Channel response #${index} Posting Priority set to ${formatPostingPriority(deliveryMode)}.`,
      );
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway]);

  const handleSetChannelResponseEnabled = useCallback((index: number, enabled: boolean) => {
    handleSetChannelResponseMode(index, enabled ? 'all' : 'off');
  }, [handleSetChannelResponseMode]);

  const handleSetChannelResponsePrompt = useCallback((index: number, prompt: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));
    const ok = talkManagerRef.current.upsertPlatformBehaviorByBindingIndex(activeTalkId, index, {
      responseMode: 'all',
      onMessagePrompt: prompt,
    });
    if (!ok) {
      setError(`No channel connection at position ${index}`);
      return;
    }
    void (async () => {
      const synced = await syncTalkBindingsToGateway(activeTalkId);
      if (!synced) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to save channel response settings; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
        return;
      }
      const sysMsg = createMessage('system', `Channel response prompt set for connection #${index}.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway]);

  const handleSetChannelResponseAgent = useCallback((index: number, agentName: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const agents = talkManagerRef.current.getAgents(activeTalkId);
    const matched = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
    if (!matched) {
      setError(`Unknown agent "${agentName}". Use /agents to list names.`);
      return;
    }
    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));
    const ok = talkManagerRef.current.upsertPlatformBehaviorByBindingIndex(activeTalkId, index, {
      agentName: matched.name,
    });
    if (!ok) {
      setError(`No channel connection at position ${index}`);
      return;
    }
    void (async () => {
      const synced = await syncTalkBindingsToGateway(activeTalkId);
      if (!synced) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to save channel response settings; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
        return;
      }
      const sysMsg = createMessage('system', `Channel response agent for connection #${index}: ${matched.name}`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway]);

  const handleSetChannelResponseAgentChoice = useCallback((index: number, agentName?: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));

    if (!agentName) {
      const bindings = talkManagerRef.current.getPlatformBindings(activeTalkId);
      if (index < 1 || index > bindings.length) {
        setError(`No channel connection at position ${index}`);
        return;
      }
      const binding = bindings[index - 1];
      const existing = talkManagerRef.current
        .getPlatformBehaviors(activeTalkId)
        .find((entry) => entry.platformBindingId === binding.id);

      if (!existing) {
        return;
      }

      const hasPrompt = Boolean(existing.onMessagePrompt?.trim());
      const existingMode = existing.responseMode ?? (existing.autoRespond === false ? 'off' : 'all');
      const explicitlyOff = existingMode === 'off';
      const ok = !hasPrompt && !explicitlyOff
        ? talkManagerRef.current.clearPlatformBehaviorByBindingIndex(activeTalkId, index)
        : talkManagerRef.current.upsertPlatformBehaviorByBindingIndex(activeTalkId, index, {
            agentName: '',
          });

      if (!ok) {
        setError(`No channel connection at position ${index}`);
        return;
      }
      void (async () => {
        const synced = await syncTalkBindingsToGateway(activeTalkId);
        if (!synced) {
          restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
          const failMsg = createMessage('system', 'Failed to save channel response settings; reverted local change.');
          chat.setMessages(prev => [...prev, failMsg]);
        }
      })();
      return;
    }

    const agents = talkManagerRef.current.getAgents(activeTalkId);
    const matched = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
    if (!matched) {
      setError(`Unknown agent "${agentName}". Use /agents to list names.`);
      return;
    }

    const ok = talkManagerRef.current.upsertPlatformBehaviorByBindingIndex(activeTalkId, index, {
      agentName: matched.name,
    });
    if (!ok) {
      setError(`No channel connection at position ${index}`);
      return;
    }
    void (async () => {
      const synced = await syncTalkBindingsToGateway(activeTalkId);
      if (!synced) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to save channel response settings; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
      }
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway]);

  const handleClearChannelResponse = useCallback((index: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));
    const ok = talkManagerRef.current.clearPlatformBehaviorByBindingIndex(activeTalkId, index);
    if (!ok) {
      setError(`No channel response settings found at position ${index}`);
      return;
    }
    void (async () => {
      const synced = await syncTalkBindingsToGateway(activeTalkId);
      if (!synced) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to clear channel response settings on gateway; reverted local change.');
        chat.setMessages(prev => [...prev, failMsg]);
        return;
      }
      const sysMsg = createMessage('system', `Channel response settings cleared for connection #${index}.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway]);

  // --- Tool policy handlers ---

  const syncToolPolicyLocal = useCallback((
    mode?: ToolMode,
    executionMode?: ToolExecutionMode,
    filesystemAccess?: ToolFilesystemAccess,
    networkAccess?: ToolNetworkAccess,
    allow?: string[],
    deny?: string[],
    googleAuthProfile?: string,
  ) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const talk = talkManagerRef.current.getTalk(activeTalkId);
    if (!talk) return;
    talk.toolMode = mode ?? talk.toolMode;
    talk.executionMode = executionMode ?? talk.executionMode;
    talk.filesystemAccess = filesystemAccess ?? talk.filesystemAccess;
    talk.networkAccess = networkAccess ?? talk.networkAccess;
    talk.toolsAllow = allow ?? talk.toolsAllow;
    talk.toolsDeny = deny ?? talk.toolsDeny;
    if (googleAuthProfile !== undefined) {
      talk.googleAuthProfile = googleAuthProfile || undefined;
    }
    talk.updatedAt = Date.now();
    talkManagerRef.current.saveTalk(activeTalkId);
  }, [activeTalkId]);

  const handleListTools = useCallback(() => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      const sysMsg = createMessage('system', 'No active gateway talk. Open a saved talk first.');
      chat.setMessages(prev => [...prev, sysMsg]);
      return;
    }
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) {
        const sysMsg = createMessage('system', 'Failed to load tool policy from gateway.');
        chat.setMessages(prev => [...prev, sysMsg]);
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      const availableNames = policy.availableTools.map((t) => t.name).join(', ') || '(none)';
      const enabledNames = policy.enabledTools.map((t) => t.name).join(', ') || '(none)';
      const allow = policy.toolsAllow.join(', ') || '(all)';
      const deny = policy.toolsDeny.join(', ') || '(none)';
      const sysMsg = createMessage(
        'system',
        `Tool policy:\n` +
        `  mode: ${policy.toolMode}\n` +
        `  executionMode: ${policy.executionMode ?? DEFAULT_EXECUTION_MODE}\n` +
        `  filesystemAccess: ${policy.filesystemAccess ?? 'full_host_access'}\n` +
        `  networkAccess: ${policy.networkAccess ?? 'full_outbound'}\n` +
        `  allow: ${allow}\n` +
        `  deny: ${deny}\n` +
        `  googleAuthProfile: ${policy.googleAuthProfile ?? '(inherit active profile)'}\n` +
        `  available: ${availableNames}\n` +
        `  enabled: ${enabledNames}`,
      );
      chat.setMessages(prev => [...prev, sysMsg]);
    });
  }, [syncToolPolicyLocal]);

  const handleSetToolsMode = useCallback((mode: ToolMode) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.updateGatewayTalkTools(gwId, { toolMode: mode }).then((policy) => {
      if (!policy) {
        setError('Failed to update tool mode on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      const sysMsg = createMessage('system', `Tool mode set to ${policy.toolMode}.`);
      chat.setMessages(prev => [...prev, sysMsg]);
    });
  }, [syncToolPolicyLocal]);

  const handleAddAllowedTool = useCallback((toolName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) return;
      const next = Array.from(new Set([...(policy.toolsAllow ?? []), toolName]));
      chatServiceRef.current?.updateGatewayTalkTools(gwId, { toolsAllow: next }).then((updated) => {
        if (!updated) { setError('Failed to update tool allow-list'); return; }
        syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
        chat.setMessages(prev => [...prev, createMessage('system', `Allowed tool added: ${toolName}`)]);
      });
    });
  }, [syncToolPolicyLocal]);

  const handleRemoveAllowedTool = useCallback((toolName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) return;
      const next = (policy.toolsAllow ?? []).filter((name) => name.toLowerCase() !== toolName.toLowerCase());
      chatServiceRef.current?.updateGatewayTalkTools(gwId, { toolsAllow: next }).then((updated) => {
        if (!updated) { setError('Failed to update tool allow-list'); return; }
        syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
        chat.setMessages(prev => [...prev, createMessage('system', `Allowed tool removed: ${toolName}`)]);
      });
    });
  }, [syncToolPolicyLocal]);

  const handleClearAllowedTools = useCallback(() => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.updateGatewayTalkTools(gwId, { toolsAllow: [] }).then((updated) => {
      if (!updated) { setError('Failed to clear tool allow-list'); return; }
      syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
      chat.setMessages(prev => [...prev, createMessage('system', 'Tool allow-list cleared (all tools allowed unless denied).')]);
    });
  }, [syncToolPolicyLocal]);

  const handleAddDeniedTool = useCallback((toolName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) return;
      const next = Array.from(new Set([...(policy.toolsDeny ?? []), toolName]));
      chatServiceRef.current?.updateGatewayTalkTools(gwId, { toolsDeny: next }).then((updated) => {
        if (!updated) { setError('Failed to update tool deny-list'); return; }
        syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
        chat.setMessages(prev => [...prev, createMessage('system', `Denied tool added: ${toolName}`)]);
      });
    });
  }, [syncToolPolicyLocal]);

  const handleRemoveDeniedTool = useCallback((toolName: string) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.getGatewayTalkTools(gwId).then((policy) => {
      if (!policy) return;
      const next = (policy.toolsDeny ?? []).filter((name) => name.toLowerCase() !== toolName.toLowerCase());
      chatServiceRef.current?.updateGatewayTalkTools(gwId, { toolsDeny: next }).then((updated) => {
        if (!updated) { setError('Failed to update tool deny-list'); return; }
        syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
        chat.setMessages(prev => [...prev, createMessage('system', `Denied tool removed: ${toolName}`)]);
      });
    });
  }, [syncToolPolicyLocal]);

  const handleClearDeniedTools = useCallback(() => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) return;
    chatServiceRef.current.updateGatewayTalkTools(gwId, { toolsDeny: [] }).then((updated) => {
      if (!updated) { setError('Failed to clear tool deny-list'); return; }
      syncToolPolicyLocal(updated.toolMode, updated.executionMode, updated.filesystemAccess, updated.networkAccess, updated.toolsAllow, updated.toolsDeny, updated.googleAuthProfile);
      chat.setMessages(prev => [...prev, createMessage('system', 'Tool deny-list cleared.')]);
    });
  }, [syncToolPolicyLocal]);

  const handleShowGoogleDocsAuthStatus = useCallback(() => {
    if (!chatServiceRef.current) return;
    chatServiceRef.current.getGoogleDocsAuthStatus().then((status) => {
      if (!status) {
        setError('Failed to fetch Google Docs auth status');
        return;
      }
      const sysMsg = createMessage(
        'system',
        `Google Docs auth:\n` +
        `  profile: ${status.profile ?? '(default)'}\n` +
        `  activeProfile: ${status.activeProfile ?? '(unknown)'}\n` +
        `  tokenPath: ${status.tokenPath}\n` +
        `  hasClientId: ${status.hasClientId}\n` +
        `  hasClientSecret: ${status.hasClientSecret}\n` +
        `  hasRefreshToken: ${status.hasRefreshToken}\n` +
        `  accessTokenReady: ${status.accessTokenReady}\n` +
        `  accountEmail: ${status.accountEmail ?? '(unknown)'}\n` +
        `  accountDisplayName: ${status.accountDisplayName ?? '(unknown)'}\n` +
        `  identityError: ${status.identityError ?? '(none)'}\n` +
        `  error: ${status.error ?? '(none)'}`,
      );
      chat.setMessages(prev => [...prev, sysMsg]);
    });
  }, []);

  const handleSetGoogleDocsRefreshToken = useCallback((token: string) => {
    if (!chatServiceRef.current) return;
    chatServiceRef.current.updateGoogleDocsAuthConfig({ refreshToken: token }).then((status) => {
      if (!status) {
        setError('Failed to update Google Docs refresh token');
        return;
      }
      const sysMsg = createMessage(
        'system',
        `Google Docs refresh token updated.\n` +
        `  accessTokenReady: ${status.accessTokenReady}\n` +
        `  error: ${status.error ?? '(none)'}`,
      );
      chat.setMessages(prev => [...prev, sysMsg]);
    });
  }, []);

  const refreshSettingsToolPolicy = useCallback(() => {
    const talk = activeTalkIdRef.current ? talkManagerRef.current?.getTalk(activeTalkIdRef.current) : null;
    const gwId = gatewayTalkIdRef.current ?? talk?.gatewayTalkId ?? null;

    if (!chatServiceRef.current) {
      const mode: ToolMode = talk?.toolMode ?? 'auto';
      const executionMode: ToolExecutionMode = talk?.executionMode ?? DEFAULT_EXECUTION_MODE;
      setSettingsToolPolicy({
        mode,
        executionMode,
        executionModeOptions: DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: talk?.filesystemAccess ?? 'full_host_access',
        networkAccess: talk?.networkAccess ?? 'full_outbound',
        effectiveTools: [],
        availableTools: [],
        enabledToolNames: talk?.toolsAllow ?? [],
        catalogEntries: [],
        installedToolNames: [],
        talkGoogleAuthProfile: talk?.googleAuthProfile,
        googleAuthActiveProfile: undefined,
        googleAuthProfiles: [],
        googleAuthStatus: undefined,
      });
      setSettingsToolPolicyError('Gateway unavailable.');
      return;
    }

    setSettingsToolPolicyLoading(true);
    setSettingsToolPolicyError(null);
    if (!gwId) {
      Promise.all([
        chatServiceRef.current.getGatewayToolCatalog(),
        chatServiceRef.current.getGoogleDocsAuthProfiles(),
        chatServiceRef.current.getGoogleDocsAuthStatus(),
      ]).then(([catalog, profiles, authStatus]) => {
        const enrichedProfiles = mergeGoogleAuthProfiles(profiles?.profiles, authStatus);
        const mode: ToolMode = talk?.toolMode ?? 'auto';
        const executionMode: ToolExecutionMode = talk?.executionMode ?? DEFAULT_EXECUTION_MODE;
        setSettingsToolPolicy({
          mode,
          executionMode,
          executionModeOptions: DEFAULT_EXECUTION_MODE_OPTIONS,
          filesystemAccess: talk?.filesystemAccess ?? 'full_host_access',
          networkAccess: talk?.networkAccess ?? 'full_outbound',
          effectiveTools: [],
          availableTools: [],
          enabledToolNames: talk?.toolsAllow ?? [],
          catalogEntries: catalog?.catalog ?? [],
          installedToolNames: catalog?.installedTools.map((tool) => tool.name) ?? [],
          talkGoogleAuthProfile: talk?.googleAuthProfile,
          googleAuthActiveProfile: profiles?.activeProfile,
          googleAuthProfiles: enrichedProfiles,
          googleAuthStatus: authStatus ?? undefined,
        });
        setSettingsToolPolicyError(
          catalog
            ? 'No active gateway talk yet. Send one message first to configure talk-level tool policy.'
            : 'Failed to load tool catalog from gateway.',
        );
      }).finally(() => {
        setSettingsToolPolicyLoading(false);
      });
      return;
    }

    Promise.all([
      chatServiceRef.current.getGatewayTalkTools(gwId),
      chatServiceRef.current.getGatewayToolCatalog(),
      chatServiceRef.current.getGoogleDocsAuthProfiles(),
      chatServiceRef.current.getGoogleDocsAuthStatus(),
    ]).then(([policy, catalog, profiles, authStatus]) => {
      if (!policy) {
        setSettingsToolPolicyError('Failed to load talk tool policy from gateway.');
        return;
      }
      const enrichedProfiles = mergeGoogleAuthProfiles(profiles?.profiles, authStatus);
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy({
        mode: policy.toolMode,
        executionMode: policy.executionMode ?? talk?.executionMode ?? DEFAULT_EXECUTION_MODE,
        executionModeOptions: policy.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: policy.filesystemAccess ?? talk?.filesystemAccess ?? 'full_host_access',
        networkAccess: policy.networkAccess ?? talk?.networkAccess ?? 'full_outbound',
        effectiveTools: policy.effectiveTools ?? policy.availableTools,
        availableTools: policy.availableTools,
        enabledToolNames: policy.enabledTools.map((tool) => tool.name),
        catalogEntries: catalog?.catalog ?? [],
        installedToolNames: catalog?.installedTools.map((tool) => tool.name) ?? [],
        talkGoogleAuthProfile: policy.googleAuthProfile,
        googleAuthActiveProfile: profiles?.activeProfile,
        googleAuthProfiles: enrichedProfiles,
        googleAuthStatus: authStatus ?? undefined,
      });
      if (!catalog) {
        setSettingsToolPolicyError('Talk policy loaded, but tool catalog could not be loaded.');
      }
    }).finally(() => {
      setSettingsToolPolicyLoading(false);
    });
  }, [syncToolPolicyLocal]);

  const handleSettingsSetToolMode = useCallback((mode: ToolMode) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy((prev) => prev ? { ...prev, mode } : prev);
      syncToolPolicyLocal(mode, undefined, undefined, undefined, undefined, undefined);
      return;
    }
    chatServiceRef.current.updateGatewayTalkTools(gwId, { toolMode: mode }).then((policy) => {
      if (!policy) {
        setError('Failed to update tool mode on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => ({
        mode: policy.toolMode,
        executionMode: policy.executionMode ?? prev?.executionMode ?? DEFAULT_EXECUTION_MODE,
        executionModeOptions: policy.executionModeOptions ?? prev?.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: policy.filesystemAccess ?? prev?.filesystemAccess ?? 'full_host_access',
        networkAccess: policy.networkAccess ?? prev?.networkAccess ?? 'full_outbound',
        effectiveTools: policy.effectiveTools ?? policy.availableTools,
        availableTools: policy.availableTools,
        enabledToolNames: policy.enabledTools.map((tool) => tool.name),
        catalogEntries: prev?.catalogEntries ?? [],
        installedToolNames: prev?.installedToolNames ?? [],
        talkGoogleAuthProfile: policy.googleAuthProfile,
        googleAuthActiveProfile: prev?.googleAuthActiveProfile,
        googleAuthProfiles: prev?.googleAuthProfiles ?? [],
        googleAuthStatus: prev?.googleAuthStatus,
      }));
    });
  }, [syncToolPolicyLocal]);

  const handleSettingsSetExecutionMode = useCallback((executionMode: ToolExecutionMode) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy((prev) => prev ? { ...prev, executionMode } : prev);
      syncToolPolicyLocal(undefined, executionMode, undefined, undefined, undefined, undefined);
      return;
    }
    chatServiceRef.current.updateGatewayTalkTools(gwId, { executionMode }).then((policy) => {
      if (!policy) {
        setError('Failed to update execution mode on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => ({
        mode: policy.toolMode,
        executionMode: policy.executionMode ?? prev?.executionMode ?? DEFAULT_EXECUTION_MODE,
        executionModeOptions: policy.executionModeOptions ?? prev?.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: policy.filesystemAccess ?? prev?.filesystemAccess ?? 'full_host_access',
        networkAccess: policy.networkAccess ?? prev?.networkAccess ?? 'full_outbound',
        effectiveTools: policy.effectiveTools ?? policy.availableTools,
        availableTools: policy.availableTools,
        enabledToolNames: policy.enabledTools.map((tool) => tool.name),
        catalogEntries: prev?.catalogEntries ?? [],
        installedToolNames: prev?.installedToolNames ?? [],
        talkGoogleAuthProfile: policy.googleAuthProfile,
        googleAuthActiveProfile: prev?.googleAuthActiveProfile,
        googleAuthProfiles: prev?.googleAuthProfiles ?? [],
        googleAuthStatus: prev?.googleAuthStatus,
      }));
    });
  }, [syncToolPolicyLocal]);

  const handleSettingsSetFilesystemAccess = useCallback((filesystemAccess: ToolFilesystemAccess) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy((prev) => prev ? { ...prev, filesystemAccess } : prev);
      syncToolPolicyLocal(undefined, undefined, filesystemAccess, undefined, undefined, undefined);
      return;
    }
    chatServiceRef.current.updateGatewayTalkTools(gwId, { filesystemAccess }).then((policy) => {
      if (!policy) {
        setError('Failed to update filesystem access on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => ({
        mode: policy.toolMode,
        executionMode: policy.executionMode ?? prev?.executionMode ?? DEFAULT_EXECUTION_MODE,
        executionModeOptions: policy.executionModeOptions ?? prev?.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: policy.filesystemAccess ?? prev?.filesystemAccess ?? 'full_host_access',
        networkAccess: policy.networkAccess ?? prev?.networkAccess ?? 'full_outbound',
        effectiveTools: policy.effectiveTools ?? policy.availableTools,
        availableTools: policy.availableTools,
        enabledToolNames: policy.enabledTools.map((tool) => tool.name),
        catalogEntries: prev?.catalogEntries ?? [],
        installedToolNames: prev?.installedToolNames ?? [],
        talkGoogleAuthProfile: policy.googleAuthProfile,
        googleAuthActiveProfile: prev?.googleAuthActiveProfile,
        googleAuthProfiles: prev?.googleAuthProfiles ?? [],
        googleAuthStatus: prev?.googleAuthStatus,
      }));
    });
  }, [syncToolPolicyLocal]);

  const handleSettingsSetNetworkAccess = useCallback((networkAccess: ToolNetworkAccess) => {
    const gwId = gatewayTalkIdRef.current;
    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy((prev) => prev ? { ...prev, networkAccess } : prev);
      syncToolPolicyLocal(undefined, undefined, undefined, networkAccess, undefined, undefined);
      return;
    }
    chatServiceRef.current.updateGatewayTalkTools(gwId, { networkAccess }).then((policy) => {
      if (!policy) {
        setError('Failed to update network access on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => ({
        mode: policy.toolMode,
        executionMode: policy.executionMode ?? prev?.executionMode ?? DEFAULT_EXECUTION_MODE,
        executionModeOptions: policy.executionModeOptions ?? prev?.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: policy.filesystemAccess ?? prev?.filesystemAccess ?? 'full_host_access',
        networkAccess: policy.networkAccess ?? prev?.networkAccess ?? 'full_outbound',
        effectiveTools: policy.effectiveTools ?? policy.availableTools,
        availableTools: policy.availableTools,
        enabledToolNames: policy.enabledTools.map((tool) => tool.name),
        catalogEntries: prev?.catalogEntries ?? [],
        installedToolNames: prev?.installedToolNames ?? [],
        talkGoogleAuthProfile: policy.googleAuthProfile,
        googleAuthActiveProfile: prev?.googleAuthActiveProfile,
        googleAuthProfiles: prev?.googleAuthProfiles ?? [],
        googleAuthStatus: prev?.googleAuthStatus,
      }));
    });
  }, [syncToolPolicyLocal]);

  const handleSettingsSetToolEnabled = useCallback((toolName: string, enabled: boolean) => {
    const gwId = gatewayTalkIdRef.current;
    const current = settingsToolPolicy;
    if (!current) return;
    const currentSet = new Set(current.enabledToolNames);
    if (enabled) currentSet.add(toolName);
    else currentSet.delete(toolName);
    const nextEnabled = Array.from(currentSet);

    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy({ ...current, enabledToolNames: nextEnabled });
      syncToolPolicyLocal(undefined, undefined, undefined, undefined, nextEnabled, []);
      return;
    }

    chatServiceRef.current.updateGatewayTalkTools(gwId, {
      toolsAllow: nextEnabled,
      toolsDeny: [],
    }).then((policy) => {
      if (!policy) {
        setError('Failed to update enabled tools on gateway');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => ({
        mode: policy.toolMode,
        executionMode: policy.executionMode ?? prev?.executionMode ?? DEFAULT_EXECUTION_MODE,
        executionModeOptions: policy.executionModeOptions ?? prev?.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: policy.filesystemAccess ?? prev?.filesystemAccess ?? 'full_host_access',
        networkAccess: policy.networkAccess ?? prev?.networkAccess ?? 'full_outbound',
        effectiveTools: policy.effectiveTools ?? policy.availableTools,
        availableTools: policy.availableTools,
        enabledToolNames: policy.enabledTools.map((tool) => tool.name),
        catalogEntries: prev?.catalogEntries ?? [],
        installedToolNames: prev?.installedToolNames ?? [],
        talkGoogleAuthProfile: policy.googleAuthProfile,
        googleAuthActiveProfile: prev?.googleAuthActiveProfile,
        googleAuthProfiles: prev?.googleAuthProfiles ?? [],
        googleAuthStatus: prev?.googleAuthStatus,
      }));
    });
  }, [settingsToolPolicy, syncToolPolicyLocal]);

  const handleSettingsSetTalkGoogleAuthProfile = useCallback((profile: string | undefined) => {
    const gwId = gatewayTalkIdRef.current;
    const current = settingsToolPolicy;
    if (!current) return;

    if (!gwId || !chatServiceRef.current) {
      setSettingsToolPolicy({ ...current, talkGoogleAuthProfile: profile });
      syncToolPolicyLocal(undefined, undefined, undefined, undefined, undefined, undefined, profile ?? '');
      return;
    }

    chatServiceRef.current.updateGatewayTalkTools(gwId, {
      googleAuthProfile: profile ?? '',
    }).then((policy) => {
      if (!policy) {
        setError('Failed to update Google auth profile for this talk');
        return;
      }
      syncToolPolicyLocal(policy.toolMode, policy.executionMode, policy.filesystemAccess, policy.networkAccess, policy.toolsAllow, policy.toolsDeny, policy.googleAuthProfile);
      setSettingsToolPolicy((prev) => ({
        mode: policy.toolMode,
        executionMode: policy.executionMode ?? prev?.executionMode ?? DEFAULT_EXECUTION_MODE,
        executionModeOptions: policy.executionModeOptions ?? prev?.executionModeOptions ?? DEFAULT_EXECUTION_MODE_OPTIONS,
        filesystemAccess: policy.filesystemAccess ?? prev?.filesystemAccess ?? 'full_host_access',
        networkAccess: policy.networkAccess ?? prev?.networkAccess ?? 'full_outbound',
        effectiveTools: policy.effectiveTools ?? policy.availableTools,
        availableTools: policy.availableTools,
        enabledToolNames: policy.enabledTools.map((tool) => tool.name),
        catalogEntries: prev?.catalogEntries ?? [],
        installedToolNames: prev?.installedToolNames ?? [],
        talkGoogleAuthProfile: policy.googleAuthProfile,
        googleAuthActiveProfile: prev?.googleAuthActiveProfile,
        googleAuthProfiles: prev?.googleAuthProfiles ?? [],
        googleAuthStatus: prev?.googleAuthStatus,
      }));
    });
  }, [settingsToolPolicy, syncToolPolicyLocal]);

  const handleSettingsStartGoogleOAuthConnect = useCallback(() => {
    if (!chatServiceRef.current) {
      setError('Gateway unavailable.');
      return;
    }
    const requestedProfile = settingsToolPolicy?.talkGoogleAuthProfile;
    chatServiceRef.current.startGoogleOAuthConnect(requestedProfile).then((started) => {
      if (!started) {
        setError('Failed to start Google OAuth flow.');
        return;
      }
      const sysMsg = createMessage(
        'system',
        `Google OAuth started.\nOpen this URL in your browser:\n${started.authUrl}\n\nAfter approval, ClawTalk will auto-refresh tools.`,
      );
      chat.setMessages((prev) => [...prev, sysMsg]);

      googleOAuthSessionRef.current = started.sessionId;
      if (googleOAuthPollRef.current) {
        clearInterval(googleOAuthPollRef.current);
        googleOAuthPollRef.current = null;
      }
      googleOAuthPollRef.current = setInterval(() => {
        const sessionId = googleOAuthSessionRef.current;
        if (!sessionId || !chatServiceRef.current) return;
        chatServiceRef.current.getGoogleOAuthConnectStatus(sessionId).then((status) => {
          if (!status?.found || status.status === 'pending') return;
          if (googleOAuthPollRef.current) {
            clearInterval(googleOAuthPollRef.current);
            googleOAuthPollRef.current = null;
          }
          googleOAuthSessionRef.current = null;
          if (status.status === 'success') {
            const okMsg = createMessage(
              'system',
              `Google OAuth connected.\nProfile: ${status.profile ?? '(unknown)'}\nAccount: ${status.accountEmail ?? '(unknown)'}`,
            );
            chat.setMessages((prev) => [...prev, okMsg]);
            refreshSettingsToolPolicy();
            return;
          }
          const failMsg = createMessage('system', `Google OAuth failed: ${status.error ?? 'Unknown error'}`);
          chat.setMessages((prev) => [...prev, failMsg]);
        });
      }, 2000);
    });
  }, [chat, refreshSettingsToolPolicy, settingsToolPolicy?.talkGoogleAuthProfile]);

  const handleSettingsCatalogInstall = useCallback((catalogId: string) => {
    if (!chatServiceRef.current) return;
    chatServiceRef.current.installGatewayCatalogTool(catalogId).then((result) => {
      if (!result?.ok) {
        setError(`Failed to install catalog tool "${catalogId}"`);
        return;
      }
      if (result.authSetupRecommended) {
        const authMessages = result.auth?.requirements
          ?.filter((req) => !req.ready)
          .map((req) => `- ${req.id}: ${req.message ?? 'auth setup required'}`)
          .join('\n');
        const msg = createMessage(
          'system',
          `Installed "${catalogId}", but auth setup is required before use.\n`
          + `${authMessages || '- Missing auth configuration'}\n`
          + `Use: /tools auth status\n`
          + `Then configure with: /tools auth set-refresh <google-refresh-token>`,
        );
        chat.setMessages((prev) => [...prev, msg]);
      }
      refreshSettingsToolPolicy();
    });
  }, [chat, refreshSettingsToolPolicy]);

  const handleSettingsCatalogUninstall = useCallback((catalogId: string) => {
    if (!chatServiceRef.current) return;
    chatServiceRef.current.uninstallGatewayCatalogTool(catalogId).then((ok) => {
      if (!ok) {
        setError(`Failed to uninstall catalog tool "${catalogId}"`);
        return;
      }
      refreshSettingsToolPolicy();
    });
  }, [refreshSettingsToolPolicy]);

  const loadSlackHints = useCallback(async () => {
    if (!chatServiceRef.current) return;

    setSlackHintsLoading(true);
    setSlackHintsError(null);

    try {
      const base = await chatServiceRef.current.getSlackOptions(undefined, 1000);
      if (!base) {
        setSlackAccountHints([]);
        setSlackChannelsByAccount({});
        setSlackHintsError('Slack discovery unavailable on this gateway.');
        return;
      }

      const normalizedAccounts = base.accounts.length > 0
        ? base.accounts
        : [{
            id: base.selectedAccountId ?? 'default',
            isDefault: true,
            hasBotToken: false,
          }];
      const channelsByAccount: Record<string, SlackChannelOption[]> = {};
      if (base.selectedAccountId) {
        channelsByAccount[base.selectedAccountId] = base.channels;
      }

      await Promise.all(
        normalizedAccounts
          .filter((account) => account.hasBotToken && account.id !== base.selectedAccountId)
          .map(async (account) => {
            const result = await chatServiceRef.current?.getSlackOptions(account.id, 1000);
            channelsByAccount[account.id] = result?.channels ?? [];
          }),
      );

      setSlackAccountHints(normalizedAccounts);
      setSlackChannelsByAccount(channelsByAccount);
    } catch (err) {
      console.debug('loadSlackHints failed:', err);
      setSlackAccountHints([]);
      setSlackChannelsByAccount({});
      setSlackHintsError('Failed to load Slack discovery data.');
    } finally {
      setSlackHintsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showChannelConfig) return;
    void loadSlackHints();
  }, [showChannelConfig, loadSlackHints]);

  // --- Playbook handler ---

  const handleShowPlaybook = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const talk = talkManagerRef.current.getTalk(activeTalkId);
    if (!talk) return;

    const sections: string[] = ['=== Playbook ==='];

    // Objectives
    if (talk.objective) {
      sections.push(`\nObjectives:\n  ${talk.objective}`);
    } else {
      sections.push('\nObjectives: (none)');
    }

    // Rules
    const directives = talk.directives ?? [];
    if (directives.length > 0) {
      const lines = directives.map((d, i) => {
        const status = d.active ? 'active' : 'paused';
        return `  ${i + 1}. [${status}] ${d.text}`;
      });
      sections.push(`\nRules:\n${lines.join('\n')}`);
    } else {
      sections.push('\nRules: (none)');
    }

    // Channel connections
    const bindings = talk.platformBindings ?? [];
    if (bindings.length > 0) {
      const lines = bindings.map((b, i) =>
        `  ${i + 1}. platform${i + 1}: ${b.platform} ${formatBindingScopeLabel(b)} (${b.permission})`
      );
      sections.push(`\nChannel connections:\n${lines.join('\n')}`);
    } else {
      sections.push('\nChannel connections: (none)');
    }

    // Channel response settings
    const behaviors = talk.platformBehaviors ?? [];
    if (bindings.length > 0) {
      const lines = bindings.map((binding, i) => {
        const behavior = behaviors.find((entry) => entry.platformBindingId === binding.id);
        const mode = behavior?.responseMode ?? (behavior?.autoRespond === false ? 'off' : 'all');
        const posting = formatPostingPriority(behavior?.deliveryMode);
        const mirror = behavior?.mirrorToTalk ?? 'off';
        const agent = behavior?.agentName ?? '(default)';
        const promptLines = (behavior?.onMessagePrompt?.trim() ? behavior.onMessagePrompt : '(none)')
          .split('\n')
          .map((line) => `      ${line || ' '}`)
          .join('\n');
        return `  ${i + 1}. mode:${mode}  posting:${posting}  mirror:${mirror}  agent:${agent}\n` +
          `    response_prompt:\n${promptLines}`;
      });
      sections.push(`\nChannel response settings:\n${lines.join('\n')}`);
    } else {
      sections.push('\nChannel response settings: (none)');
    }

    // Automations
    const jobs = talk.jobs ?? [];
    if (jobs.length > 0) {
      const lines = jobs.map((j, i) => {
        const status = j.active ? 'active' : 'paused';
        const promptLines = (j.prompt?.trim() ? j.prompt : '(none)')
          .split('\n')
          .map((line) => `      ${line || ' '}`)
          .join('\n');
        return `  ${i + 1}. [${status}] "${j.schedule}"\n` +
          `    prompt:\n${promptLines}`;
      });
      sections.push(`\nAutomations:\n${lines.join('\n')}`);
    } else {
      sections.push('\nAutomations: (none)');
    }

    // Agents
    const agents = talk.agents ?? [];
    if (agents.length > 0) {
      const lines = agents.map(a => {
        const primary = a.isPrimary ? ' (primary)' : '';
        return `  - ${a.name} [${a.role}] ${a.model}${primary}`;
      });
      sections.push(`\nAgents:\n${lines.join('\n')}`);
    } else {
      sections.push('\nAgents: (none)');
    }

    const sysMsg = createMessage('system', sections.join('\n'));
    chat.setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId]);

  const handleConfirmDeleteMessages = useCallback(async (messageIds: string[]) => {
    const sessionId = sessionManagerRef.current?.getActiveSessionId();
    const gwTalkId = gatewayTalkIdRef.current;

    // Gateway-backed talks: delete remotely, then refresh from gateway source-of-truth.
    if (gwTalkId && chatServiceRef.current) {
      const result = await chatServiceRef.current.deleteGatewayMessages(gwTalkId, messageIds);
      if (!result) {
        setError('Failed to delete messages on gateway.');
        return;
      }
      const latest = await chatServiceRef.current.fetchGatewayMessages(gwTalkId);
      chat.setMessages(latest);
      // Keep local session in sync when one exists.
      if (sessionId) {
        sessionManagerRef.current?.deleteMessages(sessionId, messageIds);
      }
      chat.setMessages((prev) => [
        ...prev,
        createMessage('system', `Deleted ${result.deleted} message${result.deleted !== 1 ? 's' : ''}.`),
      ]);
      setShowEditMessages(false);
      return;
    }

    if (!sessionId) return;
    sessionManagerRef.current?.deleteMessages(sessionId, messageIds);
    const session = sessionManagerRef.current?.getSession(sessionId);
    if (session) {
      chat.setMessages([...session.messages]);
    }
    chat.setMessages((prev) => [
      ...prev,
      createMessage('system', `Deleted ${messageIds.length} message${messageIds.length !== 1 ? 's' : ''}.`),
    ]);
    setShowEditMessages(false);
  }, [chat.setMessages, setError]);

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
          objectives: gwTalk.objectives,
          model: gwTalk.model,
          pinnedMessageIds: gwTalk.pinnedMessageIds,
          jobs: gwTalk.jobs,
          agents: gwTalk.agents,
          directives: gwTalk.directives,
          rules: gwTalk.rules,
          platformBindings: gwTalk.platformBindings,
          channelConnections: gwTalk.channelConnections,
          platformBehaviors: gwTalk.platformBehaviors,
          channelResponseSettings: gwTalk.channelResponseSettings,
          toolMode: gwTalk.toolMode,
          executionMode: gwTalk.executionMode,
          filesystemAccess: gwTalk.filesystemAccess,
          networkAccess: gwTalk.networkAccess,
          toolsAllow: gwTalk.toolsAllow,
          toolsDeny: gwTalk.toolsDeny,
          googleAuthProfile: gwTalk.googleAuthProfile,
          processing: gwTalk.processing,
          createdAt: gwTalk.createdAt,
          updatedAt: gwTalk.updatedAt,
        });
      }
    });
  }, [showTalks]);

  // Poll gateway when remoteProcessing is active — auto-fetch completed response
  useEffect(() => {
    if (!remoteProcessing || !activeTalkId || !gatewayTalkIdRef.current || !chatServiceRef.current) return;
    const gwId = gatewayTalkIdRef.current;
    const talkId = activeTalkId;
    const timer = setInterval(() => {
      if (!chatServiceRef.current) return;
      chatServiceRef.current.getGatewayTalk(gwId).then(gwTalk => {
        if (!gwTalk || activeTalkIdRef.current !== talkId) return;
        if (!gwTalk.processing) {
          setRemoteProcessing(false);
          // Fetch updated messages
          chatServiceRef.current?.fetchGatewayMessages(gwId).then(msgs => {
            if (msgs.length > 0 && activeTalkIdRef.current === talkId) {
              chat.setMessages(msgs);
            }
          });
        }
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [remoteProcessing, activeTalkId]);

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

      // Sync model to chat service and gateway (gateway may have been restarted
      // or have a different active model since the previous talk set it)
      chatServiceRef.current?.setModel(currentModel);
      modelOverrideAbortRef.current?.abort();
      const controller = new AbortController();
      modelOverrideAbortRef.current = controller;
      chatServiceRef.current?.setModelOverride(currentModel, controller.signal).catch(() => {});

      chat.clearStreaming();
      setStreamingAgentName(undefined);
      chat.setMessages([]);
      setPendingFiles([]);
      setFileIndicatorSelected(false);
      setRemoteProcessing(false);
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
    setStreamingAgentName(undefined);
    chat.setMessages(session?.messages ?? []);
    setSessionName(session?.name ?? talk.topicTitle ?? 'Talk');
    setActiveTalkId(talk.id);
    setPendingAttachment(null);
    setPendingFiles([]);
    setFileIndicatorSelected(false);
    talkManagerRef.current?.setActiveTalk(talk.id);
    talkManagerRef.current?.touchTalk(talk.id);
    talkManagerRef.current?.markRead(talk.id);
    setRemoteProcessing(talk.processing === true);
    mouseScroll.scrollToBottom();

    // Set primary agent ref synchronously (don't wait for useEffect)
    const localAgentsOnSelect = talkManagerRef.current?.getAgents(talk.id) ?? [];
    primaryAgentRef.current = localAgentsOnSelect.find(a => a.isPrimary) ?? null;

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
      // Recover agents from gateway if local agents were lost
      const localAgents = talkManagerRef.current?.getAgents(talk.id) ?? [];
      if (localAgents.length === 0) {
        chatServiceRef.current?.getGatewayTalk(gwId).then(gwTalk => {
          if (!gwTalk?.agents?.length || activeTalkIdRef.current !== talk.id) return;
          talkManagerRef.current?.setAgents(talk.id, gwTalk.agents!);
          syncAgentsToGateway(gwTalk.agents!);
        });
      }
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
  }, [activeTalkId, chat.messages, syncAgentsToGateway]);

  /** Ensure a gateway talk exists before sending messages, so all turns use talk-scoped context. */
  const ensureGatewayTalk = useCallback(async (): Promise<string | null> => {
    if (gatewayTalkIdRef.current) return gatewayTalkIdRef.current;
    if (!chatServiceRef.current) {
      setError('Chat service unavailable');
      return null;
    }
    if (creatingGatewayTalkRef.current) {
      return creatingGatewayTalkRef.current;
    }

    creatingGatewayTalkRef.current = (async () => {
      if (activeTalkIdRef.current) {
        talkManagerRef.current?.saveTalk(activeTalkIdRef.current);
      }

      const result = await chatServiceRef.current!.createGatewayTalk(currentModelRef.current);
      if (!result.ok || !result.data) {
        setError(`Failed to create gateway talk: ${result.error ?? 'Unknown error'}`);
        return null;
      }

      gatewayTalkIdRef.current = result.data;
      if (activeTalkIdRef.current) {
        talkManagerRef.current?.setGatewayTalkId(activeTalkIdRef.current, result.data);
      }
      return result.data;
    })();

    try {
      return await creatingGatewayTalkRef.current;
    } finally {
      creatingGatewayTalkRef.current = null;
    }
  }, []);

  // --- Multi-agent messaging ---

  /** Stream a single agent's response. Returns the full content or empty string on error. */
  const streamAgentResponse = useCallback(async (
    gwTalkId: string,
    message: string,
    agent: TalkAgent,
    allAgents: TalkAgent[],
    retryAttempt = 0,
  ): Promise<string> => {
    const roleTemplate = ROLE_BY_ID[agent.role];
    if (!roleTemplate) return '';

    // Guard against talk switches — compare the gateway talk ID we were
    // started with against the currently active one. If the user navigated
    // away, skip all UI mutations to prevent cross-talk contamination.
    const isStillOnSameTalk = () => gatewayTalkIdRef.current === gwTalkId;

    if (!isStillOnSameTalk()) return '';

    setStreamingAgentName(agent.name);
    const indicatorMsg = createMessage('system', `${agent.name} is responding...`);
    if (retryAttempt === 0) {
      chat.setMessages(prev => [...prev, indicatorMsg]);
    }

    try {
      let fullContent = '';
      const isRecovery = retryAttempt > 0;
      const stream = chatServiceRef.current!.streamAgentMessage(
        gwTalkId,
        message,
        { name: agent.name, model: agent.model, role: agent.role },
        allAgents.map(a => ({ name: a.name, role: a.role, model: a.model })),
        AGENT_PREAMBLE + roleTemplate.instructions,
        isRecovery,
      );

      for await (const chunk of stream) {
        if (!isStillOnSameTalk()) return fullContent; // user navigated away
        if (chunk.type === 'content') {
          fullContent += chunk.text;
        } else if (chunk.type === 'tool_start') {
          const toolMsg = createMessage('system', `[${agent.name} → Tool] ${chunk.name}(${chunk.arguments.slice(0, 80)}${chunk.arguments.length > 80 ? '...' : ''})`);
          chat.setMessages(prev => [...prev, toolMsg]);
        } else if (chunk.type === 'tool_end') {
          const status = chunk.success ? 'OK' : 'ERROR';
          const preview = chunk.content.slice(0, 150) + (chunk.content.length > 150 ? '...' : '');
          const toolMsg = createMessage('system', `[${agent.name} → Tool ${status}] ${chunk.name} (${chunk.durationMs}ms): ${preview}`);
          chat.setMessages(prev => [...prev, toolMsg]);
        } else if (chunk.type === 'status') {
          const prefix = chunk.level === 'warn' || chunk.level === 'error' ? 'Status' : 'Info';
          const statusMsg = createMessage('system', `[${agent.name} → ${prefix}] ${chunk.message}`);
          chat.setMessages(prev => [...prev, statusMsg]);
        }
      }

      if (!isStillOnSameTalk()) return fullContent;

      if (fullContent.trim()) {
        const model = chatServiceRef.current!.lastResponseModel ?? agent.model;
        const assistantMsg = createMessage('assistant', fullContent, model, agent.name, agent.role);
        chat.setMessages(prev => {
          const filtered = prev.filter(m => m.id !== indicatorMsg.id);
          return [...filtered, assistantMsg];
        });
      } else {
        chat.setMessages(prev => prev.filter(m => m.id !== indicatorMsg.id));
      }
      return fullContent;
    } catch (err) {
      if (!isStillOnSameTalk()) return '';

      // --- Retry on transient errors (max 1 retry) ---
      const { isTransientError, GatewayStreamError } = await import('../services/chat.js');
      if (retryAttempt === 0 && isTransientError(err)) {
        const partialContent = err instanceof GatewayStreamError ? err.partialContent : '';

        if (!isStillOnSameTalk()) return '';

        // Update indicator to show retry
        const retryIndicator = createMessage('system', `${agent.name}: retrying...`);
        chat.setMessages(prev => {
          const filtered = prev.filter(m => m.id !== indicatorMsg.id);
          return [...filtered, retryIndicator];
        });

        // Build recovery message — the gateway has conversation history,
        // so the LLM has full context of what was said before.
        const recoveryMsg = partialContent
          ? 'Your previous response was interrupted. Continue from where you left off.'
          : message;

        const retryContent = await streamAgentResponse(gwTalkId, recoveryMsg, agent, allAgents, 1);

        if (!isStillOnSameTalk()) return partialContent + retryContent;

        // Remove retry indicator
        chat.setMessages(prev => prev.filter(m => m.id !== retryIndicator.id));

        // Combine partial + retry content
        const combined = (partialContent + retryContent).trim();
        if (combined) {
          const model = chatServiceRef.current!.lastResponseModel ?? agent.model;
          const assistantMsg = createMessage('assistant', combined, model, agent.name, agent.role);
          chat.setMessages(prev => {
            const filtered = prev.filter(m => m.id !== indicatorMsg.id);
            return [...filtered, assistantMsg];
          });
        }
        return partialContent + retryContent;
      }

      const rawMessage = err instanceof Error ? err.message : 'Unknown error';
      // Map low-level errors to user-friendly messages
      let errorMessage = rawMessage;
      let errorHint: string | undefined;
      if (err instanceof GatewayStreamError) {
        if (err.code === 'MODE_BLOCKED_BROWSER') {
          errorMessage = 'Browser control blocked by current execution mode';
          errorHint = err.hint;
        } else if (err.code === 'FIRST_TOKEN_TIMEOUT') {
          errorMessage = 'Request timed out waiting for first model token';
          errorHint = err.hint;
        } else if (err.hint) {
          errorHint = err.hint;
        }
      }
      if (/\bterminated\b|aborted|abort/i.test(rawMessage)) {
        errorMessage = 'Request was interrupted';
      } else if (/fetch failed|network error|connection refused|econnrefused/i.test(rawMessage)) {
        errorMessage = 'Connection failed';
      } else if (/timeout/i.test(rawMessage)) {
        errorMessage = 'Request timed out';
      }
      const errMsg = createMessage('system', `${agent.name} error: ${errorMessage}${errorHint ? `\nHint: ${errorHint}` : ''}`);
      chat.setMessages(prev => {
        const filtered = prev.filter(m => m.id !== indicatorMsg.id);
        return [...filtered, errMsg];
      });
      return '';
    }
  }, []);

  /** Find agents mentioned in a response by name or model alias. */
  const findMentionedAgents = useCallback((
    responseText: string,
    respondedAgents: Set<string>,
    allAgents: TalkAgent[],
  ): TalkAgent[] => {
    const mentioned: TalkAgent[] = [];
    const textLower = responseText.toLowerCase();

    for (const agent of allAgents) {
      if (respondedAgents.has(agent.name)) continue;

      // Check for agent name (e.g. "Opus Strategist") or model alias (e.g. "Opus")
      const alias = getModelAlias(agent.model).toLowerCase();
      const nameLower = agent.name.toLowerCase();

      // Use word boundary check to avoid false positives
      const aliasPattern = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (aliasPattern.test(responseText) || textLower.includes(nameLower)) {
        mentioned.push(agent);
      }
    }
    return mentioned;
  }, []);

  const sendMultiAgentMessage = useCallback(async (text: string, targetAgents: TalkAgent[], allAgents: TalkAgent[]) => {
    const gwTalkId = gatewayTalkIdRef.current;
    if (!gwTalkId || !chatServiceRef.current) {
      setError('Multi-agent requires a gateway-synced talk');
      return;
    }

    const isStillOnSameTalk = () => gatewayTalkIdRef.current === gwTalkId;

    // Add user message
    const userMsg = createMessage('user', text);
    chat.setMessages(prev => [...prev, userMsg]);
    mouseScroll.scrollToBottom();

    // Track which agents have responded (to avoid duplicates and enable follow-up)
    const respondedAgents = new Set<string>();
    const allResponses: Array<{ agentName: string; content: string }> = [];

    for (const agent of targetAgents) {
      if (!isStillOnSameTalk()) break; // user navigated away
      const content = await streamAgentResponse(gwTalkId, text, agent, allAgents);
      respondedAgents.add(agent.name);
      if (content.trim()) allResponses.push({ agentName: agent.name, content });
    }

    if (!isStillOnSameTalk()) return;

    // Follow-up round: if any response mentions agents that haven't responded,
    // give them a chance to reply (capped at 1 extra round to prevent loops)
    const mentionersByTarget = new Map<string, Set<string>>();
    for (const response of allResponses) {
      const mentionedInResponse = findMentionedAgents(response.content, respondedAgents, allAgents);
      for (const target of mentionedInResponse) {
        if (!mentionersByTarget.has(target.name)) {
          mentionersByTarget.set(target.name, new Set<string>());
        }
        mentionersByTarget.get(target.name)!.add(response.agentName);
      }
    }
    const followUpAgents = allAgents.filter(
      (agent) => !respondedAgents.has(agent.name) && mentionersByTarget.has(agent.name),
    );
    for (const agent of followUpAgents) {
      if (!isStillOnSameTalk()) break;
      const mentioners = [...(mentionersByTarget.get(agent.name) ?? new Set<string>())];
      const respondedNames = mentioners.join(', ');
      const followUpMsg = `[${respondedNames} mentioned you in their response above. Please respond to their questions or comments directed at you.]`;
      await streamAgentResponse(gwTalkId, followUpMsg, agent, allAgents);
      respondedAgents.add(agent.name);
    }

    if (isStillOnSameTalk()) {
      setStreamingAgentName(undefined);
    }
  }, [activeTalkId, streamAgentResponse, findMentionedAgents]);

  // --- Agent command handlers ---

  const handleAddAgentCommand = useCallback((modelAlias: string, roleId: string) => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const modelId = ALIAS_TO_MODEL_ID[modelAlias.toLowerCase()] ?? modelAlias;
    const role = roleId as AgentRole;
    if (!ROLE_BY_ID[role]) {
      setError(`Unknown role: ${roleId}. Valid: analyst, critic, strategist, devils-advocate, synthesizer, editor`);
      return;
    }

    const existingAgents = talkManagerRef.current.getAgents(talkId);
    if (existingAgents.length === 0) {
      // No agents yet — prompt user to choose the primary agent's role first
      setPendingSlashAgent({ model: modelId, role });
      setRolePickerPhase('primary');
      setShowRolePicker(true);
      return;
    }

    const alias = getModelAlias(modelId);
    const newAgent: TalkAgent = {
      name: generateAgentName(alias, role),
      model: modelId,
      role,
      isPrimary: false,
    };
    talkManagerRef.current.addAgent(talkId, newAgent);
    talkManagerRef.current.saveTalk(talkId);

    const agents = talkManagerRef.current.getAgents(talkId);
    syncAgentsToGateway(agents);

    const agentAlias = getModelAlias(modelId);
    const sysMsg = createMessage('system', `Agent added: ${newAgent.name} (${ROLE_BY_ID[role].label}). Use @${agentAlias} in any message to ask directly.`);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, [currentModel, syncAgentsToGateway]);

  const handleChangeAgentRole = useCallback((name: string, roleId: string) => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const role = roleId as AgentRole;
    if (!ROLE_BY_ID[role]) {
      setError(`Unknown role: ${roleId}. Valid: analyst, critic, strategist, devils-advocate, synthesizer, editor`);
      return;
    }

    const updated = talkManagerRef.current.changeAgentRole(talkId, name, role, ROLE_BY_ID[role].label, generateAgentName);
    if (updated) {
      const agents = talkManagerRef.current.getAgents(talkId);
      syncAgentsToGateway(agents);
      const sysMsg = createMessage('system', `Agent role updated: ${updated.name} (${ROLE_BY_ID[role].label})`);
      chat.setMessages(prev => [...prev, sysMsg]);
    } else {
      setError(`Agent "${name}" not found`);
    }
  }, [syncAgentsToGateway]);

  const handleRemoveAgent = useCallback((name: string) => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const success = talkManagerRef.current.removeAgent(talkId, name);
    if (success) {
      const agents = talkManagerRef.current.getAgents(talkId);
      syncAgentsToGateway(agents);
      const sysMsg = createMessage('system', `Agent removed: ${name}`);
      chat.setMessages(prev => [...prev, sysMsg]);
    } else {
      setError(`Cannot remove "${name}" — not found or is primary agent`);
    }
  }, [syncAgentsToGateway]);

  const handleListAgents = useCallback(() => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const agents = talkManagerRef.current.getAgents(talkId);
    if (agents.length === 0) {
      const sysMsg = createMessage('system', 'No agents configured. Use /agent add <model> <role> or ^K → A to add one.');
      chat.setMessages(prev => [...prev, sysMsg]);
      return;
    }
    const lines = agents.map((a, i) => {
      const primary = a.isPrimary ? ' (primary)' : '';
      const alias = getModelAlias(a.model);
      return `  ${i + 1}. ${a.name} — ${ROLE_BY_ID[a.role]?.label ?? a.role} [${alias}]${primary}`;
    });
    const sysMsg = createMessage('system', `Agents:\n${lines.join('\n')}`);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, []);

  const handleAskAgent = useCallback(async (name: string, message: string) => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const agent = talkManagerRef.current.findAgent(talkId, name);
    if (!agent) {
      setError(`Agent "${name}" not found`);
      return;
    }

    const allAgents = talkManagerRef.current.getAgents(talkId);
    await sendMultiAgentMessage(message, [agent], allAgents);
  }, [sendMultiAgentMessage]);

  const handleDebateAll = useCallback(async (topic: string) => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const agents = talkManagerRef.current.getAgents(talkId);
    if (agents.length < 2) {
      setError('Debate requires at least 2 agents. Use /agent add or ^K to add agents.');
      return;
    }

    await sendMultiAgentMessage(topic, agents, agents);
  }, [sendMultiAgentMessage]);

  const handleReviewLast = useCallback(async () => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const agents = talkManagerRef.current.getAgents(talkId);
    const nonPrimary = agents.filter(a => !a.isPrimary);
    if (nonPrimary.length === 0) {
      setError('Review requires non-primary agents. Use /agent add to add agents.');
      return;
    }

    // Find the last assistant message
    const lastAssistant = [...chat.messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) {
      setError('No assistant message to review');
      return;
    }

    const reviewPrompt = `Please review and critique the following response:\n\n${lastAssistant.content}`;
    await sendMultiAgentMessage(reviewPrompt, nonPrimary, agents);
  }, [sendMultiAgentMessage, chat.messages]);

  // --- File attachment handler ---

  const handleAttachFile = useCallback(async (filePath: string, message?: string) => {
    const sysMsg = createMessage('system', 'Processing file...');
    chat.setMessages(prev => [...prev, sysMsg]);

    try {
      const result = await processFile(filePath);

      if (result.type === 'image') {
        const attachment = result.attachment;
        const sizeKB = Math.round(attachment.sizeBytes / 1024);

        if (message) {
          chat.setMessages(prev => prev.filter(m => m.id !== sysMsg.id));
          const confirmMsg = createMessage('system', `[attached] ${attachment.filename} (${attachment.width}x${attachment.height}, ${sizeKB}KB)`);
          chat.setMessages(prev => [...prev, confirmMsg]);
          const gwTalkId = await ensureGatewayTalk();
          if (!gwTalkId) return;
          await chat.sendMessage(message, attachment);
        } else {
          setPendingAttachment(attachment);
          chat.setMessages(prev => {
            const filtered = prev.filter(m => m.id !== sysMsg.id);
            const confirmMsg = createMessage('system', `[attached] ${attachment.filename} (${attachment.width}x${attachment.height}, ${sizeKB}KB) — type a message to send`);
            return [...filtered, confirmMsg];
          });
        }
      } else {
        // Document (PDF, text file)
        const sizeKB = Math.round(result.sizeBytes / 1024);
        const pageInfo = result.pageCount ? `, ${result.pageCount} pages` : '';
        const charCount = result.text.length;

        chat.setMessages(prev => prev.filter(m => m.id !== sysMsg.id));
        const confirmMsg = createMessage('system', `[attached] ${result.filename} (${sizeKB}KB${pageInfo}, ${charCount} chars)`);
        chat.setMessages(prev => [...prev, confirmMsg]);

        if (message) {
          const gwTalkId = await ensureGatewayTalk();
          if (!gwTalkId) return;
          await chat.sendMessage(message, undefined, { filename: result.filename, text: result.text });
        } else {
          // Store document content for next message
          setPendingDocument({ filename: result.filename, text: result.text });
        }
      }
    } catch (err) {
      chat.setMessages(prev => prev.filter(m => m.id !== sysMsg.id));
      const errMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`File error: ${errMessage}`);
    }
  }, [chat.sendMessage, ensureGatewayTalk]);

  // --- Submit handler (command registry + chat) ---

  const executeClear = useCallback(() => {
    chat.setMessages([]);
    sessionManagerRef.current?.clearActiveSession();
    setError(null);
    setPendingClear(false);
    const sysMsg = createMessage('system', 'Chat cleared.');
    chat.setMessages([sysMsg]);
  }, [chat]);

  const addSystemMessage = useCallback((text: string) => {
    const sysMsg = createMessage('system', text);
    chat.setMessages(prev => [...prev, sysMsg]);
  }, []);

  const openToolsSettings = useCallback(() => {
    setSettingsFromTalks(false);
    setSettingsTab('tools');
    setShowSettings(true);
    refreshSettingsToolPolicy();
  }, [refreshSettingsToolPolicy]);

  useEffect(() => {
    if (!showSettings) return;
    if (settingsTab === 'tools') {
      refreshSettingsToolPolicy();
    }
  }, [showSettings, settingsTab, refreshSettingsToolPolicy]);

  const commandCtx = useRef({
    switchModel,
    openModelPicker: () => { setModelPickerMode('switch'); setShowModelPicker(true); },
    clearSession: () => { setPendingClear(true); },
    setError,
    addSystemMessage,
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
    addAgent: handleAddAgentCommand,
    removeAgent: handleRemoveAgent,
    changeAgentRole: handleChangeAgentRole,
    listAgents: handleListAgents,
    askAgent: handleAskAgent,
    debateAll: handleDebateAll,
    reviewLast: handleReviewLast,
    attachFile: handleAttachFile,
    exportTalk: handleExportTalk,
    editMessages: handleEditMessages,
    addDirective: handleAddDirective,
    removeDirective: handleRemoveDirective,
    toggleDirective: handleToggleDirective,
    listDirectives: handleListDirectives,
    addPlatformBinding: handleAddPlatformBinding,
    removePlatformBinding: handleRemovePlatformBinding,
    listPlatformBindings: handleListPlatformBindings,
    listChannelResponses: handleListChannelResponses,
    setChannelResponseEnabled: handleSetChannelResponseEnabled,
    setChannelResponsePrompt: handleSetChannelResponsePrompt,
    setChannelResponseAgent: handleSetChannelResponseAgent,
    clearChannelResponse: handleClearChannelResponse,
    listTools: handleListTools,
    setToolsMode: handleSetToolsMode,
    addAllowedTool: handleAddAllowedTool,
    removeAllowedTool: handleRemoveAllowedTool,
    clearAllowedTools: handleClearAllowedTools,
    addDeniedTool: handleAddDeniedTool,
    removeDeniedTool: handleRemoveDeniedTool,
    clearDeniedTools: handleClearDeniedTools,
    showGoogleDocsAuthStatus: handleShowGoogleDocsAuthStatus,
    setGoogleDocsRefreshToken: handleSetGoogleDocsRefreshToken,
    openToolsSettings,
    showPlaybook: handleShowPlaybook,
  });
  commandCtx.current = {
    switchModel,
    openModelPicker: () => { setModelPickerMode('switch'); setShowModelPicker(true); },
    clearSession: () => { setPendingClear(true); },
    setError,
    addSystemMessage,
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
    addAgent: handleAddAgentCommand,
    removeAgent: handleRemoveAgent,
    changeAgentRole: handleChangeAgentRole,
    listAgents: handleListAgents,
    askAgent: handleAskAgent,
    debateAll: handleDebateAll,
    reviewLast: handleReviewLast,
    attachFile: handleAttachFile,
    exportTalk: handleExportTalk,
    editMessages: handleEditMessages,
    addDirective: handleAddDirective,
    removeDirective: handleRemoveDirective,
    toggleDirective: handleToggleDirective,
    listDirectives: handleListDirectives,
    addPlatformBinding: handleAddPlatformBinding,
    removePlatformBinding: handleRemovePlatformBinding,
    listPlatformBindings: handleListPlatformBindings,
    listChannelResponses: handleListChannelResponses,
    setChannelResponseEnabled: handleSetChannelResponseEnabled,
    setChannelResponsePrompt: handleSetChannelResponsePrompt,
    setChannelResponseAgent: handleSetChannelResponseAgent,
    clearChannelResponse: handleClearChannelResponse,
    listTools: handleListTools,
    setToolsMode: handleSetToolsMode,
    addAllowedTool: handleAddAllowedTool,
    removeAllowedTool: handleRemoveAllowedTool,
    clearAllowedTools: handleClearAllowedTools,
    addDeniedTool: handleAddDeniedTool,
    removeDeniedTool: handleRemoveDeniedTool,
    clearDeniedTools: handleClearDeniedTools,
    showGoogleDocsAuthStatus: handleShowGoogleDocsAuthStatus,
    setGoogleDocsRefreshToken: handleSetGoogleDocsRefreshToken,
    openToolsSettings,
    showPlaybook: handleShowPlaybook,
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

    // If already processing, queue the message
    if (chat.isProcessing) {
      setMessageQueue(prev => [...prev, trimmed]);
      return;
    }

    const gwTalkId = await ensureGatewayTalk();
    if (!gwTalkId) return;

    // Process staged pending files before routing (applies to both agent and regular paths)
    let finalMessage = trimmed;
    let fileAttachment: PendingAttachment | undefined;
    let fileDoc: { filename: string; text: string } | undefined;

    if (pendingFiles.length > 0) {
      const files = [...pendingFiles];
      setPendingFiles([]);
      setFileIndicatorSelected(false);

      const uploadNotes: string[] = [];

      for (const file of files) {
        // Upload to gateway
        if (chatServiceRef.current) {
          const uploadMsg = createMessage('system', `[uploading] ${file.filename}...`);
          chat.setMessages(prev => [...prev, uploadMsg]);
          try {
            const uploadData = await readFileForUpload(file.path);
            const uploadResult = await chatServiceRef.current.uploadFile(uploadData.filename, uploadData.base64);
            const sizeKB = Math.round(uploadResult.sizeBytes / 1024);
            const preferredPath = uploadResult.agentPath || uploadResult.workspacePath || uploadResult.serverPath;
            uploadNotes.push(`[File "${file.filename}" uploaded to server: ${preferredPath}]`);
            chat.setMessages(prev => {
              const filtered = prev.filter(m => m.id !== uploadMsg.id);
              return [...filtered, createMessage('system', `[uploaded] ${uploadResult.filename} (${sizeKB}KB) → ${preferredPath}`)];
            });
          } catch (uploadErr) {
            chat.setMessages(prev => prev.filter(m => m.id !== uploadMsg.id));
            const errMsg = uploadErr instanceof Error ? uploadErr.message : 'Unknown error';
            chat.setMessages(prev => [...prev, createMessage('system', `[upload failed] ${file.filename}: ${errMsg}`)]);
          }
        }

        // Local text extraction / image processing
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

    // When agents are configured, route through multi-agent (enables response chaining)
    const talkId = activeTalkIdRef.current;
    if (talkId && talkManagerRef.current) {
      const allAgents = talkManagerRef.current.getAgents(talkId);
      if (allAgents.length > 0) {
        // Extract @mentions (word boundary: start of string or whitespace before @)
        const mentionPattern = /(?:^|\s)@(\w+)/g;
        const mentionedAgents: TalkAgent[] = [];
        let match;
        while ((match = mentionPattern.exec(finalMessage)) !== null) {
          const agent = talkManagerRef.current.findAgent(talkId, match[1]);
          if (agent && !mentionedAgents.includes(agent)) {
            mentionedAgents.push(agent);
          }
        }

        // Use @mentioned agents, or default to primary agent
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

    // Check for pending document from /file command
    const docContent = fileDoc ?? pendingDocument ?? undefined;
    if (pendingDocument) {
      setPendingDocument(null);
    }

    // Show primary agent name during streaming (cleared after sendMessage completes)
    const primaryName = primaryAgentRef.current?.name;
    if (primaryName) setStreamingAgentName(primaryName);

    await chat.sendMessage(finalMessage, attachment, docContent);

    if (primaryName) setStreamingAgentName(undefined);
  }, [chat.sendMessage, chat.isProcessing, sendMultiAgentMessage, pendingAttachment, pendingDocument, pendingFiles, ensureGatewayTalk]);

  // Process queued messages when AI finishes responding
  useEffect(() => {
    if (!chat.isProcessing && messageQueue.length > 0) {
      // Small delay to ensure any cleanup from previous request completes
      const timer = setTimeout(() => {
        const nextMessage = messageQueue[0];
        if (nextMessage) {
          setMessageQueue(prev => prev.slice(1));
          void (async () => {
            const gwTalkId = await ensureGatewayTalk();
            if (!gwTalkId) return;
            await chat.sendMessage(nextMessage);
          })();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [chat.isProcessing, messageQueue, chat.sendMessage, ensureGatewayTalk]);

  // --- Keyboard shortcuts ---

  useInput((input, key) => {
    if (showModelPicker || showRolePicker || showEditMessages || showTalks || showChannelConfig || showJobsConfig || showSettings) return;

    // Clear confirmation mode
    if (pendingClear) {
      if (input === 'c' && !key.ctrl) {
        executeClear();
      } else {
        setPendingClear(false);
      }
      return;
    }

    // Queue message selection (navigate with up/down, delete with backspace)
    if (queueSelectedIndex !== null && messageQueue.length > 0) {
      if (key.backspace || key.delete) {
        setMessageQueue(prev => prev.filter((_, i) => i !== queueSelectedIndex));
        if (queueSelectedIndex >= messageQueue.length - 1) {
          setQueueSelectedIndex(messageQueue.length > 1 ? messageQueue.length - 2 : null);
        }
        return;
      }
      if (key.upArrow) {
        setQueueSelectedIndex(prev => (prev !== null && prev > 0) ? prev - 1 : prev);
        return;
      }
      if (key.downArrow) {
        setQueueSelectedIndex(prev => {
          if (prev === null) return null;
          if (prev < messageQueue.length - 1) return prev + 1;
          // Last item - exit selection
          return null;
        });
        return;
      }
      if (key.escape || key.return) {
        setQueueSelectedIndex(null);
        return;
      }
      setQueueSelectedIndex(null);
      // fall through to normal input handling
    }

    // File indicator selection
    if (fileIndicatorSelected && pendingFiles.length > 0) {
      if (key.backspace || key.delete) {
        setPendingFiles(prev => prev.slice(0, -1));
        if (pendingFiles.length <= 1) setFileIndicatorSelected(false);
        return;
      }
      if (key.escape || key.downArrow) {
        setFileIndicatorSelected(false);
        return;
      }
      setFileIndicatorSelected(false);
      // fall through to normal input handling
    }

    if (key.upArrow && inputText.length === 0 && messageQueue.length > 0 && !showCommandHints) {
      setQueueSelectedIndex(messageQueue.length - 1);
      return;
    }

    if (key.upArrow && inputText.length === 0 && pendingFiles.length > 0 && !showCommandHints && queueSelectedIndex === null) {
      setFileIndicatorSelected(true);
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

    // ^K AI Model (opens model picker)
    if (input === 'k' && key.ctrl) {
      setModelPickerMode('switch');
      setShowModelPicker(true);
      cleanInputChar(setInputText, 'k');
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

    // ^V AI Voice (toggle TTS responses)
    if (input === 'v' && key.ctrl) {
      voice.handleTtsToggle?.();
      cleanInputChar(setInputText, 'v');
      return;
    }

    // ^E Select Text (toggle mouse capture for text selection)
    if (input === 'e' && key.ctrl) {
      setGrabTextMode(prev => !prev);
      cleanInputChar(setInputText, 'e');
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

    // ^B Channel Config
    if (input === 'b' && key.ctrl) {
      if (!activeTalkId || !talkManagerRef.current) {
        setError('No active talk to configure.');
      } else {
        setShowChannelConfig(true);
      }
      cleanInputChar(setInputText, 'b');
      return;
    }

    // ^J Jobs Config
    if (input === 'j' && key.ctrl) {
      if (!activeTalkId || !talkManagerRef.current) {
        setError('No active talk to configure.');
      } else {
        setShowJobsConfig(true);
      }
      cleanInputChar(setInputText, 'j');
      return;
    }

    // ^S Settings
    if (input === 's' && key.ctrl) {
      setSettingsFromTalks(false);
      setSettingsTab('talk');
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

  const overlayMaxHeight = Math.max(6, terminalHeight - 4);

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
        agents={activeTalk?.agents}
        directiveCount={(activeTalk?.directives ?? []).filter(d => d.active).length}
        platformBindingCount={(activeTalk?.platformBindings ?? []).length}
      />

      {/* Talk title / grab mode indicator (pinned below status bar) */}
      {showTitleBar && (
        <Box flexDirection="column">
          <Box width={terminalWidth}>
            {talkTitle ? (
              <>
                <Box flexGrow={1} justifyContent="center">
                  <Text bold>{talkTitle}</Text>
                </Box>
                {grabTextMode && (
                  <Box marginRight={1}>
                    <Text color="yellow" bold>SELECT MODE</Text>
                    <Text dimColor> ^E exit</Text>
                  </Box>
                )}
              </>
            ) : (
              <Box flexGrow={1} justifyContent="center">
                <Text color="yellow" bold>SELECT MODE</Text>
                <Text dimColor> — drag to select, ^E to exit</Text>
              </Box>
            )}
          </Box>
          <Text dimColor>{'─'.repeat(terminalWidth)}</Text>
        </Box>
      )}

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
            onSelect={modelPickerMode === 'default' ? selectDefaultModel : selectModel}
            onClose={() => { setShowModelPicker(false); if (modelPickerMode === 'default') setShowTalks(true); }}
            maxHeight={overlayMaxHeight}
            onAddAgent={modelPickerMode === 'default' ? undefined : handleAddAgentRequest}
            title={modelPickerMode === 'default' ? 'Set Default Talks Model' : undefined}
            modelValidity={gateway.modelValidity}
            isRefreshing={gateway.modelsRefreshing}
            lastRefreshedAt={gateway.modelsLastRefreshedAt}
          />
        </Box>
      ) : showRolePicker ? (
        <Box flexGrow={1} paddingX={1}>
          <RolePicker
            roles={AGENT_ROLES}
            onSelect={handleRoleSelected}
            onClose={() => { setShowRolePicker(false); setPendingAgentModelId(null); setPendingSlashAgent(null); }}
            modelName={rolePickerPhase === 'primary'
              ? getModelAlias(currentModel) + ' (primary)'
              : getModelAlias(pendingAgentModelId ?? '')}
            maxHeight={overlayMaxHeight}
          />
        </Box>
      ) : showEditMessages ? (
        <Box flexGrow={1} paddingX={1}>
          <EditMessages
            messages={chat.messages}
            maxHeight={overlayMaxHeight}
            terminalWidth={terminalWidth}
            onClose={() => setShowEditMessages(false)}
            onConfirm={handleConfirmDeleteMessages}
            onNewChat={() => { setShowEditMessages(false); handleNewChat(); }}
            onToggleTts={() => { voice.handleTtsToggle?.(); }}
            onOpenTalks={() => { setShowEditMessages(false); setShowTalks(true); }}
            onOpenSettings={() => { setShowEditMessages(false); setSettingsFromTalks(false); setSettingsTab('talk'); setShowSettings(true); }}
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
            onOpenSettings={() => { setShowTalks(false); setSettingsFromTalks(true); setSettingsTab('mic'); setShowSettings(true); }}
            onOpenModelPicker={() => { setModelPickerMode('default'); setShowModelPicker(true); }}
            exportDir={savedConfig.exportDir}
            onNewTerminal={() => { spawnNewTerminalWindow(options); }}
            onExit={() => { voiceServiceRef.current?.cleanup(); exit(); }}
            setError={setError}
            onRenameTalk={handleRenameTalk}
            onDeleteTalk={handleDeleteTalk}
          />
        </Box>
      ) : showChannelConfig ? (
        <Box flexGrow={1} paddingX={1}>
          <ChannelConfigPicker
            maxHeight={overlayMaxHeight}
            terminalWidth={terminalWidth}
            bindings={activeTalk?.platformBindings ?? []}
            behaviors={activeTalk?.platformBehaviors ?? []}
            agents={activeTalk?.agents ?? []}
            slackAccounts={slackAccountHints}
            slackChannelsByAccount={slackChannelsByAccount}
            slackHintsLoading={slackHintsLoading}
            slackHintsError={slackHintsError}
            onRefreshSlackHints={() => { void loadSlackHints(); }}
            onClose={() => setShowChannelConfig(false)}
            onAddBinding={handleAddPlatformBinding}
            onUpdateBinding={handleUpdatePlatformBinding}
            onRemoveBinding={handleRemovePlatformBinding}
            onSetResponseMode={handleSetChannelResponseMode}
            onSetDeliveryMode={handleSetChannelDeliveryMode}
            onSetMirrorToTalk={handleSetChannelMirrorToTalk}
            onSetPrompt={handleSetChannelResponsePrompt}
            onSetAgentChoice={handleSetChannelResponseAgentChoice}
            onClearBehavior={handleClearChannelResponse}
          />
        </Box>
      ) : showJobsConfig ? (
        <Box flexGrow={1} paddingX={1}>
          <JobsConfigPicker
            maxHeight={overlayMaxHeight}
            terminalWidth={terminalWidth}
            jobs={activeTalk?.jobs ?? []}
            platformBindings={activeTalk?.platformBindings ?? []}
            gatewayConnected={Boolean((gatewayTalkIdRef.current ?? activeTalk?.gatewayTalkId) && chatServiceRef.current)}
            onClose={() => setShowJobsConfig(false)}
            onRefreshJobs={refreshJobsFromSource}
            onAddJob={handleAddJob}
            onSetJobActive={handleSetJobActive}
            onSetJobSchedule={handleSetJobSchedule}
            onSetJobPrompt={handleSetJobPrompt}
            onDeleteJob={handleDeleteJobForPicker}
            onViewReports={handleViewReports}
          />
        </Box>
      ) : showSettings ? (
        <Box flexGrow={1} paddingX={1}>
          <SettingsPicker
            onClose={() => { setShowSettings(false); if (settingsFromTalks) { setSettingsFromTalks(false); setShowTalks(true); } }}
            initialTab={settingsFromTalks ? 'mic' : settingsTab}
            hideTalkConfig={settingsFromTalks}
            onNewChat={() => { setShowSettings(false); handleNewChat(); }}
            onToggleTts={() => { voice.handleTtsToggle?.(); }}
            onOpenTalks={() => { setShowSettings(false); setSettingsFromTalks(false); setShowTalks(true); }}
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
            toolPolicy={settingsToolPolicy}
            toolPolicyLoading={settingsToolPolicyLoading}
            toolPolicyError={settingsToolPolicyError}
            onRefreshToolPolicy={refreshSettingsToolPolicy}
            onSetToolMode={handleSettingsSetToolMode}
            onSetExecutionMode={handleSettingsSetExecutionMode}
            onSetFilesystemAccess={handleSettingsSetFilesystemAccess}
            onSetNetworkAccess={handleSettingsSetNetworkAccess}
            onSetToolEnabled={handleSettingsSetToolEnabled}
            talkGoogleAuthProfile={settingsToolPolicy?.talkGoogleAuthProfile}
            googleAuthActiveProfile={settingsToolPolicy?.googleAuthActiveProfile}
            googleAuthProfiles={settingsToolPolicy?.googleAuthProfiles ?? []}
            googleAuthStatus={settingsToolPolicy?.googleAuthStatus}
            onStartGoogleOAuthConnect={handleSettingsStartGoogleOAuthConnect}
            onSetTalkGoogleAuthProfile={handleSettingsSetTalkGoogleAuthProfile}
            onInstallCatalogTool={handleSettingsCatalogInstall}
            onUninstallCatalogTool={handleSettingsCatalogUninstall}
            talkConfig={activeTalk ? {
              objective: activeTalk.objective,
              directives: (activeTalk.directives ?? []).map(d => ({ text: d.text, active: d.active })),
              platformBindings: (activeTalk.platformBindings ?? []).map(b => ({
                platform: b.platform,
                scope: b.scope,
                displayScope: b.displayScope,
                accountId: b.accountId,
                permission: b.permission,
              })),
              channelResponseSettings: (() => {
                const bindings = activeTalk.platformBindings ?? [];
                const behaviors = activeTalk.platformBehaviors ?? [];
                return bindings.map((binding, idx) => {
                  const behavior = behaviors.find((entry) => entry.platformBindingId === binding.id);
                  return {
                    connectionIndex: idx + 1,
                    responseMode: (behavior?.responseMode ?? (behavior?.autoRespond === false ? 'off' : 'all')) as 'off' | 'mentions' | 'all',
                    agentName: behavior?.agentName,
                    onMessagePrompt: behavior?.onMessagePrompt,
                  };
                });
              })(),
              jobs: (activeTalk.jobs ?? []).map(j => ({ schedule: j.schedule, prompt: j.prompt, active: j.active })),
              agents: (activeTalk.agents ?? []).map(a => ({ name: a.name, role: a.role, model: a.model, isPrimary: a.isPrimary })),
            } : null}
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
          streamingAgentName={streamingAgentName ?? primaryAgentRef.current?.name}
          remoteProcessing={remoteProcessing}
        />
      )}

      {/* Separator, indicators, and input (hidden when overlays are active) */}
      {!isOverlayActive && (
        <>
        <Text dimColor>{'─'.repeat(terminalWidth)}</Text>

        {/* Queued messages */}
        {messageQueue.length > 0 && (
          <Box flexDirection="column" paddingX={1}>
            {messageQueue.map((msg, idx) => {
              const isSelected = queueSelectedIndex === idx;
              return (
                <Box key={idx}>
                  <Text dimColor>{isSelected ? '▶ ' : '  '}</Text>
                  <Text dimColor>queued: </Text>
                  <Text color={isSelected ? 'cyan' : 'gray'}>{msg.length > 60 ? msg.slice(0, 60) + '...' : msg}</Text>
                  {isSelected && <Text dimColor>  [←/→ nav, ⌫ del, Esc cancel]</Text>}
                </Box>
              );
            })}
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

        {/* Pending attachment indicator */}
        {pendingAttachment && (
          <Box paddingX={1}>
            <Text color="blue">[attached] </Text>
            <Text>{pendingAttachment.filename} ({pendingAttachment.width}x{pendingAttachment.height}, {Math.round(pendingAttachment.sizeBytes / 1024)}KB)</Text>
          </Box>
        )}
        {pendingDocument && (
          <Box paddingX={1}>
            <Text color="blue">[attached] </Text>
            <Text>{pendingDocument.filename} ({pendingDocument.text.length} chars)</Text>
          </Box>
        )}

        {/* Pending file indicators */}
        {pendingFiles.length > 0 && (
          <Box flexDirection="column" paddingX={1}>
            {pendingFiles.map((f, i) => (
              <Box key={`pf-${i}`}>
                {fileIndicatorSelected && i === pendingFiles.length - 1 ? (
                  <>
                    <Text color="blue" inverse bold>{` [file: ${f.filename}] `}</Text>
                    <Text dimColor> Delete to remove · Esc to cancel</Text>
                  </>
                ) : (
                  <>
                    <Text color="blue">[file: {f.filename}]</Text>
                    {i === pendingFiles.length - 1 && <Text dimColor> (↑ to select)</Text>}
                  </>
                )}
              </Box>
            ))}
          </Box>
        )}
        </>
      )}

      {/* Input area (hidden when overlays are active) */}
      {!isOverlayActive && (
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
      )}

      {/* Shortcut bar pinned at bottom (2 lines) */}
      <ShortcutBar terminalWidth={terminalWidth} ttsEnabled={voice.ttsEnabled} grabTextMode={grabTextMode} inTalks={showTalks} />
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
