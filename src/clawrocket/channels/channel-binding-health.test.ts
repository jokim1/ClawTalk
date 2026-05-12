import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  clearBindingQuarantine,
  claimNextChannelDeliveryRow,
  createTalkChannelBinding,
  ensureSystemManagedTelegramConnection,
  getChannelDeliveryBindingState,
  getTalkChannelBindingById,
  markChannelDeliveryRetryOrDeadLetter,
  quarantineBinding,
  retryChannelDeliveryFailuresCapped,
  rollbackDeliveryAttemptCount,
  updateBindingDeliveryResult,
  updateConnectionProbeResult,
  upsertChannelConnection,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import {
  testTalkChannelBindingRoute,
  unquarantineTalkChannelBindingRoute,
  retryTalkChannelDeliveryFailuresCappedRoute,
} from '../web/routes/channels.js';
import { diagnoseBinding } from './channel-diagnosis.js';
import { ChannelDeliveryError } from './channel-errors.js';
import { ChannelDeliveryWorker } from './channel-delivery-worker.js';

let connectionId: string;
let bindingId: string;

function seedOutboxRow(
  overrides: Partial<{
    id: string;
    status: string;
    attemptCount: number;
    createdAt: string;
  }> = {},
): string {
  const id = overrides.id ?? `outbox_${Math.random().toString(36).slice(2)}`;
  const now = overrides.createdAt ?? '2024-06-01T00:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO channel_delivery_outbox (
        id, binding_id, talk_id, run_id, talk_message_id,
        target_kind, target_id, payload_json, status,
        reason_code, reason_detail, dedupe_key,
        available_at, created_at, updated_at, attempt_count
      ) VALUES (?, ?, 'talk-1', 'run-1', 'msg-1',
        'chat', 'tg:chat:123', '{"content":"hello"}', ?, NULL, NULL, ?,
        ?, ?, ?, ?)`,
    )
    .run(
      id,
      bindingId,
      overrides.status ?? 'pending',
      `dedupe_${id}`,
      now,
      now,
      now,
      overrides.attemptCount ?? 0,
    );
  return id;
}

beforeEach(() => {
  _initTestDatabase();
  upsertUser({
    id: 'owner-1',
    email: 'owner@example.com',
    displayName: 'Owner',
    role: 'owner',
  });
  const agent = createRegisteredAgent({
    name: 'Test Agent',
    providerId: 'provider.anthropic',
    modelId: 'claude-opus-4-6',
    toolPermissionsJson: '{}',
  });
  upsertTalk({
    id: 'talk-1',
    ownerId: 'owner-1',
    topicTitle: 'Test Talk',
  });
  getDb()
    .prepare(
      `INSERT INTO talk_agents (id, talk_id, registered_agent_id, is_primary, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, datetime('now'), datetime('now'))`,
    )
    .run('ta-1', 'talk-1', agent.id);

  const conn = ensureSystemManagedTelegramConnection(
    '2024-06-01T00:00:00.000Z',
  );
  connectionId = conn.id;

  const binding = createTalkChannelBinding({
    talkId: 'talk-1',
    connectionId,
    targetKind: 'chat',
    targetId: 'tg:chat:123',
    displayName: 'Test Chat',
    createdBy: 'owner-1',
    now: '2024-06-01T00:00:00.000Z',
  });
  bindingId = binding.id;
});

// ---------------------------------------------------------------------------
// P1: Disconnected rows preserve attempt_count via rollback
// ---------------------------------------------------------------------------

describe('rollbackDeliveryAttemptCount', () => {
  it('decrements attempt_count back to original value', () => {
    const rowId = seedOutboxRow({ attemptCount: 0 });
    // Simulate what claimNextChannelDeliveryRow does: increment to 1
    const claimed = claimNextChannelDeliveryRow('2024-06-01T00:01:00.000Z');
    expect(claimed).not.toBeNull();
    expect(claimed!.attempt_count).toBe(1);

    // Rollback the attempt
    rollbackDeliveryAttemptCount(claimed!.id);

    // Re-queue it so we can claim again
    markChannelDeliveryRetryOrDeadLetter({
      rowId: claimed!.id,
      deadLetter: false,
      reasonCode: 'connection_unreachable',
      reasonDetail: 'test',
      availableAt: '2024-06-01T00:01:01.000Z',
    });

    const reclaimed = claimNextChannelDeliveryRow('2024-06-01T00:02:00.000Z');
    expect(reclaimed).not.toBeNull();
    // Should be 1 (the 0 after rollback + 1 from this claim), not 2
    expect(reclaimed!.attempt_count).toBe(1);
  });

  it('does not go below 0', () => {
    const rowId = seedOutboxRow({ attemptCount: 0 });
    rollbackDeliveryAttemptCount(rowId);
    const row = getDb()
      .prepare('SELECT attempt_count FROM channel_delivery_outbox WHERE id = ?')
      .get(rowId) as { attempt_count: number };
    expect(row.attempt_count).toBe(0);
  });
});

describe('ChannelDeliveryWorker connection_unreachable path', () => {
  it('defers without consuming retry budget when connection is disconnected', async () => {
    // Mark connection as disconnected
    updateConnectionProbeResult(connectionId, false, 'probe fail 1');
    updateConnectionProbeResult(connectionId, false, 'probe fail 2');
    updateConnectionProbeResult(connectionId, false, 'probe fail 3');

    const state = getChannelDeliveryBindingState(bindingId);
    expect(state?.connection_health_status).toBe('disconnected');

    const sendDelivery = vi.fn();
    const worker = new ChannelDeliveryWorker({ sendDelivery, pollMs: 100 });

    // Seed a pending delivery row
    seedOutboxRow({ id: 'outbox-disconnect-1' });

    await worker.start();
    // Give it time to process
    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();

    // sendText should not have been called
    expect(sendDelivery).not.toHaveBeenCalled();

    // Row should be deferred with attempt_count still 0 (rolled back)
    const row = getDb()
      .prepare(
        'SELECT status, attempt_count, reason_code FROM channel_delivery_outbox WHERE id = ?',
      )
      .get('outbox-disconnect-1') as {
      status: string;
      attempt_count: number;
      reason_code: string;
    };
    expect(row.status).toBe('pending'); // re-queued as pending
    expect(row.reason_code).toBe('connection_unreachable');
    expect(row.attempt_count).toBe(0); // rolled back from the claim increment
  });
});

// ---------------------------------------------------------------------------
// P2: Quarantine gates
// ---------------------------------------------------------------------------

describe('quarantine gates', () => {
  it('delivery worker dead-letters quarantined binding rows', async () => {
    quarantineBinding(bindingId, 'bot_kicked');
    seedOutboxRow({ id: 'outbox-q-1' });

    const sendDelivery = vi.fn();
    const worker = new ChannelDeliveryWorker({ sendDelivery, pollMs: 100 });
    await worker.start();
    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();

    expect(sendDelivery).not.toHaveBeenCalled();
    const row = getDb()
      .prepare(
        'SELECT status, reason_code FROM channel_delivery_outbox WHERE id = ?',
      )
      .get('outbox-q-1') as { status: string; reason_code: string };
    expect(row.status).toBe('dead_letter');
    expect(row.reason_code).toBe('binding_quarantined');
  });
});

// ---------------------------------------------------------------------------
// P2: Recovery actions persist state
// ---------------------------------------------------------------------------

describe('unquarantineTalkChannelBindingRoute', () => {
  it('clears quarantine and updates delivery/connection state on success', async () => {
    quarantineBinding(bindingId, 'bot_kicked');
    updateConnectionProbeResult(connectionId, false, 'fail 1');
    updateConnectionProbeResult(connectionId, false, 'fail 2');
    updateConnectionProbeResult(connectionId, false, 'fail 3');

    const sendTestMessage = vi.fn().mockResolvedValue(undefined);
    const result = await unquarantineTalkChannelBindingRoute({
      auth: {
        userId: 'owner-1',
        role: 'owner',
        sessionId: 'sess-1',
        authType: 'cookie' as const,
      },
      talkId: 'talk-1',
      bindingId,
      sendTestMessage,
    });

    expect(result.statusCode).toBe(200);

    const binding = getTalkChannelBindingById(bindingId)!;
    expect(binding.health_quarantined).toBe(0);
    expect(binding.last_delivery_at).not.toBeNull();
    expect(binding.last_delivery_error_code).toBeNull();

    // Connection should be marked healthy
    const conn = getDb()
      .prepare(
        'SELECT health_status, consecutive_probe_failures FROM channel_connections WHERE id = ?',
      )
      .get(connectionId) as {
      health_status: string;
      consecutive_probe_failures: number;
    };
    expect(conn.health_status).toBe('healthy');
    expect(conn.consecutive_probe_failures).toBe(0);
  });

  it('persists error details on failed reconnect', async () => {
    quarantineBinding(bindingId, 'bot_kicked');

    const sendTestMessage = vi
      .fn()
      .mockRejectedValue(
        new ChannelDeliveryError('Bot was blocked', 'permanent', 'bot_kicked'),
      );
    const result = await unquarantineTalkChannelBindingRoute({
      auth: {
        userId: 'owner-1',
        role: 'owner',
        sessionId: 'sess-1',
        authType: 'cookie' as const,
      },
      talkId: 'talk-1',
      bindingId,
      sendTestMessage,
    });

    expect(result.statusCode).toBe(502);

    const binding = getTalkChannelBindingById(bindingId)!;
    expect(binding.health_quarantined).toBe(1);
    expect(binding.last_delivery_error_code).toBe('bot_kicked');
    expect(binding.last_delivery_error_detail).toBe('Bot was blocked');
    expect(binding.last_delivery_error_at).not.toBeNull();
  });
});

describe('testTalkChannelBindingRoute', () => {
  it('updates last_delivery_at and connection health on success', async () => {
    // Make connection unhealthy first
    updateConnectionProbeResult(connectionId, false, 'fail');
    updateConnectionProbeResult(connectionId, false, 'fail');
    updateConnectionProbeResult(connectionId, false, 'fail');

    const sendTestMessage = vi.fn().mockResolvedValue(undefined);
    const result = await testTalkChannelBindingRoute({
      auth: {
        userId: 'owner-1',
        role: 'owner',
        sessionId: 'sess-1',
        authType: 'cookie' as const,
      },
      talkId: 'talk-1',
      bindingId,
      sendTestMessage,
    });

    expect(result.statusCode).toBe(200);

    const binding = getTalkChannelBindingById(bindingId)!;
    expect(binding.last_delivery_at).not.toBeNull();

    const conn = getDb()
      .prepare('SELECT health_status FROM channel_connections WHERE id = ?')
      .get(connectionId) as { health_status: string };
    expect(conn.health_status).toBe('healthy');
  });

  it('formats Slack not_in_channel errors with invite guidance', async () => {
    const slackConnection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T123',
      displayName: 'KimFamily',
      enabled: true,
      healthStatus: 'healthy',
      config: {
        teamId: 'T123',
        teamName: 'KimFamily',
      },
    });
    const slackBinding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: slackConnection.id,
      targetKind: 'channel',
      targetId: 'slack:C123',
      displayName: '#general',
      createdBy: 'owner-1',
      now: '2024-06-01T00:00:00.000Z',
    });

    const result = await testTalkChannelBindingRoute({
      auth: {
        userId: 'owner-1',
        role: 'owner',
        sessionId: 'sess-1',
        authType: 'cookie' as const,
      },
      talkId: 'talk-1',
      bindingId: slackBinding.id,
      sendTestMessage: vi
        .fn()
        .mockRejectedValue(
          new ChannelDeliveryError(
            'not_in_channel',
            'permanent',
            'not_in_channel',
          ),
        ),
    });

    expect(result.statusCode).toBe(502);
    expect((result.body as any).error.message).toContain(
      'run /invite @YourAppName',
    );
  });
});

// ---------------------------------------------------------------------------
// P2: Retry-failures validation (capped route)
// ---------------------------------------------------------------------------

describe('retryTalkChannelDeliveryFailuresCappedRoute', () => {
  it('retries recent dead-lettered rows and skips old ones', () => {
    // Recent dead letter
    const recentId = seedOutboxRow({
      id: 'dl-recent',
      status: 'dead_letter',
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    // Old dead letter
    const oldId = seedOutboxRow({
      id: 'dl-old',
      status: 'dead_letter',
      createdAt: new Date(Date.now() - 120 * 60_000).toISOString(),
    });

    const result = retryTalkChannelDeliveryFailuresCappedRoute({
      auth: {
        userId: 'owner-1',
        role: 'owner',
        sessionId: 'sess-1',
        authType: 'cookie' as const,
      },
      talkId: 'talk-1',
      bindingId,
      maxAgeMins: 60,
      maxCount: 10,
    });

    expect(result.statusCode).toBe(200);
    const data = (result.body as any).data;
    expect(data.retried).toBe(1);
    expect(data.tooOld).toBe(1);
  });

  it('handles undefined maxAgeMins/maxCount gracefully', () => {
    seedOutboxRow({ id: 'dl-1', status: 'dead_letter' });

    const result = retryTalkChannelDeliveryFailuresCappedRoute({
      auth: {
        userId: 'owner-1',
        role: 'owner',
        sessionId: 'sess-1',
        authType: 'cookie' as const,
      },
      talkId: 'talk-1',
      bindingId,
      maxAgeMins: undefined,
      maxCount: undefined,
    });

    expect(result.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Diagnosis derivation
// ---------------------------------------------------------------------------

describe('diagnoseBinding', () => {
  it('returns paused when active=0', () => {
    const d = diagnoseBinding({
      active: 0,
      healthQuarantined: 0,
      healthQuarantineCode: null,
      connectionHealthStatus: 'healthy',
      deadLetterCount: 0,
      unresolvedIngressCount: 0,
      responseMode: 'all',
      lastIngressAt: null,
      lastDeliveryAt: null,
    });
    expect(d.status).toBe('paused');
  });

  it('returns quarantined with action when health_quarantined=1', () => {
    const d = diagnoseBinding({
      active: 1,
      healthQuarantined: 1,
      healthQuarantineCode: 'bot_kicked',
      connectionHealthStatus: 'healthy',
      deadLetterCount: 0,
      unresolvedIngressCount: 0,
      responseMode: 'all',
      lastIngressAt: null,
      lastDeliveryAt: null,
    });
    expect(d.status).toBe('quarantined');
    expect(d.action?.type).toBe('unquarantine');
    expect(d.headline).toContain('removed from group');
  });

  it('returns error when connection is disconnected', () => {
    const d = diagnoseBinding({
      active: 1,
      healthQuarantined: 0,
      healthQuarantineCode: null,
      connectionHealthStatus: 'disconnected',
      deadLetterCount: 0,
      unresolvedIngressCount: 0,
      responseMode: 'all',
      lastIngressAt: null,
      lastDeliveryAt: null,
    });
    expect(d.status).toBe('error');
  });

  it('returns warning when dead letters exist despite recent success', () => {
    const d = diagnoseBinding({
      active: 1,
      healthQuarantined: 0,
      healthQuarantineCode: null,
      connectionHealthStatus: 'healthy',
      deadLetterCount: 3,
      unresolvedIngressCount: 0,
      responseMode: 'all',
      lastIngressAt: new Date().toISOString(),
      lastDeliveryAt: new Date().toISOString(),
    });
    expect(d.status).toBe('warning');
    expect(d.headline).toContain('3 messages failed');
  });

  it('returns ok with response_mode=off note', () => {
    const d = diagnoseBinding({
      active: 1,
      healthQuarantined: 0,
      healthQuarantineCode: null,
      connectionHealthStatus: 'healthy',
      deadLetterCount: 0,
      unresolvedIngressCount: 0,
      responseMode: 'off',
      lastIngressAt: new Date().toISOString(),
      lastDeliveryAt: null,
    });
    expect(d.status).toBe('ok');
    expect(d.headline).toContain('responses paused');
  });

  it('returns warning for no activity', () => {
    const d = diagnoseBinding({
      active: 1,
      healthQuarantined: 0,
      healthQuarantineCode: null,
      connectionHealthStatus: 'healthy',
      deadLetterCount: 0,
      unresolvedIngressCount: 0,
      responseMode: 'all',
      lastIngressAt: null,
      lastDeliveryAt: null,
    });
    expect(d.status).toBe('warning');
    expect(d.headline).toBe('No activity yet');
    expect(d.action?.type).toBe('test');
  });

  it('returns ok with activity timestamps', () => {
    const d = diagnoseBinding({
      active: 1,
      healthQuarantined: 0,
      healthQuarantineCode: null,
      connectionHealthStatus: 'healthy',
      deadLetterCount: 0,
      unresolvedIngressCount: 0,
      responseMode: 'all',
      lastIngressAt: new Date().toISOString(),
      lastDeliveryAt: new Date().toISOString(),
    });
    expect(d.status).toBe('ok');
    expect(d.headline).toContain('Receiving');
    expect(d.headline).toContain('Sending');
  });
});

// ---------------------------------------------------------------------------
// Connection probe state transitions
// ---------------------------------------------------------------------------

describe('updateConnectionProbeResult', () => {
  it('transitions healthy → degraded → disconnected → healthy', () => {
    let conn = getDb()
      .prepare(
        'SELECT health_status, consecutive_probe_failures FROM channel_connections WHERE id = ?',
      )
      .get(connectionId) as {
      health_status: string;
      consecutive_probe_failures: number;
    };
    expect(conn.health_status).toBe('healthy');
    expect(conn.consecutive_probe_failures).toBe(0);

    updateConnectionProbeResult(connectionId, false, 'fail 1');
    conn = getDb()
      .prepare(
        'SELECT health_status, consecutive_probe_failures FROM channel_connections WHERE id = ?',
      )
      .get(connectionId) as typeof conn;
    expect(conn.health_status).toBe('degraded');
    expect(conn.consecutive_probe_failures).toBe(1);

    updateConnectionProbeResult(connectionId, false, 'fail 2');
    conn = getDb()
      .prepare(
        'SELECT health_status, consecutive_probe_failures FROM channel_connections WHERE id = ?',
      )
      .get(connectionId) as typeof conn;
    expect(conn.health_status).toBe('degraded');
    expect(conn.consecutive_probe_failures).toBe(2);

    updateConnectionProbeResult(connectionId, false, 'fail 3');
    conn = getDb()
      .prepare(
        'SELECT health_status, consecutive_probe_failures FROM channel_connections WHERE id = ?',
      )
      .get(connectionId) as typeof conn;
    expect(conn.health_status).toBe('disconnected');
    expect(conn.consecutive_probe_failures).toBe(3);

    updateConnectionProbeResult(connectionId, true);
    conn = getDb()
      .prepare(
        'SELECT health_status, consecutive_probe_failures FROM channel_connections WHERE id = ?',
      )
      .get(connectionId) as typeof conn;
    expect(conn.health_status).toBe('healthy');
    expect(conn.consecutive_probe_failures).toBe(0);
  });
});
