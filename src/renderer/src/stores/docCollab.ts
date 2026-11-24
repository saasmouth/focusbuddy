import { create } from 'zustand'
import { useAccountStore } from './account'
import { getLiveDoc, deleteLiveDoc, liveDocStatus, type LiveDocFull } from '../lib/docCollabClient'
import { setDocSocketHandler, type DocSocketEvent } from '../lib/messagingSocket'
import { useNoticeStore } from './notice'

// Client state for the currently-open live document or live folder: its metadata
// and baseline body, fetched once on open. There is NO check-out lock any more —
// live documents co-edit in real time via Yjs, and live folders converge on the
// CRDT substrate — so this store just holds the open object's meta + body for the
// editor/view to read (the view drives its own real-time channel from there).

function token(): string | null {
  return useAccountStore.getState().sessionToken
}

interface DocCollabStore {
  openId: string | null
  meta: LiveDocFull | null
  bodyObj: unknown
  loading: boolean

  /** Bumped when the list of live documents should be read again (CollaborationsView). */
  listVersion: number
  /** The live document that was open when its owner deleted it, or removed me from it (the editor says which). */
  goneId: string | null
  goneReason: 'deleted' | 'removed' | null

  openLive: (id: string) => Promise<void>
  closeLive: () => void
  /** Owner only: stop sharing and erase the shared copy on our server (4.3.56). */
  deleteShared: (id: string) => Promise<{ ok: true } | { ok: false; status: number; error: string }>
}

export const useDocCollabStore = create<DocCollabStore>((set, get) => ({
  openId: null,
  meta: null,
  bodyObj: null,
  loading: false,
  listVersion: 0,
  goneId: null,
  goneReason: null,

  openLive: async (id) => {
    const t = token()
    if (!t) return
    set({ openId: id, loading: true, meta: null, bodyObj: null, goneId: null, goneReason: null })
    const full = await getLiveDoc(t, id)
    if (!full || get().openId !== id) {
      set({ loading: false })
      return
    }
    let bodyObj: unknown = null
    try {
      bodyObj = full.body ? JSON.parse(full.body) : null
    } catch {
      bodyObj = null
    }
    set({ meta: full, bodyObj, loading: false })
  },

  closeLive: () => {
    set({ openId: null, meta: null, bodyObj: null })
  },

  deleteShared: async (id) => {
    const t = token()
    if (!t) return { ok: false, status: 401, error: 'Sign in to delete the shared copy.' }
    const r = await deleteLiveDoc(t, id)
    if (!r.ok) return r
    if (get().openId === id) set({ openId: null, meta: null, bodyObj: null })
    set({ listVersion: get().listVersion + 1 })
    return r
  }
}))

// A member hears that a live document was deleted by its owner, or that the owner
// removed them from it: the signal sends the same docLockChanged push for both
// (holder null, 4.3.56). The list is read again either way. If it is the document
// open here, ask the server: deleted (404) and removed (403) close it, each with
// its own true word; an unreachable or failing server leaves it open.
export async function handleDocSocketEvent(e: DocSocketEvent): Promise<void> {
  if (e.type !== 'docLockChanged') return
  const store = useDocCollabStore
  store.setState({ listVersion: store.getState().listVersion + 1 })
  const id = (e as { docId?: string }).docId
  if (!id || store.getState().openId !== id) return
  const t = token()
  if (!t) return
  const status = await liveDocStatus(t, id)
  if ((status !== 'deleted' && status !== 'removed') || store.getState().openId !== id) return
  const title = store.getState().meta?.title?.trim() || 'This shared document'
  store.setState({ openId: null, meta: null, bodyObj: null, goneId: id, goneReason: status })
  useNoticeStore.getState().show(
    status === 'deleted'
      ? { text: `“${title}” was deleted by its owner.`, icon: 'delete' }
      : { text: `“${title}” is no longer shared with you.`, icon: 'group' }
  )
}
setDocSocketHandler((e) => void handleDocSocketEvent(e))
