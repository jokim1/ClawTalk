import { FormEvent, useEffect, useState } from 'react';

import type {
  WorkspaceChannel,
  WorkspaceSlackInstall,
} from '../../lib/api';

type SlackChannelFormProps = {
  mode: 'create' | 'edit';
  initial?: WorkspaceChannel;
  submitting: boolean;
  error: string | null;
  installs: WorkspaceSlackInstall[];
  onSubmit: (input: {
    displayName: string;
    config: { workspace_id: string; channel_id: string };
  }) => void | Promise<void>;
  onCancel: () => void;
};

export function SlackChannelForm({
  mode,
  initial,
  submitting,
  error,
  installs,
  onSubmit,
  onCancel,
}: SlackChannelFormProps): JSX.Element {
  const initialConfig = (initial?.config ?? {}) as Record<string, unknown>;
  const initialWorkspaceId =
    typeof initialConfig.workspace_id === 'string'
      ? initialConfig.workspace_id
      : '';
  const initialChannelId =
    typeof initialConfig.channel_id === 'string'
      ? initialConfig.channel_id
      : '';

  const [displayName, setDisplayName] = useState<string>(
    initial?.displayName ?? '',
  );
  const [workspaceId, setWorkspaceId] = useState<string>(() => {
    if (initialWorkspaceId) return initialWorkspaceId;
    if (installs.length === 1) return installs[0].teamId;
    return '';
  });
  const [channelId, setChannelId] = useState<string>(initialChannelId);

  // If the install list arrives after first paint (refresh races), default
  // the dropdown to the only option when there's exactly one and the user
  // hasn't picked yet.
  useEffect(() => {
    if (!workspaceId && installs.length === 1) {
      setWorkspaceId(installs[0].teamId);
    }
  }, [installs, workspaceId]);

  const noInstalls = installs.length === 0;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const trimmedName = displayName.trim();
    if (!trimmedName) return;
    const trimmedWorkspace = workspaceId.trim();
    const trimmedChannel = channelId.trim();
    if (!trimmedWorkspace || !trimmedChannel) return;
    void onSubmit({
      displayName: trimmedName,
      config: {
        workspace_id: trimmedWorkspace,
        channel_id: trimmedChannel,
      },
    });
  }

  return (
    <form className="connector-kind-form" onSubmit={handleSubmit}>
      <label className="form-field">
        <span className="form-field-label">Display name</span>
        <input
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Engineering Slack"
          required
          maxLength={200}
        />
      </label>
      <label className="form-field">
        <span className="form-field-label">Workspace</span>
        <select
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
          required
          disabled={noInstalls}
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
          then return here to add channels from it.
        </p>
      ) : null}
      <label className="form-field">
        <span className="form-field-label">Channel ID</span>
        <input
          type="text"
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
          placeholder="C01ABCDE"
          required
        />
      </label>
      <p className="form-field-help">
        Find a channel ID by right-clicking the channel in Slack → Copy link;
        the trailing path segment is the channel ID. Channel picker arrives in
        the next iteration.
      </p>
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
          disabled={submitting || noInstalls}
        >
          {submitting ? 'Saving…' : mode === 'create' ? 'Add channel' : 'Save'}
        </button>
      </div>
    </form>
  );
}
