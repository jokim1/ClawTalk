/**
 * Model Picker Component
 *
 * Grouped list by provider for selecting AI model, with scrolling and pricing.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

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
}

type RenderItem =
  | { type: 'header'; provider: string }
  | { type: 'model'; model: Model; flatIndex: number };

export function ModelPicker({ models, currentModel, onSelect, onClose, maxHeight = 20, onAddAgent, title }: ModelPickerProps) {
  // Two-phase flow: 'model' = selecting model, 'action' = choose switch vs add agent
  const [phase, setPhase] = useState<'model' | 'action'>('model');
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  // Build grouped render list
  const { renderList, modelIndices } = useMemo(() => {
    const items: RenderItem[] = [];
    const indices: number[] = []; // maps flat model index -> renderList position
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
  const initialIndex = Math.max(0, models.findIndex(m => m.id === currentModel));
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  // Scroll offset (in render-list rows)
  const titleLines = 2; // title + blank line
  const visibleRows = Math.max(3, maxHeight - titleLines);
  const [scrollOffset, setScrollOffset] = useState(() => {
    // Start scrolled so the selected model is visible
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

  useInput((input, key) => {
    // --- Action phase: switch model or add agent ---
    if (phase === 'action') {
      if (key.escape) {
        setPhase('model');
        setPendingModelId(null);
        return;
      }
      if (key.return) {
        // Enter = switch model (same as current behavior)
        if (pendingModelId) onSelect(pendingModelId);
        return;
      }
      if ((input === 'a' || input === 'A') && onAddAgent && pendingModelId) {
        onAddAgent(pendingModelId);
        return;
      }
      return;
    }

    // --- Model phase ---
    if (key.escape) {
      onClose();
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
      if (onAddAgent) {
        // Transition to action phase
        setPendingModelId(models[selectedIndex].id);
        setPhase('action');
      } else {
        onSelect(models[selectedIndex].id);
      }
      return;
    }

    // Number keys for quick select (1-9) — fast path, always switch directly
    const num = parseInt(input, 10);
    if (num >= 1 && num <= 9 && num <= models.length) {
      onSelect(models[num - 1].id);
    }
  });

  // Slice the render list to the visible window
  const visibleItems = renderList.slice(scrollOffset, scrollOffset + visibleRows);
  const hasMore = scrollOffset + visibleRows < renderList.length;
  const hasLess = scrollOffset > 0;

  // --- Action sub-menu ---
  if (phase === 'action' && pendingModelId) {
    const pendingModel = models.find(m => m.id === pendingModelId);
    const label = pendingModel?.label ?? pendingModelId;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">{label}</Text>
        <Box height={1} />
        <Text color="cyan">{'>'}  </Text>
        <Text>Enter — Switch to this model</Text>
        {onAddAgent && (
          <Box>
            <Text>   </Text>
            <Text>A — Add as AI agent</Text>
          </Box>
        )}
        <Box height={1} />
        <Text dimColor>Esc to go back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">{title ?? 'Select Model'} (↑↓ Enter, 1-9 quick, Esc cancel)</Text>
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
        const isCurrent = model.id === currentModel;
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
