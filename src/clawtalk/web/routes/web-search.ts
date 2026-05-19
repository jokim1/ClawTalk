/**
 * web-search.ts
 *
 * REST routes for managing the per-user web-search provider catalog:
 * list providers + credentials, set/clear personal API keys, and pick
 * which provider is the active backend for the agent's `web_search`
 * tool.
 *
 * All credentials live in `web_search_provider_secrets` (per-user,
 * RLS-scoped to auth.uid()). The active picker is a single text
 * column on `users.preferred_web_search_provider_id`.
 *
 * Workspace-shared keys are intentionally NOT supported in v1 — the
 * AskUserQuestion picker chose "Per-user only" for the initial cut.
 */

import { getDbPg, withUserContext } from '../../../db.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../../llm/provider-secret-store.js';
import {
  isKnownWebSearchProviderId,
  WEB_SEARCH_PROVIDER_IDS,
} from '../../web-search/registry.js';
import type { WebSearchProviderId } from '../../web-search/types.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

function envelopeOk<T>(data: T): {
  statusCode: number;
  body: ApiEnvelope<T>;
} {
  return { statusCode: 200, body: { ok: true, data } };
}

function envelopeError(
  statusCode: number,
  code: string,
  message: string,
): { statusCode: number; body: ApiEnvelope<never> } {
  return {
    statusCode,
    body: { ok: false, error: { code, message } },
  };
}

interface WebSearchProviderRow {
  id: WebSearchProviderId;
  name: string;
  base_url: string;
  enabled: boolean;
}

interface WebSearchProviderCardApi {
  id: WebSearchProviderId;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasCredential: boolean;
  credentialHint: string | null;
  isActive: boolean;
}

interface WebSearchPageDataApi {
  providers: WebSearchProviderCardApi[];
  activeProviderId: WebSearchProviderId | null;
}

function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export async function listWebSearchProvidersRoute(auth: AuthContext): Promise<{
  statusCode: number;
  body: ApiEnvelope<WebSearchPageDataApi>;
}> {
  return withUserContext(auth.userId, async () => {
    const db = getDbPg();
    const providerRows = await db<WebSearchProviderRow[]>`
      select id, name, base_url, enabled
      from public.web_search_providers
      where enabled = true
      order by name asc
    `;
    const secretRows = await db<
      Array<{ provider_id: WebSearchProviderId; ciphertext: string }>
    >`
      select provider_id, ciphertext
      from public.web_search_provider_secrets
    `;
    const userRows = await db<
      Array<{ preferred_web_search_provider_id: string | null }>
    >`
      select preferred_web_search_provider_id
      from public.users
      where id = ${auth.userId}::uuid
      limit 1
    `;
    const activeRaw = userRows[0]?.preferred_web_search_provider_id ?? null;
    const activeProviderId =
      activeRaw && isKnownWebSearchProviderId(activeRaw) ? activeRaw : null;

    const secretByProvider = new Map<WebSearchProviderId, string>();
    for (const row of secretRows) {
      secretByProvider.set(row.provider_id, row.ciphertext);
    }

    const cards: WebSearchProviderCardApi[] = [];
    for (const provider of providerRows) {
      const ciphertext = secretByProvider.get(provider.id) ?? null;
      let credentialHint: string | null = null;
      if (ciphertext) {
        try {
          credentialHint = maskApiKey(
            (await decryptProviderSecret(ciphertext)).apiKey,
          );
        } catch {
          credentialHint = '***';
        }
      }
      cards.push({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.base_url,
        enabled: provider.enabled,
        hasCredential: !!ciphertext,
        credentialHint,
        isActive: activeProviderId === provider.id,
      });
    }

    return envelopeOk({ providers: cards, activeProviderId });
  });
}

export async function putWebSearchCredentialRoute(
  auth: AuthContext,
  providerId: string,
  body: Record<string, unknown> | null,
): Promise<{ statusCode: number; body: ApiEnvelope<{ saved: true }> }> {
  if (!isKnownWebSearchProviderId(providerId)) {
    return envelopeError(
      404,
      'not_found',
      `Unknown web search provider '${providerId}'.`,
    );
  }
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) {
    return envelopeError(400, 'invalid_input', 'apiKey is required.');
  }
  const ciphertext = await encryptProviderSecret({ apiKey });
  return withUserContext(auth.userId, async () => {
    const db = getDbPg();
    await db`
      insert into public.web_search_provider_secrets
        (owner_id, provider_id, ciphertext)
      values
        (${auth.userId}::uuid, ${providerId}, ${ciphertext})
      on conflict (owner_id, provider_id) do update set
        ciphertext = excluded.ciphertext,
        updated_at = now()
    `;
    return envelopeOk({ saved: true as const });
  });
}

export async function deleteWebSearchCredentialRoute(
  auth: AuthContext,
  providerId: string,
): Promise<{ statusCode: number; body: ApiEnvelope<{ deleted: true }> }> {
  if (!isKnownWebSearchProviderId(providerId)) {
    return envelopeError(
      404,
      'not_found',
      `Unknown web search provider '${providerId}'.`,
    );
  }
  return withUserContext(auth.userId, async () => {
    const db = getDbPg();
    await db`
      delete from public.web_search_provider_secrets
      where provider_id = ${providerId}
    `;
    // If the user was using this provider, clear the active picker
    // too — leaving it pointing at a now-credential-less provider
    // would just make the next tool call fail with a confusing
    // "no API key" error.
    await db`
      update public.users
      set preferred_web_search_provider_id = null
      where id = ${auth.userId}::uuid
        and preferred_web_search_provider_id = ${providerId}
    `;
    return envelopeOk({ deleted: true as const });
  });
}

export async function putWebSearchActiveProviderRoute(
  auth: AuthContext,
  body: Record<string, unknown> | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ activeProviderId: WebSearchProviderId | null }>;
}> {
  const raw = body?.providerId;
  const providerId =
    raw === null || raw === ''
      ? null
      : typeof raw === 'string'
        ? raw.trim()
        : undefined;
  if (providerId === undefined) {
    return envelopeError(
      400,
      'invalid_input',
      'providerId must be a string or null.',
    );
  }
  if (providerId !== null && !isKnownWebSearchProviderId(providerId)) {
    return envelopeError(
      404,
      'not_found',
      `Unknown web search provider '${providerId}'. Valid: ${WEB_SEARCH_PROVIDER_IDS.join(', ')}.`,
    );
  }
  return withUserContext(auth.userId, async () => {
    const db = getDbPg();
    if (providerId !== null) {
      const rows = await db<Array<{ ok: number }>>`
        select 1 as ok from public.web_search_provider_secrets
        where provider_id = ${providerId}
        limit 1
      `;
      if (rows.length === 0) {
        return envelopeError(
          400,
          'invalid_input',
          `Cannot make '${providerId}' active — no API key is stored for it yet.`,
        );
      }
    }
    await db`
      update public.users
      set preferred_web_search_provider_id = ${providerId}
      where id = ${auth.userId}::uuid
    `;
    return envelopeOk({ activeProviderId: providerId });
  });
}
