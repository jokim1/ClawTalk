// Tests for the ContentImageUploaderPlugin state machine.
//
// Covers the pure helpers + the appendTransaction sweep-legitimacy
// guarantee + each state.apply meta transition (incl. idempotent
// no-op). The view-level promotion loop and AbortController teardown
// run in a real browser/jsdom — they're exercised in the worker-app
// integration but not unit-tested here.

import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Fragment, Schema, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  _internal,
  ContentImageUploaderExtension,
  contentImageUploaderKey,
} from './ContentImageUploaderPlugin';

let activeEditor: Editor | null = null;

function makeEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Image.configure({ inline: true, allowBase64: true }),
      ContentImageUploaderExtension,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
}

afterEach(() => {
  activeEditor?.destroy();
  activeEditor = null;
});

// ─── Pure-helper tests ───────────────────────────────────────────

describe('_internal.freshUploadId', () => {
  it('returns 12 hex chars', () => {
    for (let i = 0; i < 20; i++) {
      expect(_internal.freshUploadId()).toMatch(/^[a-f0-9]{12}$/);
    }
  });

  it('produces distinct IDs on each call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(_internal.freshUploadId());
    expect(seen.size).toBe(50);
  });
});

describe('_internal.rewritePasteSliceImages', () => {
  function imageSchema(): Schema {
    return new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: {
          group: 'block',
          content: 'inline*',
          toDOM: () => ['p', 0],
        },
        text: { group: 'inline' },
        image: {
          group: 'inline',
          inline: true,
          attrs: { src: { default: '' } },
          toDOM: (node) => ['img', { src: node.attrs.src }],
        },
      },
    });
  }

  it('rewrites every image src to include a fresh #cu-<uploadId> marker', () => {
    const schema = imageSchema();
    const slice = new Slice(
      Fragment.from([
        schema.nodes.paragraph.create(null, [
          schema.nodes.image.create({ src: 'https://example.com/a.png' }),
          schema.nodes.image.create({ src: 'data:image/png;base64,AAAA' }),
        ]),
      ]),
      0,
      0,
    );
    const queue: Array<{ uploadId: string; originalSrc: string }> = [];
    const result = _internal.rewritePasteSliceImages(slice, queue);
    const images: string[] = [];
    result.content.descendants((node) => {
      if (node.type.name === 'image') images.push(node.attrs.src);
    });
    expect(images).toHaveLength(2);
    expect(images[0]).toMatch(
      /^https:\/\/example\.com\/a\.png#cu-[a-f0-9]{12}$/,
    );
    expect(images[1]).toMatch(/^data:image\/png;base64,AAAA#cu-[a-f0-9]{12}$/);
    expect(queue).toHaveLength(2);
    expect(queue[0].originalSrc).toBe('https://example.com/a.png');
    expect(queue[1].originalSrc).toBe('data:image/png;base64,AAAA');
  });

  it('does NOT re-rewrite images that already carry a marker', () => {
    const schema = imageSchema();
    const slice = new Slice(
      Fragment.from([
        schema.nodes.paragraph.create(null, [
          schema.nodes.image.create({
            src: 'https://example.com/a.png#cu-aaaaaaaaaaaa',
          }),
        ]),
      ]),
      0,
      0,
    );
    const queue: Array<{ uploadId: string; originalSrc: string }> = [];
    const result = _internal.rewritePasteSliceImages(slice, queue);
    expect(queue).toHaveLength(0);
    expect(result).toBe(slice);
  });

  it('returns the input slice unchanged when there are no images', () => {
    const schema = imageSchema();
    const slice = new Slice(
      Fragment.from([
        schema.nodes.paragraph.create(null, [schema.text('hello')]),
      ]),
      0,
      0,
    );
    const queue: Array<{ uploadId: string; originalSrc: string }> = [];
    expect(_internal.rewritePasteSliceImages(slice, queue)).toBe(slice);
    expect(queue).toHaveLength(0);
  });
});

// ─── State integration tests ─────────────────────────────────────

function getState(editor: Editor) {
  const s = contentImageUploaderKey.getState(editor.state);
  if (!s) throw new Error('plugin state missing');
  return s;
}

function imageNode(editor: Editor, src: string) {
  const imageType = editor.schema.nodes['image'];
  if (!imageType) throw new Error('image node type missing');
  return imageType.create({ src });
}

