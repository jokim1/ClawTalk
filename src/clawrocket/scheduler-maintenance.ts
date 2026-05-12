import { logger } from '../logger.js';
import { registerSchedulerMaintenanceHook } from '../task-scheduler.js';

import {
  pruneEventOutbox,
  pruneIdempotencyCache,
  pruneOrphanAttachments,
  scanDeadLetterQueue,
} from './db/index.js';
import { deleteAttachmentFile } from './talks/attachment-storage.js';

let registered = false;

export function registerClawrocketSchedulerMaintenanceHook(): void {
  if (registered) return;
  registered = true;

  registerSchedulerMaintenanceHook(() => {
    const prunedOutbox = pruneEventOutbox();
    const prunedIdempotency = pruneIdempotencyCache();
    const deadLetters = scanDeadLetterQueue(10);

    // Delete uploaded attachments that were never linked to a message after 1 hour.
    // pruneOrphanAttachments removes DB rows and returns storage keys so we can
    // also clean up the corresponding files on disk.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const orphanResult = pruneOrphanAttachments(oneHourAgo);
    for (const key of orphanResult.storageKeys) {
      deleteAttachmentFile(key).catch((err) => {
        logger.warn(
          { storageKey: key, error: err },
          'Failed to delete orphan attachment file',
        );
      });
    }

    if (
      prunedOutbox > 0 ||
      prunedIdempotency > 0 ||
      deadLetters.length > 0 ||
      orphanResult.count > 0
    ) {
      logger.info(
        {
          prunedOutbox,
          prunedIdempotency,
          deadLetters: deadLetters.length,
          prunedOrphanAttachments: orphanResult.count,
        },
        'Scheduler maintenance pass complete',
      );
    }
  });
}

/** @internal - for tests only. */
export function _resetClawrocketSchedulerMaintenanceHookForTests(): void {
  registered = false;
}
