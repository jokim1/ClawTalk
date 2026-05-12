import { EventEmitter } from 'events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('../../config.js', () => ({
  CONTAINER_IMAGE: 'test-image',
  TIMEZONE: 'UTC',
}));

vi.mock('../../container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  readonlyMountArgs: (src: string, dest: string) => ['-v', `${src}:${dest}:ro`],
}));

import { runBrowserSourceFetchInContainer } from './browser-source-container.js';

class MockReadable extends EventEmitter {
  setEncoding(_encoding: string): void {
    // no-op for tests
  }
}

class MockWritable {
  readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  end(): void {
    // no-op for tests
  }
}

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: MockReadable;
    stderr: MockReadable;
    stdin: MockWritable;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new MockReadable();
  proc.stderr = new MockReadable();
  proc.stdin = new MockWritable();
  proc.kill = vi.fn();
  return proc;
}

describe('browser-source-container', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('uses the local TypeScript binary and reserves stdout for JSON', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runBrowserSourceFetchInContainer({
      url: 'https://www.gamemakers.com/',
      timeoutMs: 1_000,
    });

    process.nextTick(() => {
      proc.stdout.emit(
        'data',
        JSON.stringify({
          status: 'success',
          finalUrl: 'https://www.gamemakers.com/',
          pageTitle: 'GameMakers',
          extractedText: 'hello world',
          contentType: 'text/html',
        }),
      );
      proc.emit('close', 0);
    });

    await expect(promise).resolves.toEqual({
      finalUrl: 'https://www.gamemakers.com/',
      pageTitle: 'GameMakers',
      extractedText: 'hello world',
      contentType: 'text/html',
      strategy: 'browser',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain('-lc');
    expect(args.at(-1)).toContain('./node_modules/.bin/tsc --outDir /tmp/dist');
    expect(args.at(-1)).toContain('>/dev/stderr 2>&1');
    expect(args.at(-1)).not.toContain('npx tsc');
  });
});
