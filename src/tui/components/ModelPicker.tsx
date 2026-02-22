/**
 * Model Picker Component
 *
 * Grouped list by provider for selecting AI model, with scrolling and pricing.
 * When agents exist, displays an agent strip at the top for per-agent model management.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TalkAgent } from '../../types.js';
import { getModelAlias } from '../../models.js';
import { ROLE_BY_ID } from '../../agent-roles.js';

export interface Model {
  id: string;
  label: string;
  preset?: string;
  provider?: string;
  pricingLabel?: string;
}

interface ModelPickerProps {
  models: Model[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
  maxHeight?: number;
  onAddAgent?: (modelId: string) => void;
  title?: string;
  modelValidity?: Record<string, 'valid' | 'invalid' | 'unknown'>;
  isRefreshing?: boolean;
  lastRefreshedAt?: number | null;
  agents?: TalkAgent[];
  onChangeAgentModel?: (agentName: string, modelId: string) => void;
  onRemoveAgent?: (agentName: string) => void;
}

type RenderItem =
  | { type: 'header'; provider: string }
  | { type: 'model'; model: Model; flatIndex: number };

/** Short label for agent strip: alias(RoleAbbrev) */
function agentSlotLabel(agent: TalkAgent): string {
  const alias = getModelAlias(agent.model);
  const role = ROLE_BY_ID[agent.role];
  const roleAbbrev = role ? role.label.slice(0, 3) : agent.role.slice(0, 3);
  return `${alias}(${roleAbbrev})`;
}

