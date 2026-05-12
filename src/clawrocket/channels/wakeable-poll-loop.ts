import { logger } from '../../logger.js';

export interface WakeablePollLoopOptions {
  label: string;
  pollMs: number;
  onCycle: () => Promise<boolean> | boolean;
}

export class WakeablePollLoop {
  private readonly pollMs: number;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolver: (() => void) | null = null;

  constructor(private readonly options: WakeablePollLoopOptions) {
    this.pollMs = Math.max(100, Math.floor(options.pollMs));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
    this.wake();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      if (this.loopPromise) await this.loopPromise;
      return;
    }
    this.running = false;
    this.wake();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  wake(): void {
    const resolver = this.sleepResolver;
    if (!resolver) return;
    this.clearSleepState();
    resolver();
  }

  isRunning(): boolean {
    return this.running;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const didWork = await this.options.onCycle();
        if (!didWork) {
          await this.waitForNextTick();
        }
      } catch (error) {
        logger.error({ err: error }, `${this.options.label} cycle failed`);
        await this.waitForNextTick();
      }
    }
    this.clearSleepState();
  }

  private waitForNextTick(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      this.sleepResolver = resolve;
      this.sleepTimer = setTimeout(() => {
        this.clearSleepState();
        resolve();
      }, this.pollMs);
    });
  }

  private clearSleepState(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver = null;
  }
}
