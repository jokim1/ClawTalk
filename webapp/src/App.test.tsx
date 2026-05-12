import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

describe('App', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows sign-in and hides dev quick login when dev mode is disabled', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(401, {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Authentication is required',
          },
        }),
      ],
      '/api/v1/auth/refresh': [
        jsonResponse(401, {
          ok: false,
          error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: false },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'ClawRocket' });
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Developer Quick Login' }),
      ).toBeNull(),
    );
  });

  it('shows dev quick login when dev mode is enabled', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(401, {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Authentication is required',
          },
        }),
      ],
      '/api/v1/auth/refresh': [
        jsonResponse(401, {
          ok: false,
          error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: true },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'ClawRocket' });
    await screen.findByRole('heading', { name: 'Developer Quick Login' });
  });

  it('renders talks list when session is authenticated', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'talk-1',
                type: 'talk',
                title: 'Family Planning',
                status: 'active',
                sortOrder: 0,
              },
            ],
          },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'Talks' });
    expect(screen.getByText('ClawTalk')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute(
      'href',
      'https://clawtalk.app/help',
    );
    expect(
      screen.getByRole('button', { name: 'Collapse sidebar' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(
      screen.getAllByRole('link', { name: /Family Planning/i }),
    ).toHaveLength(2);
  });

  it('collapses and re-expands the sidebar from the top header', async () => {
    const user = userEvent.setup();
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [],
          },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    const collapseButton = await screen.findByRole('button', {
      name: 'Collapse sidebar',
    });
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();

    await user.click(collapseButton);

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Home' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    expect(
      await screen.findByRole('button', { name: 'Collapse sidebar' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
  });

  it('shows talk activity and unread badges in the sidebar', async () => {
    window.localStorage.setItem(
      'clawtalk.talkReadMarkers',
      JSON.stringify({
        'talk-1': {
          messageCount: 2,
          lastMessageAt: '2026-03-18T09:00:00.000Z',
        },
      }),
    );

    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'talk-1',
                type: 'talk',
                title: 'Family Planning',
                status: 'active',
                sortOrder: 0,
                lastMessageAt: '2026-03-18T10:00:00.000Z',
                messageCount: 5,
                hasActiveRun: true,
              },
            ],
          },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'Talks' });
    expect(screen.getByLabelText('Response in progress')).toBeTruthy();
    expect(screen.getByLabelText('3 unread messages')).toBeTruthy();
  });

  it('does not show unread badges when only the stored count is stale', async () => {
    window.localStorage.setItem(
      'clawtalk.talkReadMarkers',
      JSON.stringify({
        'talk-1': {
          messageCount: 2,
          lastMessageAt: '2026-03-18T10:00:00.000Z',
        },
      }),
    );

    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'talk-1',
                type: 'talk',
                title: 'Family Planning',
                status: 'active',
                sortOrder: 0,
                lastMessageAt: '2026-03-18T10:00:00.000Z',
                messageCount: 5,
                hasActiveRun: false,
              },
            ],
          },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'Talks' });
    expect(screen.queryByLabelText(/unread messages/i)).toBeNull();

    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem('clawtalk.talkReadMarkers') || '{}',
        ),
      ).toMatchObject({
        'talk-1': {
          messageCount: 5,
          lastMessageAt: '2026-03-18T10:00:00.000Z',
        },
      }),
    );
  });

  it('returns to sign-in when a later API call returns 401', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(401, {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Authentication is required',
          },
        }),
      ],
      '/api/v1/auth/refresh': [
        jsonResponse(401, {
          ok: false,
          error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: false },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'ClawRocket' })).toBeTruthy(),
    );
  });

  it('shows sign-in after clicking sign out from authenticated shell', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [],
          },
        }),
      ],
      '/api/v1/auth/logout': [
        jsonResponse(200, {
          ok: true,
          data: { loggedOut: true },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: false },
        }),
      ],
    });

    renderWithRouter('/app/talks');
    const avatarButton = await screen.findByRole('button', {
      name: 'Owner',
    });
    avatarButton.click();
    const logOutButton = await screen.findByRole('menuitem', {
      name: 'Log Out',
    });
    logOutButton.click();

    await screen.findByRole('heading', { name: 'ClawRocket' });
  });

  it('shows unavailable talk state for 404 detail fetch', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        }),
      ],
      '/api/v1/talks/sidebar': [
        jsonResponse(200, {
          ok: true,
          data: {
            items: [],
          },
        }),
      ],
      '/api/v1/talks/talk-missing': [
        jsonResponse(404, {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        }),
      ],
      '/api/v1/talks/talk-missing/messages': [
        jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-missing',
            messages: [],
            page: { limit: 100, count: 0, beforeCreatedAt: null },
          },
        }),
      ],
      '/api/v1/talks/talk-missing/threads': [
        jsonResponse(200, {
          ok: true,
          data: {
            threads: [],
          },
        }),
      ],
      '/api/v1/talks/talk-missing/agents': [
        jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-missing',
            agents: [],
          },
        }),
      ],
      '/api/v1/talks/talk-missing/runs': [
        jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-missing',
            runs: [],
            page: { limit: 50, count: 0, offset: 0 },
          },
        }),
      ],
    });

    renderWithRouter('/app/talks/talk-missing');
    await screen.findByRole('heading', { name: 'Talk Unavailable' });
  });
});

function renderWithRouter(initialEntry: string): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>,
  );
}

function mockFetchByPath(
  responsesByPath: Record<string, Response | Response[]>,
): void {
  const queues = new Map(
    Object.entries(responsesByPath).map(([path, responses]) => [
      path,
      Array.isArray(responses) ? [...responses] : [responses],
    ]),
  );

  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    const queue = queues.get(path);
    if (!queue || queue.length === 0) {
      throw new Error(`No mocked response left for fetch(${path})`);
    }
    return queue.shift()!;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
