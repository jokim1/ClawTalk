-- 0017_seed_exa_web_search.sql
--
-- Add Exa (https://exa.ai) as a fourth web search provider alongside
-- Tavily, Brave, and Firecrawl. Exa is a neural search engine
-- purpose-built for LLM workflows — see src/clawtalk/web-search/exa.ts
-- for the adapter.

insert into public.web_search_providers (id, name, base_url) values
  ('web_search.exa', 'Exa', 'https://api.exa.ai')
on conflict (id) do update set
  name = excluded.name,
  base_url = excluded.base_url,
  updated_at = now();
