/**
 * context-loader.ts
 *
 * Core context loading function that replaces context-assembler.ts and context-directives.ts.
 * Builds a ContextPackage from a Talk ID for consumption by the agent router.
 *
 * Handles:
 * 1. Fetching goal, rules, and rolling summary
 * 2. Building source manifest with inline small sources
 * 3. Building connector tools (currently stub)
 * 4. Loading message history with token budgeting
 * 5. Assembling into a ContextPackage with metadata
 */

import { getDbPg, type Sql } from '../../db.js';
import { listTalkStateEntries } from '../db/context-accessors.js';
import { getContentByTalkId, type Content } from '../db/content-accessors.js';
import type { EffectiveToolAccess } from '../db/agent-accessors.js';
import { listTalkOutputs } from '../db/output-accessors.js';
import {
  type LlmToolDefinition,
  type LlmMessage,
} from '../agents/llm-client.js';
import type { TalkPersonaRole } from '../llm/types.js';
import type { TalkJobExecutionPolicy } from './executor.js';
import {
  buildBoundGoogleDrivePromptSection,
  buildGoogleDriveContextTools,
  loadGoogleDriveBindings,
} from './google-drive-tools.js';

const WEB_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'web_search',
    description: [
      'Search the live web for current information. Returns a list of result objects with title, url, and a short snippet.',
      '',
      'When to call this:',
      '- Anything that may have changed since your training data: current events, news, rosters, prices, schedules, "current" / "latest" / "this season" / "right now" anything.',
      '- Any fact the user states or implies a date for. Even if you think you know, verify.',
      '- When the user pushes back on a fact you stated — re-check before defending it.',
      '',
      'Query tips:',
      '- Anchor time-sensitive queries to the actual timeframe you need, not just the year. "Cal football news past week" beats "Cal football news"; "game dev releases past few days" beats "game dev releases"; "today" or "last 24 hours" works for fast-moving stories. Default search returns popular pages, often months or years old.',
      '- Check the date on each result before trusting it. For "past week" questions, even a 2-week-old article is stale. For "current season" questions, anything before this season is stale. For "today" / breaking news, anything more than a day or two old should be flagged or re-searched.',
      '- If two recent results disagree, prefer the most recent and surface the disagreement to the user instead of picking silently.',
      '- One search rarely settles a personnel question (transfers, hirings, injuries) or a fast-breaking story. Do a second, more specific search before stating it as fact.',
      '',
      "The search backend (Tavily, Brave, Firecrawl) is chosen by the workspace's active provider setting — you don't need to specify one.",
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The natural-language search query. Keep it short and focused — like what you would type into Google. Include an explicit timeframe ("past week", "today", "2026 season") when freshness matters.',
        },
        max_results: {
          type: 'number',
          description:
            'Optional cap on the number of results returned. Defaults to 5; provider hard cap is 10.',
        },
      },
      required: ['query'],
    },
  },
];
const BROWSER_TOOL_DEFINITIONS: LlmToolDefinition[] = [];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextPackage {
  /** System prompt: goal + summary + rules + state + sources + bound Drive resources */
  systemPrompt: string;

  /** Tool definitions for reading context sources, attachments, and bound Drive resources */
  contextTools: LlmToolDefinition[];

  /** Tool definitions from bound data connectors */
  connectorTools: LlmToolDefinition[];

  /** Conversation history (after summary cutoff) in chronological order */
  history: LlmMessage[];

  /** Rough token estimate for budgeting (systemPrompt + history) */
  estimatedTokens: number;

  /** Auditable snapshot of the context package actually used for the run */
  contextSnapshot: TalkRunContextSnapshot;

  /**
   * Talk-level Context image sources to attach as vision content blocks
   * on the current user turn. Populated only when the caller declared
   * the active agent supports vision (`agentSupportsVision: true`).
   * Otherwise empty — non-vision agents see a manifest note instead.
   */
  contextImageSources: ContextImageSourceRef[];

  /** Metadata about the loaded context */
  metadata: {
    talkId: string;
    threadId: string | null;
    sourceCount: number;
    connectorCount: number;
    historyTurnCount: number;
    historyMessageIds: string[];
    activeRuleCount: number;
    stateEntryCount: number;
    hasSummary: boolean;
  };
}

export interface ContextImageSourceRef {
  ref: string;
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
  fileSize: number;
}

export interface TalkRunContextStateEntrySnapshot {
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
  reason: 'state_snapshot' | 'retrieved';
}

export interface TalkRunContextSourceManifestItem {
  ref: string;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  fileName: string | null;
}

export interface TalkRunContextInlineSourceSnapshot {
  ref: string;
  text: string;
}

export interface TalkRunContextRetrievedSourceSnapshot {
  ref: string;
  title: string;
  excerpt: string;
}

export interface TalkRunContextOutputManifestItem {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
  contentLength: number;
}

export interface TalkRunContextSnapshot {
  version: 1;
  threadId: string | null;
  personaRole: TalkPersonaRole | null;
  roleHint: string | null;
  goalIncluded: boolean;
  summaryIncluded: boolean;
  activeRules: string[];
  stateSnapshot: {
    totalCount: number;
    omittedCount: number;
    included: TalkRunContextStateEntrySnapshot[];
  };
  sources: {
    totalCount: number;
    manifest: TalkRunContextSourceManifestItem[];
    inline: TalkRunContextInlineSourceSnapshot[];
  };
  outputs: {
    totalCount: number;
    omittedCount: number;
    manifest: TalkRunContextOutputManifestItem[];
  };
  retrieval: {
    query: string | null;
    queryTerms: string[];
    roleTerms: string[];
    state: TalkRunContextStateEntrySnapshot[];
    sources: TalkRunContextRetrievedSourceSnapshot[];
  };
  tools: {
    contextToolNames: string[];
    connectorToolNames: string[];
  };
  history: {
    messageIds: string[];
    turnCount: number;
  };
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_RESERVE = 4096; // Tokens to reserve for model output
const TOOL_SCHEMA_RESERVE = 2000; // Tokens to reserve for tool definitions
const STATE_SNAPSHOT_RESERVE = 2000; // Tokens reserved for bounded Talk state
const RETRIEVAL_SECTION_RESERVE = 1200; // Tokens reserved for targeted retrieval
const CONTENT_OUTLINE_BUDGET_BYTES = 2048; // Hard byte budget for the doc outline
const CHARS_TO_TOKENS = 0.25; // Simple estimation: 1 char ≈ 0.25 tokens
const SMALL_SOURCE_THRESHOLD = 250; // Max tokens to inline a source
const MAX_RETRIEVED_STATE_ENTRIES = 3;
const MAX_RETRIEVED_SOURCE_ITEMS = 3;
const MAX_RETRIEVED_SOURCE_CHARS = 500;
const MAX_OUTPUT_MANIFEST_ITEMS = 10;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
]);

