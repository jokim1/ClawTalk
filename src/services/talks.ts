/**
 * Talk Manager
 *
 * Handles saved Talks (WhatsApp-style conversations) with explicit user control.
 * Talks are saved conversations that persist across sessions.
 * Write operations use async I/O (fire-and-forget) to avoid blocking the event loop.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Talk, Job, TalkAgent, AgentRole, Directive, PlatformBinding, PlatformPermission } from '../types';

/** Validate that a talk ID is safe for use as a directory name. */
function isValidTalkId(id: string): boolean {
  return /^[\w-]+$/.test(id) && !id.includes('..');
}

export const TALKS_DIR = path.join(process.env.HOME || '~', '.clawtalk', 'talks');

export class TalkManager {
  private talks: Map<string, Talk> = new Map();
  private activeTalkId: string | null = null;

  constructor() {
    this.ensureTalksDir();
    this.loadTalks();
  }

  private ensureTalksDir(): void {
    if (!fs.existsSync(TALKS_DIR)) {
      fs.mkdirSync(TALKS_DIR, { recursive: true });
    }
  }

  /** Load all saved talks from disk on startup. */
  loadTalks(): void {
    try {
      const dirs = fs.readdirSync(TALKS_DIR);
      for (const dir of dirs) {
        if (!isValidTalkId(dir)) continue;
        const talkPath = path.join(TALKS_DIR, dir);
        const metaPath = path.join(talkPath, 'talk.json');

        if (fs.existsSync(metaPath)) {
          try {
            const talk = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Talk;
            // Only load saved talks
            if (talk.isSaved) {
              this.talks.set(talk.id, talk);
            }
          } catch (err) {
            console.debug('Skipping corrupted talk:', dir, err);
          }
        }
      }
    } catch (err) {
      console.debug('Talks directory not readable:', err);
    }
  }

