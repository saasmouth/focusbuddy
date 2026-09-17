import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { MapBody, SheetBody, SlidesBody } from '@shared/types'
import { useDocumentsStore } from '../../stores/documents'
import { useViewStore } from '../../stores/view'
import { useMessagingStore } from '../../stores/messaging'
import { useAccountStore } from '../../stores/account'
import { personDisplayName } from '../../lib/personName'
import { DocEditor, SheetEditor, SlidesEditor, MapEditor, DesignEditor, DrawStudio } from '@office'
import { promptText } from '../plexi/PromptDialog'
import Icon from '../Icon'
import DocFiledInChip from '../DocFiledInChip'
import ShareDialog from '../ShareDialog'

// Local-document comment row (matches the docComments IPC surface).
interface LocalComment {
  id: string
  parentId: string | null
  anchorId: string | null
  author: string
  body: string
  resolved: boolean
  createdAt: number
}

// Document editor — loads the active document and hands its body to the right
// surface (doc / sheet / slides). The header carries the editable title, a
// live "saved" indicator, and a way back to the hub. Body edits flow through
// the store's debounced autosave so nothing is lost.

interface Props {
  documentId: string
  // When provided (e.g. embedded inside the PlexiOffice shell), the back button
  // calls this instead of navigating to the global Documents/Design hub, so the
  // surrounding segment keeps its own chrome.
  onBack?: () => void
}

