import React, { useCallback, useEffect } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, List, ListOrdered,
  Quote, Code, Link2, Undo2, Redo2, Heading1, Heading2, AlignLeft, AlignCenter,
  AlignRight, Table2, Minus, Image as ImageIcon, RemoveFormatting,
} from 'lucide-react';

/**
 * The compose editor.
 *
 * A TipTap/ProseMirror surface with a fixed toolbar — the "looks like Google
 * Docs" brief: real document structure (headings, lists, quotes, tables,
 * images, alignment), inline formatting, link editing, undo/redo, and a paste
 * that keeps structure rather than dumping a wall of styled spans.
 *
 * Emits clean HTML on every change; the plain-text alternative part is derived
 * server-side so the two never disagree.
 */

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Compact toolbar for inline replies. */
  minimal?: boolean;
  autofocus?: boolean;
  onEditorReady?: (editor: Editor) => void;
}

const Divider = () => <span className="mx-1 h-5 w-px bg-border-light dark:bg-border-dark/60" />;

const ToolButton: React.FC<{
  icon: React.ElementType; label: string; active?: boolean; disabled?: boolean; onClick: () => void;
}> = ({ icon: Icon, label, active, disabled, onClick }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
    disabled={disabled}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`grid h-8 w-8 place-items-center rounded-lg transition-colors disabled:opacity-30 ${
      active
        ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
        : 'text-text-secondary-light hover:bg-surface-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
    }`}
  >
    <Icon size={16} />
  </button>
);

export const RichTextEditor: React.FC<Props> = ({
  value, onChange, placeholder, minimal = false, autofocus = false, onEditorReady,
}) => {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener nofollow', target: '_blank' } }),
      Placeholder.configure({ placeholder: placeholder ?? 'Write your message…' }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ inline: false, allowBase64: true }),
      Table.configure({ resizable: true }),
      TableRow, TableHeader, TableCell,
    ],
    content: value || '',
    autofocus,
    editorProps: {
      attributes: {
        class: 'tupo-prose focus:outline-none min-h-[8rem] px-4 py-3',
      },
    },
    onUpdate: ({ editor: ed }) => onChange(ed.getHTML()),
  });

  // Reflect an external value change (e.g. inserting a template) without
  // clobbering the cursor while the user is typing.
  useEffect(() => {
    if (editor && value !== editor.getHTML() && !editor.isFocused) {
      editor.commands.setContent(value || '', false);
    }
  }, [value, editor]);

  useEffect(() => {
    if (editor && onEditorReady) onEditorReady(editor);
  }, [editor, onEditorReady]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', prev ?? 'https://');
    if (url === null) return;
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const addImage = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('Image URL');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  }, [editor]);

  if (!editor) return <div className="min-h-[10rem] animate-pulse rounded-xl bg-surface-light dark:bg-surface-dark" />;

  return (
    <div className="overflow-hidden rounded-xl border border-border-light dark:border-border-dark/60">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border-light bg-surface-light/60 px-2 py-1.5 dark:border-border-dark/60 dark:bg-surface-dark/40">
        <ToolButton icon={Undo2} label="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} />
        <ToolButton icon={Redo2} label="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} />
        <Divider />
        <ToolButton icon={Bold} label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
        <ToolButton icon={Italic} label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
        <ToolButton icon={UnderlineIcon} label="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} />
        <ToolButton icon={Strikethrough} label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} />
        <ToolButton icon={Link2} label="Insert link" active={editor.isActive('link')} onClick={setLink} />
        {!minimal && (
          <>
            <Divider />
            <ToolButton icon={Heading1} label="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
            <ToolButton icon={Heading2} label="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
            <ToolButton icon={Quote} label="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
            <ToolButton icon={Code} label="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
          </>
        )}
        <Divider />
        <ToolButton icon={List} label="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <ToolButton icon={ListOrdered} label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        {!minimal && (
          <>
            <Divider />
            <ToolButton icon={AlignLeft} label="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} />
            <ToolButton icon={AlignCenter} label="Align centre" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} />
            <ToolButton icon={AlignRight} label="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} />
            <Divider />
            <ToolButton icon={Table2} label="Insert table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
            <ToolButton icon={ImageIcon} label="Insert image" onClick={addImage} />
            <ToolButton icon={Minus} label="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()} />
          </>
        )}
        <Divider />
        <ToolButton icon={RemoveFormatting} label="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} />
      </div>
      <EditorContent editor={editor} className="max-h-[52vh] overflow-y-auto bg-white dark:bg-elevated-dark/30" />
    </div>
  );
};
