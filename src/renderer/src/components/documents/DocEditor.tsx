import { useEffect, useId, useRef, useState } from 'react'
import DocMentionPicker from './editor/DocMentionPicker'
import type { DocMentionQuery } from './editor/docMentions'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { buildDocExtensions } from './editor/extensions'
import { htmlToDocContent } from '../../lib/docHtml'
import { sanitizeHtml } from '../../lib/htmlSanitize'
import { hasTrackedChanges, type PmNode as TrackedNode } from '../../lib/trackChanges'
import {
  parseDocBody,
  wrapDocBody,
  headingCss,
  MARGIN_PRESETS,
  type HeadingStyle,
  type HeadingStyles,
  type PageSetup,
  type PageMargins,
  type PageHeaderFooter
} from './editor/headingStyles'
import Toolbar from './editor/Toolbar'
import DocMenuBar from './editor/DocMenuBar'
import { setPaginationConfig } from './editor/pagination'
import DocBubbleMenu from './editor/DocBubbleMenu'
import FindReplace from './editor/FindReplace'
import DocSidePanel, { type DocSidePanelTab, type PanelCommentThread } from './editor/DocSidePanel'
import { useDocAi } from './editor/useDocAi'
import { useRegisterEditorCommands, type EditorCommand } from '../../stores/editorCommands'
import type { Doc as YDoc } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import Icon from '../Icon'
import WidgetPickerDialog from './embed/WidgetPickerDialog'
import DocPickerModal from '../DocPickerModal'
import { primeDocMeta } from '../../lib/docMetaCache'

// Focus mode dims every block except the one under the cursor, so a long draft
// collapses to the single sentence being written. The FocusBlock decoration tags
// the active block; this CSS does the fading. Scoped to .fb-focus-mode so it is
// completely inert until focus mode is on.
const FOCUS_CSS = `
.fb-focus-mode .ProseMirror > * { opacity: .24; transition: opacity .4s var(--ease-spring-soft, ease); }
.fb-focus-mode .ProseMirror > .fb-focus-block { opacity: 1; }
`

// Comment-anchored text: a soft amber highlight you can click to open the thread.
const COMMENT_CSS = `
.ProseMirror .fb-comment { background: rgba(250, 204, 21, .22); border-bottom: 2px solid rgba(234, 179, 8, .7); border-radius: 2px; cursor: pointer; }
.ProseMirror .fb-comment:hover { background: rgba(250, 204, 21, .38); }
`

// Keep wide, non-wrapping content inside the page so nothing spills past the
// margins or off the sheet (the bug where a long code line or URL ran off the
// right edge). Long code lines scroll within the content column instead of
// widening the page, images scale down to the column, tables scroll in their own
// wrapper, and long unbreakable tokens (URLs, paths) wrap. `overflow-wrap:
// anywhere` also collapses the text's min-content width, which stops a wide child
// from blowing out the page's flex width. Scoped per editor instance, so it
// applies in both page view and continuous view without leaking to other prose.
function overflowCss(scope: string): string {
  return `
.${scope} .ProseMirror { overflow-wrap: anywhere; }
.${scope} .ProseMirror pre { max-width: 100%; overflow-x: auto; }
.${scope} .ProseMirror img { max-width: 100%; height: auto; }
.${scope} .ProseMirror .tableWrapper { max-width: 100%; overflow-x: auto; }
`
}

// Page view shows real paper: the sheet is always white with dark ink, in any app
// theme (like Word and Google Docs), rather than inverting to a dark sheet in dark
// mode. Scoped to the page canvas only, so continuous view still follows the
// theme. Forces a light colour-scheme and the light Tailwind-typography variables
// so dark:prose-invert does not lighten the text on white paper.
function pagePaperCss(scope: string): string {
  const s = `.${scope} [data-testid="doc-page"]`
  return `
${s} { color-scheme: light; }
${s} .ProseMirror { color: #1c1917; }
${s} .prose {
  --tw-prose-body:#3f3f46; --tw-prose-headings:#18181b; --tw-prose-lead:#3f3f46;
  --tw-prose-links:#2563eb; --tw-prose-bold:#18181b; --tw-prose-counters:#52525b;
  --tw-prose-bullets:#a1a1aa; --tw-prose-hr:#e4e4e7; --tw-prose-quotes:#18181b;
  --tw-prose-quote-borders:#e4e4e7; --tw-prose-captions:#52525b; --tw-prose-code:#18181b;
  --tw-prose-pre-code:#e5e7eb; --tw-prose-pre-bg:#1f2937;
  --tw-prose-th-borders:#d4d4d8; --tw-prose-td-borders:#e4e4e7;
}
`
}

// Page geometry at 96dpi (the CSS reference), so a Letter portrait sheet is the
// familiar 816x1056, A4 is 794x1123, and landscape swaps the long and short
// edges. Margins come from the document's own page setup (per side, in inches),
// so what the writer sets is what the sheet and the exports show. This is what
// makes the page-view sheet look like real paper and gives portrait/landscape a
// true effect rather than a cosmetic one.
function pageGeometry(page: PageSetup): {
  w: number
  h: number
  mTop: number
  mRight: number
  mBottom: number
  mLeft: number
} {
  const DPI = 96
  const base = page.size === 'a4' ? { w: 8.27 * DPI, h: 11.69 * DPI } : { w: 8.5 * DPI, h: 11 * DPI }
  const portrait = page.orientation === 'portrait'
  return {
    w: Math.round(portrait ? base.w : base.h),
    h: Math.round(portrait ? base.h : base.w),
    mTop: Math.round(page.margin.top * DPI),
    mRight: Math.round(page.margin.right * DPI),
    mBottom: Math.round(page.margin.bottom * DPI),
    mLeft: Math.round(page.margin.left * DPI)
  }
}

