import { logger } from '../../logger.js';
import type { TalkChannelInboundEvent } from '../../types.js';
import {
  countRecentChannelIngressEvents,
  enqueueChannelIngressEvent,
  getResolvedTalkChannelBinding,
  updateBindingLastIngressAt,
  type ResolvedTalkChannelBindingRecord,
  upsertChannelTarget,
} from '../db/index.js';

export interface TalkChannelRouterControl {
  wake(): void;
}

export interface QueuedInboundPayload {
  content: string;
  timestamp: string;
  targetDisplayName: string | null;
  senderId: string | null;
  senderName: string | null;
  isMentioned: boolean;
  sourceThreadKey: string | null;
  externalMessageId: string | null;
  metadata: Record<string, unknown> | null;
}

function parseAllowedSenders(
  allowedSendersJson: string | null,
): string[] | null {
  if (!allowedSendersJson) return null;
  try {
    const parsed = JSON.parse(allowedSendersJson) as unknown;
    if (!Array.isArray(parsed)) return null;
    const normalized = parsed
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function passesResponseGate(
  binding: ResolvedTalkChannelBindingRecord,
  event: TalkChannelInboundEvent,
): { accepted: boolean; reason: string } {
  if (binding.connection_enabled !== 1) {
    return { accepted: false, reason: 'connection_disabled' };
  }
  if (binding.active !== 1) {
    return { accepted: false, reason: 'binding_inactive' };
  }
  if (binding.health_quarantined === 1) {
    return { accepted: false, reason: 'binding_quarantined' };
  }
  if (binding.response_mode === 'off') {
    return { accepted: false, reason: 'response_mode_off' };
  }
  if (binding.response_mode === 'mentions' && !event.is_mentioned) {
    return { accepted: false, reason: 'response_mode_no_match' };
  }
  const allowedSenders = parseAllowedSenders(binding.allowed_senders_json);
  if (
    allowedSenders &&
    !allowedSenders.includes(event.sender_id || '') &&
    !allowedSenders.includes(event.sender_name || '')
  ) {
    return { accepted: false, reason: 'sender_not_allowed' };
  }
  const eventTimestampMs = Date.parse(event.timestamp);
  const since = Number.isFinite(eventTimestampMs)
    ? new Date(eventTimestampMs - 60_000).toISOString()
    : new Date(Date.now() - 60_000).toISOString();
  const recentAcceptedCount = countRecentChannelIngressEvents({
    bindingId: binding.id,
    since,
  });
  if (recentAcceptedCount >= binding.inbound_rate_limit_per_minute) {
    return { accepted: false, reason: 'rate_limited' };
  }
  return { accepted: true, reason: 'accepted' };
}

export class TalkChannelRouter {
  constructor(private readonly ingressWorker: TalkChannelRouterControl) {}

  async handleInboundEvent(event: TalkChannelInboundEvent): Promise<boolean> {
    const connectionId = event.connection_id;
    if (!connectionId) return false;

    upsertChannelTarget({
      connectionId,
      targetKind: event.target_kind,
      targetId: event.target_id,
      displayName: event.target_display_name || event.target_id,
      metadataJson: JSON.stringify(event.metadata || {}),
      lastSeenAt: event.timestamp,
    });

    const binding = getResolvedTalkChannelBinding({
      connectionId,
      targetKind: event.target_kind,
      targetId: event.target_id,
    });
    if (!binding) {
      return false;
    }

    const gate = passesResponseGate(binding, event);
    if (!gate.accepted) {
      logger.debug(
        {
          bindingId: binding.id,
          targetId: event.target_id,
          reason: gate.reason,
        },
        'Talk channel inbound event rejected by response gate',
      );
      return true;
    }

    const payload: QueuedInboundPayload = {
      content: event.content,
      timestamp: event.timestamp,
      targetDisplayName: event.target_display_name,
      senderId: event.sender_id,
      senderName: event.sender_name,
      isMentioned: event.is_mentioned,
      sourceThreadKey:
        typeof event.metadata?.sourceThreadKey === 'string'
          ? event.metadata.sourceThreadKey
          : null,
      externalMessageId: event.external_message_id,
      metadata: event.metadata || null,
    };

    const queued = enqueueChannelIngressEvent({
      bindingId: binding.id,
      talkId: binding.talk_id,
      connectionId,
      targetKind: event.target_kind,
      targetId: event.target_id,
      platformEventId: event.platform_event_id,
      externalMessageId: event.external_message_id,
      senderId: event.sender_id,
      senderName: event.sender_name,
      payloadJson: JSON.stringify(payload),
      dedupeKey: `${connectionId}:${event.platform_event_id}`,
      maxPendingEvents: binding.max_pending_events,
      overflowPolicy: binding.overflow_policy,
      now: event.timestamp,
    });

    if (queued.status === 'queued') {
      this.ingressWorker.wake();
      updateBindingLastIngressAt(binding.id, event.timestamp);
      logger.info(
        {
          bindingId: binding.id,
          talkId: binding.talk_id,
          evictedRowId: queued.evictedRowId,
        },
        'Queued inbound talk channel event',
      );
      return true;
    }

    if (queued.status === 'dropped') {
      logger.info(
        {
          bindingId: binding.id,
          talkId: binding.talk_id,
          senderName: event.sender_name,
          reason: queued.reasonCode,
        },
        'Dropped inbound talk channel event',
      );
      return true;
    }

    logger.debug(
      {
        bindingId: binding.id,
        talkId: binding.talk_id,
        rowId: queued.rowId,
      },
      'Skipped duplicate inbound talk channel event',
    );
    return true;
  }
}
