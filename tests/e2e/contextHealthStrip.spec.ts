// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// Context Health strip on the desk canvas (plexi-4.0, commit f872a30 + reachability
// fix 55991cf). The strip's data (contextHealth.ts / context:* IPC) was proven live
// in contextEngineLiveWire.spec.ts; this spec covers the RENDERED surface: Canvas.tsx
// floats <ContextHealthStrip variant="chrome" data-testid="context-health-strip">
// under the breadcrumb for the active desk, and it must render nothing when the
// desk is calm.
//
// Desk-opening is driven the same way the real app does it: navigating to a 'task'
// or 'project-dashboard' view runs App.tsx's view-sync effect
// (`if (currentView.kind === 'task') setActive(currentView.taskId)` / the
// project-dashboard equivalent), which is the exact production code path a real
// click on a desk tile (DeskGallery, DesksView, FoldersCard, etc.) also runs.
// Driven via the exposed __fbView store rather than a specific dashboard tile so
// the spec doesn't depend on which cards happen to be present in a fresh test DB.
//
// Nodes are seeded through window.api.nodes directly (bypassing the renderer's
// nodes.ts store), so a `window.reload()` follows each seeding step — the same
// pattern used elsewhere in this suite (see multiSelect.spec.ts) — to let the
// store's normal boot-time refresh() pick the seeded nodes up. Without the
// reload, the renderer's local `nodes` array never learns about IPC-created
// nodes and `activeTask` resolves to null, which is a test-harness gap, not a
// product one — a real UI-driven create() always updates local state.

async function goTaskAndSettle(window: import('@playwright/test').Page, id: string): Promise<void> {
  await window.evaluate((taskId) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
    w.__fbView?.getState().goTask(taskId)
  }, id)
  // Let App.tsx's setActive effect + the fire-and-forget openDesk chain
  // (health fetch -> markReviewed -> refresh + refreshMany) settle.
  await window.waitForTimeout(400)
}

test('CONTEXT-HEALTH-STRIP — regression: desk navigation stays clean with the strip mounted', async () => {
  const { app, window, dispose } = await launchApp()
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => pageErrors.push(err.message))
  let mainStderr = ''
  app.process().stderr?.on('data', (b) => { mainStderr += b.toString() })

  try {
    await waitForReady(window)

    const ids = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      type N = { id: string }
      const a = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Nav Desk A' })) as N
      const b = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Nav Desk B' })) as N
      const c = (await api.nodes.create({ parentId: null, kind: 'folder', title: 'Nav Room C' })) as N
      return { a: a.id, b: b.id, c: c.id }
    })
    await window.reload()
    await waitForReady(window)

    // Hot-path stress: rapid desk switches across task and folder kinds, the same
    // thing setActive fires on every real navigation.
    const order = [ids.a, ids.b, ids.c, ids.a, ids.b, ids.a, ids.c, ids.b]
    for (const id of order) {
      await window.evaluate(
        ({ nodeId, folderId }) => {
          const w = window as unknown as {
            __fbView?: { getState: () => { goTask: (id: string) => void; goProject: (id: string) => void } }
          }
          // Folders resolve through goProject, tasks through goTask — both funnel
          // into the same App.tsx setActive sync effect and land on <Canvas/>.
          const state = w.__fbView?.getState()
          if (nodeId === folderId) state?.goProject(nodeId)
          else state?.goTask(nodeId)
        },
        { nodeId: id, folderId: ids.c }
      )
      await window.waitForTimeout(120)
    }
    await window.waitForTimeout(500)

    expect(pageErrors, `pageerror events: ${JSON.stringify(pageErrors)}`).toEqual([])
    const unexpectedConsoleErrors = consoleErrors.filter(
      (e) => !e.includes('Failed to load resource: the server responded with a status of 404')
    )
    expect(unexpectedConsoleErrors, `console.error: ${JSON.stringify(unexpectedConsoleErrors)}`).toEqual([])
    expect(mainStderr.includes('[context-engine]'), `main stderr:\n${mainStderr}`).toBe(false)

    // The canvas itself rendered normally throughout (didn't get stuck / crash to
    // a blank surface) after the final switch. data-canvas-surface is unique to
    // the outer canvas root (data-bare-canvas also appears on an inner
    // pan-transform child, which trips Playwright's strict-mode uniqueness check).
    await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible()
  } finally {
    await dispose()
  }
})

