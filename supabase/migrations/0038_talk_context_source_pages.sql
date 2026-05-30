-- 0038_talk_context_source_pages.sql
--
-- PDF page-rasterization (plan: pdf-page-rasterization-plan.md, Lane A).
--
-- Vision-capable-but-not-PDF-capable models (gpt-5-mini, gemini-2.5-flash,
-- moonshotai/kimi-k2.6) cannot read native PDF document blocks, so a
-- Saved-Source PDF degrades to extracted text alone and loses figures,
-- charts, and scanned imagery. The webapp rasterizes each PDF page to a
-- JPEG with pdf.js at upload time; this child table records one row per
-- persisted page image so the Worker can:
--   (a) know a source's page set is complete  ── count(*) == N
--   (b) budget the model payload from byte_size without listing R2
--   (c) delete page objects by deterministic key on source delete
-- A single page-count column cannot do (a) safely (finalize race) or (b)
-- at all, which is why this is a child table rather than a column on
-- talk_context_sources (plan locked decision 3 / Codex #3/#5/#14).
--
-- Shape mirrors content_proposals (0022): a child of an owner-scoped
-- parent with a denormalized owner_id for simple owner-only RLS
-- (owner_id = auth.uid()), plus an ownership-integrity trigger that pins
-- owner_id to the parent source's owner so a buggy or hostile insert
-- cannot attach a page row to another user's source. RLS WITH CHECK only
-- proves the page row's owner_id == auth.uid(); it does NOT prove the
-- referenced source_id belongs to that same user, so the trigger is the
-- backstop for the denormalized copy.
--
-- R2 page-image keys are deterministic (no list-by-prefix):
--   attachments/{talk_id}/{source_id}/page-{page_index}.jpg   (0-based)
--
-- This migration also adds `talk_context_sources.expected_page_count`
-- (nullable) to record N for the completeness check above.
--
-- Revert: drop trigger, then function, then table (FK ON DELETE CASCADE
-- means the rows vanish with their parent source either way), then
-- `alter table public.talk_context_sources drop column expected_page_count`.
-- Orphaned R2 page objects are harmless — they are only ever read through
-- this table.

create table public.talk_context_source_pages (
  source_id uuid not null
    references public.talk_context_sources(id) on delete cascade,
  -- 0-based page index; upper bound (MAX_RASTER_PAGES) is enforced at the
  -- upload endpoint, not the DB, so the app constant can move without a
  -- migration.
  page_index integer not null check (page_index >= 0),
  -- Size of the stored JPEG in bytes. Used to budget the model payload at
  -- consumption time; the per-image and total caps live in app code.
  byte_size integer not null check (byte_size >= 0),
  owner_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (source_id, page_index)
);

-- Expected number of page images for this source's rasterization, set by
-- the page-upload endpoint (= min(pdf.numPages, MAX_RASTER_PAGES)). A
-- source's page set is COMPLETE when
--   (select count(*) from talk_context_source_pages where source_id = id)
-- equals this value. NULL for sources never rasterized (non-PDFs, PDFs
-- uploaded before this feature, or PDFs whose client-side render produced
-- no pages) — those fall back to extracted text. Storing the expected
-- total here, rather than trusting a client "done" flag, lets the Worker
-- verify the whole set actually landed before consuming it (Codex #5
-- finalize race) and lets `count < expected` fall back to text on an
-- interrupted upload.
alter table public.talk_context_sources
  add column expected_page_count integer
    check (expected_page_count is null or expected_page_count >= 1);
-- The composite PK already provides a (source_id, page_index) index, which
-- serves both the completeness count and the ordered page fetch for a
-- source. No additional index is needed.
alter table public.talk_context_source_pages enable row level security;

create policy talk_context_source_pages_owner
  on public.talk_context_source_pages
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

grant select, insert, update, delete
  on public.talk_context_source_pages
  to authenticated;

-- Ownership-integrity: pin page.owner_id to the parent source's owner_id.
-- SECURITY DEFINER so the trigger can read talk_context_sources even when
-- the caller's RLS would hide the row (it won't, since the caller is the
-- owner — but the trigger is the last line of defense, not the first).
create or replace function public.talk_context_source_pages_assert_owner_matches_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_owner uuid;
begin
  select owner_id into expected_owner
  from public.talk_context_sources
  where id = new.source_id;

  if expected_owner is null then
    raise exception 'talk_context_source_pages.source_id % does not reference an existing source',
      new.source_id;
  end if;
  if expected_owner <> new.owner_id then
    raise exception 'talk_context_source_pages.owner_id % does not match talk_context_sources.owner_id %',
      new.owner_id, expected_owner;
  end if;
  return new;
end;
$$;

create trigger talk_context_source_pages_owner_integrity
  before insert or update on public.talk_context_source_pages
  for each row execute function public.talk_context_source_pages_assert_owner_matches_source();
