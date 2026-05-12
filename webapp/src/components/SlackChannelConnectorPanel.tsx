import { useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  ChannelConnection,
  ChannelTarget,
  ChannelTargetListPage,
  clearSlackChannelConnectorConfig,
  diagnoseSlackWorkspaceTarget,
  disconnectSlackWorkspace,
  getSlackChannelConnector,
  listChannelTargets,
  saveSlackChannelConnectorConfig,
  SlackChannelConnector,
  startSlackChannelConnectorInstall,
  syncSlackWorkspace,
  UnauthorizedError,
} from '../lib/api';
import { launchSlackInstallPopup } from '../lib/slackInstallPopup';

type Props = {
  onUnauthorized: () => void;
};

type WorkspaceTargetListState = ChannelTargetListPage & {
  loading: boolean;
};

function emptyWorkspaceTargetListState(): WorkspaceTargetListState {
  return {
    targets: [],
    totalCount: 0,
    hasMore: false,
    nextOffset: null,
    loading: false,
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function statusChipClass(status: ChannelConnection['healthStatus']): string {
  switch (status) {
    case 'healthy':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'degraded':
      return 'talk-agent-chip talk-agent-chip-warning';
    case 'error':
      return 'talk-agent-chip talk-agent-chip-error';
    default:
      return 'talk-agent-chip';
  }
}

function targetStatusChipClass(target: ChannelTarget): string {
  return target.activeBindingTalkId
    ? 'talk-agent-chip talk-agent-chip-warning'
    : 'talk-agent-chip talk-agent-chip-success';
}

function targetStatusLabel(target: ChannelTarget): string {
  return target.activeBindingTalkTitle
    ? `Bound to ${target.activeBindingTalkTitle}`
    : 'Available';
}

function readConfigString(
  connection: ChannelConnection,
  key: string,
): string | null {
  const value = connection.config?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readConfigNumber(
  connection: ChannelConnection,
  key: string,
): number | null {
  const value = connection.config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatWorkspaceMeta(connection: ChannelConnection): string {
  const teamUrl = readConfigString(connection, 'teamUrl');
  const teamId = readConfigString(connection, 'teamId');
  if (teamUrl && teamId) {
    return `${teamUrl} · ${teamId}`;
  }
  return teamUrl || teamId || connection.accountKey;
}

function formatChannelType(target: ChannelTarget): string {
  return target.metadata?.isPrivate === true ? 'Private channel' : 'Channel';
}

function buildWorkspaceSyncSummary(
  connection: ChannelConnection,
  targetPage: WorkspaceTargetListState,
): string {
  const publicCount = readConfigNumber(connection, 'lastSyncPublicCount');
  const privateCount = readConfigNumber(connection, 'lastSyncPrivateCount');
  const totalCount = readConfigNumber(connection, 'lastSyncTotalCount');
  const lastSyncedAt = readConfigString(connection, 'lastSyncedAt');
  const countLabel =
    totalCount != null
      ? `${totalCount} synced channel${totalCount === 1 ? '' : 's'}`
      : `${targetPage.totalCount} channel${targetPage.totalCount === 1 ? '' : 's'} in this result set`;
  const splitLabel =
    publicCount != null && privateCount != null
      ? ` (${publicCount} public, ${privateCount} private)`
      : '';
  const freshnessLabel = lastSyncedAt
    ? ` · Last synced ${formatDateTime(lastSyncedAt)}`
    : '';
  return `${countLabel}${splitLabel}${freshnessLabel}`;
}

export function SlackChannelConnectorPanel({
  onUnauthorized,
}: Props): JSX.Element {
  const [connector, setConnector] = useState<SlackChannelConnector | null>(null);
  const [targetPagesByConnection, setTargetPagesByConnection] = useState<
    Record<string, WorkspaceTargetListState>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clientIdDraft, setClientIdDraft] = useState('');
  const [clientSecretDraft, setClientSecretDraft] = useState('');
  const [signingSecretDraft, setSigningSecretDraft] = useState('');
  const [configDraftTouched, setConfigDraftTouched] = useState(false);
  const [searchByConnection, setSearchByConnection] = useState<
    Record<string, string>
  >({});
  const [diagnosticDrafts, setDiagnosticDrafts] = useState<
    Record<string, string>
  >({});

  const refresh = async () => {
    try {
      const next = await getSlackChannelConnector();
      setConnector(next);
      if (!configDraftTouched) {
        setClientIdDraft(next.config.clientId || '');
      }
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to load Slack connector.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await refresh();
    };
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [configDraftTouched, onUnauthorized]);

  useEffect(() => {
    if (!connector) return;
    if (connector.workspaces.length === 0) {
      setTargetPagesByConnection({});
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setTargetPagesByConnection((current) =>
        Object.fromEntries(
          connector.workspaces.map((workspace) => [
            workspace.id,
            {
              ...(current[workspace.id] || emptyWorkspaceTargetListState()),
              loading: true,
            },
          ]),
        ),
      );

      void Promise.all(
        connector.workspaces.map(async (workspace) => {
          const page = await listChannelTargets({
            connectionId: workspace.id,
            query: searchByConnection[workspace.id] || '',
            approval: 'all',
            limit: 50,
            offset: 0,
          });
          return [workspace.id, page] as const;
        }),
      )
        .then((pages) => {
          if (cancelled) return;
          setTargetPagesByConnection(
            Object.fromEntries(
              pages.map(([workspaceId, page]) => [
                workspaceId,
                { ...page, loading: false },
              ]),
            ),
          );
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof UnauthorizedError) {
            onUnauthorized();
            return;
          }
          setError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load synced Slack channels.',
          );
          setTargetPagesByConnection((current) =>
            Object.fromEntries(
              connector.workspaces.map((workspace) => [
                workspace.id,
                {
                  ...(current[workspace.id] || emptyWorkspaceTargetListState()),
                  loading: false,
                },
              ]),
            ),
          );
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [connector, onUnauthorized, searchByConnection]);

  const workspaceEntries = useMemo(
    () =>
      (connector?.workspaces || []).map((workspace) => ({
        workspace,
        targetPage:
          targetPagesByConnection[workspace.id] || emptyWorkspaceTargetListState(),
      })),
    [connector?.workspaces, targetPagesByConnection],
  );

  const handleSaveConfig = async () => {
    setBusyKey('save-config');
    try {
      const next = await saveSlackChannelConnectorConfig({
        clientId: clientIdDraft,
        clientSecret: clientSecretDraft || undefined,
        signingSecret: signingSecretDraft || undefined,
      });
      setConnector(next);
      setClientIdDraft(next.config.clientId || '');
      setClientSecretDraft('');
      setSigningSecretDraft('');
      setConfigDraftTouched(false);
      setNotice('Slack app configuration saved.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to save Slack app configuration.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearConfig = async () => {
    setBusyKey('clear-config');
    try {
      const next = await clearSlackChannelConnectorConfig();
      setConnector(next);
      setClientIdDraft('');
      setClientSecretDraft('');
      setSigningSecretDraft('');
      setConfigDraftTouched(false);
      setNotice('Slack app configuration cleared.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to clear Slack app configuration.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleInstallWorkspace = async () => {
    setBusyKey('install-workspace');
    try {
      const result = await startSlackChannelConnectorInstall(
        '/app/connectors?tab=channel-connectors',
      );
      await launchSlackInstallPopup(result.authorizationUrl);
      await refresh();
      setNotice('Slack workspace connected.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const handleSyncWorkspace = async (connectionId: string) => {
    setBusyKey(`sync:${connectionId}`);
    try {
      const result = await syncSlackWorkspace(connectionId);
      const page = await listChannelTargets({
        connectionId,
        query: searchByConnection[connectionId] || '',
        approval: 'all',
        limit: 50,
        offset: 0,
      });
      setTargetPagesByConnection((current) => ({
        ...current,
        [connectionId]: { ...page, loading: false },
      }));
      await refresh();
      setNotice(
        `Synced ${result.syncedCount} Slack channels (${result.publicCount} public, ${result.privateCount} private).`,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to sync Slack channels.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleDisconnectWorkspace = async (connectionId: string) => {
    setBusyKey(`disconnect:${connectionId}`);
    try {
      await disconnectSlackWorkspace(connectionId);
      await refresh();
      setNotice('Slack workspace disconnected.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to disconnect Slack workspace.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleLoadMoreChannels = async (connectionId: string) => {
    const currentPage = targetPagesByConnection[connectionId];
    if (!currentPage?.hasMore || currentPage.nextOffset == null) {
      return;
    }

    setTargetPagesByConnection((current) => ({
      ...current,
      [connectionId]: {
        ...(current[connectionId] || emptyWorkspaceTargetListState()),
        loading: true,
      },
    }));

    try {
      const page = await listChannelTargets({
        connectionId,
        query: searchByConnection[connectionId] || '',
        approval: 'all',
        limit: 50,
        offset: currentPage.nextOffset,
      });
      setTargetPagesByConnection((current) => ({
        ...current,
        [connectionId]: {
          targets: [...(current[connectionId]?.targets || []), ...page.targets],
          totalCount: page.totalCount,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          loading: false,
        },
      }));
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to load more Slack channels.',
      );
      setTargetPagesByConnection((current) => ({
        ...current,
        [connectionId]: {
          ...(current[connectionId] || emptyWorkspaceTargetListState()),
          loading: false,
        },
      }));
    }
  };

  const handleCheckChannel = async (workspaceId: string) => {
    const rawInput = (diagnosticDrafts[workspaceId] || '').trim();
    if (!rawInput) return;
    setBusyKey(`check:${workspaceId}`);
    try {
      const diagnostic = await diagnoseSlackWorkspaceTarget({
        connectionId: workspaceId,
        rawInput,
      });
      const page = await listChannelTargets({
        connectionId: workspaceId,
        query: searchByConnection[workspaceId] || '',
        approval: 'all',
        limit: 50,
        offset: 0,
      });
      setTargetPagesByConnection((current) => ({
        ...current,
        [workspaceId]: { ...page, loading: false },
      }));
      setDiagnosticDrafts((current) => ({ ...current, [workspaceId]: '' }));
      setNotice(`${diagnostic.target.displayName} added to synced channels.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to check Slack channel.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <article className="settings-card">
        <h2>Connect Slack App</h2>
        <p className="settings-copy">
          Configure one Slack app for this ClawTalk workspace. Save the signing
          secret first, then use the generated Redirect URL and Events API URL
          in Slack before installing the app into any workspace.
        </p>
        {error ? (
          <div className="settings-banner settings-banner-error" role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div
            className="settings-banner settings-banner-success"
            role="status"
          >
            {notice}
          </div>
        ) : null}
        {loading ? (
          <p className="page-state">Loading Slack connector…</p>
        ) : connector ? (
          <>
            {!connector.config.available ? (
              <div
                className="settings-banner settings-banner-warning"
                role="status"
              >
                {connector.config.availabilityReason}
              </div>
            ) : null}
            <div className="connector-form-grid">
              <label>
                <span className="settings-label">Client ID</span>
                <input
                  type="text"
                  value={clientIdDraft}
                  onChange={(event) => {
                    setClientIdDraft(event.target.value);
                    setConfigDraftTouched(true);
                  }}
                  placeholder="1234567890.1234567890"
                  autoComplete="off"
                />
              </label>
              <label>
                <span className="settings-label">Client Secret</span>
                <input
                  type="password"
                  value={clientSecretDraft}
                  onChange={(event) => {
                    setClientSecretDraft(event.target.value);
                    setConfigDraftTouched(true);
                  }}
                  placeholder={
                    connector.config.hasClientSecret
                      ? 'Stored in ClawTalk'
                      : 'Paste Slack client secret'
                  }
                  autoComplete="off"
                />
              </label>
              <label>
                <span className="settings-label">Signing Secret</span>
                <input
                  type="password"
                  value={signingSecretDraft}
                  onChange={(event) => {
                    setSigningSecretDraft(event.target.value);
                    setConfigDraftTouched(true);
                  }}
                  placeholder={
                    connector.config.hasSigningSecret
                      ? 'Stored in ClawTalk'
                      : 'Paste Slack signing secret'
                  }
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="connector-card-list" style={{ marginTop: '1rem' }}>
              <div className="talk-llm-card" style={{ margin: 0 }}>
                <h3>Setup Order</h3>
                <ol style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                  <li>Save the Slack app credentials here.</li>
                  <li>Paste the Redirect URL into Slack.</li>
                  <li>
                    Paste the Events API URL into Slack and complete
                    verification.
                  </li>
                  <li>Enable bot scopes and event subscriptions.</li>
                  <li>Install the app to a workspace.</li>
                  <li>
                    Invite the app to any private channels you want to bind.
                  </li>
                  <li>Sync channels here, then bind them from a Talk.</li>
                </ol>
              </div>
              <div className="talk-llm-card" style={{ margin: 0 }}>
                <h3>Callback URLs</h3>
                <p className="talk-llm-meta">
                  Redirect URL: {connector.config.redirectUrl || 'Unavailable'}
                </p>
                <p className="talk-llm-meta">
                  Events API URL:{' '}
                  {connector.config.eventsApiUrl ||
                    'Not ready until the signing secret is saved'}
                </p>
                <p className="talk-llm-meta">
                  Events API status:{' '}
                  {connector.config.eventsApiReady ? 'Ready' : 'Not ready'}
                </p>
              </div>
            </div>
            <div className="settings-button-row" style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void handleSaveConfig()}
                disabled={busyKey !== null}
              >
                {busyKey === 'save-config' ? 'Saving…' : 'Save Slack App'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void handleInstallWorkspace()}
                disabled={
                  busyKey !== null || !connector.config.oauthInstallReady
                }
              >
                {busyKey === 'install-workspace'
                  ? 'Opening Slack…'
                  : 'Install to Workspace'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void handleClearConfig()}
                disabled={busyKey !== null}
              >
                Clear Config
              </button>
            </div>
          </>
        ) : null}
      </article>

      <article className="settings-card">
        <h2>Connected Workspaces</h2>
        <p className="settings-copy">
          Each installed Slack workspace becomes its own live channel
          connection. Sync channels here; Talks choose from the synced channel
          inventory when you bind them.
        </p>
        {loading ? (
          <p className="page-state">Loading workspaces…</p>
        ) : workspaceEntries.length === 0 ? (
          <div className="settings-banner settings-banner-warning" role="status">
            No Slack workspaces are connected yet.
          </div>
        ) : (
          <div className="connector-card-list">
            {workspaceEntries.map(({ workspace, targetPage }) => (
              <article
                key={workspace.id}
                className="talk-llm-card connector-card"
              >
                <div className="connector-card-header">
                  <div>
                    <h3>{workspace.displayName}</h3>
                    <p className="talk-llm-meta">{formatWorkspaceMeta(workspace)}</p>
                  </div>
                  <span className={statusChipClass(workspace.healthStatus)}>
                    {workspace.healthStatus}
                  </span>
                </div>
                <p className="talk-llm-meta">
                  Last checked: {formatDateTime(workspace.lastHealthCheckAt)}
                </p>
                {workspace.lastHealthError ? (
                  <div
                    className="settings-banner settings-banner-warning"
                    role="status"
                  >
                    {workspace.lastHealthError}
                  </div>
                ) : null}
                <div
                  className="settings-button-row"
                  style={{ marginTop: '0.75rem' }}
                >
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleSyncWorkspace(workspace.id)}
                    disabled={busyKey !== null}
                  >
                    {busyKey === `sync:${workspace.id}` ? 'Syncing…' : 'Sync Channels'}
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleDisconnectWorkspace(workspace.id)}
                    disabled={busyKey !== null}
                  >
                    Disconnect Workspace
                  </button>
                </div>

                <label style={{ display: 'block', marginTop: '1rem' }}>
                  <span className="settings-label">Search synced channels</span>
                  <input
                    type="text"
                    value={searchByConnection[workspace.id] || ''}
                    onChange={(event) =>
                      setSearchByConnection((current) => ({
                        ...current,
                        [workspace.id]: event.target.value,
                      }))
                    }
                    placeholder="Filter by channel name or ID"
                    style={{ width: '100%' }}
                  />
                </label>

                <div className="talk-llm-card" style={{ margin: '1rem 0 0' }}>
                  <div className="connector-card-header">
                    <div>
                      <h3>Synced Channels</h3>
                      <p className="talk-llm-meta">
                        {buildWorkspaceSyncSummary(workspace, targetPage)}
                      </p>
                    </div>
                  </div>
                  {targetPage.loading ? (
                    <p className="page-state">Loading synced channels…</p>
                  ) : targetPage.targets.length === 0 ? (
                    <p className="page-state">
                      No synced channels match this filter. Sync the workspace
                      after install, and invite the app to any private channel
                      you want to bind.
                    </p>
                  ) : (
                    <>
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {targetPage.targets.map((target) => (
                          <li
                            key={target.targetId}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.75rem',
                              padding: '0.55rem 0',
                              borderBottom: '1px solid var(--border, #e6e9ef)',
                            }}
                          >
                            <div style={{ flex: 1 }}>
                              <strong>{target.displayName}</strong>
                              <div className="talk-llm-meta">
                                {formatChannelType(target)} · {target.targetId}
                              </div>
                            </div>
                            <span className={targetStatusChipClass(target)}>
                              {targetStatusLabel(target)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {targetPage.hasMore ? (
                        <div
                          className="settings-button-row"
                          style={{ marginTop: '0.75rem' }}
                        >
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleLoadMoreChannels(workspace.id)}
                            disabled={busyKey !== null || targetPage.loading}
                          >
                            Load More Channels
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="talk-llm-card" style={{ margin: '1rem 0 0' }}>
                  <h3>Advanced Lookup</h3>
                  <p className="talk-llm-meta">
                    Use this only when a specific channel is missing from the
                    synced list and you want to verify whether the app can see
                    it yet.
                  </p>
                  <label style={{ display: 'block', marginTop: '0.75rem' }}>
                    <span className="settings-label">Check channel by URL or ID</span>
                    <div className="connector-attach-row">
                      <input
                        type="text"
                        value={diagnosticDrafts[workspace.id] || ''}
                        onChange={(event) =>
                          setDiagnosticDrafts((current) => ({
                            ...current,
                            [workspace.id]: event.target.value,
                          }))
                        }
                        placeholder="https://app.slack.com/.../C123 or C12345678"
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handleCheckChannel(workspace.id)}
                        disabled={busyKey !== null}
                      >
                        Discover Channel
                      </button>
                    </div>
                  </label>
                  <p className="talk-llm-meta" style={{ marginTop: '0.5rem' }}>
                    Private channels require the Slack app to be invited first.
                    In Slack, open the channel and run{' '}
                    <code>/invite @YourAppName</code>, then sync channels again.
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </article>
    </>
  );
}
