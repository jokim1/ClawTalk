/**
 * Tests for TalkManager.importGatewayTalk
 *
 * Verifies that gateway talks are correctly imported into
 * the local TalkManager, and existing talks are updated
 * with gateway-authoritative metadata.
 */

import { TalkManager } from '../services/talks';

// Create a TalkManager that operates entirely in-memory
// (we override loadTalks to skip file I/O)
function createTestTalkManager(): TalkManager {
  // Suppress file system operations for tests
  const originalLoadTalks = TalkManager.prototype.loadTalks;
  TalkManager.prototype.loadTalks = function () {};

  const mgr = new TalkManager();

  // Restore original method
  TalkManager.prototype.loadTalks = originalLoadTalks;

  return mgr;
}

describe('TalkManager.importGatewayTalk', () => {
  let mgr: TalkManager;

  beforeEach(() => {
    mgr = createTestTalkManager();
  });

  it('imports a new gateway talk as a local saved talk', () => {
    const result = mgr.importGatewayTalk({
      id: 'gw-talk-1',
      topicTitle: 'Sprint Planning',
      objective: 'Plan Q2',
      model: 'claude-opus',
      pinnedMessageIds: ['msg-1', 'msg-2'],
      createdAt: 1000,
      updatedAt: 2000,
    });

    expect(result.id).toBe('gw-talk-1');
    expect(result.topicTitle).toBe('Sprint Planning');
    expect(result.objective).toBe('Plan Q2');
    expect(result.model).toBe('claude-opus');
    expect(result.pinnedMessageIds).toEqual(['msg-1', 'msg-2']);
    expect(result.gatewayTalkId).toBe('gw-talk-1');
    expect(result.isSaved).toBe(true);
    expect(result.createdAt).toBe(1000);
    expect(result.updatedAt).toBe(2000);
  });

  it('imported talk appears in listSavedTalks', () => {
    mgr.importGatewayTalk({
      id: 'gw-1',
      createdAt: 1000,
      updatedAt: 2000,
    });

    const saved = mgr.listSavedTalks();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('gw-1');
  });

  it('imported talk is retrievable by getTalk', () => {
    mgr.importGatewayTalk({
      id: 'gw-1',
      topicTitle: 'Test',
      createdAt: 1000,
      updatedAt: 2000,
    });

    const talk = mgr.getTalk('gw-1');
    expect(talk).not.toBeNull();
    expect(talk!.topicTitle).toBe('Test');
  });

  it('updates existing local talk with gateway metadata', () => {
    // Create a local talk first
    const local = mgr.createTalk('session-1');

    // Import gateway data for the same ID
    const result = mgr.importGatewayTalk({
      id: local.id,
      topicTitle: 'Updated from Gateway',
      objective: 'New objective',
      model: 'claude-sonnet',
      pinnedMessageIds: ['pin-1'],
      createdAt: local.createdAt,
      updatedAt: Date.now() + 1000,
    });

    expect(result.id).toBe(local.id);
    expect(result.topicTitle).toBe('Updated from Gateway');
    expect(result.objective).toBe('New objective');
    expect(result.model).toBe('claude-sonnet');
    expect(result.pinnedMessageIds).toEqual(['pin-1']);
    expect(result.gatewayTalkId).toBe(local.id);
  });

  it('preserves local fields not present in gateway data', () => {
    // Create a local talk with a topic title
    const local = mgr.createTalk('session-1');
    mgr.setTopicTitle(local.id, 'Local Title');

    // Import gateway data WITHOUT a topicTitle
    mgr.importGatewayTalk({
      id: local.id,
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
    });

    // Local title should be preserved (gateway didn't provide one)
    const talk = mgr.getTalk(local.id);
    expect(talk!.topicTitle).toBe('Local Title');
  });

  it('gateway data overrides local data when present', () => {
    const local = mgr.createTalk('session-1');
    mgr.setTopicTitle(local.id, 'Local Title');

    mgr.importGatewayTalk({
      id: local.id,
      topicTitle: 'Gateway Title',
      createdAt: local.createdAt,
      updatedAt: local.updatedAt + 1,
    });

    expect(mgr.getTalk(local.id)!.topicTitle).toBe('Gateway Title');
  });

  it('handles multiple gateway imports', () => {
    mgr.importGatewayTalk({ id: 'gw-1', topicTitle: 'Talk 1', createdAt: 1000, updatedAt: 3000 });
    mgr.importGatewayTalk({ id: 'gw-2', topicTitle: 'Talk 2', createdAt: 2000, updatedAt: 4000 });
    mgr.importGatewayTalk({ id: 'gw-3', topicTitle: 'Talk 3', createdAt: 3000, updatedAt: 5000 });

    const saved = mgr.listSavedTalks();
    expect(saved).toHaveLength(3);
    // Sorted by updatedAt, most recent first
    expect(saved[0].topicTitle).toBe('Talk 3');
    expect(saved[1].topicTitle).toBe('Talk 2');
    expect(saved[2].topicTitle).toBe('Talk 1');
  });

  it('sets sessionId to gateway talk ID for new imports', () => {
    const result = mgr.importGatewayTalk({
      id: 'gw-1',
      createdAt: 1000,
      updatedAt: 2000,
    });

    expect(result.sessionId).toBe('gw-1');
  });

  it('does not overwrite sessionId on existing local talk', () => {
    const local = mgr.createTalk('original-session');

    mgr.importGatewayTalk({
      id: local.id,
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
    });

    // sessionId should still be the original
    expect(mgr.getTalk(local.id)!.sessionId).toBe('original-session');
  });

  it('handles import with minimal data (only required fields)', () => {
    const result = mgr.importGatewayTalk({
      id: 'minimal',
      createdAt: 1000,
      updatedAt: 2000,
    });

    expect(result.id).toBe('minimal');
    expect(result.topicTitle).toBeUndefined();
    expect(result.objective).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.gatewayTalkId).toBe('minimal');
    expect(result.isSaved).toBe(true);
  });
});
