import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  ApiError,
  type AgentProviderCard,
  type AiAgentsPageData,
  type ChannelKind,
  type DataConnectorKind,
  type ExecutorSettings,
  type ProviderCredentialScope,
  type ProviderVerificationStatus,
  type RegisteredAgent,
  type SessionUser,
  type UserGoogleAccount,
  type WebSearchPageData,
  type WebSearchProviderId,
  type WorkspaceChannel,
  type WorkspaceDataConnector,
  type WorkspaceSlackInstall,
  clearWebSearchCredential,
  completeAnthropicSubscriptionOauth,
  connectUserGoogleAccount,
  connectWorkspaceSlackInstall,
  createWorkspaceChannel,
  createWorkspaceDataConnector,
  deleteWorkspaceChannel,
  deleteWorkspaceDataConnector,
  deleteWorkspaceSlackInstall,
  disconnectUserGoogleAccount,
  expandUserGoogleScopes,
  getAiAgents,
  getMainRegisteredAgent,
  getUserGoogleAccount,
  getWebSearchProviders,
  initiateAnthropicSubscriptionOauth,
  initiateOpenAiCodexSubscriptionOauth,
  listRegisteredAgents,
  listWorkspaceChannels,
  listWorkspaceDataConnectors,
  listWorkspaceSlackInstalls,
  pollOpenAiCodexSubscriptionOauth,
  saveAiProviderCredential,
  setActiveWebSearchProvider,
  setWebSearchCredential,
  setWorkspaceChannelCredential,
  setWorkspaceDataConnectorCredential,
  UnauthorizedError,
  updateMainRegisteredAgent,
  updateSessionMe,
  updateWorkspaceChannel,
  updateWorkspaceDataConnector,
  verifyAiProviderCredential,
} from '../lib/api';
import { launchGoogleAccountPopup } from '../lib/googleAccountPopup';
import { launchSlackInstallPopup } from '../lib/slackInstallPopup';
import { RegisteredAgentsPanel } from '../components/RegisteredAgentsPanel';
import { ConnectorStatusPill } from '../components/connectors/StatusPill';
import { resolveConnectorSubtitle } from '../components/connectors/subtitle';
import { SlackChannelForm } from '../components/connectors/SlackChannelForm';
import { SlackChannelPicker } from '../components/connectors/SlackChannelPicker';
import { TelegramChannelForm } from '../components/connectors/TelegramChannelForm';
import { PostHogDataConnectorForm } from '../components/connectors/PostHogDataConnectorForm';
import { GoogleDocsDataConnectorForm } from '../components/connectors/GoogleDocsDataConnectorForm';
import { GoogleSheetsDataConnectorForm } from '../components/connectors/GoogleSheetsDataConnectorForm';

const REQUIRED_GOOGLE_TOOL_SCOPES = ['drive.readonly', 'documents'];

function isGoogleToolsEnabled(): boolean {
  return import.meta.env.VITE_GOOGLE_TOOLS_ENABLED === 'true';
}

type Props = {
  user: SessionUser;
  userRole: string;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
};

type SettingsTab = 'profile' | 'api-keys' | 'agents' | 'tools' | 'connectors';

type ProviderDraft = {
  apiKey: string;
  showApiKey: boolean;
  expanded: boolean;
};

const TAB_VALUES: readonly SettingsTab[] = [
  'profile',
  'api-keys',
  'agents',
  'tools',
  'connectors',
];

const TAB_PAGE_HEADERS: Record<
  SettingsTab,
  { title: string; subtitle: string }
> = {
  profile: {
    title: 'My Profile',
    subtitle: 'Manage your personal information.',
  },
  'api-keys': {
    title: 'API Keys',
    subtitle:
      'Workspace-shared and personal AI provider credentials used by your agents.',
  },
  agents: {
    title: 'AI Agents',
    subtitle: 'Register the agents available in your talks.',
  },
  tools: {
    title: 'Tools',
    subtitle: 'Configure tool integrations that agents can call.',
  },
  connectors: {
    title: 'Connectors',
    subtitle:
      'Workspace-wide channels and data sources that any talk can opt into.',
  },
};

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
  // Any credential surface the execution-resolver will accept counts as
  // "configured". Workspace api_key + personal/workspace OAuth
  // subscriptions all flow into the same resolver fallback chain, so
  // surfacing them here unblocks Save in the agent form.
  const hasApiKey =
    anthropic?.hasCredential === true ||
    anthropic?.workspaceHasCredential === true;
  const hasOauthToken =
    anthropic?.hasPersonalSubscription === true ||
    anthropic?.hasWorkspaceSubscription === true;
  return {
    configuredAliasMap: {},
    effectiveAliasMap: {},
    defaultAlias: '',
    executorAuthMode: 'api_key',
    authModeSource: 'settings',
    hasApiKey,
    hasOauthToken,
    hasAuthToken: false,
    apiKeySource: hasApiKey ? 'stored' : null,
    oauthTokenSource: hasOauthToken ? 'stored' : null,
    authTokenSource: null,
    apiKeyHint: anthropic?.credentialHint ?? null,
    oauthTokenHint: null,
    authTokenHint: null,
    activeCredentialConfigured: hasApiKey || hasOauthToken,
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
  const [searchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const header = TAB_PAGE_HEADERS[tab];

  return (
    <section className="page-shell">
      <header className="page-header">
        <div>
          <h1>{header.title}</h1>
          <p>{header.subtitle}</p>
        </div>
      </header>

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

      {tab === 'agents' ? <AgentsTab onUnauthorized={onUnauthorized} /> : null}

      {tab === 'tools' ? <ToolsTab onUnauthorized={onUnauthorized} /> : null}

      {tab === 'connectors' ? (
        <ConnectorsTab onUnauthorized={onUnauthorized} userRole={userRole} />
      ) : null}
    </section>
  );
}

// ─── Profile tab ─────────────────────────────────────────────────────

const PROFILE_AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #3b82f6, #06b6d4)',
  'linear-gradient(135deg, #10b981, #34d399)',
  'linear-gradient(135deg, #f59e0b, #f97316)',
  'linear-gradient(135deg, #ef4444, #f43f5e)',
  'linear-gradient(135deg, #8b5cf6, #ec4899)',
  'linear-gradient(135deg, #14b8a6, #3b82f6)',
  'linear-gradient(135deg, #f97316, #ef4444)',
];

function getProfileInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

function getProfileGradient(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return PROFILE_AVATAR_GRADIENTS[
    Math.abs(hash) % PROFILE_AVATAR_GRADIENTS.length
  ];
}

function formatProfileDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

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

  const initials = getProfileInitials(user.displayName);
  const gradient = getProfileGradient(user.id);

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
        <h2>Profile Picture</h2>
        <div className="profile-avatar-section">
          <span className="profile-avatar-lg" style={{ background: gradient }}>
            {initials}
          </span>
        </div>
      </section>

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

      <section className="settings-card">
        <h2>Account</h2>
        <div className="profile-meta-grid">
          <div>
            <span className="settings-label">User ID</span>
            <strong className="profile-meta-value">
              {user.id.slice(0, 12)}…
            </strong>
          </div>
          <div>
            <span className="settings-label">Member since</span>
            <strong>{formatProfileDate(user.createdAt)}</strong>
          </div>
        </div>
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

// ─── Tools tab ───────────────────────────────────────────────────────

function ToolsTab({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  return (
    <>
      {isGoogleToolsEnabled() ? (
        <GoogleAccountSection onUnauthorized={onUnauthorized} />
      ) : null}
      <WebSearchProvidersSection onUnauthorized={onUnauthorized} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Google account (flag-gated behind VITE_GOOGLE_TOOLS_ENABLED until PR2)
// ---------------------------------------------------------------------------

function GoogleAccountSection({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const [account, setAccount] = useState<UserGoogleAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'connect' | 'expand' | 'disconnect' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await getUserGoogleAccount();
        if (cancelled) return;
        setAccount(fresh);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof Error ? err.message : 'Failed to load Google account.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  async function refresh(): Promise<void> {
    try {
      const fresh = await getUserGoogleAccount();
      setAccount(fresh);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error ? err.message : 'Failed to reload Google account.',
      );
    }
  }

  async function handleConnect(): Promise<void> {
    setBusy('connect');
    setError(null);
    setNotice(null);
    try {
      const launch = await connectUserGoogleAccount({
        scopes: REQUIRED_GOOGLE_TOOL_SCOPES,
      });
      await launchGoogleAccountPopup(launch.authorizationUrl);
      await refresh();
      setNotice('Google account connected.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Could not connect Google account.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleExpand(): Promise<void> {
    setBusy('expand');
    setError(null);
    setNotice(null);
    try {
      const launch = await expandUserGoogleScopes({
        scopes: REQUIRED_GOOGLE_TOOL_SCOPES,
      });
      await launchGoogleAccountPopup(launch.authorizationUrl);
      await refresh();
      setNotice('Scopes updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not update scopes.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(): Promise<void> {
    setBusy('disconnect');
    setError(null);
    setNotice(null);
    try {
      await disconnectUserGoogleAccount();
      await refresh();
      setNotice('Google account disconnected.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Could not disconnect Google account.',
      );
    } finally {
      setBusy(null);
    }
  }

  const missingRequired = account
    ? REQUIRED_GOOGLE_TOOL_SCOPES.filter(
        (scope) => !account.scopes.includes(scope),
      )
    : [];

  return (
    <section
      className="settings-section"
      aria-label="Google account"
      data-testid="google-account-section"
    >
      <header>
        <h2>Google account</h2>
        <p>
          Connect your Google account to let agents read and write Google Docs.
        </p>
      </header>

      {error ? <p className="settings-error">{error}</p> : null}
      {notice ? <p className="settings-notice">{notice}</p> : null}

      {loading ? (
        <p>Loading…</p>
      ) : account?.connected ? (
        <div className="settings-card">
          <p>
            <strong>Connected as:</strong>{' '}
            {account.email ?? account.displayName ?? 'unknown'}
          </p>
          <p>
            <strong>Granted scopes:</strong>{' '}
            {account.scopes.length > 0 ? account.scopes.join(', ') : 'none'}
          </p>
          {missingRequired.length > 0 ? (
            <p className="settings-warning">
              Missing required scopes for Google Docs tools:{' '}
              {missingRequired.join(', ')}.{' '}
              <button
                type="button"
                onClick={() => void handleExpand()}
                disabled={busy !== null}
              >
                {busy === 'expand' ? 'Re-requesting…' : 'Re-request scopes'}
              </button>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            disabled={busy !== null}
          >
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <div className="settings-card">
          <p>No Google account connected.</p>
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={busy !== null}
          >
            {busy === 'connect' ? 'Connecting…' : 'Connect Google account'}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Web Search Providers (per-user keys + active picker)
// ---------------------------------------------------------------------------

const WEB_SEARCH_DOCS: Record<
  WebSearchProviderId,
  { url: string; label: string }
> = {
  'web_search.tavily': {
    url: 'https://app.tavily.com/home',
    label: 'Tavily',
  },
  'web_search.brave': {
    url: 'https://api.search.brave.com/app/keys',
    label: 'Brave Search',
  },
  'web_search.firecrawl': {
    url: 'https://www.firecrawl.dev/app/api-keys',
    label: 'Firecrawl',
  },
  'web_search.exa': {
    url: 'https://dashboard.exa.ai/api-keys',
    label: 'Exa',
  },
};

const WEB_SEARCH_PLACEHOLDER: Record<WebSearchProviderId, string> = {
  'web_search.tavily': 'tvly-...',
  'web_search.brave': 'BSA...',
  'web_search.firecrawl': 'fc-...',
  'web_search.exa': 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
};

function WebSearchProvidersSection({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const [data, setData] = useState<WebSearchPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<
    Record<WebSearchProviderId, { apiKey: string; showApiKey: boolean }>
  >({} as never);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await getWebSearchProviders();
        if (cancelled) return;
        setData(fresh);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to load web search providers.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  function patchDraft(
    providerId: WebSearchProviderId,
    patch: Partial<{ apiKey: string; showApiKey: boolean }>,
  ) {
    setDrafts((prev) => {
      const existing = prev[providerId] ?? { apiKey: '', showApiKey: false };
      return {
        ...prev,
        [providerId]: { ...existing, ...patch },
      };
    });
  }

  async function refresh() {
    try {
      const fresh = await getWebSearchProviders();
      setData(fresh);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to reload web search providers.',
      );
    }
  }

  async function handleSave(providerId: WebSearchProviderId) {
    const apiKey = drafts[providerId]?.apiKey?.trim();
    if (!apiKey) {
      setError('Paste a key before saving.');
      return;
    }
    setBusyKey(`save:${providerId}`);
    setError(null);
    setNotice(null);
    try {
      await setWebSearchCredential(providerId, apiKey);
      patchDraft(providerId, { apiKey: '', showApiKey: false });
      await refresh();
      setNotice('Saved.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to save key.');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleClear(providerId: WebSearchProviderId) {
    setBusyKey(`clear:${providerId}`);
    setError(null);
    setNotice(null);
    try {
      await clearWebSearchCredential(providerId);
      await refresh();
      setNotice('Key removed.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to remove key.');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSetActive(providerId: WebSearchProviderId | null) {
    setBusyKey(`active:${providerId ?? 'none'}`);
    setError(null);
    setNotice(null);
    try {
      await setActiveWebSearchProvider(providerId);
      await refresh();
      setNotice(
        providerId ? 'Active provider updated.' : 'Active provider cleared.',
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to update active provider.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) {
    return (
      <section className="settings-card">
        <h2>Web Search</h2>
        <p className="settings-copy">Loading web search providers…</p>
      </section>
    );
  }

  const providers = data?.providers ?? [];
  const activeProviderId = data?.activeProviderId ?? null;
  const anyKeyStored = providers.some((p) => p.hasCredential);

  return (
    <section className="settings-card">
      <h2>Web Search</h2>
      <p className="settings-copy">
        Agents call <code>web_search</code> to look things up on the live web.
        Add a key for at least one provider, then pick which one is active for
        your account. Keys are personal — they aren't shared with the workspace.
      </p>

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

      <div className="talk-llm-card-list">
        {providers.map((provider) => {
          const draft = drafts[provider.id] || {
            apiKey: '',
            showApiKey: false,
          };
          const docs = WEB_SEARCH_DOCS[provider.id];
          const placeholder = WEB_SEARCH_PLACEHOLDER[provider.id] ?? 'API key';
          const savingBusy = busyKey === `save:${provider.id}`;
          const clearingBusy = busyKey === `clear:${provider.id}`;
          const activatingBusy = busyKey === `active:${provider.id}`;
          const isActive = activeProviderId === provider.id;

          return (
            <article key={provider.id} className="talk-llm-card">
              <div className="talk-llm-card-header">
                <div>
                  <h4>
                    {provider.name}
                    {isActive ? (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: '0.8em',
                          color: '#0a7',
                        }}
                      >
                        ● Active
                      </span>
                    ) : null}
                  </h4>
                  <p className="talk-llm-meta">
                    {docs ? (
                      <a href={docs.url} target="_blank" rel="noreferrer">
                        Get key from {docs.label}
                      </a>
                    ) : null}
                  </p>
                </div>
              </div>

              {provider.hasCredential ? (
                <div className="talk-llm-stored-key">
                  <span>
                    Stored key: <code>{provider.credentialHint}</code>
                  </span>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleClear(provider.id)}
                    disabled={clearingBusy}
                  >
                    {clearingBusy ? 'Removing…' : 'Remove key'}
                  </button>
                </div>
              ) : null}

              <label className="agent-form-field">
                <span>
                  {provider.hasCredential ? 'Replace key' : 'API key'}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type={draft.showApiKey ? 'text' : 'password'}
                    value={draft.apiKey}
                    onChange={(e) =>
                      patchDraft(provider.id, { apiKey: e.target.value })
                    }
                    placeholder={placeholder}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() =>
                      patchDraft(provider.id, { showApiKey: !draft.showApiKey })
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
                  onClick={() => void handleSave(provider.id)}
                  disabled={savingBusy || !draft.apiKey.trim()}
                >
                  {savingBusy
                    ? 'Saving…'
                    : provider.hasCredential
                      ? 'Update key'
                      : 'Save'}
                </button>
                {provider.hasCredential && !isActive ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleSetActive(provider.id)}
                    disabled={activatingBusy}
                  >
                    {activatingBusy ? 'Setting…' : 'Set as active'}
                  </button>
                ) : null}
                {isActive ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleSetActive(null)}
                    disabled={busyKey === 'active:none'}
                  >
                    {busyKey === 'active:none' ? 'Clearing…' : 'Clear active'}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {!anyKeyStored ? (
        <p className="settings-copy" style={{ marginTop: 16 }}>
          No web search key stored yet. The <code>web_search</code> tool will
          return a "configure a provider in Settings" error until you save one
          and mark it active.
        </p>
      ) : !activeProviderId ? (
        <p className="settings-copy" style={{ marginTop: 16 }}>
          You have keys stored but no active provider selected.{' '}
          <strong>Pick one above</strong> to enable agent web search.
        </p>
      ) : null}
    </section>
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
  const [searchParams, setSearchParams] = useSearchParams();
  const view = projectProvider(provider, scope);
  const docs = PROVIDER_DOCS[provider.id];
  const modelCount = provider.modelSuggestions.length;
  const goToAgents = (): void => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', 'agents');
    setSearchParams(params, { replace: true });
  };
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
            {modelCount > 0 ? (
              <p className="talk-llm-meta">
                {modelCount} model{modelCount === 1 ? '' : 's'} available
                {provider.liveModelDiscovery?.status === 'ok'
                  ? ' (live + curated)'
                  : ''}
                {' — '}
                <button
                  type="button"
                  className="talk-llm-link-button"
                  onClick={goToAgents}
                >
                  Configure agents →
                </button>
              </p>
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
          <summary>{view.hasCredential ? 'Update key' : 'Configure'}</summary>
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
            {provider.id === 'provider.nvidia' ? (
              <p className="talk-llm-meta talk-llm-field-span">
                On NVIDIA Build, click <strong>Generate API Key</strong>, then
                copy the <code>nvapi-…</code> token from the Python snippet (it
                appears in the <code>Authorization</code> header).
              </p>
            ) : null}
            <div className="talk-llm-inline-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={onSave}
                disabled={disabled || !draft.apiKey.trim()}
              >
                {busySave ? 'Saving…' : view.hasCredential ? 'Update' : 'Save'}
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
        err instanceof ApiError ? err.message : 'Failed to start Claude OAuth.',
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
            <a href={pending.verificationUrl} target="_blank" rel="noreferrer">
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

// ─── Connectors tab ───────────────────────────────────────────────────

const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  slack: 'Slack',
  telegram: 'Telegram',
};

const DATA_CONNECTOR_KIND_LABELS: Record<DataConnectorKind, string> = {
  posthog: 'PostHog',
  google_docs: 'Google Docs',
  google_sheets: 'Google Sheets',
};

type ConnectorModalState =
  | { kind: 'closed' }
  | { kind: 'create-channel' }
  | { kind: 'edit-channel'; channel: WorkspaceChannel }
  | { kind: 'create-data-connector' }
  | { kind: 'edit-data-connector'; dataConnector: WorkspaceDataConnector };

type ConnectorDeleteState =
  | { kind: 'closed' }
  | { kind: 'channel'; channel: WorkspaceChannel }
  | { kind: 'data-connector'; dataConnector: WorkspaceDataConnector };

type ConnectorListStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

function ConnectorsTab({
  onUnauthorized,
  userRole,
}: {
  onUnauthorized: () => void;
  userRole: string;
}): JSX.Element {
  const isAdmin = userRole === 'owner' || userRole === 'admin';
  const [status, setStatus] = useState<ConnectorListStatus>({
    kind: 'loading',
  });
  const [channels, setChannels] = useState<WorkspaceChannel[]>([]);
  const [dataConnectors, setDataConnectors] = useState<
    WorkspaceDataConnector[]
  >([]);
  const [slackInstalls, setSlackInstalls] = useState<WorkspaceSlackInstall[]>(
    [],
  );
  const [modal, setModal] = useState<ConnectorModalState>({ kind: 'closed' });
  const [createKind, setCreateKind] = useState<string>('slack');
  const [deleteState, setDeleteState] = useState<ConnectorDeleteState>({
    kind: 'closed',
  });
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [slackBusy, setSlackBusy] = useState<
    null | 'connect' | { kind: 'delete'; teamId: string }
  >(null);
  const [slackNotice, setSlackNotice] = useState<string | null>(null);
  const [slackError, setSlackError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [nextChannels, nextDataConnectors, nextSlackInstalls] =
        await Promise.all([
          listWorkspaceChannels(),
          listWorkspaceDataConnectors(),
          listWorkspaceSlackInstalls(),
        ]);
      const byName = (
        a: { displayName: string },
        b: { displayName: string },
      ): number => a.displayName.localeCompare(b.displayName);
      setChannels([...nextChannels].sort(byName));
      setDataConnectors([...nextDataConnectors].sort(byName));
      setSlackInstalls(
        [...nextSlackInstalls].sort((a, b) =>
          a.teamName.localeCompare(b.teamName),
        ),
      );
      setStatus({ kind: 'ready' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setStatus({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to load connectors.',
      });
    }
  };

  const handleConnectSlackWorkspace = async () => {
    setSlackBusy('connect');
    setSlackError(null);
    setSlackNotice(null);
    try {
      const launch = await connectWorkspaceSlackInstall();
      const result = await launchSlackInstallPopup(launch.authorizationUrl);
      await refresh();
      setSlackNotice(
        result.teamName
          ? `Connected Slack workspace ${result.teamName}.`
          : 'Slack workspace connected.',
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setSlackError(
        err instanceof Error
          ? err.message
          : 'Could not connect Slack workspace.',
      );
    } finally {
      setSlackBusy(null);
    }
  };

  const handleDisconnectSlackWorkspace = async (install: WorkspaceSlackInstall) => {
    if (install.boundChannelCount > 0) {
      const confirmed = window.confirm(
        `Disconnecting ${install.teamName} will leave ${install.boundChannelCount} channel${install.boundChannelCount === 1 ? '' : 's'} without a credential. Continue?`,
      );
      if (!confirmed) return;
    }
    setSlackBusy({ kind: 'delete', teamId: install.teamId });
    setSlackError(null);
    setSlackNotice(null);
    try {
      await deleteWorkspaceSlackInstall(install.teamId);
      await refresh();
      setSlackNotice(`Disconnected Slack workspace ${install.teamName}.`);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setSlackError(
        err instanceof Error
          ? err.message
          : 'Could not disconnect Slack workspace.',
      );
    } finally {
      setSlackBusy(null);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeModal = () => {
    setModal({ kind: 'closed' });
    setFormError(null);
    setFormSubmitting(false);
  };

  const handleSlackChannelsAdded = async (count: number) => {
    closeModal();
    await refresh();
    setSlackNotice(
      count === 0
        ? 'No new Slack channels were added.'
        : `Added ${count} Slack channel${count === 1 ? '' : 's'}.`,
    );
  };

  const handleCreateChannelSubmit = async (
    kind: ChannelKind,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => {
    setFormSubmitting(true);
    setFormError(null);
    try {
      const created = await createWorkspaceChannel({
        kind,
        displayName: input.displayName,
        config: input.config,
      });
      if (input.rotateCredential && input.apiKey !== undefined) {
        await setWorkspaceChannelCredential({
          channelId: created.id,
          apiKey: input.apiKey,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setFormError(
        err instanceof Error ? err.message : 'Failed to create channel.',
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleEditChannelSubmit = async (
    channel: WorkspaceChannel,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => {
    setFormSubmitting(true);
    setFormError(null);
    try {
      await updateWorkspaceChannel({
        channelId: channel.id,
        displayName: input.displayName,
        config: input.config,
      });
      if (input.rotateCredential && input.apiKey !== undefined) {
        await setWorkspaceChannelCredential({
          channelId: channel.id,
          apiKey: input.apiKey,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setFormError(
        err instanceof Error ? err.message : 'Failed to update channel.',
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleCreateDataConnectorSubmit = async (
    kind: DataConnectorKind,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => {
    setFormSubmitting(true);
    setFormError(null);
    try {
      const created = await createWorkspaceDataConnector({
        kind,
        displayName: input.displayName,
        config: input.config,
      });
      if (input.rotateCredential && input.apiKey !== undefined) {
        await setWorkspaceDataConnectorCredential({
          connectorId: created.id,
          apiKey: input.apiKey,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setFormError(
        err instanceof Error ? err.message : 'Failed to create data source.',
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleEditDataConnectorSubmit = async (
    dataConnector: WorkspaceDataConnector,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => {
    setFormSubmitting(true);
    setFormError(null);
    try {
      await updateWorkspaceDataConnector({
        connectorId: dataConnector.id,
        displayName: input.displayName,
        config: input.config,
      });
      if (input.rotateCredential && input.apiKey !== undefined) {
        await setWorkspaceDataConnectorCredential({
          connectorId: dataConnector.id,
          apiKey: input.apiKey,
        });
      }
      closeModal();
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setFormError(
        err instanceof Error ? err.message : 'Failed to update data source.',
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (deleteState.kind === 'closed') return;
    setDeleteSubmitting(true);
    try {
      if (deleteState.kind === 'channel') {
        await deleteWorkspaceChannel(deleteState.channel.id);
      } else {
        await deleteWorkspaceDataConnector(deleteState.dataConnector.id);
      }
      setDeleteState({ kind: 'closed' });
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      // Surface as inline error on the list; close the modal so the user
      // can see it.
      setDeleteState({ kind: 'closed' });
      setStatus({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to delete connector.',
      });
    } finally {
      setDeleteSubmitting(false);
    }
  };

  if (status.kind === 'loading') {
    return (
      <section className="page-shell-section">
        <p className="page-state">Loading connectors…</p>
      </section>
    );
  }

  return (
    <>
      <section
        className="page-shell-section connectors-section"
        aria-label="Slack workspaces"
      >
        <header className="agents-panel-header">
          <h2>Slack workspaces</h2>
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleConnectSlackWorkspace}
              disabled={slackBusy === 'connect'}
            >
              {slackBusy === 'connect'
                ? 'Opening Slack…'
                : '+ Connect Slack workspace'}
            </button>
          ) : null}
        </header>
        {slackError ? (
          <p className="page-state error" role="alert">
            {slackError}
          </p>
        ) : null}
        {slackNotice ? (
          <p className="page-state" role="status">
            {slackNotice}
          </p>
        ) : null}
        {slackInstalls.length === 0 ? (
          <p className="page-state">
            {isAdmin
              ? 'No Slack workspaces connected yet. Connect a workspace to add channels from it below.'
              : 'No Slack workspaces connected. Ask your workspace admin to connect one.'}
          </p>
        ) : (
          <table className="connector-table">
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Channels</th>
                <th scope="col">Installed</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {slackInstalls.map((install) => {
                const isDeleting =
                  slackBusy &&
                  typeof slackBusy === 'object' &&
                  slackBusy.teamId === install.teamId;
                return (
                  <tr key={install.teamId}>
                    <td>
                      <div className="connector-row-name">
                        <strong>{install.teamName}</strong>
                        <span className="connector-row-subtitle">
                          {install.teamId}
                        </span>
                      </div>
                    </td>
                    <td>
                      {install.boundChannelCount === 0
                        ? 'No channels yet'
                        : install.boundChannelCount === 1
                          ? '1 channel'
                          : `${install.boundChannelCount} channels`}
                    </td>
                    <td>{new Date(install.installedAt).toLocaleDateString()}</td>
                    <td className="connector-row-actions">
                      {isAdmin ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger-outline"
                          aria-label={`Disconnect Slack workspace ${install.teamName}`}
                          onClick={() =>
                            handleDisconnectSlackWorkspace(install)
                          }
                          disabled={Boolean(isDeleting)}
                        >
                          {isDeleting ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section
        className="page-shell-section connectors-section"
        aria-label="Channels available to talks"
      >
        <header className="agents-panel-header">
          <h2>Channels available to talks</h2>
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setCreateKind('slack');
                setModal({ kind: 'create-channel' });
              }}
            >
              + Add channel
            </button>
          ) : null}
        </header>
        {status.kind === 'error' ? (
          <p className="page-state error" role="alert">
            {status.message}{' '}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setStatus({ kind: 'loading' });
                void refresh();
              }}
            >
              Retry
            </button>
          </p>
        ) : null}
        {channels.length === 0 ? (
          <p className="page-state">
            {isAdmin
              ? 'No channels yet. Add Slack or Telegram to make them available across all your talks.'
              : 'No channels available. Ask your workspace admin to add one in Settings → Connectors.'}
          </p>
        ) : (
          <ConnectorTable
            rows={channels.map((channel) => ({
              id: channel.id,
              kindLabel: CHANNEL_KIND_LABELS[channel.kind],
              displayName: channel.displayName,
              subtitle: resolveConnectorSubtitle(channel.kind, channel.config),
              boundTalkCount: channel.boundTalkCount,
              enabled: channel.enabled,
              hasCredential: channel.hasCredential,
              onEdit: isAdmin
                ? () => setModal({ kind: 'edit-channel', channel })
                : undefined,
              onDelete: isAdmin
                ? () => setDeleteState({ kind: 'channel', channel })
                : undefined,
              labelNoun: 'Slack/Telegram channel',
            }))}
          />
        )}
      </section>

      <section
        className="page-shell-section connectors-section"
        aria-label="Data sources available to talks"
      >
        <header className="agents-panel-header">
          <h2>Data sources available to talks</h2>
          {isAdmin ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setCreateKind('posthog');
                setModal({ kind: 'create-data-connector' });
              }}
            >
              + Add data source
            </button>
          ) : null}
        </header>
        {dataConnectors.length === 0 ? (
          <p className="page-state">
            {isAdmin
              ? 'No data sources yet. Add PostHog or Google Docs/Sheets to make them available across all your talks.'
              : 'No data sources available. Ask your workspace admin to add one.'}
          </p>
        ) : (
          <ConnectorTable
            rows={dataConnectors.map((dc) => ({
              id: dc.id,
              kindLabel: DATA_CONNECTOR_KIND_LABELS[dc.kind],
              displayName: dc.displayName,
              subtitle: resolveConnectorSubtitle(dc.kind, dc.config),
              boundTalkCount: dc.boundTalkCount,
              enabled: dc.enabled,
              hasCredential: dc.hasCredential,
              onEdit: isAdmin
                ? () =>
                    setModal({
                      kind: 'edit-data-connector',
                      dataConnector: dc,
                    })
                : undefined,
              onDelete: isAdmin
                ? () =>
                    setDeleteState({
                      kind: 'data-connector',
                      dataConnector: dc,
                    })
                : undefined,
              labelNoun: 'Data source',
            }))}
          />
        )}
        {!isAdmin ? (
          <p className="page-state-footer">
            Workspace admins manage connectors in Settings.
          </p>
        ) : null}
      </section>

      {modal.kind !== 'closed' ? (
        <div
          className="connector-modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeModal();
          }}
        >
          <div className="connector-modal">
            <ConnectorModalContent
              modal={modal}
              createKind={createKind}
              setCreateKind={setCreateKind}
              submitting={formSubmitting}
              error={formError}
              slackInstalls={slackInstalls}
              onCancel={closeModal}
              onCreateChannel={handleCreateChannelSubmit}
              onEditChannel={handleEditChannelSubmit}
              onSlackChannelsAdded={handleSlackChannelsAdded}
              onCreateDataConnector={handleCreateDataConnectorSubmit}
              onEditDataConnector={handleEditDataConnectorSubmit}
            />
          </div>
        </div>
      ) : null}

      {deleteState.kind !== 'closed' ? (
        <div
          className="connector-modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              if (!deleteSubmitting) setDeleteState({ kind: 'closed' });
            }
          }}
        >
          <div className="connector-modal connector-delete-modal">
            <h3>
              Delete{' '}
              {deleteState.kind === 'channel'
                ? deleteState.channel.displayName
                : deleteState.dataConnector.displayName}
              ?
            </h3>
            <p>
              Deleting removes this connector from{' '}
              {deleteState.kind === 'channel'
                ? deleteState.channel.boundTalkCount
                : deleteState.dataConnector.boundTalkCount}{' '}
              talks. Talk histories stay intact. This cannot be undone.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDeleteState({ kind: 'closed' })}
                disabled={deleteSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleConfirmDelete}
                disabled={deleteSubmitting}
              >
                {deleteSubmitting ? 'Deleting…' : 'Delete connector'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

type ConnectorTableRow = {
  id: string;
  kindLabel: string;
  displayName: string;
  subtitle: string | null;
  boundTalkCount: number;
  enabled: boolean;
  hasCredential: boolean;
  labelNoun: string;
  onEdit?: () => void;
  onDelete?: () => void;
};

function ConnectorTable({ rows }: { rows: ConnectorTableRow[] }): JSX.Element {
  return (
    <table className="connector-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Kind</th>
          <th scope="col">Used by</th>
          <th scope="col">Status</th>
          <th scope="col" aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <div className="connector-row-name">
                <strong>{row.displayName}</strong>
                {row.subtitle ? (
                  <span className="connector-row-subtitle">{row.subtitle}</span>
                ) : null}
              </div>
            </td>
            <td>{row.kindLabel}</td>
            <td>
              {row.boundTalkCount === 0
                ? 'Not yet linked'
                : row.boundTalkCount === 1
                  ? 'Used by 1 talk'
                  : `Used by ${row.boundTalkCount} talks`}
            </td>
            <td>
              <ConnectorStatusPill
                enabled={row.enabled}
                hasCredential={row.hasCredential}
              />
            </td>
            <td className="connector-row-actions">
              {row.onEdit ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Edit ${row.labelNoun}: ${row.displayName}`}
                  onClick={row.onEdit}
                >
                  Edit
                </button>
              ) : null}
              {row.onDelete ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger-outline"
                  aria-label={`Delete ${row.labelNoun}: ${row.displayName}`}
                  onClick={row.onDelete}
                >
                  Delete
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConnectorModalContent({
  modal,
  createKind,
  setCreateKind,
  submitting,
  error,
  slackInstalls,
  onCancel,
  onCreateChannel,
  onEditChannel,
  onSlackChannelsAdded,
  onCreateDataConnector,
  onEditDataConnector,
}: {
  modal: Exclude<ConnectorModalState, { kind: 'closed' }>;
  createKind: string;
  setCreateKind: (kind: string) => void;
  submitting: boolean;
  error: string | null;
  slackInstalls: WorkspaceSlackInstall[];
  onCancel: () => void;
  onCreateChannel: (
    kind: ChannelKind,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => Promise<void>;
  onEditChannel: (
    channel: WorkspaceChannel,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => Promise<void>;
  onSlackChannelsAdded: (count: number) => Promise<void> | void;
  onCreateDataConnector: (
    kind: DataConnectorKind,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => Promise<void>;
  onEditDataConnector: (
    dc: WorkspaceDataConnector,
    input: {
      displayName: string;
      config: Record<string, unknown>;
      apiKey?: string | null;
      rotateCredential?: boolean;
    },
  ) => Promise<void>;
}): JSX.Element {
  if (modal.kind === 'create-channel') {
    return (
      <>
        <h3>Add channel</h3>
        <label className="form-field">
          <span className="form-field-label">Channel kind</span>
          <select
            value={createKind}
            onChange={(event) => setCreateKind(event.target.value)}
            disabled={submitting}
          >
            <option value="slack">Slack</option>
            <option value="telegram">Telegram</option>
          </select>
        </label>
        {createKind === 'slack' ? (
          <SlackChannelPicker
            installs={slackInstalls}
            onAdded={(count) => {
              void onSlackChannelsAdded(count);
            }}
            onCancel={onCancel}
          />
        ) : (
          <TelegramChannelForm
            mode="create"
            submitting={submitting}
            error={error}
            onSubmit={(input) => onCreateChannel('telegram', input)}
            onCancel={onCancel}
          />
        )}
      </>
    );
  }
  if (modal.kind === 'edit-channel') {
    const channel = modal.channel;
    return (
      <>
        <h3>Edit channel</h3>
        {channel.kind === 'slack' ? (
          <SlackChannelForm
            mode="edit"
            initial={channel}
            submitting={submitting}
            error={error}
            installs={slackInstalls}
            onSubmit={(input) => onEditChannel(channel, input)}
            onCancel={onCancel}
          />
        ) : (
          <TelegramChannelForm
            mode="edit"
            initial={channel}
            submitting={submitting}
            error={error}
            onSubmit={(input) => onEditChannel(channel, input)}
            onCancel={onCancel}
          />
        )}
      </>
    );
  }
  if (modal.kind === 'create-data-connector') {
    return (
      <>
        <h3>Add data source</h3>
        <label className="form-field">
          <span className="form-field-label">Data source kind</span>
          <select
            value={createKind}
            onChange={(event) => setCreateKind(event.target.value)}
            disabled={submitting}
          >
            <option value="posthog">PostHog</option>
            <option value="google_docs">Google Docs</option>
            <option value="google_sheets">Google Sheets</option>
          </select>
        </label>
        {createKind === 'posthog' ? (
          <PostHogDataConnectorForm
            mode="create"
            submitting={submitting}
            error={error}
            onSubmit={(input) => onCreateDataConnector('posthog', input)}
            onCancel={onCancel}
          />
        ) : createKind === 'google_docs' ? (
          <GoogleDocsDataConnectorForm
            mode="create"
            submitting={submitting}
            error={error}
            onSubmit={(input) => onCreateDataConnector('google_docs', input)}
            onCancel={onCancel}
          />
        ) : (
          <GoogleSheetsDataConnectorForm
            mode="create"
            submitting={submitting}
            error={error}
            onSubmit={(input) => onCreateDataConnector('google_sheets', input)}
            onCancel={onCancel}
          />
        )}
      </>
    );
  }
  const dc = modal.dataConnector;
  return (
    <>
      <h3>Edit data source</h3>
      {dc.kind === 'posthog' ? (
        <PostHogDataConnectorForm
          mode="edit"
          initial={dc}
          submitting={submitting}
          error={error}
          onSubmit={(input) => onEditDataConnector(dc, input)}
          onCancel={onCancel}
        />
      ) : dc.kind === 'google_docs' ? (
        <GoogleDocsDataConnectorForm
          mode="edit"
          initial={dc}
          submitting={submitting}
          error={error}
          onSubmit={(input) => onEditDataConnector(dc, input)}
          onCancel={onCancel}
        />
      ) : (
        <GoogleSheetsDataConnectorForm
          mode="edit"
          initial={dc}
          submitting={submitting}
          error={error}
          onSubmit={(input) => onEditDataConnector(dc, input)}
          onCancel={onCancel}
        />
      )}
    </>
  );
}
