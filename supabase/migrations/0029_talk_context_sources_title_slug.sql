-- 0029_talk_context_sources_title_slug.sql
--
-- Saved Sources redesign — index-only context (plan:
-- talks-have-a-context-radiant-orbit.md). PR1 of 2.
--
-- Adds `title_slug` so users can `@-reference` a source by a normalized
-- form of its title (e.g. `@design-notes` for a source titled
-- "Design Notes"). The stable `S<n>` ref form continues to work and is
-- the fallback when slugs collide. Slug uniqueness is NOT enforced at
-- the DB level — ambiguity is resolved at `@-ref` injection time.

alter table public.talk_context_sources
  add column title_slug text;

-- Backfill existing rows. Lowercase, replace any non-alphanumeric run
-- with a single dash, then strip leading/trailing dashes. Empty result
-- → null so the manifest renderer falls back to ref-only.
update public.talk_context_sources
set title_slug = nullif(
  trim(both '-' from
    regexp_replace(lower(coalesce(title, '')), '[^a-z0-9]+', '-', 'g')
  ),
  ''
);
