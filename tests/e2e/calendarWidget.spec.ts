import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// The desk calendar: narrowed by criteria, and openable for detail and edit.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: LaunchedApp['window']) {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Campaign desk' })
    const other = await api.nodes.create({ parentId: null, kind: 'task', title: 'Other desk' })
    const d = new Date()
    d.setHours(12, 0, 0, 0)
    const due = d.getTime()

    const mine = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'RIDGE photos' })
    await api.nodes.update(mine.id, { dueDate: due, assignee: 'Michael' })
    const drafty = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'RIDGE draft copy' })
    await api.nodes.update(drafty.id, { dueDate: due })
    const elsewhere = await api.nodes.create({ parentId: other.id, kind: 'task', title: 'RIDGE elsewhere' })
    await api.nodes.update(elsewhere.id, { dueDate: due })

    await api.widgets.create({
      taskId: desk.id, kind: 'calendar' as never, title: 'Calendar',
      content: '', x: 120, y: 120, width: 420, height: 460
    })
    return { deskId: desk.id, mineId: mine.id, draftyId: drafty.id, elsewhereId: elsewhere.id, due }
  })
}

async function open(window: LaunchedApp['window'], deskId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
}

test('the calendar narrows to this desk, and by criteria', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)
  await open(window, ids.deskId)

  const cal = window.locator('[data-widget-kind="calendar"]').first()
  await expect(cal).toBeVisible({ timeout: 10_000 })

  // Default scope is this desk: the other desk's task must not appear.
  await cal.getByTestId('calendar-open-day').click()
  const modal = window.locator('[data-testid="calendar-day-modal"]')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('RIDGE photos')
  await expect(modal).toContainText('RIDGE draft copy')
  await expect(modal).not.toContainText('RIDGE elsewhere')
  await window.keyboard.press('Escape')

  // Now exclude drafts.
  await cal.getByTestId('calendar-filter-toggle').click()
  await cal.getByPlaceholder('But not…', { exact: false }).fill('draft')
  await window.waitForTimeout(500)
  await cal.getByTestId('calendar-filter-done').click()

  await cal.getByTestId('calendar-open-day').click()
  await expect(modal).toContainText('RIDGE photos')
  await expect(modal).not.toContainText('RIDGE draft copy')
  // The rule is stated on the widget, so an empty day can be told from a typo.
  await window.keyboard.press('Escape')
  await expect(cal).toContainText('not draft')
})

test('opening a day lets a task be edited, and the change sticks', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)
  await open(window, ids.deskId)

  const cal = window.locator('[data-widget-kind="calendar"]').first()
  await expect(cal).toBeVisible({ timeout: 10_000 })
  await cal.getByTestId('calendar-open-day').click()

  const modal = window.locator('[data-testid="calendar-day-modal"]')
  await expect(modal).toBeVisible()
  await modal.getByText('RIDGE photos').click()

  // Mark it done through the modal.
  await modal.locator('select').first().selectOption('done')
  await window.waitForTimeout(600)

  const status = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.nodes.list()).find((n: { id: string }) => n.id === id)?.status
  }, ids.mineId)
  expect(status).toBe('done')
})

test('a subscribed event is shown as read-only, and says why', async () => {
  const { createServer } = await import('node:http')
  const d = new Date()
  d.setHours(10, 0, 0, 0)
  const stamp = (x: Date): string => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//T//EN',
    'BEGIN:VEVENT', 'UID:e1', `DTSTART:${stamp(d)}`,
    `DTEND:${stamp(new Date(d.getTime() + 3600_000))}`,
    'SUMMARY:BOARDMEETING', 'LOCATION:Zoom', 'END:VEVENT', 'END:VCALENDAR'
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
  const ids = await seed(window)
  await window.evaluate(async (url) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.externalCalendars.add({ provider: 'ics', name: 'Work', sourceRef: url })
  }, `http://127.0.0.1:${port}/c.ics`)
  await open(window, ids.deskId)

  const cal = window.locator('[data-widget-kind="calendar"]').first()
  await expect(cal).toBeVisible({ timeout: 10_000 })
  await cal.getByTestId('calendar-open-day').click()

  const modal = window.locator('[data-testid="calendar-day-modal"]')
  await expect(modal).toContainText('BOARDMEETING')
  await modal.getByText('BOARDMEETING').click()
  // It must say it cannot be edited here rather than offering a field that
  // would vanish at the next sync.
  await expect(modal).toContainText('read-only')
  server.close()
})
