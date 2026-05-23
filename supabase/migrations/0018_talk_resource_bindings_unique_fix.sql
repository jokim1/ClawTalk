-- C2: include owner_id in the uniqueness scope so two users with edit
-- access to the same Talk can each bind the same external Drive file
-- without one silently losing their binding.
--
-- The old index was (talk_id, binding_kind, external_id). RLS on
-- talk_resource_bindings scopes both reads and writes to
-- owner_id = auth.uid(), but the uniqueness check runs ABOVE RLS.
-- Concrete failure mode:
--   1. User A inserts (talk-X, google_drive_file, file-Y, owner=A)
--   2. User B (also in the talk) inserts (talk-X, google_drive_file,
--      file-Y, owner=B). The INSERT row's WITH CHECK passes
--      (owner_id = auth.uid()), but the unique index sees a duplicate
--      on (talk_id, binding_kind, external_id) and ON CONFLICT DO
--      NOTHING swallows it.
--   3. The follow-up SELECT in createTalkResourceBinding runs under
--      RLS scoped to owner=B, sees zero rows, and the accessor throws.
--   4. Net: B's binding silently never lands.
--
-- The fix is to make the uniqueness scope match the RLS scope by adding
-- owner_id to the index. The matching accessor change (4-column
-- ON CONFLICT target) ships in the same commit — running this migration
-- against the old accessor would leave the conflict target pointing at
-- a constraint that no longer exists.

drop index if exists public.talk_resource_bindings_unique_scope_idx;

create unique index talk_resource_bindings_unique_scope_owner_idx
  on public.talk_resource_bindings (talk_id, binding_kind, external_id, owner_id);
