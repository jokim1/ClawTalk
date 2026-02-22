/**
 * Talk handlers hook.
 *
 * Save, rename, delete, pin/unpin, objectives, reports, playbook,
 * export, edit messages, and delete messages.
 */

import { useCallback } from 'react';
import type { Message, PlatformBinding, PlatformBehavior } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { SessionManager } from '../../services/sessions.js';
import type { TalkManager } from '../../services/talks.js';
import type { Talk } from '../../types.js';
import { createMessage } from '../helpers.js';
import { exportTranscript, exportTranscriptMd, exportTranscriptDocx } from '../utils.js';
import { formatBindingScopeLabel, formatPostingPriority } from '../formatters.js';

export interface UseTalkHandlersDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  sessionManagerRef: React.MutableRefObject<SessionManager | null>;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  activeTalkId: string | null;
  activeTalkIdRef: React.MutableRefObject<string | null>;
  gatewayTalkIdRef: React.MutableRefObject<string | null>;
  setError: (msg: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  messages: Message[];
  setShowEditMessages: React.Dispatch<React.SetStateAction<boolean>>;
  savedConfig: { exportDir?: string };
  resolveGatewayJobByIndex: (index: number) => Promise<{ jobId: string; jobs: any[] } | null>;
}

export interface UseTalkHandlersResult {
  handleSaveTalk: (title?: string) => void;
  handleSetTopicTitle: (title: string) => void;
  handlePinMessage: (fromBottom?: number) => void;
  handleUnpinMessage: (fromBottom?: number) => void;
  handleListPins: () => void;
  handleSetObjective: (text: string | undefined) => void;
  handleShowObjective: () => void;
  handleViewReports: (jobIndex?: number) => void;
  handleShowPlaybook: () => void;
  handleExportTalk: (format?: string, lastN?: number) => void;
  handleEditMessages: () => void;
  handleConfirmDeleteMessages: (messageIds: string[]) => Promise<void>;
  handleRenameTalk: (talkId: string, title: string) => void;
  handleDeleteTalk: (talkId: string) => void;
  addSystemMessage: (text: string) => void;
}