describe('state.apply meta transitions', () => {
  it('pending-added inserts entries with status=queued', () => {
    activeEditor = makeEditor();
    const tr = activeEditor.state.tr.setMeta(contentImageUploaderKey, {
      kind: 'pending-added',
      entries: [
        { uploadId: 'aaaaaaaaaaaa', originalSrc: 'https://example.com/x.png' },
        { uploadId: 'bbbbbbbbbbbb', originalSrc: 'data:image/png;base64,AAA' },
      ],
    });
    activeEditor.view.dispatch(tr);
    const state = getState(activeEditor);
    expect(state.pending.size).toBe(2);
    expect(state.pending.get('aaaaaaaaaaaa')?.status).toBe('queued');
    expect(state.pending.get('aaaaaaaaaaaa')?.originalSrc).toBe(
      'https://example.com/x.png',
    );
  });

  it('pending-resolved removes the entry', () => {
    activeEditor = makeEditor();
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'pending-added',
        entries: [{ uploadId: 'aaaaaaaaaaaa', originalSrc: 'https://x/a.png' }],
      }),
    );
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'pending-resolved',
        uploadId: 'aaaaaaaaaaaa',
      }),
    );
    expect(getState(activeEditor).pending.has('aaaaaaaaaaaa')).toBe(false);
  });

  it('pending-failed flips status to failed (entry stays)', () => {
    activeEditor = makeEditor();
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'pending-added',
        entries: [{ uploadId: 'aaaaaaaaaaaa', originalSrc: 'https://x/a.png' }],
      }),
    );
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'pending-failed',
        uploadId: 'aaaaaaaaaaaa',
      }),
    );
    const entry = getState(activeEditor).pending.get('aaaaaaaaaaaa');
    expect(entry?.status).toBe('failed');
    expect(entry?.originalSrc).toBe('https://x/a.png');
  });

  it('pending-failed is a no-op if entry was already removed', () => {
    activeEditor = makeEditor();
    // Dispatch pending-failed for an id that was never added.
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'pending-failed',
        uploadId: 'zzzzzzzzzzzz',
      }),
    );
    expect(getState(activeEditor).pending.size).toBe(0);
  });

  it('pending-resolved is a no-op if entry was already removed', () => {
    activeEditor = makeEditor();
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'pending-resolved',
        uploadId: 'zzzzzzzzzzzz',
      }),
    );
    expect(getState(activeEditor).pending.size).toBe(0);
  });

  it('swept meta flips the swept flag', () => {
    activeEditor = makeEditor();
    expect(getState(activeEditor).swept).toBe(false);
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'swept',
      }),
    );
    expect(getState(activeEditor).swept).toBe(true);
  });
});

describe('appendTransaction sweep', () => {
  it('deletes a marker-bearing image whose uploadId has no pending entry', () => {
    activeEditor = makeEditor();
    // Insert an image with a #cu marker for an unknown id.
    const tr = activeEditor.state.tr;
    tr.insert(
      tr.selection.from,
      imageNode(activeEditor, 'https://x/a.png#cu-ffffffffffff'),
    );
    activeEditor.view.dispatch(tr);
    // appendTransaction should have removed it in the same dispatch cycle.
    let imgCount = 0;
    activeEditor.state.doc.descendants((n) => {
      if (n.type.name === 'image') imgCount++;
    });
    expect(imgCount).toBe(0);
  });

  it('does NOT delete an image whose uploadId is a known pending entry', () => {
    activeEditor = makeEditor();
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'pending-added',
        entries: [{ uploadId: 'aaaaaaaaaaaa', originalSrc: 'https://x/a.png' }],
      }),
    );
    const tr = activeEditor.state.tr;
    tr.insert(
      tr.selection.from,
      imageNode(activeEditor, 'https://x/a.png#cu-aaaaaaaaaaaa'),
    );
    activeEditor.view.dispatch(tr);
    let imgCount = 0;
    activeEditor.state.doc.descendants((n) => {
      if (n.type.name === 'image') imgCount++;
    });
    expect(imgCount).toBe(1);
  });

  it('leaves marker-less images alone', () => {
    activeEditor = makeEditor();
    const tr = activeEditor.state.tr;
    tr.insert(tr.selection.from, imageNode(activeEditor, 'https://x/a.png'));
    activeEditor.view.dispatch(tr);
    let found = '';
    activeEditor.state.doc.descendants((n) => {
      if (n.type.name === 'image') found = n.attrs.src;
    });
    expect(found).toBe('https://x/a.png');
  });
});

describe('findImagesByUploadId', () => {
  it('finds the image whose src ends with the matching marker', () => {
    activeEditor = makeEditor();
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(contentImageUploaderKey, {
        kind: 'pending-added',
        entries: [{ uploadId: 'aaaaaaaaaaaa', originalSrc: 'https://x/a.png' }],
      }),
    );
    const tr = activeEditor.state.tr;
    // Drop selection at end so insert lands inside the paragraph.
    tr.setSelection(TextSelection.atEnd(tr.doc));
    tr.insert(
      tr.selection.from,
      imageNode(activeEditor, 'https://x/a.png#cu-aaaaaaaaaaaa'),
    );
    activeEditor.view.dispatch(tr);
    const matches = _internal.findImagesByUploadId(
      activeEditor.state.doc,
      'aaaaaaaaaaaa',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].node.attrs.src).toBe('https://x/a.png#cu-aaaaaaaaaaaa');
  });

  it('returns empty when no image matches', () => {
    activeEditor = makeEditor();
    expect(
      _internal.findImagesByUploadId(activeEditor.state.doc, 'aaaaaaaaaaaa'),
    ).toHaveLength(0);
  });
});
