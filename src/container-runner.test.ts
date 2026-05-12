import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import { spawn } from 'child_process';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_SYNC_AGENT_RUNNER_SOURCE: true,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      lstatSync: vi.fn(() => {
        throw new Error('ENOENT');
      }),
      readlinkSync: vi.fn(() => ''),
      rmSync: vi.fn(),
      symlinkSync: vi.fn(),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  PersistentContainerAgentWorker,
} from './container-runner.js';
import {
  createLegacyGroupExecutionTarget,
  createWebRuntimeExecutionTarget,
} from './container-execution-target.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

const testLegacyTarget = createLegacyGroupExecutionTarget(
  testGroup,
  'test@g.us',
);

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.cpSync).mockReset();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testLegacyTarget,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testLegacyTarget,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testLegacyTarget,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('non-zero exit after final output still resolves as success', async () => {
    const resultPromise = runContainerAgent(
      testLegacyTarget,
      testInput,
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Finished before teardown',
      newSessionId: 'session-789',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'success',
      result: 'Finished before teardown',
      newSessionId: 'session-789',
    });
  });

  it('non-zero exit after streamed output still resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testLegacyTarget,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Streamed before teardown',
      newSessionId: 'session-999',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'success',
      result: 'Streamed before teardown',
      newSessionId: 'session-999',
    });
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Streamed before teardown' }),
    );
  });

  it('refreshes the web-talk agent runner source even when a cached copy exists', async () => {
    const projectRoot = process.cwd();
    const agentRunnerSrc = `${projectRoot}/container/agent-runner/src`;
    const groupRunnerDst =
      '/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src';

    vi.mocked(fs.existsSync).mockImplementation((targetPath) => {
      const normalized =
        typeof targetPath === 'string' ? targetPath : String(targetPath);
      if (
        normalized === agentRunnerSrc ||
        normalized === groupRunnerDst ||
        normalized === '/tmp/nanoclaw-test-groups/test-group'
      ) {
        return true;
      }
      return false;
    });

    const resultPromise = runContainerAgent(
      testLegacyTarget,
      {
        ...testInput,
        toolProfile: 'web_talk',
      },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Synced runner',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'success',
    });
    expect(fs.cpSync).toHaveBeenCalledWith(agentRunnerSrc, groupRunnerDst, {
      recursive: true,
      force: true,
    });
  });

  it('uses stateless talk_main mounts with the web runtime target and dedicated logs', async () => {
    vi.mocked(fs.existsSync).mockImplementation((targetPath) => {
      const normalized =
        typeof targetPath === 'string' ? targetPath : String(targetPath);
      return (
        normalized === '/tmp/talk-main-run' ||
        normalized === '/tmp/project-alpha' ||
        normalized.endsWith('/container/agent-runner/src')
      );
    });

    const resultPromise = runContainerAgent(
      createWebRuntimeExecutionTarget(),
      {
        prompt: 'Hello',
        groupFolder: 'web-executor',
        chatJid: 'internal:web-executor',
        isMain: true,
        toolProfile: 'talk_main',
        ephemeralContextDir: '/tmp/talk-main-run',
        projectMountHostPath: '/tmp/project-alpha',
      },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Stateless ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'success',
      result: 'Stateless ok',
    });

    const spawnArgs =
      vi.mocked(spawn).mock.calls[
        vi.mocked(spawn).mock.calls.length - 1
      ]?.[1] ?? [];
    const joinedArgs = Array.isArray(spawnArgs) ? spawnArgs.join(' ') : '';
    expect(joinedArgs).toContain('/tmp/talk-main-run:/workspace/run');
    expect(joinedArgs).toContain('/tmp/project-alpha:/workspace/project');
    expect(joinedArgs).toContain(
      '/tmp/talk-main-run/claude-home:/home/node/.claude',
    );
    expect(joinedArgs).toContain(
      '/tmp/talk-main-run/agent-runner-src:/app/src',
    );
    expect(joinedArgs).not.toContain('/workspace/group');
    expect(joinedArgs).not.toContain('/workspace/ipc');
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test-data/container-runs/web-executor/logs',
      { recursive: true },
    );
  });

  it('persistent worker streams NDJSON task lifecycle events', async () => {
    vi.useRealTimers();
    vi.mocked(fs.existsSync).mockImplementation((targetPath) => {
      const normalized =
        typeof targetPath === 'string' ? targetPath : String(targetPath);
      return (
        normalized === '/tmp/talk-main-run' ||
        normalized.endsWith('/container/agent-runner/src')
      );
    });

    const worker = new PersistentContainerAgentWorker(
      createWebRuntimeExecutionTarget(),
      {
        prompt: 'Bootstrap worker',
        model: 'claude-sonnet-4-6',
        toolProfile: 'talk_main',
        timeoutProfile: 'fast_lane',
        groupFolder: 'web-executor',
        chatJid: 'internal:web-executor',
        isMain: true,
        ephemeralContextDir: '/tmp/talk-main-run',
      },
    );

    let stdinBuffer = '';
    fakeProc.stdin.on('data', (chunk) => {
      stdinBuffer += chunk.toString();
    });

    const taskEvents: Array<{ type: string; requestId: string }> = [];
    const taskOutputs: ContainerOutput[] = [];
    const taskPromise = worker.runTask(
      {
        prompt: 'Open LinkedIn',
        model: 'claude-sonnet-4-6',
        toolProfile: 'talk_main',
        timeoutProfile: 'fast_lane',
        groupFolder: 'web-executor',
        chatJid: 'internal:web-executor',
        isMain: true,
        ephemeralContextDir: '/tmp/talk-main-run',
        browserBridgeHostSocketPath: '/tmp/browser.sock',
      },
      {
        onEvent: (event) => {
          taskEvents.push({
            type: event.type,
            requestId: event.requestId,
          });
        },
        onOutput: async (output) => {
          taskOutputs.push(output);
        },
      },
    );

    fakeProc.stdout.push('{"type":"worker_ready"}\n');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const envelopeLine = stdinBuffer.trim().split('\n').filter(Boolean)[0];
    expect(envelopeLine).toBeTruthy();
    const envelope = JSON.parse(envelopeLine) as {
      requestId: string;
      input: { browserBridgeSocketPath?: string };
    };
    expect(envelope.input.browserBridgeSocketPath).toBe(
      '/workspace/browser-bridge/browser.sock',
    );

    fakeProc.stdout.push(
      `${JSON.stringify({
        type: 'task_started',
        requestId: envelope.requestId,
      })}\n`,
    );
    fakeProc.stdout.push(
      `${JSON.stringify({
        type: 'task_output',
        requestId: envelope.requestId,
        output: {
          status: 'success',
          result: 'Partial progress',
        },
      })}\n`,
    );
    fakeProc.stdout.push(
      `${JSON.stringify({
        type: 'task_completed',
        requestId: envelope.requestId,
        output: {
          status: 'success',
          result: 'Final response',
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(taskPromise).resolves.toEqual({
      status: 'success',
      result: 'Final response',
    });
    expect(taskEvents).toEqual([
      {
        type: 'task_started',
        requestId: envelope.requestId,
      },
      {
        type: 'task_output',
        requestId: envelope.requestId,
      },
      {
        type: 'task_completed',
        requestId: envelope.requestId,
      },
    ]);
    expect(taskOutputs).toEqual([
      {
        status: 'success',
        result: 'Partial progress',
      },
    ]);

    await worker.dispose();
  });
});
