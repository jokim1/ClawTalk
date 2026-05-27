// ContentImageUploaderPlugin — paste an image, see it appear inline,
// have it silently swapped for a same-origin /api/v1/content-images
// URL once the upload completes.
//
// Architecture (v6 plan; clawtalk worktree feat/r2-content-image-upload):
//
//   - **State (plugin Map)**: pending uploads keyed by `uploadId` with
//     status `queued` or `failed`. Persists across view re-mounts so
//     the active-session sweep can recognise placeholder srcs.
//   - **View-local closures**: pendingPasteQueue + inFlightAborts +
//     inFlightSet + mountSweepScheduled + destroyed. These DON'T cross
//     re-mount boundaries — `in-flight` is bound to the View, not the
//     state. Persisting it would falsely signal "still uploading" after
//     the upload promise was lost to a route navigation.
//   - **transformPasted**: rewrite every <img src=…> in the paste slice
//     to `${originalSrc}#cu-${uploadId}` and push the upload metadata to
//     the queue. Stateless re: state.apply — appendTransaction drains
//     the queue and emits `pending-added` meta in the SAME tx that
//     applies the paste.
//   - **appendTransaction sweep-legitimacy**: build the set of
//     `validIdsAfterTx = oldPendingKeys ∪ drainedQueueIds` BEFORE
//     scanning for orphans, so just-drained placeholders are never
//     swept as orphans (would orphan a placeholder being added in the
//     same tx otherwise).
//   - **view.update**: mount-sweep on first run; promotion loop fires
//     up to MAX_CONCURRENT_UPLOADS = 4 uploads at a time.
//   - **destroy**: aborts every in-flight AbortController and flags
//     `destroyed=true` so post-resolution .finally chains stop early
//     instead of dispatching into a torn-down view.
//
// Coding-time nits from codex on v6 (Apr 2026):
//   1. Use `pluginKey.getState(view.state)`, not
//      `view.state.plugins.find(...)?.getState(...)`.
//   2. `.finally(() => { … })` MUST check `destroyed` before scheduling
//      promotion or setTimeout, otherwise destroyed views fire stray
//      callbacks.
//   3. Idempotent meta no-op: `pending-failed` / `pending-resolved`
//      handlers must no-op cleanly when the entry was already removed
//      by a racing transaction. Don't throw or assume entry present.

import { Extension } from '@tiptap/core';
import { Fragment, type Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import { ApiError, uploadContentImage } from '../../lib/api';
import { FAILED_ICON_SRC } from './failed-icon';

const MAX_CONCURRENT_UPLOADS = 4;

type UploadId = string;

interface Entry {
  originalSrc: string;
  status: 'queued' | 'failed';
  attemptedAt: number;
}

interface PluginState {
  pending: Map<UploadId, Entry>;
  swept: boolean;
}

interface PendingAddedMeta {
  kind: 'pending-added';
  entries: Array<{ uploadId: UploadId; originalSrc: string }>;
}
interface PendingResolvedMeta {
  kind: 'pending-resolved';
  uploadId: UploadId;
}
interface PendingFailedMeta {
  kind: 'pending-failed';
  uploadId: UploadId;
}
interface SweptMeta {
  kind: 'swept';
}
type Meta =
  | PendingAddedMeta
  | PendingResolvedMeta
  | PendingFailedMeta
  | SweptMeta;

// `#cu-<12hex>` = pending upload; `#cf-<12hex>` = failed upload.
const MARKER_RE = /#(cu|cf)-([a-f0-9]{12})$/;

export const contentImageUploaderKey = new PluginKey<PluginState>(
  'contentImageUploader',
);

export interface ContentImageUploaderOptions {
  onToast?: (message: string) => void;
}

function freshUploadId(): UploadId {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function findImagesByUploadId(
  doc: PMNode,
  uploadId: UploadId,
): Array<{ pos: number; node: PMNode }> {
  const found: Array<{ pos: number; node: PMNode }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'image') return;
    const src = node.attrs?.src ?? '';
    const m = MARKER_RE.exec(src);
    if (m && m[2] === uploadId) {
      found.push({ pos, node });
    }
  });
  return found;
}

