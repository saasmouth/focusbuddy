import { create } from 'zustand'
import { recordViewVisit } from '../lib/viewRecency'

// Current pane view — replaces the assumption that the main area always shows a task canvas.
// As PlexiDesk grows into a workspace OS, the main pane routes between Home Dashboard,
// All Tasks, per-Project Dashboards, individual Tasks, and Connected Apps.

export type View =
  | { kind: 'home' }
  | { kind: 'all-tasks' }
  // The Rooms/Desks index pages. 'rooms' lists every Room (folder node) and
  // 'desks' lists every Desk (canvas / task node) across all rooms, each with
  // gallery / list / kanban / table / timeline modes. optional roomId scopes the
  // desks index to a single room.
  | { kind: 'rooms' }
  | { kind: 'desks'; roomId?: string }
  // Rooms and desks other people have shared with you, shown as a gallery under
  // the Rooms nav rather than an inline tree.
  | { kind: 'shared' }
  // Trashed rooms/desks awaiting the 7-day purge, restorable with their subtree.
  | { kind: 'trash' }
  // The Attention surface (S6): every work item that needs the person, in
  // purpose-built queues. A lens over items that live with their desks —
  // it references work, it never owns it.
  | { kind: 'attention' }
  | { kind: 'calendar' }
  | { kind: 'project-dashboard'; projectId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'connected-app'; appId: string }
  | { kind: 'vault' }
  | { kind: 'messages' }
  | { kind: 'inbox' }
  | { kind: 'mail'; openUid?: number }
  | { kind: 'documents' }
  | { kind: 'office'; app?: string; doc?: string }
  // The segment views carry an optional `app` so entry points elsewhere (the
  // suite launcher, the command palette, the home dashboard) can deep-link to a
  // specific app inside the segment rather than just its home. The top-level
  // structure is four segments: PlexiDesk (the workspace), PlexiOffice (the
  // 'office' kind below), PlexiPeople (the team area) and PlexiBrain (knowledge,
  // automation, insights).
  | { kind: 'plexidesk'; app?: string }
  | { kind: 'plexipeople'; app?: string }
  | { kind: 'plexibrain'; app?: string }
  // The Plexii hub — the AI's own page. One conversational engine, many doors
  // (sidebar tab, pill, Home input, ⌘⇧K); this view is the full-screen door.
  | { kind: 'plexii' }
  | { kind: 'design' }
  | { kind: 'draw' }
  | { kind: 'document'; documentId: string }
  | { kind: 'livedoc'; liveDocId: string }
  | { kind: 'livefolder'; liveFolderId: string }
  | { kind: 'collaborations' }
  | { kind: 'insights' }
  | { kind: 'files' }
  | { kind: 'organization' }
  | { kind: 'people-map' }
  | { kind: 'suite' }
  | { kind: 'product'; productKey: string }
  | { kind: 'knowledge'; entryId?: string }
  | { kind: 'meetings' }
  | { kind: 'apps' }
  | { kind: 'forms' }
  | { kind: 'sign' }
  | { kind: 'search' }
  | { kind: 'projects' }
  | { kind: 'reports' }
  | { kind: 'flows' }
  | { kind: 'api' }
  | { kind: 'marketplace' }
  | { kind: 'mdext'; path: string }

