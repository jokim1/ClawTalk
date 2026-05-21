-- 0014_nvidia_kimi_k2_6.sql
--
-- NVIDIA NIM update: rename the provider from "NVIDIA Kimi2.5" to "NVIDIA NIM"
-- (the provider is the gateway, not the model), drop the kimi-k2.5 catalog
-- row, and seed kimi-k2.6 in its place. Additional models are picked up
-- dynamically via discoverNvidiaModels() against the live /v1/models endpoint
-- whenever a workspace has a NVIDIA credential configured.
--
-- Existing agents that still reference 'moonshotai/kimi-k2.5' become orphan
-- string references (no FK on registered_agents.model_id); the agent edit UI
-- will surface a blank model selection and the user re-picks. This is
-- acceptable per CLAUDE.md ("treat existing local data as disposable"). The
-- FK on agent_fallback_steps cascades, so any fallback step pointing at
-- kimi-k2.5 is removed by the DELETE below.
--
-- Idempotent: re-running on a database that already has kimi-k2.6 is a no-op
-- on the INSERT (on conflict ... do update) and a no-op on the DELETE (no
-- matching row).

update public.llm_providers
   set name = 'NVIDIA NIM',
       updated_at = now()
 where id = 'provider.nvidia';

delete from public.llm_provider_models
 where provider_id = 'provider.nvidia'
   and model_id = 'moonshotai/kimi-k2.5';

insert into public.llm_provider_models (
  provider_id, model_id, display_name, context_window_tokens,
  default_max_output_tokens, default_ttft_timeout_ms, enabled
) values (
  'provider.nvidia', 'moonshotai/kimi-k2.6', 'Kimi 2.6 (NVIDIA)',
  262144, 16384, 60000, true
)
on conflict (provider_id, model_id) do update set
  display_name = excluded.display_name,
  context_window_tokens = excluded.context_window_tokens,
  default_max_output_tokens = excluded.default_max_output_tokens,
  default_ttft_timeout_ms = excluded.default_ttft_timeout_ms,
  enabled = excluded.enabled,
  updated_at = now();
