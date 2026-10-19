/**
 * emailTaskCreate.spec.ts
 *
 * Verifies the node-creation contract that EmailTaskDialog relies on:
 *
 *   window.api.nodes.create({ parentId: <folder-id>, kind: 'task',
 *     priority: 4, dueDate: <ms>, title, description })
 *
 * must persist:
 *   - parentId === the folder's id
 *   - kind === 'task'
 *   - priority === 4
 *   - dueDate === the supplied timestamp (round-trip through SQLite INTEGER)
 *   - title and description intact
 *
 * The task must also appear in the result of window.api.nodes.list() so
 * that All Tasks (which shows every kind:'task' node) would include it.
 *
 * A second scenario covers the "new folder" path: supplying a fresh folder
 * name causes a folder to be created first, then the task is filed under it.
 * After create, list() must contain both the folder and the task with
 * task.parentId === folder.id.
 *
 * The dialog UI itself (EmailTaskDialog.tsx) requires a live IMAP account to
 * open, which the test environment does not have. These tests therefore drive
 * window.api.nodes directly — the same calls the dialog's submit() makes —
 * and do NOT attempt to render the dialog. That boundary is explicitly
 * documented in the boot-smoke test at the bottom.
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

// ── Test 1: task filed under an existing folder ──────────────────────────────

test('task created via api.nodes.create persists parentId, dueDate, and priority', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  const DUE_MS = new Date('2026-07-15T00:00:00').getTime()

  const result = await window.evaluate(
    async ({ dueMs }: { dueMs: number }) => {
      const api = (window as unknown as { api: typeof window.api }).api

      // Step 1: create the destination folder (mirrors dialog's "new folder" create
      // when parentId dropdown selects an existing folder).
      const folder = await api.nodes.create({
        parentId: null,
        kind: 'folder',
        title: 'Mail folder'
      })

      // Step 2: create the task as EmailTaskDialog.submit() would.
      const task = await api.nodes.create({
        parentId: (folder as { id: string }).id,
        kind: 'task',
        title: 'From email',
        description: 'From Alice Smith <alice@example.com>\n\nHi there, quick question.',
        priority: 4,
        dueDate: dueMs
      })

      // Step 3: list all nodes and return the created ids + list for assertions.
      const all = await api.nodes.list()

      return {
        folderId: (folder as { id: string }).id,
        taskId: (task as { id: string }).id,
        taskDirect: task,
        nodeIds: (all as Array<{ id: string }>).map((n) => n.id),
        allNodes: all
      }
    },
    { dueMs: DUE_MS }
  )

  // The returned task node must have the exact values supplied.
  const task = result.taskDirect as {
    id: string
    parentId: string | null
    kind: string
    title: string
    description: string
    priority: number
    dueDate: number | null
  }

  expect(task.kind).toBe('task')
  expect(task.parentId).toBe(result.folderId)
  expect(task.priority).toBe(4)
  expect(task.dueDate).toBe(DUE_MS)
  expect(task.title).toBe('From email')
  expect(task.description).toContain('Alice Smith')

  // list() must include both the folder and the task.
  expect(result.nodeIds).toContain(result.folderId)
  expect(result.nodeIds).toContain(result.taskId)

  // The task as returned by list() must also carry the same parentId/priority/dueDate.
  const taskFromList = (result.allNodes as Array<{
    id: string
    parentId: string | null
    kind: string
    priority: number
    dueDate: number | null
  }>).find((n) => n.id === result.taskId)

  expect(taskFromList).toBeDefined()
  expect(taskFromList!.kind).toBe('task')
  expect(taskFromList!.parentId).toBe(result.folderId)
  expect(taskFromList!.priority).toBe(4)
  expect(taskFromList!.dueDate).toBe(DUE_MS)

  // No unhandled JS errors during the flow.
  expect(pageErrors).toHaveLength(0)
})

// ── Test 2: "All Tasks (top level)" path — parentId null ────────────────────

test('task created at top level (parentId null) is in list and has priority + dueDate', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  const DUE_MS = new Date('2026-08-01T00:00:00').getTime()

  const result = await window.evaluate(
    async ({ dueMs }: { dueMs: number }) => {
      const api = (window as unknown as { api: typeof window.api }).api

      // No destination folder: dialog selected "All Tasks (top level)" so
      // parentId stays null (the destination variable in submit() defaults to null).
      const task = await api.nodes.create({
        parentId: null,
        kind: 'task',
        title: 'Top-level email task',
        description: 'From Bob Jones <bob@example.com>\n\nPlease review the report.',
        priority: 5,
        dueDate: dueMs
      })

      const all = await api.nodes.list()
      return {
        taskId: (task as { id: string }).id,
        taskDirect: task,
        allNodes: all
      }
    },
    { dueMs: DUE_MS }
  )

  const task = result.taskDirect as {
    id: string
    parentId: string | null
    kind: string
    priority: number
    dueDate: number | null
  }

  expect(task.kind).toBe('task')
  expect(task.parentId).toBeNull()
  expect(task.priority).toBe(5)
  expect(task.dueDate).toBe(DUE_MS)

  // Must appear in the full list with correct field values.
  const taskFromList = (result.allNodes as Array<{
    id: string
    parentId: string | null
    kind: string
    priority: number
    dueDate: number | null
  }>).find((n) => n.id === result.taskId)

  expect(taskFromList).toBeDefined()
  expect(taskFromList!.parentId).toBeNull()
  expect(taskFromList!.priority).toBe(5)
  expect(taskFromList!.dueDate).toBe(DUE_MS)

  expect(pageErrors).toHaveLength(0)
})

// ── Test 3: "new folder" path — folder created first, task filed under it ───

test('new-folder path: creates folder then files task under it', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Mirror exactly what submit() does when newFolder.trim() is truthy.
  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api

    // Dialog creates the folder first.
    const folder = await api.nodes.create({
      parentId: null,
      kind: 'folder',
      title: 'Invoices'
    })
    const folderId = (folder as { id: string }).id

    // Then creates the task under the new folder.
    const task = await api.nodes.create({
      parentId: folderId,
      kind: 'task',
      title: 'Invoice from supplier',
      description: 'From Supplier <billing@supplier.com>\n\nYour invoice is attached.',
      priority: 3,
      dueDate: null
    })

    const all = await api.nodes.list()
    return {
      folderId,
      taskId: (task as { id: string }).id,
      taskParentId: (task as { parentId: string | null }).parentId,
      folderKind: (folder as { kind: string }).kind,
      taskKind: (task as { kind: string }).kind,
      taskDueDate: (task as { dueDate: number | null }).dueDate,
      nodeIds: (all as Array<{ id: string }>).map((n) => n.id)
    }
  })

  // Folder must be a folder, task a task filed under it.
  expect(result.folderKind).toBe('folder')
  expect(result.taskKind).toBe('task')
  expect(result.taskParentId).toBe(result.folderId)
  expect(result.taskDueDate).toBeNull()

  // Both must appear in list().
  expect(result.nodeIds).toContain(result.folderId)
  expect(result.nodeIds).toContain(result.taskId)

  expect(pageErrors).toHaveLength(0)
})

// ── Test 4: boot smoke — Mail nav shows setup screen, no console fatal errors

test('boot smoke: app boots clean and Mail nav shows connect screen without crashing', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
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
