// Capability matrix tests — covers the PDF page-image fields
// (`max_images` / `accepted_image_formats`) added for the
// page-rasterization feature, plus the native-PDF vs vision-only split.

import { describe, expect, it } from 'vitest';

import { resolveModelCapabilities } from './capabilities.js';

describe('resolveModelCapabilities — PDF page-image fields', () => {
  it('gpt-5-mini is vision-but-not-PDF with a high image cap', () => {
    const caps = resolveModelCapabilities({
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
    });
    expect(caps.supports_vision).toBe(true);
    expect(caps.supports_pdf_documents).toBe(false);
    expect(caps.max_images).toBe(64);
    expect(caps.accepted_image_formats).toContain('image/jpeg');
  });

  it('gemini-2.5-flash is vision-but-not-PDF with a high image cap', () => {
    const caps = resolveModelCapabilities({
      providerId: 'provider.gemini',
      modelId: 'gemini-2.5-flash',
    });
    expect(caps.supports_vision).toBe(true);
    expect(caps.supports_pdf_documents).toBe(false);
    expect(caps.max_images).toBe(64);
    expect(caps.accepted_image_formats).toContain('image/jpeg');
  });

  it('kimi-k2.6 carries the low NVIDIA NIM image cap', () => {
    const caps = resolveModelCapabilities({
      providerId: 'provider.nvidia',
      modelId: 'moonshotai/kimi-k2.6',
    });
    expect(caps.supports_vision).toBe(true);
    expect(caps.supports_pdf_documents).toBe(false);
    // The binding constraint: Kimi via NIM caps at ~4 images/prompt.
    expect(caps.max_images).toBe(4);
    expect(caps.accepted_image_formats).toContain('image/jpeg');
    // NIM rejects WebP — it must not be advertised as accepted.
    expect(caps.accepted_image_formats).not.toContain('image/webp');
  });

  it('native-PDF models (Claude) take documents, not page images', () => {
    const caps = resolveModelCapabilities({
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-8',
    });
    expect(caps.supports_pdf_documents).toBe(true);
    // No page-image cap — these models never hit the rasterization path.
    expect(caps.max_images).toBeUndefined();
  });

  it('native-PDF models (Codex) take documents, not page images', () => {
    const caps = resolveModelCapabilities({
      providerId: 'provider.openai_codex',
      modelId: 'gpt-5.4',
    });
    expect(caps.supports_pdf_documents).toBe(true);
    expect(caps.max_images).toBeUndefined();
  });

  it('unknown models default to no vision and no image cap', () => {
    const caps = resolveModelCapabilities({
      providerId: 'provider.unknown',
      modelId: 'made-up-model',
    });
    expect(caps.supports_vision).toBe(false);
    expect(caps.supports_pdf_documents).toBe(false);
    expect(caps.max_images).toBeUndefined();
    expect(caps.accepted_image_formats).toBeUndefined();
  });
});
