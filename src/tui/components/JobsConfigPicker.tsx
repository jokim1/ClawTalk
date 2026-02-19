/**
 * Jobs Config Picker
 *
 * Keyboard-first modal for managing talk automations.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Job, PlatformBinding } from '../../types';
import {
  buildVisualLayout,
  computeVisibleWindow,
  moveCursorByVisualRow,
  sanitizePromptInput,
  wrapForTerminal,
} from './promptEditorUtils.js';

interface JobsConfigPickerProps {
  maxHeight: number;
  terminalWidth: number;
  jobs: Job[];
  platformBindings: PlatformBinding[];
  gatewayConnected: boolean;
  onClose: () => void;
  onRefreshJobs: () => Promise<Job[]>;
  onAddJob: (schedule: string, prompt: string) => Promise<boolean>;
  onSetJobActive: (index: number, active: boolean) => Promise<boolean>;
  onSetJobSchedule: (index: number, schedule: string) => Promise<boolean>;
  onSetJobPrompt: (index: number, prompt: string) => Promise<boolean>;
  onDeleteJob: (index: number) => Promise<boolean>;
  onViewReports: (index: number) => void;
}

type Mode =
  | 'list'
  | 'add-type'
  | 'add-time-schedule'
  | 'add-channel-target'
  | 'add-prompt'
  | 'edit-schedule'
  | 'edit-prompt'
  | 'confirm-delete';

type AddType = 'time' | 'channel';

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatBindingScopeLabel(binding: {
  scope: string;
  displayScope?: string;
  accountId?: string;
}): string {
  const scopeLabel = binding.displayScope?.trim() || binding.scope;
  if (binding.accountId?.trim()) {
    return `${binding.accountId}:${scopeLabel}`;
  }
  return scopeLabel;
}

function jobTypeLabel(schedule: string): string {
  if (/^on\s+/i.test(schedule)) return 'event';
  if (/^(in\s|at\s)/i.test(schedule)) return 'one-off';
  return 'recurring';
}

export function JobsConfigPicker({
  maxHeight,
  terminalWidth,
  jobs,
  platformBindings,
  gatewayConnected,
  onClose,
  onRefreshJobs,
  onAddJob,
  onSetJobActive,
  onSetJobSchedule,
  onSetJobPrompt,
  onDeleteJob,
  onViewReports,
}: JobsConfigPickerProps) {
  const [mode, setMode] = useState<Mode>('list');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [localJobs, setLocalJobs] = useState<Job[]>(jobs);

  const [addTypeSelection, setAddTypeSelection] = useState(0);
  const [channelSelection, setChannelSelection] = useState(0);
  const [scheduleInput, setScheduleInput] = useState('');
  const [promptInput, setPromptInput] = useState('');
  const [promptCursor, setPromptCursor] = useState(0);
  const [promptPreferredCol, setPromptPreferredCol] = useState<number | null>(null);
  const [pendingSchedule, setPendingSchedule] = useState('');
  const [pendingScheduleLabel, setPendingScheduleLabel] = useState('');

  const selectedJob = localJobs[selectedIndex];

  const channelTargets = useMemo(() => {
    return platformBindings.map((binding, idx) => ({
      id: binding.id,
      index: idx + 1,
      scope: binding.scope,
      label: `${binding.platform} ${formatBindingScopeLabel(binding)}`,
    }));
  }, [platformBindings]);

  const formatScheduleLabel = (schedule: string): string => {
    const eventMatch = schedule.trim().match(/^on\s+(.+)$/i);
    if (!eventMatch?.[1]) return schedule;
    const target = eventMatch[1].trim();
    const binding = channelTargets.find((entry) => entry.scope.toLowerCase() === target.toLowerCase());
    if (!binding) return schedule;
    return `on ${binding.label}`;
  };

  useEffect(() => {
    setLocalJobs(jobs);
  }, [jobs]);

  useEffect(() => {
    if (!gatewayConnected) return;
    void (async () => {
      try {
        const next = await onRefreshJobs();
        setLocalJobs(next);
      } catch {
        // Keep existing local list when refresh fails.
      }
    })();
  }, [gatewayConnected, onRefreshJobs]);

  useEffect(() => {
    if (localJobs.length === 0) {
      setSelectedIndex(0);
      setScrollOffset(0);
      if (mode === 'confirm-delete' || mode === 'edit-prompt' || mode === 'edit-schedule') {
        setMode('list');
      }
      return;
    }
    if (selectedIndex > localJobs.length - 1) {
      setSelectedIndex(localJobs.length - 1);
    }
  }, [mode, localJobs.length, selectedIndex]);

  useEffect(() => {
    if (channelSelection > channelTargets.length - 1) {
      setChannelSelection(0);
    }
  }, [channelSelection, channelTargets.length]);

  const visibleRows = Math.max(3, maxHeight - 20);
  const ensureVisible = (idx: number) => {
    setScrollOffset((prev) => {
      if (idx < prev) return idx;
      if (idx >= prev + visibleRows) return idx - visibleRows + 1;
      return prev;
    });
  };

  const refreshJobs = async (message?: string) => {
    try {
      const next = await onRefreshJobs();
      setLocalJobs(next);
      if (message) {
        setStatusMessage(message);
      }
    } catch {
      setStatusMessage('Failed to refresh automations.');
    }
  };

  const openAddType = () => {
    setAddTypeSelection(0);
    setPromptInput('');
    setPromptCursor(0);
    setPromptPreferredCol(null);
    setScheduleInput('');
    setPendingSchedule('');
    setPendingScheduleLabel('');
    setMode('add-type');
  };

  const addTypeOptions: Array<{ key: AddType; label: string; description: string; disabled?: boolean }> = [
    {
      key: 'time',
      label: 'Time schedule',
      description: 'Run on a recurring or one-off schedule (daily, every 2h, in 30m).',
    },
    {
      key: 'channel',
      label: 'Channel event',
      description: 'Run whenever a selected channel receives a message.',
      disabled: channelTargets.length === 0,
    },
  ];

  useInput((input, key) => {
    const isBackspaceKey =
      key.backspace ||
      input === '\u0008' || // Ctrl+H
      input === '\u007f';   // DEL (common Backspace on many terminals)

    if (input === 'j' && key.ctrl) {
      onClose();
      return;
    }

    if (key.escape) {
      if (mode === 'list') onClose();
      else setMode('list');
      return;
    }

    if (mode === 'add-time-schedule' || mode === 'edit-schedule') {
      return;
    }

    if (mode === 'list') {
      if (key.upArrow) {
        setSelectedIndex((prev) => {
          const next = Math.max(0, prev - 1);
          ensureVisible(next);
          return next;
        });
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) => {
          const next = Math.min(Math.max(localJobs.length - 1, 0), prev + 1);
          ensureVisible(next);
          return next;
        });
        return;
      }

      if (input === 'a') {
        openAddType();
        return;
      }

      if (input === 'r') {
        void refreshJobs('Automation list refreshed.');
        return;
      }

      if (input === 'v') {
        if (!selectedJob) {
          setStatusMessage('No automation selected.');
          return;
        }
        onViewReports(selectedIndex + 1);
        setStatusMessage(`Requested reports for automation #${selectedIndex + 1}.`);
        return;
      }

      if (input === 's') {
        if (!selectedJob) {
          setStatusMessage('No automation selected.');
          return;
        }
        setScheduleInput(selectedJob.schedule);
        setMode('edit-schedule');
        return;
      }

      if (input === 'p') {
        if (!selectedJob) {
          setStatusMessage('No automation selected.');
          return;
        }
        const normalized = sanitizePromptInput(selectedJob.prompt);
        setPromptInput(normalized);
        setPromptCursor(normalized.length);
        setPromptPreferredCol(null);
        setMode('edit-prompt');
        return;
      }

      if (input === 'd') {
        if (!selectedJob) {
          setStatusMessage('No automation selected.');
          return;
        }
        setMode('confirm-delete');
        return;
      }

      if (key.return || input === 't') {
        if (!selectedJob) {
          setStatusMessage('No automation selected.');
          return;
        }
        void (async () => {
          const nextActive = !selectedJob.active;
          const ok = await onSetJobActive(selectedIndex + 1, nextActive);
          if (!ok) {
            setStatusMessage(`Failed to update automation #${selectedIndex + 1}.`);
            return;
          }
          await refreshJobs(
            `Automation #${selectedIndex + 1} ${nextActive ? 'resumed' : 'paused'}.`,
          );
        })();
      }

      return;
    }

    if (mode === 'add-type') {
      if (key.upArrow) {
        setAddTypeSelection((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setAddTypeSelection((prev) => Math.min(addTypeOptions.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const selected = addTypeOptions[addTypeSelection];
        if (!selected) return;
        if (selected.key === 'channel') {
          if (channelTargets.length === 0) {
            setStatusMessage('Add a channel connection first to create event-triggered jobs.');
            return;
          }
          setChannelSelection(0);
          setMode('add-channel-target');
          return;
        }
        setScheduleInput('every weekday at 9am');
        setMode('add-time-schedule');
      }
      return;
    }

    if (mode === 'add-prompt' || mode === 'edit-prompt') {
      const savePrompt = async (raw: string) => {
        const trimmed = sanitizePromptInput(raw).trim();
        if (!trimmed) {
          setStatusMessage('Prompt cannot be empty.');
          return;
        }

        if (mode === 'add-prompt') {
          const ok = await onAddJob(pendingSchedule, trimmed);
          if (!ok) {
            setStatusMessage('Failed to add automation.');
            setMode('list');
            return;
          }
          await refreshJobs('Automation added.');
          setMode('list');
          setSelectedIndex(Math.max(localJobs.length, 0));
          return;
        }

        if (!selectedJob) {
          setStatusMessage('No selected automation.');
          return;
        }
        const jobIndex = selectedIndex + 1;
        const ok = await onSetJobPrompt(jobIndex, trimmed);
        if (!ok) {
          setStatusMessage(`Failed to update prompt for automation #${jobIndex}.`);
          setMode('list');
          return;
        }
        await refreshJobs(`Updated prompt for automation #${jobIndex}.`);
        setMode('list');
      };

      if (key.escape) {
        setMode('list');
        setPromptPreferredCol(null);
        return;
      }
      if (key.ctrl && input.toLowerCase() === 's') {
        void savePrompt(promptInput);
        setPromptPreferredCol(null);
        return;
      }
      if (key.return) {
        const next = `${promptInput.slice(0, promptCursor)}\n${promptInput.slice(promptCursor)}`;
        setPromptInput(next);
        setPromptCursor(promptCursor + 1);
        setPromptPreferredCol(null);
        return;
      }
      if (isBackspaceKey) {
        if (promptCursor <= 0) return;
        const next = `${promptInput.slice(0, promptCursor - 1)}${promptInput.slice(promptCursor)}`;
        setPromptInput(next);
        setPromptCursor(promptCursor - 1);
        setPromptPreferredCol(null);
        return;
      }
      if (key.delete) {
        if (promptCursor >= promptInput.length) return;
        const next = `${promptInput.slice(0, promptCursor)}${promptInput.slice(promptCursor + 1)}`;
        setPromptInput(next);
        setPromptPreferredCol(null);
        return;
      }
      if (key.leftArrow) {
        setPromptCursor((prev) => Math.max(0, prev - 1));
        setPromptPreferredCol(null);
        return;
      }
      if (key.rightArrow) {
        setPromptCursor((prev) => Math.min(promptInput.length, prev + 1));
        setPromptPreferredCol(null);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const moved = moveCursorByVisualRow(
          promptInput,
          promptCursor,
          Math.max(10, terminalWidth - 12),
          key.upArrow ? -1 : 1,
          promptPreferredCol,
        );
        setPromptCursor(moved.cursor);
        setPromptPreferredCol(moved.preferredCol);
        return;
      }
      if (input) {
        const safeInput = sanitizePromptInput(input);
        if (!safeInput) return;
        const next = `${promptInput.slice(0, promptCursor)}${safeInput}${promptInput.slice(promptCursor)}`;
        setPromptInput(next);
        setPromptCursor(promptCursor + safeInput.length);
        setPromptPreferredCol(null);
      }
      return;
    }

    if (mode === 'add-channel-target') {
      if (channelTargets.length === 0) {
        setStatusMessage('No channel targets available.');
        setMode('add-type');
        return;
      }
      if (key.upArrow) {
        setChannelSelection((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setChannelSelection((prev) => Math.min(channelTargets.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const target = channelTargets[channelSelection];
        if (!target) return;
        setPendingSchedule(`on ${target.scope}`);
        setPendingScheduleLabel(`on ${target.label}`);
        setPromptInput('');
        setPromptCursor(0);
        setPromptPreferredCol(null);
        setMode('add-prompt');
      }
      return;
    }

    if (mode === 'confirm-delete') {
      if (key.return || input.toLowerCase() === 'y') {
        if (!selectedJob) {
          setMode('list');
          return;
        }
        const jobIndex = selectedIndex + 1;
        void (async () => {
          const ok = await onDeleteJob(jobIndex);
          if (!ok) {
            setStatusMessage(`Failed to delete automation #${jobIndex}.`);
            setMode('list');
            return;
          }
          await refreshJobs(`Deleted automation #${jobIndex}.`);
          setMode('list');
        })();
        return;
      }

      if (input.toLowerCase() === 'n') {
        setMode('list');
      }
    }
  });

  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(localJobs.length, scrollOffset + visibleRows);
  const promptEditorWidth = Math.max(10, terminalWidth - 12);
  const promptEditorMaxLines = Math.max(4, Math.min(14, maxHeight - 24));
  const promptLayout = buildVisualLayout(promptInput, promptCursor, promptEditorWidth);
  const promptWindow = computeVisibleWindow(
    promptLayout.lines.length,
    promptLayout.cursorRow,
    promptEditorMaxLines,
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={terminalWidth}>
      <Text bold color="cyan">Automation Jobs</Text>
      <Text dimColor>Configure recurring, one-off, and event-driven automations for this talk.</Text>

      {mode === 'list' && (
        <>
          <Text dimColor>↑/↓ select  Enter/t pause/resume  a add  s schedule  p prompt  v reports  d delete  r refresh  Esc/^J close</Text>
          <Box height={1} />

          <Text bold>Jobs</Text>
          {localJobs.length === 0 ? (
            <Text dimColor>  No automations yet. Press "a" to add one.</Text>
          ) : (
            <>
              {Array.from({ length: visibleEnd - visibleStart }, (_, offset) => {
                const idx = visibleStart + offset;
                const job = localJobs[idx];
                if (!job) return null;
                const isSelected = idx === selectedIndex;
                const status = job.active ? 'active' : 'paused';
                return (
                  <Text key={job.id} color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '▸ ' : '  '}
                    {idx + 1}. [{status}] {truncate(formatScheduleLabel(job.schedule), Math.max(20, terminalWidth - 24))}
                  </Text>
                );
              })}
              {visibleEnd < localJobs.length && <Text dimColor>  ▼ more</Text>}
            </>
          )}

          <Box height={1} />
          <Text bold>Selected Details</Text>
          {selectedJob ? (
            <>
              <Text>  type: {jobTypeLabel(selectedJob.schedule)}</Text>
              <Text>  status: {selectedJob.active ? 'active' : 'paused'}</Text>
              <Text>  schedule: {formatScheduleLabel(selectedJob.schedule)}</Text>
              <Text>  prompt:</Text>
              {wrapForTerminal(selectedJob.prompt || '(none)', Math.max(10, terminalWidth - 10)).map((line, idx) => (
                <Text key={`job-prompt-line-${idx}`} dimColor>
                  {'    '}
                  {line || ' '}
                </Text>
              ))}
              <Text>  last run: {selectedJob.lastRunAt ? new Date(selectedJob.lastRunAt).toLocaleString() : '(never)'}</Text>
            </>
          ) : (
            <Text dimColor>  No automation selected.</Text>
          )}

          {!gatewayConnected && (
            <>
              <Box height={1} />
              <Text color="yellow">Gateway is not connected. Automations run server-side and cannot be changed offline.</Text>
            </>
          )}
        </>
      )}

      {mode === 'add-type' && (
        <>
          <Box height={1} />
          <Text bold>Step 1: Choose Trigger Type</Text>
          {addTypeOptions.map((option, idx) => (
            <Text key={option.key} color={idx === addTypeSelection ? 'cyan' : option.disabled ? 'gray' : undefined}>
              {idx === addTypeSelection ? '▸ ' : '  '}
              {option.label}
              {option.disabled ? ' [no channel connections]' : ''}
              <Text dimColor>  {option.description}</Text>
            </Text>
          ))}
          <Box height={1} />
          <Text dimColor>Enter continue  Esc cancel</Text>
        </>
      )}

      {mode === 'add-time-schedule' && (
        <>
          <Box height={1} />
          <Text bold>Step 2: Enter Time Schedule</Text>
          <Text dimColor>Examples: every weekday at 9am, every 2h, in 30m, at 2026-02-20 14:00</Text>
          <Box>
            <Text>schedule: </Text>
            <TextInput
              value={scheduleInput}
              onChange={setScheduleInput}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setStatusMessage('Schedule cannot be empty.');
                  return;
                }
                setPendingSchedule(trimmed);
                setPendingScheduleLabel(trimmed);
                setPromptInput('');
                setPromptCursor(0);
                setPromptPreferredCol(null);
                setMode('add-prompt');
              }}
            />
          </Box>
          <Text dimColor>Enter continue  Esc cancel</Text>
        </>
      )}

      {mode === 'add-channel-target' && (
        <>
          <Box height={1} />
          <Text bold>Step 2: Choose Channel Target</Text>
          {channelTargets.length === 0 ? (
            <Text dimColor>No channel connections found.</Text>
          ) : (
            channelTargets.map((target, idx) => (
              <Text key={target.id} color={idx === channelSelection ? 'cyan' : undefined}>
                {idx === channelSelection ? '▸ ' : '  '}
                {target.index}. {target.label}
              </Text>
            ))
          )}
          <Box height={1} />
          <Text dimColor>Enter continue  Esc cancel</Text>
        </>
      )}

      {mode === 'add-prompt' && (
        <>
          <Box height={1} />
          <Text bold>Step 3: Enter Prompt</Text>
          <Text dimColor>Trigger: {pendingScheduleLabel || pendingSchedule}</Text>
          <Text dimColor>Multi-line editor. Ctrl+S save  Enter newline  Esc cancel</Text>
          <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
            {promptWindow.start > 0 && <Text dimColor>▲ more</Text>}
            {promptLayout.lines.slice(promptWindow.start, promptWindow.end).map((line, idx) => {
              const row = promptWindow.start + idx;
              if (row !== promptLayout.cursorRow) {
                return <Text key={`add-prompt-editor-${row}`}>{line.text || ' '}</Text>;
              }
              const col = Math.max(0, Math.min(promptLayout.cursorCol, line.text.length));
              const before = line.text.slice(0, col);
              const hasChar = col < line.text.length;
              const at = hasChar ? line.text[col] : ' ';
              const after = hasChar ? line.text.slice(col + 1) : '';
              return (
                <Text key={`add-prompt-editor-${row}`}>
                  {before}
                  <Text inverse>{at}</Text>
                  {after}
                </Text>
              );
            })}
            {promptWindow.end < promptLayout.lines.length && <Text dimColor>▼ more</Text>}
          </Box>
        </>
      )}

      {mode === 'edit-schedule' && (
        <>
          <Box height={1} />
          <Text bold>Edit Schedule</Text>
          {selectedJob ? (
            <Text dimColor>Automation #{selectedIndex + 1}</Text>
          ) : (
            <Text dimColor>No selected automation.</Text>
          )}
          <Text dimColor>Use real channel scope for event jobs (example: on slack #team-product).</Text>
          <Box>
            <Text>schedule: </Text>
            <TextInput
              value={scheduleInput}
              onChange={setScheduleInput}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed || !selectedJob) {
                  setStatusMessage('Schedule cannot be empty.');
                  return;
                }
                const jobIndex = selectedIndex + 1;
                void (async () => {
                  const ok = await onSetJobSchedule(jobIndex, trimmed);
                  if (!ok) {
                    setStatusMessage(`Failed to update schedule for automation #${jobIndex}.`);
                    setMode('list');
                    return;
                  }
                  await refreshJobs(`Updated schedule for automation #${jobIndex}.`);
                  setMode('list');
                })();
              }}
            />
          </Box>
          <Text dimColor>Enter save  Esc cancel</Text>
        </>
      )}

      {mode === 'edit-prompt' && (
        <>
          <Box height={1} />
          <Text bold>Edit Prompt</Text>
          {selectedJob ? (
            <Text dimColor>Automation #{selectedIndex + 1}</Text>
          ) : (
            <Text dimColor>No selected automation.</Text>
          )}
          <Text dimColor>Multi-line editor. Ctrl+S save  Enter newline  Esc cancel</Text>
          <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
            {promptWindow.start > 0 && <Text dimColor>▲ more</Text>}
            {promptLayout.lines.slice(promptWindow.start, promptWindow.end).map((line, idx) => {
              const row = promptWindow.start + idx;
              if (row !== promptLayout.cursorRow) {
                return <Text key={`edit-prompt-editor-${row}`}>{line.text || ' '}</Text>;
              }
              const col = Math.max(0, Math.min(promptLayout.cursorCol, line.text.length));
              const before = line.text.slice(0, col);
              const hasChar = col < line.text.length;
              const at = hasChar ? line.text[col] : ' ';
              const after = hasChar ? line.text.slice(col + 1) : '';
              return (
                <Text key={`edit-prompt-editor-${row}`}>
                  {before}
                  <Text inverse>{at}</Text>
                  {after}
                </Text>
              );
            })}
            {promptWindow.end < promptLayout.lines.length && <Text dimColor>▼ more</Text>}
          </Box>
        </>
      )}

      {mode === 'confirm-delete' && (
        <>
          <Box height={1} />
          <Text color="yellow">Delete automation #{selectedIndex + 1}? Press Enter or y to confirm, n to cancel.</Text>
        </>
      )}

      {statusMessage && (
        <>
          <Box height={1} />
          <Text color="green">{statusMessage}</Text>
        </>
      )}
    </Box>
  );
}
