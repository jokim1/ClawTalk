-- 0033_talk_snapshot_version.sql
--
-- Talk-load architecture refactor — PR A snapshot endpoint.
-- See ~/.gstack/projects/clawtalk/talk-load-architecture-plan-2026-05-27.md.
--
-- Exposes a SECURITY DEFINER helper that the `/api/v1/talks/:talkId/snapshot`
-- endpoint calls to record the talk's outbox cursor at snapshot time.
--
-- Why this isn't a plain SELECT: migration 0006 revoked SELECT on
-- public.event_outbox from `authenticated`, so the snapshot accessor —
-- which runs under that role inside `withUserContextIsolated` — can't read
-- the outbox directly. The function self-checks ownership via auth.uid()
-- before reading, so callers can only learn the cursor for talks they own.
--
-- Returns:
--   - bigint MAX(event_id) for the talk's topic when the caller owns it
--     (0 when the talk exists but has no events yet).
--   - NULL when auth.uid() is missing or the talk is not owned by the
--     caller. The route layer falls back to 0 in that case so the
--     client-side delta filter still has a numeric cursor.
--
-- The function executes within the calling transaction's snapshot, so the
-- value it returns is consistent with the rest of a REPEATABLE READ
-- snapshot taken by `loadTalkSnapshot`.

create or replace function public.get_talk_snapshot_version(p_talk_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid;
  v_owner uuid;
  v_max bigint;
begin
  v_caller := auth.uid();
  if v_caller is null then
    return null;
  end if;

  select owner_id into v_owner
  from public.talks
  where id = p_talk_id;

  if v_owner is null or v_owner <> v_caller then
    return null;
  end if;

  select coalesce(max(event_id), 0)::bigint into v_max
  from public.event_outbox
  where topic = 'talk:' || p_talk_id::text;

  return v_max;
end;
$$;

revoke all on function public.get_talk_snapshot_version(uuid) from public;
grant execute on function public.get_talk_snapshot_version(uuid) to authenticated;