const ROLE_CONTEXT_PROFILES: Partial<
  Record<
    TalkPersonaRole,
    {
      focus: string;
      preferredStateKeywords: string[];
      preferredSourceKeywords: string[];
    }
  >
> = {
  analyst: {
    focus:
      'Prefer factual evidence, metrics, injuries, schedules, rosters, and trend data.',
    preferredStateKeywords: [
      'injury',
      'roster',
      'schedule',
      'depth',
      'stats',
      'trend',
      'performance',
    ],
    preferredSourceKeywords: [
      'injury',
      'roster',
      'schedule',
      'depth',
      'stats',
      'preview',
    ],
  },
  critic: {
    focus:
      'Prefer downside risks, weaknesses, constraints, and fragile assumptions.',
    preferredStateKeywords: ['risk', 'weakness', 'constraint', 'issue'],
    preferredSourceKeywords: ['risk', 'weakness', 'concern', 'problem'],
  },
  strategist: {
    focus:
      'Prefer goals, priorities, timelines, execution plans, and dependencies.',
    preferredStateKeywords: ['goal', 'priority', 'timeline', 'plan', 'owner'],
    preferredSourceKeywords: ['plan', 'roadmap', 'timeline', 'strategy'],
  },
  'devils-advocate': {
    focus:
      'Prefer blind spots, counterarguments, failure modes, and contradictory evidence.',
    preferredStateKeywords: [
      'assumption',
      'risk',
      'counter',
      'failure',
      'blind',
    ],
    preferredSourceKeywords: [
      'counter',
      'risk',
      'failure',
      'contrary',
      'concern',
    ],
  },
  synthesizer: {
    focus:
      'Prefer summaries, decision points, open questions, and cross-source consensus.',
    preferredStateKeywords: ['summary', 'decision', 'question', 'consensus'],
    preferredSourceKeywords: ['summary', 'decision', 'overview', 'consensus'],
  },
  editor: {
    focus: 'Prefer tone, audience, style, structure, and clarity guidance.',
    preferredStateKeywords: ['tone', 'audience', 'style', 'voice', 'format'],
    preferredSourceKeywords: ['style', 'voice', 'copy', 'brief'],
  },
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_TO_TOKENS);
}

// ---------------------------------------------------------------------------
// Main Context Loader
// ---------------------------------------------------------------------------

/**
 * Load Talk context for agent execution.
 *
 * Canonical context build order (documented contract — not ad hoc):
 *   1. Goal (talk_context_goal)
 *   2. Rolling summary (talk_context_summary) — disabled for threaded runs
 *      because a single talk-level summary injected into every thread leaks
 *      cross-thread context. Per-thread summaries are a future concern.
 *   3. Rules (talk_context_rules, active only)
 *   4. State snapshot (talk_state_entries, bounded by dedicated token budget)
 *   5. Source manifest (talk_context_sources, inline small sources)
 *   6. Bound Google Drive resources manifest (talk_resource_bindings)
 *   7. Connector tools (verified connectors only)
 *   8. Message history (thread-scoped when threadId provided, with token budgeting)
 *
 * @param talkId - The Talk to load context for
 * @param modelContextWindow - The model's context window in tokens
 * @param threadId - Optional thread to scope message history to. When provided,
 *   only messages from this thread are loaded and summary injection is skipped.
 */
