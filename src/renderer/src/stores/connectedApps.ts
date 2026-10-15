import { create } from 'zustand'
import type { ConnectedApp, ConnectedAppDraft, ConnectedAppPatch } from '@shared/types'

interface ConnectedAppsStore {
  apps: ConnectedApp[]
  loaded: boolean
  refresh: () => Promise<void>
  create: (draft: ConnectedAppDraft) => Promise<ConnectedApp>
  update: (id: string, patch: ConnectedAppPatch) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
  // Bump usage counters. Called on full-pane open + drag to canvas + first
  // focus of a canvas widget bound to this app. Drives the Favourites sort.
  touch: (id: string) => Promise<void>
  // Toggle pinned-to-Favourites. Pinned apps always show in the strip regardless
  // of recency × frequency.
  togglePinned: (id: string) => Promise<void>
  // Bind a vault entry for auto-fill (or unbind with null).
  setVaultEntry: (id: string, vaultEntryId: string | null) => Promise<void>
  /** Show or hide this app's unread count in the side menu. */
  setNotifications: (id: string, on: boolean) => Promise<void>
  // Launch a local (kind='local') app via the main process. No-op for web apps.
  // Bumps usage on success so launches feed the Favourites sort.
  launchLocal: (id: string) => Promise<{ ok: boolean; error?: string }>
}

export const useConnectedAppsStore = create<ConnectedAppsStore>((set, get) => ({
  apps: [],
  loaded: false,
  refresh: async () => {
    const apps = await window.api.connectedApps.list()
    set({ apps, loaded: true })
  },
  create: async (draft) => {
    const app = await window.api.connectedApps.create(draft)
    set({ apps: [...get().apps, app] })
    return app
  },
  update: async (id, patch) => {
    const updated = await window.api.connectedApps.update(id, patch)
    if (!updated) return
    set({ apps: get().apps.map((a) => (a.id === id ? updated : a)) })
  },
  remove: async (id) => {
    await window.api.connectedApps.delete(id)
    set({ apps: get().apps.filter((a) => a.id !== id) })
  },
  reorder: async (orderedIds) => {
    const byId = new Map(get().apps.map((a) => [a.id, a]))
    const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as ConnectedApp[]
    set({ apps: reordered })
    await window.api.connectedApps.reorder(orderedIds)
  },
  touch: async (id) => {
    const updated = await window.api.connectedApps.touch(id)
    if (!updated) return
    set({ apps: get().apps.map((a) => (a.id === id ? updated : a)) })
  },
  togglePinned: async (id) => {
    const current = get().apps.find((a) => a.id === id)
    if (!current) return
    const updated = await window.api.connectedApps.update(id, { pinned: !current.pinned })
    if (!updated) return
    set({ apps: get().apps.map((a) => (a.id === id ? updated : a)) })
  },
  setVaultEntry: async (id, vaultEntryId) => {
    const updated = await window.api.connectedApps.update(id, { vaultEntryId })
    if (!updated) return
    set({ apps: get().apps.map((a) => (a.id === id ? updated : a)) })
  },
  setNotifications: async (id, on) => {
    await window.api.connectedApps.update(id, { notifications: on })
    await get().refresh()
  },
  launchLocal: async (id) => {
    const app = get().apps.find((a) => a.id === id)
    if (!app) return { ok: false, error: 'app not found' }
    if (app.kind !== 'local') return { ok: false, error: 'not a local app' }
    // Pass title so the unminimise/unhide logic in main can fall back to a
    // user-visible process name when neither bundleId nor appPath resolves.
    const result = await window.api.localApp.launch({
      appPath: app.appPath,
      bundleId: app.bundleId,
      title: app.title
    })
    if (result.ok) {
      // Touch on success so launches feed the Favourites sort the same way
      // opening a Connected App page does.
      const touched = await window.api.connectedApps.touch(id)
      if (touched) {
        set({ apps: get().apps.map((a) => (a.id === id ? touched : a)) })
      }
      return { ok: true }
    }
    return { ok: false, error: result.error }
  }
}))
