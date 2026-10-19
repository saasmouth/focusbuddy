import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// PlexiBrain > Assemble a desk: search the brain, tick widgets (and the related
// items surfaced from the graph), then spin up a new desk holding them, as
// live-synced copies by default, or disconnected copies with the toggle off.
//
// Navigation and search/tick/create are UI-driven. Seeding source data and the
// "related" graph edge are API-driven (window.api) because there is no UI path
// yet to relate two individual widgets, see step 2 below for why.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('assemble a desk: search, collect, related surfacing, synced + disconnected create', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  await waitForReady(window)

  // ── Seed: a source desk with two distinctively-worded sticky widgets ──────
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const source = await api.nodes.create({ parentId: null, kind: 'task', title: 'Assemble source desk' })
    const stickyA = await api.widgets.create({
      taskId: source.id,
      kind: 'sticky',
      title: 'Roadmap note',
      content: 'ZEBRAQUARTZ-alpha planning notes',
      x: 40,
      y: 40,
      width: 200,
      height: 160
    })
    const stickyB = await api.widgets.create({
      taskId: source.id,
      kind: 'sticky',
      title: 'Follow-up note',
      content: 'ZEBRAQUARTZ-beta follow-up items',
      x: 260,
      y: 40,
      width: 200,
      height: 160
    })
    // A third, independently-searchable sticky for the disconnected-create run
    // (step 5), so that step's search does not collide with the copies the
    // synced-create run (step 4) leaves behind on "Assembled synced desk" —
    // those copies share stickyA/stickyB's title and content, so a shared
    // search term would return 4 hits instead of a clean 1.
    const stickyC = await api.widgets.create({
      taskId: source.id,
      kind: 'sticky',
      title: 'Standalone note',
      content: 'YAKWRENCH-gamma disconnect test',
      x: 480,
      y: 40,
      width: 200,
      height: 160
    })
    return { sourceDeskId: source.id, stickyAId: stickyA.id, stickyBId: stickyB.id, stickyCId: stickyC.id }
  })

  // A confirmed graph relationship between the two widgets so the assemble
  // view's context.related(widgetId) lookup has a neighbour to surface. There
  // is no UI affordance to relate two widgets directly (widgetLinks:create
  // draws a canvas ghost-wire but does not feed the context engine, only
  // nodes:relate calls mirrorUserRelation). nodes:relate stores an opaque
  // (a, b) edge with no type check on the ids, and context:related reads
  // confirmed relationships by raw entity id regardless of kind, so calling
  // it with the two widget ids is the only real path to a widget-to-widget
  // "related" edge today. Documented here as an API-driven step, not a UI bug.
  await window.evaluate(async ({ stickyAId, stickyBId }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.relate(stickyAId, stickyBId)
  }, seeded)

  const relatedIds = await window.evaluate(
    (id) => (window as unknown as { api: typeof window.api }).api.context.related(id),
    seeded.stickyAId
  )
  expect(relatedIds).toContain(seeded.stickyBId)

  // ── Step 1: navigate to PlexiBrain > Assemble a desk, assert empty state ──
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => { go: (v: { kind: string; app?: string }) => void } }
    }
    w.__fbView?.getState().go({ kind: 'plexibrain', app: 'assemble' })
  })
  const view = window.locator('[data-testid="assemble-desk-view"]')
  await expect(view).toBeVisible()
  await expect(window.locator('[data-testid="assemble-empty"]')).toBeVisible()
  await expect(window.locator('[data-testid="assemble-tray"]')).toHaveCount(0)

  // ── Step 2: search + collect (UI-driven) ──────────────────────────────────
  const search = window.locator('[data-testid="assemble-search"]')
  await search.fill('ZEBRAQUARTZ')
  const results = window.locator('[data-testid="assemble-result"]')
  await expect(results).toHaveCount(2, { timeout: 5_000 })

  const resultA = results.filter({ hasText: 'Roadmap note' })
  await expect(resultA).toBeVisible()
  await expect(resultA).toHaveAttribute('data-checked', 'false')
  await resultA.locator('input[type="checkbox"]').click()
  await expect(resultA).toHaveAttribute('data-checked', 'true')

  const tray = window.locator('[data-testid="assemble-tray"]')
  await expect(tray).toBeVisible()
  await expect(tray).toContainText('1 item collected')

  // ── Step 3: related surfacing, the graph neighbour appears as tickable ───
  const relatedSection = window.locator('[data-testid="assemble-related"]')
  await expect(relatedSection).toBeVisible({ timeout: 5_000 })
  const relatedRow = window.locator('[data-testid="assemble-related-row"]').filter({ hasText: 'Follow-up note' })
  await expect(relatedRow).toBeVisible()

  // Tick the related row too, so both are in the tray for the synced-create run.
  await relatedRow.locator('input[type="checkbox"]').click()
  await expect(tray).toContainText('2 items collected')

  // ── Step 4: SYNCED create (the headline contract) ─────────────────────────
  await expect(window.locator('[data-testid="assemble-synced-toggle"]')).toBeChecked() // default ON
  const deskNameInput = window.locator('[data-testid="assemble-desk-name"]')
  await deskNameInput.fill('Assembled synced desk')
  await window.locator('[data-testid="assemble-create"]').click()

  // Navigated off the assemble view onto the new desk's ACTUAL canvas, not the
  // "No desks yet" empty gallery a stale renderer node cache used to fall back
  // to (the bug this spec caught: creating the desk via a raw IPC call instead
  // of the node store left useNodeStore's `nodes` array without the new desk,
  // so Canvas.tsx's activeTask lookup failed and rendered DeskGallery instead).
  await expect(view).toHaveCount(0, { timeout: 10_000 })
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  await expect(window.getByText('No desks yet')).toHaveCount(0)
  await expect(window.getByText('Assembled synced desk').first()).toBeVisible({ timeout: 5_000 })

  const syncedCheck = await window.evaluate(async ({ sourceDeskId, stickyAId }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const source = await api.widgets.get(stickyAId)
    // Find the new desk by name and pull its widgets. The view store doesn't
    // expose the active desk id directly to window, so look it up by title.
    const roots = await api.nodes.list()
    const newDesk = roots.find((n) => n.title === 'Assembled synced desk')
    const copies = newDesk ? await api.widgets.listByTask(newDesk.id) : []
    const copy = copies.find((w) => w.content === source?.content && w.taskId !== sourceDeskId)
    return {
      deskFound: !!newDesk,
      copyCount: copies.length,
      copyId: copy?.id ?? null,
      sourceGroup: source?.syncGroupId ?? null,
      copyGroup: copy?.syncGroupId ?? null
    }
  }, seeded)

  expect(syncedCheck.deskFound).toBe(true)
  expect(syncedCheck.copyCount).toBe(2) // both collected widgets landed on the new desk
  expect(syncedCheck.sourceGroup).not.toBeNull()
  expect(syncedCheck.copyGroup).toBe(syncedCheck.sourceGroup)

  // The copy widget is actually painted on the new desk's canvas (UI-level,
  // not just present in the DB) — the specific regression this spec exists to
  // catch would leave the DB record correct but the screen empty.
  await expect(window.locator(`[data-widget-id="${syncedCheck.copyId}"]`)).toBeVisible({ timeout: 5_000 })
  await expect(window.locator(`[data-widget-id="${syncedCheck.copyId}"]`)).toContainText(
    'ZEBRAQUARTZ-alpha planning notes'
  )

  // Live-sync contract: editing the SOURCE mirrors onto the copy.
  await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.update(id, { content: 'ZEBRAQUARTZ-alpha EDITED VIA SOURCE' })
  }, seeded.stickyAId)

  const mirrored = await window.evaluate(async ({ sourceGroup }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const roots = await api.nodes.list()
    const newDesk = roots.find((n) => n.title === 'Assembled synced desk')
    const copies = newDesk ? await api.widgets.listByTask(newDesk.id) : []
    return copies.find((w) => w.syncGroupId === sourceGroup)?.content ?? null
  }, syncedCheck)

  expect(mirrored).toBe('ZEBRAQUARTZ-alpha EDITED VIA SOURCE')

  // ── Step 5: DISCONNECTED create ───────────────────────────────────────────
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => { go: (v: { kind: string; app?: string }) => void } }
    }
    w.__fbView?.getState().go({ kind: 'plexibrain', app: 'assemble' })
  })
  await expect(view).toBeVisible()

  // Use the third, still-unique sticky for this run — the "ZEBRAQUARTZ" term
  // now also matches the two synced copies left on "Assembled synced desk"
  // from step 4, so it would return 4 hits instead of a clean 1.
  await search.fill('YAKWRENCH')
  await expect(results).toHaveCount(1, { timeout: 5_000 })
  const resultC = results.filter({ hasText: 'Standalone note' })
  await resultC.locator('input[type="checkbox"]').click()
  await expect(tray).toBeVisible()

  const syncedToggle = window.locator('[data-testid="assemble-synced-toggle"]')
  await syncedToggle.uncheck()
  await expect(syncedToggle).not.toBeChecked()

  await deskNameInput.fill('Assembled disconnected desk')
  await window.locator('[data-testid="assemble-create"]').click()
  await expect(view).toHaveCount(0, { timeout: 10_000 })
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  await expect(window.getByText('No desks yet')).toHaveCount(0)
  await expect(window.getByText('Assembled disconnected desk').first()).toBeVisible({ timeout: 5_000 })

  const disconnectedCheck = await window.evaluate(async ({ stickyCId }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const roots = await api.nodes.list()
    const newDesk = roots.find((n) => n.title === 'Assembled disconnected desk')
    const copies = newDesk ? await api.widgets.listByTask(newDesk.id) : []
    const source = await api.widgets.get(stickyCId)
    const copy = copies[0]
    return {
      deskFound: !!newDesk,
      copyCount: copies.length,
      copyContentBefore: copy?.content ?? null,
      copyGroup: copy?.syncGroupId ?? null,
      sourceGroup: source?.syncGroupId ?? null,
      copyId: copy?.id ?? null
    }
  }, seeded)

  expect(disconnectedCheck.deskFound).toBe(true)
  expect(disconnectedCheck.copyCount).toBe(1)
  expect(disconnectedCheck.copyContentBefore).toBe('YAKWRENCH-gamma disconnect test')
  expect(disconnectedCheck.sourceGroup).toBeNull() // stickyC was never synced, so it never got a group at all
  expect(disconnectedCheck.copyGroup).toBeNull() // disconnected create must not stamp one either

  // Painted on screen too, same regression guard as the synced-create step.
  await expect(window.locator(`[data-widget-id="${disconnectedCheck.copyId}"]`)).toBeVisible({ timeout: 5_000 })

  // Editing the source again must NOT touch the disconnected copy.
  await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.update(id, { content: 'YAKWRENCH-gamma EDITED AFTER DISCONNECT' })
  }, seeded.stickyCId)

  const disconnectedAfter = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.get(id))?.content ?? null
  }, disconnectedCheck.copyId)

  expect(disconnectedAfter).toBe('YAKWRENCH-gamma disconnect test') // unchanged by the source edit

  // ── Step 6: no regressions, zero errors, SyncWidgetPicker unaffected ──────
  expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([])
  // "Failed to load resource: 404" is pre-existing boot noise across the whole
  // suite (the hermetic test app has no network reachability to the production
  // signal host, so a features/votes fetch 404s at boot) — filtered the same
  // way contextEngineLiveWire.spec.ts / decisionsPanel.spec.ts / documents.spec.ts
  // and others do, not specific to this feature.
  const seriousConsoleErrors = consoleErrors.filter(
    (m) => !/ResizeObserver|Warning:/.test(m) && !m.includes('Failed to load resource')
  )
  expect(seriousConsoleErrors, `console errors: ${seriousConsoleErrors.join('\n')}`).toEqual([])
})
