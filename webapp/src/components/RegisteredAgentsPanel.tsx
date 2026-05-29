import { useState, useEffect } from 'react';

import {
  ApiError,
  listRegisteredAgents,
  createRegisteredAgent,
  updateRegisteredAgent,
  deleteRegisteredAgent,
  dismissAgentModelUpgrade,
  type ExecutorSettings,
  type RegisteredAgent,
  type RegisteredAgentCredentialMode,
  type AgentProviderCard,
  UnauthorizedError,
} from '../lib/api';
import { TOOL_FAMILY_GROUPS, TOOL_NAMES } from '../lib/tool-families';

type Props = {
  providers: AgentProviderCard[];
  executorSettings: ExecutorSettings;
  containerRuntimeAvailability: 'ready' | 'unavailable';
  onUnauthorized: () => void;
  canManage: boolean;
  mainAgentId?: string | null;
  /** Called after any CRUD operation so parent can refresh its own agent list. */
  onAgentsChanged?: (agents: RegisteredAgent[]) => void;
};

type AgentDraft = {
  draftId: string;
  name: string;
  providerId: string;
  modelId: string;
  personaRole: string;
  description: string;
  systemPrompt: string;
  toolPermissions: Record<string, boolean>;
  enabled: boolean;
  // null = auto (resolver walks personal/workspace × api_key/sub
  // precedence). Non-null pins the agent to one mode.
  credentialMode: RegisteredAgentCredentialMode | null;
};

// Build the dropdown's selectable options for a provider. Returns one
// entry per credential mode that the provider has a credential
// configured for (personal OR workspace counts). Providers with no
// credential render a single "(no credential)" entry tied to null so
// the form still has a non-empty value.
type ProviderOption = {
  value: string;
  label: string;
  providerId: string;
  credentialMode: RegisteredAgentCredentialMode | null;
  disabled: boolean;
};

function providerOptionValue(
  providerId: string,
  credentialMode: RegisteredAgentCredentialMode | null,
): string {
  return `${providerId}::${credentialMode ?? 'auto'}`;
}

function buildProviderOptions(
  providers: AgentProviderCard[],
): ProviderOption[] {
  const options: ProviderOption[] = [];
  for (const provider of providers) {
    const hasApiKey = provider.hasCredential || provider.workspaceHasCredential;
    const hasSubscription =
      provider.hasPersonalSubscription || provider.hasWorkspaceSubscription;
    const disabled = !provider.enabled;
    if (hasApiKey && hasSubscription) {
      options.push({
        value: providerOptionValue(provider.id, 'api_key'),
        label: `${provider.name} — API key${disabled ? ' (disabled)' : ''}`,
        providerId: provider.id,
        credentialMode: 'api_key',
        disabled,
      });
      options.push({
        value: providerOptionValue(provider.id, 'subscription'),
        label: `${provider.name} — Subscription${disabled ? ' (disabled)' : ''}`,
        providerId: provider.id,
        credentialMode: 'subscription',
        disabled,
      });
      continue;
    }
    if (hasApiKey) {
      options.push({
        value: providerOptionValue(provider.id, null),
        label: `${provider.name}${disabled ? ' (disabled)' : ''}`,
        providerId: provider.id,
        credentialMode: null,
        disabled,
      });
      continue;
    }
    if (hasSubscription) {
      options.push({
        value: providerOptionValue(provider.id, null),
        label: `${provider.name} (Subscription)${disabled ? ' (disabled)' : ''}`,
        providerId: provider.id,
        credentialMode: null,
        disabled,
      });
      continue;
    }
    options.push({
      value: providerOptionValue(provider.id, null),
      label: `${provider.name} (no credential)`,
      providerId: provider.id,
      credentialMode: null,
      disabled,
    });
  }
  return options;
}

function findProviderOption(
  options: ProviderOption[],
  providerId: string,
  credentialMode: RegisteredAgentCredentialMode | null,
): ProviderOption | undefined {
  return (
    options.find(
      (o) =>
        o.providerId === providerId && o.credentialMode === credentialMode,
    ) ?? options.find((o) => o.providerId === providerId)
  );
}

function credentialModeBadgeLabel(
  mode: RegisteredAgentCredentialMode | null,
): string | null {
  if (mode === 'api_key') return 'API key';
  if (mode === 'subscription') return 'Subscription';
  return null;
}