function readPref<T extends string>(key: string, allowed: readonly T[], dflt: T): T {
  try {
    const v = localStorage.getItem(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
  } catch {
    return dflt
  }
}

// Doc editor — a Word-class rich-text surface on Tiptap. The toolbar, bubble
// menu and slash menu expose the full formatting set; Ask AI drafts formatted
// content at the cursor and can rewrite the selection; the Office menu imports
// and exports real .docx and exports PDF. Body edits flow to onChange (the
// store's debounced autosave).

interface Props {
  content: unknown
  title: string
  onChange: (json: unknown) => void
  // When set, the editor is a live collaborator on this Yjs document: content
  // comes from the CRDT (not the `content` prop) and local edits flow to peers
  // through it rather than through onChange.
  ydoc?: YDoc
  // Awareness + the local user's label/colour render other people's live cursors.
  awareness?: Awareness
  user?: { name: string; color: string }
  // Hands the live editor instance to the parent (for comments: apply marks,
  // read the selection, jump to a range). Called with null on teardown.
  onEditorReady?: (editor: Editor | null) => void
  // Clicking commented (highlighted) text opens its thread.
  onCommentClick?: (commentId: string) => void
  // The real comment threads for the Comments tab of the side panel. The parent
  // owns the data and the handlers; when it has no comment backend it passes an
  // empty list and leaves the handlers off, and the panel shows an honest empty
  // state. Never fabricate threads here.
  comments?: PanelCommentThread[]
  canComment?: boolean
  onAddComment?: () => void
  onReplyComment?: (threadId: string, body: string) => void
  onJumpComment?: (threadId: string) => void
  // Real member handles a comment can @mention, and the viewer's own handle.
  // Passed straight to the side panel's comment autocomplete + highlighting.
  mentionHandles?: string[]
  myHandle?: string | null
  // The name to greet the writer with in the AI Assistant tab. Omit when the user
  // is not signed in; the panel falls back to a neutral greeting.
  userName?: string | null
}

const REWRITE_ACTIONS = [
  'Improve writing',
  'Make it more concise',
  'Fix spelling and grammar',
  'Make the tone more formal',
  'Turn this into a bulleted list',
  'Turn this into a table'
]

export default function DocEditor({
  content,
  title,
  onChange,
  ydoc,
  awareness,
  user,
  onEditorReady,
  onCommentClick,
  comments = [],
  canComment = false,
  onAddComment,
  onReplyComment,
  onJumpComment,
  mentionHandles,
  myHandle,
  userName
}: Props): JSX.Element {
  const [findOpen, setFindOpen] = useState(false)
  // `@` in the document body. The query the extension reports, and a handler
  // the picker registers so Enter picks a mention instead of breaking the line.
  const [mentionQuery, setMentionQuery] = useState<DocMentionQuery | null>(null)
  const mentionKeyRef = useRef<((e: KeyboardEvent) => boolean) | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  // Track Changes (suggesting mode) toggle, and whether the doc currently carries
  // any suggestion (drives the Accept/Reject-all controls).
  const [suggesting, setSuggesting] = useState(false)
  const [hasTracked, setHasTracked] = useState(false)
  // The persistent right-side panel: open/collapsed plus the active tab. The old
  // floating-outline toggle now drives this panel's Outline tab instead.
  const [panelOpen, setPanelOpen] = useState(true)
  // In the main PlexiDesk app the ONE global assistant (AssistantOverlay) owns AI,
  // so the doc's in-panel AI tab is retired and its toggle opens the overlay
  // (contextual to this doc, and able to insert its answers here). The standalone
  // PlexiOffice build has no overlay, so it keeps its own in-panel assistant.
  const hasGlobalAssistant =
    typeof window !== 'undefined' &&
    (window as unknown as { __fbHasGlobalAssistant?: boolean }).__fbHasGlobalAssistant === true
  const [panelTab, setPanelTab] = useState<DocSidePanelTab>(hasGlobalAssistant ? 'comments' : 'ai')
  // Page vs continuous layout is a personal viewing preference (remembered across
  // sessions). Paper size, orientation and margins are part of the document and
  // travel with it, so they live on the body, not in localStorage.
  const [pageView, setPageView] = useState<boolean>(() => readPref('fb.doc.pageView', ['0', '1'] as const, '0') === '1')
  const [showMargins, setShowMargins] = useState(false)
  // Word-style margin ruler in page view; on by default, remembered per user.
  const [showRuler, setShowRuler] = useState<boolean>(() => readPref('fb.doc.ruler', ['0', '1'] as const, '1') === '1')
  const toggleRuler = (): void =>
    setShowRuler((v) => {
      const next = !v
      try {
        localStorage.setItem('fb.doc.ruler', next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  const [showHeaderFooter, setShowHeaderFooter] = useState(false)
  const [aiInstruction, setAiInstruction] = useState('')
  const [busyOffice, setBusyOffice] = useState<string | null>(null)
  const [officeMsg, setOfficeMsg] = useState<string | null>(null)
  const [widgetPickerOpen, setWidgetPickerOpen] = useState(false)
  const [docPickerOpen, setDocPickerOpen] = useState(false)

  // Parse the (possibly legacy) body once into the Tiptap doc + named heading
  // styles + page setup. The body is persisted wrapped as { doc, headingStyles,
  // page } so all three survive save/reopen; legacy raw-Tiptap bodies still open.
  const initial = parseDocBody(content)
  const [headingStyles, setHeadingStyles] = useState<HeadingStyles>(initial.headingStyles)
  const [page, setPage] = useState<PageSetup>(initial.page)
  // The editor's onUpdate closure is created once at mount, so reading state
  // there would save stale heading styles / page setup over a fresh edit. This
  // ref always holds the current values; every save reads from it.
  const metaRef = useRef<{ headingStyles: HeadingStyles; page: PageSetup }>({
    headingStyles: initial.headingStyles,
    page: initial.page
  })
  // Stable class to scope the injected heading CSS to this editor instance.
  const scopeClass = 'doc-hs-' + useId().replace(/[:]/g, '')

  const editor = useEditor({
    extensions: buildDocExtensions({
      interactive: true,
      collab: ydoc,
      awareness,
      user,
      mentionHooks: {
        onQuery: (q) => setMentionQuery(q),
        onKeyDown: (e) => mentionKeyRef.current?.(e) ?? false
      }
    }),
    // In collab mode the CRDT owns the content; passing `content` too would
    // double-insert it on top of what Collaboration loads from the Yjs doc.
    ...(ydoc ? {} : { content: (initial.doc as object) ?? { type: 'doc', content: [{ type: 'paragraph' }] } }),
    onUpdate({ editor }) {
      // Non-collab: this IS the save. Collab: peers sync through the Yjs doc, but
      // we still emit the body so the parent can snapshot it to storage (exports
      // and non-live views read that), debounced on its side. Read meta from the
      // ref so a save never reverts a just-changed heading style or page setup.
      const json = editor.getJSON()
      setHasTracked(hasTrackedChanges(json as TrackedNode))
      onChange(wrapDocBody(json, metaRef.current.headingStyles, metaRef.current.page))
    },
    onCreate({ editor }) {
      setHasTracked(hasTrackedChanges(editor.getJSON() as TrackedNode))
    },
    editorProps: {
      attributes: {
        class:
          'prose prose-stone dark:prose-invert max-w-none focus:outline-none min-h-[60vh] text-[15px] leading-relaxed',
        'data-testid': 'doc-editor-surface'
      },
      handleKeyDown(_view, event) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          setFindOpen(true)
          return true
        }
        return false
      },
      handleClick(view, pos) {
        if (!onCommentClick) return false
        const mark = view.state.doc.resolve(pos).marks().find((m) => m.type.name === 'comment')
        const id = mark?.attrs.commentId
        if (typeof id === 'string') onCommentClick(id)
        return false
      }
    }
  })

  const ai = useDocAi(editor)

  // Surface the editor instance to the parent (comments use it). Fire on
  // create + null on teardown; editor identity only changes on remount.
  useEffect(() => {
    onEditorReady?.(editor)
    return () => onEditorReady?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Publish this editor's commands to the global palette (Cmd+K) while it is
  // mounted. Toggles use functional setState so the closures never go stale and
  // the registry only needs to rebuild when the editor instance changes.
  useRegisterEditorCommands(
    'Document',
    () =>
      buildDocCommands(editor, {
        toggleFocus: () => setFocusMode((v) => !v),
        toggleOutline: () => {
          setPanelTab('outline')
          setPanelOpen(true)
        },
        togglePageView: () => setPageView((v) => !v),
        setPortrait: () => {
          updatePageSetup({ orientation: 'portrait' })
          setPageView(true)
        },
        setLandscape: () => {
          updatePageSetup({ orientation: 'landscape' })
          setPageView(true)
        },
        openFind: () => setFindOpen(true),
        draftAi: () => ai.openInsert(),
        rewriteAi: () => ai.openRewrite(),
        insertImage: () => void insertImage(),
        insertTable: () =>
          editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
        insertWidget: () => setWidgetPickerOpen(true),
        insertDoc: () => setDocPickerOpen(true),
        importDocx: () => void importDocx(),
        exportDocx: () => void exportDocx(),
        exportPdf: () => void exportPdf()
      }),
    [editor]
  )

  // Let the "/" slash menu's Insert items open these React pickers. The slash
  // extension only has the editor, so it reads these callbacks from its storage.
  useEffect(() => {
    if (!editor) return
    const store = (editor.storage as unknown as Record<string, unknown>).slashCommand as
      | { onInsertWidget?: (() => void) | null; onInsertDoc?: (() => void) | null }
      | undefined
    if (store) {
      store.onInsertWidget = () => setWidgetPickerOpen(true)
      store.onInsertDoc = () => setDocPickerOpen(true)
    }
  }, [editor])

  // Remember the page-vs-continuous viewing preference (a personal one).
  useEffect(() => {
    try {
      localStorage.setItem('fb.doc.pageView', pageView ? '1' : '0')
    } catch {
      /* ignore quota */
    }
  }, [pageView])

  // In focus mode, Escape leaves it (mirrors the palette's own Esc-to-close).
  useEffect(() => {
    if (!focusMode) return undefined
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setFocusMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusMode])

  // Update one heading level's named style and persist it with the document, so
  // every heading of that level re-renders with the new style at once.
  function updateHeadingStyle(level: number, patch: Partial<HeadingStyle>): void {
    setHeadingStyles((prev) => {
      const next: HeadingStyles = { ...prev, [level]: { ...prev[level], ...patch } }
      metaRef.current.headingStyles = next
      onChange(wrapDocBody(editor?.getJSON() ?? initial.doc, next, metaRef.current.page))
      return next
    })
  }

  // Update the page setup (size, orientation, margins) and persist it on the body
  // so the sheet and the exports both follow it.
  function updatePageSetup(patch: Partial<PageSetup>): void {
    setPage((prev) => {
      const next: PageSetup = { ...prev, ...patch, margin: { ...prev.margin, ...(patch.margin ?? {}) } }
      metaRef.current.page = next
      onChange(wrapDocBody(editor?.getJSON() ?? initial.doc, metaRef.current.headingStyles, next))
      return next
    })
  }

  // Reset the AI instruction box whenever the panel reopens.
  useEffect(() => {
    if (ai.open) setAiInstruction('')
  }, [ai.open])

  // Expose the editor as a debug/test handle. Harmless in production (a single
  // reference) and lets e2e drive selections deterministically, since selecting
  // ProseMirror text through synthetic DOM events is unreliable across platforms.
  useEffect(() => {
    if (!editor) return
    ;(window as unknown as { __docEditor?: unknown }).__docEditor = editor
    return () => {
      const w = window as unknown as { __docEditor?: unknown }
      if (w.__docEditor === editor) delete w.__docEditor
    }
  }, [editor])

  async function insertImage(): Promise<void> {
    if (!editor) return
    const res = await window.api.office.pickImage()
    if (res.ok && res.dataUrl) {
      editor.chain().focus().setImage({ src: res.dataUrl }).run()
    }
  }

  async function importDocx(): Promise<void> {
    if (!editor) return
    setBusyOffice('Importing…')
    setOfficeMsg(null)
    try {
      const res = await window.api.office.importDocx()
      if (res.ok && res.html != null) {
        editor.chain().focus().insertContent(htmlToDocContent(res.html)).run()
        // Bring the document's page setup across too: size, orientation, margins
        // and the running header/footer (mammoth only converts the body).
        if (res.page) {
          updatePageSetup({
            size: res.page.size,
            orientation: res.page.orientation,
            margin: res.page.margin,
            ...(res.page.header ? { header: res.page.header } : {}),
            ...(res.page.footer ? { footer: res.page.footer } : {})
          })
        }
        setOfficeMsg('Imported. Word styling is approximated, not pixel-perfect.')
      } else if (res.error) {
        setOfficeMsg(res.error)
      }
    } finally {
      setBusyOffice(null)
    }
  }

  async function exportDocx(): Promise<void> {
    if (!editor) return
    setBusyOffice('Exporting…')
    setOfficeMsg(null)
    try {
      const res = await window.api.office.exportDocx({ html: editor.getHTML(), title, page })
      setOfficeMsg(res.ok ? `Saved ${res.path}` : res.error ?? null)
    } finally {
      setBusyOffice(null)
    }
  }

  async function exportPdf(): Promise<void> {
    if (!editor) return
    setBusyOffice('Exporting…')
    setOfficeMsg(null)
    try {
      const res = await window.api.office.exportPdf({ html: editor.getHTML(), title, page })
      setOfficeMsg(res.ok ? `Saved ${res.path}` : res.error ?? null)
    } finally {
      setBusyOffice(null)
    }
  }

  // ── Table right-click menu ────────────────────────────────────────────────
  // Tables are the one block with a per-table page-layout choice (repeat the
  // header row on continuation pages), and a right-click on the table itself is
  // where Word and Docs put it. Kept local to the editor DOM so it never fires
  // over the rest of the app chrome.
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number; pos: number; on: boolean } | null>(null)
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom as HTMLElement
    const onCtx = (e: MouseEvent): void => {
      const found = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!found) return
      const $pos = editor.state.doc.resolve(found.pos)
      for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type.name === 'table') {
          e.preventDefault()
          setTableMenu({
            x: e.clientX,
            y: e.clientY,
            pos: $pos.before(d),
            on: $pos.node(d).attrs.headerRepeat === true
          })
          return
        }
      }
    }
    dom.addEventListener('contextmenu', onCtx)
    return () => dom.removeEventListener('contextmenu', onCtx)
  }, [editor])
  function toggleHeaderRepeat(): void {
    if (!editor || !tableMenu) return
    const { pos } = tableMenu
    editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        const node = tr.doc.nodeAt(pos)
        if (!node || node.type.name !== 'table') return false
        if (dispatch) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, headerRepeat: !node.attrs.headerRepeat })
        }
        return true
      })
      .run()
    setTableMenu(null)
  }

  if (!editor) return <div />

  // Continuous flow keeps its comfortable reading measure; page view hands the
  // sheet its own paper width, so the editor body just renders into whichever
  // container is active. Focus mode always uses the calm continuous flow.
  const showPage = pageView && !focusMode

  // The persistent right panel sits next to the writing column in a flex row. It
  // is never shown in focus mode, which keeps its calm single-column feel.
  const showPanel = panelOpen && !focusMode

  return (
    <div className={`relative flex h-full ${scopeClass} ${focusMode ? 'fb-focus-mode' : ''}`}>
      {/* `@` in the body. Mounted at the root rather than beside one of the two
          EditorContent branches, because either may be the one on screen and a
          picker attached to the wrong branch simply never appears. Portalled to
          <body> at the caret, so the document's own scroll container cannot
          clip it. */}
      <DocMentionPicker
        editor={editor}
        query={mentionQuery}
        onClose={() => setMentionQuery(null)}
        registerKeyHandler={(h) => {
          mentionKeyRef.current = h
        }}
      />
      {tableMenu && (
        <>
          {/* Click-away closes without changing anything. */}
          <div className="fixed inset-0 z-[80]" onMouseDown={() => setTableMenu(null)} />
          <div
            data-testid="doc-table-menu"
            className="fixed z-[81] min-w-[232px] rounded-[var(--radius-row)] fb-glass-panel py-1 fb-t-label"
            style={{ left: tableMenu.x, top: tableMenu.y }}
          >
            <button
              data-testid="doc-table-header-repeat"
              onClick={toggleHeaderRepeat}
              className="w-full text-left px-3 py-1.5 hover:bg-[var(--surface-sunken)] text-[var(--ink-90)] fb-press flex items-center gap-2"
            >
              <Icon name={tableMenu.on ? 'check_box' : 'check_box_outline_blank'} size={15} />
              Repeat header row on every page
            </button>
          </div>
        </>
      )}
      {/* Named heading styles: one rule per configured level, scoped to this editor. */}
      <style dangerouslySetInnerHTML={{ __html: headingCss(scopeClass, headingStyles) }} />
      <style dangerouslySetInnerHTML={{ __html: FOCUS_CSS }} />
      <style dangerouslySetInnerHTML={{ __html: COMMENT_CSS }} />
      <style dangerouslySetInnerHTML={{ __html: overflowCss(scopeClass) }} />
      <style dangerouslySetInnerHTML={{ __html: pagePaperCss(scopeClass) }} />

      <div className="relative flex-1 min-w-0 overflow-auto">
      {!focusMode && (
        <div className="max-w-3xl mx-auto px-8 pt-6">
          {/* Google-Docs-style menu bar sits above the formatting toolbar. Every
              item is wired to a real editor command, store action or export. */}
          <div className="mb-1.5 pb-1.5 border-b border-[var(--edge-soft)]">
            <DocMenuBar
              editor={editor}
              title={title}
              onInsertImage={() => void insertImage()}
              onInsertWidget={() => setWidgetPickerOpen(true)}
              onExportDocx={() => void exportDocx()}
              onExportPdf={() => void exportPdf()}
              onFind={() => setFindOpen(true)}
              onFocusMode={() => setFocusMode(true)}
              pageView={pageView}
              onSetPageView={setPageView}
              onOutline={() => {
                setPanelTab('outline')
                setPanelOpen(true)
              }}
              onComments={() => {
                setPanelTab('comments')
                setPanelOpen(true)
              }}
            />
          </div>
          <Toolbar
            editor={editor}
            headingStyles={headingStyles}
            onSetHeadingStyle={updateHeadingStyle}
            onAskAi={ai.openInsert}
            onToggleFind={() => setFindOpen((v) => !v)}
            onInsertImage={() => void insertImage()}
            onImportDocx={() => void importDocx()}
            onExportDocx={() => void exportDocx()}
            onExportPdf={() => void exportPdf()}
          />

          <div className="flex items-center gap-2 mt-2 mb-3 text-[11px] text-[var(--ink-50)] flex-wrap">
            <ReadingMeta editor={editor} />

            {/* Continuous vs Page, then orientation + paper when on a page. */}
            <span className="inline-flex rounded-full bg-[var(--surface-sunken)] overflow-hidden" data-testid="doc-layout-toggle">
              <button
                onClick={() => setPageView(false)}
                className={`px-2 py-1 ${!pageView ? 'bg-accent/10 text-accent' : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'}`}
                title="Continuous view — one flowing column"
              >
                Continuous
              </button>
              <button
                onClick={() => setPageView(true)}
                className={`px-2 py-1 ${pageView ? 'bg-accent/10 text-accent' : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'}`}
                title="Page view — paper sheets with margins"
                data-testid="doc-pageview-btn"
              >
                Page
              </button>
            </span>
            {pageView && (
              <>
                <button
                  onClick={() => updatePageSetup({ orientation: page.orientation === 'portrait' ? 'landscape' : 'portrait' })}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] fb-spring-soft"
                  title="Toggle portrait / landscape"
                  data-testid="doc-orientation-btn"
                >
                  <Icon name={page.orientation === 'portrait' ? 'crop_portrait' : 'crop_landscape'} size={13} />
                  <span>{page.orientation === 'portrait' ? 'Portrait' : 'Landscape'}</span>
                </button>
                <button
                  onClick={() => updatePageSetup({ size: page.size === 'letter' ? 'a4' : 'letter' })}
                  className="px-2 py-1 rounded-full hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] fb-spring-soft"
                  title="Paper size"
                  data-testid="doc-paper-btn"
                >
                  {page.size === 'a4' ? 'A4' : 'Letter'}
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowMargins((v) => !v)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] fb-spring-soft"
                    title="Page margins"
                    data-testid="doc-margins-btn"
                  >
                    <Icon name="margin" size={13} />
                    <span>Margins</span>
                  </button>
                  {showMargins && (
                    <MarginMenu margin={page.margin} onPick={(m) => updatePageSetup({ margin: m })} onClose={() => setShowMargins(false)} />
                  )}
                </div>
                <button
                  onClick={toggleRuler}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full fb-spring-soft ${showRuler ? 'bg-accent/10 text-accent' : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'}`}
                  title="Show the ruler — drag the markers to set page margins"
                  data-testid="doc-ruler-btn"
                >
                  <Icon name="straighten" size={13} />
                  <span>Ruler</span>
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowHeaderFooter((v) => !v)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] fb-spring-soft"
                    title="Header & footer"
                    data-testid="doc-headerfooter-btn"
                  >
                    <Icon name="web_asset" size={13} />
                    <span>Header/Footer</span>
                  </button>
                  {showHeaderFooter && (
                    <HeaderFooterMenu
                      header={page.header}
                      footer={page.footer}
                      onChange={(patch) => updatePageSetup(patch)}
                      onClose={() => setShowHeaderFooter(false)}
                    />
                  )}
                </div>
              </>
            )}

            <span className="ml-auto flex items-center gap-1">
              <button
                onClick={() => {
                  // Toggle: collapse the panel if its Outline tab is already
                  // showing, otherwise open the panel on that tab.
                  if (panelOpen && panelTab === 'outline') setPanelOpen(false)
                  else {
                    setPanelTab('outline')
                    setPanelOpen(true)
                  }
                }}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full fb-spring-soft ${
                  panelOpen && panelTab === 'outline'
                    ? 'text-accent bg-accent/10'
                    : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'
                }`}
                title="Show the document outline"
                data-testid="doc-outline-toggle"
              >
                <Icon name="format_list_bulleted" size={13} />
                <span>Outline</span>
              </button>
              <button
                onClick={() => {
                  if (panelOpen && panelTab === 'comments') setPanelOpen(false)
                  else {
                    setPanelTab('comments')
                    setPanelOpen(true)
                  }
                }}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full fb-spring-soft ${
                  panelOpen && panelTab === 'comments'
                    ? 'text-accent bg-accent/10'
                    : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'
                }`}
                title="Show comments"
                data-testid="doc-comments-toggle"
              >
                <Icon name="comment" size={13} />
                <span>Comments</span>
              </button>
              <button
                onClick={() => {
                  if (hasGlobalAssistant) {
                    // The one assistant, docked/floating, contextual to this doc.
                    window.dispatchEvent(new CustomEvent('fb:open-assistant'))
                    return
                  }
                  if (panelOpen && panelTab === 'ai') setPanelOpen(false)
                  else {
                    setPanelTab('ai')
                    setPanelOpen(true)
                  }
                }}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full fb-spring-soft ${
                  !hasGlobalAssistant && panelOpen && panelTab === 'ai'
                    ? 'text-accent bg-accent/10'
                    : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'
                }`}
                title="Show the AI assistant"
                data-testid="doc-assistant-toggle"
              >
                <Icon name="auto_awesome" size={13} />
                <span>Assistant</span>
              </button>
              <button
                onClick={() => setFocusMode(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] fb-spring-soft"
                title="Enter focus mode — dims everything but the line you're writing"
                data-testid="doc-focus-toggle"
              >
                <Icon name="center_focus_strong" size={13} />
                <span>Focus</span>
              </button>
              <button
                onClick={() => {
                  const next = !suggesting
                  setSuggesting(next)
                  editor?.commands.setTrackUser({ author: userName || user?.name || 'You', color: user?.color || '#2563eb' })
                  editor?.commands.setSuggesting(next)
                }}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full fb-spring-soft ${
                  suggesting ? 'bg-accent/[0.14] text-accent' : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'
                }`}
                title="Suggesting mode — record edits as tracked changes to accept or reject"
                data-testid="doc-suggest-toggle"
                aria-pressed={suggesting}
              >
                <Icon name="edit_note" size={13} />
                <span>Suggesting</span>
              </button>
              {(suggesting || hasTracked) && (
                <>
                  <button
                    onClick={() => editor?.commands.acceptAllChanges()}
                    disabled={!hasTracked}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full hover:bg-emerald-500/[0.12] text-emerald-600 dark:text-emerald-400 disabled:opacity-40 fb-spring-soft"
                    title="Accept all tracked changes"
                    data-testid="doc-accept-all"
                  >
                    <Icon name="check" size={13} />
                    <span>Accept all</span>
                  </button>
                  <button
                    onClick={() => editor?.commands.rejectAllChanges()}
                    disabled={!hasTracked}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full hover:bg-red-500/[0.12] text-red-600 dark:text-red-400 disabled:opacity-40 fb-spring-soft"
                    title="Reject all tracked changes"
                    data-testid="doc-reject-all"
                  >
                    <Icon name="close" size={13} />
                    <span>Reject all</span>
                  </button>
                </>
              )}
            </span>
          </div>
        </div>
      )}

      {focusMode && (
        <div
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[120] fb-glass-chrome rounded-full border border-[color:var(--glass-chrome-border)] shadow-lg flex items-center gap-2 px-3 py-1.5 text-[11px] text-[var(--ink-70)]"
          data-testid="doc-focus-bar"
        >
          <Icon name="center_focus_strong" size={13} className="text-accent" />
          <span className="font-medium">Focus</span>
          <span className="w-px h-3 bg-[color-mix(in_oklab,var(--edge-firm)_60%,transparent)]" />
          <ReadingMeta editor={editor} />
          <button
            onClick={() => setFocusMode(false)}
            className="inline-flex items-center gap-1 hover:text-[var(--ink-100)]"
            title="Exit focus mode (Esc)"
          >
            <Icon name="close" size={12} />
            <span>Exit · Esc</span>
          </button>
        </div>
      )}

      <DocBubbleMenu editor={editor} onAiRewrite={ai.openRewrite} />

      {findOpen && <FindReplace editor={editor} onClose={() => setFindOpen(false)} />}

      <div className="max-w-3xl mx-auto px-8">
      {(busyOffice || officeMsg) && (
        <div className="mb-3 text-[12px] text-[var(--ink-50)] flex items-center gap-1.5" data-testid="doc-office-status">
          {busyOffice && <Icon name="autorenew" size={13} className="animate-spin" />}
          <span>{busyOffice ?? officeMsg}</span>
          {officeMsg && !busyOffice && (
            <button onClick={() => setOfficeMsg(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]">
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      )}

      {ai.open && (
        <div className="mb-4 rounded-xl border border-accent/30 bg-accent/[0.04] p-3" data-testid="doc-ai-panel">
          <div className="flex items-center gap-1.5 mb-2">
            <Icon name="auto_awesome" size={13} className="text-accent" />
            <span className="text-[11px] uppercase tracking-wider font-semibold text-accent">
              {ai.mode === 'rewrite' ? 'Rewrite selection' : 'Draft with AI'}
            </span>
            <button onClick={ai.close} className="ml-auto icon-btn" aria-label="Close">
              <Icon name="close" size={13} />
            </button>
          </div>

          {ai.mode === 'rewrite' && (
            <div className="flex flex-wrap gap-1 mb-2">
              {REWRITE_ACTIONS.map((a) => (
                <button
                  key={a}
                  onClick={() => void ai.run(a)}
                  disabled={ai.busy}
                  className="text-[11px] px-2 py-1 rounded-full bg-[var(--surface-sunken)] hover:bg-accent/10 disabled:opacity-50"
                >
                  {a}
                </button>
              ))}
            </div>
          )}

          <textarea
            value={aiInstruction}
            onChange={(e) => setAiInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ai.run(aiInstruction)
            }}
            placeholder={
              ai.mode === 'rewrite'
                ? 'Or describe how to change the selection…'
                : 'Describe what to write… e.g. a risks section with a table, a conclusion, three pricing bullets'
            }
            rows={2}
            autoFocus
            className="fb-field w-full px-3 py-2 text-[13px] resize-none"
          />

          {ai.error && <div className="text-[12px] text-red-600 dark:text-red-400 mt-1">{ai.error}</div>}

          {ai.previewHtml != null && (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--ink-40)] mb-1">Preview</div>
              <div
                className="prose prose-sm prose-stone dark:prose-invert max-w-none max-h-60 overflow-auto rounded-lg bg-[var(--surface-base)] p-3"
                data-testid="doc-ai-preview"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(ai.previewHtml) }}
              />
            </div>
          )}

          <div className="flex items-center gap-2 mt-2">
            {ai.previewHtml == null ? (
              <button
                onClick={() => void ai.run(aiInstruction)}
                disabled={ai.busy || !aiInstruction.trim()}
                className="btn-primary text-[12px] px-3 py-1.5"
              >
                {ai.busy ? 'Drafting…' : ai.mode === 'rewrite' ? 'Rewrite' : 'Draft'}
              </button>
            ) : (
              <>
                <button onClick={ai.apply} data-testid="doc-ai-apply" className="btn-primary text-[12px] px-3 py-1.5">
                  {ai.mode === 'rewrite' ? 'Replace selection' : 'Insert'}
                </button>
                <button
                  onClick={() => void ai.run(aiInstruction || (ai.mode === 'rewrite' ? 'Improve writing' : ''))}
                  disabled={ai.busy}
                  className="fb-btn-surface text-[12px] px-3 py-1.5 hover:bg-[var(--surface-sunken)]"
                >
                  Regenerate
                </button>
              </>
            )}
            <span className="text-[11px] text-[var(--ink-40)]">Previewed before it touches the document. Cmd+Enter</span>
          </div>
        </div>
      )}
      </div>

      {showPage ? (
        <PageSheet editor={editor} page={page} showRuler={showRuler} onChangeMargin={(m) => updatePageSetup({ margin: m })} />
      ) : (
        // Continuous view: a comfortable reading column that is centred in the
        // available space and widens with the window, so the editor uses the
        // screen it has instead of hugging the left. Capped so lines never get
        // uncomfortably long on a very wide display.
        <div className="w-full max-w-[900px] xl:max-w-[1040px] mx-auto px-10 pb-16">
          <EditorContent editor={editor} />
        </div>
      )}

      {/* Collapsed: a slim tab on the right edge to bring the panel back. */}
      {!showPanel && !focusMode && (
        <button
          onClick={() => setPanelOpen(true)}
          className="absolute top-3 right-3 z-[55] inline-flex items-center gap-1 rounded-full bg-[var(--surface-raised)] px-2.5 py-1 text-[11px] text-[var(--ink-70)] hover:text-[rgb(var(--accent))] shadow-sm"
          title="Show the assistant panel"
          data-testid="doc-side-panel-expand"
        >
          <Icon name="chevron_left" size={14} />
          <span>Assistant</span>
        </button>
      )}
      </div>

      {widgetPickerOpen && (
        <WidgetPickerDialog
          onPick={(widgetId) => {
            setWidgetPickerOpen(false)
            editor.chain().focus().insertWidgetEmbed(widgetId).run()
          }}
          onClose={() => setWidgetPickerOpen(false)}
        />
      )}

      {docPickerOpen && (
        <DocPickerModal
          title="Insert an office file"
          onPick={(d) => {
            primeDocMeta(d.id, { title: d.title, docType: d.docType })
            setDocPickerOpen(false)
            editor.chain().focus().insertDocEmbed(d.id).run()
          }}
          onClose={() => setDocPickerOpen(false)}
        />
      )}

      {showPanel && (
        <DocSidePanel
          editor={editor}
          ai={ai}
          userName={userName}
          showAiTab={!hasGlobalAssistant}
          tab={panelTab}
          onTab={setPanelTab}
          onCollapse={() => setPanelOpen(false)}
          comments={comments}
          canComment={canComment}
          onAddComment={onAddComment}
          onReply={onReplyComment}
          onJumpComment={onJumpComment}
          mentionHandles={mentionHandles}
          myHandle={myHandle}
        />
      )}
    </div>
  )
}