interface ViewStore {
  view: View
  // Navigation history. `past` is the stack of views behind the current one,
  // `future` the stack ahead (populated by back()). Every setter funnels through
  // commit(), so back/forward work from anywhere, including inside a desk.
  past: View[]
  future: View[]
  back: () => void
  forward: () => void
  go: (view: View) => void
  goHome: () => void
  goAllTasks: () => void
  goRooms: () => void
  // Canonical way to open a Room. A room opens as its spatial folder-canvas
  // (kind 'project-dashboard'); every room opener routes through this so there is
  // one room destination, not three.
  goRoom: (roomId: string) => void
  goDesks: (roomId?: string) => void
  goShared: () => void
  goTrash: () => void
  goAttention: () => void
  goCalendar: () => void
  goProject: (projectId: string) => void
  goTask: (taskId: string) => void
  goConnectedApp: (appId: string) => void
  goVault: () => void
  goMessages: () => void
  goInbox: () => void
  goMail: (openUid?: number) => void
  goDocuments: () => void
  goOffice: (app?: string, doc?: string) => void
  goPlexiDesk: (app?: string) => void
  goPlexiPeople: (app?: string) => void
  goPlexiBrain: (app?: string) => void
  goPlexii: () => void
  goDesign: () => void
  goDraw: () => void
  goDocument: (documentId: string) => void
  goLiveDoc: (liveDocId: string) => void
  goLiveFolder: (liveFolderId: string) => void
  goCollaborations: () => void
  goInsights: () => void
  goFiles: () => void
  goOrg: () => void
  goPeopleMap: () => void
  goSuite: () => void
  goProduct: (productKey: string) => void
  goKnowledge: (entryId?: string) => void
  goMeetings: () => void
  goApps: () => void
  goForms: () => void
  goSign: () => void
  goSearch: () => void
  goProjects: () => void
  goReports: () => void
  goFlows: () => void
  goApi: () => void
  goMarketplace: () => void
}

const STORAGE_KEY = 'fb.view.last'
const MAX_HISTORY = 50

function readLastView(): View {
  // PlexiSuite is the default landing: anyone without a saved view starts on the
  // suite launcher. Returning users still resume their last view.
  if (typeof localStorage === 'undefined') return { kind: 'suite' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { kind: 'suite' }
    // Read the raw shape loosely first so legacy kinds that are no longer in the
    // View union can still be mapped. A user mid-session may have one of the old
    // four-segment kinds (plexiwork / plexiconnect / plexiflow) persisted; map
    // each to its closest new home so resuming never lands on a dead kind.
    const loose = JSON.parse(raw) as { kind?: string; app?: string }
    if (loose && typeof loose.kind === 'string') {
      const app = loose.app
      switch (loose.kind) {
        case 'plexiwork':
          // Projects / Tasks lived in PlexiWork and live in PlexiDesk now;
          // Reports rolls into PlexiBrain insights.
          if (app === 'reports') return { kind: 'plexibrain', app: 'insights' }
          return { kind: 'plexidesk', app: app === 'projects' ? 'plans' : app }
        case 'plexiconnect':
          // Chat / Meet moved into PlexiOffice.
          return { kind: 'office', app }
        case 'plexiflow':
          // Flow / API / Build / Form moved into PlexiBrain.
          return { kind: 'plexibrain', app: app === 'flow' ? 'flows' : app }
        default:
          return JSON.parse(raw) as View
      }
    }
  } catch {
    // ignore
  }
  return { kind: 'suite' }
}

function persistView(view: View): void {
  // Remember the most-visited modules so the command palette can promote them.
  recordViewVisit(view.kind)
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(view))
  } catch {
    /* ignore quota */
  }
}

