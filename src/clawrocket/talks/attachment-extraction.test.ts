import { describe, expect, it } from 'vitest';

import {
  inferSupportedAttachmentMimeType,
  isImageAttachmentMimeType,
} from './attachment-extraction.js';

describe('attachment extraction MIME helpers', () => {
  it('falls back from generic MIME types to supported extensions', () => {
    expect(
      inferSupportedAttachmentMimeType('notes.txt', 'application/octet-stream'),
    ).toBe('text/plain');
    expect(
      inferSupportedAttachmentMimeType(
        'diagram.png',
        'application/octet-stream',
      ),
    ).toBe('image/png');
  });

  it('preserves already-supported MIME types', () => {
    expect(
      inferSupportedAttachmentMimeType('report.pdf', 'application/pdf'),
    ).toBe('application/pdf');
    expect(inferSupportedAttachmentMimeType('photo.jpg', 'image/jpeg')).toBe(
      'image/jpeg',
    );
  });

  it('recognizes only the image MIME types supported by the current Talk UI', () => {
    expect(isImageAttachmentMimeType('image/png')).toBe(true);
    expect(isImageAttachmentMimeType('image/jpeg')).toBe(true);
    expect(isImageAttachmentMimeType('image/webp')).toBe(true);
    expect(isImageAttachmentMimeType('image/gif')).toBe(false);
    expect(isImageAttachmentMimeType('application/pdf')).toBe(false);
  });
});
