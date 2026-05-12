import { useMemo, useState } from 'react';

import {
  ApiError,
  getTalkLlmSettings,
  type TalkLlmProvider,
  type TalkLlmRoute,
  type TalkLlmSettings,
  type TalkLlmSettingsUpdate,
  UnauthorizedError,
  updateTalkLlmSettings,
} from '../lib/api';

type Props = {
  onUnauthorized: () => void;
};

type ProviderModelDraft = {
  draftId: string;
  modelId: string;
  displayName: string;
  contextWindowTokens: string;
  defaultMaxOutputTokens: string;
  supportsTools: boolean;
  enabled: boolean;
};

type ProviderDraft = {
  draftId: string;
  id: string;
  name: string;
  providerKind: TalkLlmProvider['providerKind'];
  apiFormat: TalkLlmProvider['apiFormat'];
  baseUrl: string;
  authScheme: TalkLlmProvider['authScheme'];
  enabled: boolean;
  coreCompatibility: TalkLlmProvider['coreCompatibility'];
  responseStartTimeoutMs: string;
  streamIdleTimeoutMs: string;
  absoluteTimeoutMs: string;
  hasCredential: boolean;
  clearCredential: boolean;
  credentialApiKey: string;
  credentialOrganizationId: string;
  models: ProviderModelDraft[];
};

type RouteStepDraft = {
  draftId: string;
  position: string;
  providerId: string;
  modelId: string;
};

type RouteDraft = {
  draftId: string;
  id: string;
  name: string;
  enabled: boolean;
  assignedAgentCount: number;
  assignedTalkCount: number;
  steps: RouteStepDraft[];
};

const PROVIDER_KIND_OPTIONS: Array<TalkLlmProvider['providerKind']> = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'kimi',
  'nvidia',
  'custom',
];

const API_FORMAT_OPTIONS: Array<TalkLlmProvider['apiFormat']> = [
  'anthropic_messages',
  'openai_chat_completions',
];

const AUTH_SCHEME_OPTIONS: Array<TalkLlmProvider['authScheme']> = [
  'x_api_key',
  'bearer',
];

const CORE_COMPATIBILITY_OPTIONS: Array<TalkLlmProvider['coreCompatibility']> = [
  'none',
  'claude_sdk_proxy',
];

function createDraftId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  return `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function numberToDraft(value: number | null): string {
  return value == null ? '' : String(value);
}

function buildProviderDrafts(providers: TalkLlmSettings['providers']): ProviderDraft[] {
  return providers.map((provider) => ({
    draftId: createDraftId(),
    id: provider.id,
    name: provider.name,
    providerKind: provider.providerKind,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    authScheme: provider.authScheme,
    enabled: provider.enabled,
    coreCompatibility: provider.coreCompatibility,
    responseStartTimeoutMs: numberToDraft(provider.responseStartTimeoutMs),
    streamIdleTimeoutMs: numberToDraft(provider.streamIdleTimeoutMs),
    absoluteTimeoutMs: numberToDraft(provider.absoluteTimeoutMs),
    hasCredential: provider.hasCredential,
    clearCredential: false,
    credentialApiKey: '',
    credentialOrganizationId: '',
    models: provider.models.map((model) => ({
      draftId: createDraftId(),
      modelId: model.modelId,
      displayName: model.displayName,
      contextWindowTokens: String(model.contextWindowTokens),
      defaultMaxOutputTokens: String(model.defaultMaxOutputTokens),
      supportsTools: model.supportsTools === true,
      enabled: model.enabled,
    })),
  }));
}

function buildRouteDrafts(routes: TalkLlmSettings['routes']): RouteDraft[] {
  return routes.map((route) => ({
    draftId: createDraftId(),
    id: route.id,
    name: route.name,
    enabled: route.enabled,
    assignedAgentCount: route.assignedAgentCount,
    assignedTalkCount: route.assignedTalkCount,
    steps: route.steps.map((step) => ({
      draftId: createDraftId(),
      position: String(step.position),
      providerId: step.providerId,
      modelId: step.modelId,
    })),
  }));
}

function parsePositiveInteger(fieldLabel: string, value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldLabel} must be a positive integer.`);
  }
  return Math.floor(parsed);
}