function buildDefaultRegisteredAgentToolPermissions(): Record<string, boolean> {
  // Keep in sync with the backend default in agent-accessors.ts.
  return {
    web: true,
    connectors: true,
    google_read: true,
    google_write: true,
    gmail_read: true,
    gmail_send: true,
    messaging: true,
  };
}

function generateDraftId(): string {
  return 'draft-' + Math.random().toString(36).substring(2, 11);
}

function hasHeavyTools(toolPermissions: Record<string, boolean>): boolean {
  return Boolean(
    toolPermissions.shell ||
    toolPermissions.filesystem ||
    toolPermissions.browser,
  );
}

function withExecutionPreviewDefaults(
  input: Omit<
    RegisteredAgent['executionPreview'],
    'selectedMode' | 'transport' | 'reasonCode'
  > &
    Partial<
      Pick<
        RegisteredAgent['executionPreview'],
        'selectedMode' | 'transport' | 'reasonCode'
      >
    >,
): RegisteredAgent['executionPreview'] {
  return {
    selectedMode: null,
    transport: null,
    reasonCode: null,
    ...input,
  };
}

function buildDraftExecutionPreview(input: {
  draft: AgentDraft;
  providers: AgentProviderCard[];
  executorSettings: ExecutorSettings;
  containerRuntimeAvailability: 'ready' | 'unavailable';
}): RegisteredAgent['executionPreview'] | null {
  const provider = input.providers.find(
    (entry) => entry.id === input.draft.providerId,
  );
  if (!provider) {
    return null;
  }

  if (provider.id !== 'provider.anthropic') {
    return null;
  }

  const heavyToolsEnabled = hasHeavyTools(input.draft.toolPermissions);
  const hasSubscriptionCredential =
    input.executorSettings.hasOauthToken || input.executorSettings.hasAuthToken;
  const containerRuntimeAvailable =
    input.containerRuntimeAvailability === 'ready';
  // Post-PR-#332: Claude OAuth subscriptions run through direct_http
  // with Bearer + claude-cli headers (see llm-client.ts) — no local
  // container required. Only heavy tools (shell / filesystem) still
  // need the container runtime, and that path is stubbed out on the
  // cloud Worker anyway. So the only thing that genuinely requires
  // a container is heavyToolsEnabled.
  const requiresContainerBackend = heavyToolsEnabled;

  if (requiresContainerBackend && !containerRuntimeAvailable) {
    return withExecutionPreviewDefaults({
      surface: 'main',
      backend: null,
      authPath: null,
      routeReason: 'no_valid_path',
      ready: false,
      message:
        'Shell, Filesystem, and Browser tools require a container runtime, which is not available in the cloud deployment yet.',
    });
  }

  if (heavyToolsEnabled) {
    if (
      input.executorSettings.executorAuthMode === 'subscription' &&
      hasSubscriptionCredential
    ) {
      return withExecutionPreviewDefaults({
        surface: 'main',
        backend: 'container',
        authPath: 'subscription',
        selectedMode: 'subscription',
        transport: 'subscription',
        routeReason: 'normal',
        ready: true,
        message: 'Main will use Claude subscription via the container runtime.',
      });
    }
    if (
      input.executorSettings.executorAuthMode === 'api_key' &&
      input.executorSettings.hasApiKey
    ) {
      return withExecutionPreviewDefaults({
        surface: 'main',
        backend: 'container',
        authPath: 'api_key',
        selectedMode: 'api',
        transport: 'direct',
        routeReason: 'normal',
        ready: true,
        message:
          'Main will use the Claude container runtime with an Anthropic API key.',
      });
    }
    return withExecutionPreviewDefaults({
      surface: 'main',
      backend: null,
      authPath: null,
      routeReason: 'no_valid_path',
      ready: false,
      message:
        'Heavy Claude tools require a valid container auth path. Configure subscription mode with a stored Claude credential, or switch to API key mode with an Anthropic API key.',
    });
  }

  if (
    input.executorSettings.executorAuthMode === 'subscription' &&
    hasSubscriptionCredential
  ) {
    return withExecutionPreviewDefaults({
      surface: 'main',
      backend: 'direct_http',
      authPath: 'subscription',
      selectedMode: 'subscription',
      transport: 'direct',
      routeReason: 'normal',
      ready: true,
      message: 'Main will use Claude OAuth subscription via direct HTTP.',
    });
  }

  if (input.executorSettings.hasApiKey) {
    return withExecutionPreviewDefaults({
      surface: 'main',
      backend: 'direct_http',
      authPath: 'api_key',
      selectedMode: 'api',
      transport: 'direct',
      routeReason: 'normal',
      ready: true,
      message: 'Main will use Anthropic direct HTTP with an API key.',
    });
  }

  if (hasSubscriptionCredential) {
    return withExecutionPreviewDefaults({
      surface: 'main',
      backend: 'direct_http',
      authPath: 'subscription',
      selectedMode: 'subscription',
      transport: 'direct',
      routeReason: 'normal',
      ready: true,
      message: 'Main will use Claude OAuth subscription via direct HTTP.',
    });
  }

  return withExecutionPreviewDefaults({
    surface: 'main',
    backend: null,
    authPath: null,
    routeReason: 'no_valid_path',
    ready: false,
    message:
      'No Anthropic API key or Claude subscription credential is configured for this Claude agent.',
  });
}

