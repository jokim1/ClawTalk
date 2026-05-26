-- 0028_content_edits_and_drop_proposals.sql
--
-- Direct-edit redesign (commits 1-9, plan: silly-gathering-charm.md).
-- Replaces the propose/accept abstraction with an edit-log table.
-- body_markdown stays untouched until accept; the renderer composes
-- body + pending edits at read time. Accept materializes; reject just
-- deletes the row.
--
-- Schema diff from 0022:
--   + public.content_edits  — staging table for pending agent edits
--   - public.content_proposals  — replaced by content_edits
--   - content_proposals_assert_owner_matches_content() trigger fn

-- ── New table: content_edits ────────────────────────────────────────
create table public.content_edits (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null
    references public.contents(id) on delete cascade,
  -- Logical run identifier (groups all edits from one assistant turn).
  -- Text rather than uuid since it's the talk_runs.id reused as a
  -- grouping key but accessors also tolerate ad-hoc strings.
  run_id text not null,
  agent_id uuid
    references public.registered_agents(id) on delete set null,
  agent_nickname text,
  message_id uuid
    references public.talk_messages(id) on delete set null,
  kind text not null check (kind in ('insert', 'replace', 'delete', 'bulk')),
  base_content_version integer not null,
  -- For replace/delete: the anchor to act on.
  -- For insert: anchor to insert AFTER (null = prepend).
  -- For bulk: null (whole body replaced).
  target_anchor_id text,
  -- For insert/replace: the new block markdown.
  -- For bulk: the entire new body.
  -- For delete: null.
  new_markdown text,
  rationale text,
  created_at timestamptz not null default now()
);
create index content_edits_by_content_created
  on public.content_edits (content_id, created_at);
create index content_edits_by_content_run
  on public.content_edits (content_id, run_id);

alter table public.content_edits enable row level security;

-- Owner-only RLS: an edit row is visible / mutable iff the surrounding
-- session can see the parent content (which itself is owner-gated via
-- contents.owner_id = auth.uid()).
create policy content_edits_owner
  on public.content_edits
  for all to authenticated
  using (
    exists (
      select 1 from public.contents c
      where c.id = content_edits.content_id
        and c.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.contents c
      where c.id = content_edits.content_id
        and c.owner_id = auth.uid()
    )
  );

grant select, insert, update, delete
  on public.content_edits
  to authenticated;

-- ── Drop the propose abstraction ────────────────────────────────────
-- The trigger has to go before the function (depends on it), and the
-- function before the table (drop order doesn't matter for the table
-- since it's `if exists`).
drop trigger if exists content_proposals_owner_integrity
  on public.content_proposals;
drop function if exists public.content_proposals_assert_owner_matches_content();
drop table if exists public.content_proposals;

-- Bump body_version on every content so any browser holding a cached
-- snapshot with pending proposals refetches on next mutation. Sole
-- user is Joseph; this is an extra-cautious sweep, not a correctness
-- requirement.
update public.contents set body_version = body_version + 1;
