/**
 * Agents Config Picker — interactive agent management embedded in Settings.
 *
 * Modes: list (agent list with a/d/r/m hotkeys), select-model (embedded
 * ModelPicker), select-role (embedded RolePicker), confirm-delete.
 *
 * Replaces the old read-only SettingsAgentsTab.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TalkAgent, AgentRole } from '../../types.js';
import { AGENT_ROLES, ROLE_BY_ID } from '../../agent-roles.js';
import { getModelAlias } from '../../models.js';
import { ModelPicker } from './ModelPicker.js';
import type { Model } from './ModelPicker.js';
import { RolePicker } from './RolePicker.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AgentsConfigEmbedProps {
  maxHeight: number;
  terminalWidth: number;
  agents: TalkAgent[];
  currentModel: string;
  pickerModels: Model[];
  modelValidity?: Record<string, 'valid' | 'invalid' | 'unknown'>;
  isRefreshing?: boolean;
  lastRefreshedAt?: number | null;
  onAddAgent: (modelId: string, role: AgentRole) => void;
  onRemoveAgent: (name: string) => void;
  onChangeAgentRole: (name: string, roleId: string) => void;
  onChangeAgentModel: (name: string, modelId: string) => void;
  onSwitchModel: (modelId: string) => void;
}

interface AgentsConfigPickerProps extends AgentsConfigEmbedProps {
  onClose: () => void;
  onTabLeft?: () => void;
  onTabRight?: () => void;
  embedded?: boolean;
}

// ---------------------------------------------------------------------------
// Mode state machine
// ---------------------------------------------------------------------------

type Mode = 'list' | 'select-model' | 'select-role' | 'confirm-delete';

/**
 * Add-agent phase:
 * - 'primary-role': picking role for the auto-created primary agent
 * - 'new-role': picking role for the agent being added
 */
type AddPhase = 'primary-role' | 'new-role';

/**
 * What triggered select-model / select-role:
 * - 'add': adding a new agent
 * - 'change-model': changing an existing agent's model
 * - 'change-role': changing an existing agent's role
 */
