import { randomUUID } from 'crypto';

import {
  createTalkContextRule,
  createTalkContextSource,
  deleteTalkContextRule,
  deleteTalkContextSource,
  forceDeleteTalkStateEntry,
  getContextSourceStorageKey,
  getContextSourceWithContent,
  getTalkContext,
  getTalkContextSourceById,
  getTalkContextSourceCount,
  getTalkForUser,
  listTalkContextRules,
  listTalkStateEntries,
  markTalkContextSourcePending,
  patchTalkContextRule,
  patchTalkContextSource,
  setTalkGoal,
  validateStateKey,
  type ContextRuleSnapshot,
  type ContextSourceSnapshot,
  type TalkContextSnapshot,
  type TalkStateEntrySnapshot,
} from '../../db/index.js';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  extractAttachmentText,
  inferSupportedAttachmentMimeType,
  isImageAttachmentMimeType,
  MAX_ATTACHMENT_SIZE,
} from '../../talks/attachment-extraction.js';
import {
  deleteAttachmentFile,
  loadAttachmentFile,
  saveAttachmentFile,
} from '../../talks/attachment-storage.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';

type JsonMap = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbiddenResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function badRequest(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

function talkOrNull(talkId: string, userId: string) {
  return getTalkForUser(talkId, userId);
}

/** Returns a 403 response if the user cannot edit the talk; null if allowed. */
function requireEditAccess(
  talkId: string,
  auth: AuthContext,
): ReturnType<typeof forbiddenResponse> | null {
  if (!canEditTalk(talkId, auth.userId, auth.role)) {
    return forbiddenResponse('You do not have permission to edit this talk.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/context
// ---------------------------------------------------------------------------

export function getTalkContextRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<TalkContextSnapshot>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: getTalkContext(input.talkId) },
  };
}

// ---------------------------------------------------------------------------
// PUT /talks/:talkId/context/goal
// ---------------------------------------------------------------------------

export function setTalkGoalRoute(input: {
  auth: AuthContext;
  talkId: string;
  goalText: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ goal: TalkContextSnapshot['goal'] }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const text = input.goalText.replace(/[\r\n]/g, '').trim();
  if (text.length > 160) {
    return badRequest('goal_too_long', 'Goal must be 160 characters or fewer.');
  }

  const goal = setTalkGoal({
    talkId: input.talkId,
    goalText: text,
    updatedBy: input.auth.userId,
  });

  return {
    statusCode: 200,
    body: { ok: true, data: { goal } },
  };
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/context/rules
// ---------------------------------------------------------------------------

export function listTalkContextRulesRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ rules: ContextRuleSnapshot[] }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { rules: listTalkContextRules(input.talkId) } },
  };
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/state
// ---------------------------------------------------------------------------

export function getTalkStateRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ entries: TalkStateEntrySnapshot[] }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { entries: listTalkStateEntries(input.talkId) } },
  };
}

