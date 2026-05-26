-- 0027_nvidia_stream_idle_timeout_bump.sql
--
-- Bump NVIDIA NIM's stream_idle_timeout from 20s to 60s.
--
-- The static builtin-additional-providers.ts default ships 60s on
-- fresh installs, but the prod row was already seeded at 20s and the
-- runtime reads from the DB (execution-resolver.ts:151), not the
-- source file. Kimi 2.6 on NIM has long mid-stream pauses while it
-- transitions from text emission to the tool_use block; the 20s
-- ceiling killed runs that would have completed if we waited.

update public.llm_providers
set stream_idle_timeout_ms = 60000
where id = 'provider.nvidia';
