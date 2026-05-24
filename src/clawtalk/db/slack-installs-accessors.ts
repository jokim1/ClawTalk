// Workspace Slack install accessors.
//
// One row per installed Slack workspace. The bot token is encrypted via
// the same `encryptProviderSecret` pipeline as the rest of the connector
// credentials — the plaintext is only ever materialized inside
// `decryptWorkspaceSlackInstallToken`, which is called by privileged paths
// (the Slack API client for channel listing, future executor outbound posts).
//
// Read = SELECT for any authenticated user (members need to see the
// installed-workspace dropdown when creating channels).
// Write = admins only — enforced at the route layer via `isAdminLike(auth.role)`,
// with the underlying RLS policy in 0023 as belt + suspenders.
//
// The Slack OAuth callback runs outside `withUserContext` (no auth.uid()
// from Slack's browser redirect), so `upsertWorkspaceSlackInstall` is
// callable from the BYPASSRLS pool role.

import { getDbPg } from '../../db.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../llm/provider-secret-store.js';

export interface WorkspaceSlackInstallRecord {
  team_id: string;
  team_name: string;
  bot_user_id: string | null;
  app_id: string | null;
  scopes: string[];
  enc_key_version: number;
  installed_by: string | null;
  installed_at: string;
  updated_at: string;
  bound_channel_count: number;
}

interface SlackInstallRow {
  team_id: string;
  team_name: string;
  bot_user_id: string | null;
  app_id: string | null;
  scopes: string[] | null;
  enc_key_version: number;
  installed_by: string | null;
  installed_at: string;
  updated_at: string;
  bound_channel_count: string | number;
}

function toRecord(row: SlackInstallRow): WorkspaceSlackInstallRecord {
  return {
    team_id: row.team_id,
    team_name: row.team_name,
    bot_user_id: row.bot_user_id,
    app_id: row.app_id,
    scopes: row.scopes ?? [],
    enc_key_version: row.enc_key_version,
    installed_by: row.installed_by,
    installed_at: row.installed_at,
    updated_at: row.updated_at,
    bound_channel_count: Number(row.bound_channel_count) || 0,
  };
}

export async function listWorkspaceSlackInstalls(): Promise<
  WorkspaceSlackInstallRecord[]
> {
  const db = getDbPg();
  const rows = await db<SlackInstallRow[]>`
    select i.team_id, i.team_name, i.bot_user_id, i.app_id, i.scopes,
           i.enc_key_version, i.installed_by, i.installed_at, i.updated_at,
           public.workspace_slack_install_bound_channel_count(i.team_id)
             as bound_channel_count
    from public.workspace_slack_installs i
    order by i.team_name asc, i.team_id asc
  `;
  return rows.map(toRecord);
}

export async function getWorkspaceSlackInstall(
  teamId: string,
): Promise<WorkspaceSlackInstallRecord | null> {
  const db = getDbPg();
  const rows = await db<SlackInstallRow[]>`
    select i.team_id, i.team_name, i.bot_user_id, i.app_id, i.scopes,
           i.enc_key_version, i.installed_by, i.installed_at, i.updated_at,
           public.workspace_slack_install_bound_channel_count(i.team_id)
             as bound_channel_count
    from public.workspace_slack_installs i
    where i.team_id = ${teamId}
    limit 1
  `;
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface UpsertWorkspaceSlackInstallInput {
  teamId: string;
  teamName: string;
  botUserId: string | null;
  appId: string | null;
  botToken: string;
  scopes: string[];
  installedBy: string | null;
}

export async function upsertWorkspaceSlackInstall(
  input: UpsertWorkspaceSlackInstallInput,
): Promise<WorkspaceSlackInstallRecord> {
  if (!input.teamId) {
    throw new Error('teamId is required');
  }
  if (!input.botToken) {
    throw new Error('botToken is required');
  }
  const ciphertext = await encryptProviderSecret({ apiKey: input.botToken });
  const db = getDbPg();
  const rows = await db<SlackInstallRow[]>`
    with upserted as (
      insert into public.workspace_slack_installs
        (team_id, team_name, bot_user_id, app_id, ciphertext,
         scopes, installed_by, updated_at)
      values
        (${input.teamId}, ${input.teamName}, ${input.botUserId},
         ${input.appId}, ${ciphertext}, ${input.scopes as never},
         ${input.installedBy}::uuid, now())
      on conflict (team_id) do update set
        team_name = excluded.team_name,
        bot_user_id = excluded.bot_user_id,
        app_id = excluded.app_id,
        ciphertext = excluded.ciphertext,
        scopes = excluded.scopes,
        installed_by = excluded.installed_by,
        updated_at = now()
      returning *
    )
    select u.*,
           public.workspace_slack_install_bound_channel_count(u.team_id)
             as bound_channel_count
    from upserted u
  `;
  if (!rows[0]) {
    throw new Error('upsertWorkspaceSlackInstall returned no row');
  }
  return toRecord(rows[0]);
}

export async function deleteWorkspaceSlackInstall(
  teamId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<Array<{ team_id: string }>>`
    delete from public.workspace_slack_installs
    where team_id = ${teamId}
    returning team_id
  `;
  return rows.length > 0;
}

export async function decryptWorkspaceSlackInstallToken(
  teamId: string,
): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<Array<{ ciphertext: string }>>`
    select ciphertext from public.workspace_slack_installs
    where team_id = ${teamId}
    limit 1
  `;
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  const decoded = await decryptProviderSecret(ciphertext);
  return decoded.apiKey;
}
