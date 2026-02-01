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

  // Keep callbacks current via ref to avoid effect re-triggers
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    let modelsDiscovered = false;
    let initialProbed = false;
    let providersFetched = false;
    let voiceChecked = false;

    const poll = async () => {
      const chatService = chatServiceRef.current;
      if (!chatService) return;

      try { setTailscaleStatus(getTailscaleStatus()); }
      catch { setTailscaleStatus('not-installed'); }

      try {
        const healthy = await chatService.checkHealth();
        setGatewayStatus(healthy ? 'online' : 'offline');
        if (!healthy) return;

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

        if (!voiceChecked) {
          const voiceService = voiceServiceRef.current;
          const soxOk = voiceService?.checkSoxInstalled() ?? false;
          if (!soxOk) {
            setVoiceCaps(prev => ({ ...prev, readiness: 'no-sox' }));
          } else {
            const caps = await voiceService?.fetchCapabilities();
            if (!caps) {
              setVoiceCaps(prev => ({ ...prev, readiness: 'no-gateway' }));
            } else if (!caps.stt.available) {
              setVoiceCaps({ readiness: 'no-stt', sttAvailable: false, ttsAvailable: caps.tts.available });
              voiceChecked = true;
            } else {
              setVoiceCaps({ readiness: 'ready', sttAvailable: caps.stt.available, ttsAvailable: caps.tts.available });
              voiceChecked = true;
            }
          }
        }

        if (!initialProbed) {
          initialProbed = true;
          cbRef.current.onInitialProbe(currentModelRef.current);
        }

        const todayUsage = await chatService.getCostUsage(1);
        const weekUsage = await chatService.getCostUsage(7);
        if (todayUsage || weekUsage) {
          const weekTotal = weekUsage?.totals?.totalCost;
          const dailyAvg = weekTotal ? weekTotal / 7 : undefined;
          setUsage(prev => ({
            ...prev,
            todaySpend: todayUsage?.totals?.totalCost ?? prev.todaySpend ?? 0,
            weeklySpend: weekTotal ?? prev.weeklySpend ?? 0,
            averageDailySpend: dailyAvg ?? prev.averageDailySpend ?? 0,
            monthlyEstimate: dailyAvg !== undefined ? dailyAvg * 30 : prev.monthlyEstimate ?? 0,
          }));
        }

        const provider = getProviderKey(currentModelRef.current);
        let rateLimits = await chatService.getRateLimits(provider);
        if (!rateLimits && provider === 'anthropic' && anthropicRLRef.current) {
          const bareModel = currentModelRef.current.replace(/^anthropic\//, '');
          rateLimits = await anthropicRLRef.current.fetchRateLimits(bareModel);
        }
        if (rateLimits) setUsage(prev => ({ ...prev, rateLimits }));
      } catch (err) {
        console.debug('Gateway poll failed:', err);
        setGatewayStatus('offline');
      }
    };

    poll();
    const interval = setInterval(poll, GATEWAY_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return { gatewayStatus, tailscaleStatus, usage, setUsage, availableModels, voiceCaps };
}
