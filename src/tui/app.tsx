/**
 * ClawTalk TUI App
 *
 * Main terminal user interface built with Ink (React for CLI).
 * Full-screen layout with pinned status bar (top), pinned input/shortcuts (bottom),
 * and scrollable message history in the middle.
 *
 * Orchestration-only: all handler logic lives in hooks under ./hooks/.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { render, Box, Text, useApp, useStdout } from 'ink';
import type {
  ClawTalkOptions,
  ModelStatus,
  TalkAgent,
  AgentRole,
} from '../types.js';
import { AGENT_ROLES } from '../agent-roles.js';
import { StatusBar, ShortcutBar } from './components/StatusBar';
import { InputArea } from './components/InputArea.js';
import { ChatView } from './components/ChatView.js';
import { ModelPicker } from './components/ModelPicker.js';
import { RolePicker } from './components/RolePicker.js';
import { TalksHub } from './components/TalksHub';
import { EditMessages } from './components/EditMessages';
import { ChannelConfigPicker } from './components/ChannelConfigPicker';
import { JobsConfigPicker } from './components/JobsConfigPicker';
import { SettingsPicker } from './components/SettingsPicker.js';
import { ChatService } from '../services/chat';
import type { SessionManager } from '../services/sessions';
import { getSessionManager } from '../services/sessions';
import type { TalkManager } from '../services/talks';
import { getTalkManager } from '../services/talks';
import { spawnNewTerminalWindow } from '../services/terminal.js';
import { VoiceService } from '../services/voice.js';
import { RealtimeVoiceService } from '../services/realtime-voice.js';
import { AnthropicRateLimitService } from '../services/anthropic-ratelimit.js';
import { loadConfig, getBillingForProvider } from '../config.js';
import { getModelAlias, getProviderKey } from '../models.js';
import { DEFAULT_MODEL, RESIZE_DEBOUNCE_MS } from '../constants.js';
import { createMessage } from './helpers.js';
import { getCommandCompletions } from './commands.js';
import { CommandHints } from './components/CommandHints.js';
// Hooks
import { useGateway } from './hooks/useGateway.js';
import { useChat } from './hooks/useChat.js';
import { useVoice } from './hooks/useVoice.js';
import { useRealtimeVoice } from './hooks/useRealtimeVoice.js';
import { useMouseScroll } from './hooks/useMouseScroll.js';
import { useLayout } from './hooks/useLayout.js';
import { useModelManagement } from './hooks/useModelManagement.js';
import { useAgentManagement } from './hooks/useAgentManagement.js';
import { useTalkHandlers } from './hooks/useTalkHandlers.js';
import { useJobHandlers } from './hooks/useJobHandlers.js';
import { usePlatformBindings } from './hooks/usePlatformBindings.js';
import { useToolPolicy } from './hooks/useToolPolicy.js';
import { useTalkNavigation } from './hooks/useTalkNavigation.js';
import { useAttachments } from './hooks/useAttachments.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSubmitHandler } from './hooks/useSubmitHandler.js';

interface AppProps {
  options: ClawTalkOptions;
}

function App({ options }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [savedConfig, setSavedConfig] = useState(() => loadConfig());

  // ── Resize handling ──────────────────────────────────────────────────

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

  // ── Service refs ─────────────────────────────────────────────────────

  const chatServiceRef = useRef<ChatService | null>(null);
  const sessionManagerRef = useRef<SessionManager | null>(null);
  const talkManagerRef = useRef<TalkManager | null>(null);
  const voiceServiceRef = useRef<VoiceService | null>(null);
  const realtimeVoiceServiceRef = useRef<RealtimeVoiceService | null>(null);
  const anthropicRLRef = useRef<AnthropicRateLimitService | null>(null);

  // ── Shared state ─────────────────────────────────────────────────────

  const [currentModel, setCurrentModel] = useState(options.model ?? DEFAULT_MODEL);
  const currentModelRef = useRef(currentModel);
  useEffect(() => { currentModelRef.current = currentModel; }, [currentModel]);

  const [modelStatus, setModelStatus] = useState<ModelStatus>('unknown');
  const probeAbortRef = useRef<AbortController | null>(null);
  const probeSuppressedRef = useRef(false);
  const modelOverrideAbortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-dismiss errors after 25 seconds
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
  const [pendingSlashAgent, setPendingSlashAgent] = useState<{ model: string; role: AgentRole } | null>(null);
  const [grabTextMode, setGrabTextMode] = useState(false);
  const [showEditMessages, setShowEditMessages] = useState(false);
  const [showTalks, setShowTalks] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'talk' | 'tools' | 'skills' | 'speech'>('talk');
  const [showChannelConfig, setShowChannelConfig] = useState(false);
  const [showJobsConfig, setShowJobsConfig] = useState(false);
  const [settingsFromTalks, setSettingsFromTalks] = useState(false);
  const [sessionName, setSessionName] = useState('Session 1');
  const [activeTalkId, setActiveTalkId] = useState<string | null>(null);
  const activeTalkIdRef = useRef<string | null>(null);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [queueSelectedIndex, setQueueSelectedIndex] = useState<number | null>(null);
  const [processingStartTime, setProcessingStartTime] = useState<number | null>(null);
  const [hintSelectedIndex, setHintSelectedIndex] = useState(0);
  const [pendingClear, setPendingClear] = useState(false);
  const [remoteProcessing, setRemoteProcessing] = useState(false);

  // TTS bridge ref (useChat → useVoice)
  const speakResponseRef = useRef<((text: string) => void) | null>(null);
  // Pricing ref (kept current for session cost calculation)
  const pricingRef = useRef({ inputPer1M: 0.14, outputPer1M: 0.28 });
  // Gateway Talk ID ref (used by useChat to route through /api/talks/:id/chat)
  const gatewayTalkIdRef = useRef<string | null>(null);
  const creatingGatewayTalkRef = useRef<Promise<string | null> | null>(null);
  // Primary agent ref (used by useChat for speaker labels)
  const primaryAgentRef = useRef<TalkAgent | null>(null);
  // Ref-based ensureGatewayTalk to break circular dep between useAttachments and useTalkNavigation
  const ensureGatewayTalkRef = useRef<(() => Promise<string | null>) | null>(null);

  // ── Existing hooks ───────────────────────────────────────────────────

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
        if (probeSuppressedRef.current) return;
        if (modelStatus !== 'unknown') return;
        modelMgmt.probeCurrentModel(model, undefined, true);
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

  // ── Attachments (owns pending file/image/doc state) ──────────────────

  const attachments = useAttachments({
    chatServiceRef,
    isOverlayActive: showModelPicker || showRolePicker || showEditMessages || showTalks || showChannelConfig || showJobsConfig || showSettings,
    inputText,
    setInputText,
    setError,
    setMessages: chat.setMessages,
    sendMessage: chat.sendMessage,
    ensureGatewayTalkRef,
  });

  // ── Computed values ──────────────────────────────────────────────────

  const isOverlayActive = showModelPicker || showRolePicker || showEditMessages || showTalks || showChannelConfig || showJobsConfig || showSettings;

  // Command completions when input starts with "/"
  const commandHints = useMemo(() => {
    if (!inputText.startsWith('/')) return [];
    const prefix = inputText.slice(1).split(' ')[0];
    if (inputText.includes(' ')) return [];
    return getCommandCompletions(prefix);
  }, [inputText]);
  const showCommandHints = commandHints.length > 0 && !isOverlayActive;

  // Reset hint selection when hints change
  useEffect(() => { setHintSelectedIndex(0); }, [commandHints.length, inputText]);

  // Reset queue selection when queue becomes empty
  useEffect(() => {
    if (messageQueue.length === 0) {
      setQueueSelectedIndex(null);
    } else if (queueSelectedIndex !== null && queueSelectedIndex >= messageQueue.length) {
      setQueueSelectedIndex(messageQueue.length - 1);
    }
  }, [messageQueue.length, queueSelectedIndex]);

  // ── Layout + scroll ──────────────────────────────────────────────────

  const layout = useLayout({
    terminalWidth, terminalHeight, inputText, error, pendingClear,
    pendingAttachment: attachments.pendingAttachment,
    pendingDocument: attachments.pendingDocument,
    pendingFiles: attachments.pendingFiles,
    messageQueue,
    showCommandHints,
    commandHintsCount: commandHints.length,
    isOverlayActive,
    grabTextMode,
    activeTalkId,
    talkManagerRef,
    messages: chat.messages,
  });

  const mouseScroll = useMouseScroll({
    maxOffset: layout.scrollMaxOffset,
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

  // Auto-scroll to bottom when new messages arrive
  const prevMessageCountRef = useRef(chat.messages.length);
  useEffect(() => {
    if (chat.messages.length > prevMessageCountRef.current && mouseScroll.scrollOffset === 0) {
      // Already at bottom, stay there
    } else if (chat.messages.length > prevMessageCountRef.current && !mouseScroll.isScrolledUp) {
      mouseScroll.scrollToBottom();
    }
    prevMessageCountRef.current = chat.messages.length;
  }, [chat.messages.length]);

  // ── Service initialization ───────────────────────────────────────────

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

  // ── Handler hooks ────────────────────────────────────────────────────

  const agents = useAgentManagement({
    chatServiceRef, talkManagerRef, activeTalkIdRef, gatewayTalkIdRef,
    currentModel, setError, setMessages: chat.setMessages, messages: chat.messages,
    setShowRolePicker, setPendingAgentModelId, setPendingSlashAgent,
    setStreamingAgentName, setRolePickerPhase,
    pendingAgentModelId, pendingSlashAgent, rolePickerPhase,
    primaryAgentRef, scrollToBottom: mouseScroll.scrollToBottom,
    setShowModelPicker,
  });

  const talkNav = useTalkNavigation({
    chatServiceRef, sessionManagerRef, talkManagerRef,
    activeTalkId, activeTalkIdRef, gatewayTalkIdRef, creatingGatewayTalkRef,
    currentModel, currentModelRef,
    probeSuppressedRef, probeAbortRef, modelOverrideAbortRef, primaryAgentRef,
    setCurrentModel, setActiveTalkId, setSessionName, setRemoteProcessing,
    setModelStatus, setStreamingAgentName,
    setPendingAttachment: attachments.setPendingAttachment,
    setPendingFiles: attachments.setPendingFiles,
    setFileIndicatorSelected: attachments.setFileIndicatorSelected,
    setShowTalks, setError, setMessages: chat.setMessages, messages: chat.messages,
    clearStreaming: chat.clearStreaming, scrollToBottom: mouseScroll.scrollToBottom,
    syncAgentsToGateway: agents.syncAgentsToGateway,
    showTalks, remoteProcessing,
  });

  // Keep ensureGatewayTalk ref current for useAttachments
  ensureGatewayTalkRef.current = talkNav.ensureGatewayTalk;

  const modelMgmt = useModelManagement({
    chatServiceRef, sessionManagerRef, talkManagerRef,
    activeTalkIdRef, gatewayTalkIdRef,
    currentModel, setCurrentModel, modelStatus, setModelStatus,
    setError, setMessages: chat.setMessages,
    setShowModelPicker, setShowTalks,
    savedConfig, setSavedConfig,
    pricingRef, probeAbortRef, probeSuppressedRef, modelOverrideAbortRef,
    gatewaySetUsage: gateway.setUsage,
    availableModels: gateway.availableModels,
  });

  const jobs = useJobHandlers({
    chatServiceRef, talkManagerRef,
    activeTalkId, activeTalkIdRef, gatewayTalkIdRef,
    setError, setMessages: chat.setMessages, error,
  });

  const talks = useTalkHandlers({
    chatServiceRef, sessionManagerRef, talkManagerRef,
    activeTalkId, activeTalkIdRef, gatewayTalkIdRef,
    setError, setMessages: chat.setMessages, messages: chat.messages,
    setShowEditMessages, savedConfig, resolveGatewayJobByIndex: jobs.resolveGatewayJobByIndex,
  });

  const bindings = usePlatformBindings({
    chatServiceRef, talkManagerRef,
    activeTalkId, activeTalkIdRef, gatewayTalkIdRef, currentModelRef,
    setError, setMessages: chat.setMessages, showChannelConfig,
  });

  const toolPolicy = useToolPolicy({
    chatServiceRef, talkManagerRef,
    activeTalkIdRef, gatewayTalkIdRef,
    setError, setMessages: chat.setMessages,
  });

  // Sync activeTalkIdRef + clear stale state on talk switch
  useEffect(() => {
    activeTalkIdRef.current = activeTalkId;
    setError(null);
    toolPolicy.setSettingsToolPolicy(null);
    toolPolicy.setSettingsToolPolicyError(null);
    const agentsList = activeTalkId ? talkManagerRef.current?.getAgents(activeTalkId) : [];
    primaryAgentRef.current = agentsList?.find(a => a.isPrimary) ?? null;
  }, [activeTalkId]);

  // ── Submit handler ───────────────────────────────────────────────────

  const submit = useSubmitHandler({
    chatServiceRef, talkManagerRef, activeTalkIdRef, gatewayTalkIdRef, primaryAgentRef,
    sendMessage: chat.sendMessage, isProcessing: chat.isProcessing, setMessages: chat.setMessages,
    pendingAttachment: attachments.pendingAttachment,
    setPendingAttachment: attachments.setPendingAttachment,
    pendingDocument: attachments.pendingDocument,
    setPendingDocument: attachments.setPendingDocument,
    pendingFiles: attachments.pendingFiles,
    setPendingFiles: attachments.setPendingFiles,
    setFileIndicatorSelected: attachments.setFileIndicatorSelected,
    setInputText, setStreamingAgentName, setError, scrollToBottom: mouseScroll.scrollToBottom,
    messageQueue, setMessageQueue,
    ensureGatewayTalk: talkNav.ensureGatewayTalk,
    sendMultiAgentMessage: agents.sendMultiAgentMessage,
    commandCtxHandlers: {
      switchModel: modelMgmt.switchModel,
      openModelPicker: () => { setModelPickerMode('switch'); setShowModelPicker(true); },
      clearSession: () => {
        sessionManagerRef.current?.clearActiveSession();
        submit.executeClear();
      },
      setError,
      addSystemMessage: talks.addSystemMessage,
      saveTalk: talks.handleSaveTalk,
      setTopicTitle: talks.handleSetTopicTitle,
      pinMessage: talks.handlePinMessage,
      unpinMessage: talks.handleUnpinMessage,
      listPins: talks.handleListPins,
      addJob: jobs.handleAddJob,
      listJobs: jobs.handleListJobs,
      pauseJob: jobs.handlePauseJob,
      resumeJob: jobs.handleResumeJob,
      deleteJob: jobs.handleDeleteJob,
      setObjective: talks.handleSetObjective,
      showObjective: talks.handleShowObjective,
      viewReports: talks.handleViewReports,
      addAgent: agents.handleAddAgentCommand,
      removeAgent: agents.handleRemoveAgent,
      changeAgentRole: agents.handleChangeAgentRole,
      listAgents: agents.handleListAgents,
      askAgent: agents.handleAskAgent,
      debateAll: agents.handleDebateAll,
      reviewLast: agents.handleReviewLast,
      attachFile: attachments.handleAttachFile,
      exportTalk: talks.handleExportTalk,
      editMessages: talks.handleEditMessages,
      addDirective: bindings.handleAddDirective,
      removeDirective: bindings.handleRemoveDirective,
      toggleDirective: bindings.handleToggleDirective,
      listDirectives: bindings.handleListDirectives,
      addPlatformBinding: bindings.handleAddPlatformBinding,
      removePlatformBinding: (idx: number) => bindings.handleRemovePlatformBinding(idx),
      listPlatformBindings: bindings.handleListPlatformBindings,
      listChannelResponses: bindings.handleListChannelResponses,
      setChannelResponseEnabled: bindings.handleSetChannelResponseEnabled,
      setChannelResponsePrompt: bindings.handleSetChannelResponsePrompt,
      setChannelResponseAgent: bindings.handleSetChannelResponseAgent,
      clearChannelResponse: bindings.handleClearChannelResponse,
      listTools: toolPolicy.handleListTools,
      setToolsMode: toolPolicy.handleSetToolsMode,
      addAllowedTool: toolPolicy.handleAddAllowedTool,
      removeAllowedTool: toolPolicy.handleRemoveAllowedTool,
      clearAllowedTools: toolPolicy.handleClearAllowedTools,
      addDeniedTool: toolPolicy.handleAddDeniedTool,
      removeDeniedTool: toolPolicy.handleRemoveDeniedTool,
      clearDeniedTools: toolPolicy.handleClearDeniedTools,
      showGoogleDocsAuthStatus: toolPolicy.handleShowGoogleDocsAuthStatus,
      setGoogleDocsRefreshToken: toolPolicy.handleSetGoogleDocsRefreshToken,
      openToolsSettings: () => { setSettingsFromTalks(false); setSettingsTab('tools'); setShowSettings(true); },
      showPlaybook: talks.handleShowPlaybook,
    },
  });

  // ── Keyboard shortcuts ───────────────────────────────────────────────

  useKeyboardShortcuts({
    showModelPicker, showRolePicker, showEditMessages, showTalks,
    showChannelConfig, showJobsConfig, showSettings,
    setShowModelPicker, setModelPickerMode, setShowTalks,
    setShowChannelConfig, setShowJobsConfig, setShowSettings,
    setSettingsFromTalks, setSettingsTab, setGrabTextMode, setInputText, setError,
    messageQueue, setMessageQueue, queueSelectedIndex, setQueueSelectedIndex,
    pendingFiles: attachments.pendingFiles,
    fileIndicatorSelected: attachments.fileIndicatorSelected,
    setFileIndicatorSelected: attachments.setFileIndicatorSelected,
    showCommandHints, commandHints, hintSelectedIndex, setHintSelectedIndex,
    pendingClear, setPendingClear, executeClear: submit.executeClear,
    inputText, activeTalkId, isProcessing: chat.isProcessing, options,
    voiceHandleEscape: voice.handleEscape,
    voiceHandleVoiceToggle: voice.handleVoiceToggle,
    voiceHandleLiveTalk: voice.handleLiveTalk,
    voiceHandleTtsToggle: voice.handleTtsToggle,
    voiceMode: voice.voiceMode,
    realtimeVoiceIsActive: realtimeVoice.isActive,
    realtimeVoiceEndSession: realtimeVoice.endSession,
    realtimeVoiceStartSession: realtimeVoice.startSession,
    realtimeVoiceCapsAvailable: !!gateway.realtimeVoiceCaps,
    handleNewChat: talkNav.handleNewChat,
    exit,
    voiceCleanup: () => { voiceServiceRef.current?.cleanup(); },
    talkManagerRef,
  });

  // ── Render ───────────────────────────────────────────────────────────

  const { activeTalk, overlayMaxHeight, talkTitle, showTitleBar, chatHeight,
    messageLinesArray, inputLines } = layout;

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
            models={modelMgmt.pickerModels}
            currentModel={currentModel}
            onSelect={modelPickerMode === 'default' ? modelMgmt.selectDefaultModel : modelMgmt.selectModel}
            onClose={() => { setShowModelPicker(false); if (modelPickerMode === 'default') setShowTalks(true); }}
            maxHeight={overlayMaxHeight}
            onAddAgent={modelPickerMode === 'default' ? undefined : agents.handleAddAgentRequest}
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
            onSelect={agents.handleRoleSelected}
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
            onConfirm={talks.handleConfirmDeleteMessages}
            onNewChat={() => { setShowEditMessages(false); talkNav.handleNewChat(); }}
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
            onSelectTalk={talkNav.handleSelectTalk}
            onNewChat={() => { setShowTalks(false); talkNav.handleNewChat(); }}
            onToggleTts={() => { voice.handleTtsToggle?.(); }}
            onOpenSettings={() => { setShowTalks(false); setSettingsFromTalks(true); setSettingsTab('speech'); setShowSettings(true); }}
            onOpenModelPicker={() => { setModelPickerMode('default'); setShowModelPicker(true); }}
            exportDir={savedConfig.exportDir}
            onNewTerminal={() => { spawnNewTerminalWindow(options); }}
            onExit={() => { voiceServiceRef.current?.cleanup(); exit(); }}
            setError={setError}
            onRenameTalk={talks.handleRenameTalk}
            onDeleteTalk={talks.handleDeleteTalk}
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
            slackAccounts={bindings.slackAccountHints}
            slackChannelsByAccount={bindings.slackChannelsByAccount}
            slackHintsLoading={bindings.slackHintsLoading}
            slackHintsError={bindings.slackHintsError}
            onRefreshSlackHints={() => { void bindings.loadSlackHints(); }}
            onClose={() => setShowChannelConfig(false)}
            onAddBinding={bindings.handleAddPlatformBinding}
            onUpdateBinding={bindings.handleUpdatePlatformBinding}
            onRemoveBinding={bindings.handleRemovePlatformBinding}
            onSetResponseMode={bindings.handleSetChannelResponseMode}
            onSetDeliveryMode={bindings.handleSetChannelDeliveryMode}
            onSetMirrorToTalk={bindings.handleSetChannelMirrorToTalk}
            onSetPrompt={bindings.handleSetChannelResponsePrompt}
            onSetAgentChoice={bindings.handleSetChannelResponseAgentChoice}
            onClearBehavior={bindings.handleClearChannelResponse}
            onCheckSlackProxySetup={async () => {
              return chatServiceRef.current?.getSlackProxySetup() ?? null;
            }}
            onSaveSlackSigningSecret={async (secret: string) => {
              if (!chatServiceRef.current) return { ok: false, error: 'Not connected to Gateway' };
              return chatServiceRef.current.saveSlackSigningSecret(secret);
            }}
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
            onRefreshJobs={jobs.refreshJobsFromSource}
            onAddJob={jobs.handleAddJob}
            onSetJobActive={jobs.handleSetJobActive}
            onSetJobSchedule={jobs.handleSetJobSchedule}
            onSetJobPrompt={jobs.handleSetJobPrompt}
            onDeleteJob={jobs.handleDeleteJobForPicker}
            onViewReports={talks.handleViewReports}
          />
        </Box>
      ) : showSettings ? (
        <Box flexGrow={1} paddingX={1}>
          <SettingsPicker
            onClose={() => { setShowSettings(false); if (settingsFromTalks) { setSettingsFromTalks(false); setShowTalks(true); } }}
            initialTab={settingsFromTalks ? 'speech' : settingsTab}
            hideTalkConfig={settingsFromTalks}
            onNewChat={() => { setShowSettings(false); talkNav.handleNewChat(); }}
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
            toolPolicy={toolPolicy.settingsToolPolicy}
            toolPolicyLoading={toolPolicy.settingsToolPolicyLoading}
            toolPolicyError={toolPolicy.settingsToolPolicyError}
            onRefreshToolPolicy={toolPolicy.refreshSettingsToolPolicy}
            onSetToolMode={toolPolicy.handleSettingsSetToolMode}
            onSetExecutionMode={toolPolicy.handleSettingsSetExecutionMode}
            onSetFilesystemAccess={toolPolicy.handleSettingsSetFilesystemAccess}
            onSetNetworkAccess={toolPolicy.handleSettingsSetNetworkAccess}
            onSetToolEnabled={toolPolicy.handleSettingsSetToolEnabled}
            talkGoogleAuthProfile={toolPolicy.settingsToolPolicy?.talkGoogleAuthProfile}
            googleAuthActiveProfile={toolPolicy.settingsToolPolicy?.googleAuthActiveProfile}
            googleAuthProfiles={toolPolicy.settingsToolPolicy?.googleAuthProfiles ?? []}
            googleAuthStatus={toolPolicy.settingsToolPolicy?.googleAuthStatus}
            onStartGoogleOAuthConnect={toolPolicy.handleSettingsStartGoogleOAuthConnect}
            onSetTalkGoogleAuthProfile={toolPolicy.handleSettingsSetTalkGoogleAuthProfile}
            onInstallCatalogTool={toolPolicy.handleSettingsCatalogInstall}
            onUninstallCatalogTool={toolPolicy.handleSettingsCatalogUninstall}
            skills={toolPolicy.settingsSkills ?? undefined}
            skillsLoading={toolPolicy.settingsSkillsLoading}
            skillsError={toolPolicy.settingsSkillsError}
            allSkillsMode={toolPolicy.settingsAllSkillsMode}
            onToggleSkill={toolPolicy.handleSettingsToggleSkill}
            onResetSkillsToAll={toolPolicy.handleSettingsResetSkillsToAll}
            onRefreshSkills={toolPolicy.refreshSettingsSkills}
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
                const crsBindings = activeTalk.platformBindings ?? [];
                const crsBehaviors = activeTalk.platformBehaviors ?? [];
                return crsBindings.map((binding, idx) => {
                  const behavior = crsBehaviors.find((entry) => entry.platformBindingId === binding.id);
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
        {attachments.pendingAttachment && (
          <Box paddingX={1}>
            <Text color="blue">[attached] </Text>
            <Text>{attachments.pendingAttachment.filename} ({attachments.pendingAttachment.width}x{attachments.pendingAttachment.height}, {Math.round(attachments.pendingAttachment.sizeBytes / 1024)}KB)</Text>
          </Box>
        )}
        {attachments.pendingDocument && (
          <Box paddingX={1}>
            <Text color="blue">[attached] </Text>
            <Text>{attachments.pendingDocument.filename} ({attachments.pendingDocument.text.length} chars)</Text>
          </Box>
        )}

        {/* Pending file indicators */}
        {attachments.pendingFiles.length > 0 && (
          <Box flexDirection="column" paddingX={1}>
            {attachments.pendingFiles.map((f, i) => (
              <Box key={`pf-${i}`}>
                {attachments.fileIndicatorSelected && i === attachments.pendingFiles.length - 1 ? (
                  <>
                    <Text color="blue" inverse bold>{` [file: ${f.filename}] `}</Text>
                    <Text dimColor> Delete to remove · Esc to cancel</Text>
                  </>
                ) : (
                  <>
                    <Text color="blue">[file: {f.filename}]</Text>
                    {i === attachments.pendingFiles.length - 1 && <Text dimColor> (↑ to select)</Text>}
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
            onSubmit={submit.handleSubmit}
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