// The page-margins menu: the named presets Word offers plus a custom editor for
// the four sides (in inches). Picking a preset or editing a side updates the
// Header & footer editor popover. Writes header/footer straight onto the page
// setup, so the running header/footer on every sheet and the .docx export follow.
function HeaderFooterMenu({
  header,
  footer,
  onChange,
  onClose
}: {
  header?: PageHeaderFooter
  footer?: PageHeaderFooter
  onChange: (patch: Partial<PageSetup>) => void
  onClose: () => void
}): JSX.Element {
  const inputCls =
    'fb-field w-full px-2 py-1 text-[12px]'
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-0 mt-1.5 z-40 w-64 p-2.5 text-[var(--ink-70)] space-y-2.5"
        data-testid="doc-headerfooter-menu"
      >
        <div>
          <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--ink-40)] mb-1">Header</p>
          <input
            className={inputCls}
            data-testid="doc-header-input"
            placeholder="Header text"
            value={header?.text ?? ''}
            onChange={(e) => onChange({ header: { ...header, text: e.target.value } })}
          />
          <label className="flex items-center gap-1.5 mt-1 text-[11px] cursor-pointer">
            <input
              type="checkbox"
              data-testid="doc-header-pageno"
              checked={!!header?.showPageNumber}
              onChange={(e) => onChange({ header: { ...header, showPageNumber: e.target.checked } })}
            />
            Show page number
          </label>
        </div>
        <div className="pt-1.5 border-t border-[var(--edge-soft)]">
          <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--ink-40)] mb-1">Footer</p>
          <input
            className={inputCls}
            data-testid="doc-footer-input"
            placeholder="Footer text"
            value={footer?.text ?? ''}
            onChange={(e) => onChange({ footer: { ...footer, text: e.target.value } })}
          />
          <label className="flex items-center gap-1.5 mt-1 text-[11px] cursor-pointer">
            <input
              type="checkbox"
              data-testid="doc-footer-pageno"
              checked={!!footer?.showPageNumber}
              onChange={(e) => onChange({ footer: { ...footer, showPageNumber: e.target.checked } })}
            />
            Show page number
          </label>
        </div>
      </div>
    </>
  )
}