type ActionContext = 'add' | 'change-model' | 'change-role';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentsConfigPicker({
  maxHeight,
  terminalWidth,
  agents,
  currentModel,
  pickerModels,
  modelValidity,
  isRefreshing,
  lastRefreshedAt,
  onAddAgent,
  onRemoveAgent,
  onChangeAgentRole,
  onChangeAgentModel,
  onSwitchModel,
  onClose,
  onTabLeft,
  onTabRight,
  embedded,
}: AgentsConfigPickerProps) {
  const [mode, setMode] = useState<Mode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Add-agent state
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [addPhase, setAddPhase] = useState<AddPhase>('new-role');
  const [actionContext, setActionContext] = useState<ActionContext>('add');

  // Target agent name for change-model / change-role / confirm-delete
  const [targetAgentName, setTargetAgentName] = useState<string | null>(null);

  const showStatus = useCallback((msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 2000);
  }, []);

  // Resolve selected agent from list
  const selectedAgent = agents[selectedIndex] ?? null;

  // -------------------------------------------------------------------------
  // Sub-picker callbacks
  // -------------------------------------------------------------------------

  /** ModelPicker selected a model. */
  const handleModelSelected = useCallback((modelId: string) => {
    if (actionContext === 'change-model') {
      // Change model for existing agent
      if (targetAgentName) {
        const agent = agents.find(a => a.name === targetAgentName);
        if (agent?.isPrimary) {
          onSwitchModel(modelId);
        } else {
          onChangeAgentModel(targetAgentName, modelId);
        }
        showStatus(`Model changed → ${getModelAlias(modelId)}`);
      }
      setMode('list');
      setTargetAgentName(null);
      return;
    }

    // actionContext === 'add'
    setPendingModelId(modelId);

    if (agents.length === 0) {
      // No agents yet — first create primary from currentModel
      setAddPhase('primary-role');
    } else {
      setAddPhase('new-role');
    }
    setMode('select-role');
  }, [actionContext, targetAgentName, agents, currentModel, onSwitchModel, onChangeAgentModel, showStatus]);

  /** RolePicker selected a role. */
  const handleRoleSelected = useCallback((role: { id: AgentRole }) => {
    if (actionContext === 'change-role') {
      if (targetAgentName) {
        onChangeAgentRole(targetAgentName, role.id);
        showStatus(`Role changed → ${ROLE_BY_ID[role.id]?.label ?? role.id}`);
      }
      setMode('list');
      setTargetAgentName(null);
      return;
    }

    // actionContext === 'add'
    if (addPhase === 'primary-role') {
      // Create primary agent from currentModel + selected role
      onAddAgent(currentModel, role.id);
      // Now pick role for the new agent
      setAddPhase('new-role');
      // Stay in select-role for the pending model
      return;
    }

    // addPhase === 'new-role'
    if (pendingModelId) {
      onAddAgent(pendingModelId, role.id);
      showStatus(`Agent added: ${getModelAlias(pendingModelId)} ${ROLE_BY_ID[role.id]?.label ?? role.id}`);
    }
    setPendingModelId(null);
    setMode('list');
  }, [actionContext, addPhase, pendingModelId, targetAgentName, currentModel, onAddAgent, onChangeAgentRole, showStatus]);

  /** Sub-picker cancelled. */
  const handleSubPickerClose = useCallback(() => {
    setPendingModelId(null);
    setTargetAgentName(null);
    setMode('list');
  }, []);

  // -------------------------------------------------------------------------
  // List mode input handling
  // -------------------------------------------------------------------------

  useInput((input, key) => {
    // When sub-pickers are active, they own input — early return
    if (mode === 'select-model' || mode === 'select-role') return;

    // Confirm-delete mode
    if (mode === 'confirm-delete') {
      if (key.return || input === 'y' || input === 'Y') {
        if (targetAgentName) {
          onRemoveAgent(targetAgentName);
          showStatus(`Removed ${targetAgentName}`);
        }
        setTargetAgentName(null);
        setMode('list');
        // Clamp selection
        if (selectedIndex >= agents.length - 1) {
          setSelectedIndex(Math.max(0, agents.length - 2));
        }
      } else {
        setTargetAgentName(null);
        setMode('list');
      }
      return;
    }

    // --- List mode ---

    // Global shortcuts for embedded mode
    if (input === 't' && key.ctrl) return; // handled by parent
    if (input === 'n' && key.ctrl) return;
    if (input === 'v' && key.ctrl) return;
    if (input === 'x' && key.ctrl) return;

    if (input === 's' && key.ctrl) { onClose(); return; }
    if (key.escape) { onClose(); return; }

    // Tab navigation
    if (key.leftArrow) { onTabLeft?.(); return; }
    if (key.rightArrow) { onTabRight?.(); return; }

    // Item navigation
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(Math.max(0, agents.length - 1), prev + 1));
      return;
    }

    // 'a' — Add agent
    if (input === 'a' || input === 'A') {
      setActionContext('add');
      setMode('select-model');
      return;
    }

    // 'd' — Delete agent
    if (input === 'd' || input === 'D') {
      if (!selectedAgent) {
        showStatus('No agent selected');
        return;
      }
      if (selectedAgent.isPrimary) {
        showStatus('Cannot remove primary agent');
        return;
      }
      setTargetAgentName(selectedAgent.name);
      setMode('confirm-delete');
      return;
    }

    // 'r' — Change role
    if (input === 'r' || input === 'R') {
      if (!selectedAgent) {
        showStatus('No agent selected');
        return;
      }
      setActionContext('change-role');
      setTargetAgentName(selectedAgent.name);
      setMode('select-role');
      return;
    }

    // 'm' — Change model
    if (input === 'm' || input === 'M') {
      if (!selectedAgent) {
        showStatus('No agent selected');
        return;
      }
      setActionContext('change-model');
      setTargetAgentName(selectedAgent.name);
      setMode('select-model');
      return;
    }
  });

  // -------------------------------------------------------------------------
  // Render: sub-picker modes
  // -------------------------------------------------------------------------

  if (mode === 'select-model') {
    return (
      <ModelPicker
        models={pickerModels}
        currentModel={
          actionContext === 'change-model' && targetAgentName
            ? (agents.find(a => a.name === targetAgentName)?.model ?? currentModel)
            : currentModel
        }
        onSelect={handleModelSelected}
        onClose={handleSubPickerClose}
        maxHeight={maxHeight}
        modelValidity={modelValidity}
        isRefreshing={isRefreshing}
        lastRefreshedAt={lastRefreshedAt}
      />
    );
  }

  if (mode === 'select-role') {
    const roleModelLabel = addPhase === 'primary-role'
      ? `${getModelAlias(currentModel)} (primary)`
      : actionContext === 'change-role' && targetAgentName
        ? targetAgentName
        : getModelAlias(pendingModelId ?? '');

    return (
      <RolePicker
        roles={AGENT_ROLES}
        onSelect={handleRoleSelected}
        onClose={handleSubPickerClose}
        modelName={roleModelLabel}
        maxHeight={maxHeight}
      />
    );
  }

  // -------------------------------------------------------------------------
  // Render: confirm-delete
  // -------------------------------------------------------------------------

  if (mode === 'confirm-delete') {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          Remove agent "{targetAgentName}"?
        </Text>
        <Text dimColor>Press Enter or y to confirm, any other key to cancel.</Text>
      </Box>
    );
  }

  // -------------------------------------------------------------------------
  // Render: agent list
  // -------------------------------------------------------------------------

  return (
    <Box flexDirection="column">
      {agents.length > 0 ? (
        agents.map((a, i) => {
          const isSelected = i === selectedIndex;
          const alias = getModelAlias(a.model);
          const roleLabel = ROLE_BY_ID[a.role]?.label ?? a.role;
          return (
            <Box key={a.name}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '> ' : '  '}
              </Text>
              <Text dimColor>{i + 1}. </Text>
              <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                {a.name}
              </Text>
              <Text dimColor> — {roleLabel} [{alias}]</Text>
              {a.isPrimary && <Text color="cyan"> [primary]</Text>}
            </Box>
          );
        })
      ) : (
        <Text dimColor>  No agents. Press 'a' to add one.</Text>
      )}

      {statusMessage && (
        <Box marginTop={1}>
          <Text color="green">{statusMessage}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>a add  d delete  r role  m model  ←/→ tabs  Esc close</Text>
      </Box>
    </Box>
  );
}
