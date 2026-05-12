import { randomUUID } from 'crypto';

import { logger } from '../../logger.js';
import {
  claimNextChannelIngressRow,
  enqueueChannelTurnAtomic,
  getTalkChannelBindingById,
  listChannelIngressFailures,
  markChannelIngressCompleted,
  markChannelIngressDeferred,
  markChannelIngressTerminal,
  resetChannelIngressProcessingOnStartup,
  type ChannelIngressQueueRecord,
} from '../db/index.js';
import type { TalkRunWorkerControl } from '../talks/run-worker.js';
import type { TalkLifecycleWakeBus } from './talk-lifecycle-wake-bus.js';
import type { QueuedInboundPayload } from './channel-router.js';
import { WakeablePollLoop } from './wakeable-poll-loop.js';

export interface ChannelIngressWorkerOptions {
  runWorker: TalkRunWorkerControl;
  talkLifecycleBus: TalkLifecycleWakeBus;
  pollMs?: number;
}

function parsePayload(row: ChannelIngressQueueRecord): QueuedInboundPayload {
  return JSON.parse(row.payload_json) as QueuedInboundPayload;
}

function buildMessageMetadata(
  binding: ReturnType<typeof getTalkChannelBindingById>,
  row: ChannelIngressQueueRecord,
  payload: QueuedInboundPayload,
): string {
  return JSON.stringify({
    kind: 'channel_inbound',
    bindingId: binding?.id || row.binding_id,
    platform: binding?.platform || 'telegram',
    connectionId: row.connection_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    targetDisplayName: payload.targetDisplayName,
    senderId: payload.senderId,
    senderName: payload.senderName,
    isMentioned: payload.isMentioned,
    timestamp: payload.timestamp,
    externalMessageId: payload.externalMessageId,
    metadata: payload.metadata || null,
  });
}

export class ChannelIngressWorker {
  private readonly pollMs: number;
  private readonly loop: WakeablePollLoop;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: ChannelIngressWorkerOptions) {
    this.pollMs = Math.max(100, Math.floor(options.pollMs ?? 5000));
    this.loop = new WakeablePollLoop({
      label: 'Channel ingress worker',
      pollMs: this.pollMs,
      onCycle: () => this.processCycle(),
    });
  }

  async start(): Promise<void> {
    resetChannelIngressProcessingOnStartup();
    this.unsubscribe = this.options.talkLifecycleBus.subscribeTalkTerminal(
      () => {
        this.wake();
      },
    );
    await this.loop.start();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.loop.stop();
  }

  wake(): void {
    this.loop.wake();
  }

  private processCycle(): boolean {
    let didWork = false;
    while (this.loop.isRunning()) {
      const row = claimNextChannelIngressRow();
      if (!row) break;
      didWork = true;
      this.processRow(row);
    }
    return didWork;
  }

  private processRow(row: ChannelIngressQueueRecord): void {
    const binding = getTalkChannelBindingById(row.binding_id);
    if (!binding || binding.active !== 1 || binding.connection_enabled !== 1) {
      markChannelIngressTerminal({
        rowId: row.id,
        status: 'dropped',
        reasonCode: 'binding_deactivated',
        reasonDetail: 'Binding is no longer active for queued ingress work',
      });
      return;
    }

    const payload = parsePayload(row);
    const now = new Date();
    const maxDeferredAgeMs = binding.max_deferred_age_minutes * 60 * 1000;
    if (now.getTime() - new Date(row.created_at).getTime() > maxDeferredAgeMs) {
      markChannelIngressTerminal({
        rowId: row.id,
        status: 'dropped',
        reasonCode: 'expired_while_busy',
        reasonDetail:
          'Queued ingress work expired before the talk became available',
      });
      return;
    }

    const enqueueResult = enqueueChannelTurnAtomic({
      talkId: row.talk_id,
      messageId: `msg_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      targetAgentId: binding.responder_agent_id || '',
      content: payload.content,
      metadataJson: buildMessageMetadata(binding, row, payload),
      externalCreatedAt: payload.timestamp,
      sourceBindingId: row.binding_id,
      sourceExternalMessageId: payload.externalMessageId,
      sourceThreadKey: payload.sourceThreadKey,
    });

    if (enqueueResult.status === 'enqueued') {
      markChannelIngressCompleted(row.id);
      this.options.runWorker.wake();
      return;
    }

    if (enqueueResult.status === 'thread_busy') {
      const nextAt = new Date(Date.now() + 5_000).toISOString();
      markChannelIngressDeferred({
        rowId: row.id,
        reasonDetail:
          'Target thread has an active round; retrying after the next availability window',
        availableAt: nextAt,
      });
      return;
    }

    markChannelIngressTerminal({
      rowId: row.id,
      status: 'dead_letter',
      reasonCode: 'enqueue_invalid_state',
      reasonDetail: enqueueResult.message,
    });
    logger.warn(
      {
        bindingId: row.binding_id,
        failures: listChannelIngressFailures(row.binding_id).length,
        code: enqueueResult.code,
      },
      'Dead-lettered queued inbound talk channel event',
    );
  }
}
