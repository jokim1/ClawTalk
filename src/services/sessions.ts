/**
 * Session Manager
 *
 * Handles session persistence, multi-session support, and context recovery.
 * Write operations use async I/O (fire-and-forget) to avoid blocking the event loop.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Message, Session, SearchResult } from '../types';
import type { ISessionManager } from './interfaces.js';
import { DEFAULT_MODEL } from '../constants.js';

/** Validate that a session ID is safe for use as a directory name. */
function isValidSessionId(id: string): boolean {
  return /^[\w-]+$/.test(id) && !id.includes('..');
}

export const SESSIONS_DIR = path.join(process.env.HOME || '~', '.clawtalk', 'sessions');

export class SessionManager implements ISessionManager {
  private sessions: Map<string, Session> = new Map();
  private activeSessionId: string | null = null;

  constructor() {
    this.ensureSessionsDir();
    this.loadSessions();
  }

  private ensureSessionsDir(): void {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  private loadSessions(): void {
    try {
      const dirs = fs.readdirSync(SESSIONS_DIR);
      for (const dir of dirs) {
        if (!isValidSessionId(dir)) continue;
        const sessionPath = path.join(SESSIONS_DIR, dir);
        const metaPath = path.join(sessionPath, 'metadata.json');

        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            const transcriptPath = path.join(sessionPath, 'transcript.jsonl');
            const messages: Message[] = [];

            if (fs.existsSync(transcriptPath)) {
              const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
              for (const line of lines) {
                try {
                  messages.push(JSON.parse(line));
                } catch (err) {
                  console.debug('Skipping invalid transcript line:', err);
                }
              }
            }

            if (messages.length === 0) {
              fsp.rm(sessionPath, { recursive: true }).catch(() => {});
              continue;
            }

            const session: Session = {
              id: dir,
              name: meta.name || dir,
              model: meta.model || DEFAULT_MODEL,
              messages,
              createdAt: meta.createdAt || Date.now(),
              updatedAt: meta.updatedAt || Date.now(),
            };

            this.sessions.set(dir, session);
          } catch (err) {
            console.debug('Skipping corrupted session:', dir, err);
          }
        }
      }
    } catch (err) {
      console.debug('Sessions directory not readable:', err);
    }
  }

  createSession(name?: string, model?: string): Session {
    const id = `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const session: Session = {
      id,
      name: name || `Session ${this.sessions.size + 1}`,
      model: model || DEFAULT_MODEL,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(id, session);
    this.activeSessionId = id;

    return session;
  }

  getActiveSession(): Session {
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      return this.sessions.get(this.activeSessionId)!;
    }

    const sessions = this.listSessions();
    if (sessions.length > 0) {
      this.activeSessionId = sessions[0].id;
      return sessions[0];
    }

    return this.createSession();
  }

  setActiveSession(sessionId: string): Session | null {
    if (this.sessions.has(sessionId)) {
      this.activeSessionId = sessionId;
      return this.sessions.get(sessionId)!;
    }
    return null;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values())
      .filter(s => s.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  addMessage(message: Message): void {
    const session = this.getActiveSession();
    session.messages.push(message);
    session.updatedAt = Date.now();
    this.persistTranscript(session.id, message);
    this.persistSessionMeta(session);
  }

  /** Add a message to a specific session by ID (for background completion). */
  addMessageToSession(sessionId: string, message: Message): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.messages.push(message);
    session.updatedAt = Date.now();
    this.persistTranscript(sessionId, message);
    this.persistSessionMeta(session);
    return true;
  }

  setSessionModel(model: string): void {
    const session = this.getActiveSession();
    session.model = model;
    session.updatedAt = Date.now();
    this.persistSessionMeta(session);
  }

  clearActiveSession(): void {
    const session = this.getActiveSession();
    session.messages = [];
    session.updatedAt = Date.now();

    const transcriptPath = path.join(SESSIONS_DIR, session.id, 'transcript.jsonl');
    fsp.writeFile(transcriptPath, '').catch(() => {});

    this.persistSessionMeta(session);
  }

  deleteSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    if (!isValidSessionId(sessionId)) return false;

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const resolved = path.resolve(sessionPath);
    if (!resolved.startsWith(path.resolve(SESSIONS_DIR))) return false;

    fsp.rm(sessionPath, { recursive: true }).catch(() => {});

    this.sessions.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }

    return true;
  }

  renameSession(sessionId: string, newName: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.name = newName;
    session.updatedAt = Date.now();
    this.persistSessionMeta(session);

    return true;
  }

  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getSessionDir(sessionId: string): string {
    return path.join(SESSIONS_DIR, sessionId);
  }

  searchTranscripts(query: string): SearchResult[] {
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const session of this.sessions.values()) {
      for (const message of session.messages) {
        if (message.role === 'system') continue;
        const lowerContent = message.content.toLowerCase();
        const matchIndex = lowerContent.indexOf(lowerQuery);
        if (matchIndex !== -1) {
          results.push({
            sessionId: session.id,
            sessionName: session.name,
            sessionUpdatedAt: session.updatedAt,
            message,
            matchIndex,
          });
        }
      }
    }

    results.sort((a, b) => {
      if (a.sessionUpdatedAt !== b.sessionUpdatedAt) {
        return b.sessionUpdatedAt - a.sessionUpdatedAt;
      }
      return b.message.timestamp - a.message.timestamp;
    });

    return results;
  }

  getContextSummary(maxMessages = 10): string {
    const session = this.getActiveSession();
    const recentMessages = session.messages.slice(-maxMessages);

    if (recentMessages.length === 0) return '';

    const summary = recentMessages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`)
      .join('\n\n');

    return `Previous conversation summary:\n\n${summary}`;
  }

  /** Persist session metadata to disk (async, fire-and-forget). */
  private persistSessionMeta(session: Session): void {
    const sessionPath = path.join(SESSIONS_DIR, session.id);
    const metaPath = path.join(sessionPath, 'metadata.json');
    const meta = JSON.stringify({
      name: session.name,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    }, null, 2);

    fsp.mkdir(sessionPath, { recursive: true })
      .then(() => fsp.writeFile(metaPath, meta))
      .catch(() => {});
  }

  /** Append a message to the session transcript (async, fire-and-forget). */
  private persistTranscript(sessionId: string, message: Message): void {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const transcriptPath = path.join(sessionPath, 'transcript.jsonl');
    const line = JSON.stringify(message) + '\n';

    fsp.mkdir(sessionPath, { recursive: true })
      .then(() => fsp.appendFile(transcriptPath, line))
      .catch(() => {});
  }
}

let sessionManager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager();
  }
  return sessionManager;
}
