import { Link } from 'react-router-dom';

import type { TalkSidebarItem, TalkSidebarTalk } from '../lib/api';

type ExternalTalkData = {
  items: TalkSidebarItem[];
  loading: boolean;
  error: string | null;
};

function flattenTalkSidebar(items: TalkSidebarItem[]): TalkSidebarTalk[] {
  return items.flatMap((item) =>
    item.type === 'talk' ? [item] : item.talks,
  );
}

export function TalkListPage({
  externalData,
}: {
  externalData: ExternalTalkData;
}): JSX.Element {
  const effectiveTalks = flattenTalkSidebar(externalData.items);

  if (externalData.loading) {
    return <p className="page-state">Loading talks…</p>;
  }

  if (externalData.error) {
    return (
      <section className="page-state">
        <h2>Talks Unavailable</h2>
        <p>{externalData.error}</p>
      </section>
    );
  }

  return (
    <section className="page-shell">
      <header className="page-header">
        <h1>Talks</h1>
        <p className="settings-copy">
          Use the blue <strong>+</strong> button in the sidebar to create a new talk
          or folder.
        </p>
      </header>

      {effectiveTalks.length === 0 ? (
        <p className="page-state">No talks yet. Create one from the sidebar.</p>
      ) : (
        <ul className="talk-list">
          {effectiveTalks.map((talk) => (
            <li key={talk.id}>
              <Link to={`/app/talks/${talk.id}`}>
                <div className="talk-list-main">
                  <strong>{talk.title}</strong>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