// Views are small plain objects; a JSON compare is the cheapest way to avoid
// pushing a duplicate of the current view onto the history stack.
function isSameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export const useViewStore = create<ViewStore>((set, get) => {
  // Every navigation goes through here: record where we were, clear the forward
  // stack, persist, and switch. This is what makes Back work from any screen.
  const commit = (view: View): void => {
    // Record it in the open tray. Imported lazily because the tray store reads
    // this module's View type, and a static import would close the cycle.
    void import('./openTray')
      .then((m) => m.useOpenTrayStore.getState().open(view))
      .catch(() => undefined)
    const cur = get().view
    if (isSameView(cur, view)) {
      persistView(view)
      set({ view })
      return
    }
    persistView(view)
    set({ view, past: [...get().past, cur].slice(-MAX_HISTORY), future: [] })
  }

  return {
    view: readLastView(),
    past: [],
    future: [],
    back: () => {
      const { past, view, future } = get()
      if (past.length === 0) return
      const prev = past[past.length - 1]
      persistView(prev)
      set({ view: prev, past: past.slice(0, -1), future: [view, ...future].slice(0, MAX_HISTORY) })
    },
    forward: () => {
      const { future, view, past } = get()
      if (future.length === 0) return
      const next = future[0]
      persistView(next)
      set({ view: next, future: future.slice(1), past: [...past, view].slice(-MAX_HISTORY) })
    },
    go: (view) => commit(view),
    goHome: () => commit({ kind: 'home' }),
    goAllTasks: () => commit({ kind: 'all-tasks' }),
    goRooms: () => commit({ kind: 'rooms' }),
    goRoom: (roomId) => commit({ kind: 'project-dashboard', projectId: roomId }),
    goDesks: (roomId) => commit({ kind: 'desks', roomId }),
    goShared: () => commit({ kind: 'shared' }),
    goTrash: () => commit({ kind: 'trash' }),
    goAttention: () => commit({ kind: 'attention' }),
    goCalendar: () => commit({ kind: 'calendar' }),
    goProject: (projectId) => commit({ kind: 'project-dashboard', projectId }),
    goTask: (taskId) => commit({ kind: 'task', taskId }),
    goConnectedApp: (appId) => commit({ kind: 'connected-app', appId }),
    goVault: () => commit({ kind: 'vault' }),
    goMessages: () => commit({ kind: 'messages' }),
    goInbox: () => commit({ kind: 'inbox' }),
    goMail: (openUid) => commit({ kind: 'mail', openUid }),
    goDocuments: () => commit({ kind: 'documents' }),
    goOffice: (app, doc) => commit({ kind: 'office', app, doc }),
    goPlexiDesk: (app) => commit({ kind: 'plexidesk', app }),
    goPlexiPeople: (app) => commit({ kind: 'plexipeople', app }),
    goPlexiBrain: (app) => commit({ kind: 'plexibrain', app }),
    goPlexii: () => commit({ kind: 'plexii' }),
    goDesign: () => commit({ kind: 'design' }),
    goDraw: () => commit({ kind: 'draw' }),
    goDocument: (documentId) => commit({ kind: 'document', documentId }),
    goLiveDoc: (liveDocId) => commit({ kind: 'livedoc', liveDocId }),
    goLiveFolder: (liveFolderId) => commit({ kind: 'livefolder', liveFolderId }),
    goCollaborations: () => commit({ kind: 'collaborations' }),
    goInsights: () => commit({ kind: 'insights' }),
    goFiles: () => commit({ kind: 'files' }),
    goOrg: () => commit({ kind: 'organization' }),
    goPeopleMap: () => commit({ kind: 'people-map' }),
    goSuite: () => commit({ kind: 'suite' }),
    goProduct: (productKey) => commit({ kind: 'product', productKey }),
    goKnowledge: (entryId) => commit({ kind: 'knowledge', entryId }),
    goMeetings: () => commit({ kind: 'meetings' }),
    goApps: () => commit({ kind: 'apps' }),
    goForms: () => commit({ kind: 'forms' }),
    goSign: () => commit({ kind: 'sign' }),
    goSearch: () => commit({ kind: 'search' }),
    goProjects: () => commit({ kind: 'projects' }),
    goReports: () => commit({ kind: 'reports' }),
    goFlows: () => commit({ kind: 'flows' }),
    goApi: () => commit({ kind: 'api' }),
    goMarketplace: () => commit({ kind: 'marketplace' })
  }
})

// Expose the view store on window so debugging sessions and e2e specs can drive
// navigation directly. This is a thin handle to the real store, not a mock; it
// changes nothing about how the app behaves for users.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbView?: typeof useViewStore }).__fbView = useViewStore
}