export async function loadTalkContext(
  talkId: string,
  modelContextWindow: number,
  threadId?: string | null,
  historyThroughMessageId?: string | null,
  userId?: string | null,
  options?: {
    personaRole?: TalkPersonaRole | null;
    retrievalQuery?: string | null;
    jobPolicy?: TalkJobExecutionPolicy | null;
    effectiveTools?: EffectiveToolAccess[];
    channelContextSection?: string | null;
    /**
     * Whether the active agent's model supports vision. Controls how
     * image Context sources are surfaced: vision-capable models get
     * the binary attached on the user turn; non-vision models see a
     * "hidden" note in the source manifest.
     */
    agentSupportsVision?: boolean;
  },
): Promise<ContextPackage> {
  const db = getDbPg();
  const personaRole = options?.personaRole ?? null;
  const roleHint = buildRoleHint(personaRole);

  // Step 1: Fetch goal, rules, state, and rolling summary
  const goal = await fetchGoal(db, talkId);
  const rules = await fetchRules(db, talkId);
  const stateEntries = await listTalkStateEntries(talkId);

  // When loading for a specific thread, skip talk-level summary to avoid
  // leaking cross-thread context. A stale/wrong summary is worse than no
  // summary — the model still has recent thread history.
  const summary = threadId ? null : await fetchSummary(db, talkId);
  const stateSnapshot = buildStateSnapshot(
    stateEntries,
    STATE_SNAPSHOT_RESERVE,
  );
  const outputManifest = await buildOutputManifest(talkId);

  // Step 2: Build source manifest
  const sources = await fetchSources(db, talkId);
  const agentSupportsVision = options?.agentSupportsVision ?? false;
  const sourceLines = buildSourceManifest(sources, agentSupportsVision);
  const contextImageSources: ContextImageSourceRef[] = agentSupportsVision
    ? sources
        .filter(isImageSource)
        .filter((row) => row.storage_key)
        .map((row) => ({
          ref: row.source_ref,
          id: row.id,
          title: row.title,
          fileName: row.file_name ?? `${row.source_ref}.bin`,
          mimeType: row.mime_type!,
          storageKey: row.storage_key!,
          fileSize:
            typeof row.file_size === 'string'
              ? Number(row.file_size) || 0
              : (row.file_size ?? 0),
        }))
    : [];
  const retrievedContext = buildRetrievedContext({
    query: options?.retrievalQuery ?? null,
    personaRole,
    stateEntries,
    sources,
    excludedStateKeys: new Set(
      stateSnapshot.includedEntries.map((entry) => entry.key),
    ),
    excludedSourceRefs: new Set(
      sourceLines
        .filter((source) => source.inlineContent)
        .map((source) => source.ref),
    ),
    budgetTokens: RETRIEVAL_SECTION_RESERVE,
  });
  // D4 — always advertise: emit the Bound Drive Resources prompt section
  // whenever the agent has any Google family enabled, so the agent knows
  // whether bindings exist (and is told to use the Tools tab when they
  // don't). The schemas themselves are added in buildContextTools below.
  const enabledToolFamilies = new Set(
    (options?.effectiveTools ?? [])
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );
  const googleReadEnabled =
    !options?.effectiveTools || enabledToolFamilies.has('google_read');
  const googleWriteEnabled =
    !options?.effectiveTools || enabledToolFamilies.has('google_write');
  const includeBoundDriveSection = googleReadEnabled || googleWriteEnabled;
  const driveBindings = includeBoundDriveSection
    ? await loadGoogleDriveBindings(talkId)
    : [];
  const boundGoogleDriveResources = includeBoundDriveSection
    ? buildBoundGoogleDrivePromptSection(driveBindings)
    : '';

  // Web tools gate: only inject the "today's date + verify time-sensitive
  // facts" stanza for agents that actually have web_search available. An
  // agent without web access can't act on the rule, so the stanza is pure
  // token cost for those — skip it.
  const webEnabled = !options?.effectiveTools || enabledToolFamilies.has('web');
  const includeWebFreshnessStanza =
    webEnabled && (!options?.jobPolicy || options.jobPolicy.allowWeb);

  // Step 3: Build connector tools (currently empty stub)
  const connectorTools = buildConnectorTools(talkId, options?.jobPolicy);

  // Content document (PR 5): outline + propose_content_append tool are
  // gated on the Talk actually having an attached doc. One per Talk by
  // schema, so this is at most one row.
  const content = await getContentByTalkId(talkId);
  const contentOutline = content ? buildContentOutline(content) : null;

  // Step 4: Assemble system prompt
  const systemPrompt = assembleSystemPrompt(
    goal,
    summary,
    rules,
    roleHint,
    options?.channelContextSection ?? null,
    stateSnapshot.promptText,
    outputManifest.promptText,
    retrievedContext.promptText,
    sourceLines,
    contentOutline,
    boundGoogleDriveResources,
    includeWebFreshnessStanza,
  );
  const systemPromptTokens = Math.ceil(systemPrompt.length * CHARS_TO_TOKENS);

  // Step 5: Build context tools (always included)
  const contextTools = buildContextTools(
    talkId,
    userId,
    options?.jobPolicy,
    options?.effectiveTools,
    content !== null,
  );

  // Step 6: Load message history with token budgeting (thread-scoped if threadId provided)
  const availableBudget =
    modelContextWindow -
    OUTPUT_RESERVE -
    systemPromptTokens -
    TOOL_SCHEMA_RESERVE;
  const historySelection = await loadMessageHistory(
    db,
    talkId,
    availableBudget,
    threadId,
    historyThroughMessageId,
  );
  const history = historySelection.messages;

  // Estimate total tokens
  const historyTokens = history.reduce((sum, msg) => {
    const contentStr =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
    return sum + Math.ceil(contentStr.length * CHARS_TO_TOKENS);
  }, 0);
  const estimatedTokens =
    systemPromptTokens + historyTokens + TOOL_SCHEMA_RESERVE;

  // Build metadata
  const metadata = {
    talkId,
    threadId: threadId ?? null,
    sourceCount: sources.length,
    connectorCount: connectorTools.length,
    historyTurnCount: history.length,
    historyMessageIds: historySelection.messageIds,
    activeRuleCount: rules.length,
    stateEntryCount: stateEntries.length,
    hasSummary: summary !== null,
  };

  const contextSnapshot: TalkRunContextSnapshot = {
    version: 1,
    threadId: threadId ?? null,
    personaRole,
    roleHint,
    goalIncluded: Boolean(goal),
    summaryIncluded: summary !== null,
    activeRules: rules,
    stateSnapshot: {
      totalCount: stateEntries.length,
      omittedCount: stateSnapshot.omittedCount,
      included: stateSnapshot.includedEntries.map((entry) => ({
        ...entry,
        reason: 'state_snapshot',
      })),
    },
    sources: {
      totalCount: sourceLines.length,
      manifest: sourceLines.map((source) => ({
        ref: source.ref,
        title: source.title,
        sourceType: source.sourceType,
        sourceUrl: source.sourceUrl,
        fileName: source.fileName,
      })),
      inline: sourceLines
        .filter((source) => source.inlineContent)
        .map((source) => ({
          ref: source.ref,
          text: source.inlineContent!,
        })),
    },
    outputs: {
      totalCount: outputManifest.totalCount,
      omittedCount: outputManifest.omittedCount,
      manifest: outputManifest.included,
    },
    retrieval: {
      query: options?.retrievalQuery?.trim() || null,
      queryTerms: retrievedContext.queryTerms,
      roleTerms: retrievedContext.roleTerms,
      state: retrievedContext.stateEntries.map((entry) => ({
        ...entry,
        reason: 'retrieved',
      })),
      sources: retrievedContext.sourceEntries,
    },
    tools: {
      contextToolNames: contextTools.map((tool) => tool.name),
      connectorToolNames: connectorTools.map((tool) => tool.name),
    },
    history: {
      messageIds: historySelection.messageIds,
      turnCount: history.length,
    },
    estimatedTokens,
  };

  return {
    systemPrompt,
    connectorTools,
    contextTools,
    history,
    estimatedTokens,
    contextSnapshot,
    contextImageSources,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Step 1: Fetch Goal, Rules, and Summary
// ---------------------------------------------------------------------------

async function fetchGoal(db: Sql, talkId: string): Promise<string | null> {
  const rows = await db<Array<{ goal_text: string }>>`
    select goal_text
    from public.talk_context_goal
    where talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0]?.goal_text ?? null;
}

async function fetchRules(db: Sql, talkId: string): Promise<string[]> {
  const rows = await db<Array<{ rule_text: string }>>`
    select rule_text
    from public.talk_context_rules
    where talk_id = ${talkId}::uuid and is_active = true
    order by sort_order asc, created_at asc
  `;
  return rows.map((r) => r.rule_text);
}

async function fetchSummary(db: Sql, talkId: string): Promise<string | null> {
  const rows = await db<Array<{ summary_text: string }>>`
    select summary_text
    from public.talk_context_summary
    where talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0]?.summary_text ?? null;
}

// ---------------------------------------------------------------------------
// Step 2: Build Source Manifest
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  source_ref: string;
  source_type: string;
  title: string;
  source_url: string | null;
  file_name: string | null;
  file_size: number | string | null;
  mime_type: string | null;
  storage_key: string | null;
  extracted_text: string | null;
  status: string;
}

