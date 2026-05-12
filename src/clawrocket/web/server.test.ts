import { EventEmitter } from 'events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from '../db/index.js';

const mockCreateAdaptorServer = vi.hoisted(() => vi.fn());

vi.mock('@hono/node-server', () => ({
  createAdaptorServer: mockCreateAdaptorServer,
  getConnInfo: () => ({}),
}));

import { createWebServer } from './server.js';

type FakeServer = EventEmitter & {
  address: () => { port: number };
  close: (cb?: (err?: Error | null) => void) => void;
  listen: (port: number, host: string) => void;
};

function createFakeServer(behavior: {
  port?: number;
  listen: (server: FakeServer, port: number, host: string) => void;
}): FakeServer {
  const emitter = new EventEmitter() as FakeServer;
  emitter.address = () => ({ port: behavior.port ?? 3210 });
  emitter.close = (cb) => {
    cb?.(null);
  };
  emitter.listen = (port, host) => {
    behavior.listen(emitter, port, host);
  };
  return emitter;
}

describe('createWebServer.start', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockCreateAdaptorServer.mockReset();
  });

  it('waits for listening before resolving', async () => {
    let listening = false;
    const fakeServer = createFakeServer({
      port: 4321,
      listen: (server) => {
        queueMicrotask(() => {
          listening = true;
          server.emit('listening');
        });
      },
    });
    mockCreateAdaptorServer.mockReturnValue(fakeServer);

    const webServer = createWebServer({
      host: '127.0.0.1',
      port: 4321,
    });

    const started = webServer.start();
    expect(listening).toBe(false);

    await expect(started).resolves.toEqual({
      host: '127.0.0.1',
      port: 4321,
    });
    expect(listening).toBe(true);
    expect(webServer.server).toBe(fakeServer);
  });

  it('rejects when listen emits a bind error and leaves no active server handle', async () => {
    const fakeServer = createFakeServer({
      listen: (server) => {
        queueMicrotask(() => {
          const error = new Error('address in use') as NodeJS.ErrnoException;
          error.code = 'EADDRINUSE';
          server.emit('error', error);
        });
      },
    });
    mockCreateAdaptorServer.mockReturnValue(fakeServer);

    const webServer = createWebServer({
      host: '127.0.0.1',
      port: 3210,
    });

    await expect(webServer.start()).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(webServer.server).toBeNull();
  });
});
