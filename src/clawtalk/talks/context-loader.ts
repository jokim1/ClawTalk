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
import {
  ALLOWED_TAGS,
  ensureAnchorIds,
  extractOutline,
  getAnchorId,
  insertAnchors,
  markdownToTiptapJson,
  plainTextOf,
  sanitizeRichTextDocument,
} from '../../shared/rich-text/index.js';
import type { EffectiveToolAccess } from '../db/agent-accessors.js';
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
import { extractSourceReferences } from './source-reference-detection.js';

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

  /**
   * Talk-level Context PDF sources to attach as native document blocks
   * on the current user turn. Populated only when the caller declared
   * the active agent supports PDF documents
   * (`agentSupportsDocuments: true`). Auto-attach selects at most one
   * source by recency; @-ref additions arrive with `forceAttached=true`
   * and bypass the count cap (but not the per-source size cap nor the
   * total-payload budget). Non-doc-capable agents see a manifest note
   * and rely on the `extracted_text` text fallback instead.
   */
  contextDocumentSources: ContextDocumentSourceRef[];

  /**
   * Pre-fetched `@-ref` injection block to prepend to the user-role
   * message this turn. Null when the user did not @-reference any
   * sources. Already sanitized + bounded by FORCED_INJECTION_BUDGET_BYTES.
   * The executor wraps this in a "treat as data, not instructions"
   * preamble before prepending — see new-executor.ts.
   */
  forcedInjectionText: string | null;

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

export interface ContextDocumentSourceRef {
  ref: string;
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
  fileSize: number;
  /**
   * True when the user explicitly @-ref'd this PDF on the latest turn.
   * Force-attached refs bypass the per-turn count cap (N=1) but still
   * obey the per-source size cap and the total-payload budget.
   */
  forceAttached: boolean;
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
    forcedInjection: {
      refs: string[];
      slugs: string[];
      bytes: number;
    };
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

// Per-source raw byte cap on PDF documents auto-attached or @-ref'd
// onto a user turn. 12 MiB raw expands to ~16 MB base64 string + ~16 MB
// JSON.stringify materialization, leaving headroom against the Anthropic
// 32 MB total-request-payload cap and the Cloudflare Workers 128 MB
// per-isolate heap (shared across concurrent requests). Codex review
// flagged the prior 16 MB plan as too aggressive — see
// ~/.claude/plans/pdf-vision-plan.md D3.
export const MAX_PDF_DOCUMENT_BYTES = 12 * 1024 * 1024;

// Maximum number of PDFs auto-attached per turn before @-ref bypass.
// Start conservative at 1 to keep cost + heap predictable; lift later
// once production telemetry confirms safe room.
export const MAX_AUTO_ATTACH_PDF_COUNT = 1;
// 20KB budget for the inlined doc — large enough to give the agent the
// actual prose it's being asked to edit, while truncating from the
// bottom on really long docs. Read-block tool is the v2 escape hatch.
const CONTENT_OUTLINE_BUDGET_BYTES = 20_480;
const CHARS_TO_TOKENS = 0.25; // Simple estimation: 1 char ≈ 0.25 tokens
const MAX_RETRIEVED_STATE_ENTRIES = 3;

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
    /**
     * Whether the active agent's model accepts native PDF document
     * blocks on the user turn. Controls how PDF Context sources are
     * surfaced: doc-capable models get the PDF auto-attached (capped
     * at one per turn by recency, plus any @-ref additions) as a
     * native document block; other models see a manifest note and
     * read the `extracted_text` fallback via `read_source`.
     */
    agentSupportsDocuments?: boolean;
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

  // Step 2: Build source manifest
  const sources = await fetchSources(db, talkId);
  const agentSupportsVision = options?.agentSupportsVision ?? false;
  const agentSupportsDocuments = options?.agentSupportsDocuments ?? false;

  // Auto-attach selection for PDFs: most-recently-updated source under
  // the per-source size cap, capped at N=1. @-ref bypass merges in
  // additional rows below (force-attached can exceed N=1, never the
  // per-source size cap).
  const eligiblePdfSources = sources
    .filter(isPdfSource)
    .filter((row) => rowFileSizeBytes(row) <= MAX_PDF_DOCUMENT_BYTES)
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  const autoAttachedPdfRefs = new Set<string>(
    agentSupportsDocuments
      ? eligiblePdfSources
          .slice(0, MAX_AUTO_ATTACH_PDF_COUNT)
          .map((row) => row.source_ref)
      : [],
  );

