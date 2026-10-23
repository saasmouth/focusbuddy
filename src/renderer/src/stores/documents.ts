import { create } from 'zustand'
import type { DocType, DocumentMeta, FbDocument } from '@shared/types'
import { pullCloudDocs, pushCloudDoc, pushCloudDelete } from '../lib/cloudDocsSync'
import { useNoticeStore } from './notice'
import { nudgeSync } from '../lib/syncNudge'
import { recordActionWithToast } from './actionHistory'
import { useMessagingStore } from './messaging'
import { crdtEmitDocumentCreate, crdtEmitDocumentDelete, crdtEmitDocumentAttrs } from '../lib/crdtBridge'

// Documents store — the standalone office files (doc / sheet / slides). Holds
// the list for the hub and the one open document for the editor. Body edits are
// debounced to disk so typing stays smooth and we never lose work.
//
// Deleting is a two-stage affair, mirroring Drive: remove() soft-deletes into
// the Documents Trash (undoable via the toast and recoverable from the Trash
// section any time after), and only purge() — the Trash view's "Delete
// forever" — actually destroys the row and tells the cloud to forget it.

// Per-document debounce state, keyed by document id. A single module-global timer
// used to drop a document's pending save when you switched to another document
// within the debounce window (the flush then saw a different active doc and
// skipped the write). Now each document's timer flushes independently, and
// pendingBodies holds the freshest body per document so the flush writes the right
// content even after the active document has changed.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingBodies = new Map<string, FbDocument['body']>()
/**
 * The body version each pending save is based on — the one the editor was
 * handed, not whatever the row says now.
 *
 * Kept per document and NOT read from `active` at write time, because the write
 * happens 600ms after the edit and `active` may have been replaced by then (a
 * sync apply, a restore, another document opened). Saving against the current
 * row would be the same unconditional overwrite with extra steps.
 */
const pendingBaseRev = new Map<string, number>()

/**
 * Documents this renderer is in the middle of writing.
 *
 * THE ECHO CANNOT BE RECOGNISED BY ITS REVISION, which is why this exists. The
 * main process emits documents:changed from inside updateDocument, so the
 * broadcast reaches us BEFORE the write's own promise resolves — at which point
 * `active.bodyRev` is still the old revision and the new one is not known here
 * yet. The queued body has already been taken from pendingBodies too. So every
 * guard the listener had was satisfied, the store treated its own save as
 * somebody else's edit, refetched, and bumped bodyEpoch — which is in the
 * editor's React key, so the editor remounted and the user's ENTIRE UNDO
 * HISTORY went with it, about a second after they stopped typing.
 *
 * A notify for a document we are writing is therefore ignored. If somebody
 * else's write really did land in that window, our own write is refused by its
 * compare-and-set and the conflict bar handles it — so nothing is lost by not
 * refreshing mid-write, and the undo stack survives.
 */
const writing = new Set<string>()
/**
 * Write a queued body on the way out — closing a document, or flushing before
 * the app goes away — with nowhere left to ask the user anything.
 *
 * CONDITIONAL, like every other body write, because the close path was the hole
 * in this fix: the debounced save refused a stale write, and then closing the
 * document wrote exactly the same body unconditionally and destroyed the other
 * editor's work anyway.
 *
 * And when it IS refused, the user's text is not dropped either. There is no
 * conflict bar to show at this point, and silently discarding their last
 * sentences is its own data loss, so the text becomes a document of its own and
 * a notice says where it went. Nobody's work is lost by default; the only thing
 * lost is the assumption that it saved where they expected.
 */