export function deleteTalkStateEntryRoute(input: {
  auth: AuthContext;
  talkId: string;
  key: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  try {
    validateStateKey(input.key);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid key.';
    return badRequest('invalid_key', message);
  }

  const deleted = forceDeleteTalkStateEntry(input.talkId, input.key);
  if (!deleted) return notFoundResponse('State entry not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/context/rules
// ---------------------------------------------------------------------------

export function createTalkContextRuleRoute(input: {
  auth: AuthContext;
  talkId: string;
  ruleText: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ rule: ContextRuleSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const text = input.ruleText.trim();
  if (!text) {
    return badRequest('rule_text_required', 'Rule text is required.');
  }
  if (text.length > 240) {
    return badRequest('rule_too_long', 'Rule must be 240 characters or fewer.');
  }

  try {
    const rule = createTalkContextRule({
      talkId: input.talkId,
      ruleText: text,
    });
    return {
      statusCode: 201,
      body: { ok: true, data: { rule } },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to create rule.';
    if (message.includes('Maximum 8 active rules')) {
      return badRequest('active_rule_limit', message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PATCH /talks/:talkId/context/rules/:ruleId
// ---------------------------------------------------------------------------

export function patchTalkContextRuleRoute(input: {
  auth: AuthContext;
  talkId: string;
  ruleId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): {
  statusCode: number;
  body: ApiEnvelope<{ rule: ContextRuleSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  if (input.ruleText !== undefined) {
    const text = input.ruleText.trim();
    if (!text)
      return badRequest('rule_text_required', 'Rule text is required.');
    if (text.length > 240)
      return badRequest(
        'rule_too_long',
        'Rule must be 240 characters or fewer.',
      );
  }

  try {
    const rule = patchTalkContextRule({
      ruleId: input.ruleId,
      talkId: input.talkId,
      ruleText: input.ruleText,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    });
    if (!rule) return notFoundResponse('Rule not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { rule } },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to update rule.';
    if (message.includes('Maximum 8 active rules')) {
      return badRequest('active_rule_limit', message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// DELETE /talks/:talkId/context/rules/:ruleId
// ---------------------------------------------------------------------------

export function deleteTalkContextRuleRoute(input: {
  auth: AuthContext;
  talkId: string;
  ruleId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const deleted = deleteTalkContextRule(input.ruleId, input.talkId);
  if (!deleted) return notFoundResponse('Rule not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/context/sources
// ---------------------------------------------------------------------------

export function createTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceType: string;
  title: string;
  note?: string | null;
  sourceUrl?: string | null;
  extractedText?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ source: ContextSourceSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const sourceType = input.sourceType;
  if (sourceType !== 'url' && sourceType !== 'text') {
    return badRequest(
      'invalid_source_type',
      'Source type must be url or text. Use the upload endpoint for files.',
    );
  }

  const title = input.title.trim();
  if (!title) {
    return badRequest('title_required', 'Source title is required.');
  }

  if (sourceType === 'url' && !input.sourceUrl?.trim()) {
    return badRequest('url_required', 'A URL is required for URL sources.');
  }

  if (sourceType === 'text' && !input.extractedText?.trim()) {
    return badRequest(
      'text_required',
      'Text content is required for text sources.',
    );
  }

  try {
    const source = createTalkContextSource({
      talkId: input.talkId,
      sourceType,
      title,
      note: input.note,
      sourceUrl: sourceType === 'url' ? input.sourceUrl : null,
      extractedText:
        sourceType === 'text' ? (input.extractedText?.trim() ?? null) : null,
      createdBy: input.auth.userId,
    });
    return {
      statusCode: 201,
      body: { ok: true, data: { source } },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to create source.';
    if (message.includes('Maximum 20')) {
      return badRequest('source_limit', message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PATCH /talks/:talkId/context/sources/:sourceId
// ---------------------------------------------------------------------------

export function patchTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ source: ContextSourceSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  if (input.title !== undefined && !input.title.trim()) {
    return badRequest('title_required', 'Source title is required.');
  }

  const source = patchTalkContextSource({
    sourceId: input.sourceId,
    talkId: input.talkId,
    title: input.title,
    note: input.note,
    sortOrder: input.sortOrder,
    extractedText: input.extractedText,
  });
  if (!source) return notFoundResponse('Source not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { source } },
  };
}

// ---------------------------------------------------------------------------
// DELETE /talks/:talkId/context/sources/:sourceId
// ---------------------------------------------------------------------------

export async function deleteTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  // Fetch storage key before deleting so we can clean up the file
  const storageKey = getContextSourceStorageKey(input.sourceId, input.talkId);

  const deleted = deleteTalkContextSource(input.sourceId, input.talkId);
  if (!deleted) return notFoundResponse('Source not found.');

  // Clean up file from disk if present
  if (storageKey) {
    await deleteAttachmentFile(storageKey);
  }

  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/context/sources/:sourceId/retry
// ---------------------------------------------------------------------------

export function retryTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ source: ContextSourceSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const existing = getTalkContextSourceById(input.sourceId, input.talkId);
  if (!existing) return notFoundResponse('Source not found.');
  if (existing.sourceType !== 'url' || !existing.sourceUrl) {
    return badRequest(
      'source_not_retryable',
      'Only URL sources can be retried.',
    );
  }

  const source = markTalkContextSourcePending(input.sourceId, input.talkId);
  if (!source) return notFoundResponse('Source not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { source } },
  };
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/context/sources/upload
// ---------------------------------------------------------------------------

export async function uploadTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  file: {
    name: string;
    data: Buffer;
    type: string;
  };
  title?: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ source: ContextSourceSnapshot }>;
}> {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  // Check source count limit
  const count = getTalkContextSourceCount(input.talkId);
  if (count >= 20) {
    return badRequest('source_limit', 'Maximum 20 saved sources per talk.');
  }

  const { file } = input;

  // MIME inference with extension fallback
  const mimeType = inferSupportedAttachmentMimeType(file.name, file.type);

  // Validate MIME type — exclude images (handled by vision work)
  if (
    !mimeType ||
    !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType) ||
    isImageAttachmentMimeType(mimeType)
  ) {
    return badRequest(
      'unsupported_file_type',
      `File type "${file.type || 'unknown'}" is not supported for context sources. Images are not accepted.`,
    );
  }

  // Validate size
  if (file.data.length > MAX_ATTACHMENT_SIZE) {
    return badRequest(
      'file_too_large',
      `File exceeds maximum size of ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB.`,
    );
  }

  const sourceId = randomUUID();

  // Save file to disk (uses attachments/ prefix for storage path)
  const storageKey = await saveAttachmentFile(
    sourceId,
    input.talkId,
    file.data,
    file.name,
  );

  // Extract text via the good pipeline
  let extractedText: string | null = null;
  let extractionError: string | null = null;
  try {
    extractedText = await extractAttachmentText(file.data, mimeType, file.name);
  } catch (err) {
    extractionError =
      err instanceof Error ? err.message : 'Unknown extraction error';
  }

  const title = input.title?.trim() || file.name;

  const source = createTalkContextSource({
    talkId: input.talkId,
    sourceType: 'file',
    title,
    fileName: file.name,
    fileSize: file.data.length,
    mimeType,
    storageKey,
    extractedText,
    extractionError,
    createdBy: input.auth.userId,
  });

  return {
    statusCode: 201,
    body: { ok: true, data: { source } },
  };
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/context/sources/:sourceId/content
// ---------------------------------------------------------------------------

export async function getTalkContextSourceContentRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceId: string;
}): Promise<
  | { statusCode: number; body: ApiEnvelope<never> }
  | {
      statusCode: number;
      body: Buffer | string;
      headers: Record<string, string>;
    }
> {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  const source = getTalkContextSourceById(input.sourceId, input.talkId);
  if (!source) return notFoundResponse('Source not found.');

  // For file sources with a storage key, serve the raw file
  const storageKey = getContextSourceStorageKey(input.sourceId, input.talkId);
  if (source.sourceType === 'file' && storageKey) {
    try {
      const content = await loadAttachmentFile(storageKey);
      return {
        statusCode: 200,
        body: content,
        headers: {
          'content-type': source.mimeType || 'application/octet-stream',
          'content-length': String(content.byteLength),
          'cache-control': 'private, max-age=31536000, immutable',
          'content-disposition': `inline; filename="${(source.fileName || 'file').replaceAll('"', '')}"`,
        },
      };
    } catch {
      return notFoundResponse('Source file not found on disk.');
    }
  }

  // For URL/text sources, return extracted text
  const full = getContextSourceWithContent(input.sourceId, input.talkId);
  if (!full?.extractedText) {
    return notFoundResponse('No content available for this source.');
  }

  return {
    statusCode: 200,
    body: full.extractedText,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(full.extractedText, 'utf-8')),
      'cache-control': 'private, no-cache',
    },
  };
}
