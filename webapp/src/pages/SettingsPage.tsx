import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  ApiError,
  type AgentProviderCard,
  type AiAgentsPageData,
  type ExecutorSettings,
  type ProviderCredentialScope,
  type ProviderVerificationStatus,
  type RegisteredAgent,
  type SessionUser,
  completeAnthropicSubscriptionOauth,
  getAiAgents,
  getMainRegisteredAgent,
  initiateAnthropicSubscriptionOauth,
  initiateOpenAiCodexSubscriptionOauth,
  listRegisteredAgents,
  pollOpenAiCodexSubscriptionOauth,
  saveAiProviderCredential,
  UnauthorizedError,
  updateMainRegisteredAgent,
  updateSessionMe,
  verifyAiProviderCredential,
} from '../lib/api';
import { RegisteredAgentsPanel } from '../components/RegisteredAgentsPanel';

type Props = {
  user: SessionUser;
  userRole: string;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
};

type SettingsTab = 'profile' | 'api-keys' | 'agents';

type ProviderDraft = {
  apiKey: string;
  showApiKey: boolean;
  expanded: boolean;
};

const TAB_VALUES: readonly SettingsTab[] = ['profile', 'api-keys', 'agents'];

const PROVIDER_DOCS: Record<string, { url: string; label: string }> = {
  'provider.anthropic': {
    url: 'https://console.anthropic.com/settings/keys',
    label: 'Anthropic Console',
  },
  'provider.openai': {
    url: 'https://platform.openai.com/api-keys',
    label: 'OpenAI Platform',
  },
  'provider.gemini': {
    url: 'https://aistudio.google.com/app/apikey',
    label: 'Google AI Studio',
  },
  'provider.nvidia': {
    url: 'https://build.nvidia.com/',
    label: 'NVIDIA Build',
  },
};

const PROVIDER_KEY_PLACEHOLDER: Record<string, string> = {
  'provider.anthropic': 'sk-ant-...',
  'provider.openai': 'sk-...',
  'provider.gemini': 'AIza...',
  'provider.nvidia': 'nvapi-...',
};

function parseTab(value: string | null): SettingsTab {
  return TAB_VALUES.includes(value as SettingsTab)
    ? (value as SettingsTab)
    : 'profile';
}