export default function DocumentEditorView({ documentId, onBack }: Props): JSX.Element {
  const active = useDocumentsStore((s) => s.active)
  const saving = useDocumentsStore((s) => s.saving)
  const saveError = useDocumentsStore((s) => s.saveError)
  const open = useDocumentsStore((s) => s.open)
  const close = useDocumentsStore((s) => s.close)
  const saveBody = useDocumentsStore((s) => s.saveBody)
  const rename = useDocumentsStore((s) => s.rename)
  const goDocuments = useViewStore((s) => s.goDocuments)
  const openObjectChannel = useMessagingStore((s) => s.openObjectChannel)
  const goDesign = useViewStore((s) => s.goDesign)
  // The signed-in user's name greets them in the AI Assistant panel. Omitted when
  // signed out, so the panel falls back to a neutral greeting (no fabricated name).
  const account = useAccountStore((s) => s.account)
  const userName = account ? personDisplayName(account, account.email) : null

  useEffect(() => {
    void open(documentId)
    return () => close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  // Local comments. Live/collaborative docs keep comments on the signal
  // server (LiveDocEditorView); ordinary local docs store them in SQLite via
  // the docComments IPC, so the panel works signed out too.
  const [editor, setEditor] = useState<Editor | null>(null)
  const [comments, setComments] = useState<LocalComment[]>([])
  // Share this office file directly from its editor.
  const [shareOpen, setShareOpen] = useState(false)
  useEffect(() => {
    setComments([])
    void window.api.documents.listComments(documentId).then(setComments)
  }, [documentId])

  const author = userName ?? 'You'
  // Who a comment can @mention: the real participants in this document's comment
  // thread plus the signed-in user, restricted to handle-shaped tokens so an
  // inserted @mention actually resolves. No invented members.
  const isHandle = (h: string): boolean => /^[a-z0-9._-]{2,32}$/i.test(h)
  const mentionHandles = Array.from(
    new Set(
      [author, ...comments.map((c) => c.author)]
        .filter((h): h is string => !!h && isHandle(h))
        .map((h) => h)
    )
  )
  const panelThreads = comments
    .filter((c) => !c.parentId)
    .map((root) => ({
      id: root.id,
      author: root.author || 'You',
      createdAt: root.createdAt,
      body: root.body,
      resolved: root.resolved,
      you: true, // single-user local doc: every comment is the local user's
      replies: comments
        .filter((c) => c.parentId === root.id)
        .map((r) => ({ id: r.id, author: r.author || 'You', createdAt: r.createdAt, body: r.body, you: true }))
    }))

  async function addComment(): Promise<void> {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    if (empty) {
      void promptText({
        title: 'Select some text first',
        label: 'Highlight the passage the comment is about, then add the comment.',
        confirmLabel: 'OK',
        confirmOnly: true
      })
      return
    }
    const body = await promptText({ title: 'New comment', multiline: true, confirmLabel: 'Comment' })
    if (!body || !body.trim()) return
    const anchorId = 'cmt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    editor.chain().setTextSelection({ from, to }).setComment(anchorId).run()
    const created = await window.api.documents.addComment({
      docId: documentId,
      body: body.trim(),
      author,
      anchorId
    })
    setComments((prev) => [...prev, created])
  }

  async function replyComment(threadId: string, body: string): Promise<void> {
    if (!body.trim()) return
    const created = await window.api.documents.addComment({
      docId: documentId,
      body: body.trim(),
      author,
      parentId: threadId
    })
    setComments((prev) => [...prev, created])
  }

  function jumpToComment(threadId: string): void {
    const anchor = comments.find((c) => c.id === threadId)?.anchorId
    if (!anchor || !editor) return
    // Scroll the highlighted mark into view by locating its DOM node.
    const el = editor.view.dom.querySelector(`[data-comment-id="${anchor}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  if (!active || active.id !== documentId) {
    return (
      <div className="h-full flex items-center justify-center desk-paper no-tod text-[13px] text-stone-400">
        Loading…
      </div>
    )
  }

  const typeLabel =
    active.docType === 'doc'
      ? 'Document'
      : active.docType === 'sheet'
        ? 'Spreadsheet'
        : active.docType === 'slides'
          ? 'Slides'
          : active.docType === 'design'
            ? 'Design'
            : active.docType === 'draw'
              ? 'Artwork'
              : 'Diagram'
  const typeIcon =
    active.docType === 'doc'
      ? 'description'
      : active.docType === 'sheet'
        ? 'table_chart'
        : active.docType === 'slides'
          ? 'slideshow'
          : active.docType === 'design'
            ? 'palette'
            : active.docType === 'draw'
              ? 'brush'
              : 'account_tree'

  return (
    <div className="h-full flex flex-col desk-paper no-tod">
      {/* Header */}
      <div className="shrink-0 px-4 py-2.5 border-b border-[var(--edge-soft)] flex items-center gap-3">
        <button
          onClick={() => {
            close()
            if (onBack) onBack()
            else if (active.docType === 'design') goDesign()
            else goDocuments()
          }}
          className="icon-btn"
          title={onBack ? 'Back to PlexiOffice' : active.docType === 'design' ? 'Back to PlexiDesign' : 'Back to Documents'}
        >
          <Icon name="arrow_back" size={17} />
        </button>
        <Icon name={typeIcon} size={16} className="text-accent shrink-0" />
        <input
          value={active.title}
          onChange={(e) => void rename(e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-[14px] font-semibold text-stone-900 dark:text-stone-100"
        />
        <DocFiledInChip docId={active.id} className="shrink-0 max-w-[220px]" />
        <button
          onClick={() => void openObjectChannel('document', active.id, active.title || 'Document')}
          title="Chat about this document"
          data-testid="doc-chat-button"
          className="shrink-0 icon-btn !h-7 !w-7 text-stone-400 dark:text-stone-500 hover:text-accent"
        >
          <Icon name="forum" size={15} />
        </button>
        <button
          onClick={() => setShareOpen(true)}
          title="Share this file"
          aria-label="Share this file"
          data-testid="doc-share-button"
          className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md text-[12px] font-medium text-stone-500 dark:text-stone-400 hover:text-accent hover:bg-[var(--surface-sunken)]"
        >
          <Icon name="ios_share" size={14} />
          Share
        </button>
        {saveError ? (
          <span
            className="text-[11px] text-red-600 dark:text-red-400 inline-flex items-center gap-1 shrink-0"
            title="The last change could not be saved to disk. Your edits are still here; they will be retried when you next type."
            data-testid="doc-save-error"
          >
            <Icon name="error_outline" size={13} />
            Couldn&apos;t save
          </span>
        ) : (
          <span className="text-[11px] text-stone-400 dark:text-stone-500 inline-flex items-center gap-1 shrink-0">
            <Icon name={saving ? 'sync' : 'cloud_done'} size={13} className={saving ? 'animate-spin' : 'text-emerald-500'} />
            {saving ? 'Saving' : 'Saved'}
          </span>
        )}
        <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0">{typeLabel}</span>
      </div>

      {/* Surface */}
      <div className="flex-1 overflow-auto min-h-0">
        {active.docType === 'doc' && (
          <DocEditor
            key={active.id}
            content={active.body}
            title={active.title}
            onChange={(json) => saveBody(json)}
            userName={userName}
            onEditorReady={setEditor}
            comments={panelThreads}
            canComment
            onAddComment={() => void addComment()}
            onReplyComment={(threadId, body) => void replyComment(threadId, body)}
            onJumpComment={jumpToComment}
            mentionHandles={mentionHandles}
            myHandle={userName}
          />
        )}
        {active.docType === 'sheet' && (
          <SheetEditor key={active.id} body={active.body as SheetBody} title={active.title} onChange={(b) => saveBody(b)} />
        )}
        {active.docType === 'slides' && (
          <SlidesEditor key={active.id} body={active.body as SlidesBody} title={active.title} onChange={(b) => saveBody(b)} />
        )}
        {active.docType === 'map' && (
          <MapEditor key={active.id} body={active.body as MapBody} title={active.title} onChange={(b) => saveBody(b)} />
        )}
        {active.docType === 'design' && (
          <DesignEditor key={active.id} content={active.body} title={active.title} onChange={(b) => saveBody(b)} />
        )}
        {active.docType === 'draw' && (
          <DrawStudio key={active.id} content={active.body} title={active.title} onChange={(b) => saveBody(b)} />
        )}
      </div>
      {shareOpen && (
        <ShareDialog
          kind="document"
          entityId={active.id}
          label={active.title || 'Document'}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  )
}