async function flushPendingBody(id: string, body: FbDocument['body']): Promise<void> {
  const base = pendingBaseRev.get(id)
  pendingBaseRev.delete(id)
  try {
    if (base === undefined) {
      // Nothing recorded a base, so this editor never held a version to be
      // stale against (an import, a programmatic write). Unconditional is right.
      await window.api.documents.update(id, { body })
      return
    }
    const res = await window.api.documents.updateBody(id, body, base)
    if (res.ok) return
    if (res.reason === 'missing') return
    const theirs = res.current
    const copy = await window.api.documents.create({
      docType: theirs.docType,
      title: `${theirs.title || 'Untitled'} (unsaved copy)`,
      body
    })
    useNoticeStore.getState().show(
      {
        icon: 'warning',
        text: `"${theirs.title || 'Untitled'}" changed elsewhere while you were editing. Your version was saved as "${copy.title}".`,
        // The notice is the only place this is said, so it also has to be the
        // way back to the work: a notice that names a document the user cannot
        // reach is barely better than silence.
        action: { label: 'Open it', run: () => void useDocumentsStore.getState().open(copy.id) }
      },
      12000
    )
    void useDocumentsStore.getState().refresh()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[documents.flush] final flush failed', err)
  }
}


interface DocumentsStore {
  list: DocumentMeta[]
  trashed: DocumentMeta[]
  active: FbDocument | null
  loadingList: boolean
  saving: boolean
  // Set when the last debounced persist REJECTED. The editor shows an honest
  // "Couldn't save" banner instead of a stuck "Saving" and the in-memory edit
  // is retried on the next change. Cleared on the next successful write.
  saveError: boolean
  /**
   * Set when a save was REFUSED because the document changed elsewhere — the
   * same document open in a desk widget, another window, or a body that arrived
   * from sync.
   *
   * The edit is not thrown away and not written: it stays in `active.body` and
   * on the screen, and `theirs` is what is actually stored, so the user can
   * choose. Anything that silently picked one would be the bug this replaced.
   */
  conflict: { id: string; theirs: FbDocument } | null
  /**
   * Bumped whenever `active.body` is replaced from OUTSIDE the editor — a catch-up
   * from another editor's save, a body from sync, or taking theirs after a
   * conflict. The view puts it in each editor's key so the editor REMOUNTS and
   * re-seeds.
   *
   * It is not cosmetic, and OfficeDocWidget already learned this the hard way:
   * every office editor builds its content on mount and never re-seeds, so
   * swapping `active` alone moved this store's base revision forward while the
   * editor still displayed its mount-time text. The next keystroke then saved
   * STALE text against a CURRENT revision, the compare-and-set passed, and the
   * other editor's work was destroyed anyway — the guard defeated by its own
   * catch-up. The widget got a bodyEpoch for this; the Documents view did not,
   * and had the identical hole.
   *
   * Remounting costs the undo stack and the cursor, which is the right trade:
   * it only happens when there is nothing unsaved, so nobody is mid-sentence.
   */
  bodyEpoch: number

  refresh: () => Promise<void>
  refreshTrashed: () => Promise<void>
  open: (id: string) => Promise<void>
  close: () => void
  createBlank: (docType: DocType, title?: string) => Promise<FbDocument>
  createWithAI: (input: {
    docType: DocType
    prompt: string
    audience?: string
  }) => Promise<{ ok: boolean; id?: string; error?: string; needsApiKey?: boolean }>
  /** Import a Visio .vsdx into a new map document (opens a file picker). */
  importMap: () => Promise<{ ok: boolean; id?: string; error?: string; canceled?: boolean }>
  saveBody: (body: unknown) => void
  /**
   * Resolve a refused save. Every branch keeps the user's text until they have
   * said what to do with it:
   *   theirs    take what is stored and discard my edit (they asked)
   *   mine      overwrite, against the revision I was just shown
   *   copy      keep both: my text becomes a new document, theirs stays put
   */
  resolveConflict: (choice: 'theirs' | 'mine' | 'copy') => Promise<void>
  /** Rename THE OPEN document (Documents view). Anything else renames by id. */
  rename: (title: string) => Promise<void>
  /** Rename a document by id: the way to rename a document that is not the open one (a desk widget's). */
  renameById: (id: string, title: string) => Promise<void>
  /** Move to the Documents Trash (restorable; surfaces an Undo toast). */
  remove: (id: string) => Promise<void>
  /** Bring a trashed document back into the live list. */
  restore: (id: string) => Promise<void>
  /** Delete forever, from the Trash view only. */
  purge: (id: string) => Promise<void>
}