function canManageAdmin(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function formatVerification(status: ProviderVerificationStatus): string {
  switch (status) {
    case 'verified':
      return 'Verified';
    case 'invalid':
      return 'Invalid';
    case 'verifying':
      return 'Verifying…';
    case 'rate_limited':
      return 'Rate limited';
    case 'unavailable':
      return 'Unavailable';
    case 'not_verified':
      return 'Needs verification';
    case 'missing':
    default:
      return 'Not configured';
  }
}

function verificationChipClass(status: ProviderVerificationStatus): string {
  switch (status) {
    case 'verified':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'invalid':
      return 'talk-agent-chip talk-agent-chip-error';
    case 'unavailable':
    case 'rate_limited':
      return 'talk-agent-chip talk-agent-chip-warning';
    default:
      return 'talk-agent-chip';
  }
}

type ProviderScopeView = {
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus: ProviderVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
};

function projectProvider(
  provider: AgentProviderCard,
  scope: ProviderCredentialScope,
): ProviderScopeView {
  if (scope === 'workspace') {
    return {
      hasCredential: provider.workspaceHasCredential,
      credentialHint: provider.workspaceCredentialHint,
      verificationStatus: provider.workspaceVerificationStatus,
      lastVerifiedAt: provider.workspaceLastVerifiedAt,
      lastVerificationError: provider.workspaceLastVerificationError,
    };
  }
  return {
    hasCredential: provider.hasCredential,
    credentialHint: provider.credentialHint,
    verificationStatus: provider.verificationStatus,
    lastVerifiedAt: provider.lastVerifiedAt,
    lastVerificationError: provider.lastVerificationError,
  };
}

// The new cloud Worker has no Anthropic-container runtime, so the
// Anthropic execution preview the RegisteredAgentsPanel renders is
// derived purely from whether an Anthropic API key is on file. We
// pass a synthetic ExecutorSettings shape that drives the panel's
// "Main will use Anthropic direct HTTP" branch when the Anthropic
// card has a credential, and the "no key configured" branch otherwise.
function deriveExecutorSettings(
  providers: AgentProviderCard[],
): ExecutorSettings {
  const anthropic = providers.find((p) => p.id === 'provider.anthropic');
  const hasApiKey = anthropic?.hasCredential === true;
  return {
    configuredAliasMap: {},
    effectiveAliasMap: {},
    defaultAlias: '',
    executorAuthMode: 'api_key',
    authModeSource: 'settings',
    hasApiKey,
    hasOauthToken: false,
    hasAuthToken: false,
    apiKeySource: hasApiKey ? 'stored' : null,
    oauthTokenSource: null,
    authTokenSource: null,
    apiKeyHint: anthropic?.credentialHint ?? null,
    oauthTokenHint: null,
    authTokenHint: null,
    activeCredentialConfigured: hasApiKey,
    verificationStatus: anthropic?.verificationStatus ?? 'missing',
    lastVerifiedAt: anthropic?.lastVerifiedAt ?? null,
    lastVerificationError: anthropic?.lastVerificationError ?? null,
    anthropicBaseUrl: anthropic?.baseUrl ?? '',
    isConfigured: hasApiKey,
    configVersion: 0,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
    configErrors: [],
  };
}

export function SettingsPage({
  user,
  userRole,
  onUnauthorized,
  onUserUpdated,
}: Props): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const canManage = canManageAdmin(userRole);

  const setTab = (next: SettingsTab): void => {
    const params = new URLSearchParams(searchParams);
    if (next === 'profile') {
      params.delete('tab');
    } else {
      params.set('tab', next);
    }
    setSearchParams(params, { replace: true });
  };

  return (
    <section className="page-shell">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p>
            Manage your profile, AI provider API keys, and the agents available
            in your talks.
          </p>
        </div>
      </header>

      <div className="talk-tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          role="tab"
          className={`talk-tab${tab === 'profile' ? ' talk-tab-active' : ''}`}
          aria-selected={tab === 'profile'}
          onClick={() => setTab('profile')}
        >
          Profile
        </button>
        <button
          type="button"
          role="tab"
          className={`talk-tab${tab === 'api-keys' ? ' talk-tab-active' : ''}`}
          aria-selected={tab === 'api-keys'}
          onClick={() => setTab('api-keys')}
        >
          API Keys
        </button>
        <button
          type="button"
          role="tab"
          className={`talk-tab${tab === 'agents' ? ' talk-tab-active' : ''}`}
          aria-selected={tab === 'agents'}
          onClick={() => setTab('agents')}
        >
          Agents
        </button>
      </div>

      {tab === 'profile' ? (
        <ProfileTab
          user={user}
          onUnauthorized={onUnauthorized}
          onUserUpdated={onUserUpdated}
        />
      ) : null}

      {tab === 'api-keys' ? (
        <ApiKeysTab onUnauthorized={onUnauthorized} userRole={userRole} />
      ) : null}

      {tab === 'agents' ? (
        <AgentsTab onUnauthorized={onUnauthorized} />
      ) : null}
    </section>
  );
}

// ─── Profile tab ─────────────────────────────────────────────────────

