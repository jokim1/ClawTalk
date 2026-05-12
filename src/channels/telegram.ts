import { Api, Bot, GrammyError } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { ChannelDeliveryError } from '../clawrocket/channels/channel-errors.js';
import { resolveTelegramCredential } from '../clawrocket/channels/telegram-connector.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ChannelDeliveryPayload,
  ChannelTargetObservation,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  connectionId: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onTargetObserved?: ChannelOpts['onTargetObserved'];
  onInboundEvent?: ChannelOpts['onInboundEvent'];
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function buildTelegramTargetId(chatId: string | number): string {
  return `tg:${chatId}`;
}

function getTelegramTargetKind(chatType: string): 'chat' | 'channel' {
  return chatType === 'channel' ? 'channel' : 'chat';
}

function getTelegramChatDisplayName(chat: Record<string, any>): string {
  if (chat.type === 'private') {
    const firstName =
      typeof chat.first_name === 'string' ? chat.first_name : '';
    const lastName = typeof chat.last_name === 'string' ? chat.last_name : '';
    const combined = `${firstName} ${lastName}`.trim();
    if (combined) return combined;
  }
  if (typeof chat.title === 'string' && chat.title.trim()) {
    return chat.title.trim();
  }
  if (typeof chat.username === 'string' && chat.username.trim()) {
    return `@${chat.username.trim()}`;
  }
  return buildTelegramTargetId(String(chat.id ?? 'unknown'));
}