// document's page setup, so the sheet and the exports follow immediately.
function MarginMenu({
  margin,
  onPick,
  onClose
}: {
  margin: PageMargins
  onPick: (m: PageMargins) => void
  onClose: () => void
}): JSX.Element {
  const sides: { key: keyof PageMargins; label: string }[] = [
    { key: 'top', label: 'Top' },
    { key: 'right', label: 'Right' },
    { key: 'bottom', label: 'Bottom' },
    { key: 'left', label: 'Left' }
  ]
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-0 mt-1.5 z-40 w-56 p-2 text-[var(--ink-70)]"
        data-testid="doc-margins-menu"
      >
        {MARGIN_PRESETS.map((p) => {
          const active = p.margin.top === margin.top && p.margin.right === margin.right && p.margin.bottom === margin.bottom && p.margin.left === margin.left
          return (
            <button
              key={p.id}
              onClick={() => onPick({ ...p.margin })}
              data-testid={`doc-margin-preset-${p.id}`}
              className={`w-full text-left px-2 py-1.5 rounded-md text-[12px] ${active ? 'bg-accent/10 text-accent' : 'hover:bg-[var(--surface-sunken)]'}`}
            >
              {p.label}
            </button>
          )
        })}
        <div className="mt-1.5 pt-1.5 border-t border-[var(--edge-soft)]">
          <p className="px-2 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-40)] mb-1">Custom (inches)</p>
          <div className="grid grid-cols-2 gap-1.5 px-1">
            {sides.map((s) => (
              <label key={s.key} className="flex items-center gap-1 text-[11px]">
                <span className="w-12 text-[var(--ink-50)]">{s.label}</span>
                <input
                  type="number"
                  min={0}
                  max={4}
                  step={0.05}
                  value={margin[s.key]}
                  data-testid={`doc-margin-${s.key}`}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (Number.isFinite(v)) onPick({ ...margin, [s.key]: Math.max(0, Math.min(4, v)) })
                  }}
                  className="fb-field w-full px-1.5 py-0.5"
                />
              </label>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

// The gap drawn between two sheets in page view. The pagination plugin pushes
// content onto the next sheet with a transparent spacer of matching height, so
// this is a genuine gap between discrete pages, not a line through one long sheet.
const PAGE_GAP = 28

// The page-view surface: content laid out onto discrete paper-sized sheets, each
// at the document's real paper size, orientation and margins, separated by a true
// gap. The pagination extension measures the blocks and inserts spacers so a block
// never straddles a page edge; this component draws one white sheet per page under
// the flowing content and lets the grey canvas show through the gaps.
const RULER_PX = 22 // ruler thickness
const RULER_DPI = 96 // css px per inch, matching pageGeometry

function PageSheet({
  editor,
  page,
  showRuler,
  onChangeMargin
}: {
  editor: Editor
  page: PageSetup
  showRuler: boolean
  onChangeMargin: (margin: PageSetup['margin']) => void
}): JSX.Element {
  // While a ruler marker is being dragged we preview the new margin locally so the
  // page reflows live, and only commit (persist) on release.
  const [liveMargin, setLiveMargin] = useState<PageSetup['margin'] | null>(null)
  const pendingMargin = useRef<PageSetup['margin'] | null>(null)
  const effPage = liveMargin ? { ...page, margin: liveMargin } : page
  const geom = pageGeometry(effPage)
  const usable = Math.max(1, geom.h - geom.mTop - geom.mBottom)
  const [pageCount, setPageCount] = useState(1)

  // Feed the live page metrics to the pagination plugin while this sheet is
  // mounted, and switch pagination off again when we leave page view. Depending
  // on the effective margins means dragging a ruler marker re-paginates live.
  useEffect(() => {
    setPaginationConfig(editor, {
      enabled: true,
      pageContentPx: usable,
      gapPx: PAGE_GAP,
      mTop: geom.mTop,
      mBottom: geom.mBottom,
      onPages: setPageCount
    })
    return () => setPaginationConfig(editor, { enabled: false, onPages: null })
  }, [editor, usable, geom.mTop, geom.mBottom])

  const stride = geom.h + PAGE_GAP
  const totalH = pageCount * geom.h + (pageCount - 1) * PAGE_GAP

  // Drag a margin marker. The ruler element gives us page-space pixels directly
  // (getBoundingClientRect is in CSS px, invariant under Chromium page zoom).
  // Snap to 1/16 inch and keep at least an inch of content in each dimension.
  const rulerH = useRef<HTMLDivElement>(null)
  const rulerV = useRef<HTMLDivElement>(null)
  function beginDrag(side: 'left' | 'right' | 'top' | 'bottom', el: HTMLDivElement | null, ev: React.PointerEvent): void {
    if (!el) return
    ev.preventDefault()
    const rect = el.getBoundingClientRect()
    const base = { ...(liveMargin ?? page.margin) }
    const SNAP = 6
    const MIN_CONTENT = 96
    const toIn = (px: number): number => (Math.round(px / SNAP) * SNAP) / RULER_DPI
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
    const move = (e: PointerEvent): void => {
      const m = { ...base }
      if (side === 'left') m.left = toIn(clamp(e.clientX - rect.left, 0, geom.w - geom.mRight - MIN_CONTENT))
      else if (side === 'right') m.right = toIn(clamp(rect.right - e.clientX, 0, geom.w - geom.mLeft - MIN_CONTENT))
      else if (side === 'top') m.top = toIn(clamp(e.clientY - rect.top, 0, geom.h - geom.mBottom - MIN_CONTENT))
      else m.bottom = toIn(clamp(rect.bottom - e.clientY, 0, geom.h - geom.mTop - MIN_CONTENT))
      pendingMargin.current = m
      setLiveMargin(m)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (pendingMargin.current) onChangeMargin(pendingMargin.current)
      pendingMargin.current = null
      setLiveMargin(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const inchTicks = (lengthPx: number): number[] => {
    const out: number[] = []
    for (let k = 0, x = 0; x <= lengthPx + 1; k++, x = k * RULER_DPI) out.push(x)
    return out
  }
  const markerCls = 'absolute z-10 flex items-center justify-center text-[var(--ink-70)]'

  return (
    <div
      className="py-8 px-4 overflow-x-auto bg-stone-300/50 dark:bg-black/40"
      data-testid="doc-page-canvas"
    >
      {/* Horizontal ruler — sticky so it stays put while scrolling. A corner
          spacer of the vertical ruler's width keeps it aligned above the page. */}
      {showRuler && (
        <div className="sticky top-0 z-30 flex justify-center mb-1">
          <div style={{ width: RULER_PX }} className="shrink-0" />
          <div
            ref={rulerH}
            data-testid="doc-ruler-h"
            className="relative shrink-0 select-none"
            style={{ width: geom.w, height: RULER_PX, background: 'var(--surface-raised)', border: '1px solid var(--edge-soft)', borderRadius: 3 }}
          >
            {inchTicks(geom.w).map((x, k) => (
              <div key={k} className="absolute top-0 bottom-0 w-px bg-[color-mix(in_oklab,var(--edge-firm)_50%,transparent)]" style={{ left: x }}>
                {k > 0 && <span className="absolute top-0.5 left-1 text-[9px] text-[var(--ink-40)] fb-tabular">{k}</span>}
              </div>
            ))}
            <div className="absolute top-0 bottom-0 left-0 bg-[var(--ink-40)]/20" style={{ width: geom.mLeft }} />
            <div className="absolute top-0 bottom-0 right-0 bg-[var(--ink-40)]/20" style={{ width: geom.mRight }} />
            <div
              data-testid="ruler-handle-left"
              onPointerDown={(e) => beginDrag('left', rulerH.current, e)}
              className={`${markerCls} top-0 bottom-0 w-3 -ml-1.5 cursor-col-resize`}
              style={{ left: geom.mLeft }}
              title={`Left margin ${effPage.margin.left}"`}
            >
              <span style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '7px solid var(--ink-70)' }} />
            </div>
            <div
              data-testid="ruler-handle-right"
              onPointerDown={(e) => beginDrag('right', rulerH.current, e)}
              className={`${markerCls} top-0 bottom-0 w-3 -ml-1.5 cursor-col-resize`}
              style={{ left: geom.w - geom.mRight }}
              title={`Right margin ${effPage.margin.right}"`}
            >
              <span style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '7px solid var(--ink-70)' }} />
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-center">
        {/* Vertical ruler — spans the first page; the top/bottom markers set the
            document-wide top/bottom margins. */}
        {showRuler && (
          <div
            ref={rulerV}
            data-testid="doc-ruler-v"
            className="relative shrink-0 select-none self-start"
            style={{ width: RULER_PX, height: geom.h, background: 'var(--surface-raised)', border: '1px solid var(--edge-soft)', borderRadius: 3, marginRight: 4 }}
          >
            {inchTicks(geom.h).map((y, k) => (
              <div key={k} className="absolute left-0 right-0 h-px bg-[color-mix(in_oklab,var(--edge-firm)_50%,transparent)]" style={{ top: y }} />
            ))}
            <div className="absolute left-0 right-0 top-0 bg-[var(--ink-40)]/20" style={{ height: geom.mTop }} />
            <div className="absolute left-0 right-0 bottom-0 bg-[var(--ink-40)]/20" style={{ height: geom.mBottom }} />
            <div
              data-testid="ruler-handle-top"
              onPointerDown={(e) => beginDrag('top', rulerV.current, e)}
              className={`${markerCls} left-0 right-0 h-3 -mt-1.5 cursor-row-resize`}
              style={{ top: geom.mTop }}
              title={`Top margin ${effPage.margin.top}"`}
            >
              <span style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '7px solid var(--ink-70)' }} />
            </div>
            <div
              data-testid="ruler-handle-bottom"
              onPointerDown={(e) => beginDrag('bottom', rulerV.current, e)}
              className={`${markerCls} left-0 right-0 h-3 -mt-1.5 cursor-row-resize`}
              style={{ top: geom.h - geom.mBottom }}
              title={`Bottom margin ${effPage.margin.bottom}"`}
            >
              <span style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '7px solid var(--ink-70)' }} />
            </div>
          </div>
        )}

      {/* minWidth:0 + flexShrink:0 pin the sheet to its true paper width inside the
          centering flex row. Without minWidth:0 a flex item's auto min-content
          floor lets a wide child (a long code line, a big table) stretch the whole
          page past the paper edge, dragging the margins and sheet backgrounds with
          it. Pinned here, wide content is instead contained by overflowCss above. */}
      {/* An image or figure cannot be split across a page, so pagination moves it
          whole — and one taller than the content band had nowhere to go but
          through the bottom margin and the sheets below. Capping it to the band
          makes an oversized image fit the page it lands on instead, which is what
          Word and Docs do. Scoped to page view: continuous flow has no band to
          fit, and `width:auto` keeps the aspect ratio while overflowCss's
          `max-width:100%` still holds the column.

          The 6em allowance is the image's own BLOCK chrome. The node view wraps
          the image in a block that carries the prose margins, so an image capped
          at exactly the band still produced a block taller than the band (864px
          of image inside a 931px block) — and because such an image is the first
          thing on its page, pagination rightly refuses to push it: the next page
          would be just as short. Expressed in em because those margins are
          em-based, so the allowance tracks the type size instead of assuming
          one. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `[data-testid="doc-page"] .ProseMirror :is(img, figure) { max-height: calc(${usable}px - 6em); width: auto; object-fit: contain; }`
        }}
      />
      <div className="relative" data-testid="doc-page" data-orientation={page.orientation} data-pages={pageCount} style={{ width: geom.w, minWidth: 0, maxWidth: geom.w, flexShrink: 0, minHeight: totalH }}>
        {/* One white sheet per page, each the real paper height, stacked with the
            gap between them so the grey canvas shows through as a true page split. */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          {Array.from({ length: pageCount }).map((_, i) => (
            <div
              key={i}
              data-testid="doc-page-sheet"
              className="absolute left-0 right-0 bg-white shadow-xl rounded-[2px]"
              style={{ top: i * stride, height: geom.h }}
            />
          ))}
          {/* A small page number in each gap. */}
          {Array.from({ length: Math.max(0, pageCount - 1) }).map((_, i) => (
            <span
              key={i}
              data-testid="doc-page-break"
              className="absolute right-2 text-[var(--ink-50)] fb-tabular"
              style={{ top: (i + 1) * stride - PAGE_GAP + Math.round((PAGE_GAP - 10) / 2), fontSize: 9, letterSpacing: '0.04em' }}
            >
              Page {i + 2}
            </span>
          ))}
          {/* Running header + footer in the top/bottom margin of every page. */}
          {(page.header?.text || page.header?.showPageNumber || page.footer?.text || page.footer?.showPageNumber) &&
            Array.from({ length: pageCount }).map((_, i) => (
              <div key={`hf-${i}`} data-testid={`doc-hf-${i}`}>
                {(page.header?.text || page.header?.showPageNumber) && (
                  <div
                    data-testid="doc-header"
                    className="absolute flex items-center text-[var(--ink-50)]"
                    style={{
                      top: i * stride + Math.max(6, geom.mTop / 2 - 7),
                      left: geom.mLeft,
                      width: geom.w - geom.mLeft - geom.mRight,
                      height: 14,
                      fontSize: 11
                    }}
                  >
                    <span className="flex-1 min-w-0 text-center truncate">{page.header?.text ?? ''}</span>
                    {page.header?.showPageNumber && <span className="fb-tabular pl-2">Page {i + 1}</span>}
                  </div>
                )}
                {(page.footer?.text || page.footer?.showPageNumber) && (
                  <div
                    data-testid="doc-footer"
                    className="absolute flex items-center text-[var(--ink-50)]"
                    style={{
                      top: i * stride + geom.h - Math.max(20, geom.mBottom / 2 + 7),
                      left: geom.mLeft,
                      width: geom.w - geom.mLeft - geom.mRight,
                      height: 14,
                      fontSize: 11
                    }}
                  >
                    <span className="flex-1 min-w-0 text-center truncate">{page.footer?.text ?? ''}</span>
                    {page.footer?.showPageNumber && <span className="fb-tabular pl-2">Page {i + 1}</span>}
                  </div>
                )}
              </div>
            ))}
        </div>

        {/* The flowing content sits on top of the sheets; the plugin's spacers
            create the real gaps that align it to each sheet. */}
        <div
          className="relative"
          data-testid="doc-page-content"
          style={{
            paddingTop: geom.mTop,
            paddingBottom: geom.mBottom,
            paddingLeft: geom.mLeft,
            paddingRight: geom.mRight
          }}
        >
          <EditorContent editor={editor} />
        </div>
      </div>
      </div>
    </div>
  )
}