function rewritePasteSliceImages(
  slice: Slice,
  queue: Array<{ uploadId: UploadId; originalSrc: string }>,
): Slice {
  let modified = false;

  const visit = (frag: Fragment): Fragment => {
    const children: PMNode[] = [];
    let fragModified = false;
    frag.forEach((node) => {
      if (node.type.name === 'image') {
        const src = node.attrs?.src;
        if (typeof src === 'string' && src.length > 0 && !MARKER_RE.test(src)) {
          const uploadId = freshUploadId();
          queue.push({ uploadId, originalSrc: src });
          const newNode = node.type.create(
            { ...node.attrs, src: `${src}#cu-${uploadId}` },
            node.content,
            node.marks,
          );
          children.push(newNode);
          fragModified = true;
          modified = true;
          return;
        }
      }
      if (node.content && node.content.size > 0) {
        const rewritten = visit(node.content);
        if (rewritten !== node.content) {
          children.push(node.copy(rewritten));
          fragModified = true;
          modified = true;
          return;
        }
      }
      children.push(node);
    });
    return fragModified ? Fragment.fromArray(children) : frag;
  };

  const newContent = visit(slice.content);
  return modified
    ? new Slice(newContent, slice.openStart, slice.openEnd)
    : slice;
}

// Exported for tests so we don't have to instantiate the whole plugin
// + view to exercise the paste rewrite.
export const _internal = {
  freshUploadId,
  rewritePasteSliceImages,
  findImagesByUploadId,
  MARKER_RE,
};

