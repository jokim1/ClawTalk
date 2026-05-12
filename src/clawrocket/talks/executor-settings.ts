/**
 * executor-settings.ts
 *
 * Provides runtime checks for whether Talk/agent execution is currently
 * allowed — e.g., are API credentials configured for the active executor mode.
 */

export interface ExecutorSettingsService {
  /**
   * Returns a human-readable reason string if execution is currently blocked,
   * or null if execution is allowed.
   */
  getExecutionBlockedReason(): string | null;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

/**
 * The default service always allows execution.
 * In production, this would check provider credentials, billing status, etc.
 */
const defaultService: ExecutorSettingsService = {
  getExecutionBlockedReason: () => null,
};

let activeService: ExecutorSettingsService = defaultService;

export function getActiveExecutorSettingsService(): ExecutorSettingsService {
  return activeService;
}

export function setActiveExecutorSettingsService(
  service: ExecutorSettingsService,
): void {
  activeService = service;
}