export function useTalkHandlers(deps: UseTalkHandlersDeps): UseTalkHandlersResult {
  const {
    chatServiceRef, sessionManagerRef, talkManagerRef,
    activeTalkId, activeTalkIdRef, gatewayTalkIdRef,
    setError, setMessages, messages,
    setShowEditMessages, savedConfig, resolveGatewayJobByIndex,
  } = deps;

  const addSystemMessage = useCallback((text: string) => {
    const sysMsg = createMessage('system', text);
    setMessages(prev => [...prev, sysMsg]);
  }, [setMessages]);

  const handleSaveTalk = useCallback((title?: string) => {
    if (activeTalkId && talkManagerRef.current) {
      const success = talkManagerRef.current.saveTalk(activeTalkId);
      if (success) {
        const text = title ? `Chat saved as "${title}"` : 'Chat saved to Talks.';
        if (title) {
          talkManagerRef.current.setTopicTitle(activeTalkId, title);
          if (gatewayTalkIdRef.current) {
            chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { topicTitle: title });
          }
        }
        const sysMsg = createMessage('system', text);
        setMessages(prev => [...prev, sysMsg]);
      } else {
        setError('Failed to save talk');
      }
    }
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setMessages, setError]);

  const handleSetTopicTitle = useCallback((title: string) => {
    if (activeTalkId && talkManagerRef.current) {
      const success = talkManagerRef.current.setTopicTitle(activeTalkId, title);
      if (success) {
        if (gatewayTalkIdRef.current) {
          chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { topicTitle: title });
        }
        const sysMsg = createMessage('system', `Topic set to: ${title}`);
        setMessages(prev => [...prev, sysMsg]);
      } else {
        setError('Failed to set topic');
      }
    }
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setMessages, setError]);

  const handlePinMessage = useCallback((fromBottom?: number) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
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
      if (gatewayTalkIdRef.current) {
        chatServiceRef.current?.pinGatewayMessage(gatewayTalkIdRef.current, target.id);
      }
      const preview = target.content.slice(0, 50) + (target.content.length > 50 ? '...' : '');
      const sysMsg = createMessage('system', `Pinned: "${preview}"`);
      setMessages(prev => [...prev, sysMsg]);
    } else {
      setError('Message is already pinned');
    }
  }, [activeTalkId, messages, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setMessages, setError]);

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
      if (gatewayTalkIdRef.current) {
        chatServiceRef.current?.unpinGatewayMessage(gatewayTalkIdRef.current, targetId);
      }
      const sysMsg = createMessage('system', 'Pin removed.');
      setMessages(prev => [...prev, sysMsg]);
    } else {
      setError('Failed to remove pin');
    }
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setMessages, setError]);

  const handleListPins = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const pinnedIds = talkManagerRef.current.getPinnedMessageIds(activeTalkId);
    if (pinnedIds.length === 0) {
      const sysMsg = createMessage('system', 'No pinned messages.');
      setMessages(prev => [...prev, sysMsg]);
      return;
    }
    const lines = pinnedIds.map((id, i) => {
      const msg = messages.find(m => m.id === id);
      const preview = msg ? msg.content.slice(0, 60) + (msg.content.length > 60 ? '...' : '') : '(message not found)';
      return `  ${i + 1}. ${preview}`;
    });
    const sysMsg = createMessage('system', `Pinned messages:\n${lines.join('\n')}`);
    setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId, messages, talkManagerRef, setMessages]);

  const handleSetObjective = useCallback((text: string | undefined) => {
    if (!activeTalkId || !talkManagerRef.current) return;
    talkManagerRef.current.setObjective(activeTalkId, text);
    if (gatewayTalkIdRef.current) {
      chatServiceRef.current?.updateGatewayTalk(gatewayTalkIdRef.current, { objective: text ?? '' });
    }
    if (text) {
      const sysMsg = createMessage('system', `Objectives set: ${text}`);
      setMessages(prev => [...prev, sysMsg]);
    } else {
      const sysMsg = createMessage('system', 'Objectives cleared.');
      setMessages(prev => [...prev, sysMsg]);
    }
  }, [activeTalkId, talkManagerRef, chatServiceRef, gatewayTalkIdRef, setMessages]);

  const handleShowObjective = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const objective = talkManagerRef.current.getObjective(activeTalkId);
    const text = objective
      ? `Current objectives: ${objective}`
      : 'No objectives set. Use /objective <text> (or /objectives <text>) to set one.';
    const sysMsg = createMessage('system', text);
    setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId, talkManagerRef, setMessages]);

  const handleViewReports = useCallback((jobIndex?: number) => {
    const gwId = gatewayTalkIdRef.current
      ?? (activeTalkIdRef.current ? talkManagerRef.current?.getGatewayTalkId(activeTalkIdRef.current) : null)
      ?? null;
    if (!gwId || !chatServiceRef.current) {
      setError('Reports not available — this talk is not synced to the server');
      return;
    }

    if (jobIndex !== undefined) {
      resolveGatewayJobByIndex(jobIndex).then(result => {
        if (!result) {
          setError(`No automation at position ${jobIndex}`);
          return;
        }
        chatServiceRef.current?.fetchGatewayReports(gwId, result.jobId, 10).then(reports => {
          if (reports.length === 0) {
            const sysMsg = createMessage('system', `No reports for automation #${jobIndex}.`);
            setMessages(prev => [...prev, sysMsg]);
            return;
          }
          const lines = reports.map(r => {
            const ts = new Date(r.runAt).toLocaleString();
            const icon = r.status === 'success' ? '\u2713' : '\u2717';
            return `  ${icon} [${ts}] ${r.summary}`;
          });
          const sysMsg = createMessage('system', `Reports for automation #${jobIndex}:\n${lines.join('\n')}`);
          setMessages(prev => [...prev, sysMsg]);
        });
      });
    } else {
      chatServiceRef.current.fetchGatewayReports(gwId, undefined, 10).then(reports => {
        if (reports.length === 0) {
          const sysMsg = createMessage('system', 'No automation reports for this talk.');
          setMessages(prev => [...prev, sysMsg]);
          return;
        }
        const lines = reports.map(r => {
          const ts = new Date(r.runAt).toLocaleString();
          const icon = r.status === 'success' ? '\u2713' : '\u2717';
          return `  ${icon} [${ts}] ${r.summary}`;
        });
        const sysMsg = createMessage('system', `Automation reports:\n${lines.join('\n')}`);
        setMessages(prev => [...prev, sysMsg]);
      });
    }
  }, [chatServiceRef, talkManagerRef, activeTalkIdRef, gatewayTalkIdRef, setError, setMessages, resolveGatewayJobByIndex]);

  const handleShowPlaybook = useCallback(() => {
    if (!activeTalkId || !talkManagerRef.current) return;
    const talk = talkManagerRef.current.getTalk(activeTalkId);
    if (!talk) return;

    const sections: string[] = ['=== Playbook ==='];

    if (talk.objective) {
      sections.push(`\nObjectives:\n  ${talk.objective}`);
    } else {
      sections.push('\nObjectives: (none)');
    }

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

    const bindings = talk.platformBindings ?? [];
    if (bindings.length > 0) {
      const lines = bindings.map((b, i) =>
        `  ${i + 1}. platform${i + 1}: ${b.platform} ${formatBindingScopeLabel(b)} (${b.permission})`
      );
      sections.push(`\nChannel connections:\n${lines.join('\n')}`);
    } else {
      sections.push('\nChannel connections: (none)');
    }

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
    setMessages(prev => [...prev, sysMsg]);
  }, [activeTalkId, talkManagerRef, setMessages]);

  const handleExportTalk = useCallback((format?: string, lastN?: number) => {
    const session = sessionManagerRef.current?.getActiveSession();
    if (!session || messages.length === 0) {
      setError('No messages to export');
      return;
    }
    const talk = activeTalkId ? talkManagerRef.current?.getTalk(activeTalkId) : null;
    const name = talk?.topicTitle ?? session.name ?? 'Chat';
    const msgs = lastN ? messages.slice(-lastN) : messages;

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
  }, [activeTalkId, messages, savedConfig.exportDir, sessionManagerRef, talkManagerRef, setError]);

  const handleEditMessages = useCallback(() => {
    const editable = messages.filter(m => m.role !== 'system');
    if (editable.length === 0) {
      setError('No messages to edit');
      return;
    }
    setShowEditMessages(true);
  }, [messages, setError, setShowEditMessages]);

  const handleConfirmDeleteMessages = useCallback(async (messageIds: string[]) => {
    const sessionId = sessionManagerRef.current?.getActiveSessionId();
    const gwTalkId = gatewayTalkIdRef.current;

    if (gwTalkId && chatServiceRef.current) {
      const result = await chatServiceRef.current.deleteGatewayMessages(gwTalkId, messageIds);
      if (!result) {
        setError('Failed to delete messages on gateway.');
        return;
      }
      const latest = await chatServiceRef.current.fetchGatewayMessages(gwTalkId);
      setMessages(latest);
      if (sessionId) {
        sessionManagerRef.current?.deleteMessages(sessionId, messageIds);
      }
      setMessages((prev) => [
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
      setMessages([...session.messages]);
    }
    setMessages((prev) => [
      ...prev,
      createMessage('system', `Deleted ${messageIds.length} message${messageIds.length !== 1 ? 's' : ''}.`),
    ]);
    setShowEditMessages(false);
  }, [chatServiceRef, sessionManagerRef, gatewayTalkIdRef, setMessages, setError, setShowEditMessages]);

  const handleRenameTalk = useCallback((talkId: string, title: string) => {
    if (!talkManagerRef.current) return;
    talkManagerRef.current.setTopicTitle(talkId, title);
    const gwId = talkManagerRef.current.getGatewayTalkId(talkId);
    if (gwId) {
      chatServiceRef.current?.updateGatewayTalk(gwId, { topicTitle: title });
    }
  }, [talkManagerRef, chatServiceRef]);

  const handleDeleteTalk = useCallback((talkId: string) => {
    if (!talkManagerRef.current) return;
    const gwId = talkManagerRef.current.getGatewayTalkId(talkId);
    if (gwId) {
      chatServiceRef.current?.deleteGatewayTalk(gwId);
    }
    talkManagerRef.current.unsaveTalk(talkId);
  }, [talkManagerRef, chatServiceRef]);

  return {
    handleSaveTalk,
    handleSetTopicTitle,
    handlePinMessage,
    handleUnpinMessage,
    handleListPins,
    handleSetObjective,
    handleShowObjective,
    handleViewReports,
    handleShowPlaybook,
    handleExportTalk,
    handleEditMessages,
    handleConfirmDeleteMessages,
    handleRenameTalk,
    handleDeleteTalk,
    addSystemMessage,
  };
}
