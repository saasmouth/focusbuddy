import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { MapBody, SheetBody, SlidesBody } from '@shared/types'
import { useDocumentsStore } from '../../stores/documents'
import { useViewStore } from '../../stores/view'
import { useMessagingStore } from '../../stores/messaging'
import { useAccountStore } from '../../stores/account'
import { useSignInPrompt } from '../../stores/signInPrompt'
import { personDisplayName } from '../../lib/personName'
import { commentMentionHandles } from '../../lib/mentions'
import { DocEditor, SheetEditor, SlidesEditor, MapEditor, DesignEditor, DrawStudio } from '@office'
import { createDocumentOps } from '../documents/editor/documentOps'
import DocumentConflictBar from '../documents/DocumentConflictBar'
import { localAnchorFor, positionText, resolveForEditor } from '../documents/editor/commentPositions'
import { anchorToPersist } from '../documents/editor/commentWriteBack'
import { promptText } from '../plexi/PromptDialog'
import Icon from '../Icon'
import { PlexiiDocIcon } from '../PlexiiIcon'
import DocFiledInChip from '../DocFiledInChip'
import ShareDialog from '../ShareDialog'

// Local-document comment row (matches the docComments IPC surface).
interface LocalComment {
  id: string
  parentId: string | null
  /** The OLD mark-based anchor. Only comments written before `anchor` have one. */
  anchorId: string | null
  /** The anchor JSON: a range plus a quote of the commented text. */
  anchor: string | null
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
  const goDocument = useViewStore((s) => s.goDocument)
  const conflict = useDocumentsStore((s) => s.conflict)
  // In every editor's key: an external body change must REMOUNT the editor,
  // because none of them re-seed from a prop (see the store's bodyEpoch).
  const bodyEpoch = useDocumentsStore((s) => s.bodyEpoch)
  const resolveConflict = useDocumentsStore((s) => s.resolveConflict)
  const openObjectChannel = useMessagingStore((s) => s.openObjectChannel)
  const goDesign = useViewStore((s) => s.goDesign)
  // The signed-in user's name greets them in the AI Assistant panel. Omitted when
  // signed out, so the panel falls back to a neutral greeting (no fabricated name).
  const account = useAccountStore((s) => s.account)
  // Commenting needs an account, on a LOCAL document too (owner's ruling,
  // 4.3.41). A comment is attributed to a person, and an unattributed one
  // helps nobody once the document is shared — which a local document can be
  // at any time, carrying its comments with it.
  //
  // Reading is NOT gated: comments already written stay visible signed out,
  // and the action is replaced by "Sign in to comment" rather than hidden, so
  // nobody is left wondering whether this document supports comments.
  const requestSignIn = useSignInPrompt((s) => s.requestOpen)
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
  // Who a comment can @mention: the signed-in account's HANDLE, plus any
  // handle-shaped author string already in the thread. No invented members.
  //
  // THIS READ THE DISPLAY NAME, and worked only while accounts had no names —
  // a nameless account displays as its handle, so the two were one string.
  // Required names (4.3.41) made the display name "Dana Reed", which is not
  // handle-shaped, so the pool came out empty and the "@" autocomplete stopped
  // opening at all. commentMentionHandles carries the reasoning and the tests.
  const mentionHandles = commentMentionHandles(
    account?.handle,
    comments.map((c) => c.author)
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

  // Where every thread belongs in the document as it now stands, pushed into
  // the editor as decorations.
  //
  // Deliberately NOT on every keystroke: the decorations already map through
  // transactions, so they follow typing on their own. This re-resolves only
  // when the thread list changes or the editor is rebuilt — and the editor is
  // rebuilt whenever the body is replaced from outside (bodyEpoch), which is
  // the one case with no transaction history to map through.
  useEffect(() => {
    if (!editor) return
    // Only threads that HAVE an anchor. A comment anchored the old way, by a
    // mark in the body, is not orphaned — it is fine, and it keeps its
    // CommentMark highlight. Passing it here would report "comment on removed
    // text" about a perfectly good comment, which would be a lie.
    const threads = comments
      .filter((c) => !c.parentId && c.anchor != null)
      .map((c) => ({ id: c.id, anchor: c.anchor, state: c.resolved ? ('resolved' as const) : ('open' as const) }))
    if (threads.length === 0) {
      editor.commands.setCommentRanges([])
      return
    }
    const { ranges } = resolveForEditor(editor, threads)
    editor.commands.setCommentRanges(ranges)

    // Persist an anchor the resolver had to re-find, and refresh a quote whose
    // text was edited in place. Both are the same thing from the database's
    // side: store what is true now so the next open does not have to search.
    const docText = positionText(editor.state.doc)
    for (const r of ranges) {
      const thread = threads.find((t) => t.id === r.id)
      if (!thread) continue
      // One rule, shared with the live host: local anchors only, and only when
      // the range or the quote actually changed. See commentWriteBack.ts.
      const write = anchorToPersist(thread, r, docText)
      if (!write) continue
      void window.api.documents.setCommentAnchor(r.id, write.json).then((ok) => {
        if (!ok) return
        setComments((prev) => prev.map((c) => (c.id === r.id ? { ...c, anchor: write.json } : c)))
      })
    }
    // `comments` is the thread list; bodyEpoch is the editor being rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, comments, bodyEpoch])

  async function addComment(): Promise<void> {
    if (!editor) return
    // The button is already replaced by "Sign in to comment" when signed out,
    // so this is the second line rather than the first — for a keyboard path
    // or a future caller that does not go through the panel. A comment with
    // no account behind it cannot be attributed to anyone.
    if (!account) {
      requestSignIn()
      return
    }
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
    // NO setComment. Applying the mark is a document write — it is why a
    // viewer could never comment — and the anchor now lives with the comment
    // instead. Doing both would also render .22 over .22 and a doubled border,
    // since the decoration carries the same fb-comment class as the mark.
    const anchor = JSON.stringify(localAnchorFor(editor, from, to))
    const created = await window.api.documents.addComment({
      docId: documentId,
      body: body.trim(),
      author,
      anchor
    })
    setComments((prev) => [...prev, created])
  }

  async function replyComment(threadId: string, body: string): Promise<void> {
    if (!body.trim()) return
    // The same requirement as addComment, for the same reason, and it was
    // missing here: `author` falls back to 'You' when signed out, so a reply
    // went in unattributed — the one thing requiring an account prevents.
    // The panel no longer offers the box, so this is the second line.
    if (!account) {
      requestSignIn()
      return
    }
    const created = await window.api.documents.addComment({
      docId: documentId,
      body: body.trim(),
      author,
      parentId: threadId
    })
    setComments((prev) => [...prev, created])
  }

  function jumpToComment(threadId: string): void {
    if (!editor) return
    const row = comments.find((c) => c.id === threadId)
    // A thread anchored the NEW way has no mark to find in the DOM, and the
    // old query looked for the ANCHOR id while a decoration carries the THREAD
    // id — two different ids, so it would have silently stopped scrolling for
    // every new comment. Resolve the range and scroll to it instead: the
    // document is the source of truth, not the rendered markup.
    if (row?.anchor != null) {
      const { ranges } = resolveForEditor(editor, [{ id: threadId, anchor: row.anchor }])
      const r = ranges[0]
      if (r) {
        editor.chain().setTextSelection({ from: r.from, to: r.to }).scrollIntoView().run()
        return
      }
    }
    // An older, mark-anchored comment: its highlight IS in the DOM.
    const anchorId = row?.anchorId
    if (!anchorId) return
    const el = editor.view.dom.querySelector(`[data-comment-id="${anchorId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  if (!active || active.id !== documentId) {
    return (
      <div className="h-full flex items-center justify-center desk-paper no-tod text-[13px] text-stone-400">
        Loading…
      </div>
    )
  }

  // What this view's File menus act on. Built after the guard above, so it is
  // bound to the document actually open here. In THIS view that happens to be
  // the store's active document, but it is passed explicitly all the same,
  // because the same editors are mounted on desks and in snippet sessions where
  // it is not — which was the bug.
  //
  // One object serves every editor below: this view shows exactly one document,
  // so its id and type are the right binding for all of them.
  //
  // Not memoised and not a hook: createDocumentOps is a plain factory that
  // closes over its inputs, it sits after an early return where hooks are not
  // allowed, and rebuilding it per render costs nothing.
  const documentOps = createDocumentOps({
    id: documentId,
    docType: active.docType,
    // Read at call time from the store, so a rename between renders cannot
    // leave a prompt or a copy name showing a stale title.
    title: () => useDocumentsStore.getState().active?.title ?? '',
    onOpen: (id) => goDocument(id),
    onTrashed: () => goDocuments()
    // No onRenamed: the title rendered here comes from the store, which
    // renameById has already updated by the time it resolves.
  })

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
          title={onBack ? 'Back to PlexiiOffice' : active.docType === 'design' ? 'Back to PlexiiDesign' : 'Back to Documents'}
        >
          <Icon name="arrow_back" size={17} />
        </button>
        <PlexiiDocIcon docType={active.docType} size={18} fallback={typeIcon} fallbackClassName="text-accent" className="shrink-0" />
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
            key={`${active.id}:${bodyEpoch}`}
            content={active.body}
            title={active.title}
            onChange={(json) => saveBody(json)}
            userName={userName}
            onEditorReady={setEditor}
            comments={panelThreads}
            canComment={!!account}
            onSignIn={requestSignIn}
            onAddComment={() => void addComment()}
            onReplyComment={(threadId, body) => void replyComment(threadId, body)}
            onJumpComment={jumpToComment}
            mentionHandles={mentionHandles}
            // A HANDLE, not the display name: MentionText lowercases this and
            // compares it to the "@token" it parsed, so "Dana Reed" could
            // never match and a mention of yourself rendered as somebody
            // else's. LiveDocEditorView passes `me?.handle` here for the same
            // reason.
            myHandle={account?.handle ?? null}
            documentOps={documentOps}
          />
        )}
        {active.docType === 'sheet' && (
          <SheetEditor
            key={`${active.id}:${bodyEpoch}`}
            body={active.body as SheetBody}
            title={active.title}
            onChange={(b) => saveBody(b)}
            documentOps={documentOps}
          />
        )}
        {active.docType === 'slides' && (
          <SlidesEditor key={`${active.id}:${bodyEpoch}`} body={active.body as SlidesBody} title={active.title} onChange={(b) => saveBody(b)} documentOps={documentOps} />
        )}
        {active.docType === 'map' && (
          <MapEditor key={`${active.id}:${bodyEpoch}`} body={active.body as MapBody} title={active.title} onChange={(b) => saveBody(b)} documentOps={documentOps} />
        )}
        {active.docType === 'design' && (
          <DesignEditor
            key={`${active.id}:${bodyEpoch}`}
            content={active.body}
            title={active.title}
            onChange={(b) => saveBody(b)}
            documentOps={documentOps}
          />
        )}
        {active.docType === 'draw' && (
          <DrawStudio key={`${active.id}:${bodyEpoch}`} content={active.body} title={active.title} onChange={(b) => saveBody(b)} documentOps={documentOps} />
        )}
      </div>
      {/* Below the surface, not over it: the text being decided about has to
          stay visible while the decision is made. Only shown for THIS document
          — the store holds one conflict, keyed by id, because a save refused
          for a document the user has since navigated away from is not something
          to interrupt them about here. */}
      {conflict && conflict.id === active.id && (
        <DocumentConflictBar
          theirs={conflict.theirs}
          onTheirs={() => void resolveConflict('theirs')}
          onMine={() => void resolveConflict('mine')}
          onCopy={() => void resolveConflict('copy')}
        />
      )}
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
