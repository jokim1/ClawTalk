import { randomUUID } from 'crypto';

import { withUserContext } from '../../../db.js';
import {
  createMessageAttachment,
  getMessageAttachmentById,
  getTalkForUser,
  listTalkAttachments,
  updateAttachmentExtraction,
  type AttachmentSnapshot,
} from '../../db/index.js';
import { canEditTalk } from '../middleware/acl.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

import {
  loadAttachmentFile,
  saveAttachmentFile,
} from '../../talks/attachment-storage.js';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  ALLOWED_UPLOAD_ATTACHMENT_MIME_TYPES,
  ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_ATTACHMENT_SIZE,
  extractAttachmentText,
  inferSupportedAttachmentMimeType,
  isImageAttachmentMimeType,
} from '../../talks/attachment-extraction.js';

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

function toAttachmentResponse(
  attachment: AttachmentSnapshot,
): ApiEnvelope<{ attachment: AttachmentSnapshot }> {
  return {
    ok: true,
    data: { attachment },
  };
}

function sanitizeInlineFileName(fileName: string): string {
  const sanitized = fileName.replace(/["\r\n]/g, '').trim();
  return sanitized || 'attachment';
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/attachments
// ---------------------------------------------------------------------------

export async function uploadTalkAttachmentRoute(input: {
  auth: AuthContext;
  talkId: string;
  file: {
    name: string;
    data: Buffer;
    type: string;
  };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ attachment: AttachmentSnapshot }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');

    if (!(await canEditTalk(input.talkId))) {
      return forbiddenResponse(
        'You do not have permission to upload to this talk.',
      );
    }

    const { file } = input;
    const mimeType = inferSupportedAttachmentMimeType(file.name, file.type);

    // Validate MIME type
    if (!mimeType || !ALLOWED_UPLOAD_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      return badRequest(
        'unsupported_file_type',
        `File type "${file.type || 'unknown'}" is not supported. Allowed: ${[...ALLOWED_ATTACHMENT_MIME_TYPES, ...ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES].join(', ')}`,
      );
    }

    // Validate file size
    const maxSize = isImageAttachmentMimeType(mimeType)
      ? MAX_IMAGE_ATTACHMENT_SIZE
      : MAX_ATTACHMENT_SIZE;
    if (file.data.length > maxSize) {
      return badRequest(
        'file_too_large',
        `File exceeds maximum size of ${maxSize / (1024 * 1024)} MB`,
      );
    }

    const attachmentId = randomUUID();

    // Save raw file to disk
    const storageKey = await saveAttachmentFile(
      attachmentId,
      input.talkId,
      file.data,
      file.name,
    );

    // Create DB record
    const attachment = await createMessageAttachment({
      ownerId: input.auth.userId,
      id: attachmentId,
      talkId: input.talkId,
      fileName: file.name,
      fileSize: file.data.length,
      mimeType,
      storageKey,
      createdBy: input.auth.userId,
    });

    // Extract text synchronously for text/document files. Images skip extraction.
    if (isImageAttachmentMimeType(mimeType)) {
      await updateAttachmentExtraction({
        attachmentId,
        extractedText: null,
        extractionStatus: 'ready',
      });
    } else {
      try {
        const extractedText = await extractAttachmentText(
          file.data,
          mimeType,
          file.name,
        );
        await updateAttachmentExtraction({
          attachmentId,
          extractedText,
          extractionStatus: 'ready',
        });
      } catch (err) {
        await updateAttachmentExtraction({
          attachmentId,
          extractionError:
            err instanceof Error ? err.message : 'Unknown extraction error',
          extractionStatus: 'failed',
        });
      }
    }

    const updated = await getMessageAttachmentById(attachmentId, input.talkId);
    if (updated) {
      return {
        statusCode: 201,
        body: toAttachmentResponse({
          id: updated.id,
          messageId: updated.message_id,
          fileName: updated.file_name,
          fileSize: updated.file_size,
          mimeType: updated.mime_type,
          extractionStatus: updated.extraction_status,
          extractionError: updated.extraction_error,
          extractedTextLength: updated.extracted_text?.length ?? null,
          createdAt: updated.created_at,
        }),
      };
    }

    return {
      statusCode: 201,
      body: toAttachmentResponse(attachment),
    };
  });
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/attachments
// ---------------------------------------------------------------------------

export async function listTalkAttachmentsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ attachments: AttachmentSnapshot[] }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) return notFoundResponse('Talk not found.');

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { attachments: await listTalkAttachments(input.talkId) },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/attachments/:attachmentId/content
// ---------------------------------------------------------------------------

type AttachmentContentResult =
  | {
      statusCode: number;
      body: ApiEnvelope<never>;
    }
  | {
      statusCode: number;
      body: Buffer;
      headers: Record<string, string>;
    };

export async function getTalkAttachmentContentRoute(input: {
  auth: AuthContext;
  talkId: string;
  attachmentId: string;
}): Promise<AttachmentContentResult> {
  return await withUserContext<AttachmentContentResult>(
    input.auth.userId,
    async (): Promise<AttachmentContentResult> => {
      const talk = await getTalkForUser(input.talkId);
      if (!talk) return notFoundResponse('Talk not found.');

      const attachment = await getMessageAttachmentById(
        input.attachmentId,
        input.talkId,
      );
      if (!attachment) return notFoundResponse('Attachment not found.');

      try {
        const content = await loadAttachmentFile(attachment.storage_key);
        return {
          statusCode: 200,
          body: content,
          headers: {
            'content-type': attachment.mime_type || 'application/octet-stream',
            'content-length': String(content.byteLength),
            'cache-control': 'private, max-age=31536000, immutable',
            'content-disposition': `inline; filename="${sanitizeInlineFileName(attachment.file_name)}"`,
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return notFoundResponse('Attachment file not found.');
        }
        throw err;
      }
    },
  );
}
