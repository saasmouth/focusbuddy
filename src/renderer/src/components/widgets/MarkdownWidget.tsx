import { useEffect, useRef, useState } from 'react'
import { useGrowToFit, GROW_MAX_HEIGHT } from '../../lib/useGrowToFit'
import { promptText } from '../plexi/PromptDialog'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from 'tiptap-markdown'
import type { Editor } from '@tiptap/react'
import type { Widget } from '@shared/types'
import { useWidgetStore } from '../../stores/widgets'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import ConnectedToolMenu from '../contextMenu/UnifiedConnectedMenu'
import { WidgetImage } from './widgetImage'
import { useEditorWidgetSnippets } from './useWidgetSnippets'

interface Props {
  widget: Widget
  inline?: boolean
}

interface ToolbarBtn {
  icon: string
  title: string
  shortcut?: string
  isActive?: (e: Editor) => boolean
  run: (e: Editor) => void
}

const TOOLBAR: ToolbarBtn[] = [
  {
    icon: 'format_bold',
    title: 'Bold',
    shortcut: '⌘B',
    isActive: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run()
  },
  {
    icon: 'format_italic',
    title: 'Italic',
    shortcut: '⌘I',
    isActive: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run()
  },
  {
    icon: 'format_strikethrough',
    title: 'Strikethrough',
    isActive: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run()
  },
  {
    icon: 'code',
    title: 'Inline code',
    isActive: (e) => e.isActive('code'),
    run: (e) => e.chain().focus().toggleCode().run()
  },
  {
    icon: 'title',
    title: 'Heading 2',
    isActive: (e) => e.isActive('heading', { level: 2 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run()
  },
  {
    icon: 'format_list_bulleted',
    title: 'Bulleted list',
    isActive: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run()
  },
  {
    icon: 'format_list_numbered',
    title: 'Numbered list',
    isActive: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run()
  },
  {
    icon: 'check_box',
    title: 'Task list',
    isActive: (e) => e.isActive('taskList'),
    run: (e) => e.chain().focus().toggleTaskList().run()
  },
  {
    icon: 'format_quote',
    title: 'Quote',
    isActive: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run()
  },
  {
    icon: 'data_object',
    title: 'Code block',
    isActive: (e) => e.isActive('codeBlock'),
    run: (e) => e.chain().focus().toggleCodeBlock().run()
  },
  {
    icon: 'link',
    title: 'Link',
    isActive: (e) => e.isActive('link'),
    run: (e) => {
      if (e.isActive('link')) {
        e.chain().focus().unsetLink().run()
        return
      }
      const prev = (e.getAttributes('link').href as string) || 'https://'
      void promptText({ title: 'Link URL', initial: prev, confirmLabel: 'Set link' }).then((url) => {
        if (url === null) return
        if (url === '') {
          e.chain().focus().unsetLink().run()
          return
        }
        e.chain().focus().setLink({ href: url }).run()
      })
    }
  },
  {
    icon: 'horizontal_rule',
    title: 'Divider',
    run: (e) => e.chain().focus().setHorizontalRule().run()
  },
  {
    // Copy the raw markdown source to the clipboard so the note travels out of
    // PlexiDesk as portable text (paste into GitHub, Obsidian, a PR, anywhere).
    icon: 'content_copy',
    title: 'Copy as markdown',
    run: (e) => {
      const storage = e.storage as { markdown?: { getMarkdown: () => string } }
      const md = storage.markdown?.getMarkdown() ?? ''
      void navigator.clipboard.writeText(md)
    }
  }
]

export default function MarkdownWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const lastSavedRef = useRef(widget.content)
  const saveTimerRef = useRef<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; selectionText?: string } | null>(null)
  // Slash insert menu, anchored at the caret within this container.
  const growRef = useRef<HTMLDivElement | null>(null)

  // Show the whole of what is written here without the reader having to
  // resize first. Grow-only and capped — see useGrowToFit.
  useGrowToFit(widget, growRef, { maxHeight: GROW_MAX_HEIGHT['markdown'], disabled: inline }, [widget.content])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashPos, setSlashPos] = useState<{ top: number; left: number } | null>(null)
  // Brief status under the toolbar after an export ("Saved note.pdf" / "Export cancelled").
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  const pasteRef = useRef<(e: ClipboardEvent) => boolean>(() => false)
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          // Use tiptap-markdown's link/code handling; keep StarterKit defaults otherwise
          link: false
        }),
        Link.configure({
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' }
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        // GFM tables. Pasting a |---|---| markdown table renders a real table;
        // it round-trips through the stored markdown as HTML, which is why the
        // Markdown extension below runs with html: true.
        TableKit.configure({ table: { resizable: false } }),
        // Pictures (owner decision): stored as fb-file:// on insert or paste, and
        // written as ![alt](src) in markdown.
        WidgetImage,
        Placeholder.configure({
          placeholder:
            'Type or paste markdown. ⌘B bold · ⌘I italic · type "# " for a heading · "- " for a list · "[ ] " for a task · paste a |---| table'
        }),
        Markdown.configure({
          html: true,
          tightLists: true,
          bulletListMarker: '-',
          linkify: true,
          breaks: false,
          transformPastedText: true,
          transformCopiedText: false
        })
      ],
      content: widget.content || '',
      onUpdate: ({ editor: ed }) => {
        // Debounced save — pull serialized markdown from the editor and
        // persist. Defensive against two race conditions that caused
        // AI-generated checklists to "auto-delete":
        //
        //   1. The markdown extension's storage may not be wired up yet on
        //      the first onUpdate (when the initial parse runs). storage
        //      .markdown is undefined → we'd previously default to '' and
        //      save an empty string back to the DB, clobbering the original.
        //
        //   2. Even when storage exists, getMarkdown() can return '' for a
        //      brief window before the parsed doc is committed. If we save
        //      that empty string while the actual editor doc is NOT empty,
        //      we'd wipe out content the user never touched.
        //
        // Both guards apply only when the editor genuinely has content
        // (`!ed.isEmpty`) — a deliberate user-driven clear-all still saves
        // correctly.
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = window.setTimeout(() => {
          const storage = ed.storage as { markdown?: { getMarkdown: () => string } }
          if (!storage.markdown) return
          const md = storage.markdown.getMarkdown()
          if (md === '' && !ed.isEmpty) return
          if (md === lastSavedRef.current) return
          lastSavedRef.current = md
          void update(widget.id, { content: md })
        }, 600)
      },
      // Slash opens an insert menu at the caret, mirroring the page widget so
      // the two rich surfaces feel the same. We let the "/" type normally and
      // anchor the menu on the next tick once the caret has moved past it.
      editorProps: {
        // ⌘V of what the editor cannot read itself (a picture, a drawing, a
        // grid of cells) goes through the snippet conversion; text and HTML keep
        // the editor's own paste.
        handlePaste(_view, event) {
          return pasteRef.current(event)
        },
        handleKeyDown(_view, event) {
          if (event.key === '/' && !slashOpen) {
            setTimeout(() => {
              const sel = window.getSelection()
              if (sel && sel.rangeCount > 0) {
                const rect = sel.getRangeAt(0).getBoundingClientRect()
                const container = containerRef.current?.getBoundingClientRect()
                if (container) {
                  setSlashPos({
                    top: rect.bottom - container.top + 2,
                    left: rect.left - container.left
                  })
                  setSlashOpen(true)
                }
              }
            }, 0)
            return false
          }
          if (event.key === 'Escape') setSlashOpen(false)
          return false
        }
      }
    },
    // Re-init when widget id changes (e.g. focus-mode swap)
    [widget.id]
  )

  // A destination for saved snippets and ⌘V.
  const snippets = useEditorWidgetSnippets(widget, 'markdown', editor)
  pasteRef.current = snippets.handlePaste

  // If the widget's content changes externally while we're mounted (e.g. AI Setup spawn
  // followed by a server-side update), reconcile — but never clobber an unsaved local
  // edit, which lastSavedRef guards against.
  useEffect(() => {
    if (!editor) return
    if (widget.content === lastSavedRef.current) return
    lastSavedRef.current = widget.content
    editor.commands.setContent(widget.content || '', { emitUpdate: false })
  }, [editor, widget.content])

  // Flush any pending save when the widget unmounts. Same guards as the
  // debounced path above — never overwrite non-empty content with empty
  // markdown that came from a not-yet-ready serializer.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        const ed = editor
        if (ed) {
          const storage = ed.storage as { markdown?: { getMarkdown: () => string } }
          if (!storage.markdown) return
          const md = storage.markdown.getMarkdown()
          if (md === '' && !ed.isEmpty) return
          if (md !== lastSavedRef.current) {
            void update(widget.id, { content: md })
          }
        }
      }
    }
  }, [editor, update, widget.id])

  // Delete the "/" that triggered the menu, then run the chosen block command.
  function applyBlock(run: (e: Editor) => void): void {
    if (!editor) return
    editor
      .chain()
      .focus()
      .deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from })
      .run()
    run(editor)
    setSlashOpen(false)
  }

  // Export the note. We serialise the editor to HTML, wrap it in a clean
  // self-contained document (inline print stylesheet, no app CSS needed), and
  // hand it to main to write as .html or to printToPDF.
  async function runExport(format: 'html' | 'pdf'): Promise<void> {
    if (!editor) return
    const md = (editor.storage as { markdown?: { getMarkdown: () => string } }).markdown
    const titleSource = (widget.title || md?.getMarkdown() || 'note').trim()
    const name = (titleSource.split('\n')[0] || 'note').replace(/^#+\s*/, '').slice(0, 60).trim() || 'note'
    const doc = buildExportHtml(name, editor.getHTML())
    setExportMsg('Exporting…')
    try {
      const res =
        format === 'pdf'
          ? await window.api.exportDoc.pdf({ html: doc, suggestedName: name })
          : await window.api.exportDoc.html({ html: doc, suggestedName: name })
      setExportMsg(res.ok ? `Saved ${res.path.split(/[\\/]/).pop()}` : 'Export cancelled')
    } catch {
      setExportMsg('Export failed')
    }
    window.setTimeout(() => setExportMsg(null), 2600)
  }

  const body = (
    <div ref={containerRef} className="relative h-full w-full flex flex-col bg-[var(--surface-raised)]">
      <div className="px-2 py-1 border-b border-[var(--edge-soft)] flex items-center gap-0.5 flex-wrap bg-[var(--surface-sunken)]">
        {TOOLBAR.map((b) => {
          const active = editor ? b.isActive?.(editor) ?? false : false
          return (
            <button
              key={b.title}
              type="button"
              onMouseDown={(e) => e.preventDefault()} // keep editor focus
              onClick={(e) => {
                e.stopPropagation()
                if (editor) b.run(editor)
              }}
              title={`${b.title}${b.shortcut ? ` (${b.shortcut})` : ''}`}
              className={`inline-flex items-center justify-center h-6 w-6 rounded transition-colors ${
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)]'
              }`}
            >
              <Icon name={b.icon} size={13} />
            </button>
          )
        })}
        <span className="mx-0.5 h-4 w-px bg-[var(--surface-sunken)]" aria-hidden />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            void runExport('html')
          }}
          title="Export as HTML"
          data-testid="md-export-html"
          className="inline-flex items-center justify-center h-6 w-6 rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] transition-colors"
        >
          <Icon name="html" size={13} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            void runExport('pdf')
          }}
          title="Export as PDF"
          data-testid="md-export-pdf"
          className="inline-flex items-center justify-center h-6 w-6 rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] transition-colors"
        >
          <Icon name="picture_as_pdf" size={13} />
        </button>
      </div>
      {exportMsg && (
        <div
          data-testid="md-export-status"
          className="px-3 py-1 text-[10px] text-[var(--ink-50)] border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]"
        >
          {exportMsg}
        </div>
      )}

      <div
        ref={growRef}
        className="flex-1 overflow-auto md-rendered tiptap-editor px-4 py-3 text-[var(--ink-100)]"
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          if (e.shiftKey) return
          e.preventDefault()
          const sel = window.getSelection()?.toString() ?? ''
          setCtxMenu({ x: e.clientX, y: e.clientY, selectionText: sel })
        }}
      >
        <EditorContent editor={editor} />
      </div>
      {ctxMenu && (
        <ConnectedToolMenu
          sourceWidgetId={widget.id}
          x={ctxMenu.x}
          y={ctxMenu.y}
          selectionContext={{ selectionText: ctxMenu.selectionText }}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {slashOpen && slashPos && (
        <>
          {/* click-away closes the menu */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setSlashOpen(false)} />
          <div
            data-testid="md-slash-menu"
            className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-50 w-52 max-h-64 overflow-auto py-1"
            style={{ top: slashPos.top, left: slashPos.left }}
          >
            <SlashItem icon="title" label="Heading 1" shortcut="#" onClick={() => applyBlock((e) => e.chain().focus().toggleHeading({ level: 1 }).run())} />
            <SlashItem icon="title" label="Heading 2" shortcut="##" onClick={() => applyBlock((e) => e.chain().focus().toggleHeading({ level: 2 }).run())} />
            <SlashItem icon="title" label="Heading 3" shortcut="###" onClick={() => applyBlock((e) => e.chain().focus().toggleHeading({ level: 3 }).run())} />
            <SlashItem icon="format_list_bulleted" label="Bullet list" shortcut="-" onClick={() => applyBlock((e) => e.chain().focus().toggleBulletList().run())} />
            <SlashItem icon="format_list_numbered" label="Numbered list" shortcut="1." onClick={() => applyBlock((e) => e.chain().focus().toggleOrderedList().run())} />
            <SlashItem icon="check_box" label="Task list" shortcut="[ ]" onClick={() => applyBlock((e) => e.chain().focus().toggleTaskList().run())} />
            <SlashItem icon="format_quote" label="Quote" shortcut=">" onClick={() => applyBlock((e) => e.chain().focus().toggleBlockquote().run())} />
            <SlashItem icon="data_object" label="Code block" shortcut="```" onClick={() => applyBlock((e) => e.chain().focus().toggleCodeBlock().run())} />
            <SlashItem icon="horizontal_rule" label="Divider" shortcut="---" onClick={() => applyBlock((e) => e.chain().focus().setHorizontalRule().run())} />
            <SlashItem
              icon="link"
              label="Link"
              onClick={() => {
                void promptText({ title: 'Link URL', initial: 'https://', confirmLabel: 'Set link' }).then((url) => {
                  if (url) applyBlock((e) => e.chain().focus().setLink({ href: url }).run())
                })
              }}
            />
          </div>
        </>
      )}
    </div>
  )

  if (inline) return body

  return (
    <WidgetFrame widget={widget} headerLabel="markdown" headerAccent="bg-stone-200/70 dark:bg-white/[0.07]" snippets={snippets}>
      {body}
    </WidgetFrame>
  )
}

