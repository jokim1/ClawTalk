/**
 * Platform bindings hook.
 *
 * Directives, platform binding CRUD, channel response settings handlers,
 * Slack hints loading, and gateway binding sync.
 */

import { useCallback, useState } from 'react';
import type {
  Message, PlatformBinding, PlatformBehavior, PlatformPermission,
} from '../../types.js';
import type { ChatService, SlackAccountOption, SlackChannelOption } from '../../services/chat.js';
import type { TalkManager } from '../../services/talks.js';
import { createMessage } from '../helpers.js';
import { formatBindingScopeLabel, formatPostingPriority } from '../formatters.js';

export interface UsePlatformBindingsDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  activeTalkId: string | null;
  activeTalkIdRef: React.MutableRefObject<string | null>;
  gatewayTalkIdRef: React.MutableRefObject<string | null>;
  currentModelRef: React.MutableRefObject<string>;
  setError: (msg: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export interface UsePlatformBindingsResult {
  slackAccountHints: SlackAccountOption[];
  slackChannelsByAccount: Record<string, SlackChannelOption[]>;
  slackHintsLoading: boolean;
  slackHintsError: string | null;
  loadSlackHints: () => Promise<void>;
  handleAddDirective: (text: string) => void;
  handleEditDirective: (index: number, text: string) => void;
  handleRemoveDirective: (index: number) => void;
  handleToggleDirective: (index: number) => void;
  handleListDirectives: () => void;
  handleAddPlatformBinding: (platform: string, scope: string, permission: string) => void;
  handleRemovePlatformBinding: (index: number) => void;
  handleUpdatePlatformBinding: (index: number, updates: Partial<Pick<PlatformBinding, 'platform' | 'scope' | 'permission'>>) => void;
  handleListPlatformBindings: () => void;
  handleListChannelResponses: () => void;
  handleSetChannelResponseMode: (index: number, mode: 'off' | 'mentions' | 'all') => void;
  handleSetChannelDeliveryMode: (index: number, deliveryMode: 'thread' | 'channel' | 'adaptive') => void;
  handleSetChannelMirrorToTalk: (index: number, mirrorToTalk: 'off' | 'inbound' | 'full') => void;
  handleSetChannelResponseEnabled: (index: number, enabled: boolean) => void;
  handleSetChannelResponsePrompt: (index: number, prompt: string) => void;
  handleSetChannelResponseAgent: (index: number, agentName: string) => void;
  handleSetChannelResponseAgentChoice: (index: number, agentName?: string) => void;
  handleClearChannelResponse: (index: number) => void;
}

export function usePlatformBindings(deps: UsePlatformBindingsDeps): UsePlatformBindingsResult {
  const {
    chatServiceRef, talkManagerRef,
    activeTalkId, activeTalkIdRef, gatewayTalkIdRef, currentModelRef,
    setError, setMessages,
  } = deps;

  // --- Slack hints state ---
  const [slackAccountHints, setSlackAccountHints] = useState<SlackAccountOption[]>([]);
  const [slackChannelsByAccount, setSlackChannelsByAccount] = useState<Record<string, SlackChannelOption[]>>({});
  const [slackHintsLoading, setSlackHintsLoading] = useState(false);
  const [slackHintsError, setSlackHintsError] = useState<string | null>(null);

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
  }, [chatServiceRef]);

  // --- Gateway binding sync ---

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
  }, [chatServiceRef, talkManagerRef, gatewayTalkIdRef, currentModelRef, setError]);

  const restoreTalkRoutingState = useCallback((talkId: string, bindings: PlatformBinding[], behaviors: PlatformBehavior[]) => {
    if (!talkManagerRef.current) return;
    const talk = talkManagerRef.current.getTalk(talkId);
    if (!talk) return;
    talk.platformBindings = bindings;
    talk.platformBehaviors = behaviors;
    talk.updatedAt = Date.now();
    talkManagerRef.current.saveTalk(talkId);
  }, [talkManagerRef]);

  // --- Directive handlers ---

  const handleAddDirective = useCallback((text: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);

    const directive = talkManagerRef.current.addDirective(activeTalkId, text);
    if (!directive) { setError('Failed to add rule'); return; }

    const sysMsg = createMessage('system', `Rule added: ${text}`);
    setMessages(prev => [...prev, sysMsg]);

    if (gatewayTalkIdRef.current && chatServiceRef.current) {
      const directives = talkManagerRef.current.getDirectives(activeTalkId);
      chatServiceRef.current.updateGatewayTalk(gatewayTalkIdRef.current, { directives });
    }
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setError, setMessages]);

  const handleEditDirective = useCallback((index: number, text: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;

    const success = talkManagerRef.current.editDirective(activeTalkId, index, text);
    if (!success) { setError(`No rule at position ${index}`); return; }

    const sysMsg = createMessage('system', `Rule #${index} updated.`);
    setMessages(prev => [...prev, sysMsg]);

    if (gatewayTalkIdRef.current && chatServiceRef.current) {
      const directives = talkManagerRef.current.getDirectives(activeTalkId);
      chatServiceRef.current.updateGatewayTalk(gatewayTalkIdRef.current, { directives });
    }
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setError, setMessages]);

  const handleRemoveDirective = useCallback((index: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;

    const success = talkManagerRef.current.removeDirective(activeTalkId, index);
    if (!success) { setError(`No rule at position ${index}`); return; }

    const sysMsg = createMessage('system', `Rule #${index} deleted.`);
    setMessages(prev => [...prev, sysMsg]);

    if (gatewayTalkIdRef.current && chatServiceRef.current) {
      const directives = talkManagerRef.current.getDirectives(activeTalkId);
      chatServiceRef.current.updateGatewayTalk(gatewayTalkIdRef.current, { directives });
    }
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setError, setMessages]);

  const handleToggleDirective = useCallback((index: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;

    const success = talkManagerRef.current.toggleDirective(activeTalkId, index);
    if (!success) { setError(`No rule at position ${index}`); return; }

    const directives = talkManagerRef.current.getDirectives(activeTalkId);
    const d = directives[index - 1];
    const status = d?.active ? 'active' : 'paused';
    const sysMsg = createMessage('system', `Rule #${index} ${status}.`);
    setMessages(prev => [...prev, sysMsg]);

    if (gatewayTalkIdRef.current && chatServiceRef.current) {
      chatServiceRef.current.updateGatewayTalk(gatewayTalkIdRef.current, { directives });
    }
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setError, setMessages]);

  const handleListDirectives = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const directives = talkManagerRef.current.getDirectives(activeTalkId);
    if (directives.length === 0) {
      const sysMsg = createMessage('system', 'No rules for this talk. Use /rule <text> to add one.');
      setMessages(prev => [...prev, sysMsg]);
      return;
    }
    const lines = directives.map((d, i) => {
      const status = d.active ? 'active' : 'paused';
      return `  ${i + 1}. [${status}] ${d.text}`;
    });
    const sysMsg = createMessage('system', `Rules:\n${lines.join('\n')}`);
    setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId, talkManagerRef, setMessages]);

  // --- Platform binding handlers ---

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
        setMessages(prev => [...prev, failMsg]);
        return;
      }

      const latest = talkManagerRef.current?.getPlatformBindings(activeTalkId).find((row) => row.id === binding.id) ?? binding;
      const sysMsg = createMessage(
        'system',
        `Channel connection added: ${latest.platform} ${formatBindingScopeLabel(latest)} (${latest.permission})`,
      );
      setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, syncTalkBindingsToGateway, talkManagerRef, setError, setMessages]);

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
        setMessages(prev => [...prev, failMsg]);
        return;
      }

      const sysMsg = createMessage('system', `Channel connection #${index} removed.`);
      setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, restoreTalkRoutingState, syncTalkBindingsToGateway, talkManagerRef, setError, setMessages]);

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
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setError]);

  const handleListPlatformBindings = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const bindings = talkManagerRef.current.getPlatformBindings(activeTalkId);
    if (bindings.length === 0) {
      const sysMsg = createMessage(
        'system',
        'No channel connections for this talk. Press ^B to open Channel Config (Slack full support; Telegram/WhatsApp for event jobs).',
      );
      setMessages(prev => [...prev, sysMsg]);
      return;
    }
    const lines = bindings.map((b, i) =>
      `  ${i + 1}. platform${i + 1}: ${b.platform} ${formatBindingScopeLabel(b)} (${b.permission})`
    );
    const sysMsg = createMessage('system', `Channel connections:\n${lines.join('\n')}`);
    setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId, talkManagerRef, setMessages]);

  // --- Channel response settings handlers ---

  const handleListChannelResponses = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const bindings = talkManagerRef.current.getPlatformBindings(activeTalkId);
    if (bindings.length === 0) {
      const sysMsg = createMessage('system', 'No channel connections yet. Press ^B to add one.');
      setMessages(prev => [...prev, sysMsg]);
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
    setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId, talkManagerRef, setMessages]);

  /** Helper: update behavior with gateway sync and rollback on failure. */
  const updateBehaviorWithSync = useCallback((
    index: number,
    updates: Record<string, unknown>,
    successMessage: string,
  ) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const prevBindings = talkManagerRef.current.getPlatformBindings(activeTalkId).map((row) => ({ ...row }));
    const prevBehaviors = talkManagerRef.current.getPlatformBehaviors(activeTalkId).map((row) => ({ ...row }));
    const ok = talkManagerRef.current.upsertPlatformBehaviorByBindingIndex(activeTalkId, index, updates);
    if (!ok) {
      setError(`No channel connection at position ${index}`);
      return;
    }
    void (async () => {
      const synced = await syncTalkBindingsToGateway(activeTalkId);
      if (!synced) {
        restoreTalkRoutingState(activeTalkId, prevBindings, prevBehaviors);
        const failMsg = createMessage('system', 'Failed to save channel response settings; reverted local change.');
        setMessages(prev => [...prev, failMsg]);
        return;
      }
      const sysMsg = createMessage('system', successMessage);
      setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, syncTalkBindingsToGateway, restoreTalkRoutingState, talkManagerRef, setError, setMessages]);

  const handleSetChannelResponseMode = useCallback((index: number, mode: 'off' | 'mentions' | 'all') => {
    updateBehaviorWithSync(index, { responseMode: mode }, `Channel response #${index} mode set to ${mode}.`);
  }, [updateBehaviorWithSync]);

  const handleSetChannelDeliveryMode = useCallback((index: number, deliveryMode: 'thread' | 'channel' | 'adaptive') => {
    updateBehaviorWithSync(
      index,
      { deliveryMode },
      `Channel response #${index} Posting Priority set to ${formatPostingPriority(deliveryMode)}.`,
    );
  }, [updateBehaviorWithSync]);

  const handleSetChannelMirrorToTalk = useCallback((index: number, mirrorToTalk: 'off' | 'inbound' | 'full') => {
    updateBehaviorWithSync(
      index,
      { mirrorToTalk },
      `Channel response #${index} Slack Message Mirroring set to ${mirrorToTalk}.`,
    );
  }, [updateBehaviorWithSync]);

  const handleSetChannelResponseEnabled = useCallback((index: number, enabled: boolean) => {
    handleSetChannelResponseMode(index, enabled ? 'all' : 'off');
  }, [handleSetChannelResponseMode]);

  const handleSetChannelResponsePrompt = useCallback((index: number, prompt: string) => {
    updateBehaviorWithSync(
      index,
      { responseMode: 'all', onMessagePrompt: prompt },
      `Channel response prompt set for connection #${index}.`,
    );
  }, [updateBehaviorWithSync]);

  const handleSetChannelResponseAgent = useCallback((index: number, agentName: string) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.saveTalk(activeTalkId);
    const agents = talkManagerRef.current.getAgents(activeTalkId);
    const matched = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
    if (!matched) {
      setError(`Unknown agent "${agentName}". Use /agents to list names.`);
      return;
    }
    updateBehaviorWithSync(
      index,
      { agentName: matched.name },
      `Channel response agent for connection #${index}: ${matched.name}`,
    );
  }, [activeTalkId, talkManagerRef, setError, updateBehaviorWithSync]);

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

      if (!existing) return;

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
          setMessages(prev => [...prev, failMsg]);
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
        setMessages(prev => [...prev, failMsg]);
      }
    })();
  }, [activeTalkId, syncTalkBindingsToGateway, restoreTalkRoutingState, talkManagerRef, setError, setMessages]);

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
        setMessages(prev => [...prev, failMsg]);
        return;
      }
      const sysMsg = createMessage('system', `Channel response settings cleared for connection #${index}.`);
      setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, syncTalkBindingsToGateway, restoreTalkRoutingState, talkManagerRef, setError, setMessages]);

  return {
    slackAccountHints,
    slackChannelsByAccount,
    slackHintsLoading,
    slackHintsError,
    loadSlackHints,
    handleAddDirective,
    handleEditDirective,
    handleRemoveDirective,
    handleToggleDirective,
    handleListDirectives,
    handleAddPlatformBinding,
    handleRemovePlatformBinding,
    handleUpdatePlatformBinding,
    handleListPlatformBindings,
    handleListChannelResponses,
    handleSetChannelResponseMode,
    handleSetChannelDeliveryMode,
    handleSetChannelMirrorToTalk,
    handleSetChannelResponseEnabled,
    handleSetChannelResponsePrompt,
    handleSetChannelResponseAgent,
    handleSetChannelResponseAgentChoice,
    handleClearChannelResponse,
  };
}
