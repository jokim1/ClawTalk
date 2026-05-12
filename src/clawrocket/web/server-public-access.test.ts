import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('web server public access helpers', () => {
  let loggerWarn: ReturnType<typeof vi.fn>;
  let loggerError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();

    loggerWarn = vi.fn();
    loggerError = vi.fn();

    vi.doMock('../../logger.js', () => ({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: loggerWarn,
        error: loggerError,
        fatal: vi.fn(),
      },
    }));
  });

  afterEach(() => {
    vi.unmock('../../logger.js');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses CF-Connecting-IP in cloudflare mode', async () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');

    const server = await import('./server.js');
    server._resetForwardedHeaderWarningStateForTests();

    expect(
      server._resolveClientIpForTests({
        cfConnectingIp: '203.0.113.10',
        remoteAddress: '127.0.0.1',
      }),
    ).toBe('203.0.113.10');
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('uses the forwarded client IP in caddy mode', async () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'caddy');

    const server = await import('./server.js');
    server._resetForwardedHeaderWarningStateForTests();

    expect(
      server._resolveClientIpForTests({
        xForwardedFor: '198.51.100.7, 203.0.113.9',
        remoteAddress: '127.0.0.1',
      }),
    ).toBe('203.0.113.9');
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('resolves the external https origin from trusted proxy headers in caddy mode', async () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'caddy');

    const server = await import('./server.js');

    expect(
      server._resolveRequestOriginForTests({
        requestUrl: 'http://clawtalk.app/api/v1/channel-connectors/slack',
        xForwardedProto: 'https',
        xForwardedHost: 'clawtalk.app',
      }),
    ).toBe('https://clawtalk.app');
  });

  it('resolves the external https origin from CF-Visitor in cloudflare mode', async () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');

    const server = await import('./server.js');

    expect(
      server._resolveRequestOriginForTests({
        requestUrl: 'http://clawtalk.app/api/v1/channel-connectors/slack',
        cfVisitor: '{"scheme":"https"}',
        host: 'clawtalk.app',
      }),
    ).toBe('https://clawtalk.app');
  });

  it('ignores forwarded headers in none mode', async () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'none');

    const server = await import('./server.js');
    server._resetForwardedHeaderWarningStateForTests();

    expect(
      server._resolveClientIpForTests({
        xForwardedFor: '198.51.100.7',
        cfConnectingIp: '203.0.113.10',
        remoteAddress: '10.0.0.8',
      }),
    ).toBe('10.0.0.8');
  });

  it('falls back to the socket address and warns once when CF-Connecting-IP is missing', async () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');

    const server = await import('./server.js');
    server._resetForwardedHeaderWarningStateForTests();

    expect(
      server._resolveClientIpForTests({
        remoteAddress: '127.0.0.1',
      }),
    ).toBe('127.0.0.1');
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(
      server._resolveClientIpForTests({
        remoteAddress: '127.0.0.1',
      }),
    ).toBe('127.0.0.1');

    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]?.[1]).toContain(
      'CF-Connecting-IP header missing',
    );
  });

  it('warns only once when forwarded headers are seen outside public mode', async () => {
    const server = await import('./server.js');
    server._resetForwardedHeaderWarningStateForTests();

    server._warnAboutUnexpectedForwardedHeadersForTests({
      xForwardedFor: '198.51.100.7',
    });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    server._warnAboutUnexpectedForwardedHeadersForTests({
      cfConnectingIp: '203.0.113.10',
    });

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toContain(
      'Forwarded headers detected but PUBLIC_MODE is not enabled',
    );
  });
});
