import type { Channel, ChannelDeliveryPayload } from '../../types.js';
import { ConnectionHealthMonitor } from './connection-health-monitor.js';

type ManagedRuntime = {
  channel: Channel;
  healthMonitor: ConnectionHealthMonitor | null;
};

export interface ConnectRuntimeInput {
  connectionId: string;
  channel: Channel;
  pollMs?: number;
}

export class ChannelRuntimeManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();

  async connectRuntime(input: ConnectRuntimeInput): Promise<void> {
    await this.disconnectRuntime(input.connectionId);
    await input.channel.connect();
    const healthMonitor = input.channel.probe
      ? new ConnectionHealthMonitor({
          connectionId: input.connectionId,
          probe: () => input.channel.probe!(),
          pollMs: input.pollMs,
        })
      : null;
    if (healthMonitor) {
      await healthMonitor.start();
    }
    this.runtimes.set(input.connectionId, {
      channel: input.channel,
      healthMonitor,
    });
  }

  getChannel(connectionId: string): Channel | null {
    return this.runtimes.get(connectionId)?.channel || null;
  }

  hasConnection(connectionId: string): boolean {
    return this.runtimes.has(connectionId);
  }

  getConnectionCount(): number {
    return this.runtimes.size;
  }

  async routePlatformEvent(
    connectionId: string,
    event: unknown,
  ): Promise<void> {
    const channel = this.getChannel(connectionId);
    if (!channel) {
      throw new Error(`No runtime for channel connection ${connectionId}`);
    }
    if (!channel.handlePlatformEvent) {
      throw new Error(
        `Channel ${channel.name} does not support inbound platform event routing`,
      );
    }
    await channel.handlePlatformEvent(event);
  }

  async sendDelivery(payload: ChannelDeliveryPayload): Promise<void> {
    const channel = this.getChannel(payload.connectionId);
    if (!channel) {
      throw new Error(
        `No runtime for channel connection ${payload.connectionId}`,
      );
    }
    if (channel.sendDelivery) {
      await channel.sendDelivery(payload);
      return;
    }
    await channel.sendMessage(payload.targetId, payload.content);
  }

  async disconnectRuntime(connectionId: string): Promise<void> {
    const runtime = this.runtimes.get(connectionId);
    if (!runtime) return;
    this.runtimes.delete(connectionId);
    await runtime.healthMonitor?.stop();
    await runtime.channel.disconnect();
  }

  async stop(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    for (const connectionId of ids) {
      await this.disconnectRuntime(connectionId);
    }
  }
}
