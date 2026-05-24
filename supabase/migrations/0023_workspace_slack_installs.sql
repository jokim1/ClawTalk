-- 0023_workspace_slack_installs.sql
--
-- Slack OAuth install flow — replaces the manual "paste workspace ID +
-- channel ID + bot token" form with a real Slack workspace install.
--
-- One row per installed Slack workspace. The bot token is encrypted via
-- the same `encryptProviderSecret` pipeline as the rest of the connector
-- credentials, so the install record is a workspace-global asset and any
-- number of channels can reference it through `workspace_channels.config_json.install_team_id`.
--
-- Existing `kind='slack'` rows in `workspace_channels` are dropped at the
-- end — they reference a credential layout that no longer matches.
-- Channels will be re-added through the new install + picker flow.

create table public.workspace_slack_installs (
  team_id text primary key,
  team_name text not null,
  bot_user_id text,
  app_id text,
  -- Bot token (xoxb-...) encrypted with the shared provider-secret pipeline.
  ciphertext text not null,
  enc_key_version integer not null default 1,
  scopes text[] not null default '{}'::text[],
  installed_by uuid references public.users(id) on delete set null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workspace_slack_installs_installed_at_idx
  on public.workspace_slack_installs (installed_at desc);

alter table public.workspace_slack_installs enable row level security;

create policy workspace_slack_installs_read
  on public.workspace_slack_installs
  for select to authenticated
  using (true);

create policy workspace_slack_installs_write
  on public.workspace_slack_installs
  for all to authenticated
  using (public.current_user_is_workspace_admin())
  with check (public.current_user_is_workspace_admin());

grant select, insert, update, delete
  on public.workspace_slack_installs
  to authenticated;

-- The Slack OAuth callback runs without auth.uid() (Slack redirects the
-- browser directly to /api/v1/auth/slack/callback with no clawtalk session
-- cookies). The pool runs as the BYPASSRLS `postgres` role for that handler,
-- so the UPSERT executes outside RLS. After the install row is written, the
-- callback handler enters `withUserContext(installed_by)` for any follow-up
-- work — mirroring the Google OAuth flow.

-- Bound channel count helper. SECURITY DEFINER so the count returns the true
-- global value, not just rows the caller can SELECT through
-- workspace_channels' RLS (currently `using (true)` for authenticated, but
-- defense-in-depth matches 0019's helper).
create or replace function public.workspace_slack_install_bound_channel_count(
  team_id text
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  -- workspace_channels.config_json.workspace_id holds the Slack team_id
  -- (same convention as the manual-form era), so the install ↔ channel
  -- relationship is keyed on workspace_id == team_id.
  select count(*)::bigint
  from public.workspace_channels c
  where c.kind = 'slack'
    and c.config_json ->> 'workspace_id' = workspace_slack_install_bound_channel_count.team_id;
$$;
revoke all on function public.workspace_slack_install_bound_channel_count(text)
  from public;
grant execute on function public.workspace_slack_install_bound_channel_count(text)
  to authenticated;

-- Drop the existing Slack channels — the manual-credential rows are
-- incompatible with the install-keyed model. CLAUDE.md treats local data
-- as disposable; channels will be re-created through the new picker.
delete from public.workspace_channels
where kind = 'slack';
