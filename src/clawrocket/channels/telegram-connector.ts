import { Api } from 'grammy';

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import {
  ensureSystemManagedTelegramConnection,
  getChannelConnectionSecret,
} from '../db/channel-accessors.js';
import { decryptChannelSecret } from './channel-secret-store.js';

export type TelegramTokenSource = 'db' | 'env' | 'missing';

export interface ResolvedTelegramCredential {
  tokenSource: TelegramTokenSource;
  token: string | null;
  envTokenAvailable: boolean;
  hasStoredSecret: boolean;
}

export interface TelegramBotIdentity {
  botUserId: number;
  botUsername: string | null;
  botDisplayName: string;
  canJoinGroups: boolean;
}

export interface ResolvedTelegramTarget {
  targetKind: 'chat' | 'channel';
  targetId: string;
  displayName: string;
  metadata: Record<string, unknown>;
}

function readEnvTelegramToken(): string {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  return (
    process.env.TELEGRAM_BOT_TOKEN ||
    envVars.TELEGRAM_BOT_TOKEN ||
    ''
  ).trim();
}

function formatTelegramChatDisplayName(chat: Record<string, unknown>): string {
  if (typeof chat.title === 'string' && chat.title.trim()) {
    return chat.title.trim();
  }
  if (typeof chat.first_name === 'string' && chat.first_name.trim()) {
    const lastName =
      typeof chat.last_name === 'string' && chat.last_name.trim()
        ? ` ${chat.last_name.trim()}`
        : '';
    return `${chat.first_name.trim()}${lastName}`;
  }
  if (typeof chat.username === 'string' && chat.username.trim()) {
    return `@${chat.username.trim()}`;
  }
  return `tg:${String(chat.id ?? 'unknown')}`;
}

function isPrivateInviteLink(input: string): boolean {
  return /^https?:\/\/t\.me\/\+/.test(input) || /^t\.me\/\+/.test(input);
}

function normalizeTargetRef(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('A Telegram destination is required.');
  }
  if (isPrivateInviteLink(trimmed)) {
    throw new Error(
      'Private Telegram invite links cannot be used directly. Add the bot to the destination and wait for it to appear as discovered, or use a known @username / tg:<id>.',
    );
  }
  if (trimmed.startsWith('tg:')) {
    return trimmed.slice(3);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return trimmed;
  }
  if (/^@[A-Za-z0-9_]{4,}$/.test(trimmed)) {
    return trimmed;
  }
  const publicLinkMatch = trimmed.match(
    /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})\/?$/,
  );
  if (publicLinkMatch?.[1]) {
    return `@${publicLinkMatch[1]}`;
  }
  throw new Error(
    'Use a known Telegram destination such as @username, t.me/<username>, tg:<chat_id>, or a numeric chat ID.',
  );
}

export function resolveTelegramCredential(): ResolvedTelegramCredential {
  const connection = ensureSystemManagedTelegramConnection();
  const envToken = readEnvTelegramToken();
  const envTokenAvailable = envToken.length > 0;
  const stored = getChannelConnectionSecret(connection.id);
  const hasStoredSecret = Boolean(stored?.ciphertext);

  if (stored?.ciphertext) {
    try {
      const payload = decryptChannelSecret(stored.ciphertext);
      return {
        tokenSource: 'db',
        token: payload.botToken.trim(),
        envTokenAvailable,
        hasStoredSecret: true,
      };
    } catch (error) {
      logger.error(
        { err: error, connectionId: connection.id },
        'Failed to decrypt Telegram channel secret; falling back to env token if present',
      );
    }
  }

  if (envTokenAvailable) {
    return {
      tokenSource: 'env',
      token: envToken,
      envTokenAvailable: true,
      hasStoredSecret,
    };
  }

  return {
    tokenSource: 'missing',
    token: null,
    envTokenAvailable: false,
    hasStoredSecret,
  };
}

export async function probeTelegramBotToken(
  botToken: string,
): Promise<TelegramBotIdentity> {
  const api = new Api(botToken.trim());
  const me = await api.getMe();
  return {
    botUserId: me.id,
    botUsername: me.username || null,
    botDisplayName: me.first_name || me.username || `Bot ${me.id}`,
    canJoinGroups: Boolean(me.can_join_groups),
  };
}

export async function resolveTelegramTargetInput(input: {
  botToken: string;
  rawInput: string;
}): Promise<ResolvedTelegramTarget> {
  const api = new Api(input.botToken.trim());
  const chatRef = normalizeTargetRef(input.rawInput);
  const chat = (await api.getChat(chatRef)) as unknown as Record<
    string,
    unknown
  >;
  const type = String(chat.type || 'private');
  const isChannel = type === 'channel';
  return {
    targetKind: isChannel ? 'channel' : 'chat',
    targetId: `tg:${String(chat.id)}`,
    displayName: formatTelegramChatDisplayName(chat),
    metadata: {
      chatType: type,
      username: typeof chat.username === 'string' ? chat.username : null,
      title: typeof chat.title === 'string' ? chat.title : null,
    },
  };
}