function buildTelegramTargetObservation(input: {
  connectionId: string;
  chat: Record<string, any>;
  timestamp: string;
  metadata?: Record<string, unknown> | null;
}): ChannelTargetObservation {
  return {
    platform: 'telegram',
    connection_id: input.connectionId,
    target_kind: getTelegramTargetKind(String(input.chat.type || 'private')),
    target_id: buildTelegramTargetId(String(input.chat.id)),
    display_name: getTelegramChatDisplayName(input.chat),
    observed_at: input.timestamp,
    metadata: {
      chatType: String(input.chat.type || 'private'),
      username:
        typeof input.chat.username === 'string' ? input.chat.username : null,
      title: typeof input.chat.title === 'string' ? input.chat.title : null,
      ...input.metadata,
    },
  };
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    const observeTarget = async (
      chat: Record<string, any>,
      timestamp: string,
      metadata?: Record<string, unknown> | null,
    ) => {
      await this.opts.onTargetObserved?.(
        buildTelegramTargetObservation({
          connectionId: this.opts.connectionId,
          chat,
          timestamp,
          metadata,
        }),
      );
    };

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;
      if (ctx.from?.is_bot || ctx.from?.id === ctx.me?.id) return;

      const chatJid = buildTelegramTargetId(ctx.chat.id);
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : getTelegramChatDisplayName(ctx.chat as Record<string, any>);

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      const entities = ctx.message.entities || [];
      const isBotMentioned = botUsername
        ? entities.some((entity) => {
            if (entity.type !== 'mention') return false;
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          })
        : false;
      if (botUsername) {
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      await observeTarget(ctx.chat as Record<string, any>, timestamp, {
        isGroup,
        source: 'message',
      });
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const consumed = this.opts.onInboundEvent
        ? await this.opts.onInboundEvent({
            platform: 'telegram',
            connection_id: this.opts.connectionId,
            target_kind: 'chat',
            target_id: chatJid,
            platform_event_id: ctx.update.update_id.toString(),
            external_message_id: msgId,
            sender_id: sender,
            sender_name: senderName,
            content,
            timestamp,
            target_display_name: chatName,
            is_mentioned: isBotMentioned,
            metadata: {
              isGroup,
              chatType: ctx.chat.type,
            },
          })
        : false;
      if (consumed) {
        logger.info(
          { chatJid, chatName, sender: senderName },
          'Telegram message routed to talk channel binding',
        );
        return;
      }

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = async (ctx: any, placeholder: string) => {
      if (ctx.from?.is_bot || ctx.from?.id === ctx.me?.id) return;
      const chatJid = buildTelegramTargetId(ctx.chat.id);
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const content = `${placeholder}${caption}`;
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : getTelegramChatDisplayName(ctx.chat as Record<string, any>);

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      await observeTarget(ctx.chat as Record<string, any>, timestamp, {
        isGroup,
        source: 'message',
        nonText: true,
      });
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const consumed = this.opts.onInboundEvent
        ? await this.opts.onInboundEvent({
            platform: 'telegram',
            connection_id: this.opts.connectionId,
            target_kind: 'chat',
            target_id: chatJid,
            platform_event_id: ctx.update.update_id.toString(),
            external_message_id: ctx.message.message_id.toString(),
            sender_id: ctx.from?.id?.toString() || null,
            sender_name: senderName,
            content,
            timestamp,
            target_display_name: chatName,
            is_mentioned: false,
            metadata: {
              isGroup,
              chatType: ctx.chat.type,
              nonText: true,
            },
          })
        : false;
      if (consumed) return;

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    const handleChannelPost = async (ctx: any, placeholder?: string) => {
      const message = ctx.channelPost;
      if (!message) return;
      const timestamp = new Date(message.date * 1000).toISOString();
      const targetId = buildTelegramTargetId(ctx.chat.id);
      const channelName = getTelegramChatDisplayName(
        ctx.chat as Record<string, any>,
      );
      const suffix = message.caption ? ` ${message.caption}` : '';
      const rawText =
        typeof message.text === 'string' && message.text.trim()
          ? message.text
          : '';
      const content = rawText || `${placeholder || '[Channel post]'}${suffix}`;

      await observeTarget(ctx.chat as Record<string, any>, timestamp, {
        source: 'channel_post',
      });
      this.opts.onChatMetadata(
        targetId,
        timestamp,
        channelName,
        'telegram',
        false,
      );

      if (!this.opts.onInboundEvent) return;
      await this.opts.onInboundEvent({
        platform: 'telegram',
        connection_id: this.opts.connectionId,
        target_kind: 'channel',
        target_id: targetId,
        platform_event_id: ctx.update.update_id.toString(),
        external_message_id: message.message_id.toString(),
        sender_id: null,
        sender_name: null,
        content,
        timestamp,
        target_display_name: channelName,
        is_mentioned: false,
        metadata: {
          chatType: 'channel',
          source: 'channel_post',
          nonText: !rawText,
        },
      });
    };

    this.bot.on('message:photo', (ctx) => void storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => void storeNonText(ctx, '[Video]'));
    this.bot.on(
      'message:voice',
      (ctx) => void storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) => void storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      void storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      void storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on(
      'message:location',
      (ctx) => void storeNonText(ctx, '[Location]'),
    );
    this.bot.on(
      'message:contact',
      (ctx) => void storeNonText(ctx, '[Contact]'),
    );
    this.bot.on('channel_post:text', (ctx) => void handleChannelPost(ctx));
    this.bot.on(
      'channel_post:photo',
      (ctx) => void handleChannelPost(ctx, '[Photo]'),
    );
    this.bot.on(
      'channel_post:video',
      (ctx) => void handleChannelPost(ctx, '[Video]'),
    );
    this.bot.on('channel_post:document', (ctx) => {
      const name = ctx.channelPost?.document?.file_name || 'file';
      void handleChannelPost(ctx, `[Document: ${name}]`);
    });
    this.bot.on(
      'channel_post:audio',
      (ctx) => void handleChannelPost(ctx, '[Audio]'),
    );
    this.bot.on(
      'channel_post:voice',
      (ctx) => void handleChannelPost(ctx, '[Voice message]'),
    );
    this.bot.on('channel_post:sticker', (ctx) => {
      const emoji = ctx.channelPost?.sticker?.emoji || '';
      void handleChannelPost(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('my_chat_member', (ctx) => {
      const timestamp = new Date(ctx.myChatMember.date * 1000).toISOString();
      const status = ctx.myChatMember.new_chat_member?.status || null;
      const previousStatus = ctx.myChatMember.old_chat_member?.status || null;
      return observeTarget(ctx.chat as Record<string, any>, timestamp, {
        source: 'my_chat_member',
        membershipStatus: status,
        previousMembershipStatus: previousStatus,
      });
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.sendDelivery({
      connectionId: this.opts.connectionId,
      targetId: jid,
      content: text,
    });
  }

  async sendDelivery(payload: ChannelDeliveryPayload): Promise<void> {
    if (!this.bot) {
      throw new ChannelDeliveryError(
        'Telegram bot not initialized',
        'transient',
        'bot_not_initialized',
      );
    }

    try {
      const numericId = payload.targetId.replace(/^tg:/, '');
      const replyToMessageId =
        payload.deliveryMode === 'reply' &&
        payload.sourceExternalMessageId &&
        /^\d+$/.test(payload.sourceExternalMessageId)
          ? Number(payload.sourceExternalMessageId)
          : undefined;

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (payload.content.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, payload.content, {
          reply_parameters: replyToMessageId
            ? { message_id: replyToMessageId }
            : undefined,
        });
      } else {
        for (let i = 0; i < payload.content.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            payload.content.slice(i, i + MAX_LENGTH),
            {
              reply_parameters:
                i === 0 && replyToMessageId
                  ? { message_id: replyToMessageId }
                  : undefined,
            },
          );
        }
      }
      logger.info(
        { jid: payload.targetId, length: payload.content.length },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error(
        { jid: payload.targetId, err },
        'Failed to send Telegram message',
      );
      throw classifyTelegramError(err);
    }
  }

  async probe(): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }
    await this.bot.api.getMe();
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<boolean> {
  if (poolApis.length === 0) {
    logger.warn('No pool bots available for Telegram pool send');
    return false;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned pool bot');
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
    return true;
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
    return false;
  }
}

function classifyTelegramError(err: unknown): ChannelDeliveryError {
  if (err instanceof GrammyError) {
    const status = err.error_code;
    const desc = (err.description || '').toLowerCase();

    // 403 — bot kicked, blocked, or lacks permissions
    if (status === 403) {
      if (desc.includes('bot was kicked') || desc.includes('bot was blocked')) {
        return new ChannelDeliveryError(err.message, 'permanent', 'bot_kicked');
      }
      return new ChannelDeliveryError(err.message, 'permanent', 'forbidden');
    }

    // 400 — chat not found, peer invalid
    if (status === 400) {
      if (desc.includes('chat not found') || desc.includes('peer_id_invalid')) {
        return new ChannelDeliveryError(
          err.message,
          'permanent',
          'chat_not_found',
        );
      }
      return new ChannelDeliveryError(err.message, 'permanent', 'bad_request');
    }

    // 429 — rate limited
    if (status === 429) {
      return new ChannelDeliveryError(
        err.message,
        'rate_limited',
        'rate_limited',
      );
    }

    // 5xx — transient server errors
    if (status >= 500) {
      return new ChannelDeliveryError(err.message, 'transient', 'api_error');
    }
  }

  // Network errors and everything else → transient
  const message = err instanceof Error ? err.message : 'Unknown send error';
  return new ChannelDeliveryError(message, 'transient', 'network_timeout');
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const credential = resolveTelegramCredential();
  const token = credential.token || '';
  if (!token) {
    logger.warn(
      { tokenSource: credential.tokenSource },
      'Telegram bot token not configured',
    );
    return null;
  }
  return new TelegramChannel(token, opts);
});
