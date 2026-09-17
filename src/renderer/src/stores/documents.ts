import { create } from 'zustand'
import type { DocType, DocumentMeta, FbDocument } from '@shared/types'
import { pullCloudDocs, pushCloudDoc, pushCloudDelete } from '../lib/cloudDocsSync'
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
  rename: (title: string) => Promise<void>
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
    set({ active: doc })
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
      void window.api.documents.update(a.id, { body }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[documents.close] final flush failed', err)
      })
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
    const existing = saveTimers.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.set(
      id,
      setTimeout(async () => {
        saveTimers.delete(id)
        const bodyToSave = pendingBodies.get(id)
        pendingBodies.delete(id)
        if (bodyToSave === undefined) return
        try {
          // Write to THIS document's id with its queued body, regardless of which
          // document is on screen now.
          await window.api.documents.update(id, { body: bodyToSave })
          // Only touch the shared saving/error UI state for the document still open.
          if (get().active?.id === id) set({ saving: false, saveError: false })
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
      }, 600)
    )
  },

  rename: async (title) => {
    const a = get().active
    if (!a) return
    const next = { ...a, title }
    set({ active: next })
    await window.api.documents.update(a.id, { title })
    void pushCloudDoc(next).catch(() => {})
    await get().refresh()
    nudgeSync()
    crdtEmitDocumentAttrs(a.id, { title }) // WS01 (flagged): title as LWW attr
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
    void window.api.documents.update(id, { body }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[documents.flush] final flush failed', err)
    })
  }
  // Any bodies queued without a live timer (edge cases) still get written.
  for (const [id, body] of pendingBodies) {
    pendingBodies.delete(id)
    void window.api.documents.update(id, { body }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[documents.flush] final flush failed', err)
    })
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
