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
import type { Talk, Message } from '../types';
import { generateContextMd } from './context-generator.js';

/** Validate that a talk ID is safe for use as a directory name. */
function isValidTalkId(id: string): boolean {
  return /^[\w-]+$/.test(id) && !id.includes('..');
}

export const TALKS_DIR = path.join(process.env.HOME || '~', '.remoteclaw', 'talks');

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

  /** Generate and save AI context markdown for a talk. */
  updateContextMd(talkId: string, messages: Message[]): void {
    const talk = this.talks.get(talkId);
    if (!talk) return;

    const contextMd = generateContextMd(talk, messages);
    const talkDir = path.join(TALKS_DIR, talkId);
    const contextPath = path.join(talkDir, 'context.md');

    fsp.mkdir(talkDir, { recursive: true })
      .then(() => fsp.writeFile(contextPath, contextMd))
      .catch(() => {});
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
