import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';

import { AvatarMenu } from './components/AvatarMenu';
import { ClawTalkMark } from './components/ClawTalkMark';
import { ClawTalkSidebar } from './components/ClawTalkSidebar';
import { SignInView } from './components/SignInView';
import {
  createTalk,
  createTalkFolder,
  deleteTalk,
  deleteTalkFolder,
  getSessionMe,
  getTalkSidebar,
  logout as logoutSession,
  patchTalkFolder,
  patchTalkMetadata,
  reorderTalkSidebar,
  SessionUser,
  Talk,
  TalkSidebarFolder,
  TalkSidebarItem,
  TalkSidebarTalk,
  UnauthorizedError,
} from './lib/api';
import { AiAgentsPage } from './pages/AiAgentsPage';
import { DataConnectorsPage } from './pages/DataConnectorsPage';
import { MainChannelPage } from './pages/MainChannelPage';
import { TalkDetailPage } from './pages/TalkDetailPage';
import { TalkListPage } from './pages/TalkListPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: SessionUser };

type RenameDraft = {
  talkId: string;
  draft: string;
} | null;

type TalkReadMarker = {
  messageCount: number;
  lastMessageAt: string | null;
};

type SidebarTalkView = TalkSidebarTalk & {
  unreadCount: number;
  isResponding: boolean;
};

type SidebarFolderView = Omit<TalkSidebarFolder, 'talks'> & {
  talks: SidebarTalkView[];
};

type SidebarItemView = SidebarTalkView | SidebarFolderView;

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'clawtalk.sidebarCollapsed';
const TALK_READ_MARKERS_STORAGE_KEY = 'clawtalk.talkReadMarkers';
const SIDEBAR_REFRESH_INTERVAL_MS = 5_000;

function readTalkReadMarkers(): Record<string, TalkReadMarker> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(TALK_READ_MARKERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<
      string,
      { messageCount?: unknown; lastMessageAt?: unknown }
    >;
    return Object.fromEntries(
      Object.entries(parsed).map(([talkId, marker]) => [
        talkId,
        {
          messageCount:
            typeof marker.messageCount === 'number' ? marker.messageCount : 0,
          lastMessageAt:
            typeof marker.lastMessageAt === 'string'
              ? marker.lastMessageAt
              : null,
        },
      ]),
    );
  } catch {
    return {};
  }
}

function flattenSidebarTalks(items: TalkSidebarItem[]): TalkSidebarTalk[] {
  return items.flatMap((item) => (item.type === 'talk' ? [item] : item.talks));
}

function findSidebarTalk(
  items: TalkSidebarItem[],
  talkId: string,
): TalkSidebarTalk | null {
  return flattenSidebarTalks(items).find((talk) => talk.id === talkId) ?? null;
}