function ProfileTab({
  user,
  onUnauthorized,
  onUserUpdated,
}: {
  user: SessionUser;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
}): JSX.Element {
  const [nameDraft, setNameDraft] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(user.displayName);
  }, [user.displayName]);

  const hasNameChange =
    nameDraft.trim() !== '' && nameDraft.trim() !== user.displayName;

  const handleSave = async (): Promise<void> => {
    if (!hasNameChange) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateSessionMe({
        displayName: nameDraft.trim(),
      });
      onUserUpdated(updated);
      setNotice('Profile updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update profile.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {error ? (
        <div className="settings-banner settings-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <section className="settings-card">
        <h2>Personal Information</h2>
        <label className="profile-field">
          <span className="profile-field-label">Full name</span>
          <input
            type="text"
            className="profile-field-input"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
          />
        </label>
        <label className="profile-field">
          <span className="profile-field-label">Email address</span>
          <input
            type="text"
            className="profile-field-input profile-field-locked"
            value={user.email}
            readOnly
          />
          <span className="profile-field-hint">
            This is the email used for signing in and notifications.
          </span>
        </label>
        <div className="profile-actions">
          <button
            type="button"
            className="primary-btn"
            disabled={!hasNameChange || saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2>Role &amp; Permissions</h2>
        <div className="profile-role-row">
          <strong>{formatRole(user.role)}</strong>
          <span
            className={`profile-role-badge profile-role-badge-${user.role}`}
          >
            {user.role}
          </span>
        </div>
        <p className="settings-copy">{roleDescription(user.role)}</p>
      </section>
    </>
  );
}

function formatRole(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    default:
      return role;
  }
}

function roleDescription(role: string): string {
  switch (role) {
    case 'owner':
      return 'Full access to all settings and billing.';
    case 'admin':
      return 'Can manage agents, connectors, and settings.';
    case 'member':
      return 'Can create and participate in talks.';
    default:
      return '';
  }
}

// ─── API Keys tab ────────────────────────────────────────────────────

const PROVIDER_SAVE_POLL_DELAYS_MS = [
  1_500, 1_500, 2_500, 3_500, 5_000, 5_000, 5_000,
];

function draftKey(scope: ProviderCredentialScope, providerId: string): string {
  return `${scope}:${providerId}`;
}

