import { ChannelDeliveryError } from '../clawrocket/channels/channel-errors.js';
import { logger } from '../logger.js';
import { slackApiRequest } from './slack-api.js';
import {
  Channel,
  ChannelDeliveryPayload,
  ChannelTargetObservation,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  TalkChannelInboundEvent,
} from '../types.js';

export interface SlackEventEnvelope {
  team_id?: string;
  event_id?: string;
  event_time?: number;
  type?: string;
  event?: Record<string, unknown>;
}

export interface SlackChannelOpts {
  connectionId: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onTargetObserved?: (
    observation: ChannelTargetObservation,
  ) => void | Promise<void>;
  onInboundEvent?: (
    event: TalkChannelInboundEvent,
  ) => boolean | Promise<boolean>;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

type SlackAuthIdentity = {
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
};

type CachedValue = {
  value: string;
  expiresAtMs: number;
};

type SlackConversation = {
  id: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
};

function buildSlackTargetId(channelId: string): string {
  return `slack:${channelId}`;
}

function readString(
  object: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = object?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function formatSlackSenderName(userId: string): string {
  return userId ? `Slack user ${userId}` : 'Slack user';
}

export class SlackChannel implements Channel {
  name = 'slack';

  private readonly userNameCache = new Map<string, CachedValue>();
  private readonly channelNameCache = new Map<string, CachedValue>();
  private authIdentity: SlackAuthIdentity | null = null;

  constructor(
    private readonly botToken: string,
    private readonly opts: SlackChannelOpts,
  ) {}

  async connect(): Promise<void> {
    this.authIdentity = await this.fetchAuthIdentity();
    logger.info(
      {
        connectionId: this.opts.connectionId,
        teamId: this.authIdentity.teamId,
      },
      'Slack workspace connected',
    );
  }

  async disconnect(): Promise<void> {
    this.authIdentity = null;
    this.userNameCache.clear();
    this.channelNameCache.clear();
  }

  isConnected(): boolean {
    return this.authIdentity !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async probe(): Promise<void> {
    await this.fetchAuthIdentity();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.sendDelivery({
      connectionId: this.opts.connectionId,
      targetId: jid,
      content: text,
    });
  }

  async sendDelivery(payload: ChannelDeliveryPayload): Promise<void> {
    const channelId = payload.targetId.replace(/^slack:/, '');
    const threadTs =
      payload.deliveryMode === 'reply' && payload.sourceThreadKey
        ? payload.sourceThreadKey
        : undefined;
    try {
      const response = await slackApiRequest<{
        ok: boolean;
        error?: string;
      }>({
        botToken: this.botToken,
        url: 'https://slack.com/api/chat.postMessage',
        method: 'POST',
        body: new URLSearchParams({
          channel: channelId,
          text: payload.content,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      });
      if (!response.ok) {
        throw classifySlackSendError(response.error || 'slack_send_failed');
      }
    } catch (error) {
      if (error instanceof ChannelDeliveryError) {
        throw error;
      }
      throw classifySlackSendError(
        error instanceof Error ? error.message : 'slack_send_failed',
      );
    }
  }

  async handlePlatformEvent(rawEvent: unknown): Promise<void> {
    const envelope = rawEvent as SlackEventEnvelope;
    if (!envelope || envelope.type !== 'event_callback' || !envelope.event) {
      return;
    }

    const event = envelope.event;
    const eventType = readString(event, 'type');
    if (!eventType) return;

    if (eventType === 'app_mention') {
      await this.handleMessageLikeEvent(envelope, event, true);
      return;
    }
    if (eventType === 'message') {
      const subtype = readString(event, 'subtype');
      if (subtype) return;
      const channelType = readString(event, 'channel_type');
      if (channelType !== 'channel' && channelType !== 'group') return;
      await this.handleMessageLikeEvent(envelope, event, false);
    }
  }

  private async handleMessageLikeEvent(
    envelope: SlackEventEnvelope,
    event: Record<string, unknown>,
    isMentioned: boolean,
  ): Promise<void> {
    const channelId = readString(event, 'channel');
    const senderId = readString(event, 'user');
    const text = readString(event, 'text') || '';
    const eventTs = readString(event, 'ts');
    const threadTs = readString(event, 'thread_ts') || eventTs;
    const channelType = readString(event, 'channel_type') || 'channel';

    if (!channelId || !eventTs) return;
    if (!text.trim()) return;

    const timestamp = new Date(
      typeof envelope.event_time === 'number'
        ? envelope.event_time * 1000
        : Date.now(),
    ).toISOString();
    const senderName = senderId
      ? await this.resolveUserDisplayName(senderId)
      : null;
    const channelDisplayName = await this.resolveChannelDisplayName(channelId);
    const targetId = buildSlackTargetId(channelId);
    const metadata: Record<string, unknown> = {
      channelId,
      channelType,
      slackTs: eventTs,
      sourceThreadKey: threadTs || null,
      teamId: envelope.team_id || this.authIdentity?.teamId || null,
    };

    await this.opts.onTargetObserved?.({
      platform: 'slack',
      connection_id: this.opts.connectionId,
      target_kind: 'channel',
      target_id: targetId,
      display_name: channelDisplayName,
      observed_at: timestamp,
      metadata,
    });

    this.opts.onChatMetadata(
      targetId,
      timestamp,
      channelDisplayName || targetId,
      'slack',
      true,
    );

    const consumed = this.opts.onInboundEvent
      ? await this.opts.onInboundEvent({
          platform: 'slack',
          connection_id: this.opts.connectionId,
          target_kind: 'channel',
          target_id: targetId,
          platform_event_id: envelope.event_id || `slack:${eventTs}`,
          external_message_id: eventTs,
          sender_id: senderId,
          sender_name: senderName,
          content: text,
          timestamp,
          target_display_name: channelDisplayName,
          is_mentioned: isMentioned || this.isBotMention(text),
          metadata,
        })
      : false;
    if (consumed) {
      return;
    }

    const group = this.opts.registeredGroups()[targetId];
    if (!group) return;

    this.opts.onMessage(targetId, {
      id: eventTs,
      chat_jid: targetId,
      sender: senderId || '',
      sender_name: senderName || formatSlackSenderName(senderId || ''),
      content: text,
      timestamp,
      is_from_me: false,
    });
  }

  private isBotMention(text: string): boolean {
    const botUserId = this.authIdentity?.botUserId;
    if (!botUserId) return false;
    return text.includes(`<@${botUserId}>`);
  }

  private async fetchAuthIdentity(): Promise<SlackAuthIdentity> {
    const response = await slackApiRequest<{
      ok: boolean;
      error?: string;
      team?: string;
      team_id?: string;
      user_id?: string;
    }>({
      botToken: this.botToken,
      url: 'https://slack.com/api/auth.test',
    });
    if (!response.ok || !response.team_id) {
      throw new Error(response.error || 'Slack auth.test failed.');
    }
    return {
      teamId: response.team_id,
      teamName: response.team || null,
      botUserId: response.user_id || null,
    };
  }

  private async resolveUserDisplayName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.value;
    }
    try {
      const response = await slackApiRequest<{
        ok: boolean;
        error?: string;
        user?: {
          id?: string;
          name?: string;
          profile?: {
            display_name?: string;
            real_name?: string;
          };
        };
      }>({
        botToken: this.botToken,
        url: `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
      });
      if (!response.ok || !response.user) {
        throw new Error(response.error || 'users.info failed');
      }
      const value =
        response.user.profile?.display_name ||
        response.user.profile?.real_name ||
        response.user.name ||
        formatSlackSenderName(userId);
      this.userNameCache.set(userId, {
        value,
        expiresAtMs: Date.now() + 5 * 60_000,
      });
      return value;
    } catch {
      return formatSlackSenderName(userId);
    }
  }

  private async resolveChannelDisplayName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.value;
    }
    try {
      const response = await slackApiRequest<{
        ok: boolean;
        error?: string;
        channel?: SlackConversation;
      }>({
        botToken: this.botToken,
        url: `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`,
      });
      if (!response.ok || !response.channel?.id) {
        throw new Error(response.error || 'conversations.info failed');
      }
      const value = response.channel.name
        ? `#${response.channel.name}`
        : buildSlackTargetId(channelId);
      this.channelNameCache.set(channelId, {
        value,
        expiresAtMs: Date.now() + 5 * 60_000,
      });
      return value;
    } catch {
      return buildSlackTargetId(channelId);
    }
  }
}

function classifySlackSendError(code: string): ChannelDeliveryError {
  switch (code) {
    case 'channel_not_found':
    case 'not_in_channel':
      return new ChannelDeliveryError(code, 'permanent', code);
    case 'token_revoked':
    case 'invalid_auth':
      return new ChannelDeliveryError(code, 'permanent', 'invalid_auth');
    case 'ratelimited':
      return new ChannelDeliveryError(code, 'rate_limited', 'rate_limited');
    default:
      return new ChannelDeliveryError(
        code,
        'transient',
        'slack_delivery_failed',
      );
  }
}