// Live word count and reading-time estimate. Isolated into its own component so
// it can subscribe to every keystroke without re-rendering the whole editor.
// 220 wpm is a standard silent-reading pace; we show it as a real estimate, not
// a fabricated metric — an empty document reads as empty, not "1 min".
function ReadingMeta({ editor }: { editor: Editor }): JSX.Element {
  const [words, setWords] = useState<number>(() => editor.storage.characterCount?.words?.() ?? 0)
  useEffect(() => {
    const update = (): void => setWords(editor.storage.characterCount?.words?.() ?? 0)
    update()
    editor.on('update', update)
    return () => {
      editor.off('update', update)
    }
  }, [editor])
  const mins = Math.max(1, Math.round(words / 220))
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="doc-reading-meta">
      <Icon name="schedule" size={12} />
      <span>
        {words === 0
          ? 'Empty document'
          : `${words.toLocaleString()} word${words === 1 ? '' : 's'} · ${mins} min read`}
      </span>
    </span>
  )
}

interface DocCommandHandlers {
  toggleFocus: () => void
  toggleOutline: () => void
  togglePageView: () => void
  setPortrait: () => void
  setLandscape: () => void
  openFind: () => void
  draftAi: () => void
  rewriteAi: () => void
  insertImage: () => void
  insertTable: () => void
  insertWidget: () => void
  insertDoc: () => void
  importDocx: () => void
  exportDocx: () => void
  exportPdf: () => void
}

