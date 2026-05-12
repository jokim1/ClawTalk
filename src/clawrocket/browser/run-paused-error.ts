import type { BrowserBlockMetadata } from './metadata.js';

export class BrowserRunPausedError extends Error {
  readonly code = 'browser_blocked';

  constructor(
    public readonly runId: string,
    public readonly browserBlock: BrowserBlockMetadata,
  ) {
    super(browserBlock.message);
    this.name = 'BrowserRunPausedError';
  }
}
