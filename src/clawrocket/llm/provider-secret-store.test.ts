import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('provider secret store', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads CLAWROCKET_PROVIDER_SECRET_KEY from .env when process.env is unset', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'clawrocket-provider-secret-'),
    );
    process.chdir(tempDir);
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'CLAWROCKET_PROVIDER_SECRET_KEY=env-secret-one\n',
      'utf8',
    );

    const storeA = await import('./provider-secret-store.js');
    const ciphertext = storeA.encryptProviderSecret({
      apiKey: 'sk-test-123',
    });

    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'CLAWROCKET_PROVIDER_SECRET_KEY=env-secret-two\n',
      'utf8',
    );
    vi.resetModules();

    const storeB = await import('./provider-secret-store.js');

    expect(() => storeB.decryptProviderSecret(ciphertext)).toThrow();
  });
});
