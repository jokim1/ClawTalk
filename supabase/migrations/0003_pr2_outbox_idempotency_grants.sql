-- clawtalk Phase 5 PR 2 — relax event_outbox + idempotency_cache so they're
-- writable from inside withUserContext (authenticated role).
--
-- PR 1's 0001 left these two tables RLS-off and with no GRANTs to the
-- `authenticated` role, on the assumption that they were "system-managed"
-- and would be reached via a server-side admin role. That broke the
-- enqueueTalkTurnAtomic path: the talk-turn flow writes an outbox event
-- (and consults idempotency_cache) while still inside withUserContext,
-- which has downgraded role to `authenticated`. Insert fails with a
-- permission error.
--
-- Posture chosen here:
--   - event_outbox stays RLS-off (no per-user filtering). It's a topic-
--     keyed append-only log; per-topic authorization happens at the route
--     layer ("can this user subscribe to talk:${talkId}?") before any
--     subscribe/query runs. Grant INSERT + SELECT to authenticated; the
--     SSE consumer reads its own topic windows.
--   - idempotency_cache gets RLS turned on with `user_id = auth.uid()`
--     since rows are per-user by construction (the idempotency key alone
--     isn't unique; (idempotency_key, user_id, method, path) is the
--     primary key). Grant the full set to authenticated.

grant insert, select on public.event_outbox to authenticated;
grant usage, select on sequence public.event_outbox_event_id_seq to authenticated;

alter table public.idempotency_cache enable row level security;
create policy idempotency_cache_owner on public.idempotency_cache
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
grant insert, select, update, delete on public.idempotency_cache to authenticated;
