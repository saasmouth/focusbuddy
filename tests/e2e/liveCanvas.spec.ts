/**
 * liveCanvas.spec.ts — coverage for the canvas board round-trip + the "Collaborate
 * live" entry point, after the live-canvas mechanism was retired (WS01 lock-retire).
 *
 * The old server-canonical live canvas (mirror + check-out lock) is gone: a desk now
 * collaborates by sharing the real desk on the CRDT substrate, and legacy canvases
 * convert to a real desk on open. What remains valid to test here:
 *
 *   LC-1  applyCanvasBodyToTask round-trip (the function is still load-bearing — it
 *         materialises a legacy canvas body into a real desk during migration). Build
 *         a CanvasBody with two stickies + a link and rebuild it into a fresh task via
 *         the IPC contract the function depends on; assert widgets + link (with
 *         remapped endpoints) come back.
 *
 *   LC-3  The desk's share entry point (desk context menu › Share…, which replaced the
 *         sidebar row's "Collaborate live") is reachable and does not crash when there
 *         is no session (it shares the desk on the substrate, no live canvas).
 *
 * Cross-account convergence for a shared desk (widgets + wires) is proven by the
 * crdt*Live specs; this file stays hermetic (no signal server needed).
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

// ---------------------------------------------------------------------------
// LC-1: applyCanvasBodyToTask round-trip (API-driven)
//
// The lib function itself can't be imported at runtime (the renderer loads from
// a pre-built bundle at file://, not the ESM source tree). So we exercise the
// contract directly: build a CanvasBody from the source task's widgets/links,
// then re-implement the three-pass rebuild via window.api calls — which is
// exactly what applyCanvasBodyToTask does. This validates the IPC contract that
// the function depends on (create widget, create widgetLink, remapped endpoints)
// and proves the wire format round-trips correctly.
// ---------------------------------------------------------------------------
test('LC-1 — applyCanvasBodyToTask contract: rebuild from CanvasBody via window.api', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)

  const rebuilt = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api

    // --- SOURCE: build a desk with two stickies + one link ---
    const src = await api.nodes.create({ parentId: null, kind: 'task', title: 'Source desk' })
    const w1 = await api.widgets.create({
      taskId: src.id,
      kind: 'sticky',
      title: 'First note',
      content: 'hello from src',
      x: 80,
      y: 100,
      width: 240,
      height: 180
    })
    const w2 = await api.widgets.create({
      taskId: src.id,
      kind: 'sticky',
      title: 'Second note',
      content: 'world',
      x: 400,
      y: 100,
      width: 240,
      height: 180
    })
    await api.widgetLinks.create(w1.id, w2.id, src.id)

    // --- SERIALIZE: snapshot into a CanvasBody (mirrors serializeCanvasBody) ---
    const srcWidgets = await api.widgets.listByTask(src.id)
    const srcLinks = await api.widgetLinks.listByTask(src.id)
    const widgetIds = new Set(srcWidgets.map((w) => w.id))

    const body = {
      version: 1,
      title: src.title,
      widgets: srcWidgets.map((w) => ({
        id: w.id,
        kind: w.kind,
        title: w.title,
        content: w.content,
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height,
        color: w.color ?? null
      })),
      links: srcLinks
        .filter((l) => widgetIds.has(l.sourceWidgetId) && widgetIds.has(l.targetWidgetId))
        .map((l) => ({
          sourceWidgetId: l.sourceWidgetId,
          targetWidgetId: l.targetWidgetId,
          type: l.type ?? undefined,
          verb: l.verb ?? undefined,
          enabled: l.enabled
        }))
    }

    // --- APPLY: three-pass rebuild into a blank target task (applyCanvasBodyToTask logic) ---
    const tgt = await api.nodes.create({ parentId: null, kind: 'task', title: 'Mirror task' })

    // Pass 1 — clear existing (none) and create every widget; record old->new id map.
    const existing = await api.widgets.listByTask(tgt.id)
    for (const w of existing) await api.widgets.delete(w.id)

    const idMap: Record<string, string> = {}
    for (const sw of body.widgets) {
      const created = await api.widgets.create({
        taskId: tgt.id,
        kind: sw.kind as 'sticky',
        title: sw.title ?? '',
        content: sw.content ?? '',
        x: typeof sw.x === 'number' ? sw.x : 80,
        y: typeof sw.y === 'number' ? sw.y : 80,
        width: typeof sw.width === 'number' ? sw.width : 280,
        height: typeof sw.height === 'number' ? sw.height : 200,
        color: sw.color ?? null
      })
      idMap[sw.id] = created.id
    }

    // Pass 2 — section layout + parentSectionId (no sections in this test, no-op).
    // Pass 3 — recreate links with remapped endpoints.
    for (const l of body.links) {
      const s = idMap[l.sourceWidgetId]
      const t = idMap[l.targetWidgetId]
      if (!s || !t) continue
      await api.widgetLinks.create(s, t, tgt.id, (l.type as 'context') || undefined)
    }

    // --- VERIFY ---
    const widgets = await api.widgets.listByTask(tgt.id)
    const links = await api.widgetLinks.listByTask(tgt.id)

    return {
      widgetCount: widgets.length,
      linkCount: links.length,
      widgetContents: widgets.map((w) => w.content).sort(),
      widgetTitles: widgets.map((w) => w.title).sort(),
      widgetKinds: [...new Set(widgets.map((w) => w.kind))],
      // Endpoint remapping: the new link must NOT reference the old source widget ids.
      linkSourceIsNew: links.length > 0 && !Object.keys(idMap).includes(links[0].sourceWidgetId),
      linkEndpointsInNewSet: links.every(
        (l) =>
          Object.values(idMap).includes(l.sourceWidgetId) &&
          Object.values(idMap).includes(l.targetWidgetId)
      )
    }
  })

  expect(rebuilt.widgetCount).toBe(2)
  expect(rebuilt.linkCount).toBe(1)
  expect(rebuilt.widgetContents).toContain('hello from src')
  expect(rebuilt.widgetContents).toContain('world')
  expect(rebuilt.widgetTitles).toContain('First note')
  expect(rebuilt.widgetTitles).toContain('Second note')
  expect(rebuilt.widgetKinds).toEqual(['sticky'])
  // The link's endpoints must be the NEW widget ids (remapped), not the originals.
  expect(rebuilt.linkSourceIsNew).toBe(true)
  expect(rebuilt.linkEndpointsInNewSet).toBe(true)
})

// ---------------------------------------------------------------------------
// LC-3: sharing a desk is reachable from the desk and opens without a session
// ---------------------------------------------------------------------------
// This was "Sidebar: Collaborate live context menu item present on task row".
// The sidebar's task rows and their right-click menu were removed in 24a61f93
// (Rooms/Desks trees left the sidebar), and the desk's live entry point is the
// desk context menu's Share… row since 4148318a. The intent is unchanged: the
// entry point is reachable from a desk and does not crash without a session.
test('LC-3 — Desk context menu: Share… opens the share sheet without a session', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const uncaught: string[] = []
  window.on('pageerror', (err) => uncaught.push(err.message))

  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Collab test task' })
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Collab test task/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  await window.locator('[data-testid="desk-context-trigger"]').click()
  await window.locator('[data-testid="desk-context-share"]').click()
  const sheet = window.getByRole('dialog', { name: /^Share this / })
  await expect(sheet).toBeVisible({ timeout: 4_000 })
  await expect(sheet).toContainText('Collab test task')
  await sheet.getByRole('button', { name: 'Close' }).first().click()
  await expect(sheet).toHaveCount(0)

  // App is still alive: the desk is still on screen.
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible()

  // No page-level JS exceptions.
  expect(
    uncaught.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('net::ERR_') &&
        !e.includes('Failed to load resource') &&
        !e.includes('signal')
    )
  ).toHaveLength(0)
})
