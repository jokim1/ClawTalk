import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';

import type { Talk, TalkSidebarFolder, TalkSidebarItem } from '../lib/api';

type TalkSidebarTalkView = TalkSidebarItem & {
  type: 'talk';
  unreadCount?: number;
  isResponding?: boolean;
};

type TalkSidebarFolderView = Omit<TalkSidebarFolder, 'talks'> & {
  talks: TalkSidebarTalkView[];
};

type TalkSidebarItemView = TalkSidebarTalkView | TalkSidebarFolderView;

type RenameDraft = {
  talkId: string;
  draft: string;
} | null;

type MenuPosition = {
  top: number;
  left: number;
  maxHeight: number;
};

type Props = {
  items: TalkSidebarItemView[];
  loading: boolean;
  error: string | null;
  userRole: string;
  onCreateTalk: () => Promise<Talk>;
  onCreateFolder: () => Promise<TalkSidebarFolder>;
  onRenameTalk: (talkId: string, title: string) => void;
  onPatchTalk: (input: {
    talkId: string;
    title?: string;
    folderId?: string | null;
  }) => Promise<Talk | undefined>;
  onDeleteTalk: (talkId: string) => Promise<void>;
  onRenameFolder: (folderId: string, title: string) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onReorder: (input: {
    itemType: 'talk' | 'folder';
    itemId: string;
    destinationFolderId: string | null;
    destinationIndex: number;
  }) => Promise<void> | void;
  renameDraft: RenameDraft;
};

type MenuState =
  | {
      type: 'create';
    }
  | {
      type: 'talk';
      talkId: string;
      moveOpen: boolean;
    }
  | {
      type: 'folder';
      folderId: string;
    }
  | null;

type DndId =
  | { kind: 'talk'; talkId: string }
  | { kind: 'folder'; folderId: string }
  | { kind: 'folder-drop'; folderId: string }
  | { kind: 'root-drop' };

function encodeDndId(id: DndId): string {
  switch (id.kind) {
    case 'talk':
      return `talk:${id.talkId}`;
    case 'folder':
      return `folder:${id.folderId}`;
    case 'folder-drop':
      return `folder-drop:${id.folderId}`;
    case 'root-drop':
      return 'root-drop';
  }
}

function decodeDndId(value: string): DndId | null {
  if (value === 'root-drop') return { kind: 'root-drop' };
  if (value.startsWith('talk:'))
    return { kind: 'talk', talkId: value.slice(5) };
  if (value.startsWith('folder-drop:')) {
    return { kind: 'folder-drop', folderId: value.slice(12) };
  }
  if (value.startsWith('folder:')) {
    return { kind: 'folder', folderId: value.slice(7) };
  }
  return null;
}

function DraggableRow({
  draggableId,
  disabled,
  className,
  children,
}: {
  draggableId: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: draggableId,
      disabled,
    });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform ? CSS.Translate.toString(transform) : undefined,
      }}
      className={`${className || ''}${isDragging ? ' clawtalk-sidebar-row-dragging' : ''}`}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  );
}

function DropZone({
  id,
  active,
  children,
  className,
}: {
  id: string;
  active: boolean;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`${className || ''}${active && isOver ? ' clawtalk-sidebar-drop-target' : ''}`}
    >
      {children}
    </div>
  );
}

function buildMoveTargets(
  items: TalkSidebarItemView[],
): Array<{ id: string | null; label: string }> {
  return [
    { id: null, label: '(Top Level)' },
    ...items
      .filter((item): item is TalkSidebarFolder => item.type === 'folder')
      .map((folder) => ({
        id: folder.id,
        label: folder.title || 'Untitled folder',
      })),
  ];
}

