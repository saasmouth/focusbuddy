// A subscribed calendar's events show in the calendar work widget.
//
// Reported for 4.3.43 ("the calendar widget doesn't show subscribed events")
// and never reproduced. This subscribes to a real ICS feed served from this
// test, with the shapes real calendars use: a timed event, an all-day event, a
// weekly repeating event, and one in a named time zone, all falling today. It
// checks what the database holds (the sync) and what the widget shows (the
// view), so a failure says which half is wrong.
import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let server: Server | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

const pad = (n: number): string => String(n).padStart(2, '0')
const utc = (d: Date): string =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`
const day = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`

function feed(): string {
  const now = new Date()
  const at = (h: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const local = (h: number): string => `${day(now)}T${pad(h)}0000`
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 9, 0, 0)
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//plexii-test//EN',
    'BEGIN:VEVENT', 'UID:timed@test', `DTSTART:${utc(at(14))}`, `DTEND:${utc(at(15))}`, 'SUMMARY:Timed planning call', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:allday@test', `DTSTART;VALUE=DATE:${day(now)}`, `DTEND;VALUE=DATE:${day(tomorrow)}`, 'SUMMARY:All-day offsite', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:weekly@test', `DTSTART:${utc(weekAgo)}`, `DTEND:${utc(new Date(weekAgo.getTime() + 1800000))}`, 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Weekly standup', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:zoned@test', `DTSTART;TZID=${zone}:${local(17)}`, `DTEND;TZID=${zone}:${local(18)}`, 'SUMMARY:Zoned review', 'END:VEVENT',
    'END:VCALENDAR', ''
  ].join('\r\n')
}

async function deskWithCalendar(window: Page): Promise<string> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Calendar desk' })
    await api.widgets.create({ taskId: task.id, kind: 'calendar', content: '', x: 40, y: 40, width: 420, height: 460 } as never)
    return task.id
  })
}

const TITLES = ['Timed planning call', 'All-day offsite', 'Weekly standup', 'Zoned review']

test('a subscribed ICS feed: every kind of event is stored, and shows in the calendar work widget today', async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' })
    res.end(feed())
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const taskId = await deskWithCalendar(window)
  await window.evaluate((id) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })

  // Subscribe while the widget is on screen, as a person would.
  const added = await window.evaluate(async (url) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.externalCalendars.add({ provider: 'ics', name: 'Team calendar', sourceRef: url } as never)
  }, `http://127.0.0.1:${port}/team.ics`)
  expect(added, JSON.stringify(added)).toMatchObject({ ok: true })

  const stored = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const now = new Date()
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    return (await api.externalCalendars.listEvents(from, from + 86_400_000)).map((e) => e.title)
  })
  for (const t of TITLES) expect(stored, `the sync did not store "${t}"`).toContain(t)

  for (const t of TITLES) await expect(window.getByText(t, { exact: true }).first(), `the widget does not show "${t}"`).toBeVisible({ timeout: 10_000 })
})