function makeContentImagePlugin(
  options: ContentImageUploaderOptions,
): Plugin<PluginState> {
  // View-local mutable state — re-created per Plugin instance.
  const pendingPasteQueue: Array<{
    uploadId: UploadId;
    originalSrc: string;
  }> = [];
  const inFlightAborts = new Map<UploadId, AbortController>();
  const inFlightSet = new Set<UploadId>();
  let mountSweepScheduled = false;
  let destroyed = false;

  return new Plugin<PluginState>({
    key: contentImageUploaderKey,
    state: {
      init(): PluginState {
        return { pending: new Map(), swept: false };
      },
      apply(tr, value): PluginState {
        const meta = tr.getMeta(contentImageUploaderKey) as Meta | undefined;
        if (!meta) return value;
        if (meta.kind === 'pending-added') {
          const next = new Map(value.pending);
          for (const e of meta.entries) {
            next.set(e.uploadId, {
              originalSrc: e.originalSrc,
              status: 'queued',
              attemptedAt: Date.now(),
            });
          }
          return { ...value, pending: next };
        }
        if (meta.kind === 'pending-resolved') {
          // Idempotent: entry may have been removed by a racing tx.
          if (!value.pending.has(meta.uploadId)) return value;
          const next = new Map(value.pending);
          next.delete(meta.uploadId);
          return { ...value, pending: next };
        }
        if (meta.kind === 'pending-failed') {
          const existing = value.pending.get(meta.uploadId);
          // Idempotent: entry may have been removed by a racing tx.
          if (!existing) return value;
          const next = new Map(value.pending);
          next.set(meta.uploadId, { ...existing, status: 'failed' });
          return { ...value, pending: next };
        }
        if (meta.kind === 'swept') {
          return { ...value, swept: true };
        }
        return value;
      },
    },
    appendTransaction(_transactions, oldState, newState) {
      const drained = pendingPasteQueue.splice(0);
      const oldPending =
        contentImageUploaderKey.getState(oldState)?.pending ??
        new Map<UploadId, Entry>();
      const validIdsAfterTx = new Set<UploadId>(oldPending.keys());
      for (const e of drained) validIdsAfterTx.add(e.uploadId);

      const orphans: Array<{ pos: number; size: number }> = [];
      newState.doc.descendants((node, pos) => {
        if (node.type.name !== 'image') return;
        const src = node.attrs?.src ?? '';
        const m = MARKER_RE.exec(src);
        if (!m) return;
        if (!validIdsAfterTx.has(m[2])) {
          orphans.push({ pos, size: node.nodeSize });
        }
      });

      if (drained.length === 0 && orphans.length === 0) return null;

      const tr = newState.tr;
      tr.setMeta('addToHistory', false);
      if (drained.length > 0) {
        const meta: PendingAddedMeta = {
          kind: 'pending-added',
          entries: drained,
        };
        tr.setMeta(contentImageUploaderKey, meta);
      }
      // Reverse so earlier-position deletes don't shift later positions.
      for (let i = orphans.length - 1; i >= 0; i--) {
        tr.delete(orphans[i].pos, orphans[i].pos + orphans[i].size);
      }
      return tr;
    },
    props: {
      transformPasted(slice) {
        if (slice.size === 0) return slice;
        return rewritePasteSliceImages(slice, pendingPasteQueue);
      },
    },
    view(view) {
      function tryPromote(): void {
        if (destroyed) return;
        const state = contentImageUploaderKey.getState(view.state);
        if (!state) return;
        const queued = [...state.pending.entries()]
          .filter(([id, e]) => e.status === 'queued' && !inFlightSet.has(id))
          .sort((a, b) => a[1].attemptedAt - b[1].attemptedAt);
        while (inFlightSet.size < MAX_CONCURRENT_UPLOADS && queued.length > 0) {
          const next = queued.shift();
          if (!next) break;
          const [uploadId, entry] = next;
          const ac = new AbortController();
          inFlightSet.add(uploadId);
          inFlightAborts.set(uploadId, ac);
          void startUpload(uploadId, entry, ac);
        }
      }

      async function startUpload(
        uploadId: UploadId,
        entry: Entry,
        ac: AbortController,
      ): Promise<void> {
        try {
          const payload = entry.originalSrc.startsWith('data:')
            ? { dataUrl: entry.originalSrc }
            : { sourceUrl: entry.originalSrc };
          const result = await uploadContentImage(payload, {
            signal: ac.signal,
          });
          if (destroyed) return;
          const matches = findImagesByUploadId(view.state.doc, uploadId);
          const tr = view.state.tr;
          tr.setMeta('addToHistory', false);
          for (const { pos, node } of matches) {
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              src: result.url,
            });
          }
          const meta: PendingResolvedMeta = {
            kind: 'pending-resolved',
            uploadId,
          };
          tr.setMeta(contentImageUploaderKey, meta);
          view.dispatch(tr);
        } catch (err) {
          if (destroyed) return;
          const isAbort =
            err instanceof DOMException && err.name === 'AbortError';
          if (isAbort) return;
          const matches = findImagesByUploadId(view.state.doc, uploadId);
          const tr = view.state.tr;
          tr.setMeta('addToHistory', false);
          for (const { pos, node } of matches) {
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              src: `${FAILED_ICON_SRC}#cf-${uploadId}`,
            });
          }
          const meta: PendingFailedMeta = {
            kind: 'pending-failed',
            uploadId,
          };
          tr.setMeta(contentImageUploaderKey, meta);
          view.dispatch(tr);
          const message =
            err instanceof ApiError
              ? `Image upload failed: ${err.message}`
              : 'Image upload failed.';
          options.onToast?.(message);
        } finally {
          inFlightSet.delete(uploadId);
          inFlightAborts.delete(uploadId);
          if (destroyed) return;
          // Trigger another promotion pass. Use setTimeout so the
          // current microtask (and any pending dispatch) settles first.
          setTimeout(() => {
            if (destroyed) return;
            tryPromote();
          }, 0);
        }
      }

      function runMountSweep(): void {
        if (destroyed) return;
        const state = contentImageUploaderKey.getState(view.state);
        if (!state) return;
        const orphans: Array<{ pos: number; size: number }> = [];
        view.state.doc.descendants((node, pos) => {
          if (node.type.name !== 'image') return;
          const src = node.attrs?.src ?? '';
          const m = MARKER_RE.exec(src);
          if (!m) return;
          if (!state.pending.has(m[2])) {
            orphans.push({ pos, size: node.nodeSize });
          }
        });
        const tr = view.state.tr;
        tr.setMeta('addToHistory', false);
        const meta: SweptMeta = { kind: 'swept' };
        tr.setMeta(contentImageUploaderKey, meta);
        for (let i = orphans.length - 1; i >= 0; i--) {
          tr.delete(orphans[i].pos, orphans[i].pos + orphans[i].size);
        }
        view.dispatch(tr);
        if (orphans.length > 0) {
          options.onToast?.(
            `Removed ${orphans.length} stale image placeholder${orphans.length === 1 ? '' : 's'}.`,
          );
        }
      }

      return {
        update() {
          if (destroyed) return;
          const state = contentImageUploaderKey.getState(view.state);
          if (!state) return;
          if (!state.swept && !mountSweepScheduled) {
            mountSweepScheduled = true;
            setTimeout(() => runMountSweep(), 0);
          }
          tryPromote();
        },
        destroy() {
          destroyed = true;
          for (const ac of inFlightAborts.values()) {
            try {
              ac.abort();
            } catch {
              // Ignored — abort throws if already aborted.
            }
          }
          inFlightAborts.clear();
          inFlightSet.clear();
          pendingPasteQueue.length = 0;
        },
      };
    },
  });
}

export const ContentImageUploaderExtension =
  Extension.create<ContentImageUploaderOptions>({
    name: 'contentImageUploader',
    addOptions(): ContentImageUploaderOptions {
      return {};
    },
    addProseMirrorPlugins() {
      return [makeContentImagePlugin(this.options)];
    },
  });
