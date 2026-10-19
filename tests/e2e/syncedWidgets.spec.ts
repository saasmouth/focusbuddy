/**
 * Synced Duplicate Widgets — IPC/DB level E2E
 *
 * Verifies the `syncGroupId` propagation introduced in 2.4.3:
 *   - content / title / colour mirror to all widgets sharing the same syncGroupId
 *   - position (x / y) does NOT mirror
 *   - setting syncGroupId = null stops future propagation
 *   - cross-task propagation (same DB fan-out SQL)
 *   - no crash / no infinite recursion
 *
 * Everything is exercised via window.api (IPC → main process → SQLite) so
 * this tests the actual propagation SQL, not the renderer store.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// One LaunchedApp per test — each gets a fresh isolated userData dir.
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ---------------------------------------------------------------------------
// Helper: boot app + get an active task id via IPC
// ---------------------------------------------------------------------------
async function bootAndSeedTask(app: LaunchedApp): Promise<string> {
  const { window } = app
  await waitForReady(window)
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Sync test task'
    })
    return task.id
  })
  return taskId
}

// ---------------------------------------------------------------------------
// Helper: read a widget by id from a given taskId via IPC
// ---------------------------------------------------------------------------
async function readWidget(
  app: LaunchedApp,
  widgetId: string,
  taskId: string
): Promise<Record<string, unknown> | null> {
  return app.window.evaluate(
    async ({ wid, tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const all = await api.widgets.listByTask(tid)
      const w = all.find((x) => x.id === wid)
      return w ? (w as unknown as Record<string, unknown>) : null
    },
    { wid: widgetId, tid: taskId }
  )
}

// ============================================================================
// Test 1 — Migration: app boots without pageerror; sync_group_id column exists
// ============================================================================
test('migration — app boots clean, sync_group_id column accessible', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  // Collect any uncaught page errors during boot.
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // No page errors from boot.
  expect(pageErrors).toHaveLength(0)

  // The column is reachable: create a widget with a syncGroupId and read it back.
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'migrate-check' })
    return task.id
  })

  const widgetId = await window.evaluate(
    async ({ tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const w = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'col-check',
        content: '{}',
        x: 10,
        y: 10,
        syncGroupId: 'col-check-grp'
      })
      return w.id
    },
    { tid: taskId }
  )

  const w = await readWidget(launched, widgetId, taskId)
  expect(w).not.toBeNull()
  // Was: toBe('col-check-grp'). Since 4.3.32 every standalone work widget is a
  // file (docs/widget-files.md), so a sticky's ordinary linked-duplicate group
  // becomes the group of ONE work widget file the moment it is created — the
  // column is still written and read back, now as `wf:<file id>`.
  expect((w as { syncGroupId?: string }).syncGroupId).toMatch(/^wf:/)
})

// ============================================================================
// Test 2 — Content sync between two same-task widgets
// ============================================================================
test('content mirrors from A to B when both share syncGroupId', async () => {
  launched = await launchApp()
  const taskId = await bootAndSeedTask(launched)

  // Create widget A (no syncGroupId yet).
  const widgetAId = await launched.window.evaluate(
    async ({ tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const w = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'Widget A',
        content: '{"v":1}',
        x: 50,
        y: 50
      })
      return w.id
    },
    { tid: taskId }
  )

  // Assign syncGroupId to A.
  await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { syncGroupId: 'grp-test' })
    },
    { wid: widgetAId }
  )

  // Create widget B already in the same sync group.
  const widgetBId = await launched.window.evaluate(
    async ({ tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const w = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'Widget B',
        content: '{"v":1}',
        x: 300,
        y: 50,
        syncGroupId: 'grp-test'
      })
      return w.id
    },
    { tid: taskId }
  )

  // Verify both widgets exist and share the group.
  const wA0 = await readWidget(launched, widgetAId, taskId)
  const wB0 = await readWidget(launched, widgetBId, taskId)
  // Was: both toBe('grp-test'). Since 4.3.32 an ordinary group of a
  // standalone kind becomes ONE work widget file shared by every member, so
  // the two share a `wf:` group instead — and still mirror, below.
  const groupA = (wA0 as { syncGroupId?: string }).syncGroupId
  expect(groupA).toMatch(/^wf:/)
  expect((wB0 as { syncGroupId?: string }).syncGroupId).toBe(groupA)

  // Update A's content — B should mirror.
  await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { content: '{"v":2}' })
    },
    { wid: widgetAId }
  )

  const wB1 = await readWidget(launched, widgetBId, taskId)
  expect((wB1 as { content?: string }).content).toBe('{"v":2}')
})

// ============================================================================
// Test 3 — Title + colour sync
// ============================================================================
test('title and colour mirror from A to B', async () => {
  launched = await launchApp()
  const taskId = await bootAndSeedTask(launched)

  const { widgetAId, widgetBId } = await launched.window.evaluate(
    async ({ tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'InitTitle',
        content: '{}',
        x: 50,
        y: 50,
        syncGroupId: 'grp-colour'
      })
      const b = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'InitTitle',
        content: '{}',
        x: 300,
        y: 50,
        syncGroupId: 'grp-colour'
      })
      return { widgetAId: a.id, widgetBId: b.id }
    },
    { tid: taskId }
  )

  // Update title + colour on A.
  await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { title: 'Shared', color: '#ff0000' })
    },
    { wid: widgetAId }
  )

  const wB = await readWidget(launched, widgetBId, taskId)
  expect((wB as { title?: string }).title).toBe('Shared')
  expect((wB as { color?: string }).color).toBe('#ff0000')
})

// ============================================================================
// Test 4 — Position does NOT sync
// ============================================================================
test('position (x, y) does NOT mirror to sibling widget', async () => {
  launched = await launchApp()
  const taskId = await bootAndSeedTask(launched)

  const { widgetAId, widgetBId, bOrigX, bOrigY } = await launched.window.evaluate(
    async ({ tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'Pos A',
        content: '{}',
        x: 50,
        y: 50,
        syncGroupId: 'grp-pos'
      })
      const b = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'Pos B',
        content: '{}',
        x: 200,
        y: 200,
        syncGroupId: 'grp-pos'
      })
      return { widgetAId: a.id, widgetBId: b.id, bOrigX: b.x, bOrigY: b.y }
    },
    { tid: taskId }
  )

  // Move A to a very different position.
  await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { x: 999, y: 999 })
    },
    { wid: widgetAId }
  )

  const wB = await readWidget(launched, widgetBId, taskId)
  // B must retain its original position.
  expect((wB as { x?: number }).x).toBe(bOrigX)
  expect((wB as { y?: number }).y).toBe(bOrigY)
  // Confirm A actually moved (sanity).
  const wA = await readWidget(launched, widgetAId, taskId)
  expect((wA as { x?: number }).x).toBe(999)
  expect((wA as { y?: number }).y).toBe(999)
})

// ============================================================================
// Test 5 — Cross-task propagation
// ============================================================================
test('content mirrors to a widget on a DIFFERENT task sharing the same syncGroupId', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)

  // Create two separate tasks.
  const { taskAId, taskBId, widgetAId, widgetBId } = await launched.window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const taskA = await api.nodes.create({ parentId: null, kind: 'task', title: 'Cross task A' })
    const taskB = await api.nodes.create({ parentId: null, kind: 'task', title: 'Cross task B' })
    const wA = await api.widgets.create({
      taskId: taskA.id,
      kind: 'sticky',
      title: 'Cross A',
      content: '{"cross":1}',
      x: 50,
      y: 50,
      syncGroupId: 'grp-cross'
    })
    const wB = await api.widgets.create({
      taskId: taskB.id,
      kind: 'sticky',
      title: 'Cross B',
      content: '{"cross":1}',
      x: 50,
      y: 50,
      syncGroupId: 'grp-cross'
    })
    return { taskAId: taskA.id, taskBId: taskB.id, widgetAId: wA.id, widgetBId: wB.id }
  })

  // Verify they live on separate tasks.
  const wA0 = await readWidget(launched, widgetAId, taskAId)
  const wB0 = await readWidget(launched, widgetBId, taskBId)
  expect(wA0).not.toBeNull()
  expect(wB0).not.toBeNull()

  // Update A's content — should fan-out to B (different task_id, same sync_group_id).
  await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { content: '{"cross":2}' })
    },
    { wid: widgetAId }
  )

  const wB1 = await readWidget(launched, widgetBId, taskBId)
  expect((wB1 as { content?: string }).content).toBe('{"cross":2}')
})

// ============================================================================
// Test 6 — Unlink stops sync
// ============================================================================
test('setting syncGroupId = null stops future propagation', async () => {
  launched = await launchApp()
  const taskId = await bootAndSeedTask(launched)

  const { widgetAId, widgetBId } = await launched.window.evaluate(
    async ({ tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'Unlink A',
        content: '{"v":1}',
        x: 50,
        y: 50,
        syncGroupId: 'grp-unlink'
      })
      const b = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'Unlink B',
        content: '{"v":1}',
        x: 300,
        y: 50,
        syncGroupId: 'grp-unlink'
      })
      return { widgetAId: a.id, widgetBId: b.id }
    },
    { tid: taskId }
  )

  // First confirm sync still works before unlink.
  await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { content: '{"v":10}' })
    },
    { wid: widgetAId }
  )
  const wBPre = await readWidget(launched, widgetBId, taskId)
  expect((wBPre as { content?: string }).content).toBe('{"v":10}')

  // Unlink A (set syncGroupId to null).
  await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { syncGroupId: null })
    },
    { wid: widgetAId }
  )

  // Verify A's syncGroupId is now null.
  const wAUnlinked = await readWidget(launched, widgetAId, taskId)
  expect((wAUnlinked as { syncGroupId?: string | null }).syncGroupId).toBeNull()

  // Update A's content — B must NOT mirror (A is no longer in the group).
  await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { content: '{"v":99}' })
    },
    { wid: widgetAId }
  )

  const wBPost = await readWidget(launched, widgetBId, taskId)
  // B should still have {"v":10}, not {"v":99}.
  expect((wBPost as { content?: string }).content).toBe('{"v":10}')
})

// ============================================================================
// Test 7 — No loop / no crash: update returns normally
// ============================================================================
test('update with syncGroupId completes without crash or timeout', async () => {
  launched = await launchApp()
  const taskId = await bootAndSeedTask(launched)

  // Create a chain of 3 widgets in the same group.
  const ids = await launched.window.evaluate(
    async ({ tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await Promise.all(
        [0, 1, 2].map((i) =>
          api.widgets.create({
            taskId: tid,
            kind: 'sticky',
            title: `Loop ${i}`,
            content: `{"i":${i}}`,
            x: 50 + i * 200,
            y: 50,
            syncGroupId: 'grp-loop'
          })
        )
      )
      return ws.map((w) => w.id)
    },
    { tid: taskId }
  )

  // Update the first widget — should return with no error and all siblings mirror.
  const updated = await launched.window.evaluate(
    async ({ wid, tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const result = await api.widgets.update(wid, { content: '{"loop":"done"}' })
      const all = await api.widgets.listByTask(tid)
      return { resultId: result?.id, all: all.map((w) => ({ id: w.id, content: w.content })) }
    },
    { wid: ids[0], tid: taskId }
  )

  // update returned the updated widget (no crash).
  expect(updated.resultId).toBe(ids[0])

  // All 3 widgets now share the mirrored content.
  for (const w of updated.all.filter((w) => ids.includes(w.id))) {
    expect(w.content).toBe('{"loop":"done"}')
  }
})

// ============================================================================
// Regression Tests — normal (unlinked) widget paths still work
// ============================================================================
test('regression — normal widget create/update/list without syncGroupId still works', async () => {
  launched = await launchApp()
  const taskId = await bootAndSeedTask(launched)

  const widgetId = await launched.window.evaluate(
    async ({ tid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const w = await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: 'Solo',
        content: '{"solo":true}',
        x: 100,
        y: 100
      })
      return w.id
    },
    { tid: taskId }
  )

  // Update without syncGroupId — should work as before.
  const updated = await launched.window.evaluate(
    async ({ wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.widgets.update(wid, { title: 'Updated Solo', content: '{"solo":2}' })
    },
    { wid: widgetId }
  )

  expect((updated as { title?: string }).title).toBe('Updated Solo')
  expect((updated as { content?: string }).content).toBe('{"solo":2}')
  // Was: toBeNull(). Since 4.3.32 a lone sticky is a work widget file with one
  // instance (docs/widget-files.md), so its group is the file's own; what this
  // regression pins — create/update/list work as before — is unchanged.
  expect((updated as { syncGroupId?: string | null }).syncGroupId).toMatch(/^wf:/)
})
