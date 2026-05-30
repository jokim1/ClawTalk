// T-new-A: enqueueTalkChat dedupe — route-level tests.
// T-new-C: ensureTalkUsesUsableDefaultAgent route-boundary gating (bottom
// describe). Verifies the snapshot gate fires the expected number of times
// per route under §2.3 multiplicity, with no extra heal-path queries.
//
// Pin the input-validation paths (no DB), the 404 visibility-gated
// path (RLS, no row), the happy-path 202 (dedupe-relevant), and the
// @-mention routing (dedupe-relevant). Coverage diagram in
// docs/T-new-A-chat-handler-parallelize.md §4.4.
//
// CODE PATHS                                            USER FLOWS
// [+] enqueueTalkChat (talks.ts)
//   ├── input validation                                [+] Send chat message
//   │   ├── [★★★ Test 5] empty content → 400              ├── [★★ Test 1] happy path (1 agent, no @)
//   │   └── [★★★ Test 6] >20k content → 400               ├── [★★★ Test 2] @-mention routes to single agent
//   ├── getTalkForUser(talkId)                           ├── [★★★ Test 3] missing talk → 404
//   │   └── [★★ Tests 1, 2] talk returned                 └── [★★★ Test 4] visibility-gated edit check
//   ├── canEditTalkFromRecord(talk)
//   │   └── [★★★ Test 4] talk visible → allow             [+] Heal flow
//   ├── resolveTalkAgentMentionsFromList(list, content)   └── [★★★ Test 9] empty talk_agents heals on the spot
//   │   ├── [★★★ Test 2] @-mention picks targeted agent
//   │   └── (parity: agent-registry.test.ts Test 7)
//   └── ensureTalkUsesUsableDefaultAgent (untouched)
//       └── [★★★ Test 9] empty → heal write, then list sees it

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// T-new-C: same Proxy-wrap query counter strategy as agent-registry.test.ts.
// Wraps the tagged-template call boundary on getDbPg's return value so route
// tests can assert snapshot-call multiplicity under §2.3.
const mockState = vi.hoisted(() => {
  const queryLog: string[] = [];
  function wrapDb<T extends object>(realDb: T): T {
    return new Proxy(realDb as object, {
      apply(target, thisArg, args) {
        const first = args[0];
        if (Array.isArray(first)) {
          queryLog.push(first.join('?'));
        }
        return Reflect.apply(
          target as (...a: unknown[]) => unknown,
          thisArg,
          args,
        );
      },
    }) as T;
  }
  return { queryLog, wrapDb };
});

vi.mock('../../../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../db.js')>();
  return {
    ...actual,
    getDbPg: () => mockState.wrapDb(actual.getDbPg()),
  };
});

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../../db.js';
import { createTalk } from '../../db/accessors.js';
import { createRegisteredAgent } from '../../db/agent-accessors.js';
import { setTalkAgents, listTalkAgents } from '../../agents/agent-registry.js';
import {
  deleteSettingValue,
  getSettingValue,
  upsertSettingValue,
} from '../../db/accessors.js';
import {
  enqueueTalkChat,
  getTalkRoute,
  listTalkAgentsRoute,
  listTalksRoute,
} from './talks.js';
import type { AuthContext } from '../types.js';

// Snapshot SELECT signature unique to getTalkAgentsHealthSnapshot — used
// by the gating route tests to count gate-fires distinct from other reads.
const SNAPSHOT_SIGNATURE =
  'filter (where registered_agent_id is not null) as active_count';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c999999-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NONEXISTENT_TALK_ID = '00000000-0000-0000-0000-deadbeefcafe';

