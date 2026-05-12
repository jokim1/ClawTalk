import crypto from 'crypto';

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import {
  PROVIDER_SECRET_DEV_FALLBACK,
  PROVIDER_SECRET_KEY_ENV,
} from '../llm/provider-secret-store.js';

const AES_ALGO = 'aes-256-gcm';
const envConfig = readEnvFile([PROVIDER_SECRET_KEY_ENV]);
let warnedAboutFallbackSecret = false;

export interface GoogleToolCredentialPayload {
  kind: 'google_tools';
  accessToken: string;
  refreshToken?: string;
  expiryDate?: string | null;
  scopes: string[];
  tokenType?: string | null;
}

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
      'Using unsafe development fallback for Google tool credential encryption key',
    );
  }

  return PROVIDER_SECRET_DEV_FALLBACK;
}

function deriveKey(): Buffer {
  return crypto.scryptSync(getSecretMaterial(), 'clawrocket-google-tools', 32);
}

export function encryptGoogleToolCredential(
  payload: GoogleToolCredentialPayload,
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

export function decryptGoogleToolCredential(
  ciphertext: string,
): GoogleToolCredentialPayload {
  const parsed = JSON.parse(ciphertext) as {
    v: number;
    alg: string;
    iv: string;
    tag: string;
    data: string;
  };

  if (parsed.v !== 1 || parsed.alg !== AES_ALGO) {
    throw new Error('Unsupported Google tool credential payload format');
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
  const payload = JSON.parse(plaintext) as GoogleToolCredentialPayload;

  if (payload.kind !== 'google_tools') {
    throw new Error('Unknown Google tool credential payload kind');
  }
  if (!payload.accessToken || typeof payload.accessToken !== 'string') {
    throw new Error('Google tool credential missing accessToken');
  }
  if (
    payload.refreshToken !== undefined &&
    typeof payload.refreshToken !== 'string'
  ) {
    throw new Error('Google tool credential refreshToken must be a string');
  }
  if (
    payload.expiryDate !== undefined &&
    payload.expiryDate !== null &&
    typeof payload.expiryDate !== 'string'
  ) {
    throw new Error('Google tool credential expiryDate must be a string');
  }
  if (
    !Array.isArray(payload.scopes) ||
    payload.scopes.some((scope) => typeof scope !== 'string')
  ) {
    throw new Error('Google tool credential scopes must be a string array');
  }
  if (
    payload.tokenType !== undefined &&
    payload.tokenType !== null &&
    typeof payload.tokenType !== 'string'
  ) {
    throw new Error('Google tool credential tokenType must be a string');
  }

  return payload;
}
