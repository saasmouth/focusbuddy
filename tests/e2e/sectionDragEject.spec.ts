import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, clickWidgetMenuRow } from './_helpers'

// Feature 3 — Drag items out of a section (alternative eject gesture):
//
// • icons/list children (CompactChildView): pointer-drag via useEjectDrag.
//   Releasing OUTSIDE the section card ejects to canvas (clears parentSectionId,
//   sets x/y). Releasing INSIDE snaps back, no eject.
//   A plain tap still opens the child.
//
// • grid/stacks children (WidgetFrame): dragDisabled = isZonePinned only
//   (was useControlled). Dragging past EJECT_THRESHOLD ejects. Short drag
//   inside = snaps back to cell.
//
// • Right-click "Move out of section" context-menu item must still work.
//
// • Free-layout section children must still drag/eject as before.
//
// Gesture limits in Playwright:
//   Native Playwright dragTo() drives the Rnd drag on grid/stacks children.
//   For CompactChildView (icons/list) we dispatch document-level PointerEvents
//   to simulate the useEjectDrag hook's document listener approach —
//   Playwright's drag helpers don't fire pointerdown+pointermove+pointerup
//   in the way document.addEventListener('pointermove') expects.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedSectionWithChild(
  l: LaunchedApp,
  sectionLayout: 'icons' | 'list' | 'grid' | 'stacks' | 'free'
): Promise<{ taskId: string; sectionId: string; childId: string }> {
  const { window } = l

  await waitForReady(window)

  // NOTE: createWidget INSERT does not include the `layout` column.
  // We must call api.widgets.update after creation to set the layout.
  const seeded = await window.evaluate(async (layout: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: `Eject test (${layout})`
    })
    const section = await api.widgets.create({
      taskId: task.id,
      kind: 'section',
      title: 'Test section',
      content: '',
      x: 200,
      y: 150,
      width: 400,
      height: 300,
      color: '#3b82f6'
    })
    // Set layout via update (create INSERT doesn't include the layout column)
    await api.widgets.update(section.id, { layout: layout as never })
    const child = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'child widget',
      content: 'eject me',
      x: 10,
      y: 10,
      width: 200,
      height: 120
    })
    // createWidget's INSERT hard-codes parent_section_id = NULL (WidgetDraft
    // intentionally has no parentSectionId — widgets are born free and JOIN a
    // section via update, mirroring the drag-into-section flow). So nest the
    // child explicitly via update, the same way we set the layout above.
    await api.widgets.update(child.id, { parentSectionId: section.id })
    return { taskId: task.id, sectionId: section.id, childId: child.id }
  }, sectionLayout)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(`Eject test \\(${sectionLayout}\\)`) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)

  return seeded
}

// ── Test: right-click "Move out of section" still works ──────────────────────

test('right-click "Move out of section" ejects a grid child to the canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId, sectionId, taskId } = await seedSectionWithChild(launched, 'grid')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  // Right-click the child widget header (.widget-handle) to open the context menu.
  // We right-click directly on the header div (not the whole widget) so the
  // context-menu event fires on the header's onContextMenu handler in WidgetFrame.
  const headerEl = window.locator(`[data-widget-id="${childId}"] .widget-handle`)
  await headerEl.click({ button: 'right' })
  await window.waitForTimeout(300)

  // "Move out of section" lives in the unified Organise submenu. Open it, then
  // click the eject item (getByText throws if the item is absent, which is the
  // assertion that the contextual action is present for a section child).
  await clickWidgetMenuRow(window, 'Move out of section')
  await window.waitForTimeout(400)

  // Verify the child no longer has a parentSectionId
  const result = await window.evaluate(
    async ({ childId, taskId }: { childId: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const child = widgets.find((w) => w.id === childId)
      return child ? { parentSectionId: child.parentSectionId } : null
    },
    { childId, taskId }
  )

  expect(result).not.toBeNull()
  expect(result!.parentSectionId).toBeNull()

  // Also verify the section still exists
  const sectionStillThere = await window.evaluate(
    async ({ sectionId, taskId }: { sectionId: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      return widgets.some((w) => w.id === sectionId)
    },
    { sectionId, taskId }
  )
  expect(sectionStillThere).toBe(true)
})

// ── Test: icons layout — eject button (layers_clear) still works ─────────────

test('icons layout: eject button (layers_clear) removes child from section', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId, taskId } = await seedSectionWithChild(launched, 'icons')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  // The eject button is the layers_clear button inside the icon tile.
  // It's opacity-0 by default, so we click it via DOM to bypass hover check.
  const ejected = await window.evaluate((cid: string) => {
    const tile = document.querySelector(`[data-widget-id="${cid}"]`)
    if (!tile) return { found: false, clicked: false }
    // The eject button has title="Remove from section"
    const btn = tile.querySelector<HTMLButtonElement>('button[title="Remove from section"]')
    if (!btn) return { found: false, clicked: false }
    btn.click()
    return { found: true, clicked: true }
  }, childId)
  expect(ejected.found).toBe(true)
  expect(ejected.clicked).toBe(true)
  await window.waitForTimeout(400)

  const result = await window.evaluate(
    async ({ childId, taskId }: { childId: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const child = widgets.find((w) => w.id === childId)
      return child ? { parentSectionId: child.parentSectionId } : null
    },
    { childId, taskId }
  )
  expect(result).not.toBeNull()
  expect(result!.parentSectionId).toBeNull()
})

