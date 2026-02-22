/**
 * Model management hook.
 *
 * Handles model probing, switching, default model selection,
 * pricing updates, and building the picker model list.
 */

import { useCallback, useEffect } from 'react';
import type { ModelStatus, Message } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { SessionManager } from '../../services/sessions.js';
import type { TalkManager } from '../../services/talks.js';
import type { Model } from '../components/ModelPicker.js';
import type { ModelInfo } from '../../models.js';
import {
  getModelAlias,
  getModelPricing,
  getProviderKey,
  formatPricingLabel,
} from '../../models.js';
import { loadConfig, saveConfig, getBillingForProvider } from '../../config.js';
import { createMessage } from '../helpers.js';

export interface UseModelManagementDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  sessionManagerRef: React.MutableRefObject<SessionManager | null>;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  activeTalkIdRef: React.MutableRefObject<string | null>;
  gatewayTalkIdRef: React.MutableRefObject<string | null>;
  currentModel: string;
  setCurrentModel: React.Dispatch<React.SetStateAction<string>>;
  modelStatus: ModelStatus;
  setModelStatus: React.Dispatch<React.SetStateAction<ModelStatus>>;
  setError: (msg: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setShowModelPicker: React.Dispatch<React.SetStateAction<boolean>>;
  setShowTalks: React.Dispatch<React.SetStateAction<boolean>>;
  savedConfig: ReturnType<typeof loadConfig>;
  setSavedConfig: React.Dispatch<React.SetStateAction<ReturnType<typeof loadConfig>>>;
  pricingRef: React.MutableRefObject<{ inputPer1M: number; outputPer1M: number }>;
  probeAbortRef: React.MutableRefObject<AbortController | null>;
  probeSuppressedRef: React.MutableRefObject<boolean>;
  modelOverrideAbortRef: React.MutableRefObject<AbortController | null>;
  gatewaySetUsage: (updater: (prev: any) => any) => void;
  availableModels: ModelInfo[];
}

export interface UseModelManagementResult {
  probeCurrentModel: (modelId: string, previousModel?: string, skipCheckingState?: boolean) => void;
  switchModel: (modelId: string) => void;
  selectModel: (modelId: string) => void;
  selectDefaultModel: (modelId: string) => void;
  pickerModels: Model[];
}

export function useModelManagement(deps: UseModelManagementDeps): UseModelManagementResult {
  const {
    chatServiceRef, sessionManagerRef, talkManagerRef,
    activeTalkIdRef, gatewayTalkIdRef,
    currentModel, setCurrentModel, setModelStatus,
    setError, setMessages,
    setShowModelPicker, setShowTalks,
    savedConfig, setSavedConfig,
    pricingRef, probeAbortRef, modelOverrideAbortRef,
    gatewaySetUsage, availableModels,
  } = deps;

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
        setMessages(prev => [...prev, sysMsg]);
      } else {
        setModelStatus({ error: result.reason });
        setError(result.reason);
        const sysMsg = createMessage('system', `Model probe failed: ${result.reason}`);
        setMessages(prev => [...prev, sysMsg]);
        if (previousModel) {
          setCurrentModel(previousModel);
          chatServiceRef.current?.setModel(previousModel);
          sessionManagerRef.current?.setSessionModel(previousModel);
        }
      }
    });
  }, [chatServiceRef, probeAbortRef, setModelStatus, setMessages, setError, setCurrentModel, sessionManagerRef]);

  // Update model pricing when model changes
  useEffect(() => {
    if (chatServiceRef.current) {
      chatServiceRef.current.setModel(currentModel);
      const p = getModelPricing(currentModel);
      pricingRef.current = { inputPer1M: p.input, outputPer1M: p.output };
      gatewaySetUsage(prev => ({
        ...prev,
        modelPricing: { inputPer1M: p.input, outputPer1M: p.output },
      }));
    }
  }, [currentModel, chatServiceRef, pricingRef, gatewaySetUsage]);

  const switchModel = useCallback((modelId: string) => {
    const previousModel = chatServiceRef.current?.getModel();
    setCurrentModel(modelId);
    chatServiceRef.current?.setModel(modelId);
    sessionManagerRef.current?.setSessionModel(modelId);

    if (activeTalkIdRef.current && talkManagerRef.current) {
      talkManagerRef.current.setModel(activeTalkIdRef.current, modelId);

      // Also update the primary agent's model so the status bar stays in sync
      const agents = talkManagerRef.current.getAgents(activeTalkIdRef.current);
      const primary = agents.find(a => a.isPrimary);
      if (primary) {
        primary.model = modelId;
        talkManagerRef.current.setAgents(activeTalkIdRef.current, agents);
      }
    }
    if (gatewayTalkIdRef.current) {
      chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { model: modelId });
    }

    const sysMsg = createMessage('system', `Switching to ${getModelAlias(modelId)}. Checking connection...`);
    setMessages(prev => [...prev, sysMsg]);
    setError(null);

    modelOverrideAbortRef.current?.abort();
    const controller = new AbortController();
    modelOverrideAbortRef.current = controller;
    chatServiceRef.current?.setModelOverride(modelId, controller.signal).catch(() => {});
    probeCurrentModel(modelId, previousModel);
  }, [probeCurrentModel, chatServiceRef, sessionManagerRef, talkManagerRef, activeTalkIdRef, gatewayTalkIdRef, setCurrentModel, setMessages, setError, modelOverrideAbortRef]);

  const selectModel = useCallback((modelId: string) => {
    setShowModelPicker(false);
    switchModel(modelId);
  }, [switchModel, setShowModelPicker]);

  const selectDefaultModel = useCallback((modelId: string) => {
    setShowModelPicker(false);
    setShowTalks(true);
    const config = loadConfig();
    config.defaultModel = modelId;
    saveConfig(config);
    setSavedConfig(prev => ({ ...prev, defaultModel: modelId }));
    setCurrentModel(modelId);
    chatServiceRef.current?.setModel(modelId);
    setError(`Default model set to ${getModelAlias(modelId)}`);
  }, [setShowModelPicker, setShowTalks, setSavedConfig, setCurrentModel, chatServiceRef, setError]);

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

  return {
    probeCurrentModel,
    switchModel,
    selectModel,
    selectDefaultModel,
    pickerModels,
  };
}
