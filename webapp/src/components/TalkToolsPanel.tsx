import { useCallback, useEffect, useState } from 'react';

import {
  createTalkGoogleDriveResource,
  deleteTalkResource,
  getGooglePickerSession,
  getTalkResources,
  type TalkResourceBinding,
} from '../lib/api';
import {
  openGoogleDrivePicker,
  type GoogleDrivePickerMode,
} from '../lib/googlePicker';

type DriveBinding = TalkResourceBinding & {
  kind: 'google_drive_folder' | 'google_drive_file';
};

function isDriveBinding(binding: TalkResourceBinding): binding is DriveBinding {
  return (
    binding.kind === 'google_drive_folder' ||
    binding.kind === 'google_drive_file'
  );
}

function bindingKindLabel(kind: DriveBinding['kind']): string {
  return kind === 'google_drive_folder' ? 'Folder' : 'File';
}

function bindingUrl(binding: DriveBinding): string | null {
  const metadata = binding.metadata ?? {};
  const url = metadata.url;
  return typeof url === 'string' ? url : null;
}

export interface TalkToolsPanelProps {
  talkId: string;
}

export function TalkToolsPanel({ talkId }: TalkToolsPanelProps): JSX.Element {
  const [bindings, setBindings] = useState<DriveBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getTalkResources({ talkId });
      setBindings(result.bindings.filter(isDriveBinding));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [talkId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await getTalkResources({ talkId });
        if (cancelled) return;
        setBindings(result.bindings.filter(isDriveBinding));
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [talkId]);

  const handleAddFromDrive = useCallback(
    async (mode: GoogleDrivePickerMode) => {
      setBusy(true);
      setError(null);
      try {
        const session = await getGooglePickerSession();
        const selections = await openGoogleDrivePicker({ session, mode });
        if (selections.length === 0) return;
        // Create bindings serially so a partial failure surfaces the
        // first broken selection cleanly instead of fanning out.
        for (const selection of selections) {
          await createTalkGoogleDriveResource({
            talkId,
            kind: selection.kind,
            externalId: selection.externalId,
            displayName: selection.displayName,
            metadata: selection.metadata,
          });
        }
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [reload, talkId],
  );

  const handleRemove = useCallback(
    async (binding: DriveBinding) => {
      setBusy(true);
      setError(null);
      try {
        await deleteTalkResource({ talkId, resourceId: binding.id });
        setBindings((prev) => prev.filter((b) => b.id !== binding.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [talkId],
  );

  return (
    <section className="talk-tools-panel">
      <header className="talk-tools-panel-header">
        <div>
          <h2>Bound Drive Resources</h2>
          <p className="talk-tools-panel-meta">
            Attach Google Drive folders or Docs so agents in this Talk can read
            or update them. Each user has their own bindings.
          </p>
        </div>
        <div className="talk-tools-panel-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleAddFromDrive('file')}
          >
            Add file from Drive
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleAddFromDrive('folder')}
          >
            Add folder from Drive
          </button>
        </div>
      </header>

      {error ? (
        <div className="talk-tools-panel-error" role="alert">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="talk-tools-panel-meta">Loading bindings…</p>
      ) : bindings.length === 0 ? (
        <p className="talk-tools-panel-empty">
          No Drive resources bound yet. Use the buttons above to attach a Doc
          or folder; agents will then be able to read or update it.
        </p>
      ) : (
        <ul className="talk-tools-binding-list">
          {bindings.map((binding) => {
            const url = bindingUrl(binding);
            return (
              <li className="talk-tools-binding" key={binding.id}>
                <div className="talk-tools-binding-meta">
                  <span className="talk-tools-binding-kind">
                    {bindingKindLabel(binding.kind)}
                  </span>
                  <span className="talk-tools-binding-name">
                    {binding.displayName}
                  </span>
                  {url ? (
                    <a
                      className="talk-tools-binding-link"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in Drive
                    </a>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="talk-tools-binding-remove"
                  disabled={busy}
                  onClick={() => void handleRemove(binding)}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