async function fetchSources(db: Sql, talkId: string): Promise<SourceRow[]> {
  return await db<SourceRow[]>`
    select
      id,
      source_ref,
      source_type,
      title,
      source_url,
      file_name,
      file_size,
      mime_type,
      storage_key,
      extracted_text,
      status
    from public.talk_context_sources
    where talk_id = ${talkId}::uuid and status = 'ready'
    order by sort_order asc
  `;
}

const IMAGE_SOURCE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

function isImageSource(row: SourceRow): boolean {
  return (
    row.source_type === 'file' &&
    !!row.mime_type &&
    IMAGE_SOURCE_MIME_TYPES.has(row.mime_type)
  );
}

function buildSourceManifest(
  sources: SourceRow[],
  agentSupportsVision: boolean,
): Array<{
  ref: string;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  fileName: string | null;
  line: string;
  inlineContent: string | null;
}> {
  return sources.map((source) => {
    // Use the stable source_ref from the DB (e.g., "S1", "S4")
    const ref = source.source_ref;

    // Build the source reference line (e.g., "[S1] Title - URL")
    let refLine = `[${ref}] ${source.title}`;
    if (isImageSource(source)) {
      const fileLabel = source.file_name ? ` ${source.file_name}` : '';
      refLine += agentSupportsVision
        ? ` (image —${fileLabel}; attached to this turn)`
        : ` (image —${fileLabel}; hidden, this agent's model lacks vision)`;
    } else if (source.source_type === 'url' && source.source_url) {
      refLine += ` - ${source.source_url}`;
    } else if (source.source_type === 'file' && source.file_name) {
      refLine += ` (${source.file_name})`;
    }

    // For small text sources, inline the content
    let inlineContent: string | null = null;
    if (
      source.source_type === 'text' &&
      source.extracted_text &&
      source.extracted_text.length * CHARS_TO_TOKENS < SMALL_SOURCE_THRESHOLD
    ) {
      inlineContent = source.extracted_text;
    }

    return {
      ref,
      title: source.title,
      sourceType: source.source_type,
      sourceUrl: source.source_url,
      fileName: source.file_name,
      line: refLine,
      inlineContent,
    };
  });
}

// ---------------------------------------------------------------------------
// Step 3: Build Connector Tools
// ---------------------------------------------------------------------------

/**
 * Load connector tool definitions for a Talk.
 *
 * Runtime verification guard: only connectors that are enabled, have a
 * credential, AND have verificationStatus === 'verified' produce tool
 * definitions. An attached connector that later becomes invalid or
 * unavailable is silently excluded — fail closed.
 */
function buildConnectorTools(
  _talkId: string,
  _jobPolicy?: TalkJobExecutionPolicy | null,
): LlmToolDefinition[] {
  // Data connectors were removed with the ClawTalk chassis purge.
  return [];
}

// ---------------------------------------------------------------------------
// Step 4: Assemble System Prompt
// ---------------------------------------------------------------------------

/**
 * Build the outline section for the agent's system prompt.
 *
 * Format per block: `[anchor:<id>] <kind> "<first 60 chars>"`. Blocks
 * are emitted in document order. If the outline would exceed the byte
 * budget, truncate from the bottom and append `[… N more blocks not
 * shown]`. The 60-char preview lives in `anchor_map_json` already, so
 * this is a pure projection — no re-tokenization of the body.
 */