export function ClawTalkSidebar({
  items,
  loading,
  error,
  userRole,
  onCreateTalk,
  onCreateFolder,
  onRenameTalk,
  onPatchTalk,
  onDeleteTalk,
  onRenameFolder,
  onDeleteFolder,
  onReorder,
  renameDraft,
}: Props): JSX.Element {
  const canManageAgents = userRole === 'owner' || userRole === 'admin';
  const [expandedFolderIds, setExpandedFolderIds] = useState<
    Record<string, boolean>
  >({});
  const [menuState, setMenuState] = useState<MenuState>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderDrafts, setFolderDrafts] = useState<Record<string, string>>({});
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const createMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const talkMenuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>(
    {},
  );
  const folderMenuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>(
    {},
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  useEffect(() => {
    setExpandedFolderIds((current) => {
      const next = { ...current };
      items.forEach((item) => {
        if (item.type === 'folder' && next[item.id] === undefined) {
          next[item.id] = true;
        }
      });
      return next;
    });
  }, [items]);

  useEffect(() => {
    if (!menuState) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuState(null);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [menuState]);

  useLayoutEffect(() => {
    if (!menuState) {
      setMenuPosition(null);
      return;
    }

    const getMenuAnchor = (): HTMLButtonElement | null => {
      if (menuState.type === 'create') return createMenuButtonRef.current;
      if (menuState.type === 'talk')
        return talkMenuButtonRefs.current[menuState.talkId] ?? null;
      return folderMenuButtonRefs.current[menuState.folderId] ?? null;
    };

    const updateMenuPosition = () => {
      const anchor = getMenuAnchor();
      const menu = menuRef.current;
      if (!anchor || !menu) return;

      const viewportPadding = 12;
      const offset = 6;
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const menuWidth = Math.min(
        Math.max(menuRect.width, 170),
        window.innerWidth - viewportPadding * 2,
      );
      const menuHeight = Math.max(menuRect.height, 0);
      const belowTop = anchorRect.bottom + offset;
      const belowSpace = window.innerHeight - belowTop - viewportPadding;
      const aboveSpace = anchorRect.top - offset - viewportPadding;
      const openAbove = belowSpace < menuHeight && aboveSpace > belowSpace;
      const maxHeight = Math.max(
        120,
        Math.floor(openAbove ? aboveSpace : belowSpace),
      );
      const left = Math.max(
        viewportPadding,
        Math.min(
          anchorRect.right - menuWidth,
          window.innerWidth - menuWidth - viewportPadding,
        ),
      );
      const top = openAbove
        ? Math.max(
            viewportPadding,
            anchorRect.top -
              offset -
              Math.min(menuHeight || maxHeight, maxHeight),
          )
        : Math.min(
            belowTop,
            window.innerHeight -
              viewportPadding -
              Math.min(menuHeight || maxHeight, maxHeight),
          );

      setMenuPosition({
        top: Math.round(top),
        left: Math.round(left),
        maxHeight,
      });
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [menuState]);

  const moveTargets = useMemo(() => buildMoveTargets(items), [items]);

  const renderMenu = (children: React.ReactNode) => {
    if (typeof document === 'undefined') return null;
    return createPortal(
      <div
        className="clawtalk-sidebar-menu clawtalk-sidebar-menu-portal"
        ref={menuRef}
        style={
          menuPosition
            ? {
                top: `${menuPosition.top}px`,
                left: `${menuPosition.left}px`,
                maxHeight: `${menuPosition.maxHeight}px`,
              }
            : { visibility: 'hidden' }
        }
      >
        {children}
      </div>,
      document.body,
    );
  };

  const handleCreateTalkClick = async () => {
    setMenuState(null);
    try {
      await onCreateTalk();
    } catch {
      // Parent handles refresh/error surfaces.
    }
  };

  const handleCreateFolderClick = async () => {
    setMenuState(null);
    try {
      const folder = await onCreateFolder();
      setExpandedFolderIds((current) => ({ ...current, [folder.id]: true }));
      setRenamingFolderId(folder.id);
      setFolderDrafts((current) => ({ ...current, [folder.id]: folder.title }));
    } catch {
      // Parent handles refresh/error surfaces.
    }
  };

  const commitFolderRename = async (folderId: string) => {
    const draft = (folderDrafts[folderId] || '').trim();
    await onRenameFolder(folderId, draft);
    setRenamingFolderId((current) => (current === folderId ? null : current));
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const active = decodeDndId(String(event.active.id));
    const over = event.over ? decodeDndId(String(event.over.id)) : null;
    if (!active || !over) return;

    if (active.kind === 'folder') {
      if (
        over.kind !== 'folder' &&
        over.kind !== 'talk' &&
        over.kind !== 'root-drop'
      )
        return;
      const destinationIndex =
        over.kind === 'root-drop'
          ? items.length
          : items.findIndex((item) =>
              over.kind === 'folder'
                ? item.type === 'folder' && item.id === over.folderId
                : item.type === 'talk' && item.id === over.talkId,
            );
      if (destinationIndex < 0) return;
      void onReorder({
        itemType: 'folder',
        itemId: active.folderId,
        destinationFolderId: null,
        destinationIndex,
      });
      return;
    }

    if (active.kind !== 'talk') return;

    if (over.kind === 'folder' || over.kind === 'folder-drop') {
      const folder = items.find(
        (item): item is TalkSidebarFolder =>
          item.type === 'folder' && item.id === over.folderId,
      );
      if (!folder) return;
      void onReorder({
        itemType: 'talk',
        itemId: active.talkId,
        destinationFolderId: folder.id,
        destinationIndex: folder.talks.length,
      });
      return;
    }

    if (over.kind === 'root-drop') {
      void onReorder({
        itemType: 'talk',
        itemId: active.talkId,
        destinationFolderId: null,
        destinationIndex: items.length,
      });
      return;
    }

    if (over.kind === 'talk') {
      let destinationFolderId: string | null = null;
      let destinationIndex = items.findIndex(
        (item) => item.type === 'talk' && item.id === over.talkId,
      );
      if (destinationIndex === -1) {
        for (const item of items) {
          if (item.type === 'folder') {
            const childIndex = item.talks.findIndex(
              (talk) => talk.id === over.talkId,
            );
            if (childIndex >= 0) {
              destinationFolderId = item.id;
              destinationIndex = childIndex;
              break;
            }
          }
        }
      }
      if (destinationIndex < 0) return;
      void onReorder({
        itemType: 'talk',
        itemId: active.talkId,
        destinationFolderId,
        destinationIndex,
      });
    }
  };

  const renderTalkRow = (talk: TalkSidebarTalkView, inFolder = false) => {
    const menuOpen = menuState?.type === 'talk' && menuState.talkId === talk.id;
    const renaming = renameDraft?.talkId === talk.id;
    const moveOpen = menuOpen && menuState.moveOpen;
    return (
      <DropZone
        key={talk.id}
        id={encodeDndId({ kind: 'talk', talkId: talk.id })}
        active={activeDragId !== null}
      >
        <DraggableRow
          draggableId={encodeDndId({ kind: 'talk', talkId: talk.id })}
        >
          <div
            className={`clawtalk-sidebar-tree-row clawtalk-sidebar-talk-row${inFolder ? ' clawtalk-sidebar-talk-row-nested' : ''}`}
          >
            <NavLink
              to={`/app/talks/${talk.id}`}
              className={({ isActive }) =>
                `clawtalk-sidebar-tree-link${isActive ? ' active' : ''}`
              }
            >
              <span className="clawtalk-sidebar-tree-link-inner">
                <span className="clawtalk-sidebar-tree-title-wrap">
                  {talk.isResponding ? (
                    <span
                      className="clawtalk-sidebar-activity-indicator"
                      aria-label="Response in progress"
                      title="Response in progress"
                    >
                      *
                    </span>
                  ) : null}
                  <span
                    className={`clawtalk-sidebar-tree-title${talk.isResponding ? ' clawtalk-sidebar-tree-title-responding' : ''}`}
                  >
                    {renaming
                      ? renameDraft.draft || 'Untitled talk'
                      : talk.title || 'Untitled talk'}
                  </span>
                </span>
                {talk.unreadCount && talk.unreadCount > 0 ? (
                  <span
                    className="clawtalk-sidebar-unread-badge"
                    aria-label={`${talk.unreadCount} unread messages`}
                    title={`${talk.unreadCount} unread messages`}
                  >
                    {talk.unreadCount}
                  </span>
                ) : null}
              </span>
            </NavLink>
            <div className="clawtalk-sidebar-tree-actions">
              <button
                type="button"
                className="clawtalk-sidebar-more"
                ref={(node) => {
                  talkMenuButtonRefs.current[talk.id] = node;
                }}
                aria-label={`Manage ${talk.title || 'Untitled talk'}`}
                onClick={() =>
                  setMenuState((current) =>
                    current?.type === 'talk' && current.talkId === talk.id
                      ? null
                      : { type: 'talk', talkId: talk.id, moveOpen: false },
                  )
                }
              >
                …
              </button>
              {menuOpen
                ? renderMenu(
                    <>
                      <button
                        type="button"
                        onClick={() => onRenameTalk(talk.id, talk.title)}
                      >
                        Rename Talk
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setMenuState({
                            type: 'talk',
                            talkId: talk.id,
                            moveOpen: !moveOpen,
                          })
                        }
                      >
                        Move To
                      </button>
                      {moveOpen ? (
                        <div className="clawtalk-sidebar-submenu">
                          {moveTargets.map((target) => (
                            <button
                              key={target.id || 'top-level'}
                              type="button"
                              onClick={async () => {
                                setMenuState(null);
                                await onPatchTalk({
                                  talkId: talk.id,
                                  folderId: target.id,
                                });
                              }}
                            >
                              {target.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className="danger"
                        onClick={async () => {
                          setMenuState(null);
                          await onDeleteTalk(talk.id);
                        }}
                      >
                        Delete Talk
                      </button>
                    </>,
                  )
                : null}
            </div>
          </div>
        </DraggableRow>
      </DropZone>
    );
  };

  const renderFolderRow = (folder: TalkSidebarFolder) => {
    const menuOpen =
      menuState?.type === 'folder' && menuState.folderId === folder.id;
    const expanded = expandedFolderIds[folder.id] !== false;
    const renaming = renamingFolderId === folder.id;
    const draft = folderDrafts[folder.id] ?? folder.title;

    return (
      <div key={folder.id} className="clawtalk-sidebar-folder-block">
        <DropZone
          id={encodeDndId({ kind: 'folder', folderId: folder.id })}
          active={activeDragId !== null}
        >
          <DraggableRow
            draggableId={encodeDndId({ kind: 'folder', folderId: folder.id })}
          >
            <div className="clawtalk-sidebar-tree-row clawtalk-sidebar-folder-row">
              <button
                type="button"
                className="clawtalk-sidebar-folder-toggle"
                onClick={() =>
                  setExpandedFolderIds((current) => ({
                    ...current,
                    [folder.id]: !expanded,
                  }))
                }
                aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
              >
                {expanded ? '▾' : '▸'}
              </button>
              {renaming ? (
                <form
                  className="clawtalk-sidebar-folder-form"
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    void commitFolderRename(folder.id);
                  }}
                >
                  <input
                    autoFocus
                    value={draft}
                    onChange={(event) =>
                      setFolderDrafts((current) => ({
                        ...current,
                        [folder.id]: event.target.value,
                      }))
                    }
                    onBlur={() => void commitFolderRename(folder.id)}
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === 'Escape') {
                        setRenamingFolderId(null);
                        setFolderDrafts((current) => ({
                          ...current,
                          [folder.id]: folder.title,
                        }));
                      }
                    }}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  className="clawtalk-sidebar-folder-label"
                  onClick={() =>
                    setExpandedFolderIds((current) => ({
                      ...current,
                      [folder.id]: !expanded,
                    }))
                  }
                >
                  {folder.title || 'Untitled folder'}
                </button>
              )}
              <div className="clawtalk-sidebar-tree-actions">
                <button
                  type="button"
                  className="clawtalk-sidebar-more"
                  ref={(node) => {
                    folderMenuButtonRefs.current[folder.id] = node;
                  }}
                  aria-label={`Manage ${folder.title || 'Untitled folder'}`}
                  onClick={() =>
                    setMenuState((current) =>
                      current?.type === 'folder' &&
                      current.folderId === folder.id
                        ? null
                        : { type: 'folder', folderId: folder.id },
                    )
                  }
                >
                  …
                </button>
                {menuOpen
                  ? renderMenu(
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setMenuState(null);
                            setRenamingFolderId(folder.id);
                            setFolderDrafts((current) => ({
                              ...current,
                              [folder.id]: folder.title,
                            }));
                          }}
                        >
                          Rename Folder
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={async () => {
                            setMenuState(null);
                            const confirmed = window.confirm(
                              `Delete "${folder.title || 'Untitled folder'}"? Its talks will be moved to Top Level.`,
                            );
                            if (!confirmed) return;
                            await onDeleteFolder(folder.id);
                          }}
                        >
                          Delete Folder
                        </button>
                      </>,
                    )
                  : null}
              </div>
            </div>
          </DraggableRow>
        </DropZone>

        {expanded ? (
          <DropZone
            id={encodeDndId({ kind: 'folder-drop', folderId: folder.id })}
            active={activeDragId !== null}
            className="clawtalk-sidebar-folder-talks"
          >
            {folder.talks.length === 0 ? (
              <p className="clawtalk-sidebar-folder-empty">Drop talks here</p>
            ) : (
              folder.talks.map((talk) => renderTalkRow(talk, true))
            )}
          </DropZone>
        ) : null}
      </div>
    );
  };

  return (
    <aside className="clawtalk-sidebar" aria-label="Primary navigation">
      <nav className="clawtalk-sidebar-nav" aria-label="App sections">
        <NavLink
          to="/app/talks"
          end
          className={({ isActive }) =>
            `clawtalk-sidebar-link${isActive ? ' active' : ''}`
          }
        >
          Home
        </NavLink>
        {canManageAgents ? (
          <NavLink
            to="/app/agents"
            className={({ isActive }) =>
              `clawtalk-sidebar-link${isActive ? ' active' : ''}`
            }
          >
            AI Agents
          </NavLink>
        ) : null}
        {canManageAgents ? (
          <NavLink
            to="/app/connectors"
            className={({ isActive }) =>
              `clawtalk-sidebar-link${isActive ? ' active' : ''}`
            }
          >
            Connectors
          </NavLink>
        ) : null}
      </nav>

      <div className="clawtalk-sidebar-section">
        <div className="clawtalk-sidebar-section-header">
          <div className="clawtalk-sidebar-section-label">Talks</div>
          <div className="clawtalk-sidebar-section-actions">
            <button
              type="button"
              className="clawtalk-sidebar-add"
              ref={createMenuButtonRef}
              aria-label="Create talk or folder"
              onClick={() =>
                setMenuState((current) =>
                  current?.type === 'create' ? null : { type: 'create' },
                )
              }
            >
              +
            </button>
            {menuState?.type === 'create'
              ? renderMenu(
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCreateTalkClick()}
                    >
                      New Talk
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCreateFolderClick()}
                    >
                      New Folder
                    </button>
                  </>,
                )
              : null}
          </div>
        </div>

        <NavLink
          to="/app/main"
          className={({ isActive }) =>
            `clawtalk-sidebar-link clawtalk-sidebar-link-main${isActive ? ' active' : ''}`
          }
        >
          Main (Nanoclaw)
        </NavLink>

        <div className="clawtalk-sidebar-talks" aria-label="Talk list">
          {loading ? (
            <p className="clawtalk-sidebar-empty">Loading talks…</p>
          ) : error ? (
            <p className="clawtalk-sidebar-empty">{error}</p>
          ) : items.length === 0 ? (
            <p className="clawtalk-sidebar-empty">
              No talks yet. Use + to create one.
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setActiveDragId(null)}
            >
              <DropZone
                id={encodeDndId({ kind: 'root-drop' })}
                active={activeDragId !== null}
              >
                <div className="clawtalk-sidebar-tree">
                  {items.map((item) =>
                    item.type === 'folder'
                      ? renderFolderRow(item)
                      : renderTalkRow(item),
                  )}
                </div>
              </DropZone>
            </DndContext>
          )}
        </div>
      </div>
    </aside>
  );
}
