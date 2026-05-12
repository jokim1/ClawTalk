import {
  clearBindingQuarantine,
  claimNextChannelDeliveryRow,
  getChannelDeliveryBindingState,
  markChannelDeliveryRetryOrDeadLetter,
  markChannelDeliverySent,
  quarantineBinding,
  resetChannelDeliverySendingOnStartup,
  rollbackDeliveryAttemptCount,
  updateBindingDeliveryResult,
} from '../db/index.js';
import { ChannelDeliveryError } from './channel-errors.js';
import { logger } from '../../logger.js';
import { WakeablePollLoop } from './wakeable-poll-loop.js';
import type { ChannelDeliveryPayload } from '../../types.js';

const TRANSIENT_BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 600_000] as const;
const RATE_LIMIT_BACKOFF_MS = [
  5_000, 30_000, 60_000, 120_000, 600_000,
] as const;

export interface ChannelDeliveryWorkerOptions {
  sendDelivery: (payload: ChannelDeliveryPayload) => Promise<void>;
  pollMs?: number;
}

export class ChannelDeliveryWorker {
  private readonly pollMs: number;
  private readonly loop: WakeablePollLoop;

  constructor(private readonly options: ChannelDeliveryWorkerOptions) {
    this.pollMs = Math.max(100, Math.floor(options.pollMs ?? 5000));
    this.loop = new WakeablePollLoop({
      label: 'Channel delivery worker',
      pollMs: this.pollMs,
      onCycle: async () => this.processCycle(),
    });
  }

  async start(): Promise<void> {
    resetChannelDeliverySendingOnStartup();
    await this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  wake(): void {
    this.loop.wake();
  }

  private async processCycle(): Promise<boolean> {
    let didWork = false;
    while (this.loop.isRunning()) {
      const row = claimNextChannelDeliveryRow();
      if (!row) break;
      didWork = true;
      await this.processRow(row);
    }
    return didWork;
  }

  private async processRow(row: {
    id: string;
    binding_id: string;
    target_id: string;
    payload_json: string;
    attempt_count: number;
  }): Promise<void> {
    const bindingState = getChannelDeliveryBindingState(row.binding_id);
    if (
      !bindingState ||
      bindingState.active !== 1 ||
      bindingState.connection_enabled !== 1
    ) {
      markChannelDeliveryRetryOrDeadLetter({
        rowId: row.id,
        deadLetter: true,
        reasonCode: 'binding_deactivated',
        reasonDetail: 'Binding is inactive or unavailable for delivery',
      });
      return;
    }

    // Quarantined bindings should not attempt delivery
    if (bindingState.health_quarantined === 1) {
      markChannelDeliveryRetryOrDeadLetter({
        rowId: row.id,
        deadLetter: true,
        reasonCode: 'binding_quarantined',
        reasonDetail:
          'Binding is quarantined due to persistent delivery failures',
      });
      return;
    }

    // Connection unreachable — defer, don't dead-letter (connection may recover).
    // Roll back the attempt_count that claimNextChannelDeliveryRow incremented,
    // since no actual send was attempted — otherwise a prolonged outage exhausts
    // the retry budget without ever trying to deliver.
    if (bindingState.connection_health_status === 'disconnected') {
      rollbackDeliveryAttemptCount(row.id);
      markChannelDeliveryRetryOrDeadLetter({
        rowId: row.id,
        deadLetter: false,
        reasonCode: 'connection_unreachable',
        reasonDetail:
          'Connection health probe indicates the platform is unreachable',
        availableAt: new Date(Date.now() + 30_000).toISOString(),
      });
      return;
    }

    const payload = JSON.parse(row.payload_json) as {
      content: string;
      deliveryMode?: 'reply' | 'channel';
      sourceThreadKey?: string | null;
      sourceExternalMessageId?: string | null;
      metadata?: Record<string, unknown> | null;
    };
    try {
      await this.options.sendDelivery({
        connectionId: bindingState.connection_id,
        targetId: row.target_id,
        content: payload.content,
        deliveryMode: payload.deliveryMode,
        sourceThreadKey: payload.sourceThreadKey || null,
        sourceExternalMessageId: payload.sourceExternalMessageId || null,
        metadata: payload.metadata || null,
      });
      markChannelDeliverySent(row.id);
      const now = new Date().toISOString();
      updateBindingDeliveryResult(row.binding_id, {
        lastDeliveryAt: now,
      });
      // If binding was quarantined before (shouldn't reach here normally,
      // but handle re-quarantine clearing on successful test-send paths)
      if (bindingState.health_quarantined === 1) {
        clearBindingQuarantine(row.binding_id);
      }
    } catch (error) {
      const deliveryError =
        error instanceof ChannelDeliveryError
          ? error
          : new ChannelDeliveryError(
              error instanceof Error
                ? error.message
                : 'Channel delivery failed',
              'transient',
              'unknown',
            );

      const now = new Date().toISOString();

      if (deliveryError.kind === 'permanent') {
        // Dead-letter immediately and quarantine the binding
        markChannelDeliveryRetryOrDeadLetter({
          rowId: row.id,
          deadLetter: true,
          reasonCode: deliveryError.code,
          reasonDetail: deliveryError.message,
        });
        quarantineBinding(row.binding_id, deliveryError.code);
        updateBindingDeliveryResult(row.binding_id, {
          errorCode: deliveryError.code,
          errorDetail: deliveryError.message,
          errorAt: now,
        });
        logger.warn(
          {
            rowId: row.id,
            bindingId: row.binding_id,
            code: deliveryError.code,
          },
          'Permanent delivery failure — binding quarantined',
        );
        return;
      }

      const backoffSchedule =
        deliveryError.kind === 'rate_limited'
          ? RATE_LIMIT_BACKOFF_MS
          : TRANSIENT_BACKOFF_MS;

      const backoff =
        backoffSchedule[
          Math.max(
            0,
            Math.min(backoffSchedule.length - 1, row.attempt_count - 1),
          )
        ];
      const deadLetter = row.attempt_count >= backoffSchedule.length;

      markChannelDeliveryRetryOrDeadLetter({
        rowId: row.id,
        deadLetter,
        reasonCode: deadLetter
          ? 'delivery_retries_exhausted'
          : deliveryError.kind === 'rate_limited'
            ? 'delivery_rate_limited'
            : 'delivery_transient_failure',
        reasonDetail: deliveryError.message,
        availableAt: new Date(Date.now() + backoff).toISOString(),
      });

      updateBindingDeliveryResult(row.binding_id, {
        errorCode: deliveryError.code,
        errorDetail: deliveryError.message,
        errorAt: now,
      });

      if (!deadLetter) {
        logger.warn(
          {
            rowId: row.id,
            bindingId: row.binding_id,
            attempt: row.attempt_count,
            kind: deliveryError.kind,
          },
          'Scheduled channel delivery retry',
        );
      }
    }
  }
}
