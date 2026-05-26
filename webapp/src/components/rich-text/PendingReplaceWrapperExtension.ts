// Decorative Tiptap node that renders a pending-replace edit as
// "prior (struck-through gray) above new (red)" inline. The shared
// composer in src/shared/rich-text/content-edits-ops.ts emits this
// node type in its annotated output — this extension teaches the
// editor how to parse + render it.
//
// Important: this node is RENDER-ONLY. It never ships back to the
// server (the markdown serializer doesn't know about it). When the
// pending edit is accepted or rejected, the entire wrapper disappears
// on the next render — the editor receives a fresh composed doc that
// either contains the new block (accept) or the original (reject).

import { Node, mergeAttributes } from '@tiptap/core';

import {
  ANCHOR_ATTR_KEY,
  PENDING_EDIT_ID_ATTR,
  PENDING_KIND_ATTR,
  PENDING_REPLACE_WRAPPER_TYPE,
} from '../../../../src/shared/rich-text/index.js';

export const PendingReplaceWrapperExtension = Node.create({
  name: PENDING_REPLACE_WRAPPER_TYPE,
  group: 'block',
  // Children: the prior block (non-editable) followed by the new
  // block(s) (editable). Use the catch-all block+ so any block-level
  // node type can sit inside without re-listing each one.
  content: 'block+',
  defining: true,
  isolating: false,

  addAttributes() {
    return {
      [PENDING_EDIT_ID_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-pending-edit-id'),
        renderHTML: (attrs) => {
          const v = attrs[PENDING_EDIT_ID_ATTR];
          if (typeof v !== 'string' || v.length === 0) return {};
          return { 'data-pending-edit-id': v };
        },
      },
      [PENDING_KIND_ATTR]: {
        default: 'replace',
        parseHTML: (el) => el.getAttribute('data-pending-kind') ?? 'replace',
        renderHTML: (attrs) => {
          const v = attrs[PENDING_KIND_ATTR];
          if (typeof v !== 'string' || v.length === 0) return {};
          return { 'data-pending-kind': v };
        },
      },
      [ANCHOR_ATTR_KEY]: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-anchor-id'),
        renderHTML: (attrs) => {
          const v = attrs[ANCHOR_ATTR_KEY];
          if (typeof v !== 'string' || v.length === 0) return {};
          return { 'data-anchor-id': v };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[data-node-type="${PENDING_REPLACE_WRAPPER_TYPE}"]`,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-node-type': PENDING_REPLACE_WRAPPER_TYPE,
        class: 'pending-replace-wrapper',
      }),
      0,
    ];
  },
});