function getTalkReadSnapshot(talk: TalkSidebarTalk): TalkReadMarker {
  return {
    messageCount: talk.messageCount ?? 0,
    lastMessageAt: talk.lastMessageAt ?? null,
  };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasNewerTalkMessage(
  talk: TalkSidebarTalk,
  marker: TalkReadMarker | undefined,
): boolean {
  if (!marker) return false;
  const talkLastMessageAt = parseTimestamp(talk.lastMessageAt);
  const markerLastMessageAt = parseTimestamp(marker.lastMessageAt);
  if (talkLastMessageAt !== null && markerLastMessageAt !== null) {
    return talkLastMessageAt > markerLastMessageAt;
  }
  if (talkLastMessageAt === null) return false;
  return (talk.messageCount ?? 0) > marker.messageCount;
}

function reconcileTalkReadMarker(
  talk: TalkSidebarTalk,
  marker: TalkReadMarker | undefined,
  isActive: boolean,
): TalkReadMarker {
  const snapshot = getTalkReadSnapshot(talk);
  if (isActive || !marker) return snapshot;
  return hasNewerTalkMessage(talk, marker) ? marker : snapshot;
}

function computeUnreadCount(
  talk: TalkSidebarTalk,
  marker: TalkReadMarker | undefined,
  isActive: boolean,
): number {
  if (isActive) return 0;
  if (!hasNewerTalkMessage(talk, marker)) return 0;
  const messageCount = talk.messageCount ?? 0;
  const unreadCount = messageCount - (marker?.messageCount ?? 0);
  return unreadCount > 0 ? unreadCount : 1;
}

function buildSidebarViewItems(
  items: TalkSidebarItem[],
  readMarkers: Record<string, TalkReadMarker>,
  activeTalkId: string,
): SidebarItemView[] {
  const toViewTalk = (talk: TalkSidebarTalk): SidebarTalkView => ({
    ...talk,
    unreadCount: computeUnreadCount(
      talk,
      readMarkers[talk.id],
      talk.id === activeTalkId,
    ),
    isResponding: !!talk.hasActiveRun,
  });

  return items.map((item) =>
    item.type === 'talk'
      ? toViewTalk(item)
      : {
          ...item,
          talks: item.talks.map(toViewTalk),
        },
  );
}

function toSidebarTalk(
  talk: Talk,
  existing?: Partial<TalkSidebarTalk> | null,
): TalkSidebarTalk {
  return {
    type: 'talk',
    id: talk.id,
    title: talk.title,
    status: talk.status,
    sortOrder: talk.sortOrder,
    lastMessageAt: existing?.lastMessageAt ?? null,
    messageCount: existing?.messageCount ?? 0,
    hasActiveRun: existing?.hasActiveRun ?? false,
  };
}

function updateSidebarTalk(
  items: TalkSidebarItem[],
  talk: Talk,
): TalkSidebarItem[] {
  const currentTalk = findSidebarTalk(items, talk.id);
  return items.map((item) => {
    if (item.type === 'talk') {
      return item.id === talk.id ? toSidebarTalk(talk, currentTalk) : item;
    }
    return {
      ...item,
      talks: item.talks.map((child) =>
        child.id === talk.id ? toSidebarTalk(talk, currentTalk) : child,
      ),
    };
  });
}

function removeSidebarTalk(
  items: TalkSidebarItem[],
  talkId: string,
): TalkSidebarItem[] {
  return items
    .filter((item) => !(item.type === 'talk' && item.id === talkId))
    .map((item) =>
      item.type === 'folder'
        ? { ...item, talks: item.talks.filter((talk) => talk.id !== talkId) }
        : item,
    );
}

function insertTopLevelTalk(
  items: TalkSidebarItem[],
  talk: Talk,
): TalkSidebarItem[] {
  return [toSidebarTalk(talk, null), ...items];
}

function replaceSidebarFolder(
  items: TalkSidebarItem[],
  folder: Pick<TalkSidebarFolder, 'id' | 'title' | 'sortOrder' | 'talks'>,
): TalkSidebarItem[] {
  const nextFolder: TalkSidebarFolder = {
    type: 'folder',
    id: folder.id,
    title: folder.title,
    sortOrder: folder.sortOrder,
    talks: folder.talks,
  };
  const existing = items.find(
    (item) => item.type === 'folder' && item.id === folder.id,
  );
  if (!existing) {
    return [...items, nextFolder].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
    );
  }
  return items.map((item) =>
    item.type === 'folder' && item.id === folder.id ? nextFolder : item,
  );
}

function removeSidebarFolder(
  items: TalkSidebarItem[],
  folderId: string,
): TalkSidebarItem[] {
  const folder = items.find(
    (item): item is TalkSidebarFolder =>
      item.type === 'folder' && item.id === folderId,
  );
  if (!folder) return items;
  const withoutFolder = items.filter(
    (item) => !(item.type === 'folder' && item.id === folderId),
  );
  const promoted = folder.talks.map<TalkSidebarTalk>((talk, index) => ({
    ...talk,
    sortOrder: index,
  }));
  return [...promoted, ...withoutFolder];
}

function findTalkTitle(
  items: TalkSidebarItem[],
  talkId: string,
): string | null {
  for (const item of items) {
    if (item.type === 'talk' && item.id === talkId) return item.title;
    if (item.type === 'folder') {
      const match = item.talks.find((talk) => talk.id === talkId);
      if (match) return match.title;
    }
  }
  return null;
}

