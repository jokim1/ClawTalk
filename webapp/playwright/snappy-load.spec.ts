import { test, expect, type Page, type Route } from '@playwright/test';

// Minimal Playwright regression rig for the PR A-D talk-load refactor.
//
// Two regressions guarded here:
//   1. Warmed IDB cache renders the snapshot without firing a network
//      fetch on cold load (TanStack Query persister + per-user
//      queryKey + 5min staleTime).
//   2. The thread-show effect calls scrollToBottom exactly once on
//      first paint — not 2-3 times like the pre-PR-D cascade.
//
// All backend endpoints are intercepted via page.route so the suite is
// self-contained (no Worker / Supabase needed). The WebSocket connection
// is allowed to fail — the SPA logs an error but proceeds with the
// snapshot already in hand.

const TALK_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const FIRST_MESSAGE = 'hello from the snapshot fixture';

type Counters = { snapshotHits: number };

function buildSnapshot() {
  const now = '2026-05-27T00:00:00.000Z';
  return {
    talk: {
      id: TALK_ID,
      ownerId: USER_ID,
      folderId: null,
      sortOrder: 0,
      title: 'Snappy-load fixture',
      orchestrationMode: 'ordered' as const,
      status: 'active' as const,
      version: 1,
      createdAt: now,
      updatedAt: now,
      accessRole: 'owner' as const,
    },
    threads: [
      {
        id: THREAD_ID,
        talkId: TALK_ID,
        title: 'Main',
        isDefault: true,
        isInternal: false,
        isPinned: false,
        createdAt: now,
        updatedAt: now,
        messageCount: 1,
        lastMessageAt: now,
      },
    ],
    activeThreadId: THREAD_ID,
    messages: [
      {
        id: '44444444-4444-4444-4444-444444444444',
        threadId: THREAD_ID,
        role: 'assistant' as const,
        content: FIRST_MESSAGE,
        createdBy: null,
        createdAt: now,
        runId: null,
        agentId: null,
        agentNickname: 'Fixture',
        metadata: null,
        attachments: [],
      },
    ],
    hasOlderMessages: false,
    content: null,
    pendingEdits: [],
    runs: [],
    agents: [],
    snapshotVersion: 1,
  };
}

function buildSession() {
  return {
    user: {
      id: USER_ID,
      email: 'playwright@clawtalk.test',
      displayName: 'Playwright',
      role: 'owner',
      createdAt: '2026-05-27T00:00:00.000Z',
    },
  };
}

async function fulfillJson(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, data }),
  });
}

async function installApiMocks(page: Page, counters: Counters): Promise<void> {
  // Playwright dispatches matching routes in LIFO order — register the
  // catch-all first so the specific handlers below win when both match.
  await page.route('**/api/v1/**', (route) => fulfillJson(route, {}));
  await page.route('**/api/v1/session/me', (route) =>
    fulfillJson(route, buildSession()),
  );
  await page.route('**/api/v1/auth/config', (route) =>
    fulfillJson(route, { providers: { google: { enabled: false } } }),
  );
  await page.route('**/api/v1/talks/sidebar', (route) =>
    fulfillJson(route, { items: [], mainTalkId: TALK_ID, contents: [] }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/snapshot*`, (route) => {
    counters.snapshotHits += 1;
    return fulfillJson(route, buildSnapshot());
  });
  await page.route(`**/api/v1/talks/${TALK_ID}/runs`, (route) =>
    fulfillJson(route, { runs: [] }),
  );
  await page.route(`**/api/v1/talks/${TALK_ID}/agents`, (route) =>
    fulfillJson(route, { agents: [] }),
  );
  await page.route('**/api/v1/agents', (route) =>
    fulfillJson(route, {
      defaultClaudeModelId: '',
      claudeModelSuggestions: [],
      additionalProviders: [],
    }),
  );
  await page.route('**/api/v1/registered-agents', (route) =>
    fulfillJson(route, []),
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (
      window as unknown as { __clawtalkScrollToBottomCount?: number }
    ).__clawtalkScrollToBottomCount = 0;
  });
});

test('cached snapshot renders before network fires', async ({ page }) => {
  const counters: Counters = { snapshotHits: 0 };
  await installApiMocks(page, counters);

  // First visit warms the IDB persister.
  await page.goto(`/app/talks/${TALK_ID}?thread=${THREAD_ID}`);
  await expect(page.getByText(FIRST_MESSAGE)).toBeVisible();
  expect(counters.snapshotHits).toBe(1);

  // PersistQueryClientProvider throttles writes to IDB (default ~1s);
  // wait for the persisted snapshot to actually land so the reload has
  // something to hydrate from. Polls indexedDB instead of sleeping a
  // fixed budget so we exit as soon as the cache is durable.
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open('keyval-store');
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('keyval')) {
            db.close();
            resolve(false);
            return;
          }
          const tx = db.transaction('keyval', 'readonly');
          const store = tx.objectStore('keyval');
          const getReq = store.get('clawtalk.tanstack-query.v1');
          getReq.onsuccess = () => {
            db.close();
            resolve(getReq.result !== undefined);
          };
          getReq.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      }),
    null,
    { timeout: 5_000 },
  );

  // Second visit must render from the persisted cache without firing
  // the snapshot fetch (within staleTime).
  counters.snapshotHits = 0;
  await page.reload();
  await expect(page.getByText(FIRST_MESSAGE)).toBeVisible();
  expect(counters.snapshotHits).toBe(0);
});

test('scrollToBottom fires exactly once per thread show', async ({ page }) => {
  const counters: Counters = { snapshotHits: 0 };
  await installApiMocks(page, counters);

  await page.goto(`/app/talks/${TALK_ID}?thread=${THREAD_ID}`);
  await expect(page.getByText(FIRST_MESSAGE)).toBeVisible();

  // Let the post-mount effect chain settle (autoStickToBottom is a
  // separate effect that fires on liveResponsesByRunId / message-length
  // change; we want to assert it does NOT fire spuriously after the
  // single initial scroll).
  await page.waitForTimeout(400);

  const coldCount = await page.evaluate(
    () =>
      (window as unknown as { __clawtalkScrollToBottomCount?: number })
        .__clawtalkScrollToBottomCount ?? -1,
  );
  expect(coldCount).toBe(1);

  // Warm-cache reload exercises the path where the snapshot is in cache
  // on first render — pageKind goes straight to 'ready' and the
  // thread-show effect's gate passes on the mount render. React
  // StrictMode in dev runs mount effects twice; without rAF cleanup
  // this scrolls twice and the count goes to 2.
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open('keyval-store');
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('keyval')) {
            db.close();
            resolve(false);
            return;
          }
          const tx = db.transaction('keyval', 'readonly');
          const store = tx.objectStore('keyval');
          const getReq = store.get('clawtalk.tanstack-query.v1');
          getReq.onsuccess = () => {
            db.close();
            resolve(getReq.result !== undefined);
          };
          getReq.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      }),
    null,
    { timeout: 5_000 },
  );
  await page.reload();
  await expect(page.getByText(FIRST_MESSAGE)).toBeVisible();
  await page.waitForTimeout(400);
  const warmCount = await page.evaluate(
    () =>
      (window as unknown as { __clawtalkScrollToBottomCount?: number })
        .__clawtalkScrollToBottomCount ?? -1,
  );
  expect(warmCount).toBe(1);
});
