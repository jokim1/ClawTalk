// Tiny Slack Web API client.
//
// No SDK — Slack's Bolt + Web API SDK are large and pull in Node-specific
// transports that don't run on Workers. The bits we need (token exchange +
// conversations.list + chat.postMessage later) are small enough to call
// fetch directly.
//
// All Slack Web API responses are shaped `{ ok: boolean, error?: string, ... }`.
// Non-ok responses are surfaced as `SlackApiError` with the slack-side error
// code, which callers can inspect (e.g. `token_revoked` triggers a different
// UX than `ratelimited`).

export class SlackApiError extends Error {
  readonly slackError: string;
  readonly httpStatus: number;

  constructor(slackError: string, message: string, httpStatus: number) {
    super(message);
    this.name = 'SlackApiError';
    this.slackError = slackError;
    this.httpStatus = httpStatus;
  }
}

const SLACK_API_BASE = 'https://slack.com/api';

/**
 * Call a Slack Web API method with a bot token.
 *
 * Slack accepts both GET (query params) and POST (form-encoded body) for most
 * read methods. We use GET for simplicity and to keep params URL-visible in
 * any debug logging.
 */
export async function slackApiGet<T extends { ok: boolean; error?: string }>(
  method: string,
  token: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const url = new URL(`${SLACK_API_BASE}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new SlackApiError(
      'http_error',
      `Slack ${method} returned HTTP ${response.status}`,
      response.status,
    );
  }
  const payload = (await response.json()) as T;
  if (!payload.ok) {
    throw new SlackApiError(
      payload.error || 'slack_error',
      `Slack ${method} rejected: ${payload.error || 'unknown'}`,
      response.status,
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// conversations.list
// ---------------------------------------------------------------------------

export interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface ConversationsListResponse {
  ok: boolean;
  error?: string;
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

const MAX_LIST_PAGES = 5;
const PAGE_LIMIT = 200;

/**
 * List all public + private channels the bot can see, across pages.
 *
 * Caps at MAX_LIST_PAGES (≈ 1000 channels) to bound Worker CPU time. If a
 * workspace has more than that, the UX falls back to "type to filter" plus
 * a "showing first 1000" hint. We can lift the cap later if a real workspace
 * exceeds it.
 */
export async function listSlackConversations(input: {
  token: string;
  types?: string;
  excludeArchived?: boolean;
}): Promise<SlackChannel[]> {
  const types = input.types ?? 'public_channel,private_channel';
  const excludeArchived = input.excludeArchived ?? true;
  const channels: SlackChannel[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const response: ConversationsListResponse =
      await slackApiGet<ConversationsListResponse>(
        'conversations.list',
        input.token,
        {
          types,
          exclude_archived: excludeArchived,
          limit: PAGE_LIMIT,
          cursor,
        },
      );
    if (response.channels) {
      for (const channel of response.channels) {
        channels.push(channel);
      }
    }
    const next: string | undefined = response.response_metadata?.next_cursor;
    if (!next) break;
    cursor = next;
  }
  return channels;
}