export function ModelPicker({
  models,
  currentModel,
  onSelect,
  onClose,
  maxHeight = 20,
  onAddAgent,
  title,
  modelValidity,
  isRefreshing = false,
  lastRefreshedAt = null,
  agents,
  onChangeAgentModel,
  onRemoveAgent,
}: ModelPickerProps) {
  const hasAgents = (agents?.length ?? 0) > 0;

  // Focused agent slot index (only meaningful when agents exist)
  const [focusedAgentIndex, setFocusedAgentIndex] = useState(0);

  // Clamp focusedAgentIndex when agents array shrinks
  useEffect(() => {
    if (hasAgents && focusedAgentIndex >= agents!.length) {
      setFocusedAgentIndex(Math.max(0, agents!.length - 1));
    }
  }, [agents?.length]);

  // The "current" model for the focused agent slot (or the global currentModel)
  const focusedCurrentModel = hasAgents ? agents![focusedAgentIndex]?.model ?? currentModel : currentModel;

  // Build grouped render list
  const { renderList, modelIndices } = useMemo(() => {
    const items: RenderItem[] = [];
    const indices: number[] = [];
    let seenProvider: string | null = null;
    let flatIndex = 0;

    for (const model of models) {
      const provider = model.provider ?? 'Other';
      if (provider !== seenProvider) {
        items.push({ type: 'header', provider });
        seenProvider = provider;
      }
      indices.push(items.length);
      items.push({ type: 'model', model, flatIndex });
      flatIndex++;
    }

    return { renderList: items, modelIndices: indices };
  }, [models]);

  // Track selected model index (flat, not render-list)
  const initialIndex = Math.max(0, models.findIndex(m => m.id === focusedCurrentModel));
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  // Scroll offset (in render-list rows)
  const agentStripLines = hasAgents ? 1 : 0;
  const titleLines = 2 + agentStripLines; // title + refresh status + optional agent strip
  const visibleRows = Math.max(3, maxHeight - titleLines);
  const [scrollOffset, setScrollOffset] = useState(() => {
    const renderPos = modelIndices[initialIndex] ?? 0;
    if (renderPos >= visibleRows) {
      return Math.max(0, renderPos - Math.floor(visibleRows / 2));
    }
    return 0;
  });

  // Ensure selected item is visible, adjusting scroll
  const ensureVisible = (modelIdx: number) => {
    const renderPos = modelIndices[modelIdx] ?? 0;
    setScrollOffset(prev => {
      if (renderPos < prev) return renderPos;
      if (renderPos >= prev + visibleRows) return renderPos - visibleRows + 1;
      return prev;
    });
  };

  // Re-center model list when focusedAgentIndex changes
  useEffect(() => {
    if (!hasAgents) return;
    const agentModel = agents![focusedAgentIndex]?.model;
    if (!agentModel) return;
    const idx = models.findIndex(m => m.id === agentModel);
    if (idx >= 0) {
      setSelectedIndex(idx);
      ensureVisible(idx);
    }
  }, [focusedAgentIndex]);

  // Helper: dispatch model selection for the current context
  const selectModelForContext = (modelId: string) => {
    if (!hasAgents) {
      // No agents — simple select
      onSelect(modelId);
      return;
    }

    const agent = agents![focusedAgentIndex];
    if (!agent) return;

    if (agent.isPrimary) {
      // Primary slot: close picker + full model switch
      onSelect(modelId);
    } else if (onChangeAgentModel) {
      // Non-primary: change model in place, stay open
      onChangeAgentModel(agent.name, modelId);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    // Left/Right: switch agent slot focus
    if (hasAgents && key.leftArrow) {
      setFocusedAgentIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (hasAgents && key.rightArrow) {
      setFocusedAgentIndex(prev => Math.min(agents!.length - 1, prev + 1));
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(prev => {
        const next = Math.max(0, prev - 1);
        ensureVisible(next);
        return next;
      });
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(prev => {
        const next = Math.min(models.length - 1, prev + 1);
        ensureVisible(next);
        return next;
      });
      return;
    }

    if (key.return) {
      selectModelForContext(models[selectedIndex].id);
      return;
    }

    // 'a' key: add agent with highlighted model
    if ((input === 'a' || input === 'A') && onAddAgent) {
      onAddAgent(models[selectedIndex].id);
      return;
    }

    // 'd' key: delete focused non-primary agent
    if ((input === 'd' || input === 'D') && hasAgents && onRemoveAgent) {
      const agent = agents![focusedAgentIndex];
      if (agent && !agent.isPrimary) {
        onRemoveAgent(agent.name);
      }
      return;
    }

    // Number keys for quick select (1-9)
    const num = parseInt(input, 10);
    if (num >= 1 && num <= 9 && num <= models.length) {
      selectModelForContext(models[num - 1].id);
    }
  });

  // Slice the render list to the visible window
  const visibleItems = renderList.slice(scrollOffset, scrollOffset + visibleRows);
  const hasMore = scrollOffset + visibleRows < renderList.length;
  const hasLess = scrollOffset > 0;

  const refreshLabel = lastRefreshedAt
    ? new Date(lastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  // Title and key hints
  const pickerTitle = hasAgents
    ? 'Manage Agents'
    : (title ?? 'Select Model');
  const keyHints = hasAgents
    ? '(←→ slot, ↑↓ model, Enter select, a add, d del, Esc close)'
    : '(↑↓ Enter, 1-9 quick, a: add agent, Esc cancel)';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{pickerTitle} {keyHints}</Text>
      <Text dimColor>
        {isRefreshing
          ? 'Checking model availability with gateway...'
          : (refreshLabel
            ? 'Model availability refreshed at ' + refreshLabel
            : 'Model availability not checked yet in this session')}
      </Text>

      {/* Agent strip */}
      {hasAgents && (
        <Box>
          {agents!.map((agent, i) => {
            const isFocused = i === focusedAgentIndex;
            const label = `${i + 1}. ${agentSlotLabel(agent)}`;
            return (
              <Box key={agent.name} marginRight={1}>
                <Text
                  color={isFocused ? 'cyan' : undefined}
                  bold={isFocused}
                >
                  {isFocused ? `[${label}]` : label}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box height={1} />

      {hasLess ? (
        <Text dimColor>  ▲ more</Text>
      ) : null}

      {visibleItems.map((item, i) => {
        if (item.type === 'header') {
          return (
            <Box key={`hdr-${item.provider}`}>
              <Text bold dimColor> {item.provider}</Text>
            </Box>
          );
        }

        const { model, flatIndex } = item;
        const isSelected = flatIndex === selectedIndex;
        const isCurrent = model.id === focusedCurrentModel;
        const numLabel = flatIndex < 9 ? `${flatIndex + 1}` : ' ';

        return (
          <Box key={model.id}>
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '> ' : '  '}
            </Text>
            <Text dimColor>{numLabel}. </Text>
            <Text
              color={isSelected ? 'cyan' : undefined}
              bold={isCurrent}
            >
              {model.label}
            </Text>
            {model.pricingLabel ? (
              <Text dimColor>  {model.pricingLabel}</Text>
            ) : null}
            {modelValidity?.[model.id] === 'valid' ? <Text color="green">  [live]</Text> : null}
            {modelValidity?.[model.id] === 'invalid' ? <Text color="yellow">  [unavailable]</Text> : null}
            {isCurrent ? <Text color="green"> (current)</Text> : null}
          </Box>
        );
      })}

      {hasMore ? (
        <Text dimColor>  ▼ more</Text>
      ) : null}
    </Box>
  );
}
