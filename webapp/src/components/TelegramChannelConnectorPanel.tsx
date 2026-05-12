import { useEffect, useMemo, useState } from 'react';

import {
  adoptTelegramChannelConnectorEnvToken,
  ApiError,
  approveTelegramChannelTarget,
  ChannelTarget,
  clearTelegramChannelConnectorToken,
  getTelegramChannelConnector,
  saveTelegramChannelConnectorToken,
  TelegramChannelConnector,
  UnauthorizedError,
  unapproveTelegramChannelTarget,
  validateTelegramChannelConnector,
} from '../lib/api';

type Props = {
  onUnauthorized: () => void;
};

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function statusChipClass(
  status: TelegramChannelConnector['connection']['healthStatus'],
): string {
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

function formatTargetKind(target: ChannelTarget): string {
  const chatType =
    typeof target.metadata?.chatType === 'string'
      ? target.metadata.chatType
      : null;
  if (target.targetKind === 'channel') return 'Channel';
  if (chatType === 'supergroup') return 'Supergroup';
  if (chatType === 'group') return 'Group';
  if (chatType === 'private') return 'Direct Message';
  return 'Chat';
}

function formatTokenSource(
  tokenSource: TelegramChannelConnector['connection']['tokenSource'],
): string {
  switch (tokenSource) {
    case 'db':
      return 'Managed in ClawTalk';
    case 'env':
      return 'Managed by environment';
    default:
      return 'Not configured';
  }
}

export function TelegramChannelConnectorPanel({
  onUnauthorized,
}: Props): JSX.Element {
  const [connector, setConnector] = useState<TelegramChannelConnector | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [botTokenDraft, setBotTokenDraft] = useState('');
  const [manualTargetDraft, setManualTargetDraft] = useState('');
  const [manualDisplayName, setManualDisplayName] = useState('');

  const refresh = async () => {
    try {
      const next = await getTelegramChannelConnector();
      setConnector(next);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to load Telegram connector.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await getTelegramChannelConnector();
        if (cancelled) return;
        setConnector(next);
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
              : 'Failed to load Telegram connector.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [onUnauthorized]);

  const approvedTargets = useMemo(
    () => connector?.targets.filter((target) => target.approved) || [],
    [connector],
  );
  const discoveredTargets = useMemo(
    () => connector?.targets.filter((target) => !target.approved) || [],
    [connector],
  );

  const handleValidate = async () => {
    setBusyKey('validate');
    try {
      const result = await validateTelegramChannelConnector(botTokenDraft);
      setNotice(
        result.bot.botUsername
          ? `Connected to @${result.bot.botUsername}.`
          : `Telegram bot ${result.bot.botDisplayName} validated.`,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Telegram bot validation failed.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveToken = async () => {
    setBusyKey('save-token');
    try {
      const next = await saveTelegramChannelConnectorToken(botTokenDraft);
      setConnector(next);
      setBotTokenDraft('');
      setNotice('Telegram bot token saved.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to save Telegram bot token.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleDisconnect = async () => {
    setBusyKey('disconnect');
    try {
      const next = await clearTelegramChannelConnectorToken();
      setConnector(next);
      setNotice('Telegram bot token cleared.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to clear Telegram bot token.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleAdoptEnv = async () => {
    setBusyKey('adopt-env');
    try {
      const next = await adoptTelegramChannelConnectorEnvToken();
      setConnector(next);
      setNotice('Environment-managed Telegram token adopted into ClawTalk.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to adopt environment-managed Telegram token.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleApproveKnownTarget = async () => {
    setBusyKey('approve-manual');
    try {
      await approveTelegramChannelTarget({
        rawInput: manualTargetDraft,
        displayName: manualDisplayName.trim() || undefined,
      });
      await refresh();
      setManualTargetDraft('');
      setManualDisplayName('');
      setNotice('Telegram destination approved.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to approve Telegram destination.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleApproveDiscovered = async (target: ChannelTarget) => {
    setBusyKey(`approve:${target.targetId}`);
    try {
      await approveTelegramChannelTarget({
        targetKind: target.targetKind,
        targetId: target.targetId,
        displayName: target.displayName,
      });
      await refresh();
      setNotice(`${target.displayName} approved for Talk bindings.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to approve Telegram destination.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveApproved = async (target: ChannelTarget) => {
    setBusyKey(`remove:${target.targetId}`);
    try {
      await unapproveTelegramChannelTarget({
        targetKind: target.targetKind,
        targetId: target.targetId,
      });
      await refresh();
      setNotice(`${target.displayName} removed from approved destinations.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to remove approved Telegram destination.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <article className="settings-card">
        <h2>Connect Telegram Bot</h2>
        <p className="settings-copy">
          Create a bot with <strong>@BotFather</strong>, copy its HTTP API
          token, then paste it here. ClawTalk uses one shared workspace bot and
          only owners/admins can manage it.
        </p>
        <p className="talk-llm-meta" style={{ marginTop: '0.5rem' }}>
          After the bot is connected, add it to a DM, group, supergroup, or
          channel. Telegram destinations appear here after the bot receives a
          message or membership update.
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
          <p className="page-state">Loading Telegram connector…</p>
        ) : connector ? (
          <>
            <div className="connector-form-grid">
              <label>
                <span className="settings-label">Bot token</span>
                <input
                  type="password"
                  value={botTokenDraft}
                  onChange={(event) => setBotTokenDraft(event.target.value)}
                  placeholder="123456789:AAF..."
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="settings-button-row">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void handleValidate()}
                disabled={!botTokenDraft.trim() || busyKey === 'validate'}
              >
                {busyKey === 'validate' ? 'Validating…' : 'Validate connection'}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => void handleSaveToken()}
                disabled={!botTokenDraft.trim() || busyKey === 'save-token'}
              >
                {busyKey === 'save-token' ? 'Saving…' : 'Save Bot Token'}
              </button>
              {connector.connection.tokenSource === 'db' ? (
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => void handleDisconnect()}
                  disabled={busyKey === 'disconnect'}
                >
                  {busyKey === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              ) : null}
              {connector.connection.tokenSource === 'env' ? (
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => void handleAdoptEnv()}
                  disabled={busyKey === 'adopt-env'}
                >
                  {busyKey === 'adopt-env'
                    ? 'Adopting…'
                    : 'Adopt into ClawTalk'}
                </button>
              ) : null}
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void refresh()}
                disabled={busyKey === 'refresh'}
              >
                Refresh
              </button>
            </div>

            <div className="connector-meta-grid">
              <div>
                <strong>Health</strong>
                <p>
                  <span className={statusChipClass(connector.connection.healthStatus)}>
                    {connector.connection.healthStatus}
                  </span>
                </p>
              </div>
              <div>
                <strong>Token source</strong>
                <p>{formatTokenSource(connector.connection.tokenSource)}</p>
              </div>
              <div>
                <strong>Bot username</strong>
                <p>
                  {connector.bot.botUsername
                    ? `@${connector.bot.botUsername}`
                    : 'Unknown'}
                </p>
              </div>
              <div>
                <strong>Last verified</strong>
                <p>{formatDateTime(connector.connection.lastHealthCheckAt)}</p>
              </div>
            </div>

            {connector.connection.lastHealthError ? (
              <div className="inline-banner inline-banner-warning" role="status">
                {connector.connection.lastHealthError}
              </div>
            ) : null}

            {connector.connection.tokenSource === 'env' ? (
              <p className="talk-llm-meta">
                This workspace is currently using a Telegram bot token from the
                runtime environment. Adopt it into ClawTalk if you want to
                manage and rotate the token from the UI.
              </p>
            ) : null}
          </>
        ) : null}
      </article>

      <article className="settings-card">
        <div className="connector-list-header">
          <h2>Approved Destinations</h2>
          <span className="talk-llm-meta">{approvedTargets.length} total</span>
        </div>
        {approvedTargets.length === 0 ? (
          <p className="page-state">
            No Telegram destinations have been approved yet.
          </p>
        ) : (
          <div className="connector-card-list">
            {approvedTargets.map((target) => (
              <article
                key={`${target.targetKind}:${target.targetId}`}
                className="talk-llm-card connector-card"
              >
                <div className="connector-card-header">
                  <div>
                    <h3>{target.displayName}</h3>
                    <p className="talk-llm-meta">
                      {formatTargetKind(target)} • {target.targetId}
                    </p>
                  </div>
                  <span className="talk-agent-chip talk-agent-chip-success">
                    Approved
                  </span>
                </div>
                <div className="connector-meta-grid">
                  <div>
                    <strong>Approved at</strong>
                    <p>{formatDateTime(target.registeredAt)}</p>
                  </div>
                  <div>
                    <strong>Last seen</strong>
                    <p>{formatDateTime(target.lastSeenAt)}</p>
                  </div>
                </div>
                <div className="settings-button-row">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleRemoveApproved(target)}
                    disabled={busyKey === `remove:${target.targetId}`}
                  >
                    {busyKey === `remove:${target.targetId}`
                      ? 'Removing…'
                      : 'Remove'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </article>

      <article className="settings-card">
        <h2>Add Destination</h2>
        <p className="settings-copy">
          Preferred flow: add the bot to the DM, group, supergroup, or channel,
          then send a message or wait for Telegram to deliver a membership
          update. Discovered destinations appear below automatically.
        </p>
        <p className="talk-llm-meta" style={{ marginTop: '0.5rem' }}>
          Advanced fallback: use a known <code>@username</code>,{' '}
          <code>t.me/username</code>, <code>tg:&lt;chat_id&gt;</code>, or
          numeric chat ID. Private invite links such as <code>t.me/+...</code>{' '}
          are not enough on their own.
        </p>
        <div className="connector-form-grid">
          <label>
            <span className="settings-label">Known destination</span>
            <input
              value={manualTargetDraft}
              onChange={(event) => setManualTargetDraft(event.target.value)}
              placeholder="@my_channel or tg:-1001234567890"
            />
          </label>
          <label>
            <span className="settings-label">Display name (optional)</span>
            <input
              value={manualDisplayName}
              onChange={(event) => setManualDisplayName(event.target.value)}
              placeholder="Gamemakers Content"
            />
          </label>
        </div>
        <div className="settings-button-row">
          <button
            type="button"
            className="primary-btn"
            onClick={() => void handleApproveKnownTarget()}
            disabled={!manualTargetDraft.trim() || busyKey === 'approve-manual'}
          >
            {busyKey === 'approve-manual'
              ? 'Approving…'
              : 'Approve Destination'}
          </button>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void refresh()}
          >
            I Added The Bot, Refresh
          </button>
        </div>

        <div className="connector-list-header" style={{ marginTop: '1.25rem' }}>
          <h3>Discovered Destinations</h3>
          <span className="talk-llm-meta">{discoveredTargets.length} waiting</span>
        </div>
        {discoveredTargets.length === 0 ? (
          <p className="page-state">
            No discovered Telegram destinations yet.
          </p>
        ) : (
          <div className="connector-card-list">
            {discoveredTargets.map((target) => (
              <article
                key={`${target.targetKind}:${target.targetId}`}
                className="talk-llm-card connector-card"
              >
                <div className="connector-card-header">
                  <div>
                    <h3>{target.displayName}</h3>
                    <p className="talk-llm-meta">
                      {formatTargetKind(target)} • {target.targetId}
                    </p>
                  </div>
                  <span className="talk-agent-chip">Discovered</span>
                </div>
                <div className="connector-meta-grid">
                  <div>
                    <strong>Last seen</strong>
                    <p>{formatDateTime(target.lastSeenAt)}</p>
                  </div>
                  <div>
                    <strong>Username</strong>
                    <p>
                      {typeof target.metadata?.username === 'string'
                        ? `@${target.metadata.username}`
                        : 'None'}
                    </p>
                  </div>
                </div>
                <div className="settings-button-row">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleApproveDiscovered(target)}
                    disabled={busyKey === `approve:${target.targetId}`}
                  >
                    {busyKey === `approve:${target.targetId}`
                      ? 'Approving…'
                      : 'Approve'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </article>
    </>
  );
}