export const useDocumentsStore = create<DocumentsStore>((set, get) => ({
  list: [],
  trashed: [],
  active: null,
  loadingList: false,
  saving: false,
  saveError: false,
  conflict: null,
  bodyEpoch: 0,

  refresh: async () => {
    set({ loadingList: true })
    // Pull cloud changes first (no-op unless the flag is on + signed in), so the
    // list reflects edits made in the other app / on another device.
    await pullCloudDocs().catch(() => {})
    const list = await window.api.documents.list()
    set({ list, loadingList: false })
  },

  open: async (id) => {
    const doc = await window.api.documents.get(id)
    set({ active: doc, conflict: null })
    // A fresh editor, a fresh base: anything queued from a previous session of
    // this document has either been written or been abandoned.
    pendingBaseRev.delete(id)
  },

  close: () => {
    // Flush the active document's pending body save before leaving the editor.
    // Other documents keep their own timers and flush independently. A failure
    // here is logged (not swallowed) so a lost final buffer is at least diagnosable.
    const a = get().active
    if (a && (saveTimers.has(a.id) || pendingBodies.has(a.id))) {
      const t = saveTimers.get(a.id)
      if (t) clearTimeout(t)
      saveTimers.delete(a.id)
      const body = pendingBodies.get(a.id) ?? a.body
      pendingBodies.delete(a.id)
      void flushPendingBody(a.id, body)
    }
    set({ active: null })
  },

  createBlank: async (docType, customTitle) => {
    const title =
      customTitle?.trim() ||
      (docType === 'doc'
        ? 'Untitled document'
        : docType === 'sheet'
          ? 'Untitled sheet'
          : docType === 'slides'
            ? 'Untitled deck'
            : docType === 'design'
              ? 'Untitled design'
              : docType === 'draw'
                ? 'Untitled artwork'
                : 'Untitled diagram')
    const doc = await window.api.documents.create({ docType, title })
    void pushCloudDoc(doc).catch(() => {})
    crdtEmitDocumentCreate(doc) // WS01 (flagged): materialise doc metadata on other devices
    await get().refresh()
    nudgeSync()
    return doc
  },

  createWithAI: async (input) => {
    const r = await window.api.documents.generate(input)
    if (!r.ok) return { ok: false, error: r.error, needsApiKey: r.needsApiKey }
    const doc = await window.api.documents.create({
      docType: input.docType,
      title: r.title || 'Untitled',
      body: r.body as FbDocument['body']
    })
    void pushCloudDoc(doc).catch(() => {})
    crdtEmitDocumentCreate(doc) // WS01 (flagged): materialise doc metadata on other devices
    await get().refresh()
    return { ok: true, id: doc.id }
  },

  importMap: async () => {
    const r = await window.api.map.import()
    // A cancelled picker returns ok:false with no error — surface that distinctly
    // from a real failure so the caller stays quiet rather than showing an error.
    if (!r.ok) return r.error ? { ok: false, error: r.error } : { ok: false, canceled: true }
    if (!r.body) return { ok: false, error: 'That Visio file had nothing to import.' }
    const doc = await window.api.documents.create({
      docType: 'map',
      title: r.title || 'Imported Visio diagram',
      body: r.body as FbDocument['body']
    })
    void pushCloudDoc(doc).catch(() => {})
    crdtEmitDocumentCreate(doc) // WS01 (flagged): materialise doc metadata on other devices
    await get().refresh()
    return { ok: true, id: doc.id }
  },

  // Optimistic local update + debounced persist. The editor calls this on every
  // change; we coalesce writes to ~600ms of idle.
  saveBody: (body) => {
    const a = get().active
    if (!a) return
    const id = a.id
    set({ active: { ...a, body: body as FbDocument['body'] }, saving: true })
    // Queue the freshest body for THIS document and (re)arm only this document's
    // timer. Switching to another document no longer cancels this write.
    pendingBodies.set(id, body as FbDocument['body'])
    // The base revision is whatever this document was at when the FIRST
    // unsaved edit was made, not the latest one: successive keystrokes all
    // replace the same stored body, so re-reading it per keystroke would walk
    // the base forward past a change this editor never saw.
    if (!pendingBaseRev.has(id)) pendingBaseRev.set(id, a.bodyRev)
    const existing = saveTimers.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.set(
      id,
      setTimeout(async () => {
        saveTimers.delete(id)
        const bodyToSave = pendingBodies.get(id)
        pendingBodies.delete(id)
        if (bodyToSave === undefined) return
        const baseRev = pendingBaseRev.get(id) ?? 0
        writing.add(id)
        try {
          try {
            // CONDITIONAL: replace the body only if it is still the one this
            // editor was handed. The same document can be open in a desk widget
            // or another window, each holding its own copy of the whole body, and
            // an unconditional write silently destroyed whichever edit was
            // slower. See documents.body_rev.
            const res = await window.api.documents.updateBody(id, bodyToSave, baseRev)
            if (!res.ok) {
              if (res.reason === 'stale') {
                // Keep the edit — in `active.body`, on the screen, and queued —
                // and say what is stored instead. Writing either side here would
                // be choosing for the user.
                pendingBodies.set(id, bodyToSave)
                if (get().active?.id === id) {
                  set({ saving: false, saveError: false, conflict: { id, theirs: res.current } })
                }
                return
              }
              // 'missing': the document is gone (trashed elsewhere, or purged).
              // An error banner is honest; a retry loop against a dead id is not.
              pendingBaseRev.delete(id)
              if (get().active?.id === id) set({ saving: false, saveError: true })
              return
            }
            pendingBaseRev.set(id, res.doc.bodyRev)
            // Only touch the shared saving/error UI state for the document still open.
            if (get().active?.id === id) {
              set({
                saving: false,
                saveError: false,
                conflict: null,
                // Carry the new revision forward, or the next save would be
                // refused against the one we just superseded.
                active: { ...get().active!, bodyRev: res.doc.bodyRev }
              })
            }
            nudgeSync()
          } catch (err) {
            // Never lose work silently: re-queue the body so the next edit or close
            // retries, drop the stuck "Saving" state, and flag the error.
            // eslint-disable-next-line no-console
            console.error('[documents.saveBody] persist failed', err)
            pendingBodies.set(id, bodyToSave)
            if (get().active?.id === id) set({ saving: false, saveError: true })
            return
          }
          // Mirror to the cloud for the document we just saved (by id, even if the
          // active document has since changed). On a rev conflict the server wins.
          const saved = get().active?.id === id ? get().active! : ({ ...a, body: bodyToSave } as FbDocument)
          const { conflictedTo } = await pushCloudDoc(saved).catch(() => ({ conflictedTo: undefined }))
          if (conflictedTo && get().active?.id === conflictedTo.id) set({ active: conflictedTo })
        } finally {
          // Released however we leave: a return, a throw, or the end. A
          // document left in this set would never refresh again.
          writing.delete(id)
        }
      }, 600)
    )
  },

  resolveConflict: async (choice) => {
    const c = get().conflict
    if (!c) return
    const { id, theirs } = c
    // The edit that was refused. Read from the queue rather than from `active`:
    // the queue is what the save would have written, and it is still there
    // precisely because nothing was written.
    const mine = pendingBodies.get(id)

    if (choice === 'theirs') {
      // They asked to discard it, so this is the one branch that may drop the
      // edit — and it drops it completely rather than half-writing it.
      pendingBodies.delete(id)
      pendingBaseRev.set(id, theirs.bodyRev)
      const t = saveTimers.get(id)
      if (t) clearTimeout(t)
      saveTimers.delete(id)
      set({
        active: get().active?.id === id ? theirs : get().active,
        conflict: null,
        saveError: false,
        // Taking theirs is only real if the editor shows theirs.
        bodyEpoch: get().bodyEpoch + 1
      })
      return
    }

    if (choice === 'mine') {
      if (mine === undefined) {
        set({ conflict: null })
        return
      }
      // Against the revision just SHOWN, not the one originally held: this is a
      // deliberate replacement of a body the user has been told about, rather
      // than another blind race.
      const res = await window.api.documents.updateBody(id, mine, theirs.bodyRev)
      if (res.ok) {
        pendingBodies.delete(id)
        pendingBaseRev.set(id, res.doc.bodyRev)
        set({
          active: get().active?.id === id ? { ...get().active!, bodyRev: res.doc.bodyRev } : get().active,
          conflict: null,
          saveError: false
        })
        nudgeSync()
        return
      }
      // It moved AGAIN between being shown and being overwritten. Show the new
      // one rather than looping silently.
      if (res.reason === 'stale') set({ conflict: { id, theirs: res.current } })
      else set({ conflict: null, saveError: true })
      return
    }

    // 'copy' — keep both. The document on disk is left exactly as it is and the
    // refused edit becomes a document of its own, which is the only branch
    // where nobody loses anything.
    if (mine === undefined) {
      set({ conflict: null })
      return
    }
    const copy = await window.api.documents.create({
      docType: theirs.docType,
      title: `${theirs.title || 'Untitled'} (my copy)`,
      body: mine as FbDocument['body']
    })
    pendingBodies.delete(id)
    pendingBaseRev.set(id, theirs.bodyRev)
    const t = saveTimers.get(id)
    if (t) clearTimeout(t)
    saveTimers.delete(id)
    await get().refresh()
    // The editor moves to the copy, because that is where their text is now.
    await get().open(copy.id)
    set({ conflict: null, saveError: false })
  },

  rename: async (title) => {
    const a = get().active
    if (!a) return
    await get().renameById(a.id, title)
  },

  // By id, so a desk widget (which holds its document in local state, not here)
  // renames ITS document and never whatever Documents last had open. The open
  // document's cached copy follows only if it is the same one.
  renameById: async (id, title) => {
    const a = get().active
    if (a?.id === id) set({ active: { ...a, title } })
    const updated = await window.api.documents.update(id, { title })
    if (updated) void pushCloudDoc(updated).catch(() => {})
    await get().refresh()
    nudgeSync()
    crdtEmitDocumentAttrs(id, { title }) // WS01 (flagged): title as LWW attr
  },

  refreshTrashed: async () => {
    const trashed = await window.api.documents.listTrashed()
    set({ trashed })
  },

  remove: async (id) => {
    const meta = get().list.find((d) => d.id === id)
    await window.api.documents.delete(id)
    crdtEmitDocumentDelete(id) // WS01 (flagged): tombstone so the delete converges
    // No cloud delete here: the document is only in the local Trash. The cloud
    // copy is forgotten when (and only when) the user purges it.
    // Best-effort archive of this doc's chat channel (un-archives if restored+reopened).
    void useMessagingStore.getState().archiveObjectChannel('document', id)
    if (get().active?.id === id) set({ active: null })
    await Promise.all([get().refresh(), get().refreshTrashed()])
    recordActionWithToast({
      label: `Moved "${meta?.title ?? 'document'}" to trash`,
      undo: async () => {
        await window.api.documents.restore(id)
        await Promise.all([get().refresh(), get().refreshTrashed()])
      },
      redo: async () => {
        await window.api.documents.delete(id)
        if (get().active?.id === id) set({ active: null })
        await Promise.all([get().refresh(), get().refreshTrashed()])
      }
    })
  },

  restore: async (id) => {
    await window.api.documents.restore(id)
    await Promise.all([get().refresh(), get().refreshTrashed()])
  },

  purge: async (id) => {
    await window.api.documents.purge(id)
    void pushCloudDelete(id).catch(() => {})
    await get().refreshTrashed()
  }
}))

