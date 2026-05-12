export async function slackApiRequest<
  T extends Record<string, unknown>,
>(input: {
  botToken?: string;
  url: string;
  method?: 'GET' | 'POST';
  body?: URLSearchParams;
}): Promise<T> {
  const headers = new Headers();
  if (input.botToken) {
    headers.set('Authorization', `Bearer ${input.botToken}`);
  }
  if (input.body) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
  }
  const response = await fetch(input.url, {
    method: input.method || (input.body ? 'POST' : 'GET'),
    headers,
    body: input.body?.toString(),
  });
  if (!response.ok) {
    throw new Error(`Slack request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
