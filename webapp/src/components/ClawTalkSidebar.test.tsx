import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { ClawTalkSidebar } from './ClawTalkSidebar';
import type {
  ContentSidebarItem,
  SessionUser,
  Talk,
  TalkSidebarFolder,
  TalkSidebarItem,
} from '../lib/api';

function buildUser(): SessionUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    displayName: 'Owner Example',
    role: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function buildTalk(): Talk {
  return {
    id: 'talk-created',
    ownerId: 'owner-1',
    title: 'Created Talk',
    orchestrationMode: 'ordered',
    agents: [],
    status: 'active',
    folderId: null,
    sortOrder: 0,
    version: 1,
    createdAt: '2026-03-09T00:00:00.000Z',
    updatedAt: '2026-03-09T00:00:00.000Z',
    accessRole: 'owner',
  };
}

function buildFolder(): TalkSidebarFolder {
  return {
    type: 'folder',
    id: 'folder-created',
    title: 'Created Folder',
    sortOrder: 0,
    talks: [],
  };
}

function rect(input: Partial<DOMRect> = {}): DOMRect {
  return {
    x: input.left ?? 0,
    y: input.top ?? 0,
    top: input.top ?? 0,
    left: input.left ?? 0,
    right: input.right ?? 0,
    bottom: input.bottom ?? 0,
    width: input.width ?? 0,
    height: input.height ?? 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('ClawTalkSidebar', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders menus in a portal and repositions them above the trigger when needed', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const element = this;
      if (element.getAttribute('aria-label') === 'Manage D1 Retro') {
        return rect({
          top: 560,
          bottom: 592,
          left: 230,
          right: 262,
          width: 32,
          height: 32,
        });
      }
      if (element.classList.contains('clawtalk-sidebar-menu-portal')) {
        return rect({
          top: 0,
          bottom: 180,
          left: 0,
          right: 170,
          width: 170,
          height: 180,
        });
      }
      return rect({ width: 100, height: 32, right: 100, bottom: 32 });
    });

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 640,
    });

    const items: TalkSidebarItem[] = [
      {
        type: 'talk',
        id: 'talk-1',
        title: 'D1 Retro',
        status: 'active',
        sortOrder: 0,
      },
    ];

    render(
      <MemoryRouter>
        <ClawTalkSidebar
          items={items}
          contents={[]}
          loading={false}
          error={null}
          user={buildUser()}
          mainTalkId={null}
          onSignOut={vi.fn()}
          signOutBusy={false}
          onCreateTalk={vi.fn(async () => buildTalk())}
          onCreateFolder={vi.fn(async () => buildFolder())}
          onRenameTalk={vi.fn()}
          onPatchTalk={vi.fn(async () => undefined)}
          onDeleteTalk={vi.fn(async () => undefined)}
          onRenameFolder={vi.fn(async () => undefined)}
          onDeleteFolder={vi.fn(async () => undefined)}
          onReorder={vi.fn()}
          renameDraft={null}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Manage D1 Retro' }));

    await waitFor(() => {
      const menu = document.body.querySelector('.clawtalk-sidebar-menu-portal');
      expect(menu).toBeTruthy();
      expect(menu).toHaveStyle({
        top: '374px',
        left: '92px',
        maxHeight: '542px',
      });
    });

    expect(screen.getByRole('button', { name: 'Rename Talk' })).toBeTruthy();
  });

  it('renders the Content section with empty-state hint when no documents exist', () => {
    const items: TalkSidebarItem[] = [
      {
        type: 'talk',
        id: 'talk-1',
        title: 'Untitled',
        status: 'active',
        sortOrder: 0,
      },
    ];

    render(
      <MemoryRouter>
        <ClawTalkSidebar
          items={items}
          contents={[]}
          loading={false}
          error={null}
          user={buildUser()}
          mainTalkId={null}
          onSignOut={vi.fn()}
          signOutBusy={false}
          onCreateTalk={vi.fn(async () => buildTalk())}
          onCreateFolder={vi.fn(async () => buildFolder())}
          onRenameTalk={vi.fn()}
          onPatchTalk={vi.fn(async () => undefined)}
          onDeleteTalk={vi.fn(async () => undefined)}
          onRenameFolder={vi.fn(async () => undefined)}
          onDeleteFolder={vi.fn(async () => undefined)}
          onReorder={vi.fn()}
          renameDraft={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Content')).toBeTruthy();
    expect(
      screen.getByText('Promote a Talk to start creating documents.'),
    ).toBeTruthy();
  });

  it('renders Content rows in given order and links to ?doc=1', () => {
    const items: TalkSidebarItem[] = [
      {
        type: 'talk',
        id: 'talk-with-doc',
        title: 'Talk with doc',
        status: 'active',
        sortOrder: 0,
        hasContent: true,
      },
    ];
    const contents: ContentSidebarItem[] = [
      {
        id: 'content-1',
        talkId: 'talk-with-doc',
        title: 'Most recent doc',
        updatedAt: '2026-05-24T10:00:00.000Z',
      },
      {
        id: 'content-2',
        talkId: 'talk-other',
        title: 'Older doc',
        updatedAt: '2026-05-20T10:00:00.000Z',
      },
    ];

    render(
      <MemoryRouter>
        <ClawTalkSidebar
          items={items}
          contents={contents}
          loading={false}
          error={null}
          user={buildUser()}
          mainTalkId={null}
          onSignOut={vi.fn()}
          signOutBusy={false}
          onCreateTalk={vi.fn(async () => buildTalk())}
          onCreateFolder={vi.fn(async () => buildFolder())}
          onRenameTalk={vi.fn()}
          onPatchTalk={vi.fn(async () => undefined)}
          onDeleteTalk={vi.fn(async () => undefined)}
          onRenameFolder={vi.fn(async () => undefined)}
          onDeleteFolder={vi.fn(async () => undefined)}
          onReorder={vi.fn()}
          renameDraft={null}
        />
      </MemoryRouter>,
    );

    const docList = screen.getByLabelText('Content documents');
    const links = docList.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe(
      '/app/talks/talk-with-doc?doc=1',
    );
    expect(links[0].textContent).toContain('Most recent doc');
    expect(links[1].getAttribute('href')).toBe('/app/talks/talk-other?doc=1');

    expect(screen.getByLabelText('Has document')).toBeTruthy();
  });
});