  /** Create an unsaved talk for a session. */
  createTalk(sessionId: string): Talk {
    const talk: Talk = {
      id: sessionId,
      sessionId,
      isSaved: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.talks.set(talk.id, talk);
    this.activeTalkId = talk.id;

    return talk;
  }

  /** Mark a talk as saved (appears in ^T list). */
  saveTalk(talkId: string): boolean {
    const talk = this.talks.get(talkId);
    if (!talk) return false;

    talk.isSaved = true;
    talk.updatedAt = Date.now();
    this.persistTalk(talk);

    return true;
  }

  /** Set the topic title for a talk. */
  setTopicTitle(talkId: string, title: string): boolean {
    const talk = this.talks.get(talkId);
    if (!talk) return false;

    talk.topicTitle = title;
    talk.updatedAt = Date.now();
    this.persistTalk(talk);

    return true;
  }

  /** Set the AI model for a talk. */
  setModel(talkId: string, model: string): boolean {
    const talk = this.talks.get(talkId);
    if (!talk) return false;

    talk.model = model;
    talk.updatedAt = Date.now();
    if (talk.isSaved) {
      this.persistTalk(talk);
    }

    return true;
  }

  /** Get all saved talks (sorted by updatedAt, most recent first). */
  listSavedTalks(): Talk[] {
    return Array.from(this.talks.values())
      .filter(t => t.isSaved)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get the currently active talk. */
  getActiveTalk(): Talk | null {
    if (this.activeTalkId && this.talks.has(this.activeTalkId)) {
      return this.talks.get(this.activeTalkId)!;
    }
    return null;
  }

  /** Set the active talk. */
  setActiveTalk(talkId: string): Talk | null {
    if (this.talks.has(talkId)) {
      this.activeTalkId = talkId;
      return this.talks.get(talkId)!;
    }
    return null;
  }

  /** Get a talk by ID. */
  getTalk(talkId: string): Talk | null {
    return this.talks.get(talkId) ?? null;
  }

  /** Update touch timestamp when talk is used. */
  touchTalk(talkId: string): void {
    const talk = this.talks.get(talkId);
    if (talk) {
      talk.updatedAt = Date.now();
      if (talk.isSaved) {
        this.persistTalk(talk);
      }
    }
  }

  /** Remove a talk from Saved Talks (still appears in History). */
  unsaveTalk(talkId: string): boolean {
    const talk = this.talks.get(talkId);
    if (!talk) return false;

    talk.isSaved = false;
    this.persistTalk(talk);

    return true;
  }

  /** Get the context markdown for a talk. */
  getContextMd(talkId: string): string | null {
    if (!isValidTalkId(talkId)) return null;
    const contextPath = path.join(TALKS_DIR, talkId, 'context.md');
    try {
      return fs.readFileSync(contextPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // --- Objective methods ---

  /** Set or clear the objective for a talk. */
  setObjective(talkId: string, objective: string | undefined): boolean {
    const talk = this.talks.get(talkId);
    if (!talk) return false;

    talk.objective = objective;
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Get the objective for a talk. */
  getObjective(talkId: string): string | undefined {
    const talk = this.talks.get(talkId);
    return talk?.objective;
  }

  /** Set the gateway talk ID mapping for a local talk. */
  setGatewayTalkId(talkId: string, gatewayTalkId: string): boolean {
    const talk = this.talks.get(talkId);
    if (!talk) return false;

    talk.gatewayTalkId = gatewayTalkId;
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Get the gateway talk ID for a local talk. */
  getGatewayTalkId(talkId: string): string | undefined {
    const talk = this.talks.get(talkId);
    return talk?.gatewayTalkId;
  }

  // --- Pin methods ---

  /** Add a pinned message ID to a talk. */
  addPin(talkId: string, messageId: string): boolean {
    const talk = this.talks.get(talkId);
    if (!talk) return false;

    if (!talk.pinnedMessageIds) talk.pinnedMessageIds = [];
    if (talk.pinnedMessageIds.includes(messageId)) return false;

    talk.pinnedMessageIds.push(messageId);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Remove a pinned message ID from a talk. */
  removePin(talkId: string, messageId: string): boolean {
    const talk = this.talks.get(talkId);
    if (!talk || !talk.pinnedMessageIds) return false;

    const idx = talk.pinnedMessageIds.indexOf(messageId);
    if (idx === -1) return false;

    talk.pinnedMessageIds.splice(idx, 1);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Get all pinned message IDs for a talk. */
  getPinnedMessageIds(talkId: string): string[] {
    const talk = this.talks.get(talkId);
    return talk?.pinnedMessageIds ?? [];
  }

  // --- Job methods (1-based indexes for user-facing) ---

  /** Add a new job to a talk. */
  addJob(talkId: string, schedule: string, prompt: string): Job | null {
    const talk = this.talks.get(talkId);
    if (!talk) return null;

    if (!talk.jobs) talk.jobs = [];

    const job: Job = {
      id: randomUUID(),
      schedule,
      prompt,
      active: true,
      createdAt: Date.now(),
    };

    talk.jobs.push(job);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return job;
  }

  /** Pause a job by 1-based index. */
  pauseJob(talkId: string, index: number): boolean {
    const talk = this.talks.get(talkId);
    if (!talk?.jobs) return false;

    const job = talk.jobs[index - 1];
    if (!job) return false;

    job.active = false;
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Resume a job by 1-based index. */
  resumeJob(talkId: string, index: number): boolean {
    const talk = this.talks.get(talkId);
    if (!talk?.jobs) return false;

    const job = talk.jobs[index - 1];
    if (!job) return false;

    job.active = true;
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Delete a job by 1-based index. */
  deleteJob(talkId: string, index: number): boolean {
    const talk = this.talks.get(talkId);
    if (!talk?.jobs) return false;

    if (index < 1 || index > talk.jobs.length) return false;

    talk.jobs.splice(index - 1, 1);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Get all jobs for a talk. */
  getJobs(talkId: string): Job[] {
    const talk = this.talks.get(talkId);
    return talk?.jobs ?? [];
  }

  /** Check if a talk has any active jobs. */
  hasActiveJobs(talkId: string): boolean {
    const talk = this.talks.get(talkId);
    return (talk?.jobs ?? []).some(j => j.active);
  }

  // --- Agent methods ---

  /** Get all agents for a talk. */
  getAgents(talkId: string): TalkAgent[] {
    const talk = this.talks.get(talkId);
    return talk?.agents ?? [];
  }

  /** Add an agent to a talk. Appends a number suffix if name collides. */
  addAgent(talkId: string, agent: TalkAgent): void {
    const talk = this.talks.get(talkId);
    if (!talk) return;

    if (!talk.agents) talk.agents = [];

    // Check name collision, append number if exists
    let name = agent.name;
    const existing = talk.agents.map(a => a.name.toLowerCase());
    if (existing.includes(name.toLowerCase())) {
      let suffix = 2;
      while (existing.includes(`${name} ${suffix}`.toLowerCase())) suffix++;
      name = `${name} ${suffix}`;
    }

    talk.agents.push({ ...agent, name });
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
  }

  /** Remove an agent from a talk. Returns false if not found or is primary. */
  removeAgent(talkId: string, agentName: string): boolean {
    const talk = this.talks.get(talkId);
    if (!talk?.agents) return false;

    // Use findAgent for prefix-match support
    const agent = this.findAgent(talkId, agentName);
    if (!agent || agent.isPrimary) return false;

    talk.agents = talk.agents.filter(a => a !== agent);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Set the full agents array for a talk. */
  setAgents(talkId: string, agents: TalkAgent[]): void {
    const talk = this.talks.get(talkId);
    if (!talk) return;

    talk.agents = agents;
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
  }

  /** Get the primary agent for a talk. */
  getPrimaryAgent(talkId: string): TalkAgent | undefined {
    const talk = this.talks.get(talkId);
    return talk?.agents?.find(a => a.isPrimary);
  }

  /** Change an agent's role and update its name. Returns the updated agent or null. */
  changeAgentRole(talkId: string, agentName: string, newRole: AgentRole, newRoleLabel: string, generateName: (alias: string, role: AgentRole) => string): TalkAgent | null {
    const talk = this.talks.get(talkId);
    if (!talk?.agents) return null;

    // Use findAgent for prefix-match support
    const agent = this.findAgent(talkId, agentName);
    if (!agent) return null;

    agent.role = newRole;
    // Regenerate name from model alias + new role
    const { getModelAlias } = require('../models.js');
    const alias = getModelAlias(agent.model);
    let newName = generateName(alias, newRole);

    // Handle name collision
    const existing = talk.agents.filter(a => a !== agent).map(a => a.name.toLowerCase());
    if (existing.includes(newName.toLowerCase())) {
      let suffix = 2;
      while (existing.includes(`${newName} ${suffix}`.toLowerCase())) suffix++;
      newName = `${newName} ${suffix}`;
    }

    agent.name = newName;
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return agent;
  }

  /** Find an agent by name (case-insensitive, supports prefix matching). */
  findAgent(talkId: string, name: string): TalkAgent | undefined {
    const talk = this.talks.get(talkId);
    if (!talk?.agents) return undefined;

    const lower = name.toLowerCase();

    // Exact match first
    const exact = talk.agents.find(a => a.name.toLowerCase() === lower);
    if (exact) return exact;

    // Prefix match fallback (only if unambiguous)
    const prefixMatches = talk.agents.filter(a => a.name.toLowerCase().startsWith(lower));
    if (prefixMatches.length === 1) return prefixMatches[0];

    return undefined;
  }

  // --- Directive methods (1-based indexes for user-facing) ---

  /** Add a directive to a talk. */
  addDirective(talkId: string, text: string): Directive | null {
    const talk = this.talks.get(talkId);
    if (!talk) return null;

    if (!talk.directives) talk.directives = [];

    const directive: Directive = {
      id: randomUUID(),
      text,
      active: true,
      createdAt: Date.now(),
    };

    talk.directives.push(directive);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return directive;
  }

  /** Remove a directive by 1-based index. */
  removeDirective(talkId: string, index: number): boolean {
    const talk = this.talks.get(talkId);
    if (!talk?.directives) return false;
    if (index < 1 || index > talk.directives.length) return false;

    talk.directives.splice(index - 1, 1);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Toggle a directive active/inactive by 1-based index. */
  toggleDirective(talkId: string, index: number): boolean {
    const talk = this.talks.get(talkId);
    if (!talk?.directives) return false;

    const directive = talk.directives[index - 1];
    if (!directive) return false;

    directive.active = !directive.active;
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Get all directives for a talk. */
  getDirectives(talkId: string): Directive[] {
    const talk = this.talks.get(talkId);
    return talk?.directives ?? [];
  }

  // --- Platform binding methods (1-based indexes for user-facing) ---

  /** Add a platform binding to a talk. */
  addPlatformBinding(talkId: string, platform: string, scope: string, permission: PlatformPermission): PlatformBinding | null {
    const talk = this.talks.get(talkId);
    if (!talk) return null;

    if (!talk.platformBindings) talk.platformBindings = [];

    const binding: PlatformBinding = {
      id: randomUUID(),
      platform,
      scope,
      permission,
      createdAt: Date.now(),
    };

    talk.platformBindings.push(binding);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return binding;
  }

  /** Remove a platform binding by 1-based index. */
  removePlatformBinding(talkId: string, index: number): boolean {
    const talk = this.talks.get(talkId);
    if (!talk?.platformBindings) return false;
    if (index < 1 || index > talk.platformBindings.length) return false;

    talk.platformBindings.splice(index - 1, 1);
    talk.updatedAt = Date.now();
    if (talk.isSaved) this.persistTalk(talk);
    return true;
  }

  /** Get all platform bindings for a talk. */
  getPlatformBindings(talkId: string): PlatformBinding[] {
    const talk = this.talks.get(talkId);
    return talk?.platformBindings ?? [];
  }

  /** Import a talk from gateway data (creates local entry if not present). */
  importGatewayTalk(gwTalk: {
    id: string;
    topicTitle?: string;
    objective?: string;
    model?: string;
    pinnedMessageIds?: string[];
    jobs?: Job[];
    agents?: TalkAgent[];
    directives?: Directive[];
    platformBindings?: PlatformBinding[];
    createdAt: number;
    updatedAt: number;
  }): Talk {
    // Check by gateway talk ID first, then check if any local talk maps to it
    let existing = this.talks.get(gwTalk.id);
    if (!existing) {
      for (const t of this.talks.values()) {
        if (t.gatewayTalkId === gwTalk.id) {
          existing = t;
          break;
        }
      }
    }

    if (existing) {
      // Update local metadata from gateway (gateway is source of truth)
      existing.topicTitle = gwTalk.topicTitle ?? existing.topicTitle;
      existing.objective = gwTalk.objective ?? existing.objective;
      existing.model = gwTalk.model ?? existing.model;
      existing.pinnedMessageIds = gwTalk.pinnedMessageIds ?? existing.pinnedMessageIds;
      existing.jobs = gwTalk.jobs ?? existing.jobs;
      // Only overwrite agents if gateway actually has agents; never replace
      // non-empty local agents with an empty array from gateway (sync may have
      // failed or gateway may have been restarted without agents).
      const gwAgents = gwTalk.agents;
      if (gwAgents && gwAgents.length > 0) {
        existing.agents = gwAgents;
      }
      existing.directives = gwTalk.directives ?? existing.directives;
      existing.platformBindings = gwTalk.platformBindings ?? existing.platformBindings;
      existing.updatedAt = gwTalk.updatedAt;
      existing.gatewayTalkId = gwTalk.id;
      return existing;
    }

    // Create a local talk entry backed by this gateway talk
    // sessionId matches the gateway talk ID since there's no local session
    const talk: Talk = {
      id: gwTalk.id,
      sessionId: gwTalk.id,
      topicTitle: gwTalk.topicTitle,
      objective: gwTalk.objective,
      model: gwTalk.model,
      pinnedMessageIds: gwTalk.pinnedMessageIds,
      jobs: gwTalk.jobs,
      agents: gwTalk.agents,
      directives: gwTalk.directives,
      platformBindings: gwTalk.platformBindings,
      gatewayTalkId: gwTalk.id,
      isSaved: true,
      createdAt: gwTalk.createdAt,
      updatedAt: gwTalk.updatedAt,
    };

    this.talks.set(talk.id, talk);
    return talk;
  }

  /** Persist talk metadata to disk (async, fire-and-forget). */
  private persistTalk(talk: Talk): void {
    const talkDir = path.join(TALKS_DIR, talk.id);
    const metaPath = path.join(talkDir, 'talk.json');

    fsp.mkdir(talkDir, { recursive: true })
      .then(() => fsp.writeFile(metaPath, JSON.stringify(talk, null, 2)))
      .catch(() => {});
  }
}

let talkManager: TalkManager | null = null;

export function getTalkManager(): TalkManager {
  if (!talkManager) {
    talkManager = new TalkManager();
  }
  return talkManager;
}
