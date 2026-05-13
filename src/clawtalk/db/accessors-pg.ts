// clawtalk Phase 5 (PR 2) — postgres port of accessors.ts core surface.
//
// This is the partial port covering: talks, talk_folders, talk_members,
// talk_threads (basic CRUD + helpers). The remaining slices land in
// subsequent commits on this branch:
//   - talk_messages CRUD
//   - talk_runs CRUD + status/metadata helpers
//   - event_outbox + idempotency_cache
//   - atomic multi-table transactions (enqueueTalkTurnAtomic,
//     completeRunAndPromoteNextAtomic, etc.)
//   - sidebar tree (listTalkSidebarTreeForUser, reorderTalkSidebarItem)
//   - main channel (defer — chassis-era, may be removable entirely)
//
// Behavior change vs sqlite: the sqlite-era `listTalksForUser` had an
// admin/owner-role short-circuit that returned every user's talks.
// Under postgres RLS this is impossible from the `authenticated` role
// without a policy rewrite — the cross-user view requires a
// SECURITY DEFINER admin function. Dropped here. Callers that depended
// on it must be re-routed through a future admin surface or RLS policy
// change. For now: every user sees only their own talks.
//
// Schema differences vs sqlite:
//   - is_default / is_internal / is_pinned are booleans (not 0/1).
//   - IDs are uuid; integer literals need ::uuid casts.
//   - Foreign-keyed columns enforced strictly (no missing-row inserts).
//   - talk_threads.owner_id is required (denormalized from talks for RLS).

import { randomUUID } from 'node:crypto';

import { getDbPg } from '../../db-pg.js';
import { notifyOutboxEvent } from '../talks/outbox-notifier.js';
import {
  inferThreadTitleFromContent,
  isLegacyPlaceholderTalkThreadTitle,
  normalizeStoredThreadTitle,
  validateEditableThreadTitle,
} from './thread-title-utils.js';

export type TalkAccessLevel = 'owner' | 'editor' | 'viewer';
export type TalkAccessRole = 'editor' | 'viewer';

// ---------------------------------------------------------------------------
// Talk records
// ---------------------------------------------------------------------------

