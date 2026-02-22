/**
 * Agent management hook.
 *
 * Manages multi-agent functionality: syncing agents to the gateway,
 * adding/removing agents, role selection, streaming agent responses,
 * multi-agent messaging with follow-up rounds, and agent commands
 * (/agent add, /agent role, /agent remove, /agent list, /agent ask,
 * /debate, /review).
 *
 * Extracted from app.tsx lines 753-860 and 2910-3277.
 */

import { useCallback } from 'react';
import type React from 'react';
import type { Message, TalkAgent, AgentRole } from '../../types.js';
import { AGENT_ROLES, ROLE_BY_ID, AGENT_PREAMBLE, generateAgentName } from '../../agent-roles.js';
import type { RoleTemplate } from '../../agent-roles.js';
import { getModelAlias, ALIAS_TO_MODEL_ID } from '../../models.js';
import type { ChatService } from '../../services/chat.js';
import type { TalkManager } from '../../services/talks.js';
import { createMessage } from '../helpers.js';

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface UseAgentManagementDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  activeTalkIdRef: React.MutableRefObject<string | null>;
  gatewayTalkIdRef: React.MutableRefObject<string | null>;
  currentModel: string;
  setError: (msg: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  messages: Message[];
  setShowRolePicker: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingAgentModelId: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingSlashAgent: React.Dispatch<React.SetStateAction<{ model: string; role: AgentRole } | null>>;
  setStreamingAgentName: React.Dispatch<React.SetStateAction<string | undefined>>;
  setRolePickerPhase: React.Dispatch<React.SetStateAction<'primary' | 'new-agent'>>;
  pendingAgentModelId: string | null;
  pendingSlashAgent: { model: string; role: AgentRole } | null;
  rolePickerPhase: 'primary' | 'new-agent';
  primaryAgentRef: React.MutableRefObject<TalkAgent | null>;
  scrollToBottom: () => void;
  setShowModelPicker: React.Dispatch<React.SetStateAction<boolean>>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentManagement(deps: UseAgentManagementDeps) {
  const {
    chatServiceRef,
    talkManagerRef,
    activeTalkIdRef,
    gatewayTalkIdRef,
    currentModel,
    setError,
    setMessages,
    messages,
    setShowRolePicker,
    setPendingAgentModelId,
    setPendingSlashAgent,
    setStreamingAgentName,
    setRolePickerPhase,
    pendingAgentModelId,
    pendingSlashAgent,
    rolePickerPhase,
    primaryAgentRef,
    scrollToBottom,
    setShowModelPicker,
  } = deps;

  // -------------------------------------------------------------------------
  // syncAgentsToGateway
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // handleAddAgentRequest
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // handleRoleSelected
  // -------------------------------------------------------------------------

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
        setMessages(prev => [...prev, sysMsg]);
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
    setMessages(prev => [...prev, sysMsg]);
  }, [rolePickerPhase, pendingAgentModelId, pendingSlashAgent, currentModel, syncAgentsToGateway]);

  // -------------------------------------------------------------------------
  // streamAgentResponse
  // -------------------------------------------------------------------------

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
      setMessages(prev => [...prev, indicatorMsg]);
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
          setMessages(prev => [...prev, toolMsg]);
        } else if (chunk.type === 'tool_end') {
          const status = chunk.success ? 'OK' : 'ERROR';
          const preview = chunk.content.slice(0, 150) + (chunk.content.length > 150 ? '...' : '');
          const toolMsg = createMessage('system', `[${agent.name} → Tool ${status}] ${chunk.name} (${chunk.durationMs}ms): ${preview}`);
          setMessages(prev => [...prev, toolMsg]);
        } else if (chunk.type === 'status') {
          const prefix = chunk.level === 'warn' || chunk.level === 'error' ? 'Status' : 'Info';
          const statusMsg = createMessage('system', `[${agent.name} → ${prefix}] ${chunk.message}`);
          setMessages(prev => [...prev, statusMsg]);
        }
      }

      if (!isStillOnSameTalk()) return fullContent;

      if (fullContent.trim()) {
        const model = chatServiceRef.current!.lastResponseModel ?? agent.model;
        const assistantMsg = createMessage('assistant', fullContent, model, agent.name, agent.role);
        setMessages(prev => {
          const filtered = prev.filter(m => m.id !== indicatorMsg.id);
          return [...filtered, assistantMsg];
        });
      } else {
        setMessages(prev => prev.filter(m => m.id !== indicatorMsg.id));
      }
      return fullContent;
    } catch (err) {
      if (!isStillOnSameTalk()) return '';

      // --- Retry on transient errors (max 1 retry) ---
      const { isTransientError, GatewayStreamError } = await import('../../services/chat.js');
      if (retryAttempt === 0 && isTransientError(err)) {
        const partialContent = err instanceof GatewayStreamError ? err.partialContent : '';

        if (!isStillOnSameTalk()) return '';

        // Update indicator to show retry
        const retryIndicator = createMessage('system', `${agent.name}: retrying...`);
        setMessages(prev => {
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
        setMessages(prev => prev.filter(m => m.id !== retryIndicator.id));

        // Combine partial + retry content
        const combined = (partialContent + retryContent).trim();
        if (combined) {
          const model = chatServiceRef.current!.lastResponseModel ?? agent.model;
          const assistantMsg = createMessage('assistant', combined, model, agent.name, agent.role);
          setMessages(prev => {
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
      setMessages(prev => {
        const filtered = prev.filter(m => m.id !== indicatorMsg.id);
        return [...filtered, errMsg];
      });
      return '';
    }
  }, []);

  // -------------------------------------------------------------------------
  // findMentionedAgents
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // sendMultiAgentMessage
  // -------------------------------------------------------------------------

  const sendMultiAgentMessage = useCallback(async (text: string, targetAgents: TalkAgent[], allAgents: TalkAgent[]) => {
    const gwTalkId = gatewayTalkIdRef.current;
    if (!gwTalkId || !chatServiceRef.current) {
      setError('Multi-agent requires a gateway-synced talk');
      return;
    }

    const isStillOnSameTalk = () => gatewayTalkIdRef.current === gwTalkId;

    // Add user message
    const userMsg = createMessage('user', text);
    setMessages(prev => [...prev, userMsg]);
    scrollToBottom();

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
  }, [streamAgentResponse, findMentionedAgents]);

  // -------------------------------------------------------------------------
  // handleAddAgentCommand
  // -------------------------------------------------------------------------

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
    setMessages(prev => [...prev, sysMsg]);
  }, [currentModel, syncAgentsToGateway]);

  // -------------------------------------------------------------------------
  // handleChangeAgentRole
  // -------------------------------------------------------------------------

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
      setMessages(prev => [...prev, sysMsg]);
    } else {
      setError(`Agent "${name}" not found`);
    }
  }, [syncAgentsToGateway]);

  // -------------------------------------------------------------------------
  // handleRemoveAgent
  // -------------------------------------------------------------------------

  const handleRemoveAgent = useCallback((name: string) => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const success = talkManagerRef.current.removeAgent(talkId, name);
    if (success) {
      const agents = talkManagerRef.current.getAgents(talkId);
      syncAgentsToGateway(agents);
      const sysMsg = createMessage('system', `Agent removed: ${name}`);
      setMessages(prev => [...prev, sysMsg]);
    } else {
      setError(`Cannot remove "${name}" — not found or is primary agent`);
    }
  }, [syncAgentsToGateway]);

  // -------------------------------------------------------------------------
  // handleListAgents
  // -------------------------------------------------------------------------

  const handleListAgents = useCallback(() => {
    const talkId = activeTalkIdRef.current;
    if (!talkId || !talkManagerRef.current) return;

    const agents = talkManagerRef.current.getAgents(talkId);
    if (agents.length === 0) {
      const sysMsg = createMessage('system', 'No agents configured. Use /agent add <model> <role> or ^K → A to add one.');
      setMessages(prev => [...prev, sysMsg]);
      return;
    }
    const lines = agents.map((a, i) => {
      const primary = a.isPrimary ? ' (primary)' : '';
      const alias = getModelAlias(a.model);
      return `  ${i + 1}. ${a.name} — ${ROLE_BY_ID[a.role]?.label ?? a.role} [${alias}]${primary}`;
    });
    const sysMsg = createMessage('system', `Agents:\n${lines.join('\n')}`);
    setMessages(prev => [...prev, sysMsg]);
  }, []);

  // -------------------------------------------------------------------------
  // handleAskAgent
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // handleDebateAll
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // handleReviewLast
  // -------------------------------------------------------------------------

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
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) {
      setError('No assistant message to review');
      return;
    }

    const reviewPrompt = `Please review and critique the following response:\n\n${lastAssistant.content}`;
    await sendMultiAgentMessage(reviewPrompt, nonPrimary, agents);
  }, [sendMultiAgentMessage, messages]);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    syncAgentsToGateway,
    handleAddAgentRequest,
    handleRoleSelected,
    streamAgentResponse,
    findMentionedAgents,
    sendMultiAgentMessage,
    handleAddAgentCommand,
    handleChangeAgentRole,
    handleRemoveAgent,
    handleListAgents,
    handleAskAgent,
    handleDebateAll,
    handleReviewLast,
  };
}