function parseNonNegativeInteger(fieldLabel: string, value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldLabel} must be a non-negative integer.`);
  }
  return Math.floor(parsed);
}

function parseOptionalPositiveInteger(
  fieldLabel: string,
  value: string,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parsePositiveInteger(fieldLabel, trimmed);
}

function buildTalkLlmPayload(input: {
  defaultRouteId: string;
  providers: ProviderDraft[];
  routes: RouteDraft[];
}): TalkLlmSettingsUpdate {
  const defaultRouteId = input.defaultRouteId.trim();
  if (!defaultRouteId) {
    throw new Error('Default route is required.');
  }

  const providerIds = new Set<string>();
  const modelIdsByProvider = new Map<string, Set<string>>();
  const providers = input.providers.map((provider, providerIndex) => {
    const providerId = provider.id.trim();
    const providerName = provider.name.trim();
    if (!providerId) {
      throw new Error(`Provider ${providerIndex + 1} is missing an id.`);
    }
    if (!providerName) {
      throw new Error(`Provider ${providerId} is missing a name.`);
    }
    if (providerIds.has(providerId)) {
      throw new Error(`Duplicate provider id "${providerId}" is not allowed.`);
    }
    providerIds.add(providerId);

    const modelIds = new Set<string>();
    const models = provider.models.map((model, modelIndex) => {
      const modelId = model.modelId.trim();
      if (!modelId) {
        throw new Error(
          `Provider ${providerId} model ${modelIndex + 1} is missing a model id.`,
        );
      }
      if (modelIds.has(modelId)) {
        throw new Error(
          `Provider ${providerId} contains duplicate model id "${modelId}".`,
        );
      }
      modelIds.add(modelId);
      return {
        modelId,
        displayName: model.displayName.trim() || modelId,
        contextWindowTokens: parsePositiveInteger(
          `${providerId}/${modelId} context window`,
          model.contextWindowTokens,
        ),
        defaultMaxOutputTokens: parsePositiveInteger(
          `${providerId}/${modelId} default max output`,
          model.defaultMaxOutputTokens,
        ),
        supportsTools: model.supportsTools,
        enabled: model.enabled,
      };
    });
    modelIdsByProvider.set(providerId, modelIds);

    let credential: TalkLlmSettingsUpdate['providers'][number]['credential'];
    if (provider.clearCredential) {
      credential = null;
    } else if (provider.credentialApiKey.trim()) {
      credential = {
        apiKey: provider.credentialApiKey.trim(),
        organizationId: provider.credentialOrganizationId.trim() || undefined,
      };
    } else {
      credential = undefined;
    }

    return {
      id: providerId,
      name: providerName,
      providerKind: provider.providerKind,
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl.trim(),
      authScheme: provider.authScheme,
      enabled: provider.enabled,
      coreCompatibility: provider.coreCompatibility,
      responseStartTimeoutMs: parseOptionalPositiveInteger(
        `${providerId} response-start timeout`,
        provider.responseStartTimeoutMs,
      ),
      streamIdleTimeoutMs: parseOptionalPositiveInteger(
        `${providerId} stream-idle timeout`,
        provider.streamIdleTimeoutMs,
      ),
      absoluteTimeoutMs: parseOptionalPositiveInteger(
        `${providerId} absolute timeout`,
        provider.absoluteTimeoutMs,
      ),
      models,
      credential,
    };
  });

  const routeIds = new Set<string>();
  const routes = input.routes.map((route, routeIndex) => {
    const routeId = route.id.trim();
    const routeName = route.name.trim();
    if (!routeId) {
      throw new Error(`Route ${routeIndex + 1} is missing an id.`);
    }
    if (!routeName) {
      throw new Error(`Route ${routeId} is missing a name.`);
    }
    if (routeIds.has(routeId)) {
      throw new Error(`Duplicate route id "${routeId}" is not allowed.`);
    }
    routeIds.add(routeId);

    const steps = route.steps
      .map((step, stepIndex) => {
        const providerId = step.providerId.trim();
        const modelId = step.modelId.trim();
        if (!providerId || !modelId) {
          throw new Error(
            `Route ${routeId} step ${stepIndex + 1} must include both provider and model.`,
          );
        }
        const providerModelIds = modelIdsByProvider.get(providerId);
        if (!providerModelIds) {
          throw new Error(
            `Route ${routeId} references unknown provider "${providerId}".`,
          );
        }
        if (!providerModelIds.has(modelId)) {
          throw new Error(
            `Route ${routeId} references unknown model "${modelId}" on provider "${providerId}".`,
          );
        }
        return {
          position: parseNonNegativeInteger(
            `${routeId} step ${stepIndex + 1} position`,
            step.position,
          ),
          providerId,
          modelId,
        };
      })
      .sort((left, right) => left.position - right.position);

    if (steps.length === 0) {
      throw new Error(`Route ${routeId} must have at least one step.`);
    }

    return {
      id: routeId,
      name: routeName,
      enabled: route.enabled,
      steps,
    };
  });

  if (!routeIds.has(defaultRouteId)) {
    throw new Error('Default route must match one of the configured routes.');
  }

  return {
    defaultRouteId,
    providers,
    routes,
  };
}

export function TalkLlmSettingsCard({ onUnauthorized }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [defaultRouteId, setDefaultRouteId] = useState('');
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [routes, setRoutes] = useState<RouteDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const providerOptions = useMemo(
    () =>
      providers.map((provider) => ({
        id: provider.id.trim(),
        name: provider.name.trim() || provider.id.trim() || 'Unnamed provider',
        models: provider.models.map((model) => ({
          modelId: model.modelId.trim(),
          displayName: model.displayName.trim() || model.modelId.trim(),
        })),
      })),
    [providers],
  );

  const applySnapshot = (snapshot: TalkLlmSettings): void => {
    setDefaultRouteId(snapshot.defaultRouteId || '');
    setProviders(buildProviderDrafts(snapshot.providers));
    setRoutes(buildRouteDrafts(snapshot.routes));
    setLoaded(true);
  };

  const loadSnapshot = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const snapshot = await getTalkLlmSettings();
      applySnapshot(snapshot);
      setNotice('Talk LLM settings loaded.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to load Talk LLM settings.',
      );
    } finally {
      setBusy(false);
    }
  };

  const saveSnapshot = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = buildTalkLlmPayload({
        defaultRouteId,
        providers,
        routes,
      });
      const nextSnapshot = await updateTalkLlmSettings(payload);
      applySnapshot(nextSnapshot);
      setNotice(
        'Talk LLM settings saved. Provider and route changes apply on the next talk run.',
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to save Talk LLM settings.',
      );
    } finally {
      setBusy(false);
    }
  };

  const updateProvider = (
    draftId: string,
    updater: (provider: ProviderDraft) => ProviderDraft,
  ): void => {
    setProviders((current) =>
      current.map((provider) =>
        provider.draftId === draftId ? updater(provider) : provider,
      ),
    );
  };

  const updateRoute = (
    draftId: string,
    updater: (route: RouteDraft) => RouteDraft,
  ): void => {
    setRoutes((current) =>
      current.map((route) => (route.draftId === draftId ? updater(route) : route)),
    );
  };

  return (
    <section className="settings-card">
      <header>
        <h2>Talk LLM Settings</h2>
        <p className="settings-copy">
          Manage provider-neutral Talk providers, routes, and the global default
          route. Stored credentials are write-only: loading settings never returns
          the saved secret, and a blank key field preserves the existing one.
        </p>
      </header>

      {error ? (
        <div className="settings-banner settings-banner-error">{error}</div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success">{notice}</div>
      ) : null}

      {!loaded ? (
        <div className="settings-section-actions">
          <button
            type="button"
            className="secondary-btn"
            disabled={busy}
            onClick={() => {
              void loadSnapshot();
            }}
          >
            {busy ? 'Loading…' : 'Load Talk LLM Settings'}
          </button>
        </div>
      ) : (
        <div className="talk-llm-editor">
          <div className="talk-llm-toolbar">
            <label className="settings-field-span">
              <span>Default Talk Route</span>
              <select
                value={defaultRouteId}
                onChange={(event) => setDefaultRouteId(event.target.value)}
                disabled={busy}
              >
                <option value="">Select a default route</option>
                {routes.map((route) => (
                  <option key={route.draftId} value={route.id}>
                    {route.name || route.id || 'Unnamed route'}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-section-actions">
              <button
                type="button"
                className="secondary-btn"
                disabled={busy}
                onClick={() => {
                  void loadSnapshot();
                }}
              >
                Reload Snapshot
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={busy}
                onClick={() => {
                  void saveSnapshot();
                }}
              >
                {busy ? 'Saving…' : 'Save Talk LLM Settings'}
              </button>
            </div>
          </div>

          <section className="talk-llm-section">
            <div className="talk-llm-section-header">
              <div>
                <h3>Providers</h3>
                <p className="settings-copy">
                  Providers define credentials, base URLs, supported models, and
                  timeout policy.
                </p>
              </div>
              <button
                type="button"
                className="secondary-btn"
                disabled={busy}
                onClick={() =>
                  setProviders((current) => [
                    ...current,
                    {
                      draftId: createDraftId(),
                      id: '',
                      name: '',
                      providerKind: 'custom',
                      apiFormat: 'openai_chat_completions',
                      baseUrl: '',
                      authScheme: 'bearer',
                      enabled: true,
                      coreCompatibility: 'none',
                      responseStartTimeoutMs: '',
                      streamIdleTimeoutMs: '',
                      absoluteTimeoutMs: '',
                      hasCredential: false,
                      clearCredential: false,
                      credentialApiKey: '',
                      credentialOrganizationId: '',
                      models: [
                        {
                          draftId: createDraftId(),
                          modelId: '',
                          displayName: '',
                          contextWindowTokens: '128000',
                          defaultMaxOutputTokens: '4096',
                          supportsTools: false,
                          enabled: true,
                        },
                      ],
                    },
                  ])
                }
              >
                Add Provider
              </button>
            </div>

            <div className="talk-llm-card-list">
              {providers.map((provider) => (
                <article key={provider.draftId} className="talk-llm-card">
                  <div className="talk-llm-card-header">
                    <div>
                      <h4>{provider.name.trim() || provider.id.trim() || 'New Provider'}</h4>
                      <p className="talk-llm-meta">{provider.id.trim() || 'No provider id yet'}</p>
                    </div>
                    <button
                      type="button"
                      className="secondary-btn"
                      disabled={busy}
                      onClick={() =>
                        setProviders((current) =>
                          current.filter((entry) => entry.draftId !== provider.draftId),
                        )
                      }
                    >
                      Remove Provider
                    </button>
                  </div>

                  <div className="talk-llm-grid">
                    <label>
                      <span>Provider ID</span>
                      <input
                        type="text"
                        value={provider.id}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            id: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>Name</span>
                      <input
                        type="text"
                        value={provider.name}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>Provider Kind</span>
                      <select
                        value={provider.providerKind}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            providerKind: event.target
                              .value as ProviderDraft['providerKind'],
                          }))
                        }
                      >
                        {PROVIDER_KIND_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>API Format</span>
                      <select
                        value={provider.apiFormat}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            apiFormat: event.target.value as ProviderDraft['apiFormat'],
                          }))
                        }
                      >
                        {API_FORMAT_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="talk-llm-field-span">
                      <span>Base URL</span>
                      <input
                        type="text"
                        value={provider.baseUrl}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            baseUrl: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>Auth Scheme</span>
                      <select
                        value={provider.authScheme}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            authScheme: event.target
                              .value as ProviderDraft['authScheme'],
                          }))
                        }
                      >
                        {AUTH_SCHEME_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Core Compatibility</span>
                      <select
                        value={provider.coreCompatibility}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            coreCompatibility: event.target
                              .value as ProviderDraft['coreCompatibility'],
                          }))
                        }
                      >
                        {CORE_COMPATIBILITY_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Response Start Timeout (ms)</span>
                      <input
                        type="number"
                        min="1"
                        value={provider.responseStartTimeoutMs}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            responseStartTimeoutMs: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>Stream Idle Timeout (ms)</span>
                      <input
                        type="number"
                        min="1"
                        value={provider.streamIdleTimeoutMs}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            streamIdleTimeoutMs: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>Absolute Timeout (ms)</span>
                      <input
                        type="number"
                        min="1"
                        value={provider.absoluteTimeoutMs}
                        disabled={busy}
                        onChange={(event) =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            absoluteTimeoutMs: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>

                  <label className="talk-llm-checkbox">
                    <input
                      type="checkbox"
                      checked={provider.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        updateProvider(provider.draftId, (current) => ({
                          ...current,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                    <span>Provider enabled</span>
                  </label>

                  <div className="talk-llm-subsection">
                    <div className="talk-llm-subsection-header">
                      <h5>Credential</h5>
                      <span className="talk-llm-meta">
                        {provider.hasCredential && !provider.clearCredential
                          ? 'Stored credential present'
                          : 'No stored credential'}
                      </span>
                    </div>
                    <div className="talk-llm-grid">
                      <label>
                        <span>API Key</span>
                        <input
                          type="password"
                          value={provider.credentialApiKey}
                          disabled={busy}
                          placeholder={
                            provider.hasCredential && !provider.clearCredential
                              ? 'Stored key will be preserved'
                              : 'Enter a new API key'
                          }
                          onChange={(event) =>
                            updateProvider(provider.draftId, (current) => ({
                              ...current,
                              credentialApiKey: event.target.value,
                              clearCredential: false,
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>Organization ID (optional)</span>
                        <input
                          type="text"
                          value={provider.credentialOrganizationId}
                          disabled={busy}
                          onChange={(event) =>
                            updateProvider(provider.draftId, (current) => ({
                              ...current,
                              credentialOrganizationId: event.target.value,
                              clearCredential: false,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <div className="settings-section-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        disabled={busy}
                        onClick={() =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            clearCredential: true,
                            credentialApiKey: '',
                            credentialOrganizationId: '',
                          }))
                        }
                      >
                        Clear Stored Credential
                      </button>
                    </div>
                  </div>

                  <div className="talk-llm-subsection">
                    <div className="talk-llm-subsection-header">
                      <h5>Models</h5>
                      <button
                        type="button"
                        className="secondary-btn"
                        disabled={busy}
                        onClick={() =>
                          updateProvider(provider.draftId, (current) => ({
                            ...current,
                            models: [
                              ...current.models,
                              {
                                draftId: createDraftId(),
                                modelId: '',
                                displayName: '',
                                contextWindowTokens: '128000',
                                defaultMaxOutputTokens: '4096',
                                supportsTools: false,
                                enabled: true,
                              },
                            ],
                          }))
                        }
                      >
                        Add Model
                      </button>
                    </div>
                    <div className="talk-llm-card-list talk-llm-card-list-compact">
                      {provider.models.map((model) => (
                        <div key={model.draftId} className="talk-llm-nested-card">
                          <div className="talk-llm-grid">
                            <label>
                              <span>Model ID</span>
                              <input
                                type="text"
                                value={model.modelId}
                                disabled={busy}
                                onChange={(event) =>
                                  updateProvider(provider.draftId, (current) => ({
                                    ...current,
                                    models: current.models.map((entry) =>
                                      entry.draftId === model.draftId
                                        ? { ...entry, modelId: event.target.value }
                                        : entry,
                                    ),
                                  }))
                                }
                              />
                            </label>
                            <label>
                              <span>Display Name</span>
                              <input
                                type="text"
                                value={model.displayName}
                                disabled={busy}
                                onChange={(event) =>
                                  updateProvider(provider.draftId, (current) => ({
                                    ...current,
                                    models: current.models.map((entry) =>
                                      entry.draftId === model.draftId
                                        ? { ...entry, displayName: event.target.value }
                                        : entry,
                                    ),
                                  }))
                                }
                              />
                            </label>
                            <label>
                              <span>Context Window Tokens</span>
                              <input
                                type="number"
                                min="1"
                                value={model.contextWindowTokens}
                                disabled={busy}
                                onChange={(event) =>
                                  updateProvider(provider.draftId, (current) => ({
                                    ...current,
                                    models: current.models.map((entry) =>
                                      entry.draftId === model.draftId
                                        ? {
                                            ...entry,
                                            contextWindowTokens: event.target.value,
                                          }
                                        : entry,
                                    ),
                                  }))
                                }
                              />
                            </label>
                            <label>
                              <span>Default Max Output Tokens</span>
                              <input
                                type="number"
                                min="1"
                                value={model.defaultMaxOutputTokens}
                                disabled={busy}
                                onChange={(event) =>
                                  updateProvider(provider.draftId, (current) => ({
                                    ...current,
                                    models: current.models.map((entry) =>
                                      entry.draftId === model.draftId
                                        ? {
                                            ...entry,
                                            defaultMaxOutputTokens:
                                              event.target.value,
                                          }
                                        : entry,
                                    ),
                                  }))
                                }
                              />
                            </label>
                          </div>
                          <div className="talk-llm-inline-actions">
                            <label className="talk-llm-checkbox">
                              <input
                                type="checkbox"
                                checked={model.supportsTools}
                                disabled={busy}
                                onChange={(event) =>
                                  updateProvider(provider.draftId, (current) => ({
                                    ...current,
                                    models: current.models.map((entry) =>
                                      entry.draftId === model.draftId
                                        ? {
                                            ...entry,
                                            supportsTools: event.target.checked,
                                          }
                                        : entry,
                                    ),
                                  }))
                                }
                              />
                              <span>Supports tool use</span>
                            </label>
                            <label className="talk-llm-checkbox">
                              <input
                                type="checkbox"
                                checked={model.enabled}
                                disabled={busy}
                                onChange={(event) =>
                                  updateProvider(provider.draftId, (current) => ({
                                    ...current,
                                    models: current.models.map((entry) =>
                                      entry.draftId === model.draftId
                                        ? { ...entry, enabled: event.target.checked }
                                        : entry,
                                    ),
                                  }))
                                }
                              />
                              <span>Enabled</span>
                            </label>
                            <button
                              type="button"
                              className="secondary-btn"
                              disabled={busy}
                              onClick={() =>
                                updateProvider(provider.draftId, (current) => ({
                                  ...current,
                                  models: current.models.filter(
                                    (entry) => entry.draftId !== model.draftId,
                                  ),
                                }))
                              }
                            >
                              Remove Model
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="talk-llm-section">
            <div className="talk-llm-section-header">
              <div>
                <h3>Routes</h3>
                <p className="settings-copy">
                  Routes define the primary model and ordered fallback steps used
                  by Talk agents.
                </p>
              </div>
              <button
                type="button"
                className="secondary-btn"
                disabled={busy}
                onClick={() =>
                  setRoutes((current) => [
                    ...current,
                    {
                      draftId: createDraftId(),
                      id: '',
                      name: '',
                      enabled: true,
                      assignedAgentCount: 0,
                      assignedTalkCount: 0,
                      steps: [
                        {
                          draftId: createDraftId(),
                          position: '0',
                          providerId: providerOptions[0]?.id || '',
                          modelId: providerOptions[0]?.models[0]?.modelId || '',
                        },
                      ],
                    },
                  ])
                }
              >
                Add Route
              </button>
            </div>

            <div className="talk-llm-card-list">
              {routes.map((route) => (
                <article key={route.draftId} className="talk-llm-card">
                  <div className="talk-llm-card-header">
                    <div>
                      <h4>{route.name.trim() || route.id.trim() || 'New Route'}</h4>
                      <p className="talk-llm-meta">
                        {route.assignedAgentCount} agents across {route.assignedTalkCount} talks
                      </p>
                    </div>
                    <div className="talk-llm-inline-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        disabled={busy}
                        onClick={() => setDefaultRouteId(route.id)}
                      >
                        Use As Default
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        disabled={busy}
                        onClick={() =>
                          setRoutes((current) =>
                            current.filter((entry) => entry.draftId !== route.draftId),
                          )
                        }
                      >
                        Remove Route
                      </button>
                    </div>
                  </div>

                  <div className="talk-llm-grid">
                    <label>
                      <span>Route ID</span>
                      <input
                        type="text"
                        value={route.id}
                        disabled={busy}
                        onChange={(event) =>
                          updateRoute(route.draftId, (current) => ({
                            ...current,
                            id: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>Name</span>
                      <input
                        type="text"
                        value={route.name}
                        disabled={busy}
                        onChange={(event) =>
                          updateRoute(route.draftId, (current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>

                  <label className="talk-llm-checkbox">
                    <input
                      type="checkbox"
                      checked={route.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        updateRoute(route.draftId, (current) => ({
                          ...current,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                    <span>Route enabled</span>
                  </label>

                  <div className="talk-llm-subsection">
                    <div className="talk-llm-subsection-header">
                      <h5>Steps</h5>
                      <button
                        type="button"
                        className="secondary-btn"
                        disabled={busy}
                        onClick={() =>
                          updateRoute(route.draftId, (current) => ({
                            ...current,
                            steps: [
                              ...current.steps,
                              {
                                draftId: createDraftId(),
                                position: String(current.steps.length),
                                providerId: providerOptions[0]?.id || '',
                                modelId: providerOptions[0]?.models[0]?.modelId || '',
                              },
                            ],
                          }))
                        }
                      >
                        Add Step
                      </button>
                    </div>
                    <div className="talk-llm-card-list talk-llm-card-list-compact">
                      {route.steps.map((step) => {
                        const currentProvider =
                          providerOptions.find(
                            (provider) => provider.id === step.providerId,
                          ) || providerOptions[0];
                        const modelOptions = currentProvider?.models || [];
                        const hasCurrentModel = modelOptions.some(
                          (model) => model.modelId === step.modelId,
                        );

                        return (
                          <div key={step.draftId} className="talk-llm-nested-card">
                            <div className="talk-llm-grid">
                              <label>
                                <span>Position</span>
                                <input
                                  type="number"
                                  min="0"
                                  value={step.position}
                                  disabled={busy}
                                  onChange={(event) =>
                                    updateRoute(route.draftId, (current) => ({
                                      ...current,
                                      steps: current.steps.map((entry) =>
                                        entry.draftId === step.draftId
                                          ? { ...entry, position: event.target.value }
                                          : entry,
                                      ),
                                    }))
                                  }
                                />
                              </label>
                              <label>
                                <span>Provider</span>
                                <select
                                  value={step.providerId}
                                  disabled={busy}
                                  onChange={(event) =>
                                    updateRoute(route.draftId, (current) => {
                                      const nextProvider = providerOptions.find(
                                        (provider) =>
                                          provider.id === event.target.value,
                                      );
                                      return {
                                        ...current,
                                        steps: current.steps.map((entry) =>
                                          entry.draftId === step.draftId
                                            ? {
                                                ...entry,
                                                providerId: event.target.value,
                                                modelId:
                                                  nextProvider?.models[0]?.modelId ||
                                                  entry.modelId,
                                              }
                                            : entry,
                                        ),
                                      };
                                    })
                                  }
                                >
                                  <option value="">Select provider</option>
                                  {providerOptions.map((provider) => (
                                    <option key={provider.id || provider.name} value={provider.id}>
                                      {provider.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                <span>Model</span>
                                <select
                                  value={step.modelId}
                                  disabled={busy}
                                  onChange={(event) =>
                                    updateRoute(route.draftId, (current) => ({
                                      ...current,
                                      steps: current.steps.map((entry) =>
                                        entry.draftId === step.draftId
                                          ? { ...entry, modelId: event.target.value }
                                          : entry,
                                      ),
                                    }))
                                  }
                                >
                                  <option value="">Select model</option>
                                  {!hasCurrentModel && step.modelId ? (
                                    <option value={step.modelId}>{step.modelId}</option>
                                  ) : null}
                                  {modelOptions.map((model) => (
                                    <option key={model.modelId} value={model.modelId}>
                                      {model.displayName || model.modelId}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <div className="talk-llm-inline-actions">
                              <button
                                type="button"
                                className="secondary-btn"
                                disabled={busy}
                                onClick={() =>
                                  updateRoute(route.draftId, (current) => ({
                                    ...current,
                                    steps: current.steps.filter(
                                      (entry) => entry.draftId !== step.draftId,
                                    ),
                                  }))
                                }
                              >
                                Remove Step
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