  // Step 2a: Resolve `@-ref` mentions in the latest user message into a
  // pre-fetched injection block. Must happen BEFORE history budgeting so
  // the injected bytes are counted against the model context window —
  // otherwise a 40 KB injection silently steals history slots. The
  // executor prefixes this block onto the user-role message (not the
  // system prompt) so source content stays in the user-authority lane.
  //
  // For PDFs specifically: when the agent supports native PDF documents,
  // the @-ref resolver hands the source off to `contextDocumentSources`
  // (force-attached) instead of inlining text. The non-doc path falls
  // back to the existing text-fenced injection.
  const userMessageText = options?.retrievalQuery ?? '';
  const { refs: forcedInjectionRefs, slugs: forcedInjectionSlugs } =
    extractSourceReferences(userMessageText);
  const atRefResult = await buildAtRefForcedInjection(
    db,
    talkId,
    forcedInjectionRefs,
    forcedInjectionSlugs,
    {
      agentSupportsDocuments,
      perSourceMaxBytes: MAX_PDF_DOCUMENT_BYTES,
    },
  );
  const forcedInjectionText = atRefResult.text;
  const forcedAttachedPdfRefs = new Set(
    atRefResult.forcedPdfDocuments.map((row) => row.source_ref),
  );
  const forcedInjectionTokens = forcedInjectionText
    ? Math.ceil(forcedInjectionText.length * CHARS_TO_TOKENS)
    : 0;
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
          fileSize: rowFileSizeBytes(row),
        }))
    : [];

  // Dedupe by source_ref; force-attached wins over auto-selection so
  // the executor only loads each PDF once. Forced refs append after
  // auto refs to preserve the user's explicit ordering in the @-ref
  // list (auto-attached PDF first, then any extra @-refs).
  const contextDocumentSources: ContextDocumentSourceRef[] =
    agentSupportsDocuments
      ? (() => {
          const out: ContextDocumentSourceRef[] = [];
          const seen = new Set<string>();
          for (const row of eligiblePdfSources) {
            if (!autoAttachedPdfRefs.has(row.source_ref)) continue;
            if (forcedAttachedPdfRefs.has(row.source_ref)) continue;
            out.push(toContextDocumentSourceRef(row, false));
            seen.add(row.source_ref);
          }
          for (const row of atRefResult.forcedPdfDocuments) {
            if (seen.has(row.source_ref)) continue;
            out.push(toContextDocumentSourceRef(row, true));
            seen.add(row.source_ref);
          }
          return out;
        })()
      : [];

  const pdfManifestState: PdfManifestState = {
    agentSupportsDocuments,
    autoAttachedRefs: autoAttachedPdfRefs,
    forceAttachedRefs: forcedAttachedPdfRefs,
  };
  const sourceLines = buildSourceManifest(
    sources,
    agentSupportsVision,
    pdfManifestState,
  );
  const retrievedContext = buildRetrievedContext({
    query: options?.retrievalQuery ?? null,
    personaRole,
    stateEntries,
    sources,
    excludedStateKeys: new Set(
      stateSnapshot.includedEntries.map((entry) => entry.key),
    ),
    // Sources are never inlined into the system prompt anymore — every
    // source is read-on-demand via `read_source(ref)`. Pass an empty
    // exclusion set so buildRetrievedContext sees the full source list
    // (though its source-retrieval path is now a no-op too).
    excludedSourceRefs: new Set<string>(),
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

  // Content document: outline + apply_content_edit tool are gated on
  // the Talk actually having an attached doc. One per Talk by schema,
  // so this is at most one row.
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
    TOOL_SCHEMA_RESERVE -
    forcedInjectionTokens;
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
    systemPromptTokens +
    historyTokens +
    TOOL_SCHEMA_RESERVE +
    forcedInjectionTokens;

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
      // No sources are inlined in the index-only manifest; the inline
      // array is kept for snapshot-shape backwards compatibility but is
      // always empty.
      inline: [],
      forcedInjection: {
        refs: forcedInjectionRefs,
        slugs: forcedInjectionSlugs,
        bytes: forcedInjectionText
          ? new TextEncoder().encode(forcedInjectionText).byteLength
          : 0,
      },
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
    contextDocumentSources,
    forcedInjectionText,
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

export interface SourceRow {
  id: string;
  source_ref: string;
  source_type: string;
  title: string;
  title_slug: string | null;
  note: string | null;
  source_url: string | null;
  file_name: string | null;
  file_size: number | string | null;
  mime_type: string | null;
  storage_key: string | null;
  extracted_text: string | null;
  status: string;
  updated_at: string;
}

async function fetchSources(db: Sql, talkId: string): Promise<SourceRow[]> {
  return await db<SourceRow[]>`
    select
      id,
      source_ref,
      source_type,
      title,
      title_slug,
      note,
      source_url,
      file_name,
      file_size,
      mime_type,
      storage_key,
      extracted_text,
      status,
      updated_at
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

function isPdfSource(row: SourceRow): boolean {
  return (
    row.source_type === 'file' &&
    row.mime_type === 'application/pdf' &&
    !!row.storage_key
  );
}

function rowFileSizeBytes(row: SourceRow): number {
  if (typeof row.file_size === 'string') return Number(row.file_size) || 0;
  return row.file_size ?? 0;
}

interface PdfRowLike {
  id: string;
  source_ref: string;
  title: string;
  file_name: string | null;
  mime_type: string | null;
  storage_key: string | null;
  file_size: number | string | null;
}

function toContextDocumentSourceRef(
  row: PdfRowLike,
  forceAttached: boolean,
): ContextDocumentSourceRef {
  const fileSize =
    typeof row.file_size === 'string'
      ? Number(row.file_size) || 0
      : (row.file_size ?? 0);
  return {
    ref: row.source_ref,
    id: row.id,
    title: row.title,
    fileName: row.file_name ?? `${row.source_ref}.pdf`,
    mimeType: row.mime_type!,
    storageKey: row.storage_key!,
    fileSize,
    forceAttached,
  };
}

export interface PdfManifestState {
  agentSupportsDocuments: boolean;
  autoAttachedRefs: Set<string>;
  forceAttachedRefs: Set<string>;
}

export function buildSourceManifest(
  sources: SourceRow[],
  agentSupportsVision: boolean,
  pdfState: PdfManifestState = {
    agentSupportsDocuments: false,
    autoAttachedRefs: new Set(),
    forceAttachedRefs: new Set(),
  },
): Array<{
  ref: string;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  fileName: string | null;
  line: string;
}> {
  return sources.map((source) => {
    const ref = source.source_ref;

    // Image sources: render with vision-aware suffix; no preview (the
    // text is binary).
    if (isImageSource(source)) {
      const fileLabel = source.file_name ? ` ${source.file_name}` : '';
      const suffix = agentSupportsVision
        ? ` (image —${fileLabel}; attached to this turn)`
        : ` (image —${fileLabel}; hidden, this agent's model lacks vision)`;
      return {
        ref,
        title: source.title,
        sourceType: source.source_type,
        sourceUrl: source.source_url,
        fileName: source.file_name,
        line: `[${ref}] ${source.title}${suffix}`,
      };
    }

    // PDF sources: render with document-aware suffix when the agent
    // supports native PDF input. Vision-doc capable agents see the
    // PDF as both text preview AND a native attached document (auto
    // or @-ref); non-doc-capable agents only see the text preview
    // and can call `read_source(ref)` for full extracted text.
    if (isPdfSource(source)) {
      const sizeBytes = rowFileSizeBytes(source);
      const tooBig = sizeBytes > MAX_PDF_DOCUMENT_BYTES;
      let suffix: string;
      if (!pdfState.agentSupportsDocuments) {
        suffix =
          " (PDF — text-only, this agent's model lacks PDF document vision)";
      } else if (tooBig) {
        suffix = ` (PDF — too large to attach as document, > ${Math.floor(
          MAX_PDF_DOCUMENT_BYTES / (1024 * 1024),
        )} MB; text preview only)`;
      } else if (pdfState.forceAttachedRefs.has(ref)) {
        suffix = ' (PDF — pages attached to this turn via @-ref)';
      } else if (pdfState.autoAttachedRefs.has(ref)) {
        suffix = ' (PDF — pages attached to this turn)';
      } else {
        suffix = ` (PDF — text-only this turn; @${ref} to attach pages)`;
      }

      const parts: string[] = [`[${ref}] ${source.title}${suffix}`];
      if (source.note && source.note.trim().length > 0) {
        parts[0] += ` — note: ${source.note.trim()}`;
      }
      const preview = buildSourcePreview(source.extracted_text);
      if (preview) {
        parts.push(`preview: "${preview}"`);
      } else if (source.extracted_text === null) {
        parts.push(
          '(text extraction failed; native PDF attach still available)',
        );
      }
      return {
        ref,
        title: source.title,
        sourceType: source.source_type,
        sourceUrl: source.source_url,
        fileName: source.file_name,
        line: parts.join(' — '),
      };
    }

    // Index-only manifest line:
    //   [S1] Title (note text) — url-or-filename — preview: "first 200 chars…"
    // The note and locator and preview clauses are each omitted when empty.
    const parts: string[] = [`[${ref}] ${source.title}`];
    if (source.note && source.note.trim().length > 0) {
      parts[0] += ` (${source.note.trim()})`;
    }
    if (source.source_type === 'url' && source.source_url) {
      parts.push(source.source_url);
    } else if (source.source_type === 'file' && source.file_name) {
      parts.push(source.file_name);
    }
    const preview = buildSourcePreview(source.extracted_text);
    if (preview) {
      parts.push(`preview: "${preview}"`);
    } else if (source.source_type !== 'text' || !source.extracted_text) {
      parts.push('(content not yet available)');
    }

    return {
      ref,
      title: source.title,
      sourceType: source.source_type,
      sourceUrl: source.source_url,
      fileName: source.file_name,
      line: parts.join(' — '),
    };
  });
}

