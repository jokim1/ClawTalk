import { Editor } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANCHOR_ATTR_KEY,
  ensureAnchorIds,
} from '../../../../src/shared/rich-text/index.js';
import {
  AnchorIdExtension,
  makeTransformPasted,
} from './anchor-id-extension';

function makeEditor(): Editor {
  return new Editor({
    extensions: [StarterKit.configure({ undoRedo: false }), AnchorIdExtension],
    content: ensureAnchorIds({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    }),
  });
}

function collectBlockAnchorIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.type.isBlock || node.type.name === 'doc') return;
    const value = node.attrs?.[ANCHOR_ATTR_KEY];
    if (typeof value === 'string' && value.length > 0) {
      ids.push(value);
    } else {
      ids.push('');
    }
  });
  return ids;
}

let activeEditor: Editor | null = null;

afterEach(() => {
  activeEditor?.destroy();
  activeEditor = null;
});

describe('AnchorIdExtension', () => {
  it('preserves the anchor ID assigned to the initial paragraph', () => {
    // Initial content is pre-processed by `ensureAnchorIds` (also done
    // in production via RichTextEditor), so the extension's job for the
    // first paint is to leave existing IDs alone.
    activeEditor = makeEditor();
    const ids = collectBlockAnchorIds(activeEditor);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[a-f0-9]{12}$/i);
  });

  it('assigns anchor IDs to programmatically inserted blocks', () => {
    activeEditor = makeEditor();
    activeEditor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'two' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
      ],
    });
    const ids = collectBlockAnchorIds(activeEditor);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    ids.forEach((id) => expect(id).toMatch(/^[a-f0-9]{12}$/i));
  });

  it('preserves existing anchor IDs when content already has them', () => {
    activeEditor = makeEditor();
    activeEditor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { [ANCHOR_ATTR_KEY]: 'abc123abc123' },
          content: [{ type: 'text', text: 'preexisting' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'fresh' }] },
      ],
    });
    const ids = collectBlockAnchorIds(activeEditor);
    expect(ids[0]).toBe('abc123abc123');
    expect(ids[1]).toMatch(/^[a-f0-9]{12}$/i);
    expect(ids[1]).not.toBe('abc123abc123');
  });

  it('transformPasted regenerates anchor IDs on blocks pasted internally', () => {
    activeEditor = makeEditor();
    activeEditor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { [ANCHOR_ATTR_KEY]: 'source000000' },
          content: [{ type: 'text', text: 'original' }],
        },
      ],
    });

    const schema = activeEditor.state.schema;
    const pastedSlice = new Slice(
      schema.nodes.doc
        .create(null, [
          schema.nodes.paragraph.create(
            { [ANCHOR_ATTR_KEY]: 'source000000' },
            schema.text('pasted-copy'),
          ),
          schema.nodes.paragraph.create(
            { [ANCHOR_ATTR_KEY]: 'source111111' },
            schema.text('pasted-copy-2'),
          ),
        ])
        .content,
      0,
      0,
    );

    const transformed = makeTransformPasted()(pastedSlice);
    const regeneratedIds: string[] = [];
    transformed.content.forEach((child) => {
      const value = child.attrs?.[ANCHOR_ATTR_KEY];
      if (typeof value === 'string') regeneratedIds.push(value);
    });

    expect(regeneratedIds).toHaveLength(2);
    expect(regeneratedIds[0]).not.toBe('source000000');
    expect(regeneratedIds[1]).not.toBe('source111111');
    expect(regeneratedIds[0]).not.toBe(regeneratedIds[1]);
    regeneratedIds.forEach((id) => expect(id).toMatch(/^[a-f0-9]{12}$/i));
  });
});
