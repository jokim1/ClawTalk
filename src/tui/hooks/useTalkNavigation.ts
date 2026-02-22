/**
 * Talk navigation hook.
 *
 * New chat creation, talk selection, gateway talk creation,
 * and gateway sync effects.
 */

import { useCallback, useEffect } from 'react';
import type { Message, ModelStatus, Talk, TalkAgent } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { SessionManager } from '../../services/sessions.js';
import type { TalkManager } from '../../services/talks.js';
import type { ClawTalkOptions } from '../../types.js';
import { createMessage } from '../helpers.js';

export interface UseTalkNavigationDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  sessionManagerRef: React.MutableRefObject<SessionManager | null>;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  activeTalkId: string | null;
  activeTalkIdRef: React.MutableRefObject<string | null>;
  gatewayTalkIdRef: React.MutableRefObject<string | null>;
  creatingGatewayTalkRef: React.MutableRefObject<Promise<string | null> | null>;
  currentModel: string;
  currentModelRef: React.MutableRefObject<string>;
  probeSuppressedRef: React.MutableRefObject<boolean>;
  probeAbortRef: React.MutableRefObject<AbortController | null>;
  modelOverrideAbortRef: React.MutableRefObject<AbortController | null>;
  primaryAgentRef: React.MutableRefObject<TalkAgent | null>;
  setCurrentModel: React.Dispatch<React.SetStateAction<string>>;
  setActiveTalkId: React.Dispatch<React.SetStateAction<string | null>>;
  setSessionName: React.Dispatch<React.SetStateAction<string>>;
  setRemoteProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  setModelStatus: React.Dispatch<React.SetStateAction<ModelStatus>>;
  setStreamingAgentName: React.Dispatch<React.SetStateAction<string | undefined>>;
  setPendingAttachment: React.Dispatch<React.SetStateAction<any>>;
  setPendingFiles: React.Dispatch<React.SetStateAction<Array<{ path: string; filename: string }>>>;
  setFileIndicatorSelected: React.Dispatch<React.SetStateAction<boolean>>;
  setShowTalks: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (msg: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  messages: Message[];
  clearStreaming: () => void;
  scrollToBottom: () => void;
  syncAgentsToGateway: (agents: TalkAgent[]) => void;
  showTalks: boolean;
  remoteProcessing: boolean;
}

export interface UseTalkNavigationResult {
  handleNewChat: () => void;
  handleSelectTalk: (talk: Talk) => void;
  ensureGatewayTalk: () => Promise<string | null>;
}

