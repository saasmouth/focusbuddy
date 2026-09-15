import { net } from 'electron'
import { parseIcs } from '@shared/icsParse'
import {
  listCalendars,
  getCalendar,
  updateCalendar,
  replaceEventsInWindow
} from '../db/externalCalendars'
import { accessTokenFor } from './oauth'
import type { ExternalCalendar, ExternalCalendarSyncResult, ExternalEvent } from '@shared/types'

// Pulling somebody's calendar in.
//
// The window is deliberately finite -- a year back, two forward. Calendars are
// unbounded in principle (a birthday repeats forever) and materialising that is
// both pointless and slow. Everything outside the window is simply not mirrored,
// which is honest: the app shows the window it holds.

const DAY = 86_400_000
export const SYNC_BACK_MS = 365 * DAY
export const SYNC_FORWARD_MS = 730 * DAY

export function syncWindow(now = Date.now()): { from: number; to: number } {
  return { from: now - SYNC_BACK_MS, to: now + SYNC_FORWARD_MS }
}

/** Electron's net stack, so proxies and system certificates are honoured. */
async function fetchText(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  try {
    const res = await net.fetch(url, {
      headers: {
        // Identifying the client is required by Nominatim-style services and
        // is simply good manners everywhere else.
        'User-Agent': 'PlexiDesk Calendar Sync',
        ...headers
      },
      redirect: 'follow'
    })
    if (!res.ok) {
      return {
        ok: false,
        error: `The calendar service answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`
      }
    }
    return { ok: true, body: await res.text() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Normalise a webcal:// or Google "secret address" URL.
 *
 * webcal is not a real scheme -- it is https with a different word in front,
 * and pasting one is what most people actually do when asked for a feed URL.
 */
export function normaliseFeedUrl(raw: string): string {
  const t = raw.trim()
  if (/^webcal:\/\//i.test(t)) return t.replace(/^webcal:\/\//i, 'https://')
  return t
}

/** Is this something we can actually fetch? Checked before it is saved. */
export function feedUrlProblem(raw: string): string | null {
  const url = normaliseFeedUrl(raw)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'That does not look like a URL.'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'A calendar feed must be an http(s) or webcal address.'
  }
  if (parsed.protocol === 'http:') {
    // Not refused -- some intranet feeds are plain http -- but the secret in a
    // calendar URL is the whole security model, so it is worth saying.
    return null
  }
  return null
}

async function syncIcs(
  cal: ExternalCalendar,
  from: number,
  to: number
): Promise<ExternalCalendarSyncResult> {
  const res = await fetchText(normaliseFeedUrl(cal.sourceRef))
  if (!res.ok) return { calendarId: cal.id, ok: false, events: 0, error: res.error }

  if (!/BEGIN:VCALENDAR/i.test(res.body)) {
    return {
      calendarId: cal.id,
      ok: false,
      events: 0,
      error:
        'That URL returned a page, not a calendar feed. In Google use "Secret address in iCal format"; in Outlook use "Publish a calendar" and copy the ICS link.'
    }
  }

  const parsed = parseIcs(res.body, from, to)
  const count = replaceEventsInWindow(
    cal.id,
    from,
    to,
    parsed.events.map((e) => ({
      uid: e.uid,
      title: e.summary,
      description: e.description ?? null,
      location: e.location ?? null,
      startMs: e.start,
      endMs: e.end,
      allDay: e.allDay,
      status: e.status ?? null,
      organizer: e.organizer ?? null,
      url: e.url ?? null
    }))
  )
  return { calendarId: cal.id, ok: true, events: count, warnings: parsed.unsupported }
}

// ── Provider APIs ───────────────────────────────────────────────────────────

interface GoogleEvent {
  id: string
  summary?: string
  description?: string
  location?: string
  status?: string
  htmlLink?: string
  organizer?: { email?: string }
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

async function syncGoogle(
  cal: ExternalCalendar,
  from: number,
  to: number
): Promise<ExternalCalendarSyncResult> {
  const token = await accessTokenFor(cal.accountId)
  if (!token.ok) return { calendarId: cal.id, ok: false, events: 0, error: token.error }

  const out: Omit<ExternalEvent, 'id' | 'calendarId' | 'updatedAt'>[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.sourceRef)}/events`
    )
    url.searchParams.set('timeMin', new Date(from).toISOString())
    url.searchParams.set('timeMax', new Date(to).toISOString())
    // Let Google expand recurrence: it owns the rules, and its answer is the
    // one the user sees in Google Calendar.
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('maxResults', '2500')
    url.searchParams.set('showDeleted', 'false')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetchText(url.toString(), { Authorization: `Bearer ${token.token}` })
    if (!res.ok) return { calendarId: cal.id, ok: false, events: 0, error: res.error }

    let body: { items?: GoogleEvent[]; nextPageToken?: string }
    try {
      body = JSON.parse(res.body)
    } catch {
      return { calendarId: cal.id, ok: false, events: 0, error: 'Google returned something that was not JSON.' }
    }
    for (const it of body.items ?? []) {
      const allDay = Boolean(it.start?.date)
      const startMs = it.start?.dateTime
        ? Date.parse(it.start.dateTime)
        : it.start?.date
          ? Date.parse(`${it.start.date}T00:00:00Z`)
          : NaN
      const endMs = it.end?.dateTime
        ? Date.parse(it.end.dateTime)
        : it.end?.date
          ? Date.parse(`${it.end.date}T00:00:00Z`)
          : NaN
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
      out.push({
        uid: it.id,
        title: it.summary ?? '',
        description: it.description ?? null,
        location: it.location ?? null,
        startMs,
        endMs,
        allDay,
        status: it.status ?? null,
        organizer: it.organizer?.email ?? null,
        url: it.htmlLink ?? null
      })
    }
    pageToken = body.nextPageToken
  } while (pageToken)

  return { calendarId: cal.id, ok: true, events: replaceEventsInWindow(cal.id, from, to, out) }
}

interface MsEvent {
  id: string
  subject?: string
  bodyPreview?: string
  isAllDay?: boolean
  webLink?: string
  organizer?: { emailAddress?: { address?: string } }
  location?: { displayName?: string }
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
}

/** Graph returns naive local times plus a zone name; both are needed. */
function msTimeToMs(t: { dateTime?: string; timeZone?: string } | undefined): number {
  if (!t?.dateTime) return NaN
  const zone = t.timeZone ?? 'UTC'
  if (zone === 'UTC' || /Z$/.test(t.dateTime)) {
    return Date.parse(/Z$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`)
  }
  // Ask for UTC in the Prefer header (below) so this path is rare; when it is
  // hit, treat the value as UTC rather than guessing a zone wrongly.
  return Date.parse(`${t.dateTime}Z`)
}

async function syncMicrosoft(
  cal: ExternalCalendar,
  from: number,
  to: number
): Promise<ExternalCalendarSyncResult> {
  const token = await accessTokenFor(cal.accountId)
  if (!token.ok) return { calendarId: cal.id, ok: false, events: 0, error: token.error }

  const out: Omit<ExternalEvent, 'id' | 'calendarId' | 'updatedAt'>[] = []
  // calendarView expands recurrence server-side, which is what we want for the
  // same reason as Google: the provider owns its own rules.
  let next: string | undefined =
    `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(cal.sourceRef)}/calendarView` +
    `?startDateTime=${new Date(from).toISOString()}&endDateTime=${new Date(to).toISOString()}&$top=999`

  while (next) {
    const res = await fetchText(next, {
      Authorization: `Bearer ${token.token}`,
      Prefer: 'outlook.timezone="UTC"'
    })
    if (!res.ok) return { calendarId: cal.id, ok: false, events: 0, error: res.error }
    let body: { value?: MsEvent[]; '@odata.nextLink'?: string }
    try {
      body = JSON.parse(res.body)
    } catch {
      return { calendarId: cal.id, ok: false, events: 0, error: 'Outlook returned something that was not JSON.' }
    }
    for (const it of body.value ?? []) {
      const startMs = msTimeToMs(it.start)
      const endMs = msTimeToMs(it.end)
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
      out.push({
        uid: it.id,
        title: it.subject ?? '',
        description: it.bodyPreview ?? null,
        location: it.location?.displayName ?? null,
        startMs,
        endMs,
        allDay: Boolean(it.isAllDay),
        status: null,
        organizer: it.organizer?.emailAddress?.address ?? null,
        url: it.webLink ?? null
      })
    }
    next = body['@odata.nextLink']
  }

  return { calendarId: cal.id, ok: true, events: replaceEventsInWindow(cal.id, from, to, out) }
}

/** Sync one calendar and record the outcome on it, success or failure. */
export async function syncCalendar(id: string): Promise<ExternalCalendarSyncResult> {
  const cal = getCalendar(id)
  if (!cal) return { calendarId: id, ok: false, events: 0, error: 'That calendar is no longer here.' }
  const { from, to } = syncWindow()

  let result: ExternalCalendarSyncResult
  try {
    result =
      cal.provider === 'ics'
        ? await syncIcs(cal, from, to)
        : cal.provider === 'google'
          ? await syncGoogle(cal, from, to)
          : await syncMicrosoft(cal, from, to)
  } catch (e) {
    result = {
      calendarId: id,
      ok: false,
      events: 0,
      error: e instanceof Error ? e.message : String(e)
    }
  }

  // The error is stored, not just returned: a calendar that stopped working a
  // week ago should say so on its own row, not only to whoever happened to be
  // watching when it broke.
  updateCalendar(id, {
    lastSyncAt: result.ok ? Date.now() : cal.lastSyncAt,
    lastSyncError: result.ok ? null : (result.error ?? 'Sync failed.')
  })
  return result
}

/** Sync every enabled calendar, one at a time to stay polite to the services. */
export async function syncAll(): Promise<ExternalCalendarSyncResult[]> {
  const out: ExternalCalendarSyncResult[] = []
  for (const cal of listCalendars()) {
    if (!cal.enabled) continue
    out.push(await syncCalendar(cal.id))
  }
  return out
}

let timer: ReturnType<typeof setInterval> | null = null

/** Refresh in the background every 15 minutes, and once shortly after boot. */
export function startCalendarSyncLoop(): void {
  if (timer) return
  setTimeout(() => void syncAll().catch(() => {}), 20_000)
  timer = setInterval(() => void syncAll().catch(() => {}), 15 * 60_000)
}

export function stopCalendarSyncLoop(): void {
  if (timer) clearInterval(timer)
  timer = null
}
