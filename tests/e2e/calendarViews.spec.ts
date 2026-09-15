import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Six spans, and a way back down to one day.
//
// A month or year grid can only show a few entries per cell, so the drill-in is
// not a nicety: without it the overview is a dead end.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openCalendar(window: LaunchedApp['window']): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goCalendar: () => void } } }
    w.__fbView?.getState().goCalendar()
  })
  await window.waitForTimeout(600)
}

test('every span is reachable and renders', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openCalendar(window)

  for (const label of ['Day', '3-Day', '5-Day', 'Week', 'Month', 'Year']) {
    await window.getByRole('button', { name: label, exact: true }).click()
    await window.waitForTimeout(250)
    const shown = await window.evaluate(() => ({
      month: Boolean(document.querySelector('[data-testid="calendar-month"]')),
      year: Boolean(document.querySelector('[data-testid="calendar-year"]')),
      // The hour grid has a scroller the overviews do not.
      body: document.body.innerText.slice(0, 60)
    }))
    if (label === 'Year') expect(shown.year, 'year grid').toBe(true)
    else if (label === 'Month') expect(shown.month, 'month grid').toBe(true)
    else expect(shown.year || shown.month, `${label} should not be an overview`).toBe(false)
  }
})

test('the year shows twelve months and clicking a day opens it', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openCalendar(window)

  await window.getByRole('button', { name: 'Year', exact: true }).click()
  await window.waitForTimeout(400)

  const months = await window.evaluate(
    () => document.querySelectorAll('[data-testid="calendar-year-month"]').length
  )
  expect(months).toBe(12)

  // Clicking any day in the year drops to that single day.
  await window.evaluate(() => {
    const cells = document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="calendar-year-month"] button[title]'
    )
    // Skip the month-name buttons; the day cells carry a date in their title.
    for (const c of cells) {
      if (/\d/.test(c.textContent ?? '')) {
        c.click()
        return
      }
    }
  })
  await window.waitForTimeout(400)

  const after = await window.evaluate(() => ({
    year: Boolean(document.querySelector('[data-testid="calendar-year"]')),
    mode: localStorage.getItem('calendar.mode')
  }))
  expect(after.year).toBe(false)
  expect(after.mode).toBe('day')
})

test('clicking a day number in the month opens that day', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openCalendar(window)

  await window.getByRole('button', { name: 'Month', exact: true }).click()
  await window.waitForTimeout(400)

  await window.evaluate(() => {
    const cell = document.querySelector<HTMLButtonElement>(
      '[data-testid="calendar-month-cells"] button[title^="Open "]'
    )
    cell?.click()
  })
  await window.waitForTimeout(400)

  expect(await window.evaluate(() => localStorage.getItem('calendar.mode'))).toBe('day')
  expect(
    await window.evaluate(() => Boolean(document.querySelector('[data-testid="calendar-month"]')))
  ).toBe(false)
})

test('a subscribed calendar reaches the calendar view', async () => {
  // Proves the loop the user actually cares about: subscribe in the sheet, and
  // the events show up on the grid they were looking at.
  const { createServer } = await import('node:http')
  const start = new Date()
  start.setHours(10, 0, 0, 0)
  const stamp = (d: Date): string =>
    d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const end = new Date(start.getTime() + 3_600_000)
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//T//EN',
    'BEGIN:VEVENT', 'UID:v1', `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    'SUMMARY:SUBSCRIBEDEVENT', 'LOCATION:Zoom', 'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n')
  const server = createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar' })
    res.end(ics)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(async (url) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.externalCalendars.add({ provider: 'ics', name: 'Work', sourceRef: url })
  }, `http://127.0.0.1:${port}/c.ics`)

  await openCalendar(window)
  await window.getByRole('button', { name: 'Day', exact: true }).click()
  await window.waitForTimeout(800)

  const found = await window.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="external-event"]')).map(
      (e) => e.textContent ?? ''
    )
  )
  server.close()
  expect(found.join(' ')).toContain('SUBSCRIBEDEVENT')
})

test('the calendars sheet opens from the toolbar', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openCalendar(window)
  await window.getByRole('button', { name: 'Calendars' }).click()
  await expect(window.locator('[data-testid="calendars-sheet"]')).toBeVisible()
  await expect(window.locator('[data-testid="calendars-sheet"]')).toContainText('Add a calendar')
})