export function RegisteredAgentsPanel(props: Props): JSX.Element {
  const {
    providers,
    executorSettings,
    containerRuntimeAvailability,
    onUnauthorized,
    canManage,
    mainAgentId,
    onAgentsChanged,
  } = props;

  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<AgentDraft | null>(null);
  const [editDraft, setEditDraft] = useState<AgentDraft | null>(null);

  // Load agents
  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    try {
      setIsLoading(true);
      setError(null);
      const result = await listRegisteredAgents();
      setAgents(result);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to load agents');
      }
    } finally {
      setIsLoading(false);
    }
  }

  function availableProviders() {
    // Show all providers — agents may reference disabled/uncredentialed providers.
    // The form marks unavailable providers visually but doesn't hide them.
    return providers;
  }

  function readyProviders() {
    // Prefer providers that are fully verified — enabled, have credentials,
    // and have been verified. Fall back to enabled + has-credential if none
    // are verified yet.
    const verified = providers.filter(
      (p) =>
        p.enabled && p.hasCredential && p.verificationStatus === 'verified',
    );
    if (verified.length > 0) return verified;
    return providers.filter((p) => p.enabled && p.hasCredential);
  }

  function getProviderModels(providerId: string) {
    const provider = providers.find((p) => p.id === providerId);
    return provider?.modelSuggestions || [];
  }

  function startCreate() {
    setIsCreating(true);
    const options = buildProviderOptions(providers);
    const defaultProviderId =
      readyProviders()[0]?.id || availableProviders()[0]?.id || '';
    const defaultOption = findProviderOption(
      options,
      defaultProviderId,
      null,
    );
    const defaultModelId =
      getProviderModels(defaultProviderId)[0]?.modelId || '';
    setCreateDraft({
      draftId: generateDraftId(),
      name: '',
      providerId: defaultProviderId,
      modelId: defaultModelId,
      personaRole: '',
      description: '',
      systemPrompt: '',
      toolPermissions: buildDefaultRegisteredAgentToolPermissions(),
      enabled: true,
      credentialMode: defaultOption?.credentialMode ?? null,
    });
  }

  function cancelCreate() {
    setIsCreating(false);
    setCreateDraft(null);
  }

  async function handleCreate() {
    if (!createDraft || !createDraft.name.trim()) {
      setError('Agent name is required');
      return;
    }

    try {
      setError(null);
      const input = {
        name: createDraft.name,
        providerId: createDraft.providerId,
        modelId: createDraft.modelId,
        personaRole: createDraft.personaRole || undefined,
        description: createDraft.description || undefined,
        systemPrompt: createDraft.systemPrompt || undefined,
        toolPermissionsJson: JSON.stringify(createDraft.toolPermissions),
        credentialMode: createDraft.credentialMode,
      };
      const newAgent = await createRegisteredAgent(input);
      const nextAgents = [...agents, newAgent];
      setAgents(nextAgents);
      onAgentsChanged?.(nextAgents);
      setIsCreating(false);
      setCreateDraft(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to create agent');
      }
    }
  }

  function startEdit(agent: RegisteredAgent) {
    setEditingAgentId(agent.id);
    setEditDraft({
      draftId: generateDraftId(),
      name: agent.name,
      providerId: agent.providerId,
      modelId: agent.modelId,
      personaRole: agent.personaRole || '',
      description: agent.description || '',
      systemPrompt: agent.systemPrompt || '',
      toolPermissions: { ...agent.toolPermissions },
      enabled: agent.enabled,
      credentialMode: agent.credentialMode,
    });
  }

  function cancelEdit() {
    setEditingAgentId(null);
    setEditDraft(null);
  }

  async function handleUpdate() {
    if (!editDraft || !editingAgentId || !editDraft.name.trim()) {
      setError('Agent name is required');
      return;
    }

    try {
      setError(null);
      const input = {
        agentId: editingAgentId,
        name: editDraft.name,
        providerId: editDraft.providerId,
        modelId: editDraft.modelId,
        personaRole: editDraft.personaRole || null,
        description: editDraft.description || null,
        systemPrompt: editDraft.systemPrompt || null,
        toolPermissionsJson: JSON.stringify(editDraft.toolPermissions),
        enabled: editDraft.enabled,
        credentialMode: editDraft.credentialMode,
      };
      const updated = await updateRegisteredAgent(input);
      const nextAgents = agents.map((a) =>
        a.id === editingAgentId ? updated : a,
      );
      setAgents(nextAgents);
      onAgentsChanged?.(nextAgents);
      setEditingAgentId(null);
      setEditDraft(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to update agent');
      }
    }
  }

  async function handleDelete(agentId: string) {
    if (!window.confirm('Are you sure you want to delete this agent?')) {
      return;
    }

    try {
      setError(null);
      await deleteRegisteredAgent(agentId);
      const nextAgents = agents.filter((a) => a.id !== agentId);
      setAgents(nextAgents);
      onAgentsChanged?.(nextAgents);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to delete agent');
      }
    }
  }

  function applyAgentUpdate(updated: RegisteredAgent) {
    const nextAgents = agents.map((a) => (a.id === updated.id ? updated : a));
    setAgents(nextAgents);
    onAgentsChanged?.(nextAgents);
  }

  function handleAgentMutationError(err: unknown, fallback: string) {
    if (err instanceof UnauthorizedError) {
      onUnauthorized();
    } else if (err instanceof ApiError) {
      setError(err.message);
    } else {
      setError(fallback);
    }
  }

  // Dismiss the "model retired — auto-upgraded" badge. Clears the trail; the
  // already-upgraded model is untouched.
  async function handleDismissModelUpgrade(agentId: string) {
    try {
      setError(null);
      applyAgentUpdate(await dismissAgentModelUpgrade(agentId));
    } catch (err) {
      handleAgentMutationError(err, 'Failed to dismiss the model notice');
    }
  }

  // Opt into a newer same-family model. A normal model change, so the backend
  // clears any auto-upgrade badge and re-resolves the lifecycle.
  async function handleApplyModelUpdate(agentId: string, modelId: string) {
    try {
      setError(null);
      applyAgentUpdate(await updateRegisteredAgent({ agentId, modelId }));
    } catch (err) {
      handleAgentMutationError(err, 'Failed to update the model');
    }
  }

  const createPreview = createDraft
    ? buildDraftExecutionPreview({
        draft: createDraft,
        providers,
        executorSettings,
        containerRuntimeAvailability,
      })
    : null;
  const editPreview = editDraft
    ? buildDraftExecutionPreview({
        draft: editDraft,
        providers,
        executorSettings,
        containerRuntimeAvailability,
      })
    : null;

  return (
    <div className="registered-agents-panel">
      <div className="registered-agents-header">
        <h3>Registered Agents</h3>
        {canManage && !isCreating && editingAgentId === null && (
          <button
            onClick={startCreate}
            className="registered-agents-button registered-agents-button-primary"
          >
            Create Agent
          </button>
        )}
      </div>

      {error && (
        <div className="registered-agents-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {isLoading ? (
        <div className="registered-agents-loading">Loading agents...</div>
      ) : agents.length === 0 ? (
        <div className="registered-agents-empty">No registered agents yet.</div>
      ) : (
        <div className="registered-agents-list">
          {agents.map((agent) => (
            <div key={agent.id} className="registered-agent-card">
              {editingAgentId === agent.id && editDraft ? (
                <AgentForm
                  draft={editDraft}
                  setDraft={setEditDraft}
                  providers={availableProviders()}
                  getProviderModels={getProviderModels}
                  executionPreview={editPreview}
                  onSave={handleUpdate}
                  onCancel={cancelEdit}
                  canManage={canManage}
                />
              ) : (
                <AgentCardView
                  agent={agent}
                  providerName={
                    providers.find((p) => p.id === agent.providerId)?.name ||
                    'Unknown'
                  }
                  isMainAgent={agent.id === mainAgentId}
                  onEdit={() => startEdit(agent)}
                  onDelete={() => handleDelete(agent.id)}
                  onDismissModelUpgrade={() =>
                    handleDismissModelUpgrade(agent.id)
                  }
                  onApplyModelUpdate={(modelId) =>
                    handleApplyModelUpdate(agent.id, modelId)
                  }
                  canManage={canManage}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {isCreating && createDraft && (
        <div className="registered-agent-card registered-agent-card-creating">
          <AgentForm
            draft={createDraft}
            setDraft={setCreateDraft}
            providers={availableProviders()}
            getProviderModels={getProviderModels}
            executionPreview={createPreview}
            onSave={handleCreate}
            onCancel={cancelCreate}
            canManage={canManage}
          />
        </div>
      )}
    </div>
  );
}

type AgentFormProps = {
  draft: AgentDraft;
  setDraft: (draft: AgentDraft) => void;
  providers: AgentProviderCard[];
  getProviderModels: (
    providerId: string,
  ) => Array<{ modelId: string; displayName: string }>;
  executionPreview: RegisteredAgent['executionPreview'] | null;
  onSave: () => void;
  onCancel: () => void;
  canManage: boolean;
};

function AgentForm({
  draft,
  setDraft,
  providers,
  getProviderModels,
  executionPreview,
  onSave,
  onCancel,
  canManage,
}: AgentFormProps): JSX.Element {
  const models = getProviderModels(draft.providerId);
  const selectedProvider = providers.find((p) => p.id === draft.providerId);
  const heavyToolsEnabled = hasHeavyTools(draft.toolPermissions);
  const isNonClaudeProvider =
    selectedProvider?.id !== 'provider.anthropic' && heavyToolsEnabled;
  const saveDisabled = !canManage || executionPreview?.ready === false;
  const providerOptions = buildProviderOptions(providers);

  return (
    <div className="agent-editor-card">
      <label className="agent-form-field">
        <span>Name</span>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Agent name"
          disabled={!canManage}
        />
      </label>

      <label className="agent-form-field">
        <span>Provider</span>
        <select
          value={providerOptionValue(draft.providerId, draft.credentialMode)}
          onChange={(e) => {
            const next = providerOptions.find((o) => o.value === e.target.value);
            if (!next) return;
            const newModelId =
              getProviderModels(next.providerId)[0]?.modelId || '';
            setDraft({
              ...draft,
              providerId: next.providerId,
              modelId: newModelId,
              credentialMode: next.credentialMode,
            });
          }}
          disabled={!canManage}
        >
          {providerOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="agent-form-field">
        <span>Model</span>
        <select
          value={draft.modelId}
          onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
          disabled={!canManage}
        >
          {models.map((m) => (
            <option key={m.modelId} value={m.modelId}>
              {m.displayName}
            </option>
          ))}
        </select>
        {selectedProvider?.liveModelDiscovery &&
        selectedProvider.liveModelDiscovery.status !== 'ok' ? (
          <div className="agent-form-warning">
            {selectedProvider.liveModelDiscovery.message ||
              'Live model discovery unavailable — showing curated models only.'}
          </div>
        ) : null}
      </label>

      <label className="agent-form-field">
        <span>Persona Role (optional)</span>
        <input
          type="text"
          value={draft.personaRole}
          onChange={(e) => setDraft({ ...draft, personaRole: e.target.value })}
          placeholder="e.g., Senior Engineer"
          disabled={!canManage}
        />
      </label>

      <label className="agent-form-field agent-form-field-full">
        <span>Description (optional)</span>
        <textarea
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="Short summary that shows up in the Talk invite picker"
          disabled={!canManage}
          rows={2}
          className="agent-form-textarea"
        />
      </label>

      <label className="agent-form-field agent-form-field-full">
        <span>System Prompt Template (optional)</span>
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
          placeholder="Persona instructions sent as the system prompt for every Talk run"
          disabled={!canManage}
          rows={3}
          className="agent-form-textarea"
        />
      </label>

      <label className="agent-form-field agent-form-field-full">
        <span>Enabled</span>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          disabled={!canManage}
          style={{ width: 'auto' }}
        />
      </label>

      <div className="agent-form-field-full agent-form-tools-section">
        <span className="agent-form-tools-title">Tool capabilities</span>

        {isNonClaudeProvider && (
          <div className="agent-form-warning">
            ⚠️ Shell, Filesystem, and Browser tools require the Claude provider.
          </div>
        )}
        {executionPreview ? (
          <div
            className={
              executionPreview.ready
                ? executionPreview.routeReason === 'subscription_fallback'
                  ? 'agent-form-warning'
                  : 'talk-llm-meta'
                : 'agent-form-warning'
            }
          >
            {executionPreview.message}
          </div>
        ) : null}

        {Object.entries(TOOL_FAMILY_GROUPS).map(([groupLabel, toolNames]) => (
          <div key={groupLabel} className="agent-form-tool-group">
            <div className="agent-form-tool-group-label">{groupLabel}</div>
            <div className="agent-form-tool-checkboxes">
              {toolNames.map((toolName) => (
                <label key={toolName} className="agent-form-tool-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.toolPermissions[toolName] || false}
                    onChange={(e) => {
                      setDraft({
                        ...draft,
                        toolPermissions: {
                          ...draft.toolPermissions,
                          [toolName]: e.target.checked,
                        },
                      });
                    }}
                    disabled={!canManage}
                  />
                  <span>{TOOL_NAMES[toolName]}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="agent-editor-actions">
        <button
          onClick={onSave}
          className="registered-agents-button registered-agents-button-primary"
          disabled={saveDisabled}
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="registered-agents-button registered-agents-button-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

type AgentCardViewProps = {
  agent: RegisteredAgent;
  providerName: string;
  isMainAgent: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onDismissModelUpgrade: () => void;
  onApplyModelUpdate: (modelId: string) => void;
  canManage: boolean;
};

function AgentCardView({
  agent,
  providerName,
  isMainAgent,
  onEdit,
  onDelete,
  onDismissModelUpgrade,
  onApplyModelUpdate,
  canManage,
}: AgentCardViewProps): JSX.Element {
  const toolList = Object.entries(agent.toolPermissions)
    .filter(([, enabled]) => enabled)
    .map(([toolName]) => TOOL_NAMES[toolName] || toolName);

  const credentialModeBadge = credentialModeBadgeLabel(agent.credentialMode);
  // A const (not the prop directly) so TS keeps the non-null narrowing inside
  // the Update button's click closure.
  const updateAvailable = agent.modelUpdateAvailable;
  return (
    <>
      <div className="registered-agent-card-content">
        <div className="registered-agent-card-header">
          <div>
            <h4>{agent.name}</h4>
            <div className="registered-agent-card-meta">
              <span className="registered-agent-provider">{providerName}</span>
              {credentialModeBadge && (
                <span className="registered-agent-role">
                  {credentialModeBadge}
                </span>
              )}
              {agent.personaRole && (
                <span className="registered-agent-role">
                  {agent.personaRole}
                </span>
              )}
              {isMainAgent && (
                <span className="registered-agent-role">Main Agent</span>
              )}
              {!agent.enabled && (
                <span className="registered-agent-disabled">Disabled</span>
              )}
            </div>
            {agent.description ? (
              <p className="registered-agent-description">
                {agent.description}
              </p>
            ) : null}
            <p
              className={
                agent.executionPreview.ready
                  ? 'talk-llm-meta'
                  : 'talk-llm-meta error-text'
              }
            >
              {agent.executionPreview.message}
            </p>
          </div>
          {canManage && (
            <div className="registered-agent-card-actions">
              <button
                onClick={onEdit}
                className="registered-agents-button registered-agents-button-small"
              >
                Edit
              </button>
              {!isMainAgent ? (
                <button
                  onClick={onDelete}
                  className="registered-agents-button registered-agents-button-small registered-agents-button-danger"
                >
                  Delete
                </button>
              ) : null}
            </div>
          )}
        </div>

        {agent.modelAutoUpgradedFrom && (
          <div className="registered-agent-model-notice registered-agent-model-notice-retired">
            <span>
              Model retired — auto-upgraded from{' '}
              <code>{agent.modelAutoUpgradedFrom}</code> to{' '}
              <code>{agent.modelId}</code>.
            </span>
            {canManage && (
              <button
                onClick={onDismissModelUpgrade}
                className="registered-agents-button registered-agents-button-small"
              >
                Dismiss
              </button>
            )}
          </div>
        )}

        {updateAvailable && (
          <div className="registered-agent-model-notice registered-agent-model-notice-update">
            <span>
              {updateAvailable.displayName ?? updateAvailable.modelId} available.
            </span>
            {canManage && (
              <button
                onClick={() => onApplyModelUpdate(updateAvailable.modelId)}
                className="registered-agents-button registered-agents-button-small registered-agents-button-primary"
              >
                Update
              </button>
            )}
          </div>
        )}

        {toolList.length > 0 && (
          <div className="registered-agent-card-tools">
            {toolList.map((tool) => (
              <span key={tool} className="registered-agent-tool-pill">
                {tool}
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