export function buildContentOutline(
  content: Content,
  budgetBytes: number = CONTENT_OUTLINE_BUDGET_BYTES,
): string {
  const entries = Object.entries(content.anchorMap)
    .map(([anchorId, entry]) => ({ anchorId, ...entry }))
    .sort((a, b) => a.sort_order - b.sort_order);

  const header = [
    `**Attached Document:** "${content.title}" (v${content.bodyVersion})`,
    '',
    'This Talk has a long-form document attached. When the user refers to "the doc", "the document", "this doc", or "the attached document", they mean THIS document — not a Google Doc binding. You see its full structure in the outline below. To read the full text of a specific block, ask the user; full block bodies are not in the outline by design (2KB budget).',
  ].join('\n');
  const footer =
    'To append a new block to this document, call `propose_content_append({ after_anchor_id, markdown, rationale })`. The user reviews and accepts or rejects in the Talk UI; you are not editing the document directly.';

  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header).byteLength;
  const footerBytes = encoder.encode(`\n\n${footer}`).byteLength;
  const truncationTemplate = (n: number): string =>
    `[… ${n} more blocks not shown]`;
  const maxTruncationBytes = encoder.encode(
    truncationTemplate(entries.length),
  ).byteLength;

  let usedBytes = headerBytes + footerBytes;
  const lines: string[] = [];
  let included = 0;

  for (const entry of entries) {
    const preview = entry.preview.replace(/"/g, '\\"');
    const line = `[anchor:${entry.anchorId}] ${entry.kind} "${preview}"`;
    const lineBytes = encoder.encode(`\n${line}`).byteLength;
    const remaining = entries.length - included - 1;
    const reserveForTruncation =
      remaining > 0
        ? encoder.encode(`\n${truncationTemplate(remaining)}`).byteLength
        : 0;
    if (usedBytes + lineBytes + reserveForTruncation > budgetBytes) break;
    lines.push(line);
    usedBytes += lineBytes;
    included += 1;
  }

  const remaining = entries.length - included;
  const truncationLine = remaining > 0 ? truncationTemplate(remaining) : null;

  const parts: string[] = [header];
  if (lines.length > 0) parts.push(lines.join('\n'));
  if (truncationLine) parts.push(truncationLine);
  parts.push(footer);

  // Sanity guard: respect the budget even when the header alone is
  // unusually large (long title). Trim from the bottom up.
  let assembled = parts.join('\n\n');
  if (encoder.encode(assembled).byteLength > budgetBytes && included > 0) {
    return `${header}\n\n${truncationTemplate(entries.length)}\n\n${footer}`;
  }
  // Suppress unused warning when zero blocks fit but budget allows header+footer.
  void maxTruncationBytes;
  return assembled;
}

function buildWebFreshnessStanza(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `**Today's date:** ${today}`,
    '',
    "Your training data has a cutoff — facts that change over time (rosters, prices, schedules, news, who-is-the-current-X) may be out of date. Before stating a time-sensitive fact as current, verify it with web_search. If web_search isn't configured, say so and ask the user for an authoritative source instead of guessing.",
  ].join('\n');
}

function assembleSystemPrompt(
  goal: string | null,
  summary: string | null,
  rules: string[],
  roleHint: string | null,
  channelContextSection: string | null,
  stateSnapshot: string | null,
  outputManifest: string | null,
  retrievedContext: string | null,
  sourceLines: Array<{
    ref: string;
    title: string;
    sourceType: string;
    sourceUrl: string | null;
    fileName: string | null;
    line: string;
    inlineContent: string | null;
  }>,
  contentOutline: string | null,
  boundGoogleDriveResources: string | null,
  includeWebFreshnessStanza: boolean,
): string {
  const parts: string[] = [];

  if (includeWebFreshnessStanza) {
    parts.push(buildWebFreshnessStanza());
  }

  if (goal) {
    parts.push(`**Goal:**\n${goal}`);
  }

  if (summary) {
    parts.push(`**Summary:**\n${summary}`);
  }

  if (rules.length > 0) {
    const ruleLines = rules.map((r, i) => `${i + 1}. ${r}`);
    parts.push(`**Rules:**\n${ruleLines.join('\n')}`);
  }

  // Place the Attached Document section right after Rules so it sits
  // alongside the orienting context, not buried below Sources/State.
  // 104-block / 2KB outlines were getting overlooked otherwise — Kimi
  // saw the section but pattern-matched on "Google Doc" instead.
  if (contentOutline) {
    parts.push(contentOutline);
  }

  if (roleHint) {
    parts.push(`**Role Context Hint:**\n${roleHint}`);
  }

  if (channelContextSection) {
    parts.push(`**Channel Context:**\n${channelContextSection}`);
  }

  if (stateSnapshot) {
    parts.push(stateSnapshot);
  }

  if (outputManifest) {
    parts.push(outputManifest);
  }

  if (retrievedContext) {
    parts.push(retrievedContext);
  }

  if (sourceLines.length > 0) {
    const manifestLines = sourceLines.map((s) => s.line);
    parts.push(`**Sources:**\n${manifestLines.join('\n')}`);

    // Append inline content
    const inlineBlocks = sourceLines
      .filter((s) => s.inlineContent)
      .map((s) => `\n[${s.ref}] Content:\n${s.inlineContent}`);
    if (inlineBlocks.length > 0) {
      parts.push(inlineBlocks.join('\n'));
    }
  }

  if (boundGoogleDriveResources) {
    parts.push(boundGoogleDriveResources);
  }

  return parts.join('\n\n');
}

const MAX_OMITTED_KEYS_SHOWN = 5;

function buildOmissionNote(
  omittedCount: number,
  omittedKeys: string[],
): string {
  const shownKeys = omittedKeys.slice(0, MAX_OMITTED_KEYS_SHOWN);
  const extra = omittedKeys.length - shownKeys.length;
  const keyList = shownKeys.join(', ') + (extra > 0 ? `, +${extra} more` : '');
  return `- ${omittedCount} state entr${
    omittedCount === 1 ? 'y' : 'ies'
  } omitted (keys: ${keyList}). Use list_state(prefix) to discover keys or read_state(key) to fetch one directly.`;
}

