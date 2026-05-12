import { useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  connectUserGoogleAccount,
  createDataConnector,
  DataConnector,
  deleteDataConnector,
  expandUserGoogleScopes,
  getDataConnectors,
  getUserGoogleAccount,
  patchDataConnector,
  setDataConnectorCredential,
  UnauthorizedError,
  type UserGoogleAccount,
} from '../lib/api';
import { SlackChannelConnectorPanel } from '../components/SlackChannelConnectorPanel';
import { TelegramChannelConnectorPanel } from '../components/TelegramChannelConnectorPanel';
import { launchGoogleAccountPopup } from '../lib/googleAccountPopup';
import { useLocation, useNavigate } from 'react-router-dom';

type Props = {
  onUnauthorized: () => void;
  userRole: string;
};

type ConnectorDraft = {
  name: string;
  enabled: boolean;
  documentId: string;
  documentUrl: string;
  hostUrl: string;
  projectId: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
};
const GOOGLE_CONNECTOR_SCOPES: Record<
  Extract<DataConnector['connectorKind'], 'google_docs' | 'google_sheets'>,
  string[]
> = {
  google_docs: ['documents'],
  google_sheets: ['spreadsheets.readonly', 'spreadsheets'],
};

function canManageDataConnectors(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

function createEmptyGoogleAccount(): UserGoogleAccount {
  return {
    connected: false,
    email: null,
    displayName: null,
    scopes: [],
    accessExpiresAt: null,
  };
}

function hasGoogleConnectorAccess(
  kind: Extract<DataConnector['connectorKind'], 'google_docs' | 'google_sheets'>,
  account: UserGoogleAccount,
): boolean {
  return GOOGLE_CONNECTOR_SCOPES[kind].some((scope) =>
    account.scopes.includes(scope),
  );
}

function formatVerificationStatus(
  status: DataConnector['verificationStatus'],
): string {
  switch (status) {
    case 'missing':
      return 'Missing credential';
    case 'not_verified':
      return 'Needs verification';
    case 'verifying':
      return 'Verifying…';
    case 'verified':
      return 'Configured';
    case 'invalid':
      return 'Invalid';
    case 'unavailable':
      return 'Unavailable';
    default:
      return status;
  }
}

function verificationStatusClass(
  status: DataConnector['verificationStatus'],
): string {
  switch (status) {
    case 'verified':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'invalid':
      return 'talk-agent-chip talk-agent-chip-error';
    case 'unavailable':
      return 'talk-agent-chip talk-agent-chip-warning';
    default:
      return 'talk-agent-chip';
  }
}

function formatConnectorKind(kind: DataConnector['connectorKind']): string {
  if (kind === 'posthog') return 'PostHog';
  return kind === 'google_docs' ? 'Google Docs' : 'Google Sheets';
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function readConfigString(
  connector: DataConnector,
  key: string,
  fallback = '',
): string {
  const value = connector.config?.[key];
  return typeof value === 'string' ? value : fallback;
}

function buildConnectorDraft(connector: DataConnector): ConnectorDraft {
  return {
    name: connector.name,
    enabled: connector.enabled,
    documentId: readConfigString(connector, 'documentId'),
    documentUrl: readConfigString(connector, 'documentUrl'),
    hostUrl: readConfigString(connector, 'hostUrl', 'https://us.posthog.com'),
    projectId: readConfigString(connector, 'projectId'),
    spreadsheetId: readConfigString(connector, 'spreadsheetId'),
    spreadsheetUrl: readConfigString(connector, 'spreadsheetUrl'),
  };
}

function createEmptyDraft(
  kind: DataConnector['connectorKind'],
): ConnectorDraft {
  return {
    name: '',
    enabled: true,
    documentId: '',
    documentUrl: '',
    hostUrl: 'https://us.posthog.com',
    projectId: '',
    spreadsheetId: '',
    spreadsheetUrl: '',
  };
}

function buildConnectorConfig(
  kind: DataConnector['connectorKind'],
  draft: ConnectorDraft,
): Record<string, unknown> {
  if (kind === 'posthog') {
    return {
      hostUrl: draft.hostUrl.trim(),
      projectId: draft.projectId.trim(),
    };
  }
  if (kind === 'google_docs') {
    return {
      documentId: draft.documentId.trim(),
      documentUrl: draft.documentUrl.trim(),
    };
  }
  return {
    spreadsheetId: draft.spreadsheetId.trim(),
    spreadsheetUrl: draft.spreadsheetUrl.trim(),
  };
}

export function DataConnectorsPage({
  onUnauthorized,
  userRole,
}: Props): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [connectors, setConnectors] = useState<DataConnector[]>([]);
  const [googleAccount, setGoogleAccount] = useState<UserGoogleAccount>(
    createEmptyGoogleAccount(),
  );
  const [drafts, setDrafts] = useState<Record<string, ConnectorDraft>>({});
  const [credentialDrafts, setCredentialDrafts] = useState<
    Record<string, string>
  >({});
  const [createKind, setCreateKind] =
    useState<DataConnector['connectorKind']>('posthog');
  const [createDraft, setCreateDraft] = useState<ConnectorDraft>(() =>
    createEmptyDraft('posthog'),
  );
  const [createApiKey, setCreateApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const canManage = useMemo(
    () => canManageDataConnectors(userRole),
    [userRole],
  );
  const activeTab = useMemo(
    () =>
      new URLSearchParams(location.search).get('tab') === 'channel-connectors'
        ? 'channel-connectors'
        : 'data-connectors',
    [location.search],
  );

  const setActiveTab = (tab: 'data-connectors' | 'channel-connectors') => {
    const params = new URLSearchParams(location.search);
    if (tab === 'channel-connectors') {
      params.set('tab', 'channel-connectors');
    } else {
      params.delete('tab');
    }
    navigate({
      pathname: '/app/connectors',
      search: params.toString() ? `?${params.toString()}` : '',
    });
  };

  const refreshGoogleAccount = async (): Promise<UserGoogleAccount> => {
    const nextGoogleAccount = await getUserGoogleAccount();
    setGoogleAccount(nextGoogleAccount);
    return nextGoogleAccount;
  };

  const syncConnectors = (nextConnectors: DataConnector[]) => {
    setConnectors(nextConnectors);
    setDrafts((current) => {
      const nextDrafts: Record<string, ConnectorDraft> = {};
      for (const connector of nextConnectors) {
        nextDrafts[connector.id] =
          current[connector.id] || buildConnectorDraft(connector);
      }
      return nextDrafts;
    });
    setCredentialDrafts((current) => {
      const nextDrafts: Record<string, string> = {};
      for (const connector of nextConnectors) {
        nextDrafts[connector.id] = current[connector.id] || '';
      }
      return nextDrafts;
    });
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [nextConnectors, nextGoogleAccount] = await Promise.all([
          getDataConnectors(),
          getUserGoogleAccount(),
        ]);
        if (cancelled) return;
        syncConnectors(nextConnectors);
        setGoogleAccount(nextGoogleAccount);
        setError(null);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load data connectors.',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    if (canManage) {
      void load();
    } else {
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [canManage, onUnauthorized]);

  if (!canManage) {
    return (
      <section className="settings-shell">
        <p className="page-state">
          Connectors are available to owners and admins.
        </p>
      </section>
    );
  }

  const upsertConnector = (connector: DataConnector) => {
    setConnectors((current) => {
      const existing = current.find((item) => item.id === connector.id);
      if (!existing) {
        return [connector, ...current];
      }
      return current.map((item) =>
        item.id === connector.id ? connector : item,
      );
    });
    setDrafts((current) => ({
      ...current,
      [connector.id]: buildConnectorDraft(connector),
    }));
    setCredentialDrafts((current) => ({
      ...current,
      [connector.id]: '',
    }));
  };

  const handleCreate = async () => {
    setBusyKey('create');
    try {
      let created = await createDataConnector({
        name: createDraft.name,
        connectorKind: createKind,
        config: buildConnectorConfig(createKind, createDraft),
        enabled: createDraft.enabled,
      });

      // If an API key was provided, save it immediately and trigger verification
      const trimmedKey = createApiKey.trim();
      if (trimmedKey && createKind === 'posthog') {
        created = await setDataConnectorCredential({
          connectorId: created.id,
          apiKey: trimmedKey,
        });
      }

      upsertConnector(created);
      setCreateDraft(createEmptyDraft(createKind));
      setCreateApiKey('');
      setNotice(
        trimmedKey
          ? `${created.name} connector created and credential saved.`
          : `${created.name} connector created.`,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to create connector.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveConnector = async (connector: DataConnector) => {
    const draft = drafts[connector.id];
    if (!draft) return;
    setBusyKey(`save:${connector.id}`);
    try {
      const updated = await patchDataConnector({
        connectorId: connector.id,
        name: draft.name,
        enabled: draft.enabled,
        config: buildConnectorConfig(connector.connectorKind, draft),
      });
      upsertConnector(updated);
      setNotice(`${updated.name} connector updated.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update connector.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveCredential = async (connector: DataConnector) => {
    setBusyKey(`credential:${connector.id}`);
    try {
      const updated = await setDataConnectorCredential({
        connectorId: connector.id,
        apiKey: credentialDrafts[connector.id] || null,
      });
      upsertConnector(updated);
      setNotice(
        credentialDrafts[connector.id]?.trim()
          ? `${updated.name} credential saved.`
          : `${updated.name} credential cleared.`,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to save credential.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const ensureGoogleConnectorAccess = async (
    kind: Extract<DataConnector['connectorKind'], 'google_docs' | 'google_sheets'>,
  ): Promise<UserGoogleAccount> => {
    let nextGoogleAccount = googleAccount;
    const returnTo = location.pathname;
    const requiredScopes = GOOGLE_CONNECTOR_SCOPES[kind];

    if (!nextGoogleAccount.connected) {
      const launch = await connectUserGoogleAccount({
        returnTo,
        scopes: requiredScopes,
      });
      await launchGoogleAccountPopup(launch.authorizationUrl);
      nextGoogleAccount = await refreshGoogleAccount();
    }

    if (!hasGoogleConnectorAccess(kind, nextGoogleAccount)) {
      const launch = await expandUserGoogleScopes({
        scopes: requiredScopes,
        returnTo,
      });
      await launchGoogleAccountPopup(launch.authorizationUrl);
      nextGoogleAccount = await refreshGoogleAccount();
    }

    if (!hasGoogleConnectorAccess(kind, nextGoogleAccount)) {
      throw new Error(
        `Linked Google account is still missing ${formatConnectorKind(kind)} access.`,
      );
    }

    return nextGoogleAccount;
  };

  const handleSaveGoogleConnectorCredential = async (
    connector: DataConnector,
  ) => {
    setBusyKey(`credential:${connector.id}`);
    try {
      const account = await ensureGoogleConnectorAccess(
        connector.connectorKind as 'google_docs' | 'google_sheets',
      );
      const updated = await setDataConnectorCredential({
        connectorId: connector.id,
        useGoogleAccount: true,
      });
      upsertConnector(updated);
      setNotice(
        account.email
          ? `${updated.name} credential saved from ${account.email}.`
          : `${updated.name} credential saved from linked Google account.`,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : `Failed to save ${formatConnectorKind(connector.connectorKind)} credential.`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearGoogleConnectorCredential = async (
    connector: DataConnector,
  ) => {
    setBusyKey(`credential:${connector.id}`);
    try {
      const updated = await setDataConnectorCredential({
        connectorId: connector.id,
        clearCredential: true,
      });
      upsertConnector(updated);
      setNotice(`${updated.name} credential cleared.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : `Failed to clear ${formatConnectorKind(connector.connectorKind)} credential.`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (connector: DataConnector) => {
    const confirmed = window.confirm(`Delete "${connector.name}"?`);
    if (!confirmed) return;
    setBusyKey(`delete:${connector.id}`);
    try {
      await deleteDataConnector(connector.id);
      setConnectors((current) =>
        current.filter((item) => item.id !== connector.id),
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[connector.id];
        return next;
      });
      setCredentialDrafts((current) => {
        const next = { ...current };
        delete next[connector.id];
        return next;
      });
      setNotice(`${connector.name} connector deleted.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to delete connector.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="settings-shell">
      <article className="settings-card">
        <h1>Connectors</h1>
        <p className="settings-copy">
          Manage workspace-level integrations. Data connectors power retrieval
          and query tools during execution. Channel connectors authenticate
          external inboxes, sync available destinations, and support Talk-level
          channel binding.
        </p>
        <div className="talk-subtabs-row" style={{ justifyContent: 'flex-start' }}>
          <div className="talk-tabs talk-subtabs" role="tablist" aria-label="Connector tabs">
            <button
              type="button"
              className={`talk-tab${activeTab === 'data-connectors' ? ' talk-tab-active' : ''}`}
              aria-selected={activeTab === 'data-connectors'}
              onClick={() => setActiveTab('data-connectors')}
            >
              Data Connectors
            </button>
            <button
              type="button"
              className={`talk-tab${activeTab === 'channel-connectors' ? ' talk-tab-active' : ''}`}
              aria-selected={activeTab === 'channel-connectors'}
              onClick={() => setActiveTab('channel-connectors')}
            >
              Channel Connectors
            </button>
          </div>
        </div>
        {activeTab === 'data-connectors' && error ? (
          <div className="settings-banner settings-banner-error" role="alert">
            {error}
          </div>
        ) : null}
        {activeTab === 'data-connectors' && notice ? (
          <div
            className="settings-banner settings-banner-success"
            role="status"
          >
            {notice}
          </div>
        ) : null}
      </article>

      {activeTab === 'channel-connectors' ? (
        <>
          <SlackChannelConnectorPanel onUnauthorized={onUnauthorized} />
          <TelegramChannelConnectorPanel onUnauthorized={onUnauthorized} />
        </>
      ) : (
        <>
      <article className="settings-card">
        <h2>Add Connector</h2>
        <div className="connector-form-grid">
          <label>
            <span className="settings-label">Kind</span>
            <select
              value={createKind}
              onChange={(event) => {
                const nextKind = event.target
                  .value as DataConnector['connectorKind'];
                setCreateKind(nextKind);
                setCreateDraft(createEmptyDraft(nextKind));
                setCreateApiKey('');
              }}
            >
              <option value="posthog">PostHog</option>
              <option value="google_docs">Google Docs</option>
              <option value="google_sheets">Google Sheets</option>
            </select>
          </label>
          <label>
            <span className="settings-label">Name</span>
            <input
              value={createDraft.name}
              onChange={(event) =>
                setCreateDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder={
                createKind === 'posthog'
                  ? 'FTUE PostHog'
                  : createKind === 'google_docs'
                    ? 'Season Preview Doc'
                    : 'Live Ops Sheet'
              }
            />
          </label>
          {createKind === 'posthog' ? (
            <>
              <label>
                <span className="settings-label">Host URL</span>
                <input
                  value={createDraft.hostUrl}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      hostUrl: event.target.value,
                    }))
                  }
                  placeholder="https://us.posthog.com"
                />
              </label>
              <label>
                <span className="settings-label">Project ID</span>
                <input
                  value={createDraft.projectId}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      projectId: event.target.value,
                    }))
                  }
                  placeholder="12345"
                />
              </label>
              <label>
                <span className="settings-label">PostHog API Key</span>
                <input
                  type="password"
                  value={createApiKey}
                  onChange={(event) => setCreateApiKey(event.target.value)}
                  placeholder="phx_..."
                  autoComplete="off"
                />
              </label>
            </>
          ) : (
            <>
              <label>
                <span className="settings-label">
                  {createKind === 'google_docs' ? 'Document ID' : 'Spreadsheet ID'}
                </span>
                <input
                  value={
                    createKind === 'google_docs'
                      ? createDraft.documentId
                      : createDraft.spreadsheetId
                  }
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      ...(createKind === 'google_docs'
                        ? { documentId: event.target.value }
                        : { spreadsheetId: event.target.value }),
                    }))
                  }
                  placeholder={
                    createKind === 'google_docs'
                      ? '1BxiMVs0XRA5...'
                      : '1AbC...'
                  }
                />
              </label>
              <label>
                <span className="settings-label">
                  {createKind === 'google_docs'
                    ? 'Document URL'
                    : 'Spreadsheet URL'}
                </span>
                <input
                  value={
                    createKind === 'google_docs'
                      ? createDraft.documentUrl
                      : createDraft.spreadsheetUrl
                  }
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      ...(createKind === 'google_docs'
                        ? { documentUrl: event.target.value }
                        : { spreadsheetUrl: event.target.value }),
                    }))
                  }
                  placeholder="https://docs.google.com/..."
                />
              </label>
            </>
          )}
          <label className="connector-enabled-toggle">
            <input
              type="checkbox"
              checked={createDraft.enabled}
              onChange={(event) =>
                setCreateDraft((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
            />
            <span>Enabled</span>
          </label>
          <button
            type="button"
            className="primary-btn"
            onClick={() => void handleCreate()}
            disabled={busyKey === 'create'}
          >
            {busyKey === 'create' ? 'Creating…' : 'Create Connector'}
          </button>
        </div>
      </article>

      <article className="settings-card">
        <div className="connector-list-header">
          <h2>Connectors</h2>
          <span className="talk-llm-meta">{connectors.length} total</span>
        </div>
        {loading ? (
          <p className="page-state">Loading connectors…</p>
        ) : connectors.length === 0 ? (
          <p className="page-state">No connectors yet.</p>
        ) : (
          <div className="connector-card-list">
            {connectors.map((connector) => {
              const draft =
                drafts[connector.id] || buildConnectorDraft(connector);
              const isBusy = busyKey?.endsWith(`:${connector.id}`);
              return (
                <article
                  key={connector.id}
                  className="talk-llm-card connector-card"
                >
                  <div className="connector-card-header">
                    <div>
                      <h3>{connector.name}</h3>
                      <p className="talk-llm-meta">
                        {formatConnectorKind(connector.connectorKind)} •
                        Attached to {connector.attachedTalkCount} talk
                        {connector.attachedTalkCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    <span
                      className={verificationStatusClass(
                        connector.verificationStatus,
                      )}
                    >
                      {formatVerificationStatus(connector.verificationStatus)}
                    </span>
                  </div>

                  <div className="connector-form-grid">
                    <label>
                      <span className="settings-label">Name</span>
                      <input
                        value={draft.name}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [connector.id]: {
                              ...draft,
                              name: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                    {connector.connectorKind === 'posthog' ? (
                      <>
                        <label>
                          <span className="settings-label">Host URL</span>
                          <input
                            value={draft.hostUrl}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [connector.id]: {
                                  ...draft,
                                  hostUrl: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span className="settings-label">Project ID</span>
                          <input
                            value={draft.projectId}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [connector.id]: {
                                  ...draft,
                                  projectId: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>
                          <span className="settings-label">
                            {connector.connectorKind === 'google_docs'
                              ? 'Document ID'
                              : 'Spreadsheet ID'}
                          </span>
                          <input
                            value={
                              connector.connectorKind === 'google_docs'
                                ? draft.documentId
                                : draft.spreadsheetId
                            }
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [connector.id]: {
                                  ...draft,
                                  ...(connector.connectorKind === 'google_docs'
                                    ? { documentId: event.target.value }
                                    : { spreadsheetId: event.target.value }),
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span className="settings-label">
                            {connector.connectorKind === 'google_docs'
                              ? 'Document URL'
                              : 'Spreadsheet URL'}
                          </span>
                          <input
                            value={
                              connector.connectorKind === 'google_docs'
                                ? draft.documentUrl
                                : draft.spreadsheetUrl
                            }
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [connector.id]: {
                                  ...draft,
                                  ...(connector.connectorKind === 'google_docs'
                                    ? { documentUrl: event.target.value }
                                    : { spreadsheetUrl: event.target.value }),
                                },
                              }))
                            }
                          />
                        </label>
                      </>
                    )}
                    <label className="connector-enabled-toggle">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [connector.id]: {
                              ...draft,
                              enabled: event.target.checked,
                            },
                          }))
                        }
                      />
                      <span>Enabled</span>
                    </label>
                  </div>

                  <div className="connector-meta-grid">
                    <div>
                      <strong>Credential</strong>
                      <p>{connector.hasCredential ? 'Stored' : 'Missing'}</p>
                    </div>
                    <div>
                      <strong>Last verified</strong>
                      <p>{formatDateTime(connector.lastVerifiedAt)}</p>
                    </div>
                    <div>
                      <strong>Updated</strong>
                      <p>{formatDateTime(connector.updatedAt)}</p>
                    </div>
                  </div>

                  {connector.lastVerificationError ? (
                    <div
                      className="inline-banner inline-banner-warning"
                      role="status"
                    >
                      {connector.lastVerificationError}
                    </div>
                  ) : null}

                  {connector.connectorKind === 'posthog' ? (
                    <div className="connector-credential-row">
                      <label>
                        <span className="settings-label">PostHog API Key</span>
                        <input
                          type="password"
                          value={credentialDrafts[connector.id] || ''}
                          onChange={(event) =>
                            setCredentialDrafts((current) => ({
                              ...current,
                              [connector.id]: event.target.value,
                            }))
                          }
                          placeholder={
                            connector.hasCredential ? 'Stored key' : 'phx_...'
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handleSaveCredential(connector)}
                        disabled={busyKey === `credential:${connector.id}`}
                      >
                        {busyKey === `credential:${connector.id}`
                          ? 'Saving…'
                          : 'Save API Key'}
                      </button>
                    </div>
                  ) : (
                    <div className="connector-credential-row">
                      <div>
                        <span className="settings-label">
                          Linked Google account
                        </span>
                        <p style={{ margin: '0.25rem 0 0 0' }}>
                          {googleAccount.connected
                            ? `Connected as ${googleAccount.email || 'your Google account'}`
                            : 'Not connected'}
                        </p>
                        <p className="talk-llm-meta">
                          {hasGoogleConnectorAccess(
                            connector.connectorKind as
                              | 'google_docs'
                              | 'google_sheets',
                            googleAccount,
                          )
                            ? 'This account can be saved as the connector credential.'
                            : `${formatConnectorKind(connector.connectorKind)} access is required before saving this connector credential.`}
                        </p>
                      </div>
                      <div className="settings-button-row">
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() =>
                            void handleSaveGoogleConnectorCredential(connector)
                          }
                          disabled={busyKey === `credential:${connector.id}`}
                        >
                          {busyKey === `credential:${connector.id}`
                            ? 'Saving…'
                            : !googleAccount.connected
                              ? 'Connect Google'
                              : hasGoogleConnectorAccess(
                                    connector.connectorKind as
                                      | 'google_docs'
                                      | 'google_sheets',
                                    googleAccount,
                                  )
                                ? 'Use Linked Google Account'
                                : connector.connectorKind === 'google_docs'
                                  ? 'Grant Docs Access'
                                  : 'Grant Sheets Access'}
                        </button>
                        {connector.hasCredential ? (
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleClearGoogleConnectorCredential(
                                connector,
                              )
                            }
                            disabled={busyKey === `credential:${connector.id}`}
                          >
                            Clear Stored OAuth
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )}

                  <div className="settings-button-row">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleSaveConnector(connector)}
                      disabled={busyKey === `save:${connector.id}` || isBusy}
                    >
                      {busyKey === `save:${connector.id}`
                        ? 'Saving…'
                        : 'Save Details'}
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleDelete(connector)}
                      disabled={busyKey === `delete:${connector.id}` || isBusy}
                    >
                      {busyKey === `delete:${connector.id}`
                        ? 'Deleting…'
                        : 'Delete'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </article>
        </>
      )}
    </section>
  );
}
