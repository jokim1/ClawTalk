import crypto from 'crypto';

import { logger } from '../../logger.js';
import type { ConnectorSecretPayload } from './types.js';

const SECRET_KEY_ENV = 'CLAWROCKET_CONNECTOR_SECRET_KEY';
const DEV_FALLBACK_SECRET =
  'clawrocket-dev-connector-secret-key-unsafe-default';
const AES_ALGO = 'aes-256-gcm';
let warnedAboutFallbackSecret = false;

function getSecretMaterial(): string {
  const configured = process.env[SECRET_KEY_ENV]?.trim();
  if (configured) return configured;

  if (!warnedAboutFallbackSecret && process.env.NODE_ENV !== 'test') {
    warnedAboutFallbackSecret = true;
    logger.warn(
      { envVar: SECRET_KEY_ENV },
      'Using unsafe development fallback for connector secret encryption key',
    );
  }

  return DEV_FALLBACK_SECRET;
}

function deriveKey(): Buffer {
  return crypto.scryptSync(
    getSecretMaterial(),
    'clawrocket-connector-store',
    32,
  );
}

export function encryptConnectorSecret(
  payload: ConnectorSecretPayload,
): string {
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

export function decryptConnectorSecret(
  ciphertext: string,
): ConnectorSecretPayload {
  const parsed = JSON.parse(ciphertext) as {
    v: number;
    alg: string;
    iv: string;
    tag: string;
    data: string;
  };

  if (parsed.v !== 1 || parsed.alg !== AES_ALGO) {
    throw new Error('Unsupported connector secret payload format');
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
  const payload = JSON.parse(plaintext) as ConnectorSecretPayload;

  if (payload.kind === 'posthog') {
    if (!payload.apiKey || typeof payload.apiKey !== 'string') {
      throw new Error('Connector secret payload missing PostHog apiKey');
    }
    return payload;
  }

  if (payload.kind === 'google_sheets') {
    if (!payload.accessToken || typeof payload.accessToken !== 'string') {
      throw new Error(
        'Connector secret payload missing Google Sheets accessToken',
      );
    }
    if (
      payload.refreshToken !== undefined &&
      typeof payload.refreshToken !== 'string'
    ) {
      throw new Error('Connector secret payload refreshToken must be a string');
    }
    if (
      payload.expiryDate !== undefined &&
      payload.expiryDate !== null &&
      typeof payload.expiryDate !== 'string'
    ) {
      throw new Error('Connector secret payload expiryDate must be a string');
    }
    if (
      payload.scopes !== undefined &&
      (!Array.isArray(payload.scopes) ||
        payload.scopes.some((scope) => typeof scope !== 'string'))
    ) {
      throw new Error('Connector secret payload scopes must be a string array');
    }
    return payload;
  }

  if (payload.kind === 'google_docs') {
    if (!payload.accessToken || typeof payload.accessToken !== 'string') {
      throw new Error(
        'Connector secret payload missing Google Docs accessToken',
      );
    }
    if (
      payload.refreshToken !== undefined &&
      typeof payload.refreshToken !== 'string'
    ) {
      throw new Error('Connector secret payload refreshToken must be a string');
    }
    if (
      payload.expiryDate !== undefined &&
      payload.expiryDate !== null &&
      typeof payload.expiryDate !== 'string'
    ) {
      throw new Error('Connector secret payload expiryDate must be a string');
    }
    if (
      payload.scopes !== undefined &&
      (!Array.isArray(payload.scopes) ||
        payload.scopes.some((scope) => typeof scope !== 'string'))
    ) {
      throw new Error('Connector secret payload scopes must be a string array');
    }
    return payload;
  }

  throw new Error('Unknown connector secret payload kind');
}