function SlashItem({
  icon,
  label,
  shortcut,
  onClick
}: {
  icon: string
  label: string
  shortcut?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[var(--ink-70)] hover:bg-accent/10 hover:text-accent"
    >
      <Icon name={icon} size={13} />
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-[10px] text-[var(--ink-40)]">{shortcut}</span>}
    </button>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// A clean, self-contained print stylesheet so the exported HTML/PDF reads well
// on its own without any of the app's CSS. Covers the elements tiptap emits.
const PRINT_CSS = `
  :root { color-scheme: light; }
  body { margin: 0; background: #fff; color: #1c1917; }
  .doc {
    max-width: 720px; margin: 48px auto; padding: 0 24px;
    font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .doc h1 { font-size: 1.9em; margin: 0.6em 0 0.3em; line-height: 1.25; }
  .doc h2 { font-size: 1.5em; margin: 0.8em 0 0.3em; line-height: 1.3; }
  .doc h3 { font-size: 1.2em; margin: 0.8em 0 0.3em; }
  .doc p { margin: 0.5em 0; }
  .doc ul, .doc ol { padding-left: 1.4em; margin: 0.5em 0; }
  .doc li { margin: 0.2em 0; }
  .doc a { color: #6d28d9; text-decoration: underline; }
  .doc code { background: #f4f4f5; border-radius: 4px; padding: 0.1em 0.35em; font: 0.88em "SF Mono", ui-monospace, Menlo, monospace; }
  .doc pre { background: #f4f4f5; border-radius: 8px; padding: 12px 14px; overflow: auto; }
  .doc pre code { background: none; padding: 0; }
  .doc blockquote { margin: 0.6em 0; padding: 0.1em 1em; border-left: 3px solid #d6d3d1; color: #57534e; }
  .doc hr { border: none; border-top: 1px solid #e7e5e4; margin: 1.4em 0; }
  .doc ul[data-type="taskList"] { list-style: none; padding-left: 0.2em; }
  .doc ul[data-type="taskList"] li { display: flex; gap: 0.5em; align-items: flex-start; }
  .doc img { max-width: 100%; }
`

// Wrap serialised editor HTML into a standalone document for export.
function buildExportHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head>
<body><main class="doc">${bodyHtml}</main></body></html>`
}
