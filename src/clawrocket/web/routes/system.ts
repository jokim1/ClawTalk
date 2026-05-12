import { getRegisteredChannelNames } from '../../../channels/registry.js';
import {
  getContainerRuntimeStatus,
  type ContainerRuntimeStatus,
} from '../../../container-runtime.js';
import { isDatabaseHealthy } from '../../db/index.js';
import { KeychainBridge } from '../../secrets/keychain.js';
import { ApiEnvelope } from '../types.js';

export interface DeepStatus {
  process: 'ok';
  db: 'ok' | 'error';
  keychain: 'ok' | 'error';
  containerRuntime: ContainerRuntimeStatus;
  providers: 'not_checked';
  channels: {
    registered: string[];
  };
}

export async function healthResponse(
  dbHealthyCheck: () => boolean = isDatabaseHealthy,
): Promise<ApiEnvelope<{ status: 'ok' }>> {
  const dbHealthy = dbHealthyCheck();
  if (!dbHealthy) {
    return {
      ok: false,
      error: {
        code: 'db_unavailable',
        message: 'Database is not readable',
      },
    };
  }

  return {
    ok: true,
    data: { status: 'ok' },
  };
}

export async function statusResponse(
  keychain: KeychainBridge,
): Promise<ApiEnvelope<DeepStatus>> {
  const dbHealthy = isDatabaseHealthy();
  const keychainHealthy = await keychain.healthCheck();

  return {
    ok: true,
    data: {
      process: 'ok',
      db: dbHealthy ? 'ok' : 'error',
      keychain: keychainHealthy ? 'ok' : 'error',
      containerRuntime: getContainerRuntimeStatus(),
      providers: 'not_checked',
      channels: {
        registered: getRegisteredChannelNames(),
      },
    },
  };
}
