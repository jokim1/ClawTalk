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

import { getDb } from '../../db.js';
import { listConnectorsForTalkRun } from '../db/connector-accessors.js';
import { listTalkStateEntries } from '../db/context-accessors.js';
import type { EffectiveToolAccess } from '../db/agent-accessors.js';
import { listTalkOutputs } from '../db/output-accessors.js';
import {
  buildConnectorToolDefinitions,
  type ConnectorToolDefinition,
} from '../connectors/runtime.js';
import {
  type LlmToolDefinition,
  type LlmMessage,
} from '../agents/llm-client.js';
import type { TalkPersonaRole } from '../llm/types.js';
import { WEB_TOOL_DEFINITIONS } from '../tools/web-tools.js';
import { BROWSER_TOOL_DEFINITIONS } from '../tools/browser-tools.js';
import {
  buildBoundGoogleDrivePromptSection,
  buildGoogleDriveContextTools,
} from './google-drive-tools.js';
import { buildTalkOutputToolDefinitions } from './output-tools.js';
import type { TalkJobExecutionPolicy } from './executor.js';

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
  },
): Promise<ContextPackage> {
  const db = getDb();
  const personaRole = options?.personaRole ?? null;
  const roleHint = buildRoleHint(personaRole);

  // Step 1: Fetch goal, rules, state, and rolling summary
  const goal = fetchGoal(db, talkId);
  const rules = fetchRules(db, talkId);
  const stateEntries = listTalkStateEntries(talkId);

  // When loading for a specific thread, skip talk-level summary to avoid
  // leaking cross-thread context. A stale/wrong summary is worse than no
  // summary — the model still has recent thread history.
  const summary = threadId ? null : fetchSummary(db, talkId);
  const stateSnapshot = buildStateSnapshot(
    stateEntries,
    STATE_SNAPSHOT_RESERVE,
  );
  const outputManifest = buildOutputManifest(talkId);

  // Step 2: Build source manifest
  const sources = fetchSources(db, talkId);
  const sourceLines = buildSourceManifest(sources);
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
  const boundGoogleDriveResources = buildBoundGoogleDrivePromptSection(talkId);

  // Step 3: Build connector tools (currently empty stub)
  const connectorTools = buildConnectorTools(db, talkId, options?.jobPolicy);

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
    boundGoogleDriveResources,
  );
  const systemPromptTokens = Math.ceil(systemPrompt.length * CHARS_TO_TOKENS);

  // Step 5: Build context tools (always included)
  const contextTools = buildContextTools(
    talkId,
    userId,
    options?.jobPolicy,
    options?.effectiveTools,
  );

  // Step 6: Load message history with token budgeting (thread-scoped if threadId provided)
  const availableBudget =
    modelContextWindow -
    OUTPUT_RESERVE -
    systemPromptTokens -
    TOOL_SCHEMA_RESERVE;
  const historySelection = loadMessageHistory(
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
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Step 1: Fetch Goal, Rules, and Summary
// ---------------------------------------------------------------------------

function fetchGoal(db: any, talkId: string): string | null {
  const row = db
    .prepare(
      `SELECT goal_text FROM talk_context_goal WHERE talk_id = ? LIMIT 1`,
    )
    .get(talkId) as { goal_text: string } | undefined;
  return row?.goal_text ?? null;
}

function fetchRules(db: any, talkId: string): string[] {
  const rows = db
    .prepare(
      `
      SELECT rule_text
      FROM talk_context_rules
      WHERE talk_id = ? AND is_active = 1
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as Array<{ rule_text: string }>;
  return rows.map((r) => r.rule_text);
}

function fetchSummary(db: any, talkId: string): string | null {
  const row = db
    .prepare(
      `
      SELECT summary_text
      FROM talk_context_summary
      WHERE talk_id = ?
      LIMIT 1
    `,
    )
    .get(talkId) as { summary_text: string } | undefined;
  return row?.summary_text ?? null;
}

// ---------------------------------------------------------------------------
// Step 2: Build Source Manifest
// ---------------------------------------------------------------------------

interface SourceRow {
  source_ref: string;
  source_type: string;
  title: string;
  source_url: string | null;
  file_name: string | null;
  extracted_text: string | null;
  status: string;
}

function fetchSources(db: any, talkId: string): SourceRow[] {
  const rows = db
    .prepare(
      `
      SELECT
        source_ref,
        source_type,
        title,
        source_url,
        file_name,
        extracted_text,
        status
      FROM talk_context_sources
      WHERE talk_id = ? AND status = 'ready'
      ORDER BY sort_order ASC
    `,
    )
    .all(talkId) as SourceRow[];
  return rows;
}

function buildSourceManifest(sources: SourceRow[]): Array<{
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
    if (source.source_type === 'url' && source.source_url) {
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
  _db: any,
  talkId: string,
  jobPolicy?: TalkJobExecutionPolicy | null,
): LlmToolDefinition[] {
  // listConnectorsForTalkRun already filters: enabled=1, has ciphertext.
  const connectors = listConnectorsForTalkRun(talkId);
  const scopedConnectors = jobPolicy
    ? connectors.filter((connector) =>
        jobPolicy.allowedConnectorIds.includes(connector.id),
      )
    : connectors;

  // Additional runtime guard: only verified connectors produce tools.
  const verified = scopedConnectors.filter(
    (c) => c.verificationStatus === 'verified',
  );

  const defs = buildConnectorToolDefinitions(verified);
  return defs.map((def) => ({
    name: def.toolName,
    description: def.description,
    inputSchema: def.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// Step 4: Assemble System Prompt
// ---------------------------------------------------------------------------

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
  boundGoogleDriveResources: string | null,
): string {
  const parts: string[] = [];

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
): LlmToolDefinition[] {
  const tools: LlmToolDefinition[] = [
    ...buildTalkOutputToolDefinitions({
      includeWrite: jobPolicy ? jobPolicy.allowOutputWrite : true,
    }),
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
    ...buildGoogleDriveContextTools({ talkId, userId }),
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

  return tools;
}

function buildOutputManifest(talkId: string): {
  totalCount: number;
  omittedCount: number;
  included: TalkRunContextOutputManifestItem[];
  promptText: string | null;
} {
  const outputs = listTalkOutputs(talkId);
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
  metadata_json: string | null;
}

function loadMessageHistory(
  db: any,
  talkId: string,
  budgetTokens: number,
  threadId?: string | null,
  historyThroughMessageId?: string | null,
): { messages: LlmMessage[]; messageIds: string[] } {
  const cutoff = historyThroughMessageId
    ? (db
        .prepare(
          `
          SELECT id, created_at
          FROM talk_messages
          WHERE id = ? AND talk_id = ?
            AND (? IS NULL OR thread_id = ?)
          LIMIT 1
        `,
        )
        .get(
          historyThroughMessageId,
          talkId,
          threadId ?? null,
          threadId ?? null,
        ) as { id: string; created_at: string } | undefined)
    : undefined;

  // When threadId is provided, only load messages from that thread.
  // Otherwise load all messages for the Talk (legacy/pre-thread behavior).
  let rows: MessageRow[];
  if (threadId) {
    rows = db
      .prepare(
        `
        SELECT id, role, content, agent_id, created_at, metadata_json
        FROM talk_messages
        WHERE talk_id = ? AND thread_id = ?
          AND (
            ? IS NULL
            OR created_at < ?
            OR (created_at = ? AND id <= ?)
          )
        ORDER BY created_at DESC
      `,
      )
      .all(
        talkId,
        threadId,
        cutoff?.id ?? null,
        cutoff?.created_at ?? null,
        cutoff?.created_at ?? null,
        cutoff?.id ?? null,
      ) as MessageRow[];
  } else {
    rows = db
      .prepare(
        `
        SELECT id, role, content, agent_id, created_at, metadata_json
        FROM talk_messages
        WHERE talk_id = ?
          AND (
            ? IS NULL
            OR created_at < ?
            OR (created_at = ? AND id <= ?)
          )
        ORDER BY created_at DESC
      `,
      )
      .all(
        talkId,
        cutoff?.id ?? null,
        cutoff?.created_at ?? null,
        cutoff?.created_at ?? null,
        cutoff?.id ?? null,
      ) as MessageRow[];
  }

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

  // Convert to LlmMessage format
  return {
    messages: selectedRows.map((row) => ({
      role: row.role as 'user' | 'assistant' | 'system' | 'tool',
      content: row.content,
    })),
    messageIds: selectedRows.map((row) => row.id),
  };
}
