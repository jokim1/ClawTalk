// T-new-A: resolveTalkAgentMentionsFromList parity + behavior.
// T-new-C: ensureTalkUsesUsableDefaultAgent gating behavior (bottom describe).
//
// The Option A dedupe in enqueueTalkChat replaces a re-read of
// talk_agents with a pure-function call against the already-loaded
// list. These tests pin:
//   - the pure mention-resolution logic (FromList, no DB)
//   - parity between FromList and the IO-wrapper resolveTalkAgentMentions
//     across content fixtures, against real DB state. Parity is
//     structurally guaranteed by the refactor (the wrapper now calls
//     the pure variant), but the test guards future drift.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// T-new-C: queryLog + Proxy wrapper installed at module load via vi.hoisted
// so vi.mock factories can reference it. The wrap intercepts the
// tagged-template call boundary (`db\`select ...\``) but not method calls
// (`db.begin(...)`), so withUserContext's tx open/commit aren't counted.
const mockState = vi.hoisted(() => {
  const queryLog: string[] = [];
  let snapshotShouldThrow = false;
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
  return {
    queryLog,
    wrapDb,
    setSnapshotShouldThrow(value: boolean): void {
      snapshotShouldThrow = value;
    },
    getSnapshotShouldThrow(): boolean {
      return snapshotShouldThrow;
    },
  };
});

vi.mock('../../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db.js')>();
  return {
    ...actual,
    getDbPg: () => mockState.wrapDb(actual.getDbPg()),
  };
});

vi.mock('../db/talk-agents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/talk-agents.js')>();
  return {
    ...actual,
    getTalkAgentsHealthSnapshot: async (talkId: string) => {
      if (mockState.getSnapshotShouldThrow()) {
        throw new Error('forced snapshot error (test fixture)');
      }
      return actual.getTalkAgentsHealthSnapshot(talkId);
    },
  };
});

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { createTalk } from '../db/accessors.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import type { TalkAgentAssignment } from '../db/talk-agents.js';
import {
  ensureTalkUsesUsableDefaultAgent,
  listTalkAgents,
  resolveTalkAgentMentions,
  resolveTalkAgentMentionsFromList,
  setTalkAgents,
} from './agent-registry.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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

function makeAssignment(
  agentId: string,
  agentName: string,
  nickname: string,
  isPrimary = false,
  sortOrder = 0,
): TalkAgentAssignment {
  return {
    assignmentId: `assign-${agentId}`,
    agentId,
    agentName,
    nickname,
    personaRole: 'assistant',
    isPrimary,
    sortOrder,
  };
}

describe('resolveTalkAgentMentionsFromList (pure)', () => {
  const alice = makeAssignment('aaaa', 'Alice', 'alice', true, 0);
  const bob = makeAssignment('bbbb', 'Bob', 'bob', false, 1);
  const carolWithNick = makeAssignment(
    'cccc',
    'Carol Engineer',
    'car',
    false,
    2,
  );

  it('no mention tokens → empty array', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob],
      'hello world',
    );
    expect(result).toEqual([]);
  });

  it('empty talk_agents list → empty array', () => {
    const result = resolveTalkAgentMentionsFromList([], '@alice hi');
    expect(result).toEqual([]);
  });

  it('single mention by nickname → returns that agent', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob],
      '@bob can you help',
    );
    expect(result.map((a) => a.agentId)).toEqual(['bbbb']);
  });

  it('multiple distinct mentions → returns both agents', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob],
      '@alice and @bob lets talk',
    );
    expect(result.map((a) => a.agentId).sort()).toEqual(['aaaa', 'bbbb']);
  });

  it('mention matching nickname-short-form resolves correctly', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob, carolWithNick],
      '@car please draft this',
    );
    expect(result.map((a) => a.agentId)).toEqual(['cccc']);
  });

  it('unknown mention with no alias match → empty array (fallback)', () => {
    const result = resolveTalkAgentMentionsFromList(
      [alice, bob],
      '@zoe are you here',
    );
    expect(result).toEqual([]);
  });
});

