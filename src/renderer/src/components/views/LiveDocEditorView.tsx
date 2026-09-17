import { useEffect, useRef, useState } from 'react'
import type { SheetBody, SlidesBody, MapBody } from '@shared/types'
import { useDocCollabStore } from '../../stores/docCollab'
import { useViewStore } from '../../stores/view'
import { useMessagingStore } from '../../stores/messaging'
import { useAccountStore } from '../../stores/account'
import {
  inviteToLiveDoc,
  snapshotLiveBody,
  listComments,
  addComment,
  resolveComment,
  deleteComment,
  type DocComment
} from '../../lib/docCollabClient'
import { setDocCommentHandler } from '../../lib/messagingSocket'
import { isCrossUserMention } from '../../lib/mentions'
import { notifyExternal } from '../../lib/notify'
import CommentsPanel from './CommentsPanel'
import type { Editor } from '@tiptap/react'
import { listTeams, inviteTeamToDoc, type Team } from '../../lib/teamsClient'
import { DocEditor, SheetEditor, SlidesEditor, MapEditor, DesignEditor, DrawStudio } from '@office'
import Icon from '../Icon'
import CollaboratorBar from './CollaboratorBar'
import { collaborators } from '../../lib/presence'
import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import { buildDocExtensions } from '../documents/editor/extensions'
import { parseDocBody } from '../documents/editor/headingStyles'
import { seedYDocFromPm } from '../../lib/yjsSeed'
import { reconcileMap, yToJson } from '../../lib/yjsJson'
import { YjsDocSync } from '../../lib/yjsDocSync'
import { sendSocketMessage, setYjsSocketHandler, setSocketOpenHandler } from '../../lib/messagingSocket'

// Editor for a LIVE (collaborative) document. The body lives on the server; this
// view checks the doc out (acquires the edit lock) and, while it holds the lock,
// autosaves to the server with a heartbeat. When someone else holds the lock the
// surface is read-only (marked inert) with a banner and a "Request access"
// button; the takeover handshake transfers the lock without losing anyone's work.

interface Props {
  liveDocId: string
  // Where "back" goes. Defaults to the desk's Documents view; PlexiOffice passes
  // its own handler since it has no desk routing.
  onBack?: () => void
}

// The whole-body JSON editors that co-edit through the reconcile engine. The doc
// type uses the Tiptap binding instead; everything here shares one code path.
const JSON_COEDIT_TYPES = ['sheet', 'slides', 'map', 'design', 'draw'] as const
type JsonCoeditType = (typeof JSON_COEDIT_TYPES)[number]
function isJsonCoedit(t: string | undefined): t is JsonCoeditType {
  return !!t && (JSON_COEDIT_TYPES as readonly string[]).includes(t)
}

