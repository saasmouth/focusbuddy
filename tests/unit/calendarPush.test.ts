/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { bodyFor, eventUrl, pushBlock, pushWindow, type PushTransport } from '../../src/main/calendar/push'
import type { ExternalCalendar, TimeBlock } from '../../src/shared/types'

function cal(provider: 'google' | 'microsoft', over: Partial<ExternalCalendar> = {}): ExternalCalendar {
  return {
    id: 'cal-1',
    provider,
    name: 'Work',
    color: '#dc2626',
    sourceRef: 'primary',
    accountId: 'acct-1',
    enabled: true,
    lastSyncAt: null,
    lastSyncError: null,
    syncMode: 'both',
    pushTargetId: null,
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function block(over: Partial<TimeBlock> = {}): TimeBlock {
  return {
    id: 'blk-1',
    taskId: null,
    title: 'Deep work',
    startMs: Date.UTC(2026, 8, 16, 9, 0),
    durationMin: 60,
    status: 'planned',
    origin: 'manual',
    locked: false,
    pushPolicy: 'local',
    calendarId: null,
    externalEventId: null,
    externalCalendarId: null,
    ...over
  } as TimeBlock
}

/** A transport that records what it was asked to send. */
function recorder(
  responses: Array<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }>
): { transport: PushTransport; calls: Array<{ url: string; method: string; body?: unknown }> } {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  let i = 0
  const transport: PushTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body })
    return responses[Math.min(i++, responses.length - 1)]
  }
  return { transport, calls }
}

describe('calendar push — the request that goes out', () => {
  it('a Google body carries the title, the real times and a marker', () => {
    const b = bodyFor.google(block()) as Record<string, any>
    expect(b.summary).toBe('Deep work')
    expect(b.start.dateTime).toBe('2026-09-16T09:00:00.000Z')
    // 09:00 + 60 minutes.
    expect(b.end.dateTime).toBe('2026-09-16T10:00:00.000Z')
    expect(b.extendedProperties.private.plexiiBlockId).toBe('blk-1')
  })

  it('a Microsoft body uses Graph’s own shape', () => {
    const b = bodyFor.microsoft(block({ title: 'Review' })) as Record<string, any>
    expect(b.subject).toBe('Review')
    expect(b.start.timeZone).toBe('UTC')
    expect(b.singleValueExtendedProperties[0].value).toBe('blk-1')
  })

  it('an untitled block still gets a name rather than an empty event', () => {
    expect((bodyFor.google(block({ title: '' })) as Record<string, any>).summary).toBe('Focus block')
  })

  it('a zero-length block still ends after it starts', () => {
    const b = bodyFor.google(block({ durationMin: 0 })) as Record<string, any>
    expect(Date.parse(b.end.dateTime)).toBeGreaterThan(Date.parse(b.start.dateTime))
  })

  it('the endpoints are the providers’ real ones, with the calendar id escaped', () => {
    expect(eventUrl(cal('google', { sourceRef: 'a b@x.com' }))).toContain('googleapis.com/calendar/v3/calendars/a%20b%40x.com/events')
    expect(eventUrl(cal('microsoft'), 'evt-9')).toContain('graph.microsoft.com/v1.0/me/calendars/primary/events/evt-9')
  })
})

describe('calendar push — create, then update', () => {
  it('the first push CREATES and remembers the event id', async () => {
    const { transport, calls } = recorder([{ ok: true, body: { id: 'evt-77' } }])
    const saved: Array<{ id: string; patch: unknown }> = []
    const res = await pushBlock(block(), cal('google'), 'tok', transport, (id, patch) => saved.push({ id, patch }))
    expect(res).toEqual({ ok: true, created: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    // Remembering the id is what stops the next push making a second copy.
    expect(saved).toEqual([{ id: 'blk-1', patch: { externalEventId: 'evt-77', externalCalendarId: 'cal-1' } }])
  })

  it('a second push UPDATES the same event instead of duplicating it', async () => {
    const { transport, calls } = recorder([{ ok: true, body: { id: 'evt-77' } }])
    const known = block({ externalEventId: 'evt-77', externalCalendarId: 'cal-1' })
    const res = await pushBlock(known, cal('google'), 'tok', transport, () => {})
    expect(res).toEqual({ ok: true, created: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].url).toContain('/events/evt-77')
  })

  it('an id belonging to a DIFFERENT calendar is not reused', async () => {
    const { transport, calls } = recorder([{ ok: true, body: { id: 'evt-new' } }])
    const elsewhere = block({ externalEventId: 'evt-77', externalCalendarId: 'other-cal' })
    await pushBlock(elsewhere, cal('google'), 'tok', transport, () => {})
    expect(calls[0].method).toBe('POST')
  })

  it('an event deleted on the far side is recreated rather than reported as broken', async () => {
    const { transport, calls } = recorder([
      { ok: false, error: 'The calendar service answered 404: Not Found' },
      { ok: true, body: { id: 'evt-again' } }
    ])
    const known = block({ externalEventId: 'gone', externalCalendarId: 'cal-1' })
    const res = await pushBlock(known, cal('google'), 'tok', transport, () => {})
    expect(res).toEqual({ ok: true, created: true })
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST'])
  })

  it('a real failure is reported, not retried into a duplicate', async () => {
    const { transport, calls } = recorder([
      { ok: false, error: 'The calendar service answered 403: insufficient scope' }
    ])
    const known = block({ externalEventId: 'evt-77', externalCalendarId: 'cal-1' })
    const res = await pushBlock(known, cal('google'), 'tok', transport, () => {})
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('insufficient scope')
    expect(calls).toHaveLength(1)
  })

  it('a create that fails does not record an event id', async () => {
    const { transport } = recorder([{ ok: false, error: 'network down' }])
    const saved = vi.fn()
    const res = await pushBlock(block(), cal('google'), 'tok', transport, saved)
    expect(res.ok).toBe(false)
    expect(saved).not.toHaveBeenCalled()
  })

  it('a create that answers without an id does not pretend to have one', async () => {
    const { transport } = recorder([{ ok: true, body: {} }])
    const saved = vi.fn()
    const res = await pushBlock(block(), cal('google'), 'tok', transport, saved)
    expect(res).toEqual({ ok: true, created: true })
    expect(saved).not.toHaveBeenCalled()
  })
})

describe('calendar push — the window', () => {
  it('covers the near past and several months ahead', () => {
    const now = Date.UTC(2026, 8, 15)
    const { from, to } = pushWindow(now)
    expect(from).toBeLessThan(now)
    expect(to).toBeGreaterThan(now)
    // A week back, so this morning's edit still corrects itself.
    expect(Math.round((now - from) / 86_400_000)).toBe(7)
    expect(Math.round((to - now) / 86_400_000)).toBe(120)
  })
})
