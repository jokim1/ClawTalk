import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { ClawTalkSidebar } from './ClawTalkSidebar';
import type { Talk, TalkSidebarFolder, TalkSidebarItem } from '../lib/api';

function buildTalk(): Talk {
  return {
    id: 'talk-created',
    ownerId: 'owner-1',
    title: 'Created Talk',
    projectPath: null,
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
          loading={false}
          error={null}
          userRole="owner"
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
});
