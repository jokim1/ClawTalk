-- clawtalk W7-evtsse ROLLBACK — restore `authenticated` SELECT on
-- event_outbox.
--
-- Apply ONLY if migration 0006 needs to be reverted, e.g. the
-- UserEventHub DO is rolled back but 0006 has already shipped.
--
-- This migration is NOT applied in normal forward deploys. Apply
-- out-of-band:
--
--   psql -h <host> -U postgres -d postgres \
--        -f supabase/migrations/9999_rollback_outbox_authenticated.sql
--
-- After rollback, both `authenticated` and `clawtalk_event_hub` can
-- SELECT from event_outbox. The Node-mode SSE path (if still present)
-- works again.

grant select on public.event_outbox to authenticated;
