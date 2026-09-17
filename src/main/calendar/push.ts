// Writing Plexii's own blocks OUT to a linked calendar — the second half of
// two-way sync.
//
// The direction matters more than it looks. Pulling is a mirror: whatever the
// provider says is true, and a replaced window makes deletions disappear.
// Pushing is the opposite — Plexii is the author, so every block it sends keeps
// the provider's event id and updates THAT event next time instead of creating
// a second copy of the same meeting every fifteen minutes.
//
// What can be pushed is decided by the provider, never by a setting: an ICS feed
// is a published file with no endpoint to write to, so it is refused here rather
// than failing halfway through with a 405.

import { net } from 'electron'
import { accessTokenFor } from './oauth'
import { capabilityOf, getCalendar } from '../db/externalCalendars'
import { listBlocksInRange, updateTimeBlock } from '../db/timeBlocks'
import type { ExternalCalendar, TimeBlock } from '@shared/types'

export interface CalendarPushResult {
  calendarId: string
  ok: boolean
  /** Blocks created on the far side. */
  created: number
  /** Blocks that already existed there and were brought up to date. */
  updated: number
  error?: string
}

/** How far ahead Plexii writes its own blocks out. */
const PUSH_FORWARD_MS = 120 * 24 * 60 * 60 * 1000
/** And how far back, so a block edited this morning still corrects itself. */
const PUSH_BACK_MS = 7 * 24 * 60 * 60 * 1000

export function pushWindow(now = Date.now()): { from: number; to: number } {
  return { from: now - PUSH_BACK_MS, to: now + PUSH_FORWARD_MS }
}

/**
 * The HTTP call, injectable so the push logic — which method, which body, and
 * whether a second push updates instead of duplicating — can be tested without a
 * provider, credentials or a network. Production passes nothing and gets net.fetch.
 */
export type PushTransport = (
  url: string,
  init: { method: string; token: string; body?: unknown }
) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }>

async function fetchJson(
  url: string,
  init: { method: string; token: string; body?: unknown }
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await net.fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'PlexiDesk Calendar Sync'
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    })
    const text = await res.text()
    if (!res.ok) {
      // The provider's own message is far more useful than a generic one: it is
      // what says "insufficient scope" rather than just "403".
      let detail = ''
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string }
        detail =
          typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '')
      } catch {
        detail = text.slice(0, 200)
      }
      return {
        ok: false,
        error: `The calendar service answered ${res.status}${detail ? `: ${detail}` : ''}.`
      }
    }
    return { ok: true, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function endMs(block: TimeBlock): number {
  return block.startMs + Math.max(1, block.durationMin) * 60_000
}

/** The Google Calendar body for one block. */
function googleBody(block: TimeBlock): Record<string, unknown> {
  return {
    summary: block.title || 'Focus block',
    start: { dateTime: new Date(block.startMs).toISOString() },
    end: { dateTime: new Date(endMs(block)).toISOString() },
    // The marker is how a pull can tell "this is my own block coming back" from
    // a real event somebody else created.
    extendedProperties: { private: { plexiiBlockId: block.id } }
  }
}

/** The Microsoft Graph body for one block. */
function microsoftBody(block: TimeBlock): Record<string, unknown> {
  return {
    subject: block.title || 'Focus block',
    start: { dateTime: new Date(block.startMs).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(endMs(block)).toISOString(), timeZone: 'UTC' },
    singleValueExtendedProperties: [
      { id: 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name plexiiBlockId', value: block.id }
    ]
  }
}

function eventUrl(cal: ExternalCalendar, eventId?: string): string {
  if (cal.provider === 'google') {
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.sourceRef)}/events`
    return eventId ? `${base}/${encodeURIComponent(eventId)}` : base
  }
  const base = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(cal.sourceRef)}/events`
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base
}

/**
 * Write one block to a linked calendar. Creates on the first push and updates
 * the SAME event afterwards, which is the whole reason the provider's event id
 * is stored back on the block.
 */
export async function pushBlock(
  block: TimeBlock,
  cal: ExternalCalendar,
  token: string,
  transport: PushTransport = fetchJson,
  persist: (id: string, patch: { externalEventId: string; externalCalendarId: string }) => void = (id, patch) =>
    void updateTimeBlock(id, patch)
): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const body = cal.provider === 'google' ? googleBody(block) : microsoftBody(block)
  const known = block.externalCalendarId === cal.id ? block.externalEventId : null

  if (known) {
    const res = await transport(eventUrl(cal, known), { method: 'PATCH', token, body })
    if (res.ok) return { ok: true, created: false }
    // The event was deleted on the far side; fall through and make a new one
    // rather than reporting a failure the user cannot act on.
    if (!res.error.includes('404') && !res.error.includes('410')) return { ok: false, error: res.error }
  }

  const created = await transport(eventUrl(cal), { method: 'POST', token, body })
  if (!created.ok) return { ok: false, error: created.error }
  const id = typeof created.body.id === 'string' ? created.body.id : null
  if (id) persist(block.id, { externalEventId: id, externalCalendarId: cal.id })
  return { ok: true, created: true }
}

/** Exported for tests: the request body a block becomes for each provider. */
export const bodyFor = { google: googleBody, microsoft: microsoftBody }
export { eventUrl }

/** Remove a block's event from the calendar it was pushed to. */
export async function unpushBlock(block: TimeBlock): Promise<void> {
  if (!block.externalEventId || !block.externalCalendarId) return
  const cal = getCalendar(block.externalCalendarId)
  if (!cal || capabilityOf(cal.provider) !== 'both') return
  const token = await accessTokenFor(cal.accountId)
  if (!token.ok) return
  await fetchJson(eventUrl(cal, block.externalEventId), { method: 'DELETE', token: token.token })
  updateTimeBlock(block.id, { externalEventId: null, externalCalendarId: null })
}

/**
 * Push every block on `internal` to the calendar it targets.
 *
 * Refuses rather than half-works: a target that cannot be written to, or an
 * internal calendar with no target, is reported as such.
 */
export async function pushInternalCalendar(internal: ExternalCalendar): Promise<CalendarPushResult> {
  const none = { calendarId: internal.id, created: 0, updated: 0 }
  if (internal.provider !== 'internal') {
    return { ...none, ok: false, error: 'Only a Plexii calendar can be pushed out.' }
  }
  if (internal.syncMode === 'read' || !internal.pushTargetId) {
    return { ...none, ok: true }
  }
  const target = getCalendar(internal.pushTargetId)
  if (!target) return { ...none, ok: false, error: 'The calendar it writes to is no longer here.' }
  if (capabilityOf(target.provider) !== 'both') {
    return {
      ...none,
      ok: false,
      error: `${target.name} is a published feed, which cannot be written to. Connect the account to write events back.`
    }
  }
  const token = await accessTokenFor(target.accountId)
  if (!token.ok) return { ...none, ok: false, error: token.error }

  const { from, to } = pushWindow()
  const blocks = listBlocksInRange(from, to).filter(
    (b) => (b.calendarId ?? null) === internal.id || (internal.isDefault && !b.calendarId)
  )

  let created = 0
  let updated = 0
  for (const block of blocks) {
    const res = await pushBlock(block, target, token.token)
    if (!res.ok) return { calendarId: internal.id, ok: false, created, updated, error: res.error }
    if (res.created) created++
    else updated++
  }
  return { calendarId: internal.id, ok: true, created, updated }
}
