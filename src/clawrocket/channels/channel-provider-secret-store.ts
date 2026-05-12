import crypto from 'crypto';

import { logger } from '../../logger.js';

export type ChannelProviderSecretPayload = {
  kind: 'slack_app';
  clientSecret: string;
  signingSecret: string;
};

const SECRET_KEY_ENV = 'CLAWROCKET_CHANNEL_SECRET_KEY';
const DEV_FALLBACK_SECRET = 'clawrocket-dev-channel-secret-key-unsafe-default';
const AES_ALGO = 'aes-256-gcm';
let warnedAboutFallbackSecret = false;

function getSecretMaterial(): string {
  const configured = process.env[SECRET_KEY_ENV]?.trim();
  if (configured) return configured;

  if (!warnedAboutFallbackSecret && process.env.NODE_ENV !== 'test') {
    warnedAboutFallbackSecret = true;
    logger.warn(
      { envVar: SECRET_KEY_ENV },
      'Using unsafe development fallback for channel provider secret encryption key',
    );
  }

  return DEV_FALLBACK_SECRET;
}

function deriveKey(): Buffer {
  return crypto.scryptSync(
    getSecretMaterial(),
    'clawrocket-channel-provider-store',
    32,
  );
}

export function encryptChannelProviderSecret(
  payload: ChannelProviderSecretPayload,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, deriveKey(), iv);
  const plaintext = JSON.stringify(payload);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: AES_ALGO,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  });
}

export function decryptChannelProviderSecret(
  ciphertext: string,
): ChannelProviderSecretPayload {
  const parsed = JSON.parse(ciphertext) as {
    v: number;
    alg: string;
    iv: string;
    tag: string;
    data: string;
  };

  if (parsed.v !== 1 || parsed.alg !== AES_ALGO) {
    throw new Error('Unsupported channel provider secret payload format');
  }

  const decipher = crypto.createDecipheriv(
    AES_ALGO,
    deriveKey(),
    Buffer.from(parsed.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const payload = JSON.parse(plaintext) as ChannelProviderSecretPayload;

  if (
    payload.kind !== 'slack_app' ||
    !payload.clientSecret?.trim() ||
    !payload.signingSecret?.trim()
  ) {
    throw new Error('Channel provider secret payload missing Slack app secret');
  }

  return payload;
}