function buildStateSnapshot(
  entries: Array<{
    key: string;
    value: unknown;
    version: number;
    updatedAt: string;
  }>,
  budgetTokens: number,
): {
  promptText: string | null;
  includedEntries: Array<{
    key: string;
    value: unknown;
    version: number;
    updatedAt: string;
  }>;
  omittedCount: number;
} {
  if (entries.length === 0 || budgetTokens <= 0) {
    return {
      promptText: null,
      includedEntries: [],
      omittedCount: 0,
    };
  }

  const lines: string[] = [];
  const includedEntries: Array<{
    key: string;
    value: unknown;
    version: number;
    updatedAt: string;
  }> = [];
  let usedTokens = estimateTokens('**State Snapshot:**\n');
  const omittedKeys: string[] = [];

  for (const entry of entries) {
    const line = `- ${entry.key} (v${entry.version}, updated ${entry.updatedAt}): ${JSON.stringify(entry.value)}`;
    const lineTokens = estimateTokens(line);
    if (usedTokens + lineTokens > budgetTokens) {
      omittedKeys.push(entry.key);
      continue;
    }
    lines.push(line);
    includedEntries.push(entry);
    usedTokens += lineTokens;
  }

  if (lines.length === 0) {
    const omissionNote = buildOmissionNote(entries.length, omittedKeys);
    const omissionTokens = estimateTokens(omissionNote);
    const noteToUse =
      usedTokens + omissionTokens <= budgetTokens
        ? omissionNote
        : `- ${entries.length} state entr${
            entries.length === 1 ? 'y' : 'ies'
          } omitted. Use list_state(prefix) to discover keys or read_state(key) to fetch one directly.`;
    return {
      promptText: `**State Snapshot:**\n${noteToUse}`,
      includedEntries: [],
      omittedCount: entries.length,
    };
  }

  if (omittedKeys.length > 0) {
    const omissionNote = buildOmissionNote(omittedKeys.length, omittedKeys);
    const omissionTokens = estimateTokens(omissionNote);
    if (usedTokens + omissionTokens <= budgetTokens) {
      lines.push(omissionNote);
    } else {
      lines.push(
        `- ${omittedKeys.length} additional state entr${
          omittedKeys.length === 1 ? 'y' : 'ies'
        } omitted. Use list_state(prefix) to discover keys or read_state(key) to fetch one directly.`,
      );
    }
  }

  return {
    promptText: `**State Snapshot:**\n${lines.join('\n')}`,
    includedEntries,
    omittedCount: omittedKeys.length,
  };
}

// ---------------------------------------------------------------------------
// Step 5: Build Context Tools
// ---------------------------------------------------------------------------

function buildContextTools(
  talkId: string,
  userId?: string | null,
  jobPolicy?: TalkJobExecutionPolicy | null,
  effectiveTools?: EffectiveToolAccess[],
  hasContent: boolean = false,
): LlmToolDefinition[] {
  const tools: LlmToolDefinition[] = [
    {
      name: 'read_context_source',
      description:
        'Read the content of a context source by its stable ref (e.g., S1, S2)',
      inputSchema: {
        type: 'object',
        properties: {
          sourceRef: {
            type: 'string',
            description: 'Stable source ref like S1, S2, etc.',
          },
        },
        required: ['sourceRef'],
      },
    },
    {
      name: 'read_attachment',
      description: 'Read a message attachment by ID',
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: {
            type: 'string',
            description: 'Attachment ID',
          },
        },
        required: ['attachmentId'],
      },
    },
  ];

  tools.push({
    name: 'list_state',
    description:
      'List Talk state entries, optionally filtered by a key prefix. Returns matching keys, values, versions, and update timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: {
          type: 'string',
          description:
            'Optional key prefix filter. Use this to discover entries inside a namespace.',
        },
      },
    },
  });

  tools.push({
    name: 'read_state',
    description:
      'Read a single Talk state entry by key. Returns the current value and version. Use this to fetch entries omitted from the snapshot, or to get the latest value before an update.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'State entry key to read',
        },
      },
      required: ['key'],
    },
  });

  if (!jobPolicy || jobPolicy.allowStateMutation) {
    tools.push(
      {
        name: 'update_state',
        description:
          'Persist a structured JSON state entry for this Talk using compare-and-swap versioning. Create new keys with expectedVersion 0. Update existing keys with their current version from the state snapshot. On conflict, the tool returns the current stored value as an error so you can retry.',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'State entry key',
            },
            value: {
              description:
                'JSON value to store for this key. Can be an object, array, string, number, boolean, or null.',
            },
            expectedVersion: {
              type: 'number',
              description:
                'Use 0 to create a new key. For updates, use the current version from the state snapshot.',
            },
          },
          required: ['key', 'value', 'expectedVersion'],
        },
      },
      {
        name: 'delete_state',
        description:
          'Delete a Talk state entry by key using compare-and-swap versioning. Provide the current version to prevent accidental deletes of stale data.',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'State entry key to delete',
            },
            expectedVersion: {
              type: 'number',
              description: 'Current version of the entry',
            },
          },
          required: ['key', 'expectedVersion'],
        },
      },
    );
  }

  const enabledToolFamilies = new Set(
    (effectiveTools ?? [])
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );
  const webEnabled = !effectiveTools || enabledToolFamilies.has('web');
  const browserEnabled = !effectiveTools || enabledToolFamilies.has('browser');

  if ((!jobPolicy || jobPolicy.allowWeb) && webEnabled) {
    tools.push(...WEB_TOOL_DEFINITIONS);
  }

  if ((!jobPolicy || jobPolicy.allowWeb) && browserEnabled) {
    tools.push(...BROWSER_TOOL_DEFINITIONS);
  }

  // D4 — always advertise Google Drive/Docs tools when the agent's family
  // is enabled. Credential / binding / scope gating happens at call time
  // via typed errors so the agent gets actionable feedback ("connect Google"
  // / "bind a doc first") instead of silently lacking the tool. The C6
  // external-mutation gate is enforced inside the executor, not here.
  const googleReadEnabled =
    !effectiveTools || enabledToolFamilies.has('google_read');
  const googleWriteEnabled =
    !effectiveTools || enabledToolFamilies.has('google_write');
  if (googleReadEnabled || googleWriteEnabled) {
    tools.push(
      ...buildGoogleDriveContextTools({
        readEnabled: googleReadEnabled,
        writeEnabled: googleWriteEnabled,
      }),
    );
  }

  // Content document tool (PR 5) — only register when this Talk has an
  // attached doc, so agents in chat-only Talks aren't tempted to call it
  // and fall into "no document" errors.
  if (hasContent) {
    tools.push({
      name: 'propose_content_append',
      description: [
        "Propose appending a new block to the Talk's attached document.",
        '',
        'Anchor IDs come from the **Document Outline** in your system prompt. Pass `after_anchor_id` to insert immediately after a specific block, or `null` to prepend at the very top. The user reviews and accepts or rejects the proposal in the Talk UI — your call writes a pending proposal, not the document itself.',
        '',
        'Use this when the user asks you to add to, extend, draft, or continue the doc. For now this is append-only — there is no replace or delete surface; smaller proposals (one or two blocks) review better than long ones.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          after_anchor_id: {
            type: ['string', 'null'],
            description:
              'Anchor ID of the block to insert AFTER, copied from the Document Outline. Pass null to prepend at the top.',
          },
          markdown: {
            type: 'string',
            description:
              'The new block(s) as GitHub-flavored markdown. Keep it tight — one or two blocks reviews better than a wall of text.',
          },
          rationale: {
            type: 'string',
            description:
              "Optional one-sentence explanation shown on the proposal card so the user knows why you're suggesting this block.",
          },
        },
        required: ['markdown'],
      },
    });
  }

  return tools;
}

