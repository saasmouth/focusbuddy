import { create } from 'zustand'
import type { ExternalCalendar } from '@shared/types'

// The calendar list, cached for colour lookups.
//
// Every surface that draws an entry needs to know which calendar it belongs to
// and what colour that calendar is. Fetching per entry would be absurd, and
// threading the colour through every prop would be worse, so the list is held
// once here and the two lookups below are what the renderers actually call.
//
// A missing calendar falls back to the accent rather than throwing: an entry
// whose calendar was just deleted should still be visible while the next
// refresh catches up.

const FALLBACK = 'var(--accent)'

interface CalendarState {
  calendars: ExternalCalendar[]
  loaded: boolean
  load: () => Promise<void>
}

export const useCalendarStore = create<CalendarState>((set) => ({
  calendars: [],
  loaded: false,
  load: async () => {
    const api = (window as { api?: Record<string, unknown> }).api
    const ext = api?.externalCalendars as { list?: () => Promise<ExternalCalendar[]> } | undefined
    if (!ext?.list) {
      set({ calendars: [], loaded: true })
      return
    }
    try {
      set({ calendars: (await ext.list()) ?? [], loaded: true })
    } catch {
      set({ calendars: [], loaded: true })
    }
  }
}))

/** The colour of the calendar an entry belongs to. */
export function colorOfCalendar(calendars: ExternalCalendar[], calendarId: string | null | undefined): string {
  if (!calendarId) return FALLBACK
  return calendars.find((c) => c.id === calendarId)?.color || FALLBACK
}

/**
 * The colour a Plexii time block should be drawn in: its own calendar's, or the
 * default internal calendar's when it has not been assigned one.
 */
export function colorOfBlock(calendars: ExternalCalendar[], blockCalendarId: string | null | undefined): string {
  if (blockCalendarId) {
    const own = calendars.find((c) => c.id === blockCalendarId)
    if (own?.color) return own.color
  }
  const fallbackCal = calendars.find((c) => c.provider === 'internal' && c.isDefault)
  return fallbackCal?.color || FALLBACK
}

/** A translucent wash of a colour, for an entry's fill behind its own text. */
export function tint(color: string, alpha = 0.12): string {
  if (color.startsWith('var(')) return `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`
  return `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`
}
