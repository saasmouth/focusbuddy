import { create } from 'zustand'
import type { ExternalEvent } from '@shared/types'

// Events mirrored from Google / Outlook / an ICS feed.
//
// Read-only by construction: there is no setter here that writes back, because
// these rows belong to a calendar somewhere else. A failed load leaves the list
// EMPTY rather than stale -- showing last hour's copy of somebody's diary as
// though it were current is the one failure mode a calendar must not have.

interface ExternalEventState {
  events: ExternalEvent[]
  loaded: boolean
  error: string | null
  loadRange: (fromMs: number, toMs: number) => Promise<void>
}

export const useExternalEventStore = create<ExternalEventState>((set) => ({
  events: [],
  loaded: false,
  error: null,
  loadRange: async (fromMs, toMs) => {
    const api = (window as { api?: Record<string, unknown> }).api
    const ext = api?.externalCalendars as
      | { listEvents?: (f: number, t: number) => Promise<ExternalEvent[]> }
      | undefined
    if (!ext?.listEvents) {
      // No subscriptions surface in this runtime (the browser build). Not an
      // error, just nothing to show.
      set({ events: [], loaded: true, error: null })
      return
    }
    try {
      set({ events: (await ext.listEvents(fromMs, toMs)) ?? [], loaded: true, error: null })
    } catch (e) {
      set({ events: [], loaded: true, error: e instanceof Error ? e.message : String(e) })
    }
  }
}))