const SOURCE_PREVIEW_MAX_CHARS = 200;

/**
 * Build a one-line preview from the head of `extracted_text` for the
 * source manifest. Collapses whitespace, strips control characters and
 * backticks, then truncates to 200 chars with an ellipsis. Returns null
 * when there's nothing to preview.
 */
export function buildSourcePreview(
  extractedText: string | null,
): string | null {
  if (!extractedText) return null;
  let cleaned = '';
  for (let i = 0; i < extractedText.length; i++) {
    const code = extractedText.charCodeAt(i);
    // Collapse all whitespace (newlines, tabs, etc.) to single spaces.
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== ' ') {
        cleaned += ' ';
      }
      continue;
    }
    // Drop other control chars + DEL.
    if (code < 0x20 || code === 0x7f) continue;
    // Escape backticks so the preview can't break out of a code fence.
    if (code === 0x60) {
      cleaned += "'";
      continue;
    }
    cleaned += extractedText[i];
    if (cleaned.length >= SOURCE_PREVIEW_MAX_CHARS + 1) break;
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > SOURCE_PREVIEW_MAX_CHARS) {
    cleaned = cleaned.slice(0, SOURCE_PREVIEW_MAX_CHARS).trimEnd() + '…';
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// `@-ref` Forced Injection
// ---------------------------------------------------------------------------

// 40 KB total budget for the forced-injection block. Overflow drops
// newest resolutions and emits a truncation footer.
const FORCED_INJECTION_BUDGET_BYTES = 40 * 1024;

// Reserve ~96 bytes inside the budget so the truncation footer always
// fits if we end up emitting one.
const FORCED_INJECTION_FOOTER_RESERVE_BYTES = 96;

export interface AtRefCandidateRow {
  source_ref: string;
  title: string;
  title_slug: string | null;
  status: string;
  extracted_text: string | null;
  mime_type: string | null;
  storage_key: string | null;
  file_size: number | string | null;
  file_name: string | null;
  id: string;
  source_type: string;
  source_url: string | null;
  updated_at: string;
}

type ForcedInjectionResolution =
  | { kind: 'resolved'; sourceRef: string; title: string; content: string }
  | { kind: 'pending'; sourceRef: string; title: string }
  | {
      /**
       * PDF row force-attached as a native document block. The text
       * payload omitted; manifest note in the prompt explains the
       * pages-attached-this-turn behavior. Carried back via the
       * `forcedPdfDocuments` array so the executor can hydrate.
       */
      kind: 'pdf-document';
      sourceRef: string;
      title: string;
      row: AtRefCandidateRow;
    }
  | {
      /**
       * PDF row that would have been force-attached but exceeds the
       * per-source size cap. Fall through to text injection if the row
       * has extracted_text; otherwise emit a pending note.
       */
      kind: 'pdf-too-large';
      sourceRef: string;
      title: string;
      maxBytes: number;
      fallbackText: string | null;
    }
  | { kind: 'missing-ref'; requestedRef: string }
  | { kind: 'missing-slug'; requestedSlug: string }
  | { kind: 'ambiguous-slug'; requestedSlug: string; readyRefs: string[] };

function renderForcedInjectionResolution(
  res: ForcedInjectionResolution,
): string {
  switch (res.kind) {
    case 'resolved':
      return [
        `[${res.sourceRef}] ${res.title}`,
        '<<<source',
        sanitizeBlockForPrompt(res.content),
        'source>>>',
      ].join('\n');
    case 'pending':
      return `[${res.sourceRef}] ${res.title} (content not yet available)`;
    case 'pdf-document':
      return `[${res.sourceRef}] ${res.title} (PDF — pages attached to this turn via @-ref; native document block carries the visual layout, charts, and full text)`;
    case 'pdf-too-large': {
      const mb = Math.floor(res.maxBytes / (1024 * 1024));
      if (res.fallbackText) {
        return [
          `[${res.sourceRef}] ${res.title} (PDF — exceeds ${mb} MB attach cap; text fallback below)`,
          '<<<source',
          sanitizeBlockForPrompt(res.fallbackText),
          'source>>>',
        ].join('\n');
      }
      return `[${res.sourceRef}] ${res.title} (PDF — exceeds ${mb} MB attach cap; no text available)`;
    }
    case 'missing-ref':
      return `[${res.requestedRef}] (no such source)`;
    case 'missing-slug':
      return `[@${res.requestedSlug}] (no such source)`;
    case 'ambiguous-slug':
      return `[@${res.requestedSlug}] (ambiguous slug — multiple sources match: ${res.readyRefs.join(
        ', ',
      )}. Use the @S<n> form instead.)`;
  }
}

interface AtRefResolveOptions {
  agentSupportsDocuments?: boolean;
  perSourceMaxBytes?: number;
}

function rowIsPdfWithStorage(row: AtRefCandidateRow): boolean {
  return (
    row.source_type === 'file' &&
    row.mime_type === 'application/pdf' &&
    !!row.storage_key
  );
}

function rowFileSizeBytesAt(row: AtRefCandidateRow): number {
  if (typeof row.file_size === 'string') return Number(row.file_size) || 0;
  return row.file_size ?? 0;
}

function resolveSingleRowForRef(
  row: AtRefCandidateRow,
  options: AtRefResolveOptions,
): ForcedInjectionResolution {
  // PDF + agent supports docs → emit pdf-document resolution. Size cap
  // still enforced; oversize PDFs fall back to text injection if
  // extracted_text exists, else a pending note.
  if (options.agentSupportsDocuments && rowIsPdfWithStorage(row)) {
    const sizeBytes = rowFileSizeBytesAt(row);
    const cap = options.perSourceMaxBytes ?? MAX_PDF_DOCUMENT_BYTES;
    if (sizeBytes > cap) {
      return {
        kind: 'pdf-too-large',
        sourceRef: row.source_ref,
        title: row.title,
        maxBytes: cap,
        fallbackText: row.extracted_text,
      };
    }
    return {
      kind: 'pdf-document',
      sourceRef: row.source_ref,
      title: row.title,
      row,
    };
  }

  if (row.status !== 'ready' || !row.extracted_text) {
    return {
      kind: 'pending',
      sourceRef: row.source_ref,
      title: row.title,
    };
  }
  return {
    kind: 'resolved',
    sourceRef: row.source_ref,
    title: row.title,
    content: row.extracted_text,
  };
}

function resolveAtRefRequests(
  rows: AtRefCandidateRow[],
  refs: string[],
  slugs: string[],
  options: AtRefResolveOptions = {},
): ForcedInjectionResolution[] {
  const byRef = new Map<string, AtRefCandidateRow>();
  const bySlug = new Map<string, AtRefCandidateRow[]>();
  for (const row of rows) {
    byRef.set(row.source_ref, row);
    if (row.title_slug) {
      const list = bySlug.get(row.title_slug) ?? [];
      list.push(row);
      bySlug.set(row.title_slug, list);
    }
  }

  const claimedRefs = new Set<string>();
  const resolutions: ForcedInjectionResolution[] = [];

  for (const ref of refs) {
    if (claimedRefs.has(ref)) continue;
    const row = byRef.get(ref);
    if (!row) {
      resolutions.push({ kind: 'missing-ref', requestedRef: ref });
      continue;
    }
    claimedRefs.add(row.source_ref);
    resolutions.push(resolveSingleRowForRef(row, options));
  }

  for (const slug of slugs) {
    const matches = bySlug.get(slug) ?? [];
    if (matches.length === 0) {
      resolutions.push({ kind: 'missing-slug', requestedSlug: slug });
      continue;
    }
    // PDF rows with native-doc support don't need extracted_text to
    // "be ready"; the document block carries the content. For non-PDF
    // (and non-doc-capable) paths keep the prior text-readiness check.
    const ready = matches.filter((m) => {
      if (options.agentSupportsDocuments && rowIsPdfWithStorage(m)) {
        return m.status === 'ready';
      }
      return m.status === 'ready' && m.extracted_text;
    });
    if (ready.length > 1) {
      resolutions.push({
        kind: 'ambiguous-slug',
        requestedSlug: slug,
        readyRefs: ready.map((m) => m.source_ref).sort(),
      });
      continue;
    }
    if (ready.length === 0) {
      const first = matches[0];
      if (claimedRefs.has(first.source_ref)) continue;
      claimedRefs.add(first.source_ref);
      resolutions.push({
        kind: 'pending',
        sourceRef: first.source_ref,
        title: first.title,
      });
      continue;
    }
    const row = ready[0];
    if (claimedRefs.has(row.source_ref)) continue;
    claimedRefs.add(row.source_ref);
    resolutions.push(resolveSingleRowForRef(row, options));
  }

  return resolutions;
}

export interface AtRefForcedInjectionResult {
  /**
   * The rendered text block to prepend to the user-role message.
   * Null when no resolutions were emitted (no refs/slugs, or all
   * resolutions were force-attached PDFs without text fallbacks).
   *
   * For force-attached PDFs (`pdf-document` kind), this string carries
   * a manifest note pointing the agent at the native document block;
   * the actual PDF bytes ride on the same user turn as a separate
   * `document` content block hydrated from `forcedPdfDocuments`.
   */
  text: string | null;
  /**
   * Source rows that should be hydrated as native document blocks on
   * the user turn. Already filtered to PDFs under the per-source size
   * cap. Caller deduplicates against the auto-attached set.
   */
  forcedPdfDocuments: AtRefCandidateRow[];
}

/**
 * Test-friendly pure variant of `buildAtRefForcedInjection`. Takes the
 * pre-loaded row set instead of an active SQL handle. Returns both the
 * rendered text block and the PDF rows that should be hydrated as
 * native document blocks.
 */
export function buildAtRefForcedInjectionFromRows(
  rows: AtRefCandidateRow[],
  refs: string[],
  slugs: string[],
  options: AtRefResolveOptions = {},
): AtRefForcedInjectionResult {
  if (refs.length === 0 && slugs.length === 0) {
    return { text: null, forcedPdfDocuments: [] };
  }
  const resolutions = resolveAtRefRequests(rows, refs, slugs, options);
  if (resolutions.length === 0) {
    return { text: null, forcedPdfDocuments: [] };
  }

  const encoder = new TextEncoder();
  const blocks: string[] = [];
  let usedBytes = 0;
  let omittedCount = 0;
  const forcedPdfDocuments: AtRefCandidateRow[] = [];

  for (let i = 0; i < resolutions.length; i++) {
    const rendered = renderForcedInjectionResolution(resolutions[i]);
    const separator = blocks.length === 0 ? '' : '\n\n';
    const sizeWithSeparator = encoder.encode(separator + rendered).byteLength;
    if (
      usedBytes + sizeWithSeparator + FORCED_INJECTION_FOOTER_RESERVE_BYTES >
      FORCED_INJECTION_BUDGET_BYTES
    ) {
      omittedCount = resolutions.length - i;
      break;
    }
    blocks.push(rendered);
    usedBytes += sizeWithSeparator;
    if (resolutions[i].kind === 'pdf-document') {
      forcedPdfDocuments.push(
        (
          resolutions[i] as Extract<
            ForcedInjectionResolution,
            { kind: 'pdf-document' }
          >
        ).row,
      );
    }
  }

  if (blocks.length === 0) {
    return { text: null, forcedPdfDocuments };
  }

  let text = blocks.join('\n\n');
  if (omittedCount > 0) {
    text += `\n\n[truncated, ${omittedCount} more @-refs omitted]`;
  }
  return { text, forcedPdfDocuments };
}

/**
 * Resolve `@-ref` mentions in the latest user message into a single
 * pre-fetched block prefixed onto the user turn. Returns null when no
 * refs/slugs are present or none could be resolved.
 *
 * Behaviors:
 * - `@S1` → exact source_ref match.
 * - `@design-notes` → title_slug match. Ambiguity (two ready rows
 *   sharing a slug) emits a manifest note and skips the injection.
 * - Missing ref/slug → "(no such source)" note.
 * - Pending / failed source → "(content not yet available)" note.
 * - Total output bounded to 40 KB; overflow emits a truncation footer.
 * - Content is run through sanitizeBlockForPrompt to neutralize
 *   prompt-injection vectors (control chars + backticks) before fencing.
 */
export async function buildAtRefForcedInjection(
  db: Sql,
  talkId: string,
  refs: string[],
  slugs: string[],
  options: AtRefResolveOptions = {},
): Promise<AtRefForcedInjectionResult> {
  if (refs.length === 0 && slugs.length === 0) {
    return { text: null, forcedPdfDocuments: [] };
  }

  const upperRefs = refs.map((r) => r.toUpperCase());
  const lowerSlugs = slugs.map((s) => s.toLowerCase());

  // Single SQL covering both ref + slug lookups, with no status filter
  // so we can emit a "(content not yet available)" note when a user
  // @-refs a still-pending URL ingest. Includes the columns the PDF
  // routing path needs (mime_type, storage_key, file_size, file_name)
  // so resolveSingleRowForRef can decide between text injection and
  // native document attach without a second query.
  const rows = await db<AtRefCandidateRow[]>`
    select
      id,
      source_ref,
      title,
      title_slug,
      status,
      extracted_text,
      mime_type,
      storage_key,
      file_size,
      file_name,
      source_type,
      source_url,
      updated_at
    from public.talk_context_sources
    where talk_id = ${talkId}::uuid
      and (
        source_ref = any(${upperRefs}::text[])
        or title_slug = any(${lowerSlugs}::text[])
      )
  `;

  return buildAtRefForcedInjectionFromRows(
    rows,
    upperRefs,
    lowerSlugs,
    options,
  );
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
 * Sanitize block content before inlining into the agent's system
 * prompt. Newlines + control characters can change the prompt's
 * structural meaning when concatenated with surrounding markdown.
 * Replace bare newlines inside the block with `\n` literals, drop
 * other control characters, and escape backticks so a single block
 * can't break out of the surrounding `code-fence` framing the agent
 * may use to address it. The agent still sees the full plain text;
 * only the prompt-injection-relevant edges are neutralized.
 */
function sanitizeBlockForPrompt(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (code === 0x0a || code === 0x09) {
      out += normalized[i];
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    out += normalized[i];
  }
  return out;
}

interface OutlineBlock {
  anchorId: string;
  kind: string;
  text: string;
}

function buildMarkdownOutlineBlocks(bodyMarkdown: string): OutlineBlock[] {
  const parsed = sanitizeRichTextDocument(markdownToTiptapJson(bodyMarkdown));
  const stamped = ensureAnchorIds(parsed);
  return (stamped.content ?? []).map((node) => {
    const anchorId = getAnchorId(node) ?? '';
    const text = sanitizeBlockForPrompt(plainTextOf(node));
    return { anchorId, kind: node.type, text };
  });
}

function buildHtmlOutlineBlocks(bodyHtml: string): OutlineBlock[] {
  if (!bodyHtml || bodyHtml.trim().length === 0) return [];
  // Re-stamp anchors before extracting so the AI always sees fresh
  // IDs — even if a recent user-edit stripped a block's attr.
  const stamped = insertAnchors(bodyHtml);
  if (!stamped.ok) return [];
  const outline = extractOutline(stamped.value);
  if (!outline.ok) return [];
  return outline.value.map((entry) => ({
    anchorId: entry.anchorId,
    kind: entry.tag,
    text: sanitizeBlockForPrompt(entry.textExcerpt),
  }));
}

/**
 * Build the outline section for the agent's system prompt.
 *
 * Each block is rendered inline as its full plain-text content,
 * prefixed with `<!-- anchor:<id> -->` so the agent can copy the
 * anchor ID verbatim into an `apply_content_edit` call. Blocks are
 * emitted in document order. If the cumulative size would exceed the
 * byte budget, truncation happens at a block boundary and a
 * `[… N more blocks omitted; ask the user to narrow scope]` footer is
 * appended.
 *
 * Format-aware: HTML docs route through `extractOutline` (after a
 * defensive `insertAnchors` re-stamp so the AI sees fresh anchors even
 * if a recent user-edit stripped some), markdown docs use the Tiptap
 * AST as before. Both formats produce the same shape of `[kind] text`
 * lines anchored by `<!-- anchor:id -->`; only the editor instructions
 * + allowed-tag/banned-tag reminders differ in the footer.
 */
export function buildContentOutline(
  content: Content,
  budgetBytes: number = CONTENT_OUTLINE_BUDGET_BYTES,
): string {
  const isHtml = content.contentFormat === 'html';

  const blocks = isHtml
    ? buildHtmlOutlineBlocks(content.bodyHtml ?? '')
    : buildMarkdownOutlineBlocks(content.bodyMarkdown);

  const headerLine = isHtml
    ? `**The Doc — this Talk's attached document:** "${content.title}" (v${content.bodyVersion}, HTML format)`
    : `**The Doc — this Talk's attached document:** "${content.title}" (v${content.bodyVersion})`;
  const header = [
    headerLine,
    '',
    'This Talk has exactly one long-form document attached, and the block listing below IS that document — full prose, in order, prefixed with the block kind and anchor ID for each. When the user says "the doc", "the document", "this doc", "summarize the doc", or anything similar, they mean THIS document. The user can also reference it explicitly with the literal token `@doc` in their message — when you see `@doc` anywhere in the latest user turn, treat it as a deterministic reference to THIS section. Do NOT look for a Google Doc binding. Do NOT search [S1]/[S2]/etc. Do NOT inspect chat attachments whose filename happens to match this title (the user often uploads a draft .md before promoting it into the doc — those are stale source material, not the live document). The blocks below are the canonical, current copy.',
  ].join('\n');

  const formatStanza = isHtml
    ? [
        '',
        '**HTML payload required for THIS doc.** This doc is HTML format — the `markdown` field of `apply_content_edit` carries HTML, not markdown. Wrap every block in real tags: paragraphs `<p>...</p>`, headings `<h1>...</h1>`–`<h6>`, lists `<ul><li>...</li></ul>` / `<ol>`, blockquotes `<blockquote>...</blockquote>`, code `<pre><code>...</code></pre>`. Plain text or markdown is rejected.',
        '',
        `Allowed tags (server allowlist): ${ALLOWED_TAGS.join(', ')}. Inline \`<style>\` blocks + CSS animations + the sanitized SVG subset are allowed. **Banned**: \`<script>\`, \`<iframe>\`, \`<form>\`, \`on*\` event handlers, \`javascript:\` URLs, \`<foreignObject>\`, \`<animate>\` SVG elements — these are stripped server-side. Use \`data-anchor-id="..."\` on the target block (copied verbatim from the listing above) to address an edit.`,
      ].join('\n')
    : '';

  const footer = [
    'To change this document, call `apply_content_edit({ kind, anchor?, markdown, rationale? })`. Your edit lands in the doc immediately as a *pending change* the user can Accept or Reject from the doc pane. There is no propose step, no card to wait on — you edit, the user reviews afterward.',
    '',
    "Pick `kind`: `'append'` to add new block(s) after `anchor` (omit `anchor` to prepend at top); `'replace'` to overwrite the single block at `anchor`; `'delete'` to remove the block at `anchor`; `'bulk'` to swap the entire body (`markdown` is the COMPLETE new doc, omit `anchor`). Anchors come verbatim from the block listing above.",
    '',
    'Call the tool as many times as you need in one turn — every edit you make this turn is grouped into one pending edit run the user accepts or rejects as a single unit. Smaller, targeted edits review better than one giant bulk; reserve bulk for when most of the doc actually changes.',
    '',
    'When `@doc` appears in the latest user turn AND the request is to change the document (add, append, extend, draft, continue, rewrite, edit, fix, polish, expand, shorten, delete, etc.), you MUST call `apply_content_edit` — do NOT write substantive new prose into chat as a workaround. Rhetorical questions count as instructions: "Can you add a summary?", "Could you fix the intro?", "Want to rewrite this section?" are all explicit edit requests.',
    '',
    'NEVER narrate your capabilities ("I can only modify through tools", "I cannot directly edit @doc", etc.). Your reply in chat for an edit request should be a single short acknowledgement after the call ("Replaced paragraph 2 and added a closing CTA — review in the doc pane.") OR a clarifying question only if the request is genuinely ambiguous.',
    formatStanza,
  ]
    .filter((s) => s.length > 0)
    .join('\n');

  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header).byteLength;
  const footerBytes = encoder.encode(`\n\n${footer}`).byteLength;
  const truncationTemplate = (n: number): string =>
    `[… ${n} more blocks omitted; ask the user to narrow scope]`;
  const maxTruncationBytes = encoder.encode(
    truncationTemplate(blocks.length),
  ).byteLength;

  let usedBytes = headerBytes + footerBytes;
  const lines: string[] = [];
  let included = 0;

  for (const block of blocks) {
    const anchorTag = `<!-- anchor:${block.anchorId} -->`;
    const kindTag = `[${block.kind}]`;
    const body = block.text.length > 0 ? block.text : '(empty block)';
    const rendered = `${anchorTag}\n${kindTag} ${body}`;
    const blockBytes = encoder.encode(`\n\n${rendered}`).byteLength;
    const remaining = blocks.length - included - 1;
    const reserveForTruncation =
      remaining > 0
        ? encoder.encode(`\n\n${truncationTemplate(remaining)}`).byteLength
        : 0;
    if (usedBytes + blockBytes + reserveForTruncation > budgetBytes) break;
    lines.push(rendered);
    usedBytes += blockBytes;
    included += 1;
  }

  const remaining = blocks.length - included;
  const truncationLine = remaining > 0 ? truncationTemplate(remaining) : null;

  const parts: string[] = [header];
  if (lines.length > 0) parts.push(lines.join('\n\n'));
  if (truncationLine) parts.push(truncationLine);
  parts.push(footer);

  // Sanity guard: respect the budget even when the header alone is
  // unusually large (long title). Trim from the bottom up.
  let assembled = parts.join('\n\n');
  if (encoder.encode(assembled).byteLength > budgetBytes && included > 0) {
    return `${header}\n\n${truncationTemplate(blocks.length)}\n\n${footer}`;
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
  retrievedContext: string | null,
  sourceLines: Array<{
    ref: string;
    title: string;
    sourceType: string;
    sourceUrl: string | null;
    fileName: string | null;
    line: string;
  }>,
  contentOutline: string | null,
  boundGoogleDriveResources: string | null,
  includeWebFreshnessStanza: boolean,
): string {
  const parts: string[] = [];

  // The Attached Document goes at the absolute top so the agent
  // anchors on it before any other context. After Rules wasn't enough
  // — Kimi 2.6 still opened with "I don't see a Google Doc" because by
  // the time it read the section, it had already pattern-matched the
  // user's "the doc" against its training-time Google-Docs prior.
  if (contentOutline) {
    parts.push(contentOutline);
  }

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

  if (roleHint) {
    parts.push(`**Role Context Hint:**\n${roleHint}`);
  }

  if (channelContextSection) {
    parts.push(`**Channel Context:**\n${channelContextSection}`);
  }

  if (stateSnapshot) {
    parts.push(stateSnapshot);
  }

  if (retrievedContext) {
    parts.push(retrievedContext);
  }

  if (sourceLines.length > 0) {
    const manifestLines = sourceLines.map((s) => s.line);
    parts.push(
      `**Sources:**\n${manifestLines.join('\n')}\n\nThe preview after each source is the first 200 chars of its extracted text. Call \`read_source(ref)\` to load the full content of a source when relevant — don't guess the rest from the title or preview.`,
    );
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
      name: 'read_source',
      description:
        'Read the full extracted text of a saved source by its stable ref (e.g. S1, S2). The Sources manifest in the system prompt gives you a one-line preview per source — call this tool when the preview suggests the source is relevant and you need its full content. Do not guess the rest from the title or preview.',
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
        hasAttachedContent: hasContent,
      }),
    );
  }

  // Content document tools — only register when this Talk has an
  // attached doc, so agents in chat-only Talks aren't tempted to call
  // them and fall into "no document" errors.
  if (hasContent) {
    tools.push({
      name: 'apply_content_edit',
      description: [
        "Edit the Talk's attached document directly. Your edit applies immediately as a *pending* change the user can Accept or Reject from the doc pane — there is no propose step, no card to wait on.",
        '',
        "Pick `kind` for the scope: `'append'` adds new block(s) AFTER `anchor` (omit `anchor` to prepend at the top); `'replace'` overwrites the single block at `anchor`; `'delete'` removes the block at `anchor`; `'bulk'` swaps the entire body (`markdown` is the COMPLETE new doc, omit `anchor`).",
        '',
        'Anchors come verbatim from THE DOC block listing in your system prompt. Call this tool as many times as you need in one turn — every edit you make this turn is grouped into one pending edit run the user accepts or rejects as a single unit. Smaller, targeted edits review better than one giant bulk; reserve bulk for when most of the doc actually changes.',
        '',
        'When `@doc` appears in the latest user turn AND the request is to change the document, you MUST call this tool — do not narrate the change in chat. A brief acknowledgement after the call is fine ("Replaced paragraph 2 and added a closing CTA."); a long restatement of the edit in chat is not.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['append', 'replace', 'delete', 'bulk'],
            description:
              "Edit scope. 'append' = add new block(s) after `anchor` (or at top if omitted). 'replace' = overwrite the block at `anchor`. 'delete' = remove the block at `anchor`. 'bulk' = replace the entire body with `markdown` (omit `anchor`).",
          },
          anchor: {
            // Single-string type (not the JSON Schema array form
            // `['string', 'null']`) — NVIDIA NIM's Python backend
            // crashes with `unhashable type: 'list'` when it tries
            // to cache schemas containing array-of-types.
            type: 'string',
            description:
              "Anchor ID of the target block, copied verbatim from THE DOC block listing. For 'append': insert AFTER this block (omit to prepend at top). For 'replace'/'delete': the block to act on. Omit for 'bulk'.",
          },
          markdown: {
            type: 'string',
            description:
              "For 'append'/'replace': the new block(s) as GitHub-flavored markdown. For 'bulk': the COMPLETE new document body. For 'delete': omit.",
          },
          rationale: {
            type: 'string',
            description:
              'Optional one-line note shown in the edit-run banner so the user knows why you made this edit.',
          },
        },
        required: ['kind'],
      },
    });
  }

  return tools;
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

  // Keyword-RAG over sources is disabled. The index-only manifest carries
  // a per-source preview; full content is fetched via `read_source(ref)`
  // on demand. State retrieval below is unchanged.
  const sourceCandidates: TalkRunContextRetrievedSourceSnapshot[] = [];

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

  // Source retrieval loop intentionally removed — sourceCandidates is
  // always empty in the index-only world.

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