describe('resolveTalkAgentMentionsFromList ↔ resolveTalkAgentMentions parity', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
    await seedAuthUser(OWNER_ID, 'agent-registry-test@clawtalk.test');
  });

  afterAll(async () => {
    await purge();
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('produces identical output across 5 content fixtures', async () => {
    await withUserContext(OWNER_ID, async () => {
      const agentA = await createRegisteredAgent({
        ownerId: OWNER_ID,
        name: 'Alpha',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });
      const agentB = await createRegisteredAgent({
        ownerId: OWNER_ID,
        name: 'Beta',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });

      const talk = await createTalk({
        ownerId: OWNER_ID,
        topicTitle: 'parity test',
      });

      await setTalkAgents({
        talkId: talk.id,
        ownerId: OWNER_ID,
        agents: [
          {
            id: agentA.id,
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
            id: agentB.id,
            sourceKind: 'provider',
            providerId: 'provider.openai',
            modelId: 'gpt-5-mini',
            nickname: 'beta',
            nicknameMode: 'custom',
            personaRole: 'assistant',
            isPrimary: false,
            sortOrder: 1,
          },
        ],
      });

      const fixtures = [
        'no mentions here at all',
        '@alpha please summarize',
        '@alpha and @beta both weigh in',
        'hey @Beta thoughts?',
        '@unknown should fall back',
      ];

      const loadedList = await listTalkAgents(talk.id);
      for (const content of fixtures) {
        const fromIO = await resolveTalkAgentMentions(talk.id, content);
        const fromList = resolveTalkAgentMentionsFromList(loadedList, content);
        // Order may differ in fallback paths; compare agentId sets.
        const ioIds = fromIO.map((a) => a.agentId).sort();
        const listIds = fromList.map((a) => a.agentId).sort();
        expect(listIds).toEqual(ioIds);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// T-new-C — ensureTalkUsesUsableDefaultAgent gating
// ---------------------------------------------------------------------------

const GATING_PROVIDER_ID = 'test.gating-provider';
const GATING_MODEL_ID = 'test.gating-model';

async function seedGatingProvider(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.llm_providers
      (id, name, provider_kind, api_format, base_url, auth_scheme)
    values (${GATING_PROVIDER_ID}, 'T-new-C gating', 'custom',
            'openai_chat_completions', 'mock://gating', 'bearer')
    on conflict (id) do nothing
  `;
  await db`
    insert into public.llm_provider_models
      (provider_id, model_id, display_name, context_window_tokens,
       default_max_output_tokens)
    values (${GATING_PROVIDER_ID}, ${GATING_MODEL_ID}, 'Gating Model',
            32000, 2048)
    on conflict (provider_id, model_id) do nothing
  `;
}

async function purgeGating(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where owner_id = ${OWNER_ID}::uuid`;
  await db`
    delete from public.registered_agents where owner_id = ${OWNER_ID}::uuid
  `;
  await db`
    delete from public.settings_kv
    where key in ('system.defaultTalkAgentId', 'system.mainAgentId')
  `;
}

async function insertRawTalkAgent(input: {
  talkId: string;
  registeredAgentId: string | null;
  isPrimary: boolean;
  sortOrder: number;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_agents
      (talk_id, owner_id, registered_agent_id, source_kind, provider_id,
       model_id, is_primary, sort_order)
    values (${input.talkId}::uuid, ${OWNER_ID}::uuid,
            ${input.registeredAgentId}::uuid, 'provider',
            ${GATING_PROVIDER_ID}, ${GATING_MODEL_ID},
            ${input.isPrimary}, ${input.sortOrder})
  `;
}

async function getTalkAgentSummary(
  talkId: string,
): Promise<{ isPrimary: boolean; registeredAgentId: string | null }[]> {
  const db = getDbPg();
  const rows = await db<
    { is_primary: boolean; registered_agent_id: string | null }[]
  >`
    select is_primary, registered_agent_id
    from public.talk_agents
    where talk_id = ${talkId}::uuid
    order by sort_order asc
  `;
  return rows.map((row) => ({
    isPrimary: row.is_primary,
    registeredAgentId: row.registered_agent_id,
  }));
}

async function setupTalkWithAgents(): Promise<{
  talkId: string;
  agentAId: string;
  agentBId: string;
}> {
  return withUserContext(OWNER_ID, async () => {
    const talk = await createTalk({
      ownerId: OWNER_ID,
      topicTitle: 'gating fixture',
    });
    const agentA = await createRegisteredAgent({
      ownerId: OWNER_ID,
      name: 'GateAlpha',
      providerId: GATING_PROVIDER_ID,
      modelId: GATING_MODEL_ID,
    });
    const agentB = await createRegisteredAgent({
      ownerId: OWNER_ID,
      name: 'GateBeta',
      providerId: GATING_PROVIDER_ID,
      modelId: GATING_MODEL_ID,
    });
    return { talkId: talk.id, agentAId: agentA.id, agentBId: agentB.id };
  });
}

// Heal path depends on getDefaultTalkAgentId() returning a usable agent.
// Without a configured system.defaultTalkAgentId + system.mainAgentId, it
// throws and the heal returns early, leaving prune unfired. Configure the
// default to the seeded agentA so the heal path can run end-to-end.
async function configureDefaultAgent(agentId: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.settings_kv (key, value)
    values ('system.defaultTalkAgentId', ${agentId})
    on conflict (key) do update set value = excluded.value
  `;
}

describe('ensureTalkUsesUsableDefaultAgent gating (T-new-C)', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
    await seedAuthUser(OWNER_ID, 'agent-registry-test@clawtalk.test');
    await seedGatingProvider();
  });

  afterAll(async () => {
    const db = getDbPg();
    await purgeGating();
    await db`
      delete from public.llm_provider_models
      where provider_id = ${GATING_PROVIDER_ID}
    `;
    await db`
      delete from public.llm_providers where id = ${GATING_PROVIDER_ID}
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purgeGating();
    mockState.queryLog.length = 0;
    mockState.setSnapshotShouldThrow(false);
  });

  it('healthy gate hit: 1 active primary + 0 orphans → snapshot only, no heal-path reads/writes', async () => {
    const { talkId, agentAId } = await setupTalkWithAgents();
    await insertRawTalkAgent({
      talkId,
      registeredAgentId: agentAId,
      isPrimary: true,
      sortOrder: 0,
    });

    const beforeState = await getTalkAgentSummary(talkId);
    mockState.queryLog.length = 0;

    await withUserContext(OWNER_ID, () =>
      ensureTalkUsesUsableDefaultAgent(talkId, OWNER_ID),
    );

    // Exactly one read against talk_agents (the snapshot SELECT).
    const talkAgentsQueries = mockState.queryLog.filter((q) =>
      q.includes('talk_agents'),
    );
    expect(talkAgentsQueries).toHaveLength(1);
    expect(talkAgentsQueries[0]).toMatch(/filter \(where registered_agent_id/);

    // Heal path didn't run: no settings_kv read, no registered_agents read.
    expect(
      mockState.queryLog.filter((q) => q.includes('settings_kv')),
    ).toHaveLength(0);
    expect(
      mockState.queryLog.filter((q) => q.includes('registered_agents')),
    ).toHaveLength(0);

    // No writes: state unchanged.
    const afterState = await getTalkAgentSummary(talkId);
    expect(afterState).toEqual(beforeState);
  });

  it('orphan-present heal: snapshot fires, then prune deletes the orphan', async () => {
    const { talkId, agentAId } = await setupTalkWithAgents();
    await configureDefaultAgent(agentAId);
    await insertRawTalkAgent({
      talkId,
      registeredAgentId: agentAId,
      isPrimary: true,
      sortOrder: 0,
    });
    await insertRawTalkAgent({
      talkId,
      registeredAgentId: null,
      isPrimary: false,
      sortOrder: 1,
    });

    await withUserContext(OWNER_ID, () =>
      ensureTalkUsesUsableDefaultAgent(talkId, OWNER_ID),
    );

    const afterState = await getTalkAgentSummary(talkId);
    // Orphan row pruned; the active primary survives.
    expect(afterState).toEqual([
      { isPrimary: true, registeredAgentId: agentAId },
    ]);
  });

  it('empty-agents heal: default agent gets assigned', async () => {
    const { talkId, agentAId } = await setupTalkWithAgents();
    await configureDefaultAgent(agentAId);
    // No talk_agents rows seeded — heal must insert the default agent.

    await withUserContext(OWNER_ID, () =>
      ensureTalkUsesUsableDefaultAgent(talkId, OWNER_ID),
    );

    const afterState = await getTalkAgentSummary(talkId);
    expect(afterState).toHaveLength(1);
    expect(afterState[0]?.isPrimary).toBe(true);
    expect(afterState[0]?.registeredAgentId).toBe(agentAId);
  });

  it('broken-primary heal: prune updates first row to primary', async () => {
    const { talkId, agentAId, agentBId } = await setupTalkWithAgents();
    await configureDefaultAgent(agentAId);
    await insertRawTalkAgent({
      talkId,
      registeredAgentId: agentAId,
      isPrimary: false,
      sortOrder: 0,
    });
    await insertRawTalkAgent({
      talkId,
      registeredAgentId: agentBId,
      isPrimary: false,
      sortOrder: 1,
    });

    await withUserContext(OWNER_ID, () =>
      ensureTalkUsesUsableDefaultAgent(talkId, OWNER_ID),
    );

    const afterState = await getTalkAgentSummary(talkId);
    // Exactly one primary, on the first sort_order row.
    const primaries = afterState.filter((row) => row.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.registeredAgentId).toBe(agentAId);
  });

  it('snapshot throws → swallow → heal still runs', async () => {
    const { talkId, agentAId } = await setupTalkWithAgents();
    await configureDefaultAgent(agentAId);
    // Seed an orphan so the heal path's prune has something to do.
    await insertRawTalkAgent({
      talkId,
      registeredAgentId: agentAId,
      isPrimary: true,
      sortOrder: 0,
    });
    await insertRawTalkAgent({
      talkId,
      registeredAgentId: null,
      isPrimary: false,
      sortOrder: 1,
    });

    mockState.setSnapshotShouldThrow(true);

    // Should not propagate the snapshot error.
    await expect(
      withUserContext(OWNER_ID, () =>
        ensureTalkUsesUsableDefaultAgent(talkId, OWNER_ID),
      ),
    ).resolves.toBeUndefined();

    // Heal path ran: orphan was pruned.
    const afterState = await getTalkAgentSummary(talkId);
    expect(afterState).toEqual([
      { isPrimary: true, registeredAgentId: agentAId },
    ]);
  });
});
