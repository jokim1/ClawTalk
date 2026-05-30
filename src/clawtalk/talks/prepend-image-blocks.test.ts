// Pure unit tests for prependImageBlocks — the shared block-injection
// helper extracted in the PDF page-rasterization DRY refactor (T8). Both
// the Talk-context image-source injector and the new PDF-page-image
// injector build a flat block list and hand it to this helper, so the
// "[header, ...blocks, ...base]" shape (and the empty-passthrough) is the
// single behavior that must stay stable. No DB / R2 — runs anywhere.

import { describe, expect, it } from 'vitest';

import { prependImageBlocks } from './new-executor.js';
import type { LlmContentBlock } from '../agents/llm-client.js';

const HEADER = 'Talk-level Context images:';

function imageBlock(data: string): LlmContentBlock {
  return { type: 'image', mimeType: 'image/jpeg', data, detail: 'auto' };
}

describe('prependImageBlocks', () => {
  it('returns the base unchanged when there are no blocks (no empty header)', () => {
    const stringBase = 'hello';
    expect(prependImageBlocks(stringBase, [], HEADER)).toBe(stringBase);

    const arrayBase: LlmContentBlock[] = [{ type: 'text', text: 'hi' }];
    expect(prependImageBlocks(arrayBase, [], HEADER)).toBe(arrayBase);
  });

  it('wraps a string base as [header, ...blocks, text(base)]', () => {
    const blocks = [imageBlock('aaa'), imageBlock('bbb')];
    const result = prependImageBlocks('user text', blocks, HEADER);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as LlmContentBlock[];
    expect(arr[0]).toEqual({ type: 'text', text: HEADER });
    expect(arr.slice(1, 3)).toEqual(blocks);
    expect(arr[arr.length - 1]).toEqual({ type: 'text', text: 'user text' });
  });

  it('prepends [header, ...blocks] in front of an existing block array', () => {
    const existing: LlmContentBlock[] = [{ type: 'text', text: 'tail' }];
    const blocks = [imageBlock('zzz')];
    const result = prependImageBlocks(
      existing,
      blocks,
      HEADER,
    ) as LlmContentBlock[];
    expect(result[0]).toEqual({ type: 'text', text: HEADER });
    expect(result[1]).toEqual(blocks[0]);
    expect(result[2]).toEqual(existing[0]);
    expect(result).toHaveLength(3);
  });

  it('preserves block order exactly (label/image pairs survive)', () => {
    const blocks: LlmContentBlock[] = [
      { type: 'text', text: 'page 1:' },
      imageBlock('p1'),
      { type: 'text', text: 'page 2:' },
      imageBlock('p2'),
    ];
    const result = prependImageBlocks('q', blocks, HEADER) as LlmContentBlock[];
    expect(result.slice(1, 5)).toEqual(blocks);
  });
});
