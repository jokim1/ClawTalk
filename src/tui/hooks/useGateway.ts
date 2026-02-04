/**
 * Gateway connection, health polling, and service discovery hook
 *
 * Polls the gateway for health, discovers models and providers,
 * checks voice capabilities, and fetches usage/rate-limit data.
 */

import { useState, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { UsageStats, VoiceReadiness } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { VoiceService } from '../../services/voice.js';
import type { AnthropicRateLimitService } from '../../services/anthropic-ratelimit.js';
import type { BillingOverride } from '../../config.js';
import { getStatus as getTailscaleStatus } from '../../services/tailscale.js';
import type { TailscaleStatus } from '../../services/tailscale.js';
import {
  MODEL_REGISTRY,
  MODEL_BY_ID,
  getProviderKey,
  buildUnknownModelInfo,
} from '../../models.js';
import type { ModelInfo } from '../../models.js';
import { GATEWAY_POLL_INTERVAL_MS } from '../../constants.js';

export interface VoiceCaps {
  readiness: VoiceReadiness;
  sttAvailable: boolean;
  ttsAvailable: boolean;
}

interface Callbacks {
  onInitialProbe: (model: string) => void;
  onBillingDiscovered: (billing: Record<string, BillingOverride>) => void;
}

// Combined state to enable atomic updates (React 17 doesn't batch in async)
interface GatewayState {
  gatewayStatus: 'online' | 'offline' | 'connecting';
  tailscaleStatus: TailscaleStatus | 'checking';
  availableModels: ModelInfo[];
  usage: UsageStats;
  voiceCaps: VoiceCaps;
  isInitialized: boolean;
}

const initialState: GatewayState = {
  gatewayStatus: 'connecting',
  tailscaleStatus: 'checking',
  availableModels: MODEL_REGISTRY,
  usage: {
    todaySpend: 0,
    averageDailySpend: 0,
    modelPricing: { inputPer1M: 0.14, outputPer1M: 0.28 },
  },
  voiceCaps: {
    readiness: 'checking',
    sttAvailable: false,
    ttsAvailable: false,
  },
  isInitialized: false,
};

export function useGateway(
  chatServiceRef: MutableRefObject<ChatService | null>,
  voiceServiceRef: MutableRefObject<VoiceService | null>,
  anthropicRLRef: MutableRefObject<AnthropicRateLimitService | null>,
  currentModelRef: MutableRefObject<string>,
  callbacks: Callbacks,
) {
  const [state, setState] = useState<GatewayState>(initialState);

  // Keep callbacks current via ref to avoid effect re-triggers
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  // Track previous values to avoid unnecessary re-renders
  const prevGatewayStatusRef = useRef(state.gatewayStatus);
  const prevTailscaleStatusRef = useRef(state.tailscaleStatus);
  const prevUsageRef = useRef({ todaySpend: 0, weeklySpend: 0, rateLimitsJson: '' });
  const isFirstPollRef = useRef(true);

  // Wrapper for backward compatibility with app.tsx setUsage calls
  const setUsage = (updater: UsageStats | ((prev: UsageStats) => UsageStats)) => {
    setState(prev => ({
      ...prev,
      usage: typeof updater === 'function' ? updater(prev.usage) : updater,
    }));
  };

  useEffect(() => {
    let modelsDiscovered = false;
    let initialProbed = false;
    let providersFetched = false;
    let voiceChecked = false;

    const poll = async () => {
      const chatService = chatServiceRef.current;
      if (!chatService) return;

      const isFirstPoll = isFirstPollRef.current;

      // Collect all state changes to apply atomically
      const updates: Partial<GatewayState> = {};

      try {
        const tsStatus = getTailscaleStatus();
        if (tsStatus !== prevTailscaleStatusRef.current) {
          prevTailscaleStatusRef.current = tsStatus;
          updates.tailscaleStatus = tsStatus;
        }
      } catch {
        if (prevTailscaleStatusRef.current !== 'not-installed') {
          prevTailscaleStatusRef.current = 'not-installed';
          updates.tailscaleStatus = 'not-installed';
        }
      }

      try {
        const healthy = await chatService.checkHealth();
        const newGatewayStatus = healthy ? 'online' : 'offline';
        if (newGatewayStatus !== prevGatewayStatusRef.current) {
          prevGatewayStatusRef.current = newGatewayStatus;
          updates.gatewayStatus = newGatewayStatus;
        }
        if (!healthy) {
          // Apply updates and mark initialized even if unhealthy
          if (isFirstPoll) {
            isFirstPollRef.current = false;
            updates.isInitialized = true;
            setState(prev => ({ ...prev, ...updates }));
          } else if (Object.keys(updates).length > 0) {
            setState(prev => ({ ...prev, ...updates }));
          }
          return;
        }

        if (!modelsDiscovered) {
          modelsDiscovered = true;
          const ids = await chatService.listModels();
          if (ids && ids.length > 0) {
            const unknown = ids.filter(id => !MODEL_BY_ID[id]).map(buildUnknownModelInfo);
            if (unknown.length > 0) {
              updates.availableModels = [...MODEL_REGISTRY, ...unknown];
            }
          }
        }

        if (!providersFetched) {
          providersFetched = true;
          const providers = await chatService.getProviders();
          if (providers && providers.length > 0) {
            const billing: Record<string, BillingOverride> = {};
            for (const p of providers) billing[p.id] = p.billing;
            cbRef.current.onBillingDiscovered(billing);
          }
        }

        if (!voiceChecked) {
          const voiceService = voiceServiceRef.current;
          const soxOk = voiceService?.checkSoxInstalled() ?? false;
          if (!soxOk) {
            updates.voiceCaps = { readiness: 'no-sox', sttAvailable: false, ttsAvailable: false };
          } else {
            const caps = await voiceService?.fetchCapabilities();
            if (!caps) {
              updates.voiceCaps = { readiness: 'no-gateway', sttAvailable: false, ttsAvailable: false };
            } else if (!caps.stt.available) {
              updates.voiceCaps = { readiness: 'no-stt', sttAvailable: false, ttsAvailable: caps.tts.available };
              voiceChecked = true;
            } else {
              updates.voiceCaps = { readiness: 'ready', sttAvailable: caps.stt.available, ttsAvailable: caps.tts.available };
              voiceChecked = true;
            }
          }
        }

        if (!initialProbed) {
          initialProbed = true;
          // Defer probe callback until after state update to avoid interleaved renders
          setTimeout(() => cbRef.current.onInitialProbe(currentModelRef.current), 0);
        }

        // Collect usage updates
        const todayUsage = await chatService.getCostUsage(1);
        const weekUsage = await chatService.getCostUsage(7);

        const provider = getProviderKey(currentModelRef.current);
        let rateLimits = await chatService.getRateLimits(provider);
        if (!rateLimits && provider === 'anthropic' && anthropicRLRef.current) {
          const bareModel = currentModelRef.current.replace(/^anthropic\//, '');
          rateLimits = await anthropicRLRef.current.fetchRateLimits(bareModel);
        }

        const weekTotal = weekUsage?.totals?.totalCost ?? 0;
        const todayTotal = todayUsage?.totals?.totalCost ?? 0;
        const rateLimitsJson = rateLimits ? JSON.stringify(rateLimits) : '';
        const hasUsageChanged =
          isFirstPoll ||
          todayTotal !== prevUsageRef.current.todaySpend ||
          weekTotal !== prevUsageRef.current.weeklySpend ||
          rateLimitsJson !== prevUsageRef.current.rateLimitsJson;

        if (hasUsageChanged) {
          prevUsageRef.current = { todaySpend: todayTotal, weeklySpend: weekTotal, rateLimitsJson };
          const dailyAvg = weekTotal ? weekTotal / 7 : undefined;
          // Note: usage update is merged in setState, preserving modelPricing from app.tsx
          updates.usage = {
            todaySpend: todayTotal,
            weeklySpend: weekTotal,
            averageDailySpend: dailyAvg ?? 0,
            monthlyEstimate: dailyAvg !== undefined ? dailyAvg * 30 : 0,
            ...(rateLimits ? { rateLimits } : {}),
          } as UsageStats;
        }

        // Apply all updates atomically in a single setState call
        if (isFirstPoll) {
          isFirstPollRef.current = false;
          updates.isInitialized = true;
        }

        if (Object.keys(updates).length > 0) {
          setState(prev => ({
            ...prev,
            ...updates,
            // Merge usage to preserve modelPricing from app.tsx
            usage: updates.usage ? { ...prev.usage, ...updates.usage } : prev.usage,
          }));
        }
      } catch (err) {
        console.debug('Gateway poll failed:', err);
        if (prevGatewayStatusRef.current !== 'offline') {
          prevGatewayStatusRef.current = 'offline';
          setState(prev => ({ ...prev, gatewayStatus: 'offline' }));
        }
      }
    };

    // Defer first poll to next macrotask so all useEffects (including
    // service initialization in app.tsx) complete first. Without this,
    // chatServiceRef/voiceServiceRef are null on first poll, causing
    // voice readiness to stay stuck at 'checking' for 30s.
    const initial = setTimeout(poll, 0);
    const interval = setInterval(poll, GATEWAY_POLL_INTERVAL_MS);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, []);

  // Extract individual values for backward compatibility
  return {
    gatewayStatus: state.gatewayStatus,
    tailscaleStatus: state.tailscaleStatus,
    usage: state.usage,
    setUsage,
    availableModels: state.availableModels,
    voiceCaps: state.voiceCaps,
    isInitialized: state.isInitialized,
  };
}