export function useTalkNavigation(deps: UseTalkNavigationDeps): UseTalkNavigationResult {
  const {
    chatServiceRef, sessionManagerRef, talkManagerRef,
    activeTalkId, activeTalkIdRef, gatewayTalkIdRef, creatingGatewayTalkRef,
    currentModel, currentModelRef,
    probeSuppressedRef, probeAbortRef, modelOverrideAbortRef, primaryAgentRef,
    setCurrentModel, setActiveTalkId, setSessionName, setRemoteProcessing,
    setModelStatus, setStreamingAgentName,
    setPendingAttachment, setPendingFiles, setFileIndicatorSelected, setShowTalks,
    setError, setMessages, messages,
    clearStreaming, scrollToBottom, syncAgentsToGateway,
    showTalks, remoteProcessing,
  } = deps;

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
  }, [showTalks, chatServiceRef, talkManagerRef]);

  // Poll gateway when remoteProcessing is active
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
          chatServiceRef.current?.fetchGatewayMessages(gwId).then(msgs => {
            if (msgs.length > 0 && activeTalkIdRef.current === talkId) {
              setMessages(msgs);
            }
          });
        }
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [remoteProcessing, activeTalkId, chatServiceRef, activeTalkIdRef, gatewayTalkIdRef, setRemoteProcessing, setMessages]);

  const handleNewChat = useCallback(() => {
    const session = sessionManagerRef.current?.createSession(undefined, currentModel);
    if (session) {
      const talk = talkManagerRef.current?.createTalk(session.id);
      if (talk) {
        talkManagerRef.current?.setModel(talk.id, currentModel);
        setActiveTalkId(talk.id);
      }

      gatewayTalkIdRef.current = null;

      chatServiceRef.current?.setModel(currentModel);
      modelOverrideAbortRef.current?.abort();
      const controller = new AbortController();
      modelOverrideAbortRef.current = controller;
      chatServiceRef.current?.setModelOverride(currentModel, controller.signal).catch(() => {});

      clearStreaming();
      setStreamingAgentName(undefined);
      setMessages([]);
      setPendingFiles([]);
      setFileIndicatorSelected(false);
      setRemoteProcessing(false);
      setSessionName(session.name);
      const sysMsg = createMessage('system', 'New chat started.');
      setMessages(prev => [...prev, sysMsg]);
      scrollToBottom();
    }
  }, [activeTalkId, messages, currentModel, sessionManagerRef, talkManagerRef, chatServiceRef, gatewayTalkIdRef, modelOverrideAbortRef, clearStreaming, setStreamingAgentName, setMessages, setActiveTalkId, setPendingFiles, setFileIndicatorSelected, setRemoteProcessing, setSessionName, scrollToBottom]);

  const handleSelectTalk = useCallback((talk: Talk) => {
    const session = sessionManagerRef.current?.setActiveSession(talk.sessionId);

    clearStreaming();
    setStreamingAgentName(undefined);
    setMessages(session?.messages ?? []);
    setSessionName(session?.name ?? talk.topicTitle ?? 'Talk');
    setActiveTalkId(talk.id);
    setPendingAttachment(null);
    setPendingFiles([]);
    setFileIndicatorSelected(false);
    talkManagerRef.current?.setActiveTalk(talk.id);
    talkManagerRef.current?.touchTalk(talk.id);
    talkManagerRef.current?.markRead(talk.id);
    setRemoteProcessing(talk.processing === true);
    scrollToBottom();

    const localAgentsOnSelect = talkManagerRef.current?.getAgents(talk.id) ?? [];
    primaryAgentRef.current = localAgentsOnSelect.find(a => a.isPrimary) ?? null;

    const gwId = talk.gatewayTalkId;
    if (gwId) {
      gatewayTalkIdRef.current = gwId;
      chatServiceRef.current?.fetchGatewayMessages(gwId).then(msgs => {
        if (msgs.length > 0 && activeTalkIdRef.current === talk.id) {
          setMessages(msgs);
        }
      });
      const localAgents = talkManagerRef.current?.getAgents(talk.id) ?? [];
      if (localAgents.length === 0) {
        chatServiceRef.current?.getGatewayTalk(gwId).then(gwTalk => {
          if (!gwTalk?.agents?.length || activeTalkIdRef.current !== talk.id) return;
          talkManagerRef.current?.setAgents(talk.id, gwTalk.agents!);
          syncAgentsToGateway(gwTalk.agents!);
        });
      }
    } else {
      gatewayTalkIdRef.current = null;
    }

    probeSuppressedRef.current = true;
    probeAbortRef.current?.abort();

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
  }, [activeTalkId, messages, syncAgentsToGateway, sessionManagerRef, talkManagerRef, chatServiceRef, activeTalkIdRef, gatewayTalkIdRef, primaryAgentRef, probeSuppressedRef, probeAbortRef, modelOverrideAbortRef, currentModelRef, clearStreaming, setStreamingAgentName, setMessages, setSessionName, setActiveTalkId, setPendingAttachment, setPendingFiles, setFileIndicatorSelected, setRemoteProcessing, setCurrentModel, setModelStatus, setShowTalks, scrollToBottom]);

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
  }, [chatServiceRef, activeTalkIdRef, gatewayTalkIdRef, creatingGatewayTalkRef, currentModelRef, talkManagerRef, setError]);

  return {
    handleNewChat,
    handleSelectTalk,
    ensureGatewayTalk,
  };
}