// The document editor's command catalog, published to the Cmd+K palette. Every
// formatting, structure, insert, view and Office action lives here so a power
// user never has to reach for the toolbar, which is the keyboard-first promise
// Word and Google Docs never delivered.
function buildDocCommands(editor: Editor | null, h: DocCommandHandlers): EditorCommand[] {
  if (!editor) return []
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()
  return [
    // Format
    { id: 'doc-bold', label: 'Bold', icon: 'format_bold', shortcut: '⌘B', group: 'Format', keywords: 'strong', run: () => chain().toggleBold().run() },
    { id: 'doc-italic', label: 'Italic', icon: 'format_italic', shortcut: '⌘I', group: 'Format', keywords: 'emphasis', run: () => chain().toggleItalic().run() },
    { id: 'doc-underline', label: 'Underline', icon: 'format_underlined', shortcut: '⌘U', group: 'Format', run: () => chain().toggleUnderline().run() },
    { id: 'doc-strike', label: 'Strikethrough', icon: 'strikethrough_s', group: 'Format', keywords: 'cross out', run: () => chain().toggleStrike().run() },
    { id: 'doc-code', label: 'Inline code', icon: 'code', group: 'Format', keywords: 'monospace', run: () => chain().toggleCode().run() },
    { id: 'doc-highlight', label: 'Highlight', icon: 'ink_highlighter', group: 'Format', keywords: 'mark', run: () => chain().toggleHighlight().run() },
    { id: 'doc-clear-format', label: 'Clear formatting', icon: 'format_clear', group: 'Format', keywords: 'remove strip reset marks', run: () => chain().unsetAllMarks().clearNodes().run() },
    // Structure
    { id: 'doc-h1', label: 'Heading 1', icon: 'title', group: 'Style', keywords: 'title big', run: () => chain().toggleHeading({ level: 1 }).run() },
    { id: 'doc-h2', label: 'Heading 2', icon: 'title', group: 'Style', keywords: 'subheading', run: () => chain().toggleHeading({ level: 2 }).run() },
    { id: 'doc-h3', label: 'Heading 3', icon: 'title', group: 'Style', keywords: 'subheading', run: () => chain().toggleHeading({ level: 3 }).run() },
    { id: 'doc-paragraph', label: 'Body text', icon: 'notes', group: 'Style', keywords: 'normal paragraph', run: () => chain().setParagraph().run() },
    { id: 'doc-bullets', label: 'Bulleted list', icon: 'format_list_bulleted', group: 'Style', keywords: 'unordered', run: () => chain().toggleBulletList().run() },
    { id: 'doc-numbers', label: 'Numbered list', icon: 'format_list_numbered', group: 'Style', keywords: 'ordered', run: () => chain().toggleOrderedList().run() },
    { id: 'doc-checklist', label: 'Checklist', icon: 'checklist', group: 'Style', keywords: 'task todo', run: () => chain().toggleTaskList().run() },
    { id: 'doc-quote', label: 'Quote block', icon: 'format_quote', group: 'Style', keywords: 'blockquote', run: () => chain().toggleBlockquote().run() },
    { id: 'doc-codeblock', label: 'Code block', icon: 'data_object', group: 'Style', keywords: 'snippet syntax', run: () => chain().toggleCodeBlock().run() },
    { id: 'doc-divider', label: 'Divider', icon: 'horizontal_rule', group: 'Style', keywords: 'horizontal rule separator', run: () => chain().setHorizontalRule().run() },
    // Align
    { id: 'doc-align-left', label: 'Align left', icon: 'format_align_left', group: 'Align', run: () => chain().setTextAlign('left').run() },
    { id: 'doc-align-center', label: 'Align centre', icon: 'format_align_center', group: 'Align', keywords: 'center', run: () => chain().setTextAlign('center').run() },
    { id: 'doc-align-right', label: 'Align right', icon: 'format_align_right', group: 'Align', run: () => chain().setTextAlign('right').run() },
    { id: 'doc-align-justify', label: 'Justify', icon: 'format_align_justify', group: 'Align', run: () => chain().setTextAlign('justify').run() },
    // Insert
    { id: 'doc-insert-image', label: 'Insert image', icon: 'image', group: 'Insert', keywords: 'picture photo', run: h.insertImage },
    { id: 'doc-insert-table', label: 'Insert table', icon: 'table_chart', group: 'Insert', keywords: 'grid', run: h.insertTable },
    { id: 'doc-insert-widget', label: 'Insert widget from a desk', icon: 'widgets', group: 'Insert', keywords: 'embed desk canvas', run: h.insertWidget },
    { id: 'doc-insert-doc', label: 'Insert office file', icon: 'description', group: 'Insert', keywords: 'embed document sheet slides plexioffice', run: h.insertDoc },
    // Find
    { id: 'doc-find', label: 'Find and replace', icon: 'search', shortcut: '⌘F', group: 'Edit', keywords: 'search replace', run: h.openFind },
    // AI
    { id: 'doc-ai-draft', label: 'Draft with AI', icon: 'auto_awesome', group: 'AI', keywords: 'generate write', run: h.draftAi },
    { id: 'doc-ai-rewrite', label: 'Rewrite selection with AI', icon: 'auto_awesome', group: 'AI', keywords: 'improve tone', run: h.rewriteAi },
    // View
    { id: 'doc-focus', label: 'Toggle focus mode', icon: 'center_focus_strong', group: 'View', keywords: 'zen distraction free writing', run: h.toggleFocus },
    { id: 'doc-outline', label: 'Toggle outline', icon: 'format_list_bulleted', group: 'View', keywords: 'navigation headings map', run: h.toggleOutline },
    { id: 'doc-pageview', label: 'Toggle page view', icon: 'description', group: 'View', keywords: 'page continuous print layout paper', run: h.togglePageView },
    { id: 'doc-portrait', label: 'Page orientation: portrait', icon: 'crop_portrait', group: 'View', keywords: 'orientation vertical tall', run: h.setPortrait },
    { id: 'doc-landscape', label: 'Page orientation: landscape', icon: 'crop_landscape', group: 'View', keywords: 'orientation horizontal wide', run: h.setLandscape },
    // Office
    { id: 'doc-import-docx', label: 'Import Word (.docx)', icon: 'upload_file', group: 'File', keywords: 'open word', run: h.importDocx },
    { id: 'doc-export-docx', label: 'Export Word (.docx)', icon: 'description', group: 'File', keywords: 'save word', run: h.exportDocx },
    { id: 'doc-export-pdf', label: 'Export PDF', icon: 'picture_as_pdf', group: 'File', keywords: 'save pdf', run: h.exportPdf }
  ]
}