// Flush every document's pending debounced body write immediately. close()
// already flushes the one document you are leaving, but quitting the app,
// closing the window, or reloading the renderer never calls close(), so a
// debounced edit made in the last ~600ms would be lost. This writes every
// queued body straight to disk. On beforeunload we cannot await, but the IPC
// message is posted to the main process before the renderer tears down, so the
// SQLite write still lands.
export function flushPendingDocumentSaves(): void {
  for (const [id, timer] of saveTimers) {
    clearTimeout(timer)
    saveTimers.delete(id)
    const body = pendingBodies.get(id)
    if (body === undefined) continue
    pendingBodies.delete(id)
    void flushPendingBody(id, body)
  }
  // Any bodies queued without a live timer (edge cases) still get written.
  for (const [id, body] of pendingBodies) {
    pendingBodies.delete(id)
    void flushPendingBody(id, body)
  }
}

// Thin handle for debugging + e2e (same convention as __fbNodes / __fbWidgets /
// __fbView): the live convergence spec drives document creation through the store
// action (which fires crdtEmitDocumentCreate) rather than the raw api.documents
// bridge (which does not). Without this the CRDT emit path is unreachable in tests.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbDocuments?: typeof useDocumentsStore }).__fbDocuments = useDocumentsStore
  // Quit, window close and reload all fire beforeunload in the renderer;
  // pagehide is the fallback some platforms fire instead. Flush pending
  // office-document edits on any of them so no typed content is lost.
  const flushOnExit = (): void => flushPendingDocumentSaves()
  window.addEventListener('beforeunload', flushOnExit)
  window.addEventListener('pagehide', flushOnExit)
}