export default function LiveDocEditorView({ liveDocId, onBack }: Props): JSX.Element {
  const meta = useDocCollabStore((s) => s.meta)
  const bodyObj = useDocCollabStore((s) => s.bodyObj)
  const loading = useDocCollabStore((s) => s.loading)
  const openLive = useDocCollabStore((s) => s.openLive)
  const closeLive = useDocCollabStore((s) => s.closeLive)
  const goDocuments = useViewStore((s) => s.goDocuments)
  const openObjectChannel = useMessagingStore((s) => s.openObjectChannel)
  const back = onBack ?? goDocuments
  const myId = useAccountStore((s) => s.account?.id)
  const token = useAccountStore((s) => s.sessionToken)

  const [inviting, setInviting] = useState(false)
  const [inviteHandle, setInviteHandle] = useState('')
  const [inviteNote, setInviteNote] = useState<string | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  // Real-time co-editing for documents (other types still use check-out). We hold
  // the Y.Doc + provider in a ref and flip a state flag once it's live so the
  // editor re-renders with it.
  const collabRef = useRef<{ docId: string; ydoc: Y.Doc; sync: YjsDocSync } | null>(null)
  const [collabReady, setCollabReady] = useState(false)
  // Debounce the body snapshot so co-editing writes storage at most every few
  // seconds, not on every keystroke.
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Comments: the live editor instance (to anchor marks + jump), the threads,
  // the panel toggle, and the in-progress new-comment composer.
  const [editor, setEditor] = useState<Editor | null>(null)
  const [comments, setComments] = useState<DocComment[]>([])
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [focusComment, setFocusComment] = useState<string | null>(null)
  const [composing, setComposing] = useState<{ from: number; to: number } | null>(null)
  const [composeText, setComposeText] = useState('')
  // JSON-body co-editing for sheets/slides (the doc path uses the Tiptap binding
  // above). The Y.Doc holds the body via the reconcile engine; remote changes
  // refresh collabBody + bump collabVersion (which re-keys the editor), while
  // local edits reconcile in under a private origin so they don't re-key.
  const jsonCollabRef = useRef<{ docId: string; ydoc: Y.Doc; sync: YjsDocSync; root: Y.Map<unknown> } | null>(null)
  const localOriginRef = useRef<object>({})
  const [collabBody, setCollabBody] = useState<unknown>(null)

  useEffect(() => {
    // Live docs co-edit via Yjs (Tiptap for 'doc', the JSON reconcile engine for
    // sheet/slides/map/design), so there is no check-out lock — openLive just
    // fetches the doc's meta + baseline body for the Yjs session to seed from.
    void openLive(liveDocId)
    return () => closeLive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveDocId])

  // Stand up the CRDT session for documents once the doc has loaded. The provider
  // joins the server room and replays the log; if nothing replays (a fresh doc),
  // onFirstSync seeds it from the body — idempotently, so a join race can't double
  // the content. Other members' edits arrive through the same socket.
  useEffect(() => {
    if (!meta || meta.id !== liveDocId || meta.docType !== 'doc') return
    if (collabRef.current?.docId === liveDocId) return
    const ydoc = new Y.Doc()
    const seed = (): void => {
      try {
        const body = useDocCollabStore.getState().bodyObj
        const pm = (parseDocBody(body).doc as object) ?? { type: 'doc', content: [{ type: 'paragraph' }] }
        seedYDocFromPm(ydoc, pm, getSchema(buildDocExtensions({ interactive: false })))
      } catch {
        /* best-effort seed; an empty doc is recoverable, a duplicated one is not */
      }
    }
    const sync = new YjsDocSync(liveDocId, ydoc, sendSocketMessage, seed)
    setYjsSocketHandler((e) => sync.handleMessage(e))
    // On every (re)connect, re-join the room and push our state so a dropped
    // socket doesn't silently end co-editing or lose offline edits.
    setSocketOpenHandler(() => sync.rejoin())
    const acct = useAccountStore.getState().account?.id
    if (acct) sync.awareness.setLocalStateField('account', acct)
    collabRef.current = { docId: liveDocId, ydoc, sync }
    setCollabReady(true)
    return () => {
      setYjsSocketHandler(null)
      setSocketOpenHandler(null)
      if (snapshotTimer.current) clearTimeout(snapshotTimer.current)
      sync.destroy()
      ydoc.destroy()
      collabRef.current = null
      setCollabReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, meta?.docType, liveDocId])

  // Load comments for the open document and apply live changes from the socket.
  useEffect(() => {
    if (!meta || meta.id !== liveDocId || meta.docType !== 'doc') return
    const tok = useAccountStore.getState().sessionToken
    if (tok) void listComments(tok, liveDocId).then(setComments).catch(() => setComments([]))
    setDocCommentHandler((e) => {
      if (e.docId !== liveDocId) return
      setComments((prev) => {
        if (e.action === 'deleted') return prev.filter((c) => c.id !== e.comment.id && c.parentId !== e.comment.id)
        return [...prev.filter((c) => c.id !== e.comment.id), e.comment]
      })
      // Cross-user @mention alert: when someone else's comment names my handle,
      // notify me even if the app is focused elsewhere. Read straight from the
      // account store so the closure never holds a stale handle. This runs on the
      // comment already delivered by the socket, so it needs no server change.
      if (e.action !== 'deleted') {
        const acct = useAccountStore.getState().account
        if (isCrossUserMention(e.comment.body, e.comment.authorAccountId, acct?.id, acct?.handle ?? null)) {
          notifyExternal('You were mentioned in a document', e.comment.body.slice(0, 140), {
            force: true,
            tag: `docmention-${e.comment.id}`,
            onClick: () => {
              setCommentsOpen(true)
              setFocusComment(e.comment.parentId ?? e.comment.id)
            }
          })
        }
      }
    })
    return () => setDocCommentHandler(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, meta?.docType, liveDocId])

  // CRDT session for sheets/slides/maps/designs via the JSON reconcile engine.
  // These are all whole-body JSON editors, so the same reconcile+observe path
  // drives genuine simultaneous editing for every one of them; only the plain
  // document uses the Tiptap binding above.
  useEffect(() => {
    if (!meta || meta.id !== liveDocId || !isJsonCoedit(meta.docType)) return
    if (jsonCollabRef.current?.docId === liveDocId) return
    const ydoc = new Y.Doc()
    const root = ydoc.getMap('root')
    const LOCAL = {}
    localOriginRef.current = LOCAL
    const refresh = (): void => {
      // yToJson returns a fresh object each time, so the editor's body prop
      // changes identity and its body-sync effect folds the merge in.
      const body = yToJson(root)
      setCollabBody(body)
      // Persist remote edits too (the elected writer may just be watching);
      // scheduleSnapshot self-gates so only that one client actually writes.
      scheduleSnapshot(body)
    }
    // Remote changes (origin not our local marker) refresh + re-key the editor.
    const observer = (_events: unknown, txn: { origin: unknown }): void => {
      if (txn.origin === LOCAL) return
      refresh()
    }
    root.observeDeep(observer)
    const seed = (): void => {
      if (root.size > 0) {
        refresh()
        return
      }
      const body = useDocCollabStore.getState().bodyObj
      if (body && typeof body === 'object') {
        Y.transact(ydoc, () => reconcileMap(root, body as Record<string, unknown>), LOCAL)
      }
      refresh()
    }
    const sync = new YjsDocSync(liveDocId, ydoc, sendSocketMessage, seed)
    setYjsSocketHandler((e) => sync.handleMessage(e))
    setSocketOpenHandler(() => sync.rejoin())
    const acct = useAccountStore.getState().account?.id
    if (acct) sync.awareness.setLocalStateField('account', acct)
    jsonCollabRef.current = { docId: liveDocId, ydoc, sync, root }
    return () => {
      root.unobserveDeep(observer)
      setYjsSocketHandler(null)
      setSocketOpenHandler(null)
      if (snapshotTimer.current) clearTimeout(snapshotTimer.current)
      sync.destroy()
      ydoc.destroy()
      jsonCollabRef.current = null
      setCollabBody(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, meta?.docType, liveDocId])

  // Enforce read-only for non-holders by marking the editor subtree inert (the
  // server also rejects writes without the lock, so this is belt-and-braces).
  useEffect(() => {
    // Every live editor type co-edits in real time (Tiptap for 'doc', the JSON
    // reconcile engine for the rest), so the surface is never inert — there is no
    // check-out lock any more.
    const el = surfaceRef.current
    if (el) (el as unknown as { inert: boolean }).inert = false
  }, [meta, bodyObj])

  // Load the owner's teams when the invite panel opens, so they can invite a whole
  // team at once. Above the early return to keep hook order stable.
  useEffect(() => {
    if (inviting && token) void listTeams(token).then(setTeams).catch(() => setTeams([]))
  }, [inviting, token])

  if (loading || !meta || meta.id !== liveDocId) {
    return (
      <div className="h-full flex items-center justify-center desk-paper no-tod text-[13px] text-[var(--ink-40)]">
        Loading shared document…
      </div>
    )
  }

  const typeLabel =
    meta.docType === 'doc'
      ? 'Document'
      : meta.docType === 'sheet'
        ? 'Spreadsheet'
        : meta.docType === 'slides'
          ? 'Slides'
          : meta.docType === 'design'
            ? 'Design'
            : meta.docType === 'draw'
              ? 'Artwork'
              : 'Diagram'
  const typeIcon =
    meta.docType === 'doc'
      ? 'description'
      : meta.docType === 'sheet'
        ? 'table_chart'
        : meta.docType === 'slides'
          ? 'slideshow'
          : meta.docType === 'design'
            ? 'palette'
            : meta.docType === 'draw'
              ? 'brush'
              : 'account_tree'
  const isOwner = meta.ownerAccountId === myId
  // Comments are a document-only feature for now.
  const canComment = meta.docType === 'doc'
  // Awareness: who has access. No lock any more, so no holder is highlighted.
  const people = collaborators(meta.members ?? [], null, myId ?? null)
  // The label + colour shown on my caret to the other editors.
  const me = people.find((p) => p.you)
  const meUser = { name: me?.name ?? 'You', color: me?.color ?? '#888888' }
  // Who a comment can @mention: the real collaborators on this document (their
  // handles), restricted to handle-shaped tokens. No invented members.
  const mentionHandles = Array.from(
    new Set(people.map((p) => p.handle).filter((h): h is string => !!h && /^[a-z0-9._-]{2,32}$/i.test(h)))
  )

  // Snapshot the live Yjs content back to stored body_json (debounced), so
  // exports and non-live views of this doc track what people are typing.
  // Elect a single snapshot writer so N collaborators don't all write body_json.
  // The writer is the lowest accountId currently present (every surface's provider
  // publishes its account in awareness). Deterministic, so all clients agree, and
  // it self-heals when the writer leaves — the next-lowest takes over.
  function amSnapshotWriter(): boolean {
    const me = useAccountStore.getState().account?.id
    if (!me) return false
    const sync = collabRef.current?.sync ?? jsonCollabRef.current?.sync
    if (!sync) return false
    const present = [...sync.awareness.getStates().values()]
      .map((s) => (s as { account?: string })?.account)
      .filter((a): a is string => typeof a === 'string')
    if (!present.includes(me)) present.push(me)
    return me === [...present].sort()[0]
  }

  function scheduleSnapshot(json: unknown): void {
    if (snapshotTimer.current) clearTimeout(snapshotTimer.current)
    snapshotTimer.current = setTimeout(() => {
      if (!amSnapshotWriter()) return // only the elected writer persists the body
      const tok = useAccountStore.getState().sessionToken
      if (tok) void snapshotLiveBody(tok, liveDocId, JSON.stringify(json))
    }, 3000)
  }

  // A local sheet/slides edit: reconcile the new body into the CRDT (private
  // origin so it doesn't re-key us) and snapshot it to storage.
  function onJsonChange(body: unknown): void {
    const ref = jsonCollabRef.current
    if (!ref || !body || typeof body !== 'object') return
    Y.transact(ref.ydoc, () => reconcileMap(ref.root, body as Record<string, unknown>), localOriginRef.current)
    scheduleSnapshot(body)
  }

  // Resolve an author id to a handle for the panel (members cover comment authors).
  const handleOf = (id: string): string => people.find((p) => p.accountId === id)?.handle ?? id

  // Shape the real server comment threads for the in-editor side panel. Roots are
  // threads; replies nest under their root. Nothing here is fabricated, it is the
  // exact server data the floating CommentsPanel also reads.
  const panelThreads = comments
    .filter((c) => !c.parentId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((root) => ({
      id: root.id,
      author: handleOf(root.authorAccountId),
      createdAt: root.createdAt,
      body: root.body,
      resolved: !!root.resolved,
      you: root.authorAccountId === myId,
      replies: comments
        .filter((c) => c.parentId === root.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => ({
          id: r.id,
          author: handleOf(r.authorAccountId),
          createdAt: r.createdAt,
          body: r.body,
          you: r.authorAccountId === myId
        }))
    }))

  // Start a comment on the current selection: capture the range and open the
  // composer. Applying the mark waits until the body is typed and saved.
  function startComment(): void {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    if (empty) return
    setCommentsOpen(true)
    setComposing({ from, to })
    setComposeText('')
  }

  async function submitComment(): Promise<void> {
    const text = composeText.trim()
    const tok = useAccountStore.getState().sessionToken
    if (!editor || !composing || !text || !tok) return
    const id = 'cmt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    editor.chain().setTextSelection({ from: composing.from, to: composing.to }).setComment(id).run()
    const created = await addComment(tok, liveDocId, text, { id })
    if (created) setComments((prev) => [...prev.filter((c) => c.id !== created.id), created])
    else editor.commands.unsetComment(id) // save failed — drop the orphan mark
    setComposing(null)
    setComposeText('')
  }

  async function replyToComment(rootId: string, body: string): Promise<void> {
    const tok = useAccountStore.getState().sessionToken
    if (!tok) return
    const created = await addComment(tok, liveDocId, body, { parentId: rootId })
    if (created) setComments((prev) => [...prev.filter((c) => c.id !== created.id), created])
  }

  async function resolveThread(rootId: string, resolved: boolean): Promise<void> {
    const tok = useAccountStore.getState().sessionToken
    if (!tok) return
    setComments((prev) => prev.map((c) => (c.id === rootId ? { ...c, resolved } : c)))
    if (resolved) editor?.commands.unsetComment(rootId) // clear the highlight when resolved
    await resolveComment(tok, rootId, resolved)
  }

  async function removeComment(commentId: string): Promise<void> {
    const tok = useAccountStore.getState().sessionToken
    if (!tok) return
    setComments((prev) => prev.filter((c) => c.id !== commentId && c.parentId !== commentId))
    editor?.commands.unsetComment(commentId)
    await deleteComment(tok, commentId)
  }

  function jumpToComment(commentId: string): void {
    if (!editor) return
    let found: { from: number; to: number } | null = null
    editor.state.doc.descendants((node, pos) => {
      if (found || !node.isText) return
      if (node.marks.some((m) => m.type.name === 'comment' && m.attrs.commentId === commentId)) {
        found = { from: pos, to: pos + node.nodeSize }
      }
    })
    if (found) editor.chain().setTextSelection(found).scrollIntoView().focus().run()
  }

  async function sendInvite(): Promise<void> {
    if (!token) return
    const res = await inviteToLiveDoc(token, liveDocId, inviteHandle.trim())
    setInviteNote(res.ok ? `Invited ${res.member?.handle ?? inviteHandle}` : res.error ?? 'Could not invite that handle.')
    if (res.ok) {
      setInviteHandle('')
      setInviting(false)
    }
  }

  async function inviteTeam(teamId: string): Promise<void> {
    if (!token) return
    const res = await inviteTeamToDoc(token, liveDocId, teamId)
    setInviteNote(res.ok ? `Invited the team (${res.invited ?? 0} members)` : res.error ?? 'Could not invite that team.')
    if (res.ok) setInviting(false)
  }

  return (
    <div className="h-full flex flex-col desk-paper no-tod">
      {/* Header */}
      <div className="shrink-0 px-4 py-2.5 border-b border-[var(--edge-soft)] flex items-center gap-3">
        <button onClick={() => back()} className="icon-btn" title="Back">
          <Icon name="arrow_back" size={17} />
        </button>
        <Icon name={typeIcon} size={16} className="text-accent shrink-0" />
        <span className="flex-1 min-w-0 text-[14px] font-semibold text-[var(--ink-100)] truncate">
          {meta.title}
        </span>
        <button
          onClick={() => void openObjectChannel('document', liveDocId, meta.title || 'Document')}
          title="Chat about this document"
          data-testid="doc-chat-button"
          className="shrink-0 icon-btn text-[var(--ink-50)] hover:text-accent"
        >
          <Icon name="forum" size={15} />
        </button>
        <CollaboratorBar people={people} />
        {canComment && (
          <>
            <button
              onClick={startComment}
              className="icon-btn text-[var(--ink-40)] hover:text-accent"
              title="Comment on the selected text"
              data-testid="livedoc-comment-add"
            >
              <Icon name="add_comment" size={16} />
            </button>
            <button
              onClick={() => setCommentsOpen((v) => !v)}
              className="icon-btn text-[var(--ink-40)] hover:text-accent inline-flex items-center"
              title="Comments"
              data-testid="livedoc-comments-toggle"
            >
              <Icon name="comment" size={16} />
              {comments.filter((c) => !c.parentId && !c.resolved).length > 0 && (
                <span className="ml-0.5 text-[10px] font-semibold text-accent">
                  {comments.filter((c) => !c.parentId && !c.resolved).length}
                </span>
              )}
            </button>
          </>
        )}
        <span className="text-[11px] text-[var(--ink-40)] shrink-0">{typeLabel}</span>
        {isOwner && (
          <button onClick={() => setInviting((v) => !v)} className="icon-btn" title="Invite someone" data-testid="livedoc-invite">
            <Icon name="person_add" size={15} />
          </button>
        )}
      </div>

      {/* Collaboration status strip. Every live editor type co-edits in real time
          (Tiptap / JSON reconcile), so there is no check-out lock. */}
      <div
        className="shrink-0 px-4 py-1.5 text-[12px] flex items-center gap-2 border-b bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/40 text-emerald-800 dark:text-emerald-200"
        data-testid="livedoc-status"
      >
        <Icon name="bolt" size={14} />
        <span data-testid="livedoc-live">Live — everyone here can edit together.</span>
      </div>

      {inviting && (
        <div className="shrink-0 px-4 py-2 border-b border-[var(--edge-soft)] flex items-center gap-2">
          <input
            value={inviteHandle}
            onChange={(e) => setInviteHandle(e.target.value)}
            placeholder="Invite by handle, e.g. @alex"
            className="fb-field flex-1 px-3 py-1.5 text-[12px]"
            data-testid="livedoc-invite-handle"
          />
          <button onClick={() => void sendInvite()} className="btn-primary text-[12px] px-3 py-1.5" data-testid="livedoc-invite-send">
            Invite
          </button>
          {inviteNote && <span className="text-[11px] text-[var(--ink-50)]">{inviteNote}</span>}
          {teams.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-[var(--ink-40)]">or a team:</span>
              {teams.map((t) => (
                <button
                  key={t.id}
                  onClick={() => void inviteTeam(t.id)}
                  data-testid={`livedoc-invite-team-${t.id}`}
                  className="fb-btn-surface inline-flex items-center gap-1 text-[11px] px-2 py-0.5 hover:border-accent hover:text-accent"
                >
                  <Icon name="group" size={12} />
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {composing && (
        <div className="shrink-0 px-4 py-2 border-b border-[var(--edge-soft)] flex items-center gap-2 bg-amber-50/60 dark:bg-amber-950/20">
          <Icon name="add_comment" size={14} className="text-amber-600 shrink-0" />
          <input
            autoFocus
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitComment()
              if (e.key === 'Escape') setComposing(null)
            }}
            placeholder="Comment on the selected text…"
            data-testid="livedoc-comment-input"
            className="fb-card flex-1 px-3 py-1.5 text-[12px] focus:border-accent"
          />
          <button
            onClick={() => void submitComment()}
            disabled={!composeText.trim()}
            className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-50"
            data-testid="livedoc-comment-submit"
          >
            Comment
          </button>
          <button onClick={() => setComposing(null)} className="icon-btn" aria-label="Cancel">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {/* Surface + comments panel */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 overflow-auto min-h-0" ref={surfaceRef}>
        {meta.docType === 'doc' &&
          (collabReady && collabRef.current ? (
            // Real-time: the CRDT owns the content, edits flow through the Yjs doc.
            <DocEditor
              key={`${meta.id}:collab`}
              content={bodyObj}
              title={meta.title}
              onChange={scheduleSnapshot}
              ydoc={collabRef.current.ydoc}
              awareness={collabRef.current.sync.awareness}
              user={meUser}
              userName={me?.name ?? null}
              onEditorReady={setEditor}
              comments={panelThreads}
              canComment={canComment}
              onAddComment={startComment}
              onReplyComment={(rootId, body) => void replyToComment(rootId, body)}
              onJumpComment={jumpToComment}
              mentionHandles={mentionHandles}
              myHandle={me?.handle ?? null}
              onCommentClick={(id) => {
                setCommentsOpen(true)
                setFocusComment(id)
              }}
            />
          ) : (
            <div className="p-6 text-[13px] text-[var(--ink-40)]" data-testid="livedoc-connecting">
              Connecting live editing…
            </div>
          ))}
        {meta.docType === 'sheet' &&
          (collabBody !== null ? (
            // Stable key: the editor stays mounted and folds remote edits in via
            // its body-sync effect, so an uncommitted cell edit is never lost.
            <SheetEditor key={`${meta.id}:collab`} body={collabBody as SheetBody} title={meta.title} onChange={onJsonChange} />
          ) : (
            <div className="p-6 text-[13px] text-[var(--ink-40)]" data-testid="livedoc-connecting">Connecting live editing…</div>
          ))}
        {meta.docType === 'slides' &&
          (collabBody !== null ? (
            <SlidesEditor key={`${meta.id}:collab`} body={collabBody as SlidesBody} title={meta.title} onChange={onJsonChange} />
          ) : (
            <div className="p-6 text-[13px] text-[var(--ink-40)]">Connecting live editing…</div>
          ))}
        {meta.docType === 'map' &&
          (collabBody !== null ? (
            <MapEditor key={`${meta.id}:collab`} body={collabBody as MapBody} title={meta.title} onChange={onJsonChange} foldExternal />
          ) : (
            <div className="p-6 text-[13px] text-[var(--ink-40)]" data-testid="livedoc-connecting">Connecting live editing…</div>
          ))}
        {meta.docType === 'design' &&
          (collabBody !== null ? (
            <DesignEditor key={`${meta.id}:collab`} content={collabBody} title={meta.title} onChange={onJsonChange} foldExternal />
          ) : (
            <div className="p-6 text-[13px] text-[var(--ink-40)]" data-testid="livedoc-connecting">Connecting live editing…</div>
          ))}
        {meta.docType === 'draw' &&
          (collabBody !== null ? (
            <DrawStudio key={`${meta.id}:collab`} content={collabBody} title={meta.title} onChange={onJsonChange} foldExternal />
          ) : (
            <div className="p-6 text-[13px] text-[var(--ink-40)]" data-testid="livedoc-connecting">Connecting live editing…</div>
          ))}
        </div>
        {canComment && commentsOpen && (
          <CommentsPanel
            comments={comments}
            myId={myId ?? null}
            handleOf={handleOf}
            focusId={focusComment}
            onReply={(rootId, body) => void replyToComment(rootId, body)}
            onResolve={(rootId, resolved) => void resolveThread(rootId, resolved)}
            onDelete={(id) => void removeComment(id)}
            onJump={jumpToComment}
            onClose={() => setCommentsOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
