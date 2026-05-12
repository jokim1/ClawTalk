import crypto from 'crypto';

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import type { ProviderSecretPayload } from './types.js';

export const PROVIDER_SECRET_KEY_ENV = 'CLAWROCKET_PROVIDER_SECRET_KEY';
export const PROVIDER_SECRET_DEV_FALLBACK =
  'clawrocket-dev-provider-secret-key-unsafe-default';
const AES_ALGO = 'aes-256-gcm';
let warnedAboutFallbackSecret = false;
const envConfig = readEnvFile([PROVIDER_SECRET_KEY_ENV]);

function getSecretMaterial(): string {
  const configured = (
    process.env[PROVIDER_SECRET_KEY_ENV] ||
    envConfig[PROVIDER_SECRET_KEY_ENV] ||
    ''
  ).trim();
  if (configured) return configured;

  if (!warnedAboutFallbackSecret && process.env.NODE_ENV !== 'test') {
    warnedAboutFallbackSecret = true;
    logger.warn(
      { envVar: PROVIDER_SECRET_KEY_ENV },
      'Using unsafe development fallback for Talk provider secret encryption key',
    );
  }

  return PROVIDER_SECRET_DEV_FALLBACK;
}

function deriveKey(): Buffer {
  return crypto.scryptSync(
    getSecretMaterial(),
    'clawrocket-provider-store',
    32,
  );
}

function validateProviderSecretPayload(
  payload: ProviderSecretPayload,
): ProviderSecretPayload {
  if (!payload.apiKey || typeof payload.apiKey !== 'string') {
    throw new Error('Provider secret payload missing apiKey');
  }
  if (
    payload.organizationId !== undefined &&
    typeof payload.organizationId !== 'string'
  ) {
    throw new Error('Provider secret payload organizationId must be a string');
  }
  return payload;
}

export function encryptProviderSecret(payload: ProviderSecretPayload): string {
  const iv = crypto.randomBytes(12);
  const key = deriveKey();
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
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

export function decryptProviderSecret(
  ciphertext: string,
): ProviderSecretPayload {
  const parsed = JSON.parse(ciphertext) as {
    v: number;
    alg: string;
    iv: string;
    tag: string;
    data: string;
  };

  if (parsed.v !== 1 || parsed.alg !== AES_ALGO) {
    throw new Error('Unsupported provider secret payload format');
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
  const payload = JSON.parse(plaintext) as ProviderSecretPayload;
  return validateProviderSecretPayload(payload);
}