function makeAuth(): AuthContext {
  return {
    sessionId: 'test-session',
    userId: OWNER_ID,
    role: 'owner',
    authType: 'bearer',
  };
}

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where owner_id = ${OWNER_ID}::uuid`;
  await db`delete from public.registered_agents where owner_id = ${OWNER_ID}::uuid`;
}

describe('enqueueTalkChat — input validation (no DB)', () => {
  // Tests 5 and 6 hit the pre-withUserContext guards. The DB is never
  // touched on these paths, so they don't require initPgDatabase.

  it('Test 5: empty content (after trim) returns 400 message_required', async () => {
    const result = await enqueueTalkChat({
      talkId: NONEXISTENT_TALK_ID,
      auth: makeAuth(),
      content: '   ',
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'message_required' },
    });
  });

  it('Test 6: content > 20_000 chars returns 400 message_too_large', async () => {
    const bigContent = 'x'.repeat(20_001);
    const result = await enqueueTalkChat({
      talkId: NONEXISTENT_TALK_ID,
      auth: makeAuth(),
      content: bigContent,
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'message_too_large' },
    });
  });
});

describe('enqueueTalkChat — DB-backed paths', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
    await seedAuthUser(OWNER_ID, 'talks-route-test@clawtalk.test');
  });

  afterAll(async () => {
    await purge();
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('Test 3: unknown talkId returns 404 talk_not_found', async () => {
    const result = await enqueueTalkChat({
      talkId: NONEXISTENT_TALK_ID,
      auth: makeAuth(),
      content: 'hello',
    });
    expect(result.statusCode).toBe(404);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });
  });

  it('Test 4: invisible talk (cross-owner) returns 404 BEFORE edit check', async () => {
    // Per codex C3: current RLS returns 404 (not 403) for non-owner via
    // getTalkForUser. canEditTalkFromRecord is dead code for non-owner
    // today; this test documents the observed behavior.
    const otherUserId = '0c999999-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await seedAuthUser(otherUserId, 'other-owner@clawtalk.test');
    const otherTalkId = await withUserContext(otherUserId, async () => {
      const talk = await createTalk({
        ownerId: otherUserId,
        topicTitle: 'others talk',
      });
      return talk.id;
    });

    const result = await enqueueTalkChat({
      talkId: otherTalkId,
      auth: makeAuth(),
      content: 'hello',
    });
    expect(result.statusCode).toBe(404);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'talk_not_found' },
    });

    // Cleanup the other-owner row to keep neighboring tests deterministic.
    const db = getDbPg();
    await db`delete from public.talks where id = ${otherTalkId}::uuid`;
    await db`delete from auth.users where id = ${otherUserId}::uuid`;
  });

  it('Test 1: happy path — 1 agent, no @-mention → 202 with single run', async () => {
    const { talkId } = await seedHappyPath();
    const result = await enqueueTalkChat({
      talkId,
      auth: makeAuth(),
      content: 'hello there',
    });
    expect(result.statusCode).toBe(202);
    if (!result.body.ok) {
      throw new Error(
        `expected 202 ok body, got error: ${JSON.stringify(result.body)}`,
      );
    }
    expect(result.body.data.runs).toHaveLength(1);
    expect(result.body.data.talkId).toBe(talkId);
  });

  it('Test 2: @-mention routes to single agent (Beta only)', async () => {
    const { talkId, agentBetaId } = await seedHappyPath({
      withTwoAgents: true,
    });
    const result = await enqueueTalkChat({
      talkId,
      auth: makeAuth(),
      content: '@beta please weigh in',
    });
    expect(result.statusCode).toBe(202);
    if (!result.body.ok) {
      throw new Error(
        `expected 202 ok body, got error: ${JSON.stringify(result.body)}`,
      );
    }
    expect(result.body.data.runs).toHaveLength(1);
    expect(result.body.data.runs[0]!.targetAgentId).toBe(agentBetaId);
  });

  it('Test 9: zero talk_agents → heal-then-read writes default agent in one tx', async () => {
    // Seed only the default-agent setting + a healable registered agent +
    // a talk with no talk_agents rows. enqueueTalkChat must heal AND
    // route to the healed agent within a single withUserContext tx.
    //
    // system.defaultTalkAgentId is a global setting (per codex C-1 review
    // 2026-05-28): save the prior value and restore on exit so subsequent
    // tests / local dev don't see a stale pointer to a purged agent UUID.
    const SETTING_KEY = 'system.defaultTalkAgentId';
    const priorSettingValue = await getSettingValue(SETTING_KEY);

    try {
      const talkId = await withUserContext(OWNER_ID, async () => {
        const defaultAgent = await createRegisteredAgent({
          ownerId: OWNER_ID,
          name: 'DefaultHealAgent',
          providerId: 'provider.openai',
          modelId: 'gpt-5-mini',
        });
        await upsertSettingValue({
          key: SETTING_KEY,
          value: defaultAgent.id,
        });
        const talk = await createTalk({
          ownerId: OWNER_ID,
          topicTitle: 'heal test',
        });
        return talk.id;
      });

      // Pre-assert: no talk_agents rows yet.
      await withUserContext(OWNER_ID, async () => {
        const before = await listTalkAgents(talkId);
        expect(before).toHaveLength(0);
      });

      const result = await enqueueTalkChat({
        talkId,
        auth: makeAuth(),
        content: 'hello after heal',
      });
      expect(result.statusCode).toBe(202);
      if (!result.body.ok) {
        throw new Error(
          `expected 202 ok body, got error: ${JSON.stringify(result.body)}`,
        );
      }
      expect(result.body.data.runs).toHaveLength(1);

      // Post-assert: heal wrote the default agent into talk_agents.
      await withUserContext(OWNER_ID, async () => {
        const after = await listTalkAgents(talkId);
        expect(after).toHaveLength(1);
      });
    } finally {
      if (priorSettingValue === undefined) {
        await deleteSettingValue(SETTING_KEY);
      } else {
        await upsertSettingValue({
          key: SETTING_KEY,
          value: priorSettingValue,
        });
      }
    }
  });
});

// ── fixture helpers ──────────────────────────────────────────────────

async function seedHappyPath(opts?: { withTwoAgents?: boolean }): Promise<{
  talkId: string;
  agentAlphaId: string;
  agentBetaId: string;
}> {
  return await withUserContext(OWNER_ID, async () => {
    const agentAlpha = await createRegisteredAgent({
      ownerId: OWNER_ID,
      name: 'Alpha',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
    });
    const agentBeta = await createRegisteredAgent({
      ownerId: OWNER_ID,
      name: 'Beta',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
    });
    const talk = await createTalk({
      ownerId: OWNER_ID,
      topicTitle: 'happy path',
    });
    await setTalkAgents({
      talkId: talk.id,
      ownerId: OWNER_ID,
      agents: opts?.withTwoAgents
        ? [
            {
              id: agentAlpha.id,
              sourceKind: 'provider',
              providerId: 'provider.openai',
              modelId: 'gpt-5-mini',
              nickname: 'alpha',
              nicknameMode: 'custom',
              personaRole: 'assistant',
              isPrimary: true,
              sortOrder: 0,
            },
            {
              id: agentBeta.id,
              sourceKind: 'provider',
              providerId: 'provider.openai',
              modelId: 'gpt-5-mini',
              nickname: 'beta',
              nicknameMode: 'custom',
              personaRole: 'assistant',
              isPrimary: false,
              sortOrder: 1,
            },
          ]
        : [
            {
              id: agentAlpha.id,
              sourceKind: 'provider',
              providerId: 'provider.openai',
              modelId: 'gpt-5-mini',
              nickname: 'alpha',
              nicknameMode: 'custom',
              personaRole: 'assistant',
              isPrimary: true,
              sortOrder: 0,
            },
          ],
    });
    return {
      talkId: talk.id,
      agentAlphaId: agentAlpha.id,
      agentBetaId: agentBeta.id,
    };
  });
}

// ---------------------------------------------------------------------------
// T-new-C — route-boundary gating tests
// ---------------------------------------------------------------------------
//
// Each route exercise asserts:
//   1. response shape OK (no 500)
//   2. snapshot SELECT fires the §2.3-expected number of times
//   3. DB-state unchanged (no inserts/updates on talk_agents)
//
// (1)+(3) prove the route returns and writes nothing on a healthy talk;
// (2) proves the gate fired (snapshot SELECT count == ensureCall count)
// rather than the full 6-RT heal chain running per call.

async function seedHealthyTalk(opts?: {
  topicTitle?: string;
}): Promise<{ talkId: string; agentId: string }> {
  return withUserContext(OWNER_ID, async () => {
    const agent = await createRegisteredAgent({
      ownerId: OWNER_ID,
      name: `Healthy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
    });
    const talk = await createTalk({
      ownerId: OWNER_ID,
      topicTitle: opts?.topicTitle ?? 'gating route fixture',
    });
    await setTalkAgents({
      talkId: talk.id,
      ownerId: OWNER_ID,
      agents: [
        {
          id: agent.id,
          sourceKind: 'provider',
          providerId: 'provider.openai',
          modelId: 'gpt-5-mini',
          nickname: 'healthy',
          nicknameMode: 'custom',
          personaRole: 'assistant',
          isPrimary: true,
          sortOrder: 0,
        },
      ],
    });
    return { talkId: talk.id, agentId: agent.id };
  });
}

