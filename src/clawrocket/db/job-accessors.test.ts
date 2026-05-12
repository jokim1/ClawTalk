import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db.js';
import { createRegisteredAgent } from './agent-accessors.js';
import {
  _initTestDatabase,
  createTalk,
  createTalkOutput,
  createTalkThread,
  createJobTriggerRun,
  createTalkJob,
  deleteTalkJob,
  getTalkRunById,
  listTalkJobs,
  listTalkThreads,
  patchTalkJob,
  upsertUser,
} from './index.js';

const TALK_ID = 'talk-jobs';
const OWNER_ID = 'owner-1';

function attachTalkAgent(agentId: string, nickname = 'Analyst'): void {
  getDb()
    .prepare(
      `
      INSERT INTO talk_agents (
        id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
    )
    .run(`ta-${agentId}`, TALK_ID, agentId, nickname);
}

describe('job-accessors', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: OWNER_ID,
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    createTalk({
      id: TALK_ID,
      ownerId: OWNER_ID,
      topicTitle: 'Jobs Test Talk',
    });
    createTalkThread({
      talkId: TALK_ID,
      title: 'Default',
    });
  });

  it('creates report jobs with hidden threads and hides them from the normal thread rail', () => {
    const agent = createRegisteredAgent({
      name: 'Growth Analyst',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      systemPrompt: 'Analyze trends.',
    });
    attachTalkAgent(agent.id, agent.name);
    const report = createTalkOutput({
      talkId: TALK_ID,
      title: 'Daily Report',
      contentMarkdown: '',
      createdByUserId: OWNER_ID,
    });

    const job = createTalkJob({
      talkId: TALK_ID,
      title: 'Daily FTUE Brief',
      prompt: 'Check FTUE metrics.',
      targetAgentId: agent.id,
      schedule: {
        kind: 'weekly',
        weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
        hour: 9,
        minute: 0,
      },
      timezone: 'America/Los_Angeles',
      deliverableKind: 'report',
      reportOutputId: report.id,
      createdBy: OWNER_ID,
    });

    expect(job.deliverableKind).toBe('report');
    expect(listTalkJobs(TALK_ID)).toHaveLength(1);
    expect(listTalkThreads(TALK_ID).map((thread) => thread.id)).not.toContain(
      job.threadId,
    );
  });

  it('switches thread visibility when the deliverable changes and hides deleted job threads', () => {
    const agent = createRegisteredAgent({
      name: 'Researcher',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      systemPrompt: 'Research topics.',
    });
    attachTalkAgent(agent.id, agent.name);
    const report = createTalkOutput({
      talkId: TALK_ID,
      title: 'Weekly Report',
      contentMarkdown: '',
      createdByUserId: OWNER_ID,
    });

    const job = createTalkJob({
      talkId: TALK_ID,
      title: 'Weekly News',
      prompt: 'Summarize top stories.',
      targetAgentId: agent.id,
      schedule: { kind: 'hourly_interval', everyHours: 24 },
      timezone: 'America/Los_Angeles',
      deliverableKind: 'thread',
      createdBy: OWNER_ID,
    });
    expect(listTalkThreads(TALK_ID).map((thread) => thread.id)).toContain(
      job.threadId,
    );

    const patched = patchTalkJob({
      talkId: TALK_ID,
      jobId: job.id,
      deliverableKind: 'report',
      reportOutputId: report.id,
    });
    expect(patched?.deliverableKind).toBe('report');
    expect(listTalkThreads(TALK_ID).map((thread) => thread.id)).not.toContain(
      job.threadId,
    );

    expect(deleteTalkJob(TALK_ID, job.id)).toBe(true);
    expect(listTalkThreads(TALK_ID).map((thread) => thread.id)).not.toContain(
      job.threadId,
    );
  });

  it('creates a manual trigger run atomically with creator-backed identity and job_id provenance', () => {
    const agent = createRegisteredAgent({
      name: 'Scheduler Agent',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      systemPrompt: 'Do scheduled work.',
    });
    attachTalkAgent(agent.id, agent.name);
    const job = createTalkJob({
      talkId: TALK_ID,
      title: 'Daily Standup Digest',
      prompt: 'Summarize what changed today.',
      targetAgentId: agent.id,
      schedule: { kind: 'hourly_interval', everyHours: 24 },
      timezone: 'America/Los_Angeles',
      deliverableKind: 'thread',
      createdBy: OWNER_ID,
    });

    const result = createJobTriggerRun({
      jobId: job.id,
      triggerSource: 'manual',
      allowPaused: true,
      now: '2026-03-17T17:00:00.000Z',
    });

    expect(result.status).toBe('enqueued');
    if (result.status !== 'enqueued') {
      return;
    }

    const run = getTalkRunById(result.runId);
    expect(run).toMatchObject({
      requested_by: OWNER_ID,
      job_id: job.id,
      target_agent_id: agent.id,
      trigger_message_id: result.messageId,
      status: 'queued',
    });
  });
});
