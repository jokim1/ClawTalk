// clawtalk Phase 5 PR 2 — Web Crypto provider-secret store.
//
// Sibling of the legacy `provider-secret-store.ts` (node:crypto). The
// caller swap will route `ai-agents.ts`, `execution-planner.ts`, and
// `execution-resolver.ts` through this async API, at which point the
// node:crypto file gets deleted.
//
// Behavior change vs sqlite-era:
//   - Async API (await encryptProviderSecret/decryptProviderSecret).
//   - AES-256-GCM via Web Crypto (works in both Workers and Node 19+).
//   - PBKDF2-SHA256 100k iterations. Cloudflare Workers caps PBKDF2 at
//     100k and throws on anything higher.
//   - Wire format is byte-compatible with the node:crypto version
//     (same `v=1, alg, iv, tag, data` shape). Rows written under the
//     old API decrypt fine under the new one.

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import type { ProviderSecretPayload } from './types.js';

export const PROVIDER_SECRET_KEY_ENV = 'CLAWTALK_PROVIDER_SECRET_KEY';
export const PROVIDER_SECRET_DEV_FALLBACK =
  'clawtalk-dev-provider-secret-key-unsafe-default';

const AES_ALGO = 'aes-256-gcm';
const KDF_SALT = 'clawtalk-provider-store';
// Workers cap PBKDF2 at 100k iterations — anything higher throws
// "iteration counts above 100000 are not supported". 100k is the
// OWASP 2017 baseline and acceptable for this threat model: the
// master key lives in Workers Secrets (CLAWTALK_PROVIDER_SECRET_KEY),
// so an attacker would need both the ciphertext (DB row) and the
// master key before iteration count matters.
const KDF_ITERATIONS = 100_000;
const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;

type DerivedKey = Awaited<ReturnType<typeof deriveKey>>;

let warnedAboutFallbackSecret = false;
const envConfig = readEnvFile([PROVIDER_SECRET_KEY_ENV]);
let cachedKey: Promise<DerivedKey> | null = null;

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

async function deriveKey() {
  const passphrase = new TextEncoder().encode(getSecretMaterial());
  const salt = new TextEncoder().encode(KDF_SALT);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    passphrase,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function getKey(): Promise<DerivedKey> {
  if (!cachedKey) cachedKey = deriveKey();
  return cachedKey;
}

/** Test-only: drop the cached derived key so a fresh secret material
 * (e.g., from a swapped .env in a test) takes effect on the next call. */
export function _resetCachedKeyForTests(): void {
  cachedKey = null;
  warnedAboutFallbackSecret = false;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

export async function encryptProviderSecret(
  payload: ProviderSecretPayload,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const key = await getKey();
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  // Web Crypto appends the 16-byte auth tag to the ciphertext output;
  // split it back out so the wire format matches the node:crypto shape.
  const data = sealed.slice(0, sealed.length - GCM_TAG_BYTES);
  const tag = sealed.slice(sealed.length - GCM_TAG_BYTES);
  return JSON.stringify({
    v: 1,
    alg: AES_ALGO,
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
    data: bytesToBase64(data),
  });
}

export async function decryptProviderSecret(
  ciphertext: string,
): Promise<ProviderSecretPayload> {
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

  const iv = base64ToBytes(parsed.iv);
  const data = base64ToBytes(parsed.data);
  const tag = base64ToBytes(parsed.tag);
  // Web Crypto expects ciphertext + tag as one contiguous buffer.
  const sealed = new Uint8Array(data.length + tag.length);
  sealed.set(data, 0);
  sealed.set(tag, data.length);

  const key = await getKey();
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    sealed,
  );
  const plaintext = new TextDecoder('utf-8').decode(plaintextBuf);
  const payload = JSON.parse(plaintext) as ProviderSecretPayload;
  return validateProviderSecretPayload(payload);
}