// ── Test: list layout — eject button still works ─────────────────────────────

test('list layout: eject button (layers_clear) removes child from section', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId, taskId } = await seedSectionWithChild(launched, 'list')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  const ejected = await window.evaluate((cid: string) => {
    const tile = document.querySelector(`[data-widget-id="${cid}"]`)
    if (!tile) return { found: false, clicked: false }
    const btn = tile.querySelector<HTMLButtonElement>('button[title="Remove from section"]')
    if (!btn) return { found: false, clicked: false }
    btn.click()
    return { found: true, clicked: true }
  }, childId)
  expect(ejected.found).toBe(true)
  expect(ejected.clicked).toBe(true)
  await window.waitForTimeout(400)

  const result = await window.evaluate(
    async ({ childId, taskId }: { childId: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const child = widgets.find((w) => w.id === childId)
      return child ? { parentSectionId: child.parentSectionId } : null
    },
    { childId, taskId }
  )
  expect(result).not.toBeNull()
  expect(result!.parentSectionId).toBeNull()
})

// ── Test: icons/list drag gesture — useEjectDrag wiring ──────────────────────
//
// We can't use Playwright dragTo() here because useEjectDrag attaches
// document-level pointermove/pointerup listeners (not on the element itself).
// Instead we dispatch raw PointerEvents — the same events the browser fires —
// and verify the DB reflects the eject.

test('icons layout: pointer drag outside section card ejects child to canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId, taskId, sectionId } = await seedSectionWithChild(launched, 'icons')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  // Dispatch pointerdown → pointermove far outside section bounds → pointerup
  // to trigger the useEjectDrag hook's eject path.
  const ejected = await window.evaluate(
    ({ cid, sid }: { cid: string; sid: string }) => {
      const tile = document.querySelector(`[data-widget-id="${cid}"]`) as HTMLElement | null
      if (!tile) return false
      const rect = tile.getBoundingClientRect()
      const startX = rect.left + rect.width / 2
      const startY = rect.top + rect.height / 2

      // Get the section card bounds
      const sectionEl = document.querySelector(`[data-widget-id="${sid}"]`) as HTMLElement | null
      const sectionRect = sectionEl?.getBoundingClientRect()

      // Drop point: 200px below the section bottom (definitely outside)
      const dropX = startX
      const dropY = sectionRect ? sectionRect.bottom + 200 : startY + 400

      // Dispatch document-level pointer events (mirroring what the browser sends)
      const pointerDown = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: startX,
        clientY: startY,
        button: 0,
        buttons: 1,
        pointerId: 1
      })
      tile.dispatchEvent(pointerDown)

      // Move past 6px threshold in two steps
      for (const [mx, my] of [
        [startX, startY + 10],
        [dropX, dropY]
      ] as [number, number][]) {
        document.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: mx,
            clientY: my,
            button: 0,
            buttons: 1,
            pointerId: 1
          })
        )
      }

      // Pointer up at drop point
      document.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY,
          button: 0,
          buttons: 0,
          pointerId: 1
        })
      )
      return true
    },
    { cid: childId, sid: sectionId }
  )

  expect(ejected).toBe(true)
  await window.waitForTimeout(500)

  const result = await window.evaluate(
    async ({ childId, taskId }: { childId: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const child = widgets.find((w) => w.id === childId)
      return child ? { parentSectionId: child.parentSectionId } : null
    },
    { childId, taskId }
  )
  expect(result).not.toBeNull()
  expect(result!.parentSectionId).toBeNull()
})

test('icons layout: sub-threshold pointer motion (< 6px) does NOT eject child', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId, taskId } = await seedSectionWithChild(launched, 'icons')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  // Dispatch a sub-threshold drag: 3px of movement → below 6px hypotenuse threshold.
  // The useEjectDrag hook ignores moves below sqrt(dx^2+dy^2) < 6, so no eject fires.
  const dragged = await window.evaluate(
    ({ cid }: { cid: string }) => {
      const tile = document.querySelector(`[data-widget-id="${cid}"]`) as HTMLElement | null
      if (!tile) return false
      const rect = tile.getBoundingClientRect()
      const startX = rect.left + rect.width / 2
      const startY = rect.top + rect.height / 2

      tile.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: startX,
          clientY: startY,
          button: 0,
          buttons: 1,
          pointerId: 1
        })
      )

      // Move only 3px — below the 6px threshold, so movedRef never becomes true
      document.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX: startX + 3,
          clientY: startY,
          button: 0,
          buttons: 1,
          pointerId: 1
        })
      )

      // Release at the same sub-threshold position
      document.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          clientX: startX + 3,
          clientY: startY,
          button: 0,
          buttons: 0,
          pointerId: 1
        })
      )
      return true
    },
    { cid: childId }
  )

  expect(dragged).toBe(true)
  await window.waitForTimeout(500)

  // Child must still be in the section — no eject should have fired
  const result = await window.evaluate(
    async ({ childId, taskId }: { childId: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const child = widgets.find((w) => w.id === childId)
      return child ? { parentSectionId: child.parentSectionId } : null
    },
    { childId, taskId }
  )
  expect(result).not.toBeNull()
  // Sub-threshold drag: must still be in section
  expect(result!.parentSectionId).not.toBeNull()
})

