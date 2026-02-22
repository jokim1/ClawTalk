/**
 * Job/Automation handlers hook.
 *
 * CRUD for scheduled/event-driven automations, refresh from gateway,
 * resolve by index, and schedule normalization.
 */

import { useCallback } from 'react';
import type { Job, Message, PlatformBinding } from '../../types.js';
import type { ChatService } from '../../services/chat.js';
import type { TalkManager } from '../../services/talks.js';
import { createMessage } from '../helpers.js';
import { formatBindingScopeLabel } from '../formatters.js';

/** Normalize event-based schedule strings against known channel bindings. */
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

export interface UseJobHandlersDeps {
  chatServiceRef: React.MutableRefObject<ChatService | null>;
  talkManagerRef: React.MutableRefObject<TalkManager | null>;
  activeTalkId: string | null;
  activeTalkIdRef: React.MutableRefObject<string | null>;
  gatewayTalkIdRef: React.MutableRefObject<string | null>;
  setError: (msg: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  error: string | null;
}

export interface UseJobHandlersResult {
  refreshJobsFromSource: () => Promise<Job[]>;
  resolveGatewayJobByIndex: (index: number) => Promise<{ jobId: string; jobs: Job[] } | null>;
  handleAddJob: (schedule: string, prompt: string) => Promise<boolean>;
  handleListJobs: () => void;
  handlePauseJob: (index: number) => void;
  handleResumeJob: (index: number) => void;
  handleDeleteJob: (index: number) => void;
  handleDeleteJobForPicker: (index: number) => Promise<boolean>;
  handleSetJobActive: (index: number, active: boolean) => Promise<boolean>;
  handleSetJobSchedule: (index: number, schedule: string) => Promise<boolean>;
  handleSetJobPrompt: (index: number, prompt: string) => Promise<boolean>;
}

export function useJobHandlers(deps: UseJobHandlersDeps): UseJobHandlersResult {
  const {
    chatServiceRef, talkManagerRef,
    activeTalkId, activeTalkIdRef, gatewayTalkIdRef,
    setError, setMessages, error,
  } = deps;

  const getGatewayTalkIdForActiveTalk = useCallback((): string | null => {
    if (gatewayTalkIdRef.current) return gatewayTalkIdRef.current;
    if (!activeTalkId || !talkManagerRef.current) return null;
    return talkManagerRef.current.getGatewayTalkId(activeTalkId) ?? null;
  }, [activeTalkId, gatewayTalkIdRef, talkManagerRef]);

  const refreshJobsFromSource = useCallback(async (): Promise<Job[]> => {
    if (!activeTalkId || !talkManagerRef.current) return [];

    const gwId = getGatewayTalkIdForActiveTalk();
    if (gwId && chatServiceRef.current) {
      const jobs = await chatServiceRef.current.listGatewayJobs(gwId);
      talkManagerRef.current.replaceJobs(activeTalkId, jobs);
      return jobs;
    }

    return talkManagerRef.current.getJobs(activeTalkId);
  }, [activeTalkId, getGatewayTalkIdForActiveTalk, chatServiceRef, talkManagerRef]);

  const resolveGatewayJobByIndex = useCallback(async (index: number): Promise<{ jobId: string; jobs: Job[] } | null> => {
    const gwId = getGatewayTalkIdForActiveTalk();
    if (!gwId || !chatServiceRef.current) return null;
    const jobs = await refreshJobsFromSource();
    const job = jobs[index - 1];
    if (!job?.id) return null;
    return { jobId: job.id, jobs };
  }, [getGatewayTalkIdForActiveTalk, refreshJobsFromSource, chatServiceRef]);

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
  }, [activeTalkId, getGatewayTalkIdForActiveTalk, refreshJobsFromSource, resolveGatewayJobByIndex, chatServiceRef, talkManagerRef, setError]);

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
  }, [activeTalkId, getGatewayTalkIdForActiveTalk, refreshJobsFromSource, resolveGatewayJobByIndex, chatServiceRef, talkManagerRef, setError]);

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
      setMessages(prev => [...prev, sysMsg]);
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
      setMessages(prev => [...prev, sysMsg]);
      return true;
    } catch (err) {
      setError(`Automation failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }, [activeTalkId, getGatewayTalkIdForActiveTalk, refreshJobsFromSource, chatServiceRef, talkManagerRef, setError, setMessages]);

  const handleListJobs = useCallback(() => {
    if (!activeTalkId) return;

    void (async () => {
      const jobs = await refreshJobsFromSource();
      if (jobs.length === 0) {
        const sysMsg = createMessage('system', 'No automations for this talk.');
        setMessages(prev => [...prev, sysMsg]);
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
      setMessages(prev => [...prev, sysMsg]);
    })();
  }, [activeTalkId, refreshJobsFromSource, setMessages]);

  const handleSetJobActive = useCallback(async (index: number, active: boolean): Promise<boolean> => {
    const ok = await updateJobByIndex(index, { active });
    if (!ok) {
      if (!error) {
        setError(`Failed to ${active ? 'resume' : 'pause'} automation #${index}`);
      }
      return false;
    }
    return true;
  }, [error, updateJobByIndex, setError]);

  const handleSetJobSchedule = useCallback(async (index: number, schedule: string): Promise<boolean> => {
    const ok = await updateJobByIndex(index, { schedule });
    if (!ok) {
      if (!error) {
        setError(`Failed to update schedule for automation #${index}`);
      }
      return false;
    }
    return true;
  }, [error, updateJobByIndex, setError]);

  const handleSetJobPrompt = useCallback(async (index: number, prompt: string): Promise<boolean> => {
    const ok = await updateJobByIndex(index, { prompt });
    if (!ok) {
      if (!error) {
        setError(`Failed to update prompt for automation #${index}`);
      }
      return false;
    }
    return true;
  }, [error, updateJobByIndex, setError]);

  const handlePauseJob = useCallback((index: number) => {
    void (async () => {
      const ok = await handleSetJobActive(index, false);
      if (!ok) return;
      const sysMsg = createMessage('system', `Automation #${index} paused.`);
      setMessages(prev => [...prev, sysMsg]);
    })();
  }, [handleSetJobActive, setMessages]);

  const handleResumeJob = useCallback((index: number) => {
    void (async () => {
      const ok = await handleSetJobActive(index, true);
      if (!ok) return;
      const sysMsg = createMessage('system', `Automation #${index} resumed.`);
      setMessages(prev => [...prev, sysMsg]);
    })();
  }, [handleSetJobActive, setMessages]);

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
      setMessages(prev => [...prev, sysMsg]);
    })();
  }, [deleteJobByIndex, error, setError, setMessages]);

  const handleDeleteJobForPicker = useCallback(async (index: number): Promise<boolean> => {
    const ok = await deleteJobByIndex(index);
    if (!ok) {
      if (!error) {
        setError(`Failed to delete automation #${index}`);
      }
      return false;
    }
    return true;
  }, [deleteJobByIndex, error, setError]);

  return {
    refreshJobsFromSource,
    resolveGatewayJobByIndex,
    handleAddJob,
    handleListJobs,
    handlePauseJob,
    handleResumeJob,
    handleDeleteJob,
    handleDeleteJobForPicker,
    handleSetJobActive,
    handleSetJobSchedule,
    handleSetJobPrompt,
  };
}