function buildOptimisticReorder(
  items: TalkSidebarItem[],
  input: {
    itemType: 'talk' | 'folder';
    itemId: string;
    destinationFolderId: string | null;
    destinationIndex: number;
  },
): TalkSidebarItem[] {
  const destinationIndex = Math.max(0, input.destinationIndex);

  if (input.itemType === 'folder') {
    if (input.destinationFolderId !== null) return items;
    const root = items.filter(
      (item) => item.type !== 'folder' || item.id !== input.itemId,
    );
    const folder = items.find(
      (item): item is TalkSidebarFolder =>
        item.type === 'folder' && item.id === input.itemId,
    );
    if (!folder) return items;
    const next = [...root];
    next.splice(Math.min(destinationIndex, next.length), 0, folder);
    return next.map((item, index) => ({ ...item, sortOrder: index }));
  }

  const stripped = items
    .filter((item) => !(item.type === 'talk' && item.id === input.itemId))
    .map((item) =>
      item.type === 'folder'
        ? {
            ...item,
            talks: item.talks.filter((talk) => talk.id !== input.itemId),
          }
        : item,
    );

  const moving =
    items.find(
      (item): item is TalkSidebarTalk =>
        item.type === 'talk' && item.id === input.itemId,
    ) ||
    items
      .filter((item): item is TalkSidebarFolder => item.type === 'folder')
      .flatMap((folder) => folder.talks)
      .find((talk) => talk.id === input.itemId);
  if (!moving) return items;

  if (input.destinationFolderId === null) {
    const nextRoot = [...stripped];
    nextRoot.splice(Math.min(destinationIndex, nextRoot.length), 0, {
      ...moving,
      sortOrder: destinationIndex,
    });
    return nextRoot.map((item, index) =>
      item.type === 'talk'
        ? { ...item, sortOrder: index }
        : { ...item, sortOrder: index },
    );
  }

  return stripped.map((item) => {
    if (item.type !== 'folder' || item.id !== input.destinationFolderId)
      return item;
    const talks = [...item.talks];
    talks.splice(Math.min(destinationIndex, talks.length), 0, {
      ...moving,
      sortOrder: destinationIndex,
    });
    return {
      ...item,
      talks: talks.map((talk, index) => ({ ...talk, sortOrder: index })),
    };
  });
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [sidebarItems, setSidebarItems] = useState<TalkSidebarItem[]>([]);
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<RenameDraft>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [talkReadMarkers, setTalkReadMarkers] = useState<
    Record<string, TalkReadMarker>
  >({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    if (stored === 'true') {
      setSidebarCollapsed(true);
    }
    setTalkReadMarkers(readTalkReadMarkers());
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      sidebarCollapsed ? 'true' : 'false',
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      TALK_READ_MARKERS_STORAGE_KEY,
      JSON.stringify(talkReadMarkers),
    );
  }, [talkReadMarkers]);

  const refreshSession = useCallback(async () => {
    try {
      const user = await getSessionMe();
      setAuth({ status: 'authenticated', user });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setAuth({ status: 'unauthenticated' });
        return;
      }
      setAuth({ status: 'unauthenticated' });
    }
  }, []);

  const handleUnauthorized = useCallback(() => {
    setAuth({ status: 'unauthenticated' });
  }, []);

  const handleSignOut = useCallback(async () => {
    if (signOutBusy) return;
    setSignOutBusy(true);
    try {
      await logoutSession();
    } finally {
      setAuth({ status: 'unauthenticated' });
      setSignOutBusy(false);
    }
  }, [signOutBusy]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const refreshSidebar = useCallback(async () => {
    try {
      const tree = await getTalkSidebar();
      setSidebarItems(tree.items);
      setSidebarError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setSidebarError(
        err instanceof Error ? err.message : 'Failed to load talks',
      );
    } finally {
      setSidebarLoading(false);
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    if (auth.status !== 'authenticated') {
      setSidebarItems([]);
      setSidebarLoading(true);
      setSidebarError(null);
      setRenameDraft(null);
      return;
    }
    void refreshSidebar();
  }, [auth.status, refreshSidebar]);

  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    const refresh = () => void refreshSidebar();
    const intervalId = window.setInterval(refresh, SIDEBAR_REFRESH_INTERVAL_MS);
    const handleFocus = () => refresh();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [auth.status, refreshSidebar]);

  const handleCreateTalk = useCallback(async () => {
    const talk = await createTalk('');
    setSidebarItems((current) => insertTopLevelTalk(current, talk));
    setSidebarError(null);
    setRenameDraft({ talkId: talk.id, draft: talk.title });
    navigate(`/app/talks/${talk.id}`);
    void refreshSidebar();
    return talk;
  }, [navigate, refreshSidebar]);

  const handleCreateFolder = useCallback(async () => {
    const folder = await createTalkFolder('');
    setSidebarItems((current) => replaceSidebarFolder(current, folder));
    setSidebarError(null);
    return folder;
  }, []);

  const handleRenameTalk = useCallback(
    (talkId: string, title: string) => {
      setRenameDraft({ talkId, draft: title });
      navigate(`/app/talks/${talkId}`);
    },
    [navigate],
  );

  const handleRenameDraftChange = useCallback(
    (talkId: string, draft: string) => {
      setRenameDraft({ talkId, draft });
    },
    [],
  );

  const handleRenameDraftCancel = useCallback((talkId: string) => {
    setRenameDraft((current) => (current?.talkId === talkId ? null : current));
  }, []);

  const handleRenameDraftCommit = useCallback(
    async (talkId: string, draft: string) => {
      const updated = await patchTalkMetadata({ talkId, title: draft });
      setSidebarItems((current) => updateSidebarTalk(current, updated));
      setRenameDraft((current) =>
        current?.talkId === talkId ? null : current,
      );
    },
    [],
  );

  const handlePatchTalk = useCallback(
    async (input: {
      talkId: string;
      title?: string;
      folderId?: string | null;
    }) => {
      const updated = await patchTalkMetadata(input);
      setSidebarItems((current) => {
        const without = removeSidebarTalk(current, updated.id);
        const nextTalk = toSidebarTalk(
          updated,
          findSidebarTalk(current, updated.id),
        );
        if (updated.folderId) {
          return without.map((item) =>
            item.type === 'folder' && item.id === updated.folderId
              ? {
                  ...item,
                  talks: [...item.talks, nextTalk].sort(
                    (a, b) =>
                      a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
                  ),
                }
              : item,
          );
        }
        return [...without, nextTalk].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
        );
      });
      void refreshSidebar();
      return updated;
    },
    [refreshSidebar],
  );

  const handleDeleteTalk = useCallback(
    async (talkId: string) => {
      await deleteTalk(talkId);
      setSidebarItems((current) => removeSidebarTalk(current, talkId));
      if (location.pathname.startsWith(`/app/talks/${talkId}`)) {
        navigate('/app/talks');
      }
    },
    [location.pathname, navigate],
  );

  const handleRenameFolder = useCallback(
    async (folderId: string, title: string) => {
      const updated = await patchTalkFolder({ folderId, title });
      setSidebarItems((current) => replaceSidebarFolder(current, updated));
    },
    [],
  );

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      await deleteTalkFolder(folderId);
      setSidebarItems((current) => removeSidebarFolder(current, folderId));
      void refreshSidebar();
    },
    [refreshSidebar],
  );

  const handleReorder = useCallback(
    async (input: {
      itemType: 'talk' | 'folder';
      itemId: string;
      destinationFolderId: string | null;
      destinationIndex: number;
    }) => {
      const snapshot = sidebarItems;
      setSidebarItems((current) => buildOptimisticReorder(current, input));
      try {
        await reorderTalkSidebar(input);
      } catch {
        setSidebarItems(snapshot);
      }
    },
    [sidebarItems],
  );

  const canManageSettings =
    auth.status === 'authenticated' &&
    (auth.user.role === 'owner' || auth.user.role === 'admin');
  const canManageAgents =
    auth.status === 'authenticated' &&
    (auth.user.role === 'owner' || auth.user.role === 'admin');

  const handleUserUpdated = useCallback((user: SessionUser) => {
    setAuth({ status: 'authenticated', user });
  }, []);

  const currentTalkId = location.pathname.startsWith('/app/talks/')
    ? decodeURIComponent(location.pathname.split('/')[3] || '')
    : '';
  const sidebarViewItems = useMemo(
    () => buildSidebarViewItems(sidebarItems, talkReadMarkers, currentTalkId),
    [currentTalkId, sidebarItems, talkReadMarkers],
  );
  const currentTalkTitle = currentTalkId
    ? findTalkTitle(sidebarItems, currentTalkId)
    : null;
  const isTalkRoute =
    location.pathname.startsWith('/app/talks/') &&
    location.pathname !== '/app/talks';
  const isMainRoute = location.pathname.startsWith('/app/main');

  useEffect(() => {
    if (!sidebarItems.length) return;
    setTalkReadMarkers((current) => {
      let changed = false;
      const next = { ...current };
      for (const talk of flattenSidebarTalks(sidebarItems)) {
        const nextMarker = reconcileTalkReadMarker(
          talk,
          current[talk.id],
          talk.id === currentTalkId,
        );
        const previous = current[talk.id];
        if (
          previous &&
          previous.messageCount === nextMarker.messageCount &&
          previous.lastMessageAt === nextMarker.lastMessageAt
        ) {
          continue;
        }
        next[talk.id] = nextMarker;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [currentTalkId, sidebarItems]);

  if (auth.status === 'loading') {
    return <main className="page-state">Checking session…</main>;
  }

  if (auth.status === 'unauthenticated') {
    return <SignInView onSignedIn={refreshSession} />;
  }

  return (
    <main
      className={`app-shell${sidebarCollapsed ? ' app-shell-sidebar-collapsed' : ''}`}
    >
      <header className="app-global-header">
        <div className="app-global-header-left">
          <button
            type="button"
            className="app-sidebar-toggle"
            aria-label={
              sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
            }
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            {sidebarCollapsed ? '▸' : '◂'}
          </button>
          <div className="app-global-brand">
            <ClawTalkMark />
            <span className="app-global-brand-title">ClawTalk</span>
          </div>
          <form
            className="app-global-search"
            role="search"
            onSubmit={(event) => event.preventDefault()}
          >
            <span className="app-global-search-icon" aria-hidden="true">
              ⌕
            </span>
            <input type="search" aria-label="Search" placeholder="Search..." />
          </form>
        </div>
        <div className="app-global-header-right">
          <a
            className="app-global-help-link"
            href="https://clawtalk.app/help"
            target="_blank"
            rel="noreferrer"
            aria-label="Help"
            title="Help"
          >
            ?
          </a>
          <AvatarMenu
            user={auth.user}
            canManageSettings={canManageSettings}
            onSignOut={handleSignOut}
            signOutBusy={signOutBusy}
          />
        </div>
      </header>
      {!sidebarCollapsed ? (
        <ClawTalkSidebar
          items={sidebarViewItems}
          loading={sidebarLoading}
          error={sidebarError}
          userRole={auth.user.role}
          onCreateTalk={handleCreateTalk}
          onCreateFolder={handleCreateFolder}
          onRenameTalk={handleRenameTalk}
          onPatchTalk={handlePatchTalk}
          onDeleteTalk={handleDeleteTalk}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onReorder={handleReorder}
          renameDraft={renameDraft}
        />
      ) : null}
      <div className="app-main">
        <div
          className={`app-main-content${isTalkRoute || isMainRoute ? ' app-main-content-talk' : ''}`}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/app/main" replace />} />
            <Route
              path="/app/main"
              element={<MainChannelPage onUnauthorized={handleUnauthorized} />}
            />
            <Route
              path="/app/main/:threadId"
              element={<MainChannelPage onUnauthorized={handleUnauthorized} />}
            />
            <Route
              path="/app/talks"
              element={
                <TalkListPage
                  externalData={{
                    items: sidebarItems,
                    loading: sidebarLoading,
                    error: sidebarError,
                  }}
                />
              }
            />
            <Route
              path="/app/talks/:talkId/*"
              element={
                <TalkDetailPage
                  onUnauthorized={handleUnauthorized}
                  titleOverride={currentTalkTitle}
                  renameDraft={renameDraft}
                  onRenameDraftChange={handleRenameDraftChange}
                  onRenameDraftCancel={handleRenameDraftCancel}
                  onRenameDraftCommit={handleRenameDraftCommit}
                />
              }
            />
            <Route
              path="/app/agents"
              element={
                <AiAgentsPage
                  onUnauthorized={handleUnauthorized}
                  userRole={auth.user.role}
                />
              }
            />
            <Route
              path="/app/connectors"
              element={
                canManageAgents ? (
                  <DataConnectorsPage
                    onUnauthorized={handleUnauthorized}
                    userRole={auth.user.role}
                  />
                ) : (
                  <Navigate to="/app/talks" replace />
                )
              }
            />
            <Route
              path="/app/settings"
              element={
                canManageSettings ? (
                  <SettingsPage
                    onUnauthorized={handleUnauthorized}
                    userRole={auth.user.role}
                  />
                ) : (
                  <Navigate to="/app/talks" replace />
                )
              }
            />
            <Route
              path="/app/profile"
              element={
                <ProfilePage
                  user={auth.user}
                  onUnauthorized={handleUnauthorized}
                  onUserUpdated={handleUserUpdated}
                />
              }
            />
            <Route path="*" element={<Navigate to="/app/main" replace />} />
          </Routes>
        </div>
      </div>
    </main>
  );
}
