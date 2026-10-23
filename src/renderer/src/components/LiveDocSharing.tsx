import { useEffect, useState } from 'react'
import { getSchema } from '@tiptap/core'
import Icon from './Icon'
import SharePeoplePicker, { type SharePick } from './SharePeoplePicker'
import {
  addComment,
  createLiveDoc,
  inviteToLiveDoc,
  inviteToLiveDocByEmail,
  resolveComment,
  setLiveDocMemberRole
} from '../lib/docCollabClient'
import { buildDocExtensions } from './documents/editor/extensions'
import { parseDocBody } from './documents/editor/headingStyles'
import { copyCommentsToLiveDoc, describeCopy, type LocalCommentRow } from '../lib/commentShareCopy'
import { useAccountStore } from '../stores/account'
import { useViewStore } from '../stores/view'

// Live people-sharing for an office file (a local document). Sharing promotes the
// document to a live, co-edited document (the same "collaborate" path the hub
// uses), invites the chosen people, and switches the sharer into the live copy so
// everyone edits the same file. Uses the shared multi-select picker.
export default function LiveDocSharing({
  documentId,
  onClose
}: {
  documentId: string
  onClose: () => void
}): JSX.Element {
  const [perm, setPerm] = useState<'view' | 'edit'>('edit')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const goLiveDoc = useViewStore((s) => s.goLiveDoc)

  // A comment on a document only you can see is a private note, so bringing
  // them along is asked for rather than assumed. Unticked: sharing a file must
  // never publish "fix this before Sarah reads it" to Sarah as a side effect.
  // Set once the live document exists. Sharing normally navigates away, which
  // is what stopped a second Share creating a SECOND live document; when we
  // stay put to show a note about the comments, that protection has to be put
  // back explicitly.
  const [shared, setShared] = useState(false)
  const [includeComments, setIncludeComments] = useState(false)
  const [comments, setComments] = useState<LocalCommentRow[]>([])
  useEffect(() => {
    let live = true
    void window.api.documents
      .listComments(documentId)
      .then((rows) => {
        if (live) setComments(rows as LocalCommentRow[])
      })
      .catch(() => {
        if (live) setComments([])
      })
    return () => {
      live = false
    }
  }, [documentId])
  // Threads, not rows: a reply is part of the comment a person is counting.
  const threadCount = comments.filter((c) => !c.parentId).length

  async function onShare(picks: SharePick[]): Promise<{ ok: boolean; error?: string }> {
    const token = useAccountStore.getState().sessionToken
    if (!token) {
      setMsg('Sign in to share this file.')
      return { ok: false }
    }
    setBusy(true)
    setMsg(null)
    const doc = await window.api.documents.get(documentId)
    if (!doc) {
      setMsg('Could not load this document.')
      setBusy(false)
      return { ok: false }
    }
    const created = await createLiveDoc(token, {
      docType: doc.docType,
      title: doc.title,
      body: JSON.stringify(doc.body)
    })
    if (!created) {
      setMsg('Could not start live sharing. Check your connection and that you are signed in.')
      setBusy(false)
      return { ok: false }
    }
    // Comments first, while the room is still empty: the anchors are converted
    // against the body the live copy will be seeded from, and a reader opening
    // it should not find threads arriving one by one behind them.
    let copyNote: string | null = null
    if (includeComments && threadCount > 0) {
      try {
        const pm = (parseDocBody(doc.body).doc as object) ?? { type: 'doc', content: [{ type: 'paragraph' }] }
        const result = await copyCommentsToLiveDoc(
          {
            token,
            liveDocId: created.id,
            pmJSON: pm,
            schema: getSchema(buildDocExtensions({ interactive: false })),
            comments
          },
          { addComment, resolveComment }
        )
        copyNote = describeCopy(result)
      } catch {
        // The document is shared either way; say so rather than rolling back a
        // live document people may already have been invited to.
        copyNote = 'the comments could not be copied'
      }
    }
    for (const p of picks) {
      let accId: string | null = null
      if (p.handle) {
        const r = await inviteToLiveDoc(token, created.id, p.handle).catch(() => null)
        accId = r?.member?.accountId ?? null
      } else if (p.email) {
        const r = await inviteToLiveDocByEmail(token, created.id, p.email).catch(() => null)
        accId = r?.accountId ?? null
      }
      if (perm === 'view' && accId) await setLiveDocMemberRole(token, created.id, accId, 'viewer').catch(() => {})
    }
    setBusy(false)
    if (copyNote && /could not|without a highlight|unresolved/.test(copyNote)) {
      // Something was not carried across exactly. Say it where the person
      // still has the dialog in front of them, and stay put so they can read
      // it, rather than navigating away from a half-told story.
      setMsg(`Shared. Comments: ${copyNote}.`)
      setShared(true)
      return { ok: true }
    }
    // Move the sharer into the live copy so everyone is editing the same document.
    goLiveDoc(created.id)
    onClose()
    return { ok: true }
  }

  return (
    <div className="rounded-md border-2 border-accent/40 bg-accent/[0.04] p-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-accent">
        <Icon name="bolt" size={12} />
        Live sharing (real-time)
      </div>
      <p className="text-[11px] text-[var(--ink-50)] leading-snug">
        Sharing turns this into a live document everyone edits together, and switches you to the shared copy.
        Add as many people as you like.
      </p>
      {threadCount > 0 && (
        <label className="flex items-start gap-2 text-[11px] text-[var(--ink-60)] cursor-pointer select-none" data-testid="share-include-comments">
          <input
            type="checkbox"
            checked={includeComments}
            disabled={busy}
            onChange={(e) => setIncludeComments(e.target.checked)}
            className="mt-[2px] accent-[var(--accent)]"
          />
          <span>
            Include my comments ({threadCount})
            <span className="block text-[var(--ink-40)]">
              Everyone you share with will be able to read them.
            </span>
          </span>
        </label>
      )}
      <SharePeoplePicker perm={perm} onPermChange={setPerm} busy={busy || shared} onShare={onShare} msg={msg} />
    </div>
  )
}
