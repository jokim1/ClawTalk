// Tiptap extension that maintains stable per-block `data-anchor-id`
// attributes used by the Content feature's proposal pipeline.
//
// Three responsibilities:
//   1. Add the `dataAnchorId` global attribute to every block-level
//      node type the editor knows about, so the attribute round-trips
//      through Tiptap's HTML parse/serialize.
//   2. After any transaction that adds new block nodes (typed input,
//      paste, programmatic insert), assign fresh anchor IDs to any
//      block that doesn't have one.
//   3. When the user copy-pastes blocks *within* the editor, regen
//      the anchor IDs on the pasted blocks so they never duplicate
//      the source blocks' IDs.
//
// External round-trip caveat: HTML-comment anchors emitted by the
// markdown serializer survive Tiptap → markdown → Tiptap inside the
// app. They likely do NOT survive a user-driven copy of doc → Slack
// or Notion → paste back. On such external paste-ins the parser
// won't find anchor comments and PR 4's save path will regenerate
// fresh IDs; in the same transaction we'll mark any pending
// proposals whose `after_anchor_id` is no longer present as `stale`.
// That stale-marking is a PR 4/PR 6 concern — this extension only
// guarantees the in-editor invariant (every block has an ID, no
// duplicates after internal paste).

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Fragment, type Node as PMNode, Slice } from '@tiptap/pm/model';

import {
  ANCHOR_ATTR_KEY,
  freshAnchorId,
} from '../../../../src/shared/rich-text/index.js';

const ANCHOR_HTML_ATTR = 'data-anchor-id';

function setAnchorOnNode(node: PMNode, anchorId: string): PMNode {
  return node.type.create(
    { ...node.attrs, [ANCHOR_ATTR_KEY]: anchorId },
    node.content,
    node.marks,
  );
}

function regenerateAnchorsInFragment(fragment: Fragment): Fragment {
  const children: PMNode[] = [];
  fragment.forEach((child) => {
    if (child.type.isBlock && child.type.name !== 'doc') {
      children.push(setAnchorOnNode(child, freshAnchorId()));
    } else {
      children.push(child);
    }
  });
  return Fragment.fromArray(children);
}

function blockNodeMissingAnchor(node: PMNode): boolean {
  if (!node.type.isBlock) return false;
  if (node.type.name === 'doc') return false;
  const value = node.attrs?.[ANCHOR_ATTR_KEY];
  return typeof value !== 'string' || value.length === 0;
}

export const AnchorIdExtension = Extension.create({
  name: 'anchorId',

  addGlobalAttributes() {
    // The exact node-type list depends on which extensions the editor
    // loads. We can't introspect `this.editor.schema` at config time,
    // so we list the v1 block-level types statically. Any block type
    // not listed here won't carry an anchor — which is fine for the
    // v1 markdown subset (paragraph/heading/list/blockquote/codeBlock
    // are all included).
    return [
      {
        types: [
          'paragraph',
          'heading',
          'blockquote',
          'bulletList',
          'orderedList',
          'codeBlock',
          'horizontalRule',
        ],
        attributes: {
          [ANCHOR_ATTR_KEY]: {
            default: null,
            parseHTML: (element) => element.getAttribute(ANCHOR_HTML_ATTR),
            renderHTML: (attributes) => {
              const value = attributes[ANCHOR_ATTR_KEY];
              if (typeof value !== 'string' || value.length === 0) return {};
              return { [ANCHOR_HTML_ATTR]: value };
            },
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('anchorIdAppendTx'),
        appendTransaction: (_transactions, _oldState, newState) => {
          const tr = newState.tr;
          let modified = false;
          newState.doc.descendants((node, pos) => {
            if (!blockNodeMissingAnchor(node)) return;
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              [ANCHOR_ATTR_KEY]: freshAnchorId(),
            });
            modified = true;
          });
          return modified ? tr : null;
        },
      }),
    ];
  },

});

export function makeTransformPasted(): (slice: Slice) => Slice {
  return (slice: Slice) => {
    if (!slice.content || slice.content.childCount === 0) return slice;
    return new Slice(
      regenerateAnchorsInFragment(slice.content),
      slice.openStart,
      slice.openEnd,
    );
  };
}
