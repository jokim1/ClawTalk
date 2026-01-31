/**
 * Tailscale Status Detection Service
 *
 * Uses `tailscale status --json` for reliable detection via the
 * BackendState field rather than parsing human-readable text output.
 */

import { execSync } from 'child_process';

export type TailscaleStatus = 'connected' | 'not-running' | 'not-installed' | 'logged-out';

interface TailscaleJsonStatus {
  BackendState?: string;
}

function checkInstalled(): boolean {
  try {
    execSync('which tailscale', { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function checkRunning(): 'connected' | 'not-running' | 'logged-out' {
  try {
    const raw = execSync('tailscale status --json', { timeout: 3000, stdio: 'pipe' }).toString();
    const json: TailscaleJsonStatus = JSON.parse(raw);

    switch (json.BackendState) {
      case 'Running':
        return 'connected';
      case 'NeedsLogin':
      case 'NeedsMachineAuth':
        return 'logged-out';
      default:
        return 'not-running';
    }
  } catch {
    return 'not-running';
  }
}

export function getStatus(): TailscaleStatus {
  if (!checkInstalled()) {
    return 'not-installed';
  }
  return checkRunning();
}
