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

export function useGateway(
  chatServiceRef: MutableRefObject<ChatService | null>,
  voiceServiceRef: MutableRefObject<VoiceService | null>,
  anthropicRLRef: MutableRefObject<AnthropicRateLimitService | null>,
  currentModelRef: MutableRefObject<string>,
  callbacks: Callbacks,
) {
  const [gatewayStatus, setGatewayStatus] = useState<'online' | 'offline' | 'connecting'>('connecting');
  const [tailscaleStatus, setTailscaleStatus] = useState<TailscaleStatus | 'checking'>('checking');
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>(MODEL_REGISTRY);
  const [usage, setUsage] = useState<UsageStats>({
    todaySpend: 0,
    averageDailySpend: 0,
    modelPricing: { inputPer1M: 0.14, outputPer1M: 0.28 },
  });
  const [voiceCaps, setVoiceCaps] = useState<VoiceCaps>({
    readiness: 'checking',
    sttAvailable: false,
    ttsAvailable: false,
  });
  const [isInitialized, setIsInitialized] = useState(false);

  // Keep callbacks current via ref to avoid effect re-triggers
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  // Track previous values to avoid unnecessary re-renders
  const prevGatewayStatusRef = useRef(gatewayStatus);
  const prevTailscaleStatusRef = useRef(tailscaleStatus);
  const prevUsageRef = useRef({ todaySpend: 0, weeklySpend: 0, rateLimitsJson: '' });
  const isFirstPollRef = useRef(true);

  useEffect(() => {
    let modelsDiscovered = false;
    let initialProbed = false;
    let providersFetched = false;
    let voiceChecked = false;

    const poll = async () => {
      const chatService = chatServiceRef.current;
      if (!chatService) return;

      const isFirstPoll = isFirstPollRef.current;

      // During first poll, collect updates to batch them
      let pendingTsStatus: TailscaleStatus | 'checking' | null = null;
      let pendingGatewayStatus: 'online' | 'offline' | null = null;

      try {
        const tsStatus = getTailscaleStatus();
        if (isFirstPoll || tsStatus !== prevTailscaleStatusRef.current) {
          prevTailscaleStatusRef.current = tsStatus;
          if (isFirstPoll) {
            pendingTsStatus = tsStatus;
          } else {
            setTailscaleStatus(tsStatus);
          }
        }
      } catch {
        if (isFirstPoll || prevTailscaleStatusRef.current !== 'not-installed') {
          prevTailscaleStatusRef.current = 'not-installed';
          if (isFirstPoll) {
            pendingTsStatus = 'not-installed';
          } else {
            setTailscaleStatus('not-installed');
          }
        }
      }

      try {
        const healthy = await chatService.checkHealth();
        const newGatewayStatus = healthy ? 'online' : 'offline';
        if (isFirstPoll || newGatewayStatus !== prevGatewayStatusRef.current) {
          prevGatewayStatusRef.current = newGatewayStatus;
          if (isFirstPoll) {
            pendingGatewayStatus = newGatewayStatus;
          } else {
            setGatewayStatus(newGatewayStatus);
          }
        }
        if (!healthy) {
          // Apply batched updates for first poll even if unhealthy
          if (isFirstPoll) {
            isFirstPollRef.current = false;
            if (pendingTsStatus !== null) setTailscaleStatus(pendingTsStatus);
            if (pendingGatewayStatus !== null) setGatewayStatus(pendingGatewayStatus);
            setIsInitialized(true);
          }
          return;
        }

        if (!modelsDiscovered) {
          modelsDiscovered = true;
          const ids = await chatService.listModels();
          if (ids && ids.length > 0) {
            const unknown = ids.filter(id => !MODEL_BY_ID[id]).map(buildUnknownModelInfo);
            if (unknown.length > 0) setAvailableModels([...MODEL_REGISTRY, ...unknown]);
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

        // Collect voice caps for batching during first poll
        let pendingVoiceCaps: VoiceCaps | null = null;

        if (!voiceChecked) {
          const voiceService = voiceServiceRef.current;
          const soxOk = voiceService?.checkSoxInstalled() ?? false;
          if (!soxOk) {
            pendingVoiceCaps = { readiness: 'no-sox', sttAvailable: false, ttsAvailable: false };
          } else {
            const caps = await voiceService?.fetchCapabilities();
            if (!caps) {
              pendingVoiceCaps = { readiness: 'no-gateway', sttAvailable: false, ttsAvailable: false };
            } else if (!caps.stt.available) {
              pendingVoiceCaps = { readiness: 'no-stt', sttAvailable: false, ttsAvailable: caps.tts.available };
              voiceChecked = true;
            } else {
              pendingVoiceCaps = { readiness: 'ready', sttAvailable: caps.stt.available, ttsAvailable: caps.tts.available };
              voiceChecked = true;
            }
          }
          if (!isFirstPoll && pendingVoiceCaps) {
            setVoiceCaps(pendingVoiceCaps);
          }
        }

        if (!initialProbed) {
          initialProbed = true;
          cbRef.current.onInitialProbe(currentModelRef.current);
        }

        // Collect all usage updates before applying — React 17 doesn't
        // batch setState in async functions, so multiple setUsage calls
        // cause multiple Ink re-renders (visible as flicker).
        const todayUsage = await chatService.getCostUsage(1);
        const weekUsage = await chatService.getCostUsage(7);

        const provider = getProviderKey(currentModelRef.current);
        let rateLimits = await chatService.getRateLimits(provider);
        if (!rateLimits && provider === 'anthropic' && anthropicRLRef.current) {
          const bareModel = currentModelRef.current.replace(/^anthropic\//, '');
          rateLimits = await anthropicRLRef.current.fetchRateLimits(bareModel);
        }

        // Only update usage if values have actually changed to avoid re-renders
        const weekTotal = weekUsage?.totals?.totalCost ?? 0;
        const todayTotal = todayUsage?.totals?.totalCost ?? 0;
        const rateLimitsJson = rateLimits ? JSON.stringify(rateLimits) : '';
        const hasUsageChanged =
          isFirstPoll ||
          todayTotal !== prevUsageRef.current.todaySpend ||
          weekTotal !== prevUsageRef.current.weeklySpend ||
          rateLimitsJson !== prevUsageRef.current.rateLimitsJson;

        const dailyAvg = weekTotal ? weekTotal / 7 : undefined;
        const pendingUsage = hasUsageChanged ? {
          todaySpend: todayTotal,
          weeklySpend: weekTotal,
          averageDailySpend: dailyAvg ?? 0,
          monthlyEstimate: dailyAvg !== undefined ? dailyAvg * 30 : 0,
          ...(rateLimits ? { rateLimits } : {}),
        } : null;

        if (hasUsageChanged) {
          prevUsageRef.current = { todaySpend: todayTotal, weeklySpend: weekTotal, rateLimitsJson };
        }

        // Apply all batched updates at end of first poll (single re-render)
        if (isFirstPoll) {
          isFirstPollRef.current = false;
          // Batch all state updates together
          if (pendingTsStatus !== null) setTailscaleStatus(pendingTsStatus);
          if (pendingGatewayStatus !== null) setGatewayStatus(pendingGatewayStatus);
          if (pendingVoiceCaps) setVoiceCaps(pendingVoiceCaps);
          if (pendingUsage) setUsage(prev => ({ ...prev, ...pendingUsage }));
          setIsInitialized(true);
        } else if (pendingUsage) {
          setUsage(prev => ({ ...prev, ...pendingUsage }));
        }
      } catch (err) {
        console.debug('Gateway poll failed:', err);
        if (prevGatewayStatusRef.current !== 'offline') {
          prevGatewayStatusRef.current = 'offline';
          setGatewayStatus('offline');
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

  return { gatewayStatus, tailscaleStatus, usage, setUsage, availableModels, voiceCaps, isInitialized };
}