export interface TalkRecord {
  id: string;
  owner_id: string;
  folder_id: string | null;
  sort_order: number;
  topic_title: string | null;
  project_path: string | null;
  orchestration_mode: 'ordered' | 'panel';
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TalkFolderRecord {
  id: string;
  owner_id: string;
  title: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TalkWithAccessRecord extends TalkRecord {
  access_role: TalkAccessLevel;
}

export interface TalkListPage {
  limit: number;
  offset: number;
}

// Note vs sqlite: `llm_policy` is dropped here — talk_llm_policies is
// chassis-era and gone from the postgres schema. Callers that used to
// surface a per-talk LLM policy string in the sidebar list need to
// move that into a registered_agents/agent-config lookup at the row
// level instead.
export interface TalkSidebarTalkRecord {
  id: string;
  owner_id: string;
  folder_id: string | null;
  sort_order: number;
  topic_title: string | null;
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
  access_role: TalkAccessLevel;
  last_message_at: string | null;
  message_count: number;
  has_active_run: boolean;
}

export interface TalkSidebarTreeRecord {
  folders: TalkFolderRecord[];
  rootTalks: TalkSidebarTalkRecord[];
  talksByFolderId: Record<string, TalkSidebarTalkRecord[]>;
}

export function normalizeTalkListPage(input?: {
  limit?: number;
  offset?: number;
}): TalkListPage {
  const limit =
    typeof input?.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 50;
  const offset =
    typeof input?.offset === 'number'
      ? Math.max(0, Math.floor(input.offset))
      : 0;
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Talks
// ---------------------------------------------------------------------------

const TALK_COLUMNS = `id, owner_id, folder_id, sort_order, topic_title,
  project_path, orchestration_mode, status, version, created_at, updated_at`;

export async function createTalk(input: {
  ownerId: string;
  id?: string;
  topicTitle?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
  status?: 'active' | 'paused' | 'archived';
}): Promise<TalkRecord> {
  const db = getDbPg();
  // Insert at sort_order 0 and bump everyone else by 1 so the new talk
  // appears first in the sidebar. Bumping happens for both root talks and
  // root folders so the (talk, folder) ordering stays interleaved.
  await db`
    update public.talks
    set sort_order = sort_order + 1
    where owner_id = ${input.ownerId}::uuid and folder_id is null
  `;
  await db`
    update public.talk_folders
    set sort_order = sort_order + 1
    where owner_id = ${input.ownerId}::uuid
  `;
  const inserted = input.id
    ? await db<TalkRecord[]>`
        insert into public.talks
          (id, owner_id, folder_id, sort_order, topic_title,
           orchestration_mode, status)
        values
          (${input.id}::uuid, ${input.ownerId}::uuid, null, 0,
           ${input.topicTitle ?? null},
           ${input.orchestrationMode ?? 'ordered'},
           ${input.status ?? 'active'})
        returning ${db.unsafe(TALK_COLUMNS)}
      `
    : await db<TalkRecord[]>`
        insert into public.talks
          (owner_id, folder_id, sort_order, topic_title,
           orchestration_mode, status)
        values
          (${input.ownerId}::uuid, null, 0,
           ${input.topicTitle ?? null},
           ${input.orchestrationMode ?? 'ordered'},
           ${input.status ?? 'active'})
        returning ${db.unsafe(TALK_COLUMNS)}
      `;
  const talk = inserted[0];
  // Auto-provision a default thread so the UI always has somewhere to
  // post. Schema enforces talk_threads.owner_id NOT NULL — must match the
  // talk's owner.
  await getOrCreateDefaultThread({ talkId: talk.id, ownerId: input.ownerId });
  return talk;
}

export async function getTalkById(
  talkId: string,
): Promise<TalkRecord | undefined> {
  const db = getDbPg();
  const rows = await db<TalkRecord[]>`
    select ${db.unsafe(TALK_COLUMNS)}
    from public.talks
    where id = ${talkId}::uuid
    limit 1
  `;
  return rows[0];
}

export async function touchTalkUpdatedAt(
  talkId: string,
  updatedAt?: string,
): Promise<void> {
  const db = getDbPg();
  if (updatedAt) {
    await db`
      update public.talks
      set updated_at = ${updatedAt}::timestamptz
      where id = ${talkId}::uuid
    `;
  } else {
    await db`
      update public.talks
      set updated_at = now()
      where id = ${talkId}::uuid
    `;
  }
}

export async function listTalksForUser(input: {
  limit?: number;
  offset?: number;
  status?: 'active' | 'paused' | 'archived';
}): Promise<TalkWithAccessRecord[]> {
  // RLS filters to the caller automatically. No admin/owner cross-user
  // bypass — see top-of-file comment.
  const page = normalizeTalkListPage(input);
  const db = getDbPg();
  // The talk_members policy lets the talk owner see member rows for
  // their talks (and members see their own row). RLS on talks restricts
  // to owner_id = auth.uid(), so any talk visible to the caller is one
  // they own — access_role is always 'owner' under this slice. Sharing
  // (editor/viewer via talk_members) will need an `owner_id = auth.uid()
  // OR id in (select talk_id from talk_members where user_id = auth.uid())`
  // policy expansion when the sharing feature ships.
  const rows = input.status
    ? await db<TalkRecord[]>`
        select ${db.unsafe(TALK_COLUMNS)}
        from public.talks
        where status = ${input.status}
        order by updated_at desc, created_at desc
        limit ${page.limit} offset ${page.offset}
      `
    : await db<TalkRecord[]>`
        select ${db.unsafe(TALK_COLUMNS)}
        from public.talks
        order by updated_at desc, created_at desc
        limit ${page.limit} offset ${page.offset}
      `;
  return rows.map((t) => ({ ...t, access_role: 'owner' as const }));
}

export async function getTalkForUser(
  talkId: string,
): Promise<TalkWithAccessRecord | undefined> {
  const talk = await getTalkById(talkId);
  if (!talk) return undefined;
  return { ...talk, access_role: 'owner' };
}

export async function upsertTalk(input: {
  ownerId: string;
  id: string;
  topicTitle?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
  status?: 'active' | 'paused' | 'archived';
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks
      (id, owner_id, folder_id, sort_order, topic_title,
       orchestration_mode, status, version)
    values
      (${input.id}::uuid, ${input.ownerId}::uuid, null, 0,
       ${input.topicTitle ?? null},
       ${input.orchestrationMode ?? 'ordered'},
       ${input.status ?? 'active'}, 1)
    on conflict (id) do update set
      topic_title = excluded.topic_title,
      orchestration_mode = excluded.orchestration_mode,
      status = excluded.status,
      updated_at = now(),
      version = public.talks.version + 1
  `;
}

export async function patchTalkMetadata(input: {
  ownerId: string;
  talkId: string;
  title?: string | null;
  folderId?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
}): Promise<TalkRecord | undefined> {
  const db = getDbPg();
  // Pre-fetch the talk to (a) detect a destination-folder change vs the
  // current parent and (b) return undefined for RLS-hidden rows before
  // doing any work.
  const existing = await getTalkById(input.talkId);
  if (!existing) return undefined;

  // Validate destination folder belongs to the caller (RLS-scoped read).
  if (
    input.folderId !== undefined &&
    input.folderId !== null &&
    input.folderId !== existing.folder_id
  ) {
    const folder = await getTalkFolderById(input.folderId);
    if (!folder) return undefined;
  }

  // Title / orchestration update is unconditional even on folder moves
  // so the version bump always reflects "something changed" in one place.
  if (input.title !== undefined || input.orchestrationMode !== undefined) {
    await db`
      update public.talks
      set topic_title = case when ${input.title !== undefined}::boolean
                          then ${input.title ?? null} else topic_title end,
          orchestration_mode = coalesce(${input.orchestrationMode ?? null},
                                        orchestration_mode),
          updated_at = now(),
          version = version + 1
      where id = ${input.talkId}::uuid
    `;
  }

  if (input.folderId !== undefined && input.folderId !== existing.folder_id) {
    const sourceFolderId = existing.folder_id;
    // Compact the source list so deleted-position siblings don't keep
    // their gap.
    if (sourceFolderId === null) {
      const rootItems = (await listOwnedRootSidebarItems()).filter(
        (item) => !(item.type === 'talk' && item.id === input.talkId),
      );
      await writeRootSidebarOrder(
        rootItems.map((item) => ({ type: item.type, id: item.id })),
      );
    } else {
      const folderTalkIds = (
        await listOwnedFolderTalkIds(sourceFolderId)
      ).filter((id) => id !== input.talkId);
      await writeFolderTalkOrder(sourceFolderId, folderTalkIds);
    }

    if (input.folderId === null) {
      // Move to top-level: append to end. Mirrors the sqlite
      // appendTalksToTopLevel helper inline.
      const maxRootTalk = await db<{ value: number }[]>`
        select coalesce(max(sort_order), -1)::int as value
        from public.talks
        where folder_id is null
      `;
      const maxRootFolder = await db<{ value: number }[]>`
        select coalesce(max(sort_order), -1)::int as value
        from public.talk_folders
      `;
      const nextSort =
        Math.max(maxRootTalk[0]?.value ?? -1, maxRootFolder[0]?.value ?? -1) +
        1;
      await db`
        update public.talks
        set folder_id = null,
            sort_order = ${nextSort},
            updated_at = now(),
            version = version + 1
        where id = ${input.talkId}::uuid
      `;
    } else {
      const folderTalkIds = await listOwnedFolderTalkIds(input.folderId);
      await db`
        update public.talks
        set folder_id = ${input.folderId}::uuid,
            sort_order = ${folderTalkIds.length},
            updated_at = now(),
            version = version + 1
        where id = ${input.talkId}::uuid
      `;
    }
  }

  return await getTalkById(input.talkId);
}

export async function updateTalkProjectPath(input: {
  talkId: string;
  projectPath: string | null;
}): Promise<TalkRecord | undefined> {
  const db = getDbPg();
  const rows = await db<TalkRecord[]>`
    update public.talks
    set project_path = ${input.projectPath},
        updated_at = now(),
        version = version + 1
    where id = ${input.talkId}::uuid
    returning ${db.unsafe(TALK_COLUMNS)}
  `;
  return rows[0];
}

export async function deleteTalkForOwner(input: {
  talkId: string;
}): Promise<boolean> {
  const db = getDbPg();
  // Capture the parent folder before delete so we know which sibling
  // list to compact afterwards. RLS scopes the SELECT to the caller.
  const existing = await getTalkById(input.talkId);
  if (!existing) return false;
  const oldFolderId = existing.folder_id;
  const rows = await db<{ id: string }[]>`
    delete from public.talks
    where id = ${input.talkId}::uuid
    returning id
  `;
  if (rows.length === 0) return false;
  if (oldFolderId === null) {
    const remaining = await listOwnedRootSidebarItems();
    await writeRootSidebarOrder(
      remaining.map((item) => ({ type: item.type, id: item.id })),
    );
  } else {
    const remaining = await listOwnedFolderTalkIds(oldFolderId);
    await writeFolderTalkOrder(oldFolderId, remaining);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Talk folders
// ---------------------------------------------------------------------------

const TALK_FOLDER_COLUMNS = `id, owner_id, title, sort_order, created_at, updated_at`;

export async function listTalkFoldersForOwner(): Promise<TalkFolderRecord[]> {
  const db = getDbPg();
  return await db<TalkFolderRecord[]>`
    select ${db.unsafe(TALK_FOLDER_COLUMNS)}
    from public.talk_folders
    order by sort_order asc, created_at asc, id asc
  `;
}

export async function createTalkFolder(input: {
  ownerId: string;
  id?: string;
  title: string;
}): Promise<TalkFolderRecord> {
  const db = getDbPg();
  // Bump root order so the new folder appears first.
  await db`
    update public.talks
    set sort_order = sort_order + 1
    where owner_id = ${input.ownerId}::uuid and folder_id is null
  `;
  await db`
    update public.talk_folders
    set sort_order = sort_order + 1
    where owner_id = ${input.ownerId}::uuid
  `;
  const rows = input.id
    ? await db<TalkFolderRecord[]>`
        insert into public.talk_folders
          (id, owner_id, title, sort_order)
        values (${input.id}::uuid, ${input.ownerId}::uuid, ${input.title}, 0)
        returning ${db.unsafe(TALK_FOLDER_COLUMNS)}
      `
    : await db<TalkFolderRecord[]>`
        insert into public.talk_folders
          (owner_id, title, sort_order)
        values (${input.ownerId}::uuid, ${input.title}, 0)
        returning ${db.unsafe(TALK_FOLDER_COLUMNS)}
      `;
  return rows[0];
}

export async function renameTalkFolder(input: {
  id: string;
  title: string;
}): Promise<TalkFolderRecord | undefined> {
  const db = getDbPg();
  const rows = await db<TalkFolderRecord[]>`
    update public.talk_folders
    set title = ${input.title}, updated_at = now()
    where id = ${input.id}::uuid
    returning ${db.unsafe(TALK_FOLDER_COLUMNS)}
  `;
  return rows[0];
}

export async function deleteTalkFolderAndMoveTalksToTopLevel(input: {
  id: string;
  ownerId: string;
}): Promise<boolean> {
  const db = getDbPg();
  // Move every talk in the folder to top-level, append to the end. Then
  // delete the folder row. RLS USING filters protect cross-user attempts.
  const maxRootTalk = await db<{ value: number }[]>`
    select coalesce(max(sort_order), -1)::int as value
    from public.talks
    where owner_id = ${input.ownerId}::uuid and folder_id is null
  `;
  const maxRootFolder = await db<{ value: number }[]>`
    select coalesce(max(sort_order), -1)::int as value
    from public.talk_folders
    where owner_id = ${input.ownerId}::uuid
  `;
  let nextSort =
    Math.max(maxRootTalk[0]?.value ?? -1, maxRootFolder[0]?.value ?? -1) + 1;
  const folderTalks = await db<{ id: string }[]>`
    select id from public.talks
    where folder_id = ${input.id}::uuid
    order by sort_order asc, created_at asc, id asc
  `;
  for (const t of folderTalks) {
    await db`
      update public.talks
      set folder_id = null, sort_order = ${nextSort}, updated_at = now()
      where id = ${t.id}::uuid
    `;
    nextSort += 1;
  }
  const result = await db<{ id: string }[]>`
    delete from public.talk_folders
    where id = ${input.id}::uuid
    returning id
  `;
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Sidebar tree + reorder helpers
//
// All of the sidebar surface runs inside withUserContext, so RLS pins
// every read and write to the caller. The sqlite-era helpers took an
// ownerId param as an authorization assertion; that's dropped here
// since RLS makes it both redundant (USING-clause filter) and
// uneforceable (WITH CHECK matches the user-context auth.uid()).
// ---------------------------------------------------------------------------

async function getTalkFolderById(
  folderId: string,
): Promise<TalkFolderRecord | undefined> {
  const db = getDbPg();
  const rows = await db<TalkFolderRecord[]>`
    select ${db.unsafe(TALK_FOLDER_COLUMNS)}
    from public.talk_folders
    where id = ${folderId}::uuid
    limit 1
  `;
  return rows[0];
}

async function listOwnedRootSidebarItems(): Promise<
  Array<{ type: 'talk' | 'folder'; id: string; sort_order: number }>
> {
  const db = getDbPg();
  return await db<
    Array<{ type: 'talk' | 'folder'; id: string; sort_order: number }>
  >`
    select 'talk'::text as type, id, sort_order
    from public.talks
    where folder_id is null
    union all
    select 'folder'::text as type, id, sort_order
    from public.talk_folders
    order by sort_order asc, id asc
  `;
}

async function listOwnedFolderTalkIds(folderId: string): Promise<string[]> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    select id from public.talks
    where folder_id = ${folderId}::uuid
    order by sort_order asc, created_at asc, id asc
  `;
  return rows.map((row) => row.id);
}

async function writeRootSidebarOrder(
  items: Array<{ type: 'talk' | 'folder'; id: string }>,
): Promise<void> {
  const db = getDbPg();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === 'talk') {
      await db`
        update public.talks
        set sort_order = ${index}
        where id = ${item.id}::uuid and folder_id is null
      `;
    } else {
      await db`
        update public.talk_folders
        set sort_order = ${index}
        where id = ${item.id}::uuid
      `;
    }
  }
}

async function writeFolderTalkOrder(
  folderId: string,
  talkIds: string[],
): Promise<void> {
  const db = getDbPg();
  for (let index = 0; index < talkIds.length; index += 1) {
    await db`
      update public.talks
      set sort_order = ${index}
      where id = ${talkIds[index]}::uuid and folder_id = ${folderId}::uuid
    `;
  }
}

export async function listTalkSidebarTreeForUser(input?: {
  status?: 'active' | 'paused' | 'archived';
}): Promise<TalkSidebarTreeRecord> {
  const folders = await listTalkFoldersForOwner();
  // Sidebar trees stay intentionally small in v1; this ceiling avoids
  // pulling an unbounded root list while still covering normal usage.
  const rawTalks = await listTalksForUser({
    limit: 1000,
    offset: 0,
    status: input?.status ?? 'active',
  });
  const talkIds = rawTalks.map((talk) => talk.id);

  const metricsByTalkId = new Map<
    string,
    {
      lastMessageAt: string | null;
      messageCount: number;
      hasActiveRun: boolean;
    }
  >();

  if (talkIds.length > 0) {
    const db = getDbPg();
    const messageRows = await db<
      Array<{
        talk_id: string;
        message_count: number;
        last_message_at: string | null;
      }>
    >`
      select talk_id, count(*)::int as message_count,
             max(created_at) as last_message_at
      from public.talk_messages
      where talk_id in ${db(talkIds)}
      group by talk_id
    `;
    for (const row of messageRows) {
      metricsByTalkId.set(row.talk_id, {
        lastMessageAt: row.last_message_at,
        messageCount: row.message_count,
        hasActiveRun: false,
      });
    }
    const runRows = await db<
      Array<{ talk_id: string; active_run_count: number }>
    >`
      select talk_id, count(*)::int as active_run_count
      from public.talk_runs
      where talk_id in ${db(talkIds)}
        and status in ('queued', 'running', 'awaiting_confirmation')
      group by talk_id
    `;
    for (const row of runRows) {
      const current = metricsByTalkId.get(row.talk_id) ?? {
        lastMessageAt: null,
        messageCount: 0,
        hasActiveRun: false,
      };
      metricsByTalkId.set(row.talk_id, {
        ...current,
        hasActiveRun: row.active_run_count > 0,
      });
    }
  }

  const talks: TalkSidebarTalkRecord[] = rawTalks.map((talk) => ({
    id: talk.id,
    owner_id: talk.owner_id,
    folder_id: talk.folder_id,
    sort_order: talk.sort_order,
    topic_title: talk.topic_title,
    status: talk.status,
    version: talk.version,
    created_at: talk.created_at,
    updated_at: talk.updated_at,
    access_role: talk.access_role,
    last_message_at: metricsByTalkId.get(talk.id)?.lastMessageAt ?? null,
    message_count: metricsByTalkId.get(talk.id)?.messageCount ?? 0,
    has_active_run: metricsByTalkId.get(talk.id)?.hasActiveRun ?? false,
  }));
  const rootTalks = talks
    .filter((talk) => talk.folder_id === null)
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at),
    );
  const talksByFolderId = folders.reduce<
    Record<string, TalkSidebarTalkRecord[]>
  >((acc, folder) => {
    acc[folder.id] = talks
      .filter((talk) => talk.folder_id === folder.id)
      .sort(
        (a, b) =>
          a.sort_order - b.sort_order ||
          a.created_at.localeCompare(b.created_at),
      );
    return acc;
  }, {});
  return { folders, rootTalks, talksByFolderId };
}

