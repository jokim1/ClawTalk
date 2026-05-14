// clawtalk Phase 5 (PR 2) — shared pg test harness.
//
// =====================================================================
// HARNESS CONTRACT — read before using these helpers.
// =====================================================================
//
// This module codifies the inline harness shape that landed across the
// six accessor-pg test files (accessors-pg.test.ts, agent-accessors-pg
// .test.ts, context-accessors-pg.test.ts, output-accessors-pg.test.ts,
// talk-tools-accessors-pg.test.ts, job-accessors-pg.test.ts). The TF-N
// test-conversion batches in Phase 5 PR 2 should import from here
// instead of copy-pasting helpers into each new test file.
//
// ---------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------
//   1. Local Supabase stack is running on 127.0.0.1:54432 — bring it
//      up with `npm run db:start` (`supabase start`) before invoking
//      vitest. Schema must already be applied via accumulated
//      migrations (`supabase db reset --local` does this).
//   2. Vitest is configured with `fileParallelism: false` and
//      `maxWorkers: 1` (vitest.config.ts) — test files serialize
//      end-to-end. Within a file, individual `it()` blocks share the
//      same DB instance; isolate via beforeEach purges, not full
//      `resetPgDatabase()`.
//
// ---------------------------------------------------------------------
// Conventions for new test files
// ---------------------------------------------------------------------
//   1. Pick a unique 6-digit UUID prefix per file. Convention:
//        const USER_A_ID = '0c<XYZ>-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
//        const USER_B_ID = '0c<XYZ>-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
//      Existing prefixes (don't reuse) —
//        111111 → agent-accessors
//        222222 → context-accessors
//        333333 → output-accessors
//        444444 → talk-tools-accessors
//        555555 → accessors (talks/folders/messages/...)
//        777777 → job-accessors
//      Unique prefixes keep test files non-overlapping if the pool
//      config ever loosens, and make log spelunking unambiguous.
//
//   2. Seed users + foreign-key dependencies in `beforeAll`, running
//      from the postgres role (BYPASSRLS) — i.e. outside any
//      `withUserContext`. seedAuthUser / seedTalk / seedLlmProvider
//      below all assume this.
//
//   3. Purge owner-scoped rows in `beforeEach`, again from the
//      postgres role. Use `purgeUserData([USER_A_ID, USER_B_ID])`
//      unless the file has a specialized purge (e.g. job-accessors
//      seeds talk_agents per-test and needs to clear it explicitly).
//
//   4. In `afterAll`: call `deleteAuthUsers([USER_A_ID, USER_B_ID])`
//      to CASCADE-delete the seeded users (which clears anything the
//      per-test purge missed), then `closePgDatabase()` so the next
//      test file can re-init.
//
//   5. Every accessor call under assertion runs inside
//      `withUserContext(userId, async () => { ... })`. Inside that
//      block the connection is downgraded to the `authenticated` role
//      and `auth.uid()` returns `userId` — RLS USING / WITH CHECK
//      clauses fire as they will in production. Calls outside
//      `withUserContext` run as the postgres role (BYPASSRLS); reserve
//      that for seeding and cleanup, never for the assertions under
//      test.
//
//   6. The cross-user RLS gate is the load-bearing security assertion.
//      Pattern: write rows as USER_A inside `withUserContext(USER_A)`,
//      then from inside `withUserContext(USER_B)` prove that
//        - reads return undefined / empty
//        - inserts with ownerId=USER_A are rejected by WITH CHECK
//        - updates / deletes of USER_A's rows affect zero rows
//      Every pg test file ships at least one of these — keep that
//      coverage when converting sqlite-era tests.
//
// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
//   seedAuthUser(opts?)  — insert into auth.users; returns the userId.
//                          From postgres role (BYPASSRLS).
//   seedTalk(input)      — insert into public.talks with a fixed
//                          ownerId. Bypasses createTalk's auto-thread
//                          provisioning — for tests that want a bare
//                          talk shell or a deterministic talkId, use
//                          this; for happy-path flows use the
//                          `createTalk` accessor inside withUserContext.
//   seedLlmProvider(input) — insert public.llm_providers +
//                          llm_provider_models stubs so FK constraints
//                          on agent_fallback_steps.provider_id and
//                          (provider_id, model_id) are satisfied.
//   purgeUserData(userIds) — delete owner-scoped rows from the primary
//                          fact tables. Run in beforeEach.
//   deleteAuthUsers(userIds) — CASCADE-delete the seeded auth.users
//                          rows. Run in afterAll.
//   withFreshUser(fn)    — seedAuthUser(random) + run fn inside
//                          withUserContext(userId). For one-shot tests
//                          that don't need to share state. The new
//                          user persists until the next
//                          resetPgDatabase() or explicit cleanup.
//   resetPgDatabase()    — TRUNCATE every public.* table CASCADE +
//                          delete every @clawtalk.local user from
//                          auth.users. ~100ms. Use between epochs,
//                          not between individual `it()` blocks.
//   getDbPg / initPgDatabase / closePgDatabase / withUserContext are
//   re-exported for convenience so test files can pull everything
//   from a single import.
// =====================================================================