// Expose the documents store on window so e2e specs can reproduce a state the
// app reaches on its own (a document opened or created without navigating to
// it, e.g. by PlexiiAssist) through the store's real methods. A thin handle to
// the real store, not a mock; it changes nothing about how the app behaves.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbDocuments?: typeof useDocumentsStore }).__fbDocuments = useDocumentsStore
}

// WHY THERE IS NO SHARED PER-DOCUMENT BODY STORE, decided with 9d rather than
// overlooked. The obvious third step after the guard and this broadcast is one
// in-memory body and one save queue per document id, shared by every editor in
// the window, so two views of one document could never disagree. It is not
// built, on purpose.
//
// What it would actually buy, once the broadcast below exists, is narrow: two
// editors in ONE window, BOTH holding unsaved text, converging without a
// prompt. Everything else is already handled — an idle copy catches up
// silently, and a copy with unsaved text gets a conflict it can resolve in one
// click with nothing lost. The cost is a third source of truth for document
// bodies alongside this store and OfficeDocWidget's local state, and the two
// disagreeing is a worse failure than the prompt it would remove.
//
// Revisit it if the prompt turns out to be common in practice, which would mean
// people really do edit one document in two places at once; until then the
// guard is the backstop and the broadcast is what keeps it out of sight.

// Someone else replaced this document's body: another editor on the same
// document, another window, a snapshot restore, or a body that arrived from
// sync. Catch up when there is nothing to lose.
//
// THE RULE, and both halves of it matter:
//   nothing unsaved  -> reload, silently. This is what keeps two editors on one
//                       document in step at all, so a conflict prompt stays
//                       rare rather than routine.
//   unsaved edits     -> do NOTHING. Replacing the body under someone mid-
//                       sentence would destroy the very work body_rev exists to
//                       protect, and interrupting them with a prompt they have
//                       not yet earned is worse than letting their save be
//                       refused when they stop typing.
//
// The echo of our own write is ignored by revision, not by a flag: the writer
// already knows the number it just wrote.
if (typeof window !== 'undefined' && window.api?.documents?.onChanged) {
  window.api.documents.onChanged((id, bodyRev) => {
    const s = useDocumentsStore.getState()
    if (s.active?.id !== id) return
    if (s.active.bodyRev === bodyRev) return // our own save, already applied
    // The echo of a write still in flight. It cannot be recognised by its
    // revision — the broadcast is emitted inside the write and arrives before
    // the write's promise resolves, so the new revision is not known here yet —
    // and refreshing on it remounts the editor and destroys the undo history.
    if (writing.has(id)) return
    if (pendingBodies.has(id)) return // unsaved work on screen — leave it alone
    void window.api.documents.get(id).then((doc) => {
      const cur = useDocumentsStore.getState()
      // Re-check: the document may have been closed, or edited, while the
      // refetch was in flight.
      if (!doc || cur.active?.id !== id || pendingBodies.has(id)) return
      pendingBaseRev.set(id, doc.bodyRev)
      // The epoch is what makes this a catch-up rather than a trap: without it
      // the base revision advances and the editor does not, which is strictly
      // worse than never refreshing at all.
      useDocumentsStore.setState({
        active: doc,
        conflict: null,
        bodyEpoch: useDocumentsStore.getState().bodyEpoch + 1
      })
    })
  })
}
