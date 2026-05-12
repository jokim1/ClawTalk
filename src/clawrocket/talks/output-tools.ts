import type { LlmToolDefinition } from '../agents/llm-client.js';
import type { TalkJobExecutionPolicy } from './executor.js';
import {
  createTalkOutput,
  getTalkOutput,
  listTalkOutputs,
  patchTalkOutput,
} from '../db/output-accessors.js';

function parseOutputId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseExpectedVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function buildTalkOutputToolDefinitions(options?: {
  includeWrite?: boolean;
}): LlmToolDefinition[] {
  const tools: LlmToolDefinition[] = [
    {
      name: 'list_outputs',
      description:
        'List saved Talk outputs as lightweight summaries. Use this before reading or updating a specific output.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'read_output',
      description:
        'Read a saved Talk output by outputId, including its current version, title, and markdown body.',
      inputSchema: {
        type: 'object',
        properties: {
          outputId: {
            type: 'string',
            description: 'Saved Talk output ID',
          },
        },
        required: ['outputId'],
      },
    },
  ];

  if (options?.includeWrite !== false) {
    tools.push({
      name: 'write_output',
      description:
        'Create or update a saved Talk output using compare-and-swap versioning over the whole document. To create a new output, omit outputId and use expectedVersion 0 with title and contentMarkdown. To update an existing output, provide outputId, the current expectedVersion, and at least one of title or contentMarkdown. Any title or body change increments the same shared version. On conflict, the tool returns the current stored output as an error so you can retry.',
      inputSchema: {
        type: 'object',
        properties: {
          outputId: {
            type: 'string',
            description:
              'Existing output ID for updates. Omit this to create a new output.',
          },
          title: {
            type: 'string',
            description:
              'Output title. Required for create. Optional for update unless changing the title.',
          },
          contentMarkdown: {
            type: 'string',
            description:
              'Markdown body. Required for create. Optional for update unless changing the body.',
          },
          expectedVersion: {
            type: 'number',
            description:
              'Use 0 when creating a new output. For updates, use the current output version.',
          },
        },
        required: ['expectedVersion'],
      },
    });
  }

  return tools;
}

export async function executeTalkOutputTool(input: {
  talkId: string;
  userId: string;
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  policy?: TalkJobExecutionPolicy | null;
}): Promise<{ result: string; isError?: boolean }> {
  if (input.toolName === 'list_outputs') {
    return {
      result: JSON.stringify({ outputs: listTalkOutputs(input.talkId) }),
    };
  }

  if (input.toolName === 'read_output') {
    const outputId = parseOutputId(input.args.outputId);
    if (!outputId) {
      return { result: 'Error: outputId parameter required', isError: true };
    }
    const output = getTalkOutput(input.talkId, outputId);
    if (!output) {
      return { result: `Output ${outputId} not found`, isError: true };
    }
    return { result: JSON.stringify(output) };
  }

  if (input.toolName === 'write_output') {
    if (input.policy && !input.policy.allowOutputWrite) {
      return {
        result: 'Error: write_output is not available for scheduled job runs.',
        isError: true,
      };
    }
    const outputId = parseOutputId(input.args.outputId);
    const expectedVersion = parseExpectedVersion(input.args.expectedVersion);
    const title =
      typeof input.args.title === 'string' ? input.args.title : undefined;
    const contentMarkdown =
      typeof input.args.contentMarkdown === 'string'
        ? input.args.contentMarkdown
        : undefined;

    if (expectedVersion === null) {
      return {
        result:
          'Error: expectedVersion must be an integer number greater than or equal to 0',
        isError: true,
      };
    }

    try {
      if (!outputId) {
        if (expectedVersion !== 0) {
          return {
            result:
              'Error: create mode requires expectedVersion 0 when outputId is omitted',
            isError: true,
          };
        }
        if (title === undefined || contentMarkdown === undefined) {
          return {
            result:
              'Error: create mode requires both title and contentMarkdown',
            isError: true,
          };
        }
        const created = createTalkOutput({
          talkId: input.talkId,
          title,
          contentMarkdown,
          createdByUserId: input.userId,
          updatedByRunId: input.runId,
        });
        return { result: JSON.stringify(created) };
      }

      if (expectedVersion < 1) {
        return {
          result:
            'Error: update mode requires expectedVersion to be a positive integer',
          isError: true,
        };
      }
      if (title === undefined && contentMarkdown === undefined) {
        return {
          result: 'Error: update mode requires title and/or contentMarkdown',
          isError: true,
        };
      }

      const updated = patchTalkOutput({
        talkId: input.talkId,
        outputId,
        expectedVersion,
        title,
        contentMarkdown,
        updatedByUserId: input.userId,
        updatedByRunId: input.runId,
      });
      if (updated.kind === 'not_found') {
        return { result: `Output ${outputId} not found`, isError: true };
      }
      if (updated.kind === 'conflict') {
        return {
          result: JSON.stringify({
            conflict: true,
            current: updated.current,
          }),
          isError: true,
        };
      }
      return { result: JSON.stringify(updated.output) };
    } catch (error) {
      return {
        result: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  return {
    result: `Tool '${input.toolName}' is not a Talk output tool`,
    isError: true,
  };
}
