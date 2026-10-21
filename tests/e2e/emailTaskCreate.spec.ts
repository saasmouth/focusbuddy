/**
 * Email → task (DEC-144).
 *
 * "Make a task from this email" adds a TASK to Focus — the one list of tasks —
 * optionally filed on one of your desks, with a due date, an urgency and the
 * email as its source. It used to create a whole desk (or a folder and a desk)
 * through nodes.create; that path and the tests that pinned it are retired.
 *
 * The dialog needs a live mailbox, so these drive the exact store call the
 * dialog makes (window.api.workItems.create with the dialog's draft shape) and
 * read back through workItems.list — the list Focus renders. The boot smoke at
 * the bottom covers the Mail surface itself.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Item = {
  id: string
  kind: string
  parentId: string | null
  title: string
  description: string
  dueAt: string | null
  wiUrgency: string | null
  sourceType: string | null
  intentClass: string | null
}

test('an email becomes a task in Focus, filed on the chosen desk', async () => {
  launched = await launchApp()
  const { window } = launched
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))
  await waitForReady(window)

  const DUE_ISO = new Date('2026-07-15T17:00:00').toISOString()
  const result = await window.evaluate(async (dueAt: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Email desk' })
    const item = await api.workItems.create({
      title: 'From email',
      notes: 'From Alice Smith <alice@example.com>\n\nPlease review the contract.',
      parentId: desk.id,
      intentClass: 'to_do',
      dueAt,
      wiUrgency: 'high',
      sourceType: 'mail',
      wiOrigin: 'human'
    })
    const focus = await api.workItems.list()
    const nodes = await api.nodes.list()
    return { deskId: desk.id, item, focus, nodeIds: (nodes as Array<{ id: string }>).map((n) => n.id) }
  }, DUE_ISO)

  const item = result.item as Item
  expect(item.kind).toBe('work_item')
  expect(item.parentId).toBe(result.deskId)
  expect(item.title).toBe('From email')
  expect(item.description).toContain('Alice Smith')
  expect(item.dueAt).toBe(DUE_ISO)
  expect(item.wiUrgency).toBe('high')
  expect(item.sourceType).toBe('mail')
  // It is in Focus…
  expect((result.focus as Item[]).some((i) => i.id === item.id)).toBe(true)
  // …and it is not a desk: the desk tree never lists a task.
  expect(result.nodeIds).not.toContain(item.id)
  expect(pageErrors).toHaveLength(0)
})

test('an email task with no desk lands in Focus alone', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const item = await api.workItems.create({
      title: 'Reply to Bob',
      notes: 'From Bob <bob@example.com>',
      parentId: null,
      intentClass: 'to_do',
      dueAt: null,
      wiUrgency: null,
      sourceType: 'mail',
      wiOrigin: 'human'
    })
    return { item, focus: await api.workItems.list() }
  })
  const item = result.item as Item
  expect(item.parentId).toBeNull()
  expect(item.dueAt).toBeNull()
  expect((result.focus as Item[]).some((i) => i.id === item.id)).toBe(true)
})

test('boot smoke: app boots clean and Mail nav shows connect screen without crashing', async () => {
  launched = await launchApp()
  const { window } = launched

  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await waitForReady(window)

  // Navigate to Mail — must show the connect / setup screen, not crash.
  await window.getByRole('button', { name: /^Mail$/i }).click()

  // The setup heading must be visible; the dialog requires a live email, so it
  // cannot appear here — that is the documented boundary.
  await expect(
    window.getByRole('heading', { name: /connect your email/i })
  ).toBeVisible({ timeout: 8_000 })

  // No React error boundary covering the screen.
  await expect(
    window.locator('[data-testid="fatal-error"], [data-error-boundary]')
  ).toHaveCount(0)

  // No module/IPC/init failures in the console.
  const fatal = consoleErrors.filter(
    (e) =>
      /Cannot find module|ipcRenderer|Uncaught|SyntaxError|ReferenceError/.test(e) &&
      !/favicon/.test(e)
  )
  expect(fatal).toHaveLength(0)
})