async function buildOutputManifest(talkId: string): Promise<{
  totalCount: number;
  omittedCount: number;
  included: TalkRunContextOutputManifestItem[];
  promptText: string | null;
}> {
  const outputs = await listTalkOutputs(talkId);
  if (outputs.length === 0) {
    return {
      totalCount: 0,
      omittedCount: 0,
      included: [],
      promptText: null,
    };
  }

  const included = outputs
    .slice(0, MAX_OUTPUT_MANIFEST_ITEMS)
    .map((output) => ({
      id: output.id,
      title: output.title,
      version: output.version,
      updatedAt: output.updatedAt,
      contentLength: output.contentLength,
    }));
  const omittedCount = Math.max(0, outputs.length - included.length);
  const lines = included.map(
    (output) =>
      `- ${output.id}: ${output.title} (v${output.version}, ${output.contentLength} chars, updated ${output.updatedAt})`,
  );
  if (omittedCount > 0) {
    lines.push(
      `- ${omittedCount} additional output${
        omittedCount === 1 ? '' : 's'
      } omitted from the default manifest.`,
    );
  }

  return {
    totalCount: outputs.length,
    omittedCount,
    included,
    promptText: `**Outputs:**\n${lines.join('\n')}`,
  };
}

function buildRoleHint(personaRole: TalkPersonaRole | null): string | null {
  if (!personaRole) return null;
  const profile = ROLE_CONTEXT_PROFILES[personaRole];
  if (!profile) return null;
  return `${profile.focus} Preferred state keywords: ${profile.preferredStateKeywords.join(
    ', ',
  )}. Preferred source keywords: ${profile.preferredSourceKeywords.join(', ')}.`;
}

function extractKeywords(text: string | null | undefined): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return Array.from(new Set(tokens)).slice(0, 12);
}

function scoreMatch(
  haystack: string,
  queryTerms: string[],
  roleTerms: string[],
): number {
  const normalized = haystack.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (normalized.includes(term)) score += 3;
  }
  for (const term of roleTerms) {
    if (normalized.includes(term)) score += 1;
  }
  return score;
}

