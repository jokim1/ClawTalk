-- 0024_drop_talk_outputs.sql
--
-- Reports kill switch — remove the legacy `talk_outputs` artifact surface
-- now that Content (1:1 long-form docs per Talk, see 0022) fully subsumes
-- the "durable talk-level markdown" use case.
--
-- The agent-side write tools (`list_outputs`/`read_output`/`write_output`)
-- were already dead chassis stubs that threw at runtime — see CLAUDE.md
-- "Engineering Defaults" (remove dead paths instead of supporting old +
-- new in parallel).
--
-- talk_jobs.deliverable_kind used to be 'thread' | 'report' with a
-- report_output_id FK pointing at talk_outputs. Reports are gone, so
-- jobs always produce thread messages now. The job system itself needs
-- a re-architecture (TODO in CLAUDE.md "What's Next" §7); this migration
-- just removes the report deliverable from the schema.

-- Drop the FK column first (depends on talk_outputs).
alter table public.talk_jobs
  drop column if exists report_output_id;

-- Drop the deliverable_kind concept entirely. All jobs post to a thread now.
alter table public.talk_jobs
  drop column if exists deliverable_kind;

-- Drop the table (RLS policy + indexes go with it).
drop table if exists public.talk_outputs;