export async function reorderTalkSidebarItem(input: {
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): Promise<boolean> {
  // Folders only live at root — refuse a folder→folder move.
  if (input.itemType === 'folder' && input.destinationFolderId !== null) {
    return false;
  }

  const talk =
    input.itemType === 'talk' ? await getTalkById(input.itemId) : undefined;
  const folder =
    input.itemType === 'folder'
      ? await getTalkFolderById(input.itemId)
      : undefined;
  if (input.itemType === 'talk') {
    if (!talk) return false;
    if (
      input.destinationFolderId !== null &&
      !(await getTalkFolderById(input.destinationFolderId))
    ) {
      return false;
    }
  } else if (!folder) {
    return false;
  }

  // Folder reorder: only touches the root list.
  if (input.itemType === 'folder') {
    const rootItems = (await listOwnedRootSidebarItems())
      .filter((item) => !(item.type === 'folder' && item.id === input.itemId))
      .map((item) => ({ type: item.type, id: item.id }));
    const index = Math.max(
      0,
      Math.min(input.destinationIndex, rootItems.length),
    );
    rootItems.splice(index, 0, { type: 'folder', id: input.itemId });
    await writeRootSidebarOrder(rootItems);
    return true;
  }

  // Talk move — same-parent reorder is the cheap path.
  const sourceFolderId = talk!.folder_id;
  if (sourceFolderId === input.destinationFolderId) {
    if (sourceFolderId === null) {
      const rootItems = (await listOwnedRootSidebarItems())
        .filter((item) => !(item.type === 'talk' && item.id === input.itemId))
        .map((item) => ({ type: item.type, id: item.id }));
      const index = Math.max(
        0,
        Math.min(input.destinationIndex, rootItems.length),
      );
      rootItems.splice(index, 0, { type: 'talk', id: input.itemId });
      await writeRootSidebarOrder(rootItems);
    } else {
      const talkIds = (await listOwnedFolderTalkIds(sourceFolderId)).filter(
        (id) => id !== input.itemId,
      );
      const index = Math.max(
        0,
        Math.min(input.destinationIndex, talkIds.length),
      );
      talkIds.splice(index, 0, input.itemId);
      await writeFolderTalkOrder(sourceFolderId, talkIds);
    }
    return true;
  }

  // Cross-parent move: compact the source list first, then insert into
  // the destination at the requested index.
  if (sourceFolderId === null) {
    const rootItems = (await listOwnedRootSidebarItems())
      .filter((item) => !(item.type === 'talk' && item.id === input.itemId))
      .map((item) => ({ type: item.type, id: item.id }));
    await writeRootSidebarOrder(rootItems);
  } else {
    const sourceTalkIds = (await listOwnedFolderTalkIds(sourceFolderId)).filter(
      (id) => id !== input.itemId,
    );
    await writeFolderTalkOrder(sourceFolderId, sourceTalkIds);
  }

  const db = getDbPg();
  if (input.destinationFolderId === null) {
    const rootItems = (await listOwnedRootSidebarItems()).map((item) => ({
      type: item.type,
      id: item.id,
    }));
    const index = Math.max(
      0,
      Math.min(input.destinationIndex, rootItems.length),
    );
    rootItems.splice(index, 0, { type: 'talk', id: input.itemId });
    await db`
      update public.talks
      set folder_id = null,
          updated_at = now(),
          version = version + 1
      where id = ${input.itemId}::uuid
    `;
    await writeRootSidebarOrder(rootItems);
  } else {
    const talkIds = await listOwnedFolderTalkIds(input.destinationFolderId);
    const index = Math.max(0, Math.min(input.destinationIndex, talkIds.length));
    talkIds.splice(index, 0, input.itemId);
    await db`
      update public.talks
      set folder_id = ${input.destinationFolderId}::uuid,
          updated_at = now(),
          version = version + 1
      where id = ${input.itemId}::uuid
    `;
    await writeFolderTalkOrder(input.destinationFolderId, talkIds);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Talk members + access helpers
// ---------------------------------------------------------------------------

export async function upsertTalkMember(input: {
  talkId: string;
  userId: string;
  role: TalkAccessRole;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_members (talk_id, user_id, role)
    values (${input.talkId}::uuid, ${input.userId}::uuid, ${input.role})
    on conflict (talk_id, user_id) do update set role = excluded.role
  `;
}

export async function deleteTalkMember(input: {
  talkId: string;
  userId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ talk_id: string }[]>`
    delete from public.talk_members
    where talk_id = ${input.talkId}::uuid
      and user_id = ${input.userId}::uuid
    returning talk_id
  `;
  return rows.length > 0;
}

export async function canUserAccessTalk(talkId: string): Promise<boolean> {
  // Under RLS, "can the caller see this talk?" reduces to "does the
  // SELECT return a row?" — the policy filters on owner_id = auth.uid()
  // OR membership. Sharing is not in the talks RLS policy yet (only
  // owner_id), so this currently only returns true for the owner. When
  // sharing ships, expand the talks policy and this helper becomes
  // correct automatically.
  const talk = await getTalkById(talkId);
  return talk !== undefined;
}

export async function canUserEditTalk(talkId: string): Promise<boolean> {
  // Same caveat: RLS-defined edit access. Owner-only for now.
  const talk = await getTalkById(talkId);
  return talk !== undefined;
}

export async function getTalkIdsAccessibleByUser(): Promise<string[]> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    select id from public.talks
  `;
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Talk threads
// ---------------------------------------------------------------------------

export interface TalkThreadRecord {
  id: string;
  talk_id: string;
  owner_id: string;
  title: string | null;
  is_default: boolean;
  is_internal: boolean;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

const TALK_THREAD_COLUMNS = `id, talk_id, owner_id, title, is_default,
  is_internal, is_pinned, created_at, updated_at`;

export async function getOrCreateDefaultThread(input: {
  talkId: string;
  ownerId: string;
}): Promise<string> {
  const db = getDbPg();
  const existing = await db<{ id: string }[]>`
    select id from public.talk_threads
    where talk_id = ${input.talkId}::uuid and is_default = true
    limit 1
  `;
  if (existing[0]) return existing[0].id;

  const inserted = await db<{ id: string }[]>`
    insert into public.talk_threads
      (talk_id, owner_id, title, is_default, is_internal)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, null, true, false)
    returning id
  `;
  return inserted[0].id;
}

export interface TalkThreadWithMetrics extends TalkThreadRecord {
  message_count: number;
  last_message_at: string | null;
}

export async function listTalkThreads(input: {
  talkId: string;
  ownerId: string;
}): Promise<TalkThreadWithMetrics[]> {
  // Heal-on-read: ensure a default thread exists so the UI always has
  // somewhere to post.
  await getOrCreateDefaultThread(input);
  const db = getDbPg();
  const rows = await db<
    Array<
      TalkThreadRecord & {
        message_count: number;
        last_message_at: string | null;
      }
    >
  >`
    select t.id, t.talk_id, t.owner_id, t.title, t.is_default, t.is_internal,
           t.is_pinned, t.created_at, t.updated_at,
           coalesce(m.message_count, 0)::int as message_count,
           m.last_message_at
    from public.talk_threads t
    left join (
      select thread_id, count(*)::int as message_count,
             max(created_at) as last_message_at
      from public.talk_messages
      where talk_id = ${input.talkId}::uuid
      group by thread_id
    ) m on m.thread_id = t.id
    where t.talk_id = ${input.talkId}::uuid and t.is_internal = false
    order by t.is_pinned desc, coalesce(m.last_message_at, t.created_at) desc
  `;
  return rows;
}

export async function createTalkThread(input: {
  ownerId: string;
  talkId: string;
  title?: string | null;
  isInternal?: boolean;
}): Promise<TalkThreadRecord> {
  const normalizedTitle = normalizeStoredThreadTitle(input.title ?? null);
  const db = getDbPg();
  const rows = await db<TalkThreadRecord[]>`
    insert into public.talk_threads
      (talk_id, owner_id, title, is_default, is_internal)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, ${normalizedTitle},
       false, ${input.isInternal ?? false})
    returning ${db.unsafe(TALK_THREAD_COLUMNS)}
  `;
  return rows[0];
}

export async function updateTalkThreadMetadata(input: {
  talkId: string;
  threadId: string;
  title?: string;
  pinned?: boolean;
}): Promise<TalkThreadRecord | null> {
  const normalizedTitle =
    input.title === undefined
      ? undefined
      : validateEditableThreadTitle(input.title);
  const db = getDbPg();
  const rows = await db<TalkThreadRecord[]>`
    update public.talk_threads
    set title = case when ${normalizedTitle !== undefined}::boolean
                  then ${normalizedTitle ?? null} else title end,
        is_pinned = coalesce(${input.pinned ?? null}::boolean, is_pinned),
        updated_at = now()
    where id = ${input.threadId}::uuid and talk_id = ${input.talkId}::uuid
    returning ${db.unsafe(TALK_THREAD_COLUMNS)}
  `;
  return rows[0] ?? null;
}

export async function updateTalkThreadTitle(input: {
  talkId: string;
  threadId: string;
  title: string;
}): Promise<TalkThreadRecord | null> {
  const updated = await updateTalkThreadMetadata(input);
  if (!updated || updated.title === null) return null;
  return updated;
}

export async function deleteTalkThread(input: {
  talkId: string;
  threadId: string;
}): Promise<boolean> {
  // Refuse to delete the default thread — UI invariant.
  const db = getDbPg();
  const thread = await db<{ is_default: boolean }[]>`
    select is_default from public.talk_threads
    where id = ${input.threadId}::uuid and talk_id = ${input.talkId}::uuid
    limit 1
  `;
  if (!thread[0]) return false;
  if (thread[0].is_default) {
    throw new Error('Cannot delete the default thread');
  }
  const rows = await db<{ id: string }[]>`
    delete from public.talk_threads
    where id = ${input.threadId}::uuid and talk_id = ${input.talkId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function resolveThreadIdForTalk(input: {
  talkId: string;
  threadId?: string | null;
  ownerId: string;
}): Promise<string> {
  if (input.threadId) {
    const db = getDbPg();
    const exists = await db<{ id: string }[]>`
      select id from public.talk_threads
      where id = ${input.threadId}::uuid and talk_id = ${input.talkId}::uuid
      limit 1
    `;
    if (exists[0]) return exists[0].id;
  }
  return await getOrCreateDefaultThread({
    talkId: input.talkId,
    ownerId: input.ownerId,
  });
}

// ---------------------------------------------------------------------------
// Talk messages
// ---------------------------------------------------------------------------

export type TalkMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface TalkMessageRecord {
  id: string;
  talk_id: string | null;
  thread_id: string;
  owner_id: string;
  role: TalkMessageRole;
  content: string;
  created_by: string | null;
  created_at: string;
  run_id: string | null;
  metadata_json: Record<string, unknown> | null;
  sequence_in_run: number | null;
}

const TALK_MESSAGE_COLUMNS = `id, talk_id, thread_id, owner_id, role, content,
  created_by, created_at, run_id, metadata_json, sequence_in_run`;

export async function createTalkMessage(input: {
  ownerId: string;
  id?: string;
  talkId: string;
  threadId: string;
  role: TalkMessageRole;
  content: string;
  createdBy?: string | null;
  runId?: string | null;
  metadata?: Record<string, unknown> | null;
  sequenceInRun?: number | null;
  createdAt?: string;
}): Promise<TalkMessageRecord> {
  const db = getDbPg();
  const metadata =
    input.metadata && Object.keys(input.metadata).length > 0
      ? db.json(input.metadata as never)
      : null;
  // Always bind created_at as a real timestamptz parameter — postgres.js's
  // db.unsafe() doesn't inline as raw SQL when nested inside a tagged
  // template, it gets parameterized as a string literal. Fall back to
  // client-side now() to match the column default behavior.
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rows = input.id
    ? await db<TalkMessageRecord[]>`
        insert into public.talk_messages
          (id, talk_id, thread_id, owner_id, role, content, created_by,
           run_id, metadata_json, sequence_in_run, created_at)
        values
          (${input.id}::uuid, ${input.talkId}::uuid, ${input.threadId}::uuid,
           ${input.ownerId}::uuid, ${input.role}, ${input.content},
           ${input.createdBy ?? null}::uuid, ${input.runId ?? null}::uuid,
           ${metadata}, ${input.sequenceInRun ?? null},
           ${createdAt}::timestamptz)
        returning ${db.unsafe(TALK_MESSAGE_COLUMNS)}
      `
    : await db<TalkMessageRecord[]>`
        insert into public.talk_messages
          (talk_id, thread_id, owner_id, role, content, created_by,
           run_id, metadata_json, sequence_in_run, created_at)
        values
          (${input.talkId}::uuid, ${input.threadId}::uuid,
           ${input.ownerId}::uuid, ${input.role}, ${input.content},
           ${input.createdBy ?? null}::uuid, ${input.runId ?? null}::uuid,
           ${metadata}, ${input.sequenceInRun ?? null},
           ${createdAt}::timestamptz)
        returning ${db.unsafe(TALK_MESSAGE_COLUMNS)}
      `;
  return rows[0];
}

export async function listTalkMessages(input: {
  talkId: string;
  threadId?: string | null;
  limit?: number;
  beforeCreatedAt?: string;
}): Promise<TalkMessageRecord[]> {
  const limit =
    typeof input.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 100;
  const threadId = input.threadId ?? null;
  const before = input.beforeCreatedAt ?? null;
  const db = getDbPg();
  const rows = await db<TalkMessageRecord[]>`
    select ${db.unsafe(TALK_MESSAGE_COLUMNS)}
    from public.talk_messages
    where talk_id = ${input.talkId}::uuid
      and (${threadId}::uuid is null or thread_id = ${threadId}::uuid)
      and (${before}::timestamptz is null or created_at < ${before}::timestamptz)
    order by created_at desc, coalesce(sequence_in_run, 0) desc, id desc
    limit ${limit}
  `;
  rows.reverse();
  return rows;
}

export async function searchTalkMessages(input: {
  talkId: string;
  query: string;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    thread_id: string;
    thread_title: string | null;
    role: TalkMessageRole;
    content: string;
    created_at: string;
  }>
> {
  const normalizedQuery = input.query.trim();
  const limit =
    typeof input.limit === 'number'
      ? Math.min(50, Math.max(1, Math.floor(input.limit)))
      : 20;
  if (normalizedQuery.length === 0) return [];

  const escaped = normalizedQuery.replace(/[\\%_]/g, (c) => `\\${c}`);
  const likePattern = `%${escaped}%`;
  const db = getDbPg();
  return await db<
    Array<{
      id: string;
      thread_id: string;
      thread_title: string | null;
      role: TalkMessageRole;
      content: string;
      created_at: string;
    }>
  >`
    select m.id, m.thread_id, t.title as thread_title, m.role, m.content,
           m.created_at
    from public.talk_messages m
    left join public.talk_threads t on t.id = m.thread_id
    where m.talk_id = ${input.talkId}::uuid
      and m.content like ${likePattern} escape E'\\\\'
    order by m.created_at desc, coalesce(m.sequence_in_run, 0) desc, m.id desc
    limit ${limit}
  `;
}

export async function getTalkMessageById(
  messageId: string,
): Promise<TalkMessageRecord | undefined> {
  const db = getDbPg();
  const rows = await db<TalkMessageRecord[]>`
    select ${db.unsafe(TALK_MESSAGE_COLUMNS)}
    from public.talk_messages
    where id = ${messageId}::uuid
    limit 1
  `;
  return rows[0];
}

// ---------------------------------------------------------------------------
// deleteTalkMessagesAtomic — multi-row delete with validation + outbox emit.
//
// Validates: (a) every id resolves to a row on (talkId), (b) no system
// messages in the batch, (c) every row belongs to the requested thread,
// (d) the thread has no active runs. Then NULLs trigger_message_id on any
// talk_runs that point at deleted ids and finally deletes the messages.
//
// The sqlite-era executor-session reset is dropped (chassis removal —
// talk_executor_sessions doesn't exist in pg). Callers don't need to
// invoke anything similar; executor state lives inside the run record.
// ---------------------------------------------------------------------------

export async function deleteTalkMessagesAtomic(input: {
  talkId: string;
  threadId: string;
  messageIds: string[];
  now?: string;
}): Promise<{ deletedCount: number; deletedMessageIds: string[] }> {
  const normalizedIds = Array.from(
    new Set(
      input.messageIds
        .map((messageId) => messageId.trim())
        .filter((messageId) => messageId.length > 0),
    ),
  );
  if (normalizedIds.length === 0) {
    throw new Error('talk history edit requires at least one message');
  }

  const db = getDbPg();
  const rows = await db<
    Array<{ id: string; role: TalkMessageRole; thread_id: string }>
  >`
    select id, role, thread_id
    from public.talk_messages
    where talk_id = ${input.talkId}::uuid
      and id in ${db(normalizedIds)}
  `;
  if (rows.length !== normalizedIds.length) {
    throw new Error('one or more talk messages were not found');
  }
  if (rows.some((row) => row.role === 'system')) {
    throw new Error('system messages cannot be deleted');
  }
  const threadIds = Array.from(new Set(rows.map((row) => row.thread_id)));
  if (threadIds.length !== 1 || threadIds[0] !== input.threadId) {
    throw new Error('selected messages do not belong to the requested thread');
  }
  if (
    await hasActiveTalkRuns({
      talkId: input.talkId,
      threadId: input.threadId,
    })
  ) {
    throw new TalkActiveRoundError('thread');
  }

  const now = input.now ?? new Date().toISOString();
  await db`
    update public.talk_runs
    set trigger_message_id = null
    where talk_id = ${input.talkId}::uuid
      and thread_id = ${input.threadId}::uuid
      and trigger_message_id in ${db(normalizedIds)}
  `;
  await db`
    delete from public.talk_messages
    where talk_id = ${input.talkId}::uuid
      and id in ${db(normalizedIds)}
  `;
  await touchTalkUpdatedAt(input.talkId, now);
  await appendOutboxEvent({
    topic: `talk:${input.talkId}`,
    eventType: 'talk_history_edited',
    payload: {
      talkId: input.talkId,
      threadIds: [input.threadId],
      deletedCount: normalizedIds.length,
      deletedMessageIds: normalizedIds,
      editedAt: now,
    },
  });
  return {
    deletedCount: normalizedIds.length,
    deletedMessageIds: normalizedIds,
  };
}

// ---------------------------------------------------------------------------
// Talk runs
// ---------------------------------------------------------------------------

export type TalkRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'cancelled'
  | 'completed'
  | 'failed';

export type TalkRunKind = 'conversation' | 'instruction_review';
export type TalkRunTaskType = 'chat' | 'browser';
export type TalkRunSelectedMode = 'api' | 'subscription';
export type TalkRunTransport = 'direct' | 'subscription';

// Browser-block surface (browser_phase / blocked_reason / browser_session_id)
// is intentionally dropped — the browser execution chassis was removed in
// Phase 1. Callers that referenced those fields under sqlite need their
// own cleanup pass when they swap over.

export interface TalkRunRecord {
  id: string;
  talk_id: string | null;
  owner_id: string;
  thread_id: string;
  requested_by: string;
  status: TalkRunStatus;
  trigger_message_id: string | null;
  job_id: string | null;
  target_agent_id: string | null;
  agent_id: string | null;
  idempotency_key: string | null;
  run_kind: TalkRunKind;
  response_group_id: string | null;
  sequence_index: number | null;
  executor_alias: string | null;
  executor_model: string | null;
  source_binding_id: string | null;
  source_external_message_id: string | null;
  source_thread_key: string | null;
  task_type: TalkRunTaskType | null;
  selected_mode: TalkRunSelectedMode | null;
  transport: TalkRunTransport | null;
  timeout_phase: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_reason: string | null;
  metadata_json: Record<string, unknown> | null;
}

const TALK_RUN_COLUMNS = `id, talk_id, owner_id, thread_id, requested_by,
  status, trigger_message_id, job_id, target_agent_id, agent_id,
  idempotency_key, run_kind, response_group_id, sequence_index,
  executor_alias, executor_model, source_binding_id,
  source_external_message_id, source_thread_key, task_type, selected_mode,
  transport, timeout_phase, created_at, started_at, ended_at, cancel_reason,
  metadata_json`;

export async function createTalkRun(input: {
  ownerId: string;
  id?: string;
  talkId: string | null;
  threadId: string;
  requestedBy: string;
  status: TalkRunStatus;
  triggerMessageId?: string | null;
  jobId?: string | null;
  targetAgentId?: string | null;
  agentId?: string | null;
  idempotencyKey?: string | null;
  runKind?: TalkRunKind;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  executorAlias?: string | null;
  executorModel?: string | null;
  sourceBindingId?: string | null;
  sourceExternalMessageId?: string | null;
  sourceThreadKey?: string | null;
  taskType?: TalkRunTaskType | null;
  selectedMode?: TalkRunSelectedMode | null;
  transport?: TalkRunTransport | null;
  timeoutPhase?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<TalkRunRecord> {
  const db = getDbPg();
  const metadata = input.metadata ? db.json(input.metadata as never) : null;
  const rows = input.id
    ? await db<TalkRunRecord[]>`
        insert into public.talk_runs
          (id, talk_id, owner_id, thread_id, requested_by, status,
           trigger_message_id, job_id, target_agent_id, agent_id,
           idempotency_key, run_kind, response_group_id, sequence_index,
           executor_alias, executor_model, source_binding_id,
           source_external_message_id, source_thread_key, task_type,
           selected_mode, transport, timeout_phase, metadata_json)
        values
          (${input.id}::uuid, ${input.talkId}::uuid, ${input.ownerId}::uuid,
           ${input.threadId}::uuid, ${input.requestedBy}::uuid,
           ${input.status},
           ${input.triggerMessageId ?? null}::uuid,
           ${input.jobId ?? null}::uuid,
           ${input.targetAgentId ?? null}::uuid,
           ${input.agentId ?? null}::uuid,
           ${input.idempotencyKey ?? null},
           ${input.runKind ?? 'conversation'},
           ${input.responseGroupId ?? null},
           ${input.sequenceIndex ?? null},
           ${input.executorAlias ?? null},
           ${input.executorModel ?? null},
           ${input.sourceBindingId ?? null},
           ${input.sourceExternalMessageId ?? null},
           ${input.sourceThreadKey ?? null},
           ${input.taskType ?? null},
           ${input.selectedMode ?? null},
           ${input.transport ?? null},
           ${input.timeoutPhase ?? null},
           ${metadata})
        returning ${db.unsafe(TALK_RUN_COLUMNS)}
      `
    : await db<TalkRunRecord[]>`
        insert into public.talk_runs
          (talk_id, owner_id, thread_id, requested_by, status,
           trigger_message_id, job_id, target_agent_id, agent_id,
           idempotency_key, run_kind, response_group_id, sequence_index,
           executor_alias, executor_model, source_binding_id,
           source_external_message_id, source_thread_key, task_type,
           selected_mode, transport, timeout_phase, metadata_json)
        values
          (${input.talkId}::uuid, ${input.ownerId}::uuid,
           ${input.threadId}::uuid, ${input.requestedBy}::uuid,
           ${input.status},
           ${input.triggerMessageId ?? null}::uuid,
           ${input.jobId ?? null}::uuid,
           ${input.targetAgentId ?? null}::uuid,
           ${input.agentId ?? null}::uuid,
           ${input.idempotencyKey ?? null},
           ${input.runKind ?? 'conversation'},
           ${input.responseGroupId ?? null},
           ${input.sequenceIndex ?? null},
           ${input.executorAlias ?? null},
           ${input.executorModel ?? null},
           ${input.sourceBindingId ?? null},
           ${input.sourceExternalMessageId ?? null},
           ${input.sourceThreadKey ?? null},
           ${input.taskType ?? null},
           ${input.selectedMode ?? null},
           ${input.transport ?? null},
           ${input.timeoutPhase ?? null},
           ${metadata})
        returning ${db.unsafe(TALK_RUN_COLUMNS)}
      `;
  return rows[0];
}

export async function getTalkRunById(
  runId: string,
): Promise<TalkRunRecord | null> {
  const db = getDbPg();
  const rows = await db<TalkRunRecord[]>`
    select ${db.unsafe(TALK_RUN_COLUMNS)}
    from public.talk_runs
    where id = ${runId}::uuid
    limit 1
  `;
  return rows[0] ?? null;
}

export async function getRunningTalkRun(
  talkId: string,
): Promise<TalkRunRecord | null> {
  const db = getDbPg();
  const rows = await db<TalkRunRecord[]>`
    select ${db.unsafe(TALK_RUN_COLUMNS)}
    from public.talk_runs
    where talk_id = ${talkId}::uuid
      and status in ('running', 'awaiting_confirmation')
    order by created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

export async function listQueuedTalkRuns(limit = 50): Promise<TalkRunRecord[]> {
  const db = getDbPg();
  return await db<TalkRunRecord[]>`
    select ${db.unsafe(TALK_RUN_COLUMNS)}
    from public.talk_runs
    where status = 'queued'
    order by created_at asc
    limit ${limit}
  `;
}

export async function listRunningTalkRuns(
  limit = 50,
): Promise<TalkRunRecord[]> {
  const db = getDbPg();
  return await db<TalkRunRecord[]>`
    select ${db.unsafe(TALK_RUN_COLUMNS)}
    from public.talk_runs
    where status in ('running', 'awaiting_confirmation')
    order by started_at asc nulls last, created_at asc
    limit ${limit}
  `;
}

export async function countRunningTalkRuns(): Promise<number> {
  const db = getDbPg();
  const rows = await db<{ count: number }[]>`
    select count(*)::int as count
    from public.talk_runs
    where status in ('running', 'awaiting_confirmation')
  `;
  return rows[0]?.count ?? 0;
}

export async function hasActiveTalkRuns(input: {
  talkId: string;
  threadId?: string | null;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = input.threadId
    ? await db<{ count: number }[]>`
        select count(*)::int as count
        from public.talk_runs
        where talk_id = ${input.talkId}::uuid
          and thread_id = ${input.threadId}::uuid
          and status in ('queued', 'running', 'awaiting_confirmation')
      `
    : await db<{ count: number }[]>`
        select count(*)::int as count
        from public.talk_runs
        where talk_id = ${input.talkId}::uuid
          and status in ('queued', 'running', 'awaiting_confirmation')
      `;
  return (rows[0]?.count ?? 0) > 0;
}

export async function listTalkRunsForTalk(
  talkId: string,
  limit = 100,
): Promise<TalkRunRecord[]> {
  const db = getDbPg();
  return await db<TalkRunRecord[]>`
    select ${db.unsafe(TALK_RUN_COLUMNS)}
    from public.talk_runs
    where talk_id = ${talkId}::uuid
    order by created_at desc
    limit ${limit}
  `;
}

export async function markTalkRunStatus(
  runId: string,
  status: TalkRunStatus,
  patch?: {
    startedAt?: string | null;
    endedAt?: string | null;
    cancelReason?: string | null;
  },
): Promise<TalkRunRecord | null> {
  const db = getDbPg();
  const rows = await db<TalkRunRecord[]>`
    update public.talk_runs
    set status = ${status},
        started_at = case when ${patch?.startedAt !== undefined}::boolean
                       then ${patch?.startedAt ?? null}::timestamptz
                       else started_at end,
        ended_at = case when ${patch?.endedAt !== undefined}::boolean
                     then ${patch?.endedAt ?? null}::timestamptz
                     else ended_at end,
        cancel_reason = case when ${patch?.cancelReason !== undefined}::boolean
                          then ${patch?.cancelReason ?? null}
                          else cancel_reason end
    where id = ${runId}::uuid
    returning ${db.unsafe(TALK_RUN_COLUMNS)}
  `;
  return rows[0] ?? null;
}

export async function setTalkRunMetadata(
  runId: string,
  metadata: Record<string, unknown> | null,
): Promise<void> {
  const db = getDbPg();
  await db`
    update public.talk_runs
    set metadata_json = ${metadata ? db.json(metadata as never) : null}
    where id = ${runId}::uuid
  `;
}

export async function updateTalkRunMetadata(
  runId: string,
  patch: Record<string, unknown>,
): Promise<TalkRunRecord | null> {
  // Shallow merge over existing metadata. Postgres jsonb `||` merges
  // top-level keys (right overrides left).
  const db = getDbPg();
  const rows = await db<TalkRunRecord[]>`
    update public.talk_runs
    set metadata_json = coalesce(metadata_json, '{}'::jsonb)
                        || ${db.json(patch as never)}
    where id = ${runId}::uuid
    returning ${db.unsafe(TALK_RUN_COLUMNS)}
  `;
  return rows[0] ?? null;
}

export async function setTalkRunExecutorProfile(input: {
  runId: string;
  executorAlias: string;
  executorModel: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    update public.talk_runs
    set executor_alias = ${input.executorAlias},
        executor_model = ${input.executorModel}
    where id = ${input.runId}::uuid
  `;
}

// ---------------------------------------------------------------------------
// Run metadata derivation helpers
// (browser-block surface dropped — chassis removal)
// ---------------------------------------------------------------------------

export function normalizeTalkRunTaskType(
  value: unknown,
): TalkRunTaskType | null {
  return value === 'chat' || value === 'browser' ? value : null;
}

export function normalizeTalkRunSelectedMode(
  value: unknown,
): TalkRunSelectedMode | null {
  return value === 'api' || value === 'subscription' ? value : null;
}

export function normalizeTalkRunTransport(
  value: unknown,
): TalkRunTransport | null {
  return value === 'direct' || value === 'subscription' ? value : null;
}

export function getTalkRunTaskType(
  run: Pick<TalkRunRecord, 'task_type' | 'metadata_json'>,
): TalkRunTaskType {
  const typed = normalizeTalkRunTaskType(run.task_type);
  if (typed) return typed;
  const meta = run.metadata_json ?? {};
  if (
    meta.executionStrategy === 'browser_fast_lane' ||
    meta.routeReason === 'browser_fast_lane'
  ) {
    return 'browser';
  }
  return 'chat';
}

export function getTalkRunSelectedMode(
  run: Pick<TalkRunRecord, 'selected_mode' | 'metadata_json'>,
): TalkRunSelectedMode | null {
  const typed = normalizeTalkRunSelectedMode(run.selected_mode);
  if (typed) return typed;
  const meta = run.metadata_json ?? {};
  const decision =
    meta.executionDecision &&
    typeof meta.executionDecision === 'object' &&
    !Array.isArray(meta.executionDecision)
      ? (meta.executionDecision as Record<string, unknown>)
      : null;
  if (decision?.authPath === 'api_key') return 'api';
  if (decision?.authPath === 'subscription') return 'subscription';
  return null;
}

export function getTalkRunTransport(
  run: Pick<TalkRunRecord, 'transport' | 'metadata_json'>,
): TalkRunTransport | null {
  const typed = normalizeTalkRunTransport(run.transport);
  if (typed) return typed;
  const meta = run.metadata_json ?? {};
  const decision =
    meta.executionDecision &&
    typeof meta.executionDecision === 'object' &&
    !Array.isArray(meta.executionDecision)
      ? (meta.executionDecision as Record<string, unknown>)
      : null;
  if (decision?.backend === 'direct_http') return 'direct';
  if (decision?.backend === 'container') return 'subscription';
  return null;
}

export function getTalkRunTimeoutPhase(
  run: Pick<TalkRunRecord, 'timeout_phase' | 'metadata_json'>,
): string | null {
  if (typeof run.timeout_phase === 'string' && run.timeout_phase) {
    return run.timeout_phase;
  }
  const meta = run.metadata_json ?? {};
  return typeof meta.timeoutPhase === 'string' ? meta.timeoutPhase : null;
}

// ---------------------------------------------------------------------------
// Event outbox
//
// Migration 0003 grants INSERT + SELECT on event_outbox to the
// authenticated role. The table itself has no RLS — topic-level
// authorization happens at the route layer (the SSE subscribe handler
// verifies the caller can read talk:${talkId}). Payload is jsonb in pg,
// so accessor accepts/returns objects directly.
// ---------------------------------------------------------------------------

export interface OutboxEvent {
  event_id: number;
  topic: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function appendOutboxEvent(input: {
  topic: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<number> {
  const db = getDbPg();
  // event_id is bigserial → postgres.js serializes as string by default
  // (to avoid JS number-precision loss on >2^53 values). Cast to int so
  // we get a JS number back. ClawTalk's outbox throughput is nowhere
  // close to int range; revisit if that changes.
  const rows = await db<{ event_id: number }[]>`
    insert into public.event_outbox (topic, event_type, payload)
    values (${input.topic}, ${input.eventType},
            ${db.json(input.payload as never)})
    returning event_id::int as event_id
  `;
  const eventId = rows[0].event_id;
  // Process-local wakeup for in-process SSE consumers. Cloudflare Workers
  // doesn't share processes across requests, so this is a no-op there;
  // the Workers cutover (task #18) will replace this with a polling-based
  // streaming endpoint backed by getOutboxEventsForTopics.
  queueMicrotask(() => {
    notifyOutboxEvent({ topic: input.topic, eventId });
  });
  return eventId;
}

export async function getOutboxEventsForTopics(
  topics: string[],
  afterEventId: number,
  limit = 100,
): Promise<OutboxEvent[]> {
  if (topics.length === 0) return [];
  const db = getDbPg();
  return await db<OutboxEvent[]>`
    select event_id::int as event_id, topic, event_type, payload, created_at
    from public.event_outbox
    where topic in ${db(topics)} and event_id > ${afterEventId}
    order by event_id asc
    limit ${limit}
  `;
}

export async function getOutboxMinEventIdForTopics(
  topics: string[],
): Promise<number | null> {
  if (topics.length === 0) return null;
  const db = getDbPg();
  const rows = await db<{ min_event_id: number | null }[]>`
    select min(event_id)::int as min_event_id
    from public.event_outbox
    where topic in ${db(topics)}
  `;
  return rows[0]?.min_event_id ?? null;
}

export async function getOutboxMaxEventIdForTopics(
  topics: string[],
): Promise<number | null> {
  if (topics.length === 0) return null;
  const db = getDbPg();
  const rows = await db<{ max_event_id: number | null }[]>`
    select max(event_id)::int as max_event_id
    from public.event_outbox
    where topic in ${db(topics)}
  `;
  return rows[0]?.max_event_id ?? null;
}

export async function pruneEventOutbox(input?: {
  nowMs?: number;
  retentionHours?: number;
  keepRecentPerTopic?: number;
}): Promise<number> {
  const nowMs = input?.nowMs ?? Date.now();
  const retentionMs = (input?.retentionHours ?? 72) * 60 * 60 * 1000;
  const keepRecentPerTopic = input?.keepRecentPerTopic ?? 5000;
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();

  // Per-topic window: delete events older than `cutoffIso` AND older
  // than the Nth most recent event per topic (so we always keep the tail
  // even for low-traffic topics). One DELETE per topic; postgres has no
  // direct equivalent to per-group OFFSET so we run them serially.
  const db = getDbPg();
  const topics = await db<{ topic: string }[]>`
    select distinct topic from public.event_outbox
  `;
  let totalDeleted = 0;
  for (const { topic } of topics) {
    const threshold = await db<{ event_id: number }[]>`
      select event_id from public.event_outbox
      where topic = ${topic}
      order by event_id desc
      limit 1 offset ${keepRecentPerTopic - 1}
    `;
    const result = threshold[0]
      ? await db<{ event_id: number }[]>`
          delete from public.event_outbox
          where topic = ${topic}
            and created_at < ${cutoffIso}::timestamptz
            and event_id < ${threshold[0].event_id}
          returning event_id
        `
      : await db<{ event_id: number }[]>`
          delete from public.event_outbox
          where topic = ${topic}
            and created_at < ${cutoffIso}::timestamptz
          returning event_id
        `;
    totalDeleted += result.length;
  }
  return totalDeleted;
}

// ---------------------------------------------------------------------------
// Idempotency cache (per-user; RLS via migration 0003)
// ---------------------------------------------------------------------------

export interface IdempotencyCacheRecord {
  idempotency_key: string;
  user_id: string;
  method: string;
  path: string;
  request_hash: string;
  status_code: number;
  response_body: string;
  created_at: string;
  expires_at: string;
}

export async function getIdempotencyCache(input: {
  idempotencyKey: string;
  method: string;
  path: string;
}): Promise<IdempotencyCacheRecord | undefined> {
  // user_id = auth.uid() is enforced by RLS (migration 0003), no need to
  // pass userId explicitly. Expired rows are filtered server-side.
  const db = getDbPg();
  const rows = await db<IdempotencyCacheRecord[]>`
    select idempotency_key, user_id, method, path, request_hash,
           status_code, response_body, created_at, expires_at
    from public.idempotency_cache
    where idempotency_key = ${input.idempotencyKey}
      and method = ${input.method.toUpperCase()}
      and path = ${input.path}
      and expires_at > now()
    limit 1
  `;
  return rows[0];
}

export async function saveIdempotencyCache(input: {
  userId: string;
  idempotencyKey: string;
  method: string;
  path: string;
  requestHash: string;
  statusCode: number;
  responseBody: string;
  expiresAt: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.idempotency_cache
      (idempotency_key, user_id, method, path, request_hash,
       status_code, response_body, expires_at)
    values
      (${input.idempotencyKey}, ${input.userId}::uuid,
       ${input.method.toUpperCase()}, ${input.path}, ${input.requestHash},
       ${input.statusCode}, ${input.responseBody},
       ${input.expiresAt}::timestamptz)
    on conflict (idempotency_key, user_id, method, path) do update set
      request_hash = excluded.request_hash,
      status_code = excluded.status_code,
      response_body = excluded.response_body,
      created_at = now(),
      expires_at = excluded.expires_at
  `;
}

export async function pruneIdempotencyCache(nowMs?: number): Promise<number> {
  const nowIso = new Date(nowMs ?? Date.now()).toISOString();
  const db = getDbPg();
  const rows = await db<{ idempotency_key: string }[]>`
    delete from public.idempotency_cache
    where expires_at <= ${nowIso}::timestamptz
    returning idempotency_key
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Simple atomic helpers (assistant + outbox events inside withUserContext tx)
//
// The caller's withUserContext already opens a postgres tx, so all of
// these are atomic without a separate begin() — message insert + outbox
// append either both commit or both roll back.
// ---------------------------------------------------------------------------

export async function appendAssistantMessageWithOutbox(input: {
  ownerId: string;
  talkId: string;
  threadId: string;
  runId: string;
  messageId?: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  agentId?: string | null;
  agentNickname?: string | null;
  sequenceInRun?: number | null;
  createdAt?: string;
}): Promise<TalkMessageRecord> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const merged: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (input.agentId && typeof merged.agentId !== 'string') {
    merged.agentId = input.agentId;
  }
  if (input.agentNickname && typeof merged.agentNickname !== 'string') {
    merged.agentNickname = input.agentNickname;
  }
  const message = await createTalkMessage({
    ownerId: input.ownerId,
    id: input.messageId,
    talkId: input.talkId,
    threadId: input.threadId,
    role: 'assistant',
    content: input.content,
    createdBy: null,
    runId: input.runId,
    metadata: Object.keys(merged).length > 0 ? merged : null,
    sequenceInRun: input.sequenceInRun ?? null,
    createdAt,
  });
  await touchTalkUpdatedAt(input.talkId, createdAt);
  await appendOutboxEvent({
    topic: `talk:${input.talkId}`,
    eventType: 'message_appended',
    payload: {
      talkId: input.talkId,
      threadId: input.threadId,
      messageId: message.id,
      runId: input.runId,
      role: 'assistant',
      createdBy: null,
      content: input.content,
      createdAt,
      agentId: input.agentId ?? null,
      agentNickname: input.agentNickname ?? null,
      metadata: Object.keys(merged).length > 0 ? merged : null,
    },
  });
  return message;
}

// ---------------------------------------------------------------------------
// Error classes (carried over)
// ---------------------------------------------------------------------------

export class TalkActiveRoundError extends Error {
  readonly code = 'talk_active_round';
  readonly scope: 'talk' | 'thread';
  constructor(scope: 'talk' | 'thread') {
    super(
      scope === 'thread'
        ? 'This thread already has an active round'
        : 'This talk already has an active round',
    );
    this.name = 'TalkActiveRoundError';
    this.scope = scope;
  }
}

export class AttachmentValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.code = code;
  }
}

export class TalkThreadValidationError extends Error {
  readonly code: 'thread_not_found';
  constructor(message = 'Thread not found or does not belong to this talk') {
    super(message);
    this.name = 'TalkThreadValidationError';
    this.code = 'thread_not_found';
  }
}

export class ThreadDeleteConflictError extends Error {
  readonly code:
    | 'default_thread'
    | 'internal_thread'
    | 'job_owned_thread'
    | 'thread_has_active_runs';
  constructor(
    code:
      | 'default_thread'
      | 'internal_thread'
      | 'job_owned_thread'
      | 'thread_has_active_runs',
    message: string,
  ) {
    super(message);
    this.name = 'ThreadDeleteConflictError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Thread title inference (heal-on-write)
// ---------------------------------------------------------------------------

async function getFirstThreadUserMessageContent(
  talkId: string,
  threadId: string,
): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<{ content: string }[]>`
    select content
    from public.talk_messages
    where talk_id = ${talkId}::uuid
      and thread_id = ${threadId}::uuid
      and role = 'user'
    order by created_at asc, id asc
    limit 1
  `;
  return rows[0]?.content ?? null;
}

async function maybePersistTalkThreadTitleFromMessages(
  talkId: string,
  threadId: string,
  currentTitle: string | null | undefined,
): Promise<string | null> {
  const normalizedTitle = normalizeStoredThreadTitle(currentTitle);
  if (
    normalizedTitle !== null &&
    !isLegacyPlaceholderTalkThreadTitle(normalizedTitle)
  ) {
    return normalizedTitle;
  }
  const inferred = inferThreadTitleFromContent(
    await getFirstThreadUserMessageContent(talkId, threadId),
  );
  if (!inferred) return normalizedTitle;
  const db = getDbPg();
  await db`
    update public.talk_threads
    set title = ${inferred}, updated_at = now()
    where id = ${threadId}::uuid and talk_id = ${talkId}::uuid
      and (title is null or trim(title) = '' or title = 'Default Thread')
  `;
  return inferred;
}

// ---------------------------------------------------------------------------
// enqueueTalkTurnAtomic — user message + N queued runs + outbox events
//
// Caller's withUserContext wraps this in a single tx; either all rows
// land or none do. Attachments path is preserved from sqlite for
// completeness (validates count cap + atomically links message_id).
// ---------------------------------------------------------------------------

export async function enqueueTalkTurnAtomic(input: {
  ownerId: string;
  talkId: string;
  threadId?: string | null;
  userId: string;
  content: string;
  messageId?: string;
  runIds?: string[];
  targetAgentIds: string[];
  responseGroupId?: string | null;
  sequenceIndexes?: Array<number | null> | null;
  attachmentIds?: string[] | null;
  maxAttachmentsPerMessage?: number;
  idempotencyKey?: string | null;
}): Promise<{
  message: TalkMessageRecord;
  runs: TalkRunRecord[];
  threadId: string;
}> {
  if (input.targetAgentIds.length === 0) {
    throw new Error('talk turn requires at least one target agent');
  }
  if (input.runIds && input.runIds.length !== input.targetAgentIds.length) {
    throw new Error('talk turn requires one run id per target agent');
  }
  if (
    input.sequenceIndexes &&
    input.sequenceIndexes.length !== input.targetAgentIds.length
  ) {
    throw new Error('talk turn requires one sequence index per run');
  }

  const threadId = await resolveThreadIdForTalk({
    talkId: input.talkId,
    threadId: input.threadId,
    ownerId: input.ownerId,
  });

  // No concurrent rounds — if any run is queued/running/awaiting on the
  // thread, reject before creating new ones.
  const db = getDbPg();
  const active = await db<{ count: number }[]>`
    select count(*)::int as count
    from public.talk_runs
    where talk_id = ${input.talkId}::uuid
      and thread_id = ${threadId}::uuid
      and status in ('queued', 'running', 'awaiting_confirmation')
  `;
  if ((active[0]?.count ?? 0) > 0) {
    throw new TalkActiveRoundError('thread');
  }

  const responseGroupId =
    input.responseGroupId?.trim() || `group_${randomUUID()}`;
  const sequenceIndexes = input.targetAgentIds.map((_, i) => {
    const raw = input.sequenceIndexes?.[i];
    return typeof raw === 'number' &&
      Number.isFinite(raw) &&
      Number.isInteger(raw) &&
      raw >= 0
      ? raw
      : null;
  });

  const message = await createTalkMessage({
    ownerId: input.ownerId,
    id: input.messageId,
    talkId: input.talkId,
    threadId,
    role: 'user',
    content: input.content,
    createdBy: input.userId,
  });

  // Heal thread title from the first user message — runs in the same
  // tx so a rollback drops the title write too.
  const threadRows = await db<{ title: string | null }[]>`
    select title from public.talk_threads
    where id = ${threadId}::uuid and talk_id = ${input.talkId}::uuid
    limit 1
  `;
  await maybePersistTalkThreadTitleFromMessages(
    input.talkId,
    threadId,
    threadRows[0]?.title ?? null,
  );

  // Fan out one queued run per target agent.
  const runs: TalkRunRecord[] = [];
  for (let i = 0; i < input.targetAgentIds.length; i++) {
    const run = await createTalkRun({
      ownerId: input.ownerId,
      id: input.runIds?.[i],
      talkId: input.talkId,
      threadId,
      requestedBy: input.userId,
      status: 'queued',
      triggerMessageId: message.id,
      targetAgentId: input.targetAgentIds[i],
      idempotencyKey: i === 0 ? (input.idempotencyKey ?? null) : null,
      responseGroupId,
      sequenceIndex: sequenceIndexes[i],
    });
    runs.push(run);
  }

  await touchTalkUpdatedAt(input.talkId);
  await appendOutboxEvent({
    topic: `talk:${input.talkId}`,
    eventType: 'message_appended',
    payload: {
      talkId: input.talkId,
      threadId,
      messageId: message.id,
      runId: null,
      role: 'user',
      createdBy: input.userId,
      content: input.content,
      createdAt: message.created_at,
    },
  });
  for (const run of runs) {
    await appendOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: 'talk_run_queued',
      payload: {
        talkId: input.talkId,
        threadId,
        runId: run.id,
        runKind: run.run_kind,
        triggerMessageId: message.id,
        targetAgentId: run.target_agent_id,
        responseGroupId,
        sequenceIndex: run.sequence_index,
        status: 'queued',
        executorAlias: run.executor_alias,
        executorModel: run.executor_model,
      },
    });
  }

  // Attachments: validate cap + atomically link by message_id. Any
  // un-linkable ID rolls back the whole turn via the throw.
  const attIds = input.attachmentIds;
  if (Array.isArray(attIds) && attIds.length > 0) {
    const cap = input.maxAttachmentsPerMessage ?? 5;
    if (attIds.length > cap) {
      throw new AttachmentValidationError(
        'too_many_attachments',
        `A message may have at most ${cap} attachments.`,
      );
    }
    const invalidIds: string[] = [];
    for (const attId of attIds) {
      const result = await db<{ id: string }[]>`
        update public.talk_message_attachments
        set message_id = ${message.id}::uuid
        where id = ${attId}::uuid
          and talk_id = ${input.talkId}::uuid
          and message_id is null
        returning id
      `;
      if (result.length === 0) invalidIds.push(attId);
    }
    if (invalidIds.length > 0) {
      throw new AttachmentValidationError(
        'invalid_attachment_ids',
        `Some attachment IDs could not be linked: ${invalidIds.join(', ')}. ` +
          'They may be invalid, already linked, or belong to another talk.',
      );
    }
  }

  return { message, runs, threadId };
}

// ---------------------------------------------------------------------------
// claimQueuedTalkRuns — promote queued runs to running
//
// Within a response group, sequence_index enforces ordering: a higher-
// index run can't claim until lower-index siblings have terminated
// (completed or failed). Browser-phase shenanigans from sqlite are
// dropped (chassis removal).
// ---------------------------------------------------------------------------

export async function claimQueuedTalkRuns(
  limit: number,
  startedAtOverride?: string,
): Promise<TalkRunRecord[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const startedAt = startedAtOverride ?? new Date().toISOString();
  const db = getDbPg();

  const queued = await db<TalkRunRecord[]>`
    select ${db.unsafe(TALK_RUN_COLUMNS)}
    from public.talk_runs r
    where r.status = 'queued' and r.talk_id is not null
      and (
        r.sequence_index is null
        or not exists (
          select 1 from public.talk_runs prior
          where prior.response_group_id = r.response_group_id
            and prior.sequence_index is not null
            and prior.sequence_index < r.sequence_index
            and prior.status not in ('completed', 'failed')
        )
      )
    order by r.created_at asc, coalesce(r.sequence_index, -1) asc, r.id asc
    limit ${normalizedLimit}
  `;

  const claimed: TalkRunRecord[] = [];
  for (const run of queued) {
    const updated = await db<TalkRunRecord[]>`
      update public.talk_runs
      set status = 'running',
          timeout_phase = null,
          started_at = ${startedAt}::timestamptz,
          ended_at = null,
          cancel_reason = null
      where id = ${run.id}::uuid and status = 'queued'
      returning ${db.unsafe(TALK_RUN_COLUMNS)}
    `;
    if (updated.length !== 1) continue;
    claimed.push(updated[0]);
    await appendOutboxEvent({
      topic: `talk:${run.talk_id}`,
      eventType: 'talk_run_started',
      payload: {
        talkId: run.talk_id,
        threadId: run.thread_id,
        runId: run.id,
        runKind: run.run_kind,
        triggerMessageId: run.trigger_message_id,
        targetAgentId: run.target_agent_id ?? null,
        responseGroupId: run.response_group_id ?? null,
        sequenceIndex: run.sequence_index ?? null,
        status: 'running',
        executorAlias: run.executor_alias,
        executorModel: run.executor_model,
      },
    });
  }
  return claimed;
}

// ---------------------------------------------------------------------------
// completeRunAndPromoteNextAtomic — finalize a run, append the assistant
// message, record the LLM attempt, emit completed event.
//
// Channel delivery surface (talk_channel_bindings + channel_delivery_outbox)
// from sqlite is dropped — chassis removal. The "promote next" in the
// name is implicit: claimQueuedTalkRuns will pick up the next ordered
// sibling on its next tick once this run reaches a terminal state.
// ---------------------------------------------------------------------------

export async function completeRunAndPromoteNextAtomic(input: {
  ownerId: string;
  runId: string;
  responseMessageId?: string;
  responseContent: string;
  responseMetadata?: Record<string, unknown> | null;
  agentId?: string | null;
  agentNickname?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  latencyMs?: number | null;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  } | null;
  responseSequenceInRun?: number | null;
  endedAt?: string;
}): Promise<{ applied: boolean; talkId: string | null }> {
  const now = input.endedAt ?? new Date().toISOString();
  const db = getDbPg();

  const runs = await db<
    Pick<
      TalkRunRecord,
      | 'id'
      | 'talk_id'
      | 'thread_id'
      | 'trigger_message_id'
      | 'target_agent_id'
      | 'executor_alias'
      | 'executor_model'
      | 'run_kind'
      | 'response_group_id'
      | 'sequence_index'
      | 'metadata_json'
    >[]
  >`
    select id, talk_id, thread_id, trigger_message_id, target_agent_id,
           executor_alias, executor_model, run_kind, response_group_id,
           sequence_index, metadata_json
    from public.talk_runs
    where id = ${input.runId}::uuid and status = 'running'
    limit 1
  `;
  const run = runs[0];
  if (!run) return { applied: false, talkId: null };

  const updated = await db<{ id: string }[]>`
    update public.talk_runs
    set status = 'completed', ended_at = ${now}::timestamptz, cancel_reason = null
    where id = ${run.id}::uuid and status = 'running'
    returning id
  `;
  if (updated.length !== 1) {
    return { applied: false, talkId: run.talk_id };
  }

  // Merge responseMetadata into the run's existing metadata_json under
  // a `responseMetadata` key (mirrors sqlite behavior).
  if (input.responseMetadata && Object.keys(input.responseMetadata).length) {
    await updateTalkRunMetadata(run.id, {
      responseMetadata: input.responseMetadata,
    });
  }

  const responseMessage = await appendAssistantMessageWithOutbox({
    ownerId: input.ownerId,
    talkId: run.talk_id!,
    threadId: run.thread_id,
    runId: run.id,
    messageId: input.responseMessageId,
    content: input.responseContent,
    metadata: input.responseMetadata ?? null,
    agentId: input.agentId ?? run.target_agent_id ?? null,
    agentNickname: input.agentNickname ?? null,
    sequenceInRun: input.responseSequenceInRun ?? null,
    createdAt: now,
  });

  if (input.modelId) {
    // llm_attempts.agent_id is FK-validated against registered_agents.
    // target_agent_id on talk_runs is just a "we asked for this" hint
    // and is NOT FK-validated, so it can hold pre-registration UUIDs.
    // Only the explicit agentId param (already FK-validated by the
    // caller's path) is safe to use here.
    await db`
      insert into public.llm_attempts
        (run_id, talk_id, owner_id, agent_id, provider_id, model_id, status,
         latency_ms, input_tokens, cached_input_tokens, output_tokens,
         estimated_cost_usd)
      values
        (${input.runId}::uuid, ${run.talk_id}::uuid, ${input.ownerId}::uuid,
         ${input.agentId ?? null}::uuid,
         ${input.providerId ?? null}, ${input.modelId}, 'success',
         ${input.latencyMs ?? null},
         ${input.usage?.inputTokens ?? null},
         ${input.usage?.cachedInputTokens ?? null},
         ${input.usage?.outputTokens ?? null},
         ${input.usage?.estimatedCostUsd ?? null})
    `;
  }

  await appendOutboxEvent({
    topic: `talk:${run.talk_id}`,
    eventType: 'talk_run_completed',
    payload: {
      talkId: run.talk_id,
      threadId: run.thread_id,
      runId: run.id,
      runKind: run.run_kind,
      triggerMessageId: run.trigger_message_id,
      responseMessageId: responseMessage.id,
      responseGroupId: run.response_group_id,
      sequenceIndex: run.sequence_index,
      executorAlias: run.executor_alias,
      executorModel: run.executor_model,
    },
  });
  return { applied: true, talkId: run.talk_id };
}

// ---------------------------------------------------------------------------
// failRunAndPromoteNextAtomic — mark a run as failed, record the reason,
// emit failed event. As with complete, the "promote next" semantic is
// implicit via claimQueuedTalkRuns's next tick.
// ---------------------------------------------------------------------------

export async function failRunAndPromoteNextAtomic(input: {
  runId: string;
  errorCode: string;
  errorMessage: string;
  metadataPatch?: Record<string, unknown> | null;
  endedAt?: string;
}): Promise<{ applied: boolean; talkId: string | null }> {
  const now = input.endedAt ?? new Date().toISOString();
  const db = getDbPg();

  const runs = await db<
    Pick<
      TalkRunRecord,
      | 'id'
      | 'talk_id'
      | 'thread_id'
      | 'trigger_message_id'
      | 'target_agent_id'
      | 'executor_alias'
      | 'executor_model'
      | 'run_kind'
      | 'response_group_id'
      | 'sequence_index'
    >[]
  >`
    select id, talk_id, thread_id, trigger_message_id, target_agent_id,
           executor_alias, executor_model, run_kind, response_group_id,
           sequence_index
    from public.talk_runs
    where id = ${input.runId}::uuid and status = 'running'
    limit 1
  `;
  const run = runs[0];
  if (!run) return { applied: false, talkId: null };

  const reason = `${input.errorCode}: ${input.errorMessage}`.slice(0, 500);
  const failed = await db<{ id: string }[]>`
    update public.talk_runs
    set status = 'failed',
        ended_at = ${now}::timestamptz,
        cancel_reason = ${reason}
    where id = ${run.id}::uuid and status = 'running'
    returning id
  `;
  if (failed.length !== 1) {
    return { applied: false, talkId: run.talk_id };
  }

  if (input.metadataPatch && Object.keys(input.metadataPatch).length) {
    await updateTalkRunMetadata(run.id, {
      responseMetadata: input.metadataPatch,
    });
  }

  await appendOutboxEvent({
    topic: `talk:${run.talk_id}`,
    eventType: 'talk_run_failed',
    payload: {
      talkId: run.talk_id,
      threadId: run.thread_id,
      runId: run.id,
      runKind: run.run_kind,
      triggerMessageId: run.trigger_message_id,
      responseGroupId: run.response_group_id,
      sequenceIndex: run.sequence_index,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      executorAlias: run.executor_alias,
      executorModel: run.executor_model,
    },
  });
  return { applied: true, talkId: run.talk_id };
}

// ---------------------------------------------------------------------------
// cancelTalkRunsAtomic — cancel every active run on a talk (or thread).
// ---------------------------------------------------------------------------

export async function cancelTalkRunsAtomic(input: {
  talkId: string;
  threadId?: string | null;
  cancelledBy: string;
  ownerId: string;
  endedAt?: string;
}): Promise<{
  cancelledRuns: number;
  cancelledRunIds: string[];
  cancelledRunning: boolean;
}> {
  const now = input.endedAt ?? new Date().toISOString();
  const threadId = input.threadId
    ? await resolveThreadIdForTalk({
        talkId: input.talkId,
        threadId: input.threadId,
        ownerId: input.ownerId,
      })
    : null;
  const db = getDbPg();
  const activeRuns = await db<
    Pick<
      TalkRunRecord,
      | 'id'
      | 'thread_id'
      | 'status'
      | 'target_agent_id'
      | 'response_group_id'
      | 'sequence_index'
    >[]
  >`
    select id, thread_id, status, target_agent_id, response_group_id,
           sequence_index
    from public.talk_runs
    where talk_id = ${input.talkId}::uuid
      and (${threadId}::uuid is null or thread_id = ${threadId}::uuid)
      and status in ('queued', 'running', 'awaiting_confirmation')
    order by created_at asc
  `;

  const cancelledRunIds: string[] = [];
  let cancelledRunning = false;
  const cancelReason = `Cancelled by ${input.cancelledBy}`.slice(0, 500);
  for (const run of activeRuns) {
    const updated = await db<{ id: string }[]>`
      update public.talk_runs
      set status = 'cancelled',
          ended_at = ${now}::timestamptz,
          cancel_reason = ${cancelReason}
      where id = ${run.id}::uuid
        and status in ('queued', 'running', 'awaiting_confirmation')
      returning id
    `;
    if (updated.length !== 1) continue;
    cancelledRunIds.push(run.id);
    if (run.status === 'running') {
      cancelledRunning = true;
      await appendOutboxEvent({
        topic: `talk:${input.talkId}`,
        eventType: 'talk_response_cancelled',
        payload: {
          talkId: input.talkId,
          threadId: run.thread_id,
          runId: run.id,
          agentId: run.target_agent_id ?? null,
          responseGroupId: run.response_group_id,
          sequenceIndex: run.sequence_index,
        },
      });
    }
  }
  if (cancelledRunIds.length > 0) {
    const threadIds = Array.from(
      new Set(
        activeRuns
          .filter((r) => cancelledRunIds.includes(r.id))
          .map((r) => r.thread_id),
      ),
    );
    await appendOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: 'talk_run_cancelled',
      payload: {
        talkId: input.talkId,
        cancelledBy: input.cancelledBy,
        runIds: cancelledRunIds,
        threadIds,
      },
    });
  }
  return {
    cancelledRuns: cancelledRunIds.length,
    cancelledRunIds,
    cancelledRunning,
  };
}

// ---------------------------------------------------------------------------
// failInterruptedRunsOnStartup — boot-time cleanup.
//
// Runs *outside* withUserContext: this is a process-startup pass that
// touches every active run regardless of owner, so it executes as the
// postgres role (RLS bypassed). Marks every status='running' row failed
// with cancel_reason='interrupted_by_restart' and emits a
// talk_run_failed outbox event for each so live subscribers learn the
// run died. The main-channel sibling (failInterruptedMainRunsOnStartup)
// is dropped — chassis removal.
// ---------------------------------------------------------------------------

export async function failInterruptedRunsOnStartup(
  now?: string,
): Promise<{ failedRunIds: string[]; promotedRunIds: string[] }> {
  const currentNow = now ?? new Date().toISOString();
  const db = getDbPg();
  const runningRuns = await db<
    Array<{
      id: string;
      talk_id: string;
      thread_id: string;
      trigger_message_id: string | null;
      executor_alias: string | null;
      executor_model: string | null;
      run_kind: TalkRunKind;
    }>
  >`
    select id, talk_id, thread_id, trigger_message_id, executor_alias,
           executor_model, run_kind
    from public.talk_runs
    where status = 'running' and talk_id is not null
    order by created_at asc
  `;

  const failedRunIds: string[] = [];
  for (const run of runningRuns) {
    const updated = await db<{ id: string }[]>`
      update public.talk_runs
      set status = 'failed',
          ended_at = ${currentNow}::timestamptz,
          cancel_reason = 'interrupted_by_restart'
      where id = ${run.id}::uuid and status = 'running'
      returning id
    `;
    if (updated.length !== 1) continue;
    failedRunIds.push(run.id);
    await appendOutboxEvent({
      topic: `talk:${run.talk_id}`,
      eventType: 'talk_run_failed',
      payload: {
        talkId: run.talk_id,
        threadId: run.thread_id,
        runId: run.id,
        runKind: run.run_kind,
        triggerMessageId: run.trigger_message_id,
        errorCode: 'interrupted_by_restart',
        errorMessage: 'Run interrupted by process restart',
        executorAlias: run.executor_alias,
        executorModel: run.executor_model,
      },
    });
  }
  return { failedRunIds, promotedRunIds: [] };
}

export async function appendRuntimeTalkMessage(input: {
  ownerId: string;
  id?: string;
  talkId: string;
  threadId: string;
  runId: string;
  role: 'assistant' | 'tool';
  content: string;
  metadata?: Record<string, unknown> | null;
  sequenceInRun: number;
  createdAt?: string;
}): Promise<TalkMessageRecord> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const meta = input.metadata ?? null;
  const agentId =
    meta && typeof meta.agentId === 'string' ? meta.agentId : null;
  const agentNickname =
    meta && typeof meta.agentNickname === 'string'
      ? meta.agentNickname
      : meta && typeof meta.agentName === 'string'
        ? meta.agentName
        : null;
  const message = await createTalkMessage({
    ownerId: input.ownerId,
    id: input.id,
    talkId: input.talkId,
    threadId: input.threadId,
    role: input.role,
    content: input.content,
    createdBy: null,
    runId: input.runId,
    metadata: meta,
    sequenceInRun: input.sequenceInRun,
    createdAt,
  });
  await touchTalkUpdatedAt(input.talkId, createdAt);
  await appendOutboxEvent({
    topic: `talk:${input.talkId}`,
    eventType: 'message_appended',
    payload: {
      talkId: input.talkId,
      threadId: input.threadId,
      messageId: message.id,
      runId: input.runId,
      role: input.role,
      createdBy: null,
      content: input.content,
      createdAt,
      agentId,
      agentNickname,
      metadata: meta,
    },
  });
  return message;
}

// ---------------------------------------------------------------------------
// Settings KV (system-managed; migration 0004 grants select/insert/update on
// public.settings_kv to authenticated. Admin gating happens at the route
// layer under the cloud-era auth model — there is no per-row owner_id.)
// ---------------------------------------------------------------------------

export async function getSettingValue(key: string): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<{ value: string | null }[]>`
    select value from public.settings_kv where key = ${key} limit 1
  `;
  return rows[0]?.value ?? null;
}

export async function upsertSettingValue(input: {
  key: string;
  value: string | null;
  updatedBy?: string | null;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.settings_kv (key, value, updated_by)
    values (${input.key}, ${input.value},
            ${input.updatedBy ?? null}::uuid)
    on conflict (key) do update set
      value = excluded.value,
      updated_at = now(),
      updated_by = excluded.updated_by
  `;
}

export async function deleteSettingValue(key: string): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.settings_kv where key = ${key}
  `;
}

// ---------------------------------------------------------------------------
// Users (public.users; auto-mirrored from auth.users via
// handle_new_auth_user trigger). RLS-gated by users_self_select policy so
// callers inside withUserContext only see their own row.
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  role: 'owner' | 'admin' | 'member';
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export async function getUserById(
  userId: string,
): Promise<UserRecord | undefined> {
  const db = getDbPg();
  const rows = await db<UserRecord[]>`
    select * from public.users where id = ${userId}::uuid limit 1
  `;
  return rows[0];
}

export async function updateUserDisplayName(input: {
  userId: string;
  displayName: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    update public.users
    set display_name = ${input.displayName}
    where id = ${input.userId}::uuid
  `;
}
