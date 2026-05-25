// Tests for `propose_content_append` tool handler.
//
// Goes against the local Supabase Postgres started by `npm run db:start`.
// The handler is a thin wrapper around `createProposal` — these tests
// verify the wrapper (arg validation, tool-error mapping) end-to-end on
// real data; deep CAS / drift behavior is already covered in
// content-accessors.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  createContent,
  getContentByTalkId,
  listPendingProposalsByContentId,
  updateContentBody,
} from '../db/content-accessors.js';
import {
  ANCHOR_ATTR_KEY,
  tiptapJsonToMarkdown,
  type RichTextDocument,
} from '../../shared/rich-text/index.js';
import { executeProposeContentAppend } from './content-tool-handlers.js';

const USER_A_ID = '0c44ee44-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c44ee44-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c44ee44-cccc-cccc-cccc-ccccccccc0a1';
const TALK_B_ID = '0c44ee44-cccc-cccc-cccc-ccccccccc0b1';
// runId/agentId are FK-validated against talk_runs and registered_agents.
// Seeding those rows would just exercise content-accessors.test.ts again;
// pass null instead and verify the wrapper's mapping with simpler asserts.
const RUN_ID = null;
const AGENT_ID = null;

async function seedAuthUser(
  id: string,
  email: string,
  displayName: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${displayName}::text))
    on conflict (id) do nothing
  `;
}

async function seedTalk(talkId: string, ownerId: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks (id, owner_id, topic_title)
    values (${talkId}::uuid, ${ownerId}::uuid, 'Tool Handler Talk')
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.talks where id in (${TALK_A_ID}::uuid, ${TALK_B_ID}::uuid)
  `;
  await seedTalk(TALK_A_ID, USER_A_ID);
  await seedTalk(TALK_B_ID, USER_B_ID);
}

function docFor(
  blocks: Array<{ anchor: string; text: string; type?: string }>,
): RichTextDocument {
  return {
    type: 'doc',
    content: blocks.map((b) => ({
      type: b.type ?? 'paragraph',
      attrs: { [ANCHOR_ATTR_KEY]: b.anchor },
      content: [{ type: 'text', text: b.text }],
    })),
  };
}

describe('executeProposeContentAppend', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'tool-a@clawtalk.local', 'Tool A');
    await seedAuthUser(USER_B_ID, 'tool-b@clawtalk.local', 'Tool B');
    await seedTalk(TALK_A_ID, USER_A_ID);
    await seedTalk(TALK_B_ID, USER_B_ID);
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`
      delete from auth.users where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('happy path writes a pending proposal and returns its id', async () => {
    await withUserContext(USER_A_ID, async () => {
      const created = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      const body = tiptapJsonToMarkdown(
        docFor([
          { anchor: 'aaaaaaaaaaa1', text: 'Intro' },
          { anchor: 'aaaaaaaaaaa2', text: 'Body' },
        ]),
      );
      const update = await updateContentBody({
        contentId: created.id,
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: body,
        updatedByUserId: USER_A_ID,
      });
      expect(update.kind).toBe('ok');

      const result = await executeProposeContentAppend({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        args: {
          after_anchor_id: 'aaaaaaaaaaa1',
          markdown: 'A new paragraph proposed by the agent.',
          rationale: 'Adds a clarifying transition between Intro and Body.',
        },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.result) as {
        proposalId: string;
        status: string;
        afterAnchorId: string | null;
        contentId: string;
      };
      expect(parsed.status).toBe('pending');
      expect(parsed.afterAnchorId).toBe('aaaaaaaaaaa1');
      expect(parsed.contentId).toBe(created.id);

      const pending = await listPendingProposalsByContentId(created.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].insertedMarkdown).toContain(
        'A new paragraph proposed by the agent.',
      );
      expect(pending[0].afterAnchorId).toBe('aaaaaaaaaaa1');
    });
  });

  it('accepts null after_anchor_id to prepend at the top', async () => {
    await withUserContext(USER_A_ID, async () => {
      const created = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      const body = tiptapJsonToMarkdown(
        docFor([{ anchor: 'bbbbbbbbbbb1', text: 'Body' }]),
      );
      await updateContentBody({
        contentId: created.id,
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: body,
        updatedByUserId: USER_A_ID,
      });

      const result = await executeProposeContentAppend({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        args: { after_anchor_id: null, markdown: 'Prepended block.' },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.result) as {
        afterAnchorId: string | null;
      };
      expect(parsed.afterAnchorId).toBeNull();
    });
  });

  it('returns a tool error when the anchor is not in the document', async () => {
    await withUserContext(USER_A_ID, async () => {
      await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      const content = await getContentByTalkId(TALK_A_ID);
      expect(content).not.toBeNull();

      const result = await executeProposeContentAppend({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        args: {
          after_anchor_id: 'doesnotexist',
          markdown: 'Block targeting a missing anchor.',
        },
      });

      expect(result.isError).toBe(true);
      expect(result.result.toLowerCase()).toContain('anchor');
    });
  });

  it('returns a tool error when the Talk has no attached document', async () => {
    await withUserContext(USER_A_ID, async () => {
      const result = await executeProposeContentAppend({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        args: { markdown: 'A block with no document.' },
      });

      expect(result.isError).toBe(true);
      expect(result.result.toLowerCase()).toContain('document');
    });
  });

  it('returns a tool error when markdown is missing or empty', async () => {
    await withUserContext(USER_A_ID, async () => {
      await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
        createdByUserId: USER_A_ID,
      });
      const blank = await executeProposeContentAppend({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        args: { markdown: '   ' },
      });
      expect(blank.isError).toBe(true);

      const missing = await executeProposeContentAppend({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        args: {},
      });
      expect(missing.isError).toBe(true);
    });
  });
});