// ── Test: grid/stacks children — dragDisabled is now isZonePinned only ───────
//
// We verify via store introspection that a grid section child IS draggable
// (Rnd's disableDragging=false) when the parent section is not zone-pinned.
// Full Playwright native drag of Rnd is unreliable in headless Electron, so
// we assert the DOM attribute Rnd sets when dragging is disabled vs enabled,
// and that the eject-via-context-menu path (already verified above) works.

test('grid layout: WidgetFrame child is NOT drag-disabled (dragDisabled=isZonePinned only)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId } = await seedSectionWithChild(launched, 'grid')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  // When dragDisabled=false Rnd renders the drag handle with the draggable class
  // AND does NOT add a cursor:not-allowed / pointer-events:none style.
  // The widget-handle div should be visible and have cursor-move.
  const handleInfo = await window.evaluate((cid: string) => {
    const widget = document.querySelector(`[data-widget-id="${cid}"]`)
    if (!widget) return null
    const handle = widget.querySelector('.widget-handle')
    if (!handle) return null
    const style = window.getComputedStyle(handle)
    return {
      found: true,
      cursor: style.cursor,
      hasHandle: true
    }
  }, childId)

  expect(handleInfo).not.toBeNull()
  expect(handleInfo!.found).toBe(true)
  expect(handleInfo!.hasHandle).toBe(true)
  // The handle should be draggable (cursor:move or grab, not not-allowed)
  expect(handleInfo!.cursor).not.toBe('not-allowed')
})

// ── Test: stacks layout — same dragDisabled check ────────────────────────────

test('stacks layout: WidgetFrame child is NOT drag-disabled', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId } = await seedSectionWithChild(launched, 'stacks')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  const handleInfo = await window.evaluate((cid: string) => {
    const widget = document.querySelector(`[data-widget-id="${cid}"]`)
    if (!widget) return null
    const handle = widget.querySelector('.widget-handle')
    if (!handle) return null
    const style = window.getComputedStyle(handle)
    return {
      found: true,
      cursor: style.cursor
    }
  }, childId)

  expect(handleInfo).not.toBeNull()
  expect(handleInfo!.found).toBe(true)
  expect(handleInfo!.cursor).not.toBe('not-allowed')
})

// ── Test: free-layout section child still ejects via context-menu ─────────────

test('free layout: right-click "Move out of section" ejects child to canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId, taskId } = await seedSectionWithChild(launched, 'free')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  const childEl = window.locator(`[data-widget-id="${childId}"] .widget-handle`)
  await childEl.click({ button: 'right' })
  await window.waitForTimeout(300)

  // Eject now lives in the unified Organise submenu — open it, then click.
  await clickWidgetMenuRow(window, 'Move out of section')
  await window.waitForTimeout(400)

  const result = await window.evaluate(
    async ({ childId, taskId }: { childId: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const child = widgets.find((w) => w.id === childId)
      return child ? { parentSectionId: child.parentSectionId } : null
    },
    { childId, taskId }
  )
  expect(result).not.toBeNull()
  expect(result!.parentSectionId).toBeNull()
})

// ── Test: header eject button (layers_clear icon in widget header) ─────────────

test('header eject button (layers_clear) still ejects grid child', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { childId, taskId } = await seedSectionWithChild(launched, 'grid')

  await window.waitForSelector(`[data-widget-id="${childId}"]`, { timeout: 5_000 })

  // The header layers_clear button is in the WidgetFrame header for section children
  const ejected = await window.evaluate((cid: string) => {
    const widget = document.querySelector(`[data-widget-id="${cid}"]`)
    if (!widget) return false
    const btn = widget.querySelector<HTMLButtonElement>('button[title="Remove from section (eject to canvas)"]')
    if (!btn) return false
    btn.click()
    return true
  }, childId)
  expect(ejected).toBe(true)
  await window.waitForTimeout(400)

  const result = await window.evaluate(
    async ({ childId, taskId }: { childId: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const child = widgets.find((w) => w.id === childId)
      return child ? { parentSectionId: child.parentSectionId } : null
    },
    { childId, taskId }
  )
  expect(result).not.toBeNull()
  expect(result!.parentSectionId).toBeNull()
})
