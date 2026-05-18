-- 0011_codex_responses_api_format.sql
--
-- Flip provider.openai_codex to the codex_responses api_format.
--
-- Migration 0010 repurposed provider.openai_codex for ChatGPT
-- subscriptions but kept api_format = 'openai_chat_completions' as a
-- placeholder (inference was stubbed). The chatgpt.com/backend-api/codex
-- endpoint speaks the OpenAI Responses API, not Chat Completions, so
-- agents pinned to this provider failed with shape mismatches.
--
-- This migration:
--   1. Widens the api_format CHECK constraint to admit 'codex_responses'.
--      The original constraint in 0001 only allowed anthropic_messages
--      and openai_chat_completions, so the UPDATE below would otherwise
--      hit SQLSTATE 23514.
--   2. Switches api_format to 'codex_responses' so the llm-client
--      dispatches to the codex Responses adapter.
--   3. Seeds the gpt-5.4-mini model row that was missing from 0010
--      (the catalog defines three Codex models but 0010 only seeded
--      gpt-5.4 and gpt-5.3-codex).

alter table public.llm_providers
  drop constraint if exists llm_providers_api_format_check;

alter table public.llm_providers
  add constraint llm_providers_api_format_check
  check (api_format in ('anthropic_messages', 'openai_chat_completions', 'codex_responses'));

update public.llm_providers
set api_format = 'codex_responses',
    updated_at = now()
where id = 'provider.openai_codex'
  and api_format <> 'codex_responses';

insert into public.llm_provider_models (
  provider_id, model_id, display_name, context_window_tokens,
  default_max_output_tokens, default_ttft_timeout_ms, enabled
) values
  ('provider.openai_codex', 'gpt-5.4-mini', 'GPT-5.4 Mini',
   128000, 8192, 45000, true)
on conflict (provider_id, model_id) do update set
  display_name = excluded.display_name,
  context_window_tokens = excluded.context_window_tokens,
  default_max_output_tokens = excluded.default_max_output_tokens,
  default_ttft_timeout_ms = excluded.default_ttft_timeout_ms,
  enabled = excluded.enabled,
  updated_at = now();
