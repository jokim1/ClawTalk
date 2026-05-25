import { FormEvent, useEffect, useMemo, useState } from 'react';

import {
  bulkAddSlackChannels,
  listSlackInstallChannels,
  type SlackChannelOption,
  type WorkspaceSlackInstall,
} from '../../lib/api';

type SlackChannelPickerProps = {
  installs: WorkspaceSlackInstall[];
  onAdded: (count: number) => void;
  onCancel: () => void;
};

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; channels: SlackChannelOption[] }
  | { kind: 'error'; message: string };

export function SlackChannelPicker({
  installs,
  onAdded,
  onCancel,
}: SlackChannelPickerProps): JSX.Element {
  const noInstalls = installs.length === 0;
  const [teamId, setTeamId] = useState<string>(() =>
    installs.length === 1 ? installs[0].teamId : '',
  );
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) {
      setState({ kind: 'idle' });
      setSelectedIds(new Set());
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    setSelectedIds(new Set());
    listSlackInstallChannels(teamId)
      .then((channels) => {
        if (cancelled) return;
        setState({ kind: 'ready', channels });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: err.message || 'Failed to load Slack channels.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const filtered = useMemo(() => {
    if (state.kind !== 'ready') return [];
    const q = search.trim().toLowerCase();
    if (!q) return state.channels;
    return state.channels.filter((c) => c.name.toLowerCase().includes(q));
  }, [state, search]);

  const selectableCount = useMemo(
    () => filtered.filter((c) => !c.alreadyAdded).length,
    [filtered],
  );

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (state.kind !== 'ready') return;
    if (selectedIds.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const picks = state.channels
        .filter((c) => selectedIds.has(c.id))
        .map((c) => ({
          channelId: c.id,
          channelName: c.name,
          isPrivate: c.isPrivate,
        }));
      const created = await bulkAddSlackChannels({
        teamId,
        channels: picks,
      });
      onAdded(created.length);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to add channels.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="connector-kind-form" onSubmit={handleSubmit}>
      <label className="form-field">
        <span className="form-field-label">Workspace</span>
        <select
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
          required
          disabled={noInstalls || submitting}
        >
          <option value="" disabled>
            {noInstalls
              ? 'No Slack workspaces connected'
              : 'Select a workspace'}
          </option>
          {installs.map((install) => (
            <option key={install.teamId} value={install.teamId}>
              {install.teamName} ({install.teamId})
            </option>
          ))}
        </select>
      </label>

      {noInstalls ? (
        <p className="form-field-help">
          Connect a Slack workspace from the Slack workspaces section above,
          then return here to add channels.
        </p>
      ) : null}

      {teamId ? (
        <>
          <label className="form-field">
            <span className="form-field-label">Filter channels</span>
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Type to filter by name…"
              disabled={state.kind !== 'ready' || submitting}
            />
          </label>

          <div className="slack-channel-picker-list">
            {state.kind === 'loading' ? (
              <p className="page-state">Loading channels…</p>
            ) : null}
            {state.kind === 'error' ? (
              <p className="page-state error" role="alert">
                {state.message}
              </p>
            ) : null}
            {state.kind === 'ready' && filtered.length === 0 ? (
              <p className="page-state">
                {search
                  ? `No channels match "${search}".`
                  : 'This workspace has no public or private channels visible to the bot.'}
              </p>
            ) : null}
            {state.kind === 'ready' && filtered.length > 0 ? (
              <ul className="slack-channel-picker-options">
                {filtered.map((channel) => {
                  const disabled = channel.alreadyAdded;
                  return (
                    <li key={channel.id}>
                      <label
                        className={`slack-channel-picker-row${disabled ? ' is-disabled' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(channel.id)}
                          onChange={() => toggle(channel.id)}
                          disabled={disabled || submitting}
                        />
                        <span className="slack-channel-picker-name">
                          {channel.isPrivate ? '🔒 ' : '# '}
                          {channel.name}
                        </span>
                        <span className="slack-channel-picker-meta">
                          {channel.numMembers !== null
                            ? `${channel.numMembers} member${channel.numMembers === 1 ? '' : 's'}`
                            : ''}
                          {channel.isMember ? '' : ' · bot not joined'}
                          {channel.alreadyAdded ? ' · already added' : ''}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {state.kind === 'ready' &&
            selectableCount === 0 &&
            filtered.length > 0 ? (
              <p className="form-field-help">
                All matching channels are already added.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            submitting ||
            noInstalls ||
            state.kind !== 'ready' ||
            selectedIds.size === 0
          }
        >
          {submitting
            ? 'Adding…'
            : selectedIds.size === 0
              ? 'Add selected'
              : `Add ${selectedIds.size} channel${selectedIds.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </form>
  );
}