test('CONTEXT-HEALTH-STRIP — reachability: related-desk change surfaces an attention chip on the canvas', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const ids = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      type N = { id: string }
      const a = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk Alpha' })) as N
      const b = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk Beta' })) as N
      return { a: a.id, b: b.id }
    })
    await window.reload()
    await waitForReady(window)

    // Open Alpha first so it has an established review point.
    await goTaskAndSettle(window, ids.a)

    // Relate them (the operator's documented API surface), then push Beta into a
    // materially significant change so its OWN health crosses into
    // attention-required (a purely cosmetic edit at default importance lands in
    // the lower 'changed' band, which the strip's relatedRows filter does NOT
    // surface — only attention-required / decision-risk do).
    await window.evaluate(async ({ a, b }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.nodes.relate(a, b)
      await api.nodes.update(b, { importance: 5 })
    }, ids)

    // Re-open Alpha: the strip should now show Beta as a related desk needing
    // attention.
    await goTaskAndSettle(window, ids.a)

    const strip = window.locator('[data-testid="context-health-strip"]')
    await expect(strip).toBeVisible()
    await expect(strip).toContainText('Related')
    await expect(strip).toContainText('Desk Beta')
    await expect(strip).toContainText('Needs attention')

    // Cross-check against the same context:* read surface the strip itself calls.
    const apiCheck = await window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.context!.health(id)
    }, ids.b)
    expect(apiCheck.state).toBe('attention-required')

    // Clicking the related chip is a real click (not a store call). The strip
    // routes by the target's own kind (src/renderer/src/components/
    // ContextHealthStrip.tsx): Beta is a task-kind desk, so the resulting view is
    // kind 'task' with taskId = Beta's id. MainPane routes that to <Canvas/> and
    // App.tsx points activeTaskId at Beta, so the desk opens correctly.
    await strip.getByText('Desk Beta').click()
    await window.waitForTimeout(300)
    const view = await window.evaluate(() => {
      const w = window as unknown as {
        __fbView?: { getState: () => { view: { kind: string; projectId?: string; taskId?: string } } }
      }
      return w.__fbView?.getState().view
    })
    expect(view?.kind).toBe('task')
    expect(view?.taskId).toBe(ids.b)
  } finally {
    await dispose()
  }
})

test('CONTEXT-HEALTH-STRIP — calm desk: no strip once reviewed with no pending changes and no related desks', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const id = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      type N = { id: string }
      const desk = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Calm Desk' })) as N
      return desk.id
    })
    await window.reload()
    await waitForReady(window)

    // First-ever open: this desk was never reviewed, and its own creation is
    // itself one Event on the object — recorded here for honesty, not asserted
    // as pass/fail, since "no prior visit at all" is a different case from the
    // steady-state "calm" case the commit message and the operator's ask target.
    await goTaskAndSettle(window, id)
    const firstOpenHealth = await window.evaluate(async (deskId) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.context!.health(deskId)
    }, id)
    const firstOpenStripVisible = await window.locator('[data-testid="context-health-strip"]').isVisible()

    // Navigate away, then back with NO changes and NO relations in between —
    // this is the calm/steady-state case: reviewed once, nothing since, nothing
    // related. The commit's own words: "renders nothing when the desk is calm."
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
      w.__fbView?.getState().goHome()
    })
    await window.waitForTimeout(200)
    await goTaskAndSettle(window, id)

    const strip = window.locator('[data-testid="context-health-strip"]')
    await expect(strip).toHaveCount(0)

    const steadyHealth = await window.evaluate(async (deskId) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.context!.health(deskId)
    }, id)
    expect(steadyHealth.state).toBe('current')
    expect(steadyHealth.changedEventCount).toBe(0)

    console.log('FIRST_OPEN_INFO (informational only)', JSON.stringify({ firstOpenHealth, firstOpenStripVisible }))
  } finally {
    await dispose()
  }
})
