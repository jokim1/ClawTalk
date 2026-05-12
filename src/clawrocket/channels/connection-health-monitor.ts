import { logger } from '../../logger.js';
import { updateConnectionProbeResult } from '../db/index.js';
import { WakeablePollLoop } from './wakeable-poll-loop.js';

export interface ConnectionHealthMonitorOptions {
  connectionId: string;
  probe: () => Promise<void>;
  pollMs?: number;
}

export class ConnectionHealthMonitor {
  private readonly loop: WakeablePollLoop;
  private readonly connectionId: string;
  private readonly probe: () => Promise<void>;

  constructor(options: ConnectionHealthMonitorOptions) {
    this.connectionId = options.connectionId;
    this.probe = options.probe;
    const pollMs = Math.max(5_000, Math.floor(options.pollMs ?? 60_000));
    this.loop = new WakeablePollLoop({
      label: 'Connection health monitor',
      pollMs,
      onCycle: async () => {
        await this.runProbe();
        return false; // always sleep between probes
      },
    });
  }

  async start(): Promise<void> {
    await this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  private async runProbe(): Promise<void> {
    try {
      await this.probe();
      updateConnectionProbeResult(this.connectionId, true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Probe failed';
      logger.warn(
        { connectionId: this.connectionId, err: detail },
        'Connection probe failed',
      );
      updateConnectionProbeResult(this.connectionId, false, detail);
    }
  }
}