async function countTalkAgentMutations(talkIds: string[]): Promise<number> {
  // Detect inserts/updates/deletes via a simple post-condition: snapshot
  // talk_agents row state before+after the route call and compare. Caller
  // is responsible for picking matching points in time.
  // (Single-row helpers below use direct query equality instead.)
  if (talkIds.length === 0) return 0;
  const db = getDbPg();
  const rows = await db<{ count: string }[]>`
    select count(*)::text as count
    from public.talk_agents
    where talk_id = any(${talkIds}::uuid[])
  `;
  return Number(rows[0]?.count ?? 0);
}

async function snapshotTalkAgentRows(
  talkId: string,
): Promise<
  { isPrimary: boolean; registeredAgentId: string | null; sortOrder: number }[]
> {
  const db = getDbPg();
  const rows = await db<
    {
      is_primary: boolean;
      registered_agent_id: string | null;
      sort_order: number;
    }[]
  >`
    select is_primary, registered_agent_id, sort_order
    from public.talk_agents
    where talk_id = ${talkId}::uuid
    order by sort_order asc
  `;
  return rows.map((row) => ({
    isPrimary: row.is_primary,
    registeredAgentId: row.registered_agent_id,
    sortOrder: row.sort_order,
  }));
}

describe('ensureTalkUsesUsableDefaultAgent route gating (T-new-C)', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
    await seedAuthUser(OWNER_ID, 'talks-route-test@clawtalk.test');
  });

  afterAll(async () => {
    await purge();
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
    mockState.queryLog.length = 0;
  });

  it('sendChatRoute: healthy talk → 1 snapshot fire, no writes', async () => {
    const { talkId } = await seedHealthyTalk();
    const before = await snapshotTalkAgentRows(talkId);
    mockState.queryLog.length = 0;

    const result = await enqueueTalkChat({
      talkId,
      auth: makeAuth(),
      content: 'gating happy path',
    });

    expect(result.statusCode).toBe(202);
    const snapshotFires = mockState.queryLog.filter((q) =>
      q.includes(SNAPSHOT_SIGNATURE),
    );
    expect(snapshotFires).toHaveLength(1);

    const after = await snapshotTalkAgentRows(talkId);
    expect(after).toEqual(before);
  });

  it('getTalkRoute: healthy talk → 2 snapshot fires (direct + toTalkApiRecord), no writes', async () => {
    const { talkId } = await seedHealthyTalk();
    const before = await snapshotTalkAgentRows(talkId);
    mockState.queryLog.length = 0;

    const result = await getTalkRoute({ talkId, auth: makeAuth() });

    expect(result.statusCode).toBe(200);
    if (!result.body.ok) {
      throw new Error(
        `expected 200 ok body, got: ${JSON.stringify(result.body)}`,
      );
    }
    expect(result.body.data.talk.id).toBe(talkId);

    const snapshotFires = mockState.queryLog.filter((q) =>
      q.includes(SNAPSHOT_SIGNATURE),
    );
    expect(snapshotFires).toHaveLength(2);

    const after = await snapshotTalkAgentRows(talkId);
    expect(after).toEqual(before);
  });

  it('listTalkAgentsRoute: healthy talk → 2 snapshot fires (direct + listEffectiveTalkAgents), no writes', async () => {
    const { talkId } = await seedHealthyTalk();
    const before = await snapshotTalkAgentRows(talkId);
    mockState.queryLog.length = 0;

    const result = await listTalkAgentsRoute({ talkId, auth: makeAuth() });

    expect(result.statusCode).toBe(200);
    if (!result.body.ok) {
      throw new Error(
        `expected 200 ok body, got: ${JSON.stringify(result.body)}`,
      );
    }
    expect(result.body.data.talkId).toBe(talkId);
    expect(result.body.data.agents.length).toBeGreaterThanOrEqual(1);

    const snapshotFires = mockState.queryLog.filter((q) =>
      q.includes(SNAPSHOT_SIGNATURE),
    );
    expect(snapshotFires).toHaveLength(2);

    const after = await snapshotTalkAgentRows(talkId);
    expect(after).toEqual(before);
  });

  it('listTalksRoute: N=3 healthy talks → 3 snapshot fires (one per toTalkApiRecord), no writes', async () => {
    const t1 = await seedHealthyTalk({ topicTitle: 'gating list 1' });
    const t2 = await seedHealthyTalk({ topicTitle: 'gating list 2' });
    const t3 = await seedHealthyTalk({ topicTitle: 'gating list 3' });
    const beforeCount = await countTalkAgentMutations([
      t1.talkId,
      t2.talkId,
      t3.talkId,
    ]);
    mockState.queryLog.length = 0;

    const result = await listTalksRoute({ auth: makeAuth(), limit: 10 });

    expect(result.statusCode).toBe(200);
    if (!result.body.ok) {
      throw new Error(
        `expected 200 ok body, got: ${JSON.stringify(result.body)}`,
      );
    }
    // Our 3 talks should be in the list; other tests in the file may have
    // left talks under OWNER_ID — assert the count is at least 3.
    expect(result.body.data.talks.length).toBeGreaterThanOrEqual(3);

    const snapshotFires = mockState.queryLog.filter((q) =>
      q.includes(SNAPSHOT_SIGNATURE),
    );
    // listTalksRoute calls toTalkApiRecord per talk in the list — N
    // snapshot fires, where N is the number of talks under OWNER_ID. We
    // seeded exactly 3 this test (purge runs in beforeEach), so N == 3.
    expect(snapshotFires).toHaveLength(3);

    const afterCount = await countTalkAgentMutations([
      t1.talkId,
      t2.talkId,
      t3.talkId,
    ]);
    expect(afterCount).toBe(beforeCount);
  });
});
