-- 0015_drop_talks_project_path.sql
--
-- Drop talks.project_path. The Project Mount UI was a holdover from the
-- container-runtime chassis; the cloud Worker has no container backend, so
-- the column was inert (the executor stub would have thrown if the
-- container branch ever ran). Per CLAUDE.md, prefer removing dead paths
-- over carrying compatibility baggage.

alter table public.talks
  drop column if exists project_path;
