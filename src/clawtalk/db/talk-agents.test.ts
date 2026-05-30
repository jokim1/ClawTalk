// T-new-C C3: getTalkAgentsHealthSnapshot — count-by-state accessor used
// by ensureTalkUsesUsableDefaultAgent's early-exit gate.
//
// 7 fixture cases drawn from the §4.1 equivalence table in the plan doc:
// one per (activeCount, primaryCount, orphanCount) tuple that the gate
// must distinguish.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { createTalk } from './accessors.js';
import { createRegisteredAgent } from './agent-accessors.js';
import { getTalkAgentsHealthSnapshot } from './talk-agents.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c999999-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROVIDER_ID = 'test.health-provider';
const MODEL_ID = 'test.health-model';

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function seedProvider(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.llm_providers
      (id, name, provider_kind, api_format, base_url, auth_scheme)
    values (${PROVIDER_ID}, 'Test Health Provider', 'custom',
            'openai_chat_completions', 'mock://health', 'bearer')
    on conflict (id) do nothing
  `;
  await db`
    insert into public.llm_provider_models
      (provider_id, model_id, display_name, context_window_tokens,
       default_max_output_tokens)
    values (${PROVIDER_ID}, ${MODEL_ID}, 'Test Health Model', 32000, 2048)
    on conflict (provider_id, model_id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where owner_id = ${OWNER_ID}::uuid`;
  await db`
    delete from public.registered_agents where owner_id = ${OWNER_ID}::uuid
  `;
}

async function insertTalkAgent(input: {
  talkId: string;
  ownerId: string;
  registeredAgentId: string | null;
  isPrimary: boolean;
  sortOrder: number;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_agents
      (talk_id, owner_id, registered_agent_id, source_kind, provider_id,
       model_id, is_primary, sort_order)
    values (${input.talkId}::uuid, ${input.ownerId}::uuid,
            ${input.registeredAgentId}::uuid, 'provider',
            ${PROVIDER_ID}, ${MODEL_ID}, ${input.isPrimary},
            ${input.sortOrder})
  `;
}

async function setupTalkAndAgents(): Promise<{
  talkId: string;
  agentAId: string;
  agentBId: string;
}> {
  return withUserContext(OWNER_ID, async () => {
    const talk = await createTalk({
      ownerId: OWNER_ID,
      topicTitle: 'health snapshot fixture',
    });
    const agentA = await createRegisteredAgent({
      ownerId: OWNER_ID,
      name: 'AgentA',
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });
    const agentB = await createRegisteredAgent({
      ownerId: OWNER_ID,
      name: 'AgentB',
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });
    return { talkId: talk.id, agentAId: agentA.id, agentBId: agentB.id };
  });
}

describe('getTalkAgentsHealthSnapshot', () => {
  beforeAll(async () => {
    await initPgDatabase({ url: TEST_DB_URL });
    await seedAuthUser(OWNER_ID, 'health-snapshot-test@clawtalk.test');
    await seedProvider();
  });

  afterAll(async () => {
    const db = getDbPg();
    await purge();
    await db`
      delete from public.llm_provider_models where provider_id = ${PROVIDER_ID}
    `;
    await db`delete from public.llm_providers where id = ${PROVIDER_ID}`;
    await db`delete from auth.users where id = ${OWNER_ID}::uuid`;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('empty talk_agents → all zeros', async () => {
    const { talkId } = await setupTalkAndAgents();
    const snapshot = await withUserContext(OWNER_ID, () =>
      getTalkAgentsHealthSnapshot(talkId),
    );
    expect(snapshot).toEqual({
      activeCount: 0,
      primaryCount: 0,
      orphanCount: 0,
    });
  });

  it('1 active primary row → healthy shape', async () => {
    const { talkId, agentAId } = await setupTalkAndAgents();
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: agentAId,
      isPrimary: true,
      sortOrder: 0,
    });
    const snapshot = await withUserContext(OWNER_ID, () =>
      getTalkAgentsHealthSnapshot(talkId),
    );
    expect(snapshot).toEqual({
      activeCount: 1,
      primaryCount: 1,
      orphanCount: 0,
    });
  });

  it('1 active non-primary row → primaryCount=0 routes to heal', async () => {
    const { talkId, agentAId } = await setupTalkAndAgents();
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: agentAId,
      isPrimary: false,
      sortOrder: 0,
    });
    const snapshot = await withUserContext(OWNER_ID, () =>
      getTalkAgentsHealthSnapshot(talkId),
    );
    expect(snapshot).toEqual({
      activeCount: 1,
      primaryCount: 0,
      orphanCount: 0,
    });
  });

  it('2 active rows, exactly 1 primary → healthy shape (multi-agent)', async () => {
    const { talkId, agentAId, agentBId } = await setupTalkAndAgents();
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: agentAId,
      isPrimary: true,
      sortOrder: 0,
    });
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: agentBId,
      isPrimary: false,
      sortOrder: 1,
    });
    const snapshot = await withUserContext(OWNER_ID, () =>
      getTalkAgentsHealthSnapshot(talkId),
    );
    expect(snapshot).toEqual({
      activeCount: 2,
      primaryCount: 1,
      orphanCount: 0,
    });
  });

  it('2 active rows, 2 primary (invariant broken) → routes to heal', async () => {
    const { talkId, agentAId, agentBId } = await setupTalkAndAgents();
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: agentAId,
      isPrimary: true,
      sortOrder: 0,
    });
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: agentBId,
      isPrimary: true,
      sortOrder: 1,
    });
    const snapshot = await withUserContext(OWNER_ID, () =>
      getTalkAgentsHealthSnapshot(talkId),
    );
    expect(snapshot).toEqual({
      activeCount: 2,
      primaryCount: 2,
      orphanCount: 0,
    });
  });

  it('1 active primary + 1 null-FK orphan → orphan blocks healthy', async () => {
    const { talkId, agentAId } = await setupTalkAndAgents();
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: agentAId,
      isPrimary: true,
      sortOrder: 0,
    });
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: null,
      isPrimary: false,
      sortOrder: 1,
    });
    const snapshot = await withUserContext(OWNER_ID, () =>
      getTalkAgentsHealthSnapshot(talkId),
    );
    expect(snapshot).toEqual({
      activeCount: 1,
      primaryCount: 1,
      orphanCount: 1,
    });
  });

  it('1 null-FK orphan only → routes to heal', async () => {
    const { talkId } = await setupTalkAndAgents();
    await insertTalkAgent({
      talkId,
      ownerId: OWNER_ID,
      registeredAgentId: null,
      isPrimary: false,
      sortOrder: 0,
    });
    const snapshot = await withUserContext(OWNER_ID, () =>
      getTalkAgentsHealthSnapshot(talkId),
    );
    expect(snapshot).toEqual({
      activeCount: 0,
      primaryCount: 0,
      orphanCount: 1,
    });
  });
});
