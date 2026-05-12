import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let cookieValue = '';

describe('api auth retry behavior', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        return cookieValue;
      },
      set(value: string) {
        cookieValue = value;
      },
    });
    cookieValue = 'cr_csrf_token=test-csrf-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes once and retries the original request after a 401', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talks: [],
          page: { limit: 50, offset: 0, count: 0 },
        },
      }),
    ];
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      paths.push(normalizePath(input));
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();
    const talks = await api.listTalks();

    expect(talks).toEqual([]);
    expect(paths).toEqual([
      '/api/v1/talks',
      '/api/v1/auth/refresh',
      '/api/v1/talks',
    ]);
  });

  it('throws UnauthorizedError when refresh fails', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'invalid_refresh_token', message: 'Invalid token' },
      }),
    ];
    vi.stubGlobal('fetch', async () => {
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();

    await expect(api.listTalks()).rejects.toBeInstanceOf(api.UnauthorizedError);
  });

  it('throws UnauthorizedError when refresh succeeds but retried request is still 401', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
    ];
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      paths.push(normalizePath(input));
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();

    await expect(api.listTalks()).rejects.toBeInstanceOf(api.UnauthorizedError);
    expect(paths).toEqual([
      '/api/v1/talks',
      '/api/v1/auth/refresh',
      '/api/v1/talks',
    ]);
  });

  it('coalesces concurrent refresh attempts into a single refresh call', async () => {
    const callCounts = new Map<string, number>();
    let refreshCalls = 0;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = normalizePath(input);
      const count = callCounts.get(path) || 0;
      callCounts.set(path, count + 1);

      if (path === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        });
      }

      if (path === '/api/v1/talks') {
        if (count === 0) {
          return jsonResponse(401, {
            ok: false,
            error: {
              code: 'unauthorized',
              message: 'Authentication is required',
            },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            talks: [],
            page: { limit: 50, offset: 0, count: 0 },
          },
        });
      }

      if (path === '/api/v1/session/me') {
        if (count === 0) {
          return jsonResponse(401, {
            ok: false,
            error: {
              code: 'unauthorized',
              message: 'Authentication is required',
            },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        });
      }

      throw new Error(`Unexpected fetch path: ${path}`);
    });

    const api = await loadApiModule();
    const [talks, user] = await Promise.all([
      api.listTalks(),
      api.getSessionMe(),
    ]);

    expect(talks).toEqual([]);
    expect(user.email).toBe('owner@example.com');
    expect(refreshCalls).toBe(1);
  });

  it('does not attempt refresh for logout requests', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = normalizePath(input);
      paths.push(path);
      return jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      });
    });

    const api = await loadApiModule();

    await expect(api.logout()).rejects.toBeInstanceOf(api.UnauthorizedError);
    expect(paths).toEqual(['/api/v1/auth/logout']);
  });

  it('rebuilds mutation headers after a 401 refresh retry and reuses the idempotency key', async () => {
    const mutationHeaders: Array<Record<string, string>> = [];

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        if (path === '/api/v1/talks') {
          mutationHeaders.push(readHeaders(init));
          if (mutationHeaders.length === 1) {
            return jsonResponse(401, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Authentication is required',
              },
            });
          }

          return jsonResponse(200, {
            ok: true,
            data: {
              talk: {
                id: 'talk-1',
                ownerId: 'u1',
                title: 'New Talk',
                agents: [],
                status: 'active',
                folderId: null,
                sortOrder: 0,
                version: 1,
                createdAt: '2026-03-08T00:00:00.000Z',
                updatedAt: '2026-03-08T00:00:00.000Z',
                accessRole: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/auth/refresh') {
          cookieValue = 'cr_csrf_token=fresh-csrf-token';
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();
    const talk = await api.createTalk('New Talk');

    expect(talk.id).toBe('talk-1');
    expect(mutationHeaders).toHaveLength(2);
    expect(mutationHeaders[0]['x-csrf-token']).toBe('test-csrf-token');
    expect(mutationHeaders[1]['x-csrf-token']).toBe('fresh-csrf-token');
    expect(mutationHeaders[0]['idempotency-key']).toBeTruthy();
    expect(mutationHeaders[0]['idempotency-key']).toBe(
      mutationHeaders[1]['idempotency-key'],
    );
  });

  it('retries csrf_failed mutations once after refreshing session with fresh headers', async () => {
    const mutationHeaders: Array<Record<string, string>> = [];

    cookieValue = '';
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        if (path === '/api/v1/talks') {
          mutationHeaders.push(readHeaders(init));
          if (mutationHeaders.length === 1) {
            return jsonResponse(403, {
              ok: false,
              error: {
                code: 'csrf_failed',
                message: 'Missing X-CSRF-Token header',
              },
            });
          }
          return jsonResponse(200, {
            ok: true,
            data: {
              talk: {
                id: 'talk-2',
                ownerId: 'u1',
                title: 'Recovered Talk',
                agents: [],
                status: 'active',
                folderId: null,
                sortOrder: 0,
                version: 1,
                createdAt: '2026-03-08T00:00:00.000Z',
                updatedAt: '2026-03-08T00:00:00.000Z',
                accessRole: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/auth/refresh') {
          cookieValue = 'cr_csrf_token=recovered-csrf-token';
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();
    const talk = await api.createTalk('Recovered Talk');

    expect(talk.id).toBe('talk-2');
    expect(mutationHeaders).toHaveLength(2);
    expect(mutationHeaders[0]['x-csrf-token']).toBeUndefined();
    expect(mutationHeaders[1]['x-csrf-token']).toBe('recovered-csrf-token');
    expect(mutationHeaders[0]['idempotency-key']).toBe(
      mutationHeaders[1]['idempotency-key'],
    );
  });

  it('retries multipart attachment uploads after csrf_failed and preserves the file payload', async () => {
    const mutationHeaders: Array<Record<string, string>> = [];
    const uploadedFiles: string[] = [];

    cookieValue = '';
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        if (path === '/api/v1/talks/talk-1/attachments') {
          mutationHeaders.push(readHeaders(init));

          if (!(init?.body instanceof FormData)) {
            throw new Error('Expected multipart FormData upload body');
          }

          const file = init.body.get('file');
          if (!(file instanceof File)) {
            throw new Error('Expected file entry in upload FormData');
          }
          uploadedFiles.push(`${file.name}:${file.type}:${file.size}`);

          if (mutationHeaders.length === 1) {
            return jsonResponse(403, {
              ok: false,
              error: {
                code: 'csrf_failed',
                message: 'Missing X-CSRF-Token header',
              },
            });
          }

          return jsonResponse(201, {
            ok: true,
            data: {
              attachment: {
                id: 'att-1',
                fileName: file.name,
                fileSize: file.size,
                mimeType: file.type,
                extractionStatus: 'ready',
              },
            },
          });
        }

        if (path === '/api/v1/auth/refresh') {
          cookieValue = 'cr_csrf_token=upload-refresh-token';
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();
    const attachment = await api.uploadTalkAttachment(
      'talk-1',
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    );

    expect(attachment.attachment.id).toBe('att-1');
    expect(mutationHeaders).toHaveLength(2);
    expect(mutationHeaders[0]['x-csrf-token']).toBeUndefined();
    expect(mutationHeaders[1]['x-csrf-token']).toBe('upload-refresh-token');
    expect(uploadedFiles).toEqual([
      'notes.txt:text/plain:5',
      'notes.txt:text/plain:5',
    ]);
  });

  it('coalesces concurrent mutation refreshes and rebuilds fresh headers for both retries', async () => {
    const counts = new Map<string, number>();
    const createTalkHeaders: Array<Record<string, string>> = [];
    const metadataHeaders: Array<Record<string, string>> = [];
    let refreshCalls = 0;

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        const count = counts.get(path) || 0;
        counts.set(path, count + 1);

        if (path === '/api/v1/auth/refresh') {
          refreshCalls += 1;
          cookieValue = 'cr_csrf_token=shared-fresh-token';
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/talks') {
          createTalkHeaders.push(readHeaders(init));
          if (createTalkHeaders.length === 1) {
            return jsonResponse(401, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Authentication is required',
              },
            });
          }
          return jsonResponse(200, {
            ok: true,
            data: {
              talk: {
                id: 'talk-3',
                ownerId: 'u1',
                title: 'Concurrent Create',
                agents: [],
                status: 'active',
                folderId: null,
                sortOrder: 0,
                version: 1,
                createdAt: '2026-03-08T00:00:00.000Z',
                updatedAt: '2026-03-08T00:00:00.000Z',
                accessRole: 'owner',
              },
            },
          });
        }

        if (path === '/api/v1/talks/talk-99') {
          metadataHeaders.push(readHeaders(init));
          if (metadataHeaders.length === 1) {
            return jsonResponse(401, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Authentication is required',
              },
            });
          }
          return jsonResponse(200, {
            ok: true,
            data: {
              talk: {
                id: 'talk-99',
                ownerId: 'u1',
                title: 'Updated Talk',
                agents: [],
                status: 'active',
                folderId: null,
                sortOrder: 0,
                version: 2,
                createdAt: '2026-03-08T00:00:00.000Z',
                updatedAt: '2026-03-08T00:01:00.000Z',
                accessRole: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();
    const [createdTalk, patchedTalk] = await Promise.all([
      api.createTalk('Concurrent Create'),
      api.patchTalkMetadata({ talkId: 'talk-99', title: 'Updated Talk' }),
    ]);

    expect(createdTalk.id).toBe('talk-3');
    expect(patchedTalk.id).toBe('talk-99');
    expect(refreshCalls).toBe(1);
    expect(createTalkHeaders).toHaveLength(2);
    expect(metadataHeaders).toHaveLength(2);
    expect(createTalkHeaders[1]['x-csrf-token']).toBe('shared-fresh-token');
    expect(metadataHeaders[1]['x-csrf-token']).toBe('shared-fresh-token');
    expect(createTalkHeaders[0]['idempotency-key']).toBe(
      createTalkHeaders[1]['idempotency-key'],
    );
    expect(metadataHeaders[0]['idempotency-key']).toBe(
      metadataHeaders[1]['idempotency-key'],
    );
  });

  it('does not retry non-csrf 403 responses for mutations', async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        paths.push(normalizePath(input));
        if (normalizePath(input) === '/api/v1/talks') {
          expect(readHeaders(init)['x-csrf-token']).toBe('test-csrf-token');
        }
        return jsonResponse(403, {
          ok: false,
          error: {
            code: 'forbidden',
            message: 'Forbidden',
          },
        });
      },
    );

    const api = await loadApiModule();

    await expect(api.createTalk('Forbidden')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(paths).toEqual(['/api/v1/talks']);
  });

  it('stops retrying after one auth refresh and one csrf refresh', async () => {
    const mutationHeaders: Array<Record<string, string>> = [];
    let refreshCalls = 0;

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = normalizePath(input);
        if (path === '/api/v1/talks') {
          mutationHeaders.push(readHeaders(init));
          if (mutationHeaders.length === 1) {
            return jsonResponse(401, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Authentication is required',
              },
            });
          }
          return jsonResponse(403, {
            ok: false,
            error: {
              code: 'csrf_failed',
              message: 'CSRF token mismatch',
            },
          });
        }

        if (path === '/api/v1/auth/refresh') {
          refreshCalls += 1;
          cookieValue = `cr_csrf_token=retry-token-${refreshCalls}`;
          return jsonResponse(200, {
            ok: true,
            data: {
              user: {
                id: 'u1',
                email: 'owner@example.com',
                displayName: 'Owner',
                role: 'owner',
              },
            },
          });
        }

        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );

    const api = await loadApiModule();

    await expect(api.createTalk('Still Failing')).rejects.toMatchObject({
      status: 403,
      code: 'csrf_failed',
    });
    expect(refreshCalls).toBe(2);
    expect(mutationHeaders).toHaveLength(3);
    expect(mutationHeaders[0]['x-csrf-token']).toBe('test-csrf-token');
    expect(mutationHeaders[1]['x-csrf-token']).toBe('retry-token-1');
    expect(mutationHeaders[2]['x-csrf-token']).toBe('retry-token-2');
    expect(mutationHeaders[0]['idempotency-key']).toBe(
      mutationHeaders[1]['idempotency-key'],
    );
    expect(mutationHeaders[1]['idempotency-key']).toBe(
      mutationHeaders[2]['idempotency-key'],
    );
  });
});

async function loadApiModule() {
  vi.resetModules();
  return import('./api');
}

function normalizePath(input: RequestInfo | URL): string {
  const raw = String(input);
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return new URL(raw).pathname;
  }
  return raw.split('?')[0];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function readHeaders(init?: RequestInit): Record<string, string> {
  const headers = new Headers(init?.headers);
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
