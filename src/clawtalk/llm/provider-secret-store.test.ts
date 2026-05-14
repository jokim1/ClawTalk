// clawtalk Phase 5 PR 2 — Web Crypto provider-secret tests.
//
// Mirrors the legacy node:crypto test shape (.env-swap roundtrip)
// plus a few additional assertions: roundtrip preservation,
// tamper-detection on the auth tag.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('provider-secret-store-pg', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('roundtrips: encrypt → decrypt returns same payload', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'clawtalk-secret-pg-rt-'),
    );
    process.chdir(tempDir);
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'CLAWTALK_PROVIDER_SECRET_KEY=roundtrip-key\n',
      'utf8',
    );
    vi.resetModules();
    const store = await import('./provider-secret-store.js');
    const ciphertext = await store.encryptProviderSecret({
      apiKey: 'sk-test-roundtrip',
      organizationId: 'org-roundtrip',
    });
    const decrypted = await store.decryptProviderSecret(ciphertext);
    expect(decrypted.apiKey).toBe('sk-test-roundtrip');
    expect(decrypted.organizationId).toBe('org-roundtrip');
  });

  it('different env keys produce mutually-incompatible ciphertexts', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'clawtalk-secret-pg-swap-'),
    );
    process.chdir(tempDir);
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'CLAWTALK_PROVIDER_SECRET_KEY=env-secret-one\n',
      'utf8',
    );

    vi.resetModules();
    const storeA = await import('./provider-secret-store.js');
    const ciphertext = await storeA.encryptProviderSecret({
      apiKey: 'sk-test-123',
    });

    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'CLAWTALK_PROVIDER_SECRET_KEY=env-secret-two\n',
      'utf8',
    );
    vi.resetModules();
    const storeB = await import('./provider-secret-store.js');
    await expect(storeB.decryptProviderSecret(ciphertext)).rejects.toThrow();
  });

  it('rejects ciphertext with the wrong format version', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'clawtalk-secret-pg-ver-'),
    );
    process.chdir(tempDir);
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'CLAWTALK_PROVIDER_SECRET_KEY=any-key\n',
      'utf8',
    );
    vi.resetModules();
    const store = await import('./provider-secret-store.js');
    const bogus = JSON.stringify({
      v: 99,
      alg: 'aes-256-gcm',
      iv: 'AAAA',
      tag: 'AAAA',
      data: 'AAAA',
    });
    await expect(store.decryptProviderSecret(bogus)).rejects.toThrow(
      /Unsupported provider secret payload format/,
    );
  });

  it('rejects ciphertext tampered with a flipped auth tag', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'clawtalk-secret-pg-tamper-'),
    );
    process.chdir(tempDir);
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'CLAWTALK_PROVIDER_SECRET_KEY=tamper-key\n',
      'utf8',
    );
    vi.resetModules();
    const store = await import('./provider-secret-store.js');
    const ciphertext = await store.encryptProviderSecret({
      apiKey: 'sk-tamper',
    });
    const parsed = JSON.parse(ciphertext) as { tag: string };
    // Flip a byte of the auth tag.
    const tagBytes = Buffer.from(parsed.tag, 'base64');
    tagBytes[0] ^= 0xff;
    const corrupted = JSON.stringify({
      ...parsed,
      tag: tagBytes.toString('base64'),
    });
    await expect(store.decryptProviderSecret(corrupted)).rejects.toThrow();
  });
});