import { randomUUID } from 'node:crypto';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';

export { closePgDatabase, getDbPg, initPgDatabase, withUserContext };

const TEST_USER_EMAIL_SUFFIX = '@clawtalk.local';

export async function seedAuthUser(opts?: {
  id?: string;
  email?: string;
  displayName?: string;
  role?: string;
}): Promise<string> {
  const id = opts?.id ?? randomUUID();
  const email = opts?.email ?? `test-${id}${TEST_USER_EMAIL_SUFFIX}`;
  const displayName = opts?.displayName ?? `Test User ${id.slice(0, 8)}`;
  const meta: Record<string, string> = { full_name: displayName };
  if (opts?.role) {
    meta.role = opts.role;
  }
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text, ${db.json(meta as never)})
    on conflict (id) do nothing
  `;
  return id;
}

export async function seedTalk(input: {
  ownerId: string;
  talkId?: string;
  topicTitle?: string;
}): Promise<string> {
  const talkId = input.talkId ?? randomUUID();
  const db = getDbPg();
  await db`
    insert into public.talks (id, owner_id, topic_title)
    values (${talkId}::uuid, ${input.ownerId}::uuid,
            ${input.topicTitle ?? 'Test Talk'})
    on conflict (id) do nothing
  `;
  return talkId;
}

export async function seedLlmProvider(input: {
  id: string;
  modelId: string;
  displayName?: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.llm_providers
      (id, name, provider_kind, api_format, base_url, auth_scheme)
    values (${input.id}, ${input.displayName ?? input.id}, 'custom',
            'openai_chat_completions', 'mock://test', 'bearer')
    on conflict (id) do nothing
  `;
  await db`
    insert into public.llm_provider_models
      (provider_id, model_id, display_name, context_window_tokens,
       default_max_output_tokens)
    values (${input.id}, ${input.modelId},
            ${input.displayName ?? input.modelId}, 32000, 2048)
    on conflict (provider_id, model_id) do nothing
  `;
}

export async function purgeUserData(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const db = getDbPg();
  // Cascade through talks: deletes folders/threads/messages/runs/jobs/
  // agents/outputs/context that hang off owner_id. Then sweep the
  // sibling tables whose owner column isn't owner_id (user_id) or that
  // don't cascade from talks.
  await db`
    delete from public.talks where owner_id in ${db(userIds)}
  `;
  await db`
    delete from public.talk_folders where owner_id in ${db(userIds)}
  `;
  await db`
    delete from public.registered_agents where owner_id in ${db(userIds)}
  `;
  await db`
    delete from public.user_tool_permissions where user_id in ${db(userIds)}
  `;
  await db`
    delete from public.idempotency_cache where user_id in ${db(userIds)}
  `;
  await db`
    delete from public.user_google_credentials where user_id in ${db(userIds)}
  `;
  await db`
    delete from public.google_oauth_link_requests where user_id in ${db(userIds)}
  `;
}

export async function deleteAuthUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const db = getDbPg();
  await db`
    delete from auth.users where id in ${db(userIds)}
  `;
}

export async function withFreshUser<T>(
  fn: (userId: string) => Promise<T>,
): Promise<T> {
  const userId = await seedAuthUser();
  return withUserContext(userId, () => fn(userId));
}

export async function resetPgDatabase(): Promise<void> {
  const db = getDbPg();
  const rows = await db<{ tablename: string }[]>`
    select tablename
    from pg_tables
    where schemaname = 'public'
  `;
  if (rows.length > 0) {
    const tables = rows.map((r) => `public."${r.tablename}"`).join(', ');
    await db.unsafe(`truncate ${tables} restart identity cascade`);
  }
  await db`
    delete from auth.users where email like ${'%' + TEST_USER_EMAIL_SUFFIX}
  `;
}
