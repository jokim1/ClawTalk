// Read-only Tiptap render for Content body markdown.
//
// PR 3 ships the editor in read-only mode only — PR 4 will toggle
// `editable=true`, add the toolbar, link bubbles, and the autosave
// loop. Keeping the toolbar out of this PR's diff keeps the surface
// area small enough to dogfood the doc surface without committing
// to the full edit UX yet.
//
// The doc body is markdown. We parse it once via the shared
// `markdownToTiptapJson` module (also used server-side) so the
// editor and the executor see the same tree shape. The
// AnchorIdExtension below guarantees every block has a stable
// `data-anchor-id` for the agent-proposal pipeline.

import { EditorContent, useEditor } from '@tiptap/react';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useMemo } from 'react';

import {
  ensureAnchorIds,
  isAllowedRichTextLinkUrl,
  markdownToTiptapJson,
} from '../../../../src/shared/rich-text/index.js';
import {
  AnchorIdExtension,
  makeTransformPasted,
} from './anchor-id-extension';

type RichTextEditorProps = {
  bodyMarkdown: string;
  editable?: boolean;
  placeholder?: string;
};

export function RichTextEditor({
  bodyMarkdown,
  editable = false,
  placeholder,
}: RichTextEditorProps): JSX.Element {
  const initialContent = useMemo(
    () => ensureAnchorIds(markdownToTiptapJson(bodyMarkdown)),
    // Initial-only; subsequent body updates re-run via the effect below
    // so the editor instance keeps its selection/cursor state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const transformPasted = useMemo(() => makeTransformPasted(), []);

  const editor = useEditor({
    content: initialContent,
    editable,
    extensions: [
      StarterKit.configure({
        undoRedo: editable ? undefined : false,
      }),
      Link.configure({
        autolink: true,
        defaultProtocol: 'https',
        isAllowedUri: (url) => isAllowedRichTextLinkUrl(url),
        openOnClick: !editable,
        linkOnPaste: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? '',
      }),
      AnchorIdExtension,
    ],
    immediatelyRender: false,
    editorProps: {
      transformPasted: (slice) => transformPasted(slice),
    },
  });

  useEffect(() => {
    if (!editor) return;
    const nextJson = ensureAnchorIds(markdownToTiptapJson(bodyMarkdown));
    editor.commands.setContent(nextJson, { emitUpdate: false });
  }, [bodyMarkdown, editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editable, editor]);

  return (
    <div className="rich-text-editor">
      <EditorContent editor={editor} />
    </div>
  );
}
