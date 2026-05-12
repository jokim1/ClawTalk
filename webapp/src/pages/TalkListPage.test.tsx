import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { TalkListPage } from './TalkListPage';
import type { TalkSidebarItem } from '../lib/api';

describe('TalkListPage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows empty-state guidance when the sidebar tree has no talks', () => {
    renderWithRouter([]);

    expect(screen.getByText('No talks yet. Create one from the sidebar.')).toBeTruthy();
    expect(
      screen.getByText((content) => content.includes('Use the blue') && content.includes('button in the sidebar')),
    ).toBeTruthy();
  });

  it('renders talks from both top level and folders', async () => {
    renderWithRouter([
      {
        type: 'talk',
        id: 'talk-1',
        title: 'Smoke Talk',
        status: 'active',
        sortOrder: 0,
      },
      {
        type: 'folder',
        id: 'folder-1',
        title: 'Research',
        sortOrder: 1,
        talks: [
          {
            type: 'talk',
            id: 'talk-2',
            title: 'Nested Talk',
            status: 'active',
            sortOrder: 0,
          },
        ],
      },
    ]);

    expect(await screen.findByRole('link', { name: /Smoke Talk/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Nested Talk/i })).toBeTruthy();
  });
});

function renderWithRouter(items: TalkSidebarItem[]): void {
  render(
    <MemoryRouter>
      <TalkListPage externalData={{ items, loading: false, error: null }} />
    </MemoryRouter>,
  );
}