function buildExcerpt(
  text: string,
  preferredTerms: string[],
  maxChars: number,
): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  const matchIndex = preferredTerms
    .map((term) => lower.indexOf(term))
    .find((index) => index >= 0);
  if (typeof matchIndex !== 'number' || matchIndex < 0) {
    return `${normalized.slice(0, maxChars).trim()}…`;
  }

  const start = Math.max(0, matchIndex - Math.floor(maxChars / 3));
  const end = Math.min(normalized.length, start + maxChars);
  const excerpt = normalized.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < normalized.length ? '…' : ''}`;
}

function buildRetrievedContext(input: {
  query: string | null;
  personaRole: TalkPersonaRole | null;
  stateEntries: Array<{
    key: string;
    value: unknown;
    version: number;
    updatedAt: string;
  }>;
  sources: SourceRow[];
  excludedStateKeys: Set<string>;
  excludedSourceRefs: Set<string>;
  budgetTokens: number;
}): {
  promptText: string | null;
  queryTerms: string[];
  roleTerms: string[];
  stateEntries: Array<{
    key: string;
    value: unknown;
    version: number;
    updatedAt: string;
  }>;
  sourceEntries: TalkRunContextRetrievedSourceSnapshot[];
} {
  const queryTerms = extractKeywords(input.query);
  const profile = input.personaRole
    ? ROLE_CONTEXT_PROFILES[input.personaRole]
    : undefined;
  const roleTerms = Array.from(
    new Set([
      ...(profile?.preferredStateKeywords || []),
      ...(profile?.preferredSourceKeywords || []),
    ]),
  );

  if (queryTerms.length === 0 && roleTerms.length === 0) {
    return {
      promptText: null,
      queryTerms,
      roleTerms,
      stateEntries: [],
      sourceEntries: [],
    };
  }

  const stateCandidates = input.stateEntries
    .filter((entry) => !input.excludedStateKeys.has(entry.key))
    .map((entry) => ({
      ...entry,
      score: scoreMatch(
        `${entry.key} ${JSON.stringify(entry.value)}`,
        queryTerms,
        roleTerms,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_RETRIEVED_STATE_ENTRIES);

  const sourceCandidates = input.sources
    .filter(
      (source) =>
        !input.excludedSourceRefs.has(source.source_ref) &&
        typeof source.extracted_text === 'string' &&
        source.extracted_text.trim().length > 0,
    )
    .map((source) => ({
      source,
      score: scoreMatch(
        [
          source.title,
          source.source_url,
          source.file_name,
          source.extracted_text,
        ]
          .filter(Boolean)
          .join(' '),
        queryTerms,
        roleTerms,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_RETRIEVED_SOURCE_ITEMS)
    .map(({ source }) => ({
      ref: source.source_ref,
      title: source.title,
      excerpt: buildExcerpt(
        source.extracted_text!,
        [...queryTerms, ...roleTerms],
        MAX_RETRIEVED_SOURCE_CHARS,
      ),
    }));

  if (stateCandidates.length === 0 && sourceCandidates.length === 0) {
    return {
      promptText: null,
      queryTerms,
      roleTerms,
      stateEntries: [],
      sourceEntries: [],
    };
  }

  const parts: string[] = [];
  let usedTokens = estimateTokens('**Retrieved Context:**\n');
  const keptStateEntries: Array<{
    key: string;
    value: unknown;
    version: number;
    updatedAt: string;
  }> = [];
  const keptSourceEntries: TalkRunContextRetrievedSourceSnapshot[] = [];

  for (const entry of stateCandidates) {
    const line = `- State ${entry.key} (v${entry.version}, updated ${entry.updatedAt}): ${JSON.stringify(entry.value)}`;
    const lineTokens = estimateTokens(line);
    if (usedTokens + lineTokens > input.budgetTokens) break;
    keptStateEntries.push(entry);
    parts.push(line);
    usedTokens += lineTokens;
  }

  for (const source of sourceCandidates) {
    const block = `- Source [${source.ref}] ${source.title}: ${source.excerpt}`;
    const blockTokens = estimateTokens(block);
    if (usedTokens + blockTokens > input.budgetTokens) break;
    keptSourceEntries.push(source);
    parts.push(block);
    usedTokens += blockTokens;
  }

  return {
    promptText:
      parts.length > 0 ? `**Retrieved Context:**\n${parts.join('\n')}` : null,
    queryTerms,
    roleTerms,
    stateEntries: keptStateEntries,
    sourceEntries: keptSourceEntries,
  };
}

// ---------------------------------------------------------------------------
// Step 6: Load Message History with Token Budgeting
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  role: string;
  content: string;
  agent_id: string | null;
  created_at: string;
  // postgres.js parses jsonb columns on read; this is the parsed
  // object, not the serialized string.
  metadata_json: Record<string, unknown> | null;
}

function extractAssistantProviderData(
  metadata: Record<string, unknown> | null,
): LlmMessage['providerData'] | undefined {
  if (!metadata) return undefined;
  const reasoning = metadata.codexReasoningItems;
  const message = metadata.codexMessageItems;
  const out: LlmMessage['providerData'] = {};
  if (Array.isArray(reasoning) && reasoning.length > 0) {
    out.codexReasoningItems = reasoning as Array<Record<string, unknown>>;
  }
  if (Array.isArray(message) && message.length > 0) {
    out.codexMessageItems = message as Array<Record<string, unknown>>;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function loadMessageHistory(
  db: Sql,
  talkId: string,
  budgetTokens: number,
  threadId?: string | null,
  historyThroughMessageId?: string | null,
): Promise<{ messages: LlmMessage[]; messageIds: string[] }> {
  const threadIdArg = threadId ?? null;
  const cutoff = historyThroughMessageId
    ? (
        await db<Array<{ id: string; created_at: string }>>`
          select id, created_at
          from public.talk_messages
          where id = ${historyThroughMessageId}::uuid
            and talk_id = ${talkId}::uuid
            and (${threadIdArg}::uuid is null or thread_id = ${threadIdArg}::uuid)
          limit 1
        `
      )[0]
    : undefined;
  const cutoffId = cutoff?.id ?? null;
  const cutoffCreatedAt = cutoff?.created_at ?? null;

  // When threadId is provided, only load messages from that thread.
  // Otherwise load all messages for the Talk (legacy/pre-thread behavior).
  // The cutoff predicate matches messages strictly before the cutoff time,
  // PLUS messages at the same created_at with id <= cutoff.id — this keeps
  // tie-breaking semantics identical to the sqlite era.
  const rows = await db<MessageRow[]>`
    select id, role, content, agent_id, created_at, metadata_json
    from public.talk_messages
    where talk_id = ${talkId}::uuid
      and (${threadIdArg}::uuid is null or thread_id = ${threadIdArg}::uuid)
      and (
        ${cutoffId}::uuid is null
        or created_at < ${cutoffCreatedAt}::timestamptz
        or (created_at = ${cutoffCreatedAt}::timestamptz and id <= ${cutoffId}::uuid)
      )
    order by created_at desc
  `;

  // Walk backward through messages, accumulating token count
  let accumulatedTokens = 0;
  const selectedRows: MessageRow[] = [];

  for (const row of rows) {
    const messageTokens = Math.ceil(row.content.length * CHARS_TO_TOKENS);
    if (accumulatedTokens + messageTokens > budgetTokens) {
      break; // Budget exceeded, stop here
    }
    accumulatedTokens += messageTokens;
    selectedRows.push(row);
  }

  // Reverse to chronological order
  selectedRows.reverse();

  // Convert to LlmMessage format. Codex provider_data (encrypted
  // reasoning + replayable message items) was stashed in
  // metadata_json by the executor's buildResponseMetadataJson — surface
  // it on assistant messages so the codex_responses adapter can replay
  // it to the backend on the next turn.
  return {
    messages: selectedRows.map((row) => {
      const message: LlmMessage = {
        role: row.role as 'user' | 'assistant' | 'system' | 'tool',
        content: row.content,
      };
      if (row.role === 'assistant') {
        const providerData = extractAssistantProviderData(row.metadata_json);
        if (providerData) {
          message.providerData = providerData;
        }
      }
      return message;
    }),
    messageIds: selectedRows.map((row) => row.id),
  };
}
