import path from 'path';
import { fileURLToPath } from 'url';

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolResult = {
  result: string;
  isError?: boolean;
};

type RuntimeTools = {
  webToolsEnabled: boolean;
  browserToolsEnabled: boolean;
  webToolDefinitions: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  browserToolDefinitions: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  executeWebFetch: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
  executeWebSearch: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
  executeBrowserTool: (input: {
    toolName: string;
    args: Record<string, unknown>;
    context: {
      signal: AbortSignal;
      talkId?: string;
      userId: string;
      runId: string;
    };
  }) => Promise<ToolResult>;
};

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'clawrocket-runtime';
const SERVER_VERSION = '1.0.0';
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

process.chdir(REPO_ROOT);

function sendMessage(payload: unknown): void {
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, 'utf8');
  process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
}

function sendResult(id: JsonRpcId, result: unknown): void {
  sendMessage({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function sendError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): void {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function parseContentLength(headerBlock: string): number | null {
  const lines = headerBlock.split('\r\n');
  for (const line of lines) {
    const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

function parseBooleanEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

async function loadRuntimeTools(): Promise<RuntimeTools> {
  const [webToolsModule, browserToolsModule] = await Promise.all([
    import('../tools/web-tools.js'),
    import('../tools/browser-tools.js'),
  ]);

  return {
    webToolsEnabled: parseBooleanEnv(process.env.CLAWROCKET_CODEX_ALLOW_WEB),
    browserToolsEnabled: parseBooleanEnv(
      process.env.CLAWROCKET_CODEX_ALLOW_BROWSER,
    ),
    webToolDefinitions: webToolsModule.WEB_TOOL_DEFINITIONS,
    browserToolDefinitions: browserToolsModule.BROWSER_TOOL_DEFINITIONS,
    executeWebFetch: webToolsModule.executeWebFetch,
    executeWebSearch: webToolsModule.executeWebSearch,
    executeBrowserTool: browserToolsModule.executeBrowserTool,
  };
}

const runtimeToolsPromise = loadRuntimeTools();
const inflightControllers = new Set<AbortController>();

function abortInflightToolCalls(): void {
  for (const controller of inflightControllers) {
    controller.abort('codex_mcp_server_stopped');
  }
  inflightControllers.clear();
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  const id = message.id ?? null;
  const method = typeof message.method === 'string' ? message.method : null;
  const params =
    message.params && typeof message.params === 'object' ? message.params : {};

  if (!method) {
    sendError(id, -32600, 'Missing JSON-RPC method.');
    return;
  }

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
      return;
    case 'notifications/initialized':
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list': {
      const runtime = await runtimeToolsPromise;
      const tools = [
        ...(runtime.webToolsEnabled ? runtime.webToolDefinitions : []),
        ...(runtime.browserToolsEnabled ? runtime.browserToolDefinitions : []),
      ].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      sendResult(id, { tools });
      return;
    }
    case 'tools/call': {
      const runtime = await runtimeToolsPromise;
      const toolName =
        typeof params.name === 'string' ? params.name.trim() : '';
      const toolArgs =
        params.arguments &&
        typeof params.arguments === 'object' &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const controller = new AbortController();
      const signal = controller.signal;
      inflightControllers.add(controller);

      try {
        let result: ToolResult;
        if (toolName === 'web_fetch' && runtime.webToolsEnabled) {
          result = await runtime.executeWebFetch(toolArgs, signal);
        } else if (toolName === 'web_search' && runtime.webToolsEnabled) {
          result = await runtime.executeWebSearch(toolArgs, signal);
        } else if (
          runtime.browserToolsEnabled &&
          toolName.startsWith('browser_')
        ) {
          result = await runtime.executeBrowserTool({
            toolName,
            args: toolArgs,
            context: {
              signal,
              talkId: process.env.CLAWROCKET_CODEX_TALK_ID || undefined,
              userId: process.env.CLAWROCKET_CODEX_USER_ID || '',
              runId: process.env.CLAWROCKET_CODEX_RUN_ID || '',
            },
          });
        } else {
          sendError(id, -32601, `Tool '${toolName}' is not available.`);
          return;
        }

        sendResult(id, {
          content: [
            {
              type: 'text',
              text: result.result,
            },
          ],
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (error) {
        sendResult(id, {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        });
      } finally {
        inflightControllers.delete(controller);
      }
      return;
    }
    default:
      sendError(id, -32601, `Method '${method}' is not supported.`);
  }
}

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const separatorIndex = buffer.indexOf('\r\n\r\n');
    if (separatorIndex === -1) {
      return;
    }

    const headerBlock = buffer.slice(0, separatorIndex).toString('utf8');
    const contentLength = parseContentLength(headerBlock);
    if (contentLength == null) {
      sendError(null, -32700, 'Missing Content-Length header.');
      process.exitCode = 1;
      return;
    }

    const messageStart = separatorIndex + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }

    const rawMessage = buffer.slice(messageStart, messageEnd).toString('utf8');
    buffer = buffer.slice(messageEnd);

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(rawMessage) as JsonRpcRequest;
    } catch {
      sendError(null, -32700, 'Invalid JSON payload.');
      continue;
    }

    void handleRequest(parsed).catch((error) => {
      const id = parsed.id ?? null;
      sendError(
        id,
        -32603,
        error instanceof Error ? error.message : String(error),
      );
    });
  }
});

process.stdin.on('end', () => {
  abortInflightToolCalls();
});

process.stdin.on('close', () => {
  abortInflightToolCalls();
});

process.stdin.resume();