function ApiKeysTab({
  onUnauthorized,
  userRole,
}: {
  onUnauthorized: () => void;
  userRole: string;
}): JSX.Element {
  const isAdmin = userRole === 'owner' || userRole === 'admin';
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const next = await getAiAgents();
        if (cancelled) return;
        setData(next);
        setDrafts(initDrafts(next.additionalProviders));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load AI provider settings.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const updateDraft = (
    scope: ProviderCredentialScope,
    providerId: string,
    patch: Partial<ProviderDraft>,
  ): void => {
    setDrafts((current) => {
      const key = draftKey(scope, providerId);
      return {
        ...current,
        [key]: {
          ...(current[key] || {
            apiKey: '',
            showApiKey: false,
            expanded: false,
          }),
          ...patch,
        },
      };
    });
  };

  const refreshProvider = (
    next: AgentProviderCard,
    scope: ProviderCredentialScope,
  ): void => {
    setData((current) =>
      current
        ? {
            ...current,
            additionalProviders: current.additionalProviders.map((entry) =>
              entry.id === next.id ? next : entry,
            ),
          }
        : current,
    );
    const view = projectProvider(next, scope);
    updateDraft(scope, next.id, {
      apiKey: '',
      expanded: !view.hasCredential,
    });
  };

  const pollAfterSave = async (
    providerId: string,
    scope: ProviderCredentialScope,
  ): Promise<void> => {
    for (const delayMs of PROVIDER_SAVE_POLL_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const next = await getAiAgents();
        const provider = next.additionalProviders.find(
          (entry) => entry.id === providerId,
        );
        if (!provider) return;
        refreshProvider(provider, scope);
        const view = projectProvider(provider, scope);
        if (
          view.verificationStatus === 'verifying' ||
          view.verificationStatus === 'not_verified'
        ) {
          continue;
        }
        if (view.verificationStatus === 'verified') {
          setNotice(`${provider.name} verified.`);
        }
        return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        }
        return;
      }
    }
  };

  const handleFailure = (err: unknown, fallback: string): void => {
    if (err instanceof UnauthorizedError) {
      onUnauthorized();
      return;
    }
    setError(err instanceof ApiError ? err.message : fallback);
  };

  const handleSave = async (
    providerId: string,
    scope: ProviderCredentialScope,
  ): Promise<void> => {
    const draft = drafts[draftKey(scope, providerId)];
    if (!draft) return;
    const apiKey = draft.apiKey.trim();
    if (!apiKey) {
      setError('Enter an API key before saving.');
      return;
    }
    setBusyKey(`save:${scope}:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await saveAiProviderCredential({
        providerId,
        apiKey,
        scope,
      });
      refreshProvider(updated, scope);
      const view = projectProvider(updated, scope);
      setNotice(
        scope === 'workspace'
          ? `${updated.name} workspace credential saved.`
          : `${updated.name} credential saved.`,
      );
      if (
        view.verificationStatus === 'verifying' ||
        view.verificationStatus === 'not_verified'
      ) {
        void pollAfterSave(providerId, scope);
      }
    } catch (err) {
      handleFailure(err, 'Failed to save provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleClear = async (
    providerId: string,
    scope: ProviderCredentialScope,
  ): Promise<void> => {
    setBusyKey(`save:${scope}:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await saveAiProviderCredential({
        providerId,
        apiKey: null,
        scope,
      });
      refreshProvider(updated, scope);
      setNotice(
        scope === 'workspace'
          ? `${updated.name} workspace credential cleared.`
          : `${updated.name} credential cleared.`,
      );
    } catch (err) {
      handleFailure(err, 'Failed to clear provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleVerify = async (
    providerId: string,
    scope: ProviderCredentialScope,
  ): Promise<void> => {
    setBusyKey(`verify:${scope}:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await verifyAiProviderCredential(providerId, scope);
      refreshProvider(updated, scope);
      setNotice(`${updated.name} verification updated.`);
    } catch (err) {
      handleFailure(err, 'Failed to verify provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) {
    return <section className="page-state">Loading API keys…</section>;
  }

  if (error && !data) {
    return (
      <section className="settings-banner settings-banner-error" role="alert">
        {error}
      </section>
    );
  }

  const providers = data?.additionalProviders ?? [];

  return (
    <>
      {error ? (
        <div className="settings-banner settings-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <section className="settings-card">
        <h2>Workspace API Keys</h2>
        <p className="settings-copy">
          Workspace-shared keys are visible to every member and used when a
          member hasn't supplied a personal key of their own.{' '}
          {isAdmin
            ? 'Set them here as the workspace admin.'
            : 'Only workspace admins can change these.'}
        </p>

        {providers.length === 0 ? (
          <p className="settings-copy">
            No providers are enabled for this workspace.
          </p>
        ) : (
          <div className="talk-llm-card-list">
            {providers.map((provider) => (
              <ProviderCredentialCard
                key={`workspace:${provider.id}`}
                scope="workspace"
                provider={provider}
                draft={
                  drafts[draftKey('workspace', provider.id)] ||
                  emptyDraft(provider, 'workspace')
                }
                canManage={isAdmin}
                busySave={busyKey === `save:workspace:${provider.id}`}
                busyVerify={busyKey === `verify:workspace:${provider.id}`}
                onDraftChange={(patch) =>
                  updateDraft('workspace', provider.id, patch)
                }
                onSave={() => void handleSave(provider.id, 'workspace')}
                onClear={() => void handleClear(provider.id, 'workspace')}
                onVerify={() => void handleVerify(provider.id, 'workspace')}
              />
            ))}
          </div>
        )}
      </section>

      <section className="settings-card">
        <h2>Personal API Keys</h2>
        <p className="settings-copy">
          Personal keys override the workspace key when set. Use these when you
          want to bill against your own provider account.
        </p>

        {providers.length === 0 ? (
          <p className="settings-copy">
            No providers are enabled for this workspace.
          </p>
        ) : (
          <div className="talk-llm-card-list">
            {providers.map((provider) => (
              <ProviderCredentialCard
                key={`user:${provider.id}`}
                scope="user"
                provider={provider}
                draft={
                  drafts[draftKey('user', provider.id)] ||
                  emptyDraft(provider, 'user')
                }
                canManage
                busySave={busyKey === `save:user:${provider.id}`}
                busyVerify={busyKey === `verify:user:${provider.id}`}
                onDraftChange={(patch) =>
                  updateDraft('user', provider.id, patch)
                }
                onSave={() => void handleSave(provider.id, 'user')}
                onClear={() => void handleClear(provider.id, 'user')}
                onVerify={() => void handleVerify(provider.id, 'user')}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function initDrafts(
  providers: AgentProviderCard[],
): Record<string, ProviderDraft> {
  const drafts: Record<string, ProviderDraft> = {};
  for (const provider of providers) {
    drafts[draftKey('user', provider.id)] = emptyDraft(provider, 'user');
    drafts[draftKey('workspace', provider.id)] = emptyDraft(
      provider,
      'workspace',
    );
  }
  return drafts;
}

function emptyDraft(
  provider: AgentProviderCard,
  scope: ProviderCredentialScope,
): ProviderDraft {
  const view = projectProvider(provider, scope);
  return {
    apiKey: '',
    showApiKey: false,
    expanded: !view.hasCredential,
  };
}

function ProviderCredentialCard({
  scope,
  provider,
  draft,
  canManage,
  busySave,
  busyVerify,
  onDraftChange,
  onSave,
  onClear,
  onVerify,
}: {
  scope: ProviderCredentialScope;
  provider: AgentProviderCard;
  draft: ProviderDraft;
  canManage: boolean;
  busySave: boolean;
  busyVerify: boolean;
  onDraftChange: (patch: Partial<ProviderDraft>) => void;
  onSave: () => void;
  onClear: () => void;
  onVerify: () => void;
}): JSX.Element {
  const view = projectProvider(provider, scope);
  const docs = PROVIDER_DOCS[provider.id];
  const placeholder = PROVIDER_KEY_PLACEHOLDER[provider.id] || 'sk-...';
  const disabled = !canManage || busySave;
  const scopeLabel = scope === 'workspace' ? 'workspace' : 'personal';
  // Subscription-only providers (e.g. ChatGPT Codex) hide the API key
  // section entirely — credentials live in the OAuth subscription
  // section rendered below.
  const showApiKeySection = provider.credentialMode !== 'subscription_only';

  return (
    <article className="talk-llm-card">
      <div className="talk-llm-card-header">
        <div>
          <h4>{provider.name}</h4>
          <p className="talk-llm-meta">
            {docs ? (
              <a href={docs.url} target="_blank" rel="noreferrer">
                Get key from {docs.label}
              </a>
            ) : showApiKeySection ? (
              'Configure an API key to use this provider in talks.'
            ) : (
              'Subscription-only provider — connect via OAuth below.'
            )}
          </p>
        </div>
        {showApiKeySection ? (
          <span className={verificationChipClass(view.verificationStatus)}>
            {formatVerification(view.verificationStatus)}
          </span>
        ) : null}
      </div>

      {showApiKeySection && view.hasCredential ? (
        <div className="talk-llm-stored-key">
          <div>
            <strong>{view.credentialHint || 'Stored in settings'}</strong>
            <p className="talk-llm-meta">
              Last verified {formatDateTime(view.lastVerifiedAt)}
            </p>
            {view.lastVerificationError ? (
              <p className="talk-llm-meta">{view.lastVerificationError}</p>
            ) : null}
          </div>
          {canManage ? (
            <button
              type="button"
              className="icon-btn danger-btn"
              onClick={onClear}
              disabled={disabled}
              aria-label={`Delete ${provider.name} ${scopeLabel} credential`}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      {showApiKeySection && canManage ? (
        <details
          className="talk-llm-update-disclosure"
          open={draft.expanded}
          onToggle={(event) =>
            onDraftChange({
              expanded: (event.currentTarget as HTMLDetailsElement).open,
            })
          }
        >
          <summary>
            {view.hasCredential ? 'Update key' : 'Configure'}
          </summary>
          <div className="talk-llm-grid">
            <label className="talk-llm-field-span">
              <span>API key</span>
              <div className="talk-llm-secret-input">
                <input
                  type={draft.showApiKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  placeholder={placeholder}
                  onChange={(event) =>
                    onDraftChange({ apiKey: event.target.value })
                  }
                  disabled={disabled}
                />
                <button
                  type="button"
                  className="talk-llm-eye-toggle"
                  onClick={() =>
                    onDraftChange({ showApiKey: !draft.showApiKey })
                  }
                  disabled={disabled}
                  aria-label={
                    draft.showApiKey
                      ? `Hide ${provider.name} API key`
                      : `Show ${provider.name} API key`
                  }
                >
                  {draft.showApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
            <div className="talk-llm-inline-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={onSave}
                disabled={disabled || !draft.apiKey.trim()}
              >
                {busySave
                  ? 'Saving…'
                  : view.hasCredential
                    ? 'Update'
                    : 'Save'}
              </button>
              {view.hasCredential ? (
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={onVerify}
                  disabled={busyVerify}
                >
                  {busyVerify ? 'Verifying…' : 'Re-verify'}
                </button>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}

      {provider.id === 'provider.anthropic' ? (
        <AnthropicSubscriptionSection
          scope={scope}
          provider={provider}
          canManage={canManage}
        />
      ) : null}
      {provider.id === 'provider.openai_codex' ? (
        <OpenAiCodexSubscriptionSection
          scope={scope}
          provider={provider}
          canManage={canManage}
        />
      ) : null}
    </article>
  );
}

// ─── Anthropic OAuth subscription section ─────────────────────────

function AnthropicSubscriptionSection({
  scope,
  provider,
  canManage,
}: {
  scope: ProviderCredentialScope;
  provider: AgentProviderCard;
  canManage: boolean;
}): JSX.Element {
  const hasSubscription =
    scope === 'workspace'
      ? provider.hasWorkspaceSubscription
      : provider.hasPersonalSubscription;
  const expiresAt =
    scope === 'workspace'
      ? provider.workspaceSubscriptionExpiresAt
      : provider.personalSubscriptionExpiresAt;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState('');
  const [done, setDone] = useState(false);

  const handleConnect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const init = await initiateAnthropicSubscriptionOauth(scope);
      setAuthorizeUrl(init.authorizationUrl);
      setState(init.state);
      window.open(init.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to start Claude OAuth.',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleComplete = async (): Promise<void> => {
    if (!state || !codeDraft.trim()) {
      setError('Paste the code from console.anthropic.com.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Anthropic's console returns `{code}#{state}` — accept either
      // the full blob or just the code.
      const codeOnly = codeDraft.trim().split('#')[0];
      await completeAnthropicSubscriptionOauth({
        state,
        code: codeOnly,
      });
      setDone(true);
      // Reload the page to refresh the AgentProviderCard.
      window.location.reload();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to complete Claude OAuth.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      style={{
        marginTop: '1rem',
        paddingTop: '0.75rem',
        borderTop: '1px solid var(--border-color, #e3eaf5)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <strong>Claude subscription</strong>
          <p className="talk-llm-meta">
            {hasSubscription
              ? `Connected · refreshes automatically${
                  expiresAt
                    ? ` (current token expires ${formatDateTime(expiresAt)})`
                    : ''
                }`
              : 'Connect a Claude Pro or Max account so this provider works without a console API key.'}
          </p>
        </div>
        {canManage && !authorizeUrl && !done ? (
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void handleConnect()}
            disabled={busy}
          >
            {busy
              ? 'Starting…'
              : hasSubscription
                ? 'Reconnect with Claude'
                : 'Connect with Claude'}
          </button>
        ) : null}
      </div>
      {authorizeUrl && !done ? (
        <div className="talk-llm-grid" style={{ marginTop: '0.5rem' }}>
          <p className="talk-llm-meta">
            A new tab opened to{' '}
            <a href={authorizeUrl} target="_blank" rel="noreferrer">
              claude.ai
            </a>
            . Sign in and approve access, then paste the code shown on{' '}
            <code>console.anthropic.com</code> back here.
          </p>
          <label className="talk-llm-field-span">
            <span>Paste the code (or full code#state blob)</span>
            <input
              type="text"
              value={codeDraft}
              onChange={(event) => setCodeDraft(event.target.value)}
              placeholder="…#…"
              disabled={busy}
            />
          </label>
          <div className="talk-llm-inline-actions">
            <button
              type="button"
              className="primary-btn"
              onClick={() => void handleComplete()}
              disabled={busy || !codeDraft.trim()}
            >
              {busy ? 'Completing…' : 'Complete connection'}
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => {
                setAuthorizeUrl(null);
                setState(null);
                setCodeDraft('');
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="talk-llm-meta error-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ─── OpenAI Codex device-code subscription section ────────────────

function OpenAiCodexSubscriptionSection({
  scope,
  provider,
  canManage,
}: {
  scope: ProviderCredentialScope;
  provider: AgentProviderCard;
  canManage: boolean;
}): JSX.Element {
  const hasSubscription =
    scope === 'workspace'
      ? provider.hasWorkspaceSubscription
      : provider.hasPersonalSubscription;
  const expiresAt =
    scope === 'workspace'
      ? provider.workspaceSubscriptionExpiresAt
      : provider.personalSubscriptionExpiresAt;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    state: string;
    userCode: string;
    verificationUrl: string;
    pollIntervalSeconds: number;
  } | null>(null);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer: number | null = null;
    setPolling(true);
    const tick = async (): Promise<void> => {
      try {
        const result = await pollOpenAiCodexSubscriptionOauth({
          state: pending.state,
        });
        if (cancelled) return;
        if (result.status === 'authorized') {
          setPending(null);
          setPolling(false);
          window.location.reload();
          return;
        }
        timer = window.setTimeout(
          () => void tick(),
          pending.pollIntervalSeconds * 1000,
        );
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : 'Failed to poll OpenAI device authorization.',
        );
        setPolling(false);
      }
    };
    timer = window.setTimeout(
      () => void tick(),
      pending.pollIntervalSeconds * 1000,
    );
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [pending]);

  const handleConnect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const init = await initiateOpenAiCodexSubscriptionOauth(scope);
      setPending({
        state: init.state,
        userCode: init.userCode,
        verificationUrl: init.verificationUrl,
        pollIntervalSeconds: init.pollIntervalSeconds,
      });
      window.open(init.verificationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to start ChatGPT OAuth.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      style={{
        marginTop: '1rem',
        paddingTop: '0.75rem',
        borderTop: '1px solid var(--border-color, #e3eaf5)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <strong>ChatGPT subscription</strong>
          <p className="talk-llm-meta">
            {hasSubscription
              ? `Connected · refreshes automatically${
                  expiresAt
                    ? ` (current token expires ${formatDateTime(expiresAt)})`
                    : ''
                }`
              : 'Connect a ChatGPT Plus or Pro account. Note: inference adapter for Codex Responses is still in progress — auth lands here first.'}
          </p>
        </div>
        {canManage && !pending ? (
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void handleConnect()}
            disabled={busy}
          >
            {busy
              ? 'Starting…'
              : hasSubscription
                ? 'Reconnect with ChatGPT'
                : 'Connect with ChatGPT'}
          </button>
        ) : null}
      </div>
      {pending ? (
        <div
          className="talk-llm-grid"
          style={{ marginTop: '0.5rem', gap: '0.5rem' }}
        >
          <p className="talk-llm-meta">
            Open{' '}
            <a
              href={pending.verificationUrl}
              target="_blank"
              rel="noreferrer"
            >
              {pending.verificationUrl}
            </a>{' '}
            and enter this code:
          </p>
          <div
            style={{
              fontSize: '1.5rem',
              fontFamily: 'monospace',
              letterSpacing: '0.25rem',
              padding: '0.5rem',
              background: 'var(--surface-alt, #f3f6fb)',
              borderRadius: '6px',
              textAlign: 'center',
            }}
          >
            {pending.userCode}
          </div>
          <p className="talk-llm-meta">
            {polling
              ? 'Waiting for you to authorize on OpenAI… this page refreshes when done.'
              : 'Ready.'}
          </p>
          <div className="talk-llm-inline-actions">
            <button
              type="button"
              className="secondary-btn"
              onClick={() => {
                setPending(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="talk-llm-meta error-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ─── Agents tab ──────────────────────────────────────────────────────

function AgentsTab({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  // `registered_agents` is per-user via RLS, so every authenticated
  // user manages their own list — no admin gate here.
  const canManage = true;
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [mainAgentId, setMainAgentId] = useState<string | null>(null);
  const [mainAgentDraft, setMainAgentDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [nextData, nextAgents, mainAgent] = await Promise.all([
          getAiAgents(),
          listRegisteredAgents(),
          getMainRegisteredAgent().catch(() => null),
        ]);
        if (cancelled) return;
        setData(nextData);
        setAgents(nextAgents);
        if (mainAgent) {
          setMainAgentId(mainAgent.id);
          setMainAgentDraft(mainAgent.id);
        } else {
          setMainAgentId(null);
          setMainAgentDraft('');
        }
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof ApiError ? err.message : 'Failed to load agents.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const executorSettings = useMemo(
    () => deriveExecutorSettings(data?.additionalProviders ?? []),
    [data?.additionalProviders],
  );

  const handleSaveMain = async (): Promise<void> => {
    if (!mainAgentDraft || mainAgentDraft === mainAgentId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateMainRegisteredAgent(mainAgentDraft);
      setMainAgentId(updated.id);
      setMainAgentDraft(updated.id);
      setNotice('Main agent updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update main agent.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <section className="page-state">Loading agents…</section>;
  }

  if (!data) {
    return (
      <section className="settings-banner settings-banner-error" role="alert">
        {error || 'Agents are unavailable.'}
      </section>
    );
  }

  const selectedMain = agents.find((agent) => agent.id === mainAgentDraft);

  return (
    <>
      {error ? (
        <div className="settings-banner settings-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <section className="settings-card">
        <RegisteredAgentsPanel
          providers={data.additionalProviders}
          executorSettings={executorSettings}
          containerRuntimeAvailability="unavailable"
          onUnauthorized={onUnauthorized}
          canManage={canManage}
          mainAgentId={mainAgentId}
          onAgentsChanged={setAgents}
        />
      </section>

      {agents.length > 0 ? (
        <section className="settings-card">
          <h2>Main Agent</h2>
          <p className="settings-copy">
            The main agent is the default participant when a Talk doesn't
            specify one.
          </p>
          <div className="talk-llm-grid">
            <label className="talk-llm-field-span">
              <span>Select main agent</span>
              <select
                value={mainAgentDraft}
                onChange={(event) => setMainAgentDraft(event.target.value)}
                disabled={!canManage || busy}
              >
                <option value="" disabled>
                  Choose an agent…
                </option>
                {agents
                  .filter((agent) => agent.enabled)
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.modelId})
                    </option>
                  ))}
              </select>
            </label>
            <div className="talk-llm-inline-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={() => void handleSaveMain()}
                disabled={
                  !canManage ||
                  busy ||
                  !mainAgentDraft ||
                  mainAgentDraft === mainAgentId
                }
              >
                {busy ? 'Saving…' : 'Set as Main Agent'}
              </button>
            </div>
          </div>
          {selectedMain && !selectedMain.executionPreview.ready ? (
            <p className="talk-llm-meta error-text">
              {selectedMain.executionPreview.message}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
