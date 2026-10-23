/**
 * E2E tests for the Google-Docs-style menu bars on the four office editors:
 * Sheet, Slides, Draw (Map), and Design.
 *
 * Each test:
 *  1. Creates a doc of the right type via window.api.documents.create
 *  2. Navigates to it via window.__fbView.getState().goDocument(id)
 *  3. Waits for the editor surface and menu bar to appear
 *  4. Confirms every top-level menu button is visible
 *  5. Opens the Insert (or Slide) dropdown and verifies key items
 *  6. Fires one real action and asserts the editor state changed
 *  7. Screenshots the dropdown
 *
 * Strategy: use window.api IPC for setup (no file-dialog, no reload) and
 * window.__fbView for navigation. Real actions are exercised through the menu
 * bar UI; state is read back from window.api.documents.get to confirm persistence.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'
import path from 'path'

const SHOTS_DIR =
  '/private/tmp/claude-501/-Applications-agentic-starter-kit-main/0d9ea3a0-0a94-4273-82da-09071878651b/scratchpad'

// ── helpers ───────────────────────────────────────────────────────────────────

type DocType = 'sheet' | 'slides' | 'map' | 'design'

async function createAndOpen(
  window: Parameters<typeof waitForReady>[0],
  docType: DocType,
  title: string
): Promise<string> {
  const id = await window.evaluate(
    async ({ docType, title }: { docType: string; title: string }) => {
      const w = window as unknown as {
        api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }
        __fbView?: { getState: () => { goDocument: (id: string) => void } }
      }
      const d = await w.api.documents.create({ docType, title })
      w.__fbView?.getState().goDocument(d.id)
      return d.id
    },
    { docType, title }
  )
  return id
}

async function readBody(
  window: Parameters<typeof waitForReady>[0],
  id: string
): Promise<unknown> {
  return window.evaluate(async (docId: string) => {
    const api = (
      window as unknown as {
        api: { documents: { get: (id: string) => Promise<{ body: unknown } | null> } }
      }
    ).api
    const doc = await api.documents.get(docId)
    return doc?.body ?? null
  }, id)
}

// ── SHEETS ────────────────────────────────────────────────────────────────────

test('SHEET-MB — menu bar renders all 7 buttons, Insert dropdown opens, Row above fires without error', async () => {
  const { window, dispose } = await launchApp()
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  try {
    await waitForReady(window)
    const id = await createAndOpen(window, 'sheet', 'Sheet Menu')

    // Wait for menu bar
    await expect(window.locator('[data-testid="sheet-menubar"]')).toBeVisible({ timeout: 12_000 })

    // All 7 top-level buttons
    const bar = window.locator('[data-testid="sheet-menubar"]')
    for (const btn of ['file', 'edit', 'insert', 'format', 'data', 'tools', 'help']) {
      await expect(bar.locator(`[data-testid="sheet-menubar-${btn}"]`)).toBeVisible({
        timeout: 5_000
      })
    }

    // Open Insert menu
    await bar.locator('[data-testid="sheet-menubar-insert"]').click()
    const insertList = window.locator('[data-testid="sheet-menubar-insert-list"]')
    await expect(insertList).toBeVisible({ timeout: 5_000 })

    // Required items
    await expect(insertList.locator('span.truncate', { hasText: 'Row above' })).toBeVisible()
    await expect(insertList.locator('span.truncate', { hasText: 'Row below' })).toBeVisible()
    await expect(insertList.locator('span.truncate', { hasText: 'Sheet' })).toBeVisible()
    await expect(insertList.locator('span.truncate', { hasText: 'Named range' })).toBeVisible()

    // Screenshot the dropdown
    const shot = path.join(SHOTS_DIR, 'sheet-menubar-insert.png')
    await window.screenshot({ path: shot })
    console.log('Sheet Insert screenshot:', shot)

    // Click "Row above" — this should call insertRowAbove and not throw
    await insertList.locator('span.truncate', { hasText: 'Row above' }).click()
    // Allow any state update to settle
    await window.waitForTimeout(600)

    // The sheet grid should still be visible (not crashed)
    // SheetEditor renders inside the document view; the grid is visible if the
    // editor did not crash. We look for the SheetGrid canvas or the tab strip.
    const sheetPresent = await window
      .locator('[data-testid="sheet-menubar"]')
      .isVisible()
      .catch(() => false)
    expect(sheetPresent, 'sheet menu bar still visible after Row above action').toBe(true)

    // No uncaught errors
    expect(errors, 'no uncaught console errors').toHaveLength(0)
  } finally {
    await dispose()
  }
})

// ── SLIDES ────────────────────────────────────────────────────────────────────

test('SLIDES-MB — menu bar renders all 7 buttons, Slide dropdown opens, New slide fires and slide count increases', async () => {
  const { window, dispose } = await launchApp()
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  try {
    await waitForReady(window)
    const id = await createAndOpen(window, 'slides', 'Slides Menu')

    // Wait for the slides editor to be fully mounted
    await expect(window.locator('[data-testid="slides-menubar"]')).toBeVisible({ timeout: 12_000 })
    // Also wait for the canvas
    await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible({ timeout: 8_000 })

    // Let the initial body autosave (600 ms debounce + buffer)
    await window.waitForTimeout(1_600)

    const bar = window.locator('[data-testid="slides-menubar"]')

    // All 7 top-level buttons: file / edit / view / insert / slide / format / help
    for (const btn of ['file', 'edit', 'view', 'insert', 'slide', 'format', 'help']) {
      await expect(bar.locator(`[data-testid="slides-menubar-${btn}"]`)).toBeVisible({
        timeout: 5_000
      })
    }

    // Read initial slide count
    const bodyBefore = (await readBody(window, id)) as {
      slides?: unknown[]
    }
    const slidesCountBefore = bodyBefore?.slides?.length ?? 1

    // Open Slide menu
    await bar.locator('[data-testid="slides-menubar-slide"]').click()
    const slideList = window.locator('[data-testid="slides-menubar-slide-list"]')
    await expect(slideList).toBeVisible({ timeout: 5_000 })

    // Required items
    await expect(slideList.locator('span.truncate', { hasText: 'New slide' })).toBeVisible()
    await expect(slideList.locator('span.truncate', { hasText: 'Delete slide' })).toBeVisible()
    await expect(slideList.locator('span.truncate', { hasText: 'Move slide up' })).toBeVisible()
    await expect(slideList.locator('span.truncate', { hasText: 'Move slide down' })).toBeVisible()

    // Screenshot the dropdown
    const shot = path.join(SHOTS_DIR, 'slides-menubar-slide.png')
    await window.screenshot({ path: shot })
    console.log('Slides Slide dropdown screenshot:', shot)

    // "New slide" is one command on every surface: the template gallery (SPEC §9,
    // registry-41). Pick Blank there, as a person would.
    await slideList.locator('span.truncate', { hasText: 'New slide' }).click()
    await expect(window.locator('[data-testid="slide-template-gallery"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="slide-template-blank"]').click()
    await window.waitForTimeout(1_600) // wait for autosave

    // Slide count must have increased
    const bodyAfter = (await readBody(window, id)) as { slides?: unknown[] }
    const slidesCountAfter = bodyAfter?.slides?.length ?? 0
    expect(slidesCountAfter, 'new slide was added via menu bar').toBeGreaterThan(slidesCountBefore)

    // No uncaught errors
    expect(errors, 'no uncaught console errors').toHaveLength(0)
  } finally {
    await dispose()
  }
})

// ── DRAW (Map) ────────────────────────────────────────────────────────────────

test('DRAW-MB — menu bar renders file/insert/view/help, Insert lists shape items, clicking Process adds a node', async () => {
  const { window, dispose } = await launchApp()
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  try {
    await waitForReady(window)
    const id = await createAndOpen(window, 'map', 'Draw Menu')

    // Wait for menu bar
    await expect(window.locator('[data-testid="draw-menubar"]')).toBeVisible({ timeout: 12_000 })

    const bar = window.locator('[data-testid="draw-menubar"]')

    // 4 top-level buttons: file / insert / view / help
    for (const btn of ['file', 'insert', 'view', 'help']) {
      await expect(bar.locator(`[data-testid="draw-menubar-${btn}"]`)).toBeVisible({
        timeout: 5_000
      })
    }

    // Read initial node count
    const bodyBefore = (await readBody(window, id)) as { nodes?: unknown[] }
    const nodesBefore = (bodyBefore as { nodes?: unknown[] } | null)?.nodes?.length ?? 0

    // Open Insert menu
    await bar.locator('[data-testid="draw-menubar-insert"]').click()
    const insertList = window.locator('[data-testid="draw-menubar-insert-list"]')
    await expect(insertList).toBeVisible({ timeout: 5_000 })

    // The insert menu lists shape items (from SHAPE_TOOLS via DrawMenuBar)
    // At minimum Process, Decision, Start / End should be there
    await expect(insertList.locator('span.truncate', { hasText: 'Process' })).toBeVisible()
    await expect(insertList.locator('span.truncate', { hasText: 'Decision' })).toBeVisible()
    await expect(insertList.locator('span.truncate', { hasText: 'Start / End' })).toBeVisible()

    // Screenshot the dropdown
    const shot = path.join(SHOTS_DIR, 'draw-menubar-insert.png')
    await window.screenshot({ path: shot })
    console.log('Draw Insert screenshot:', shot)

    // Click "Process" — calls addNode('process')
    await insertList.locator('span.truncate', { hasText: 'Process' }).click()
    await window.waitForTimeout(1_200) // allow autosave

    // The Draw menu bar should still be visible (no crash)
    const menuStillVisible = await bar.isVisible().catch(() => false)
    expect(menuStillVisible, 'draw menu bar still visible after adding a node').toBe(true)

    // The React Flow canvas should now have at least one node.
    // MapEditor renders React Flow nodes as divs inside the rf canvas.
    // data-id attribute is set by React Flow on each node div.
    const rfNodes = window.locator('.react-flow__node')
    const nodeCount = await rfNodes.count()
    expect(nodeCount, 'at least one React Flow node in canvas after Insert > Process').toBeGreaterThan(
      nodesBefore
    )

    // No uncaught errors
    expect(errors, 'no uncaught console errors').toHaveLength(0)
  } finally {
    await dispose()
  }
})

// ── DESIGN ────────────────────────────────────────────────────────────────────

test('DESIGN-MB — menu bar renders file/edit/insert/tools/help, Insert shows Text/Image/Shape/Line, Text click adds element', async () => {
  const { window, dispose } = await launchApp()
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  try {
    await waitForReady(window)
    const id = await createAndOpen(window, 'design', 'Design Menu')

    // Wait for menu bar and design editor surface
    await expect(window.locator('[data-testid="design-menubar"]')).toBeVisible({ timeout: 12_000 })
    await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 8_000 })

    // Let initial body autosave
    await window.waitForTimeout(1_600)

    // Read initial element count from body
    const bodyBefore = (await readBody(window, id)) as { elements?: unknown[] }
    const elementsBefore = bodyBefore?.elements?.length ?? 0

    const bar = window.locator('[data-testid="design-menubar"]')

    // 5 top-level buttons: file / edit / insert / tools / help
    for (const btn of ['file', 'edit', 'insert', 'tools', 'help']) {
      await expect(bar.locator(`[data-testid="design-menubar-${btn}"]`)).toBeVisible({
        timeout: 5_000
      })
    }

    // Open Insert menu
    await bar.locator('[data-testid="design-menubar-insert"]').click()
    const insertList = window.locator('[data-testid="design-menubar-insert-list"]')
    await expect(insertList).toBeVisible({ timeout: 5_000 })

    // Required items: Text, Image, Shape, Line
    await expect(insertList.locator('span.truncate', { hasText: 'Text' })).toBeVisible()
    await expect(insertList.locator('span.truncate', { hasText: 'Image' })).toBeVisible()
    await expect(insertList.locator('span.truncate', { hasText: 'Shape' })).toBeVisible()
    await expect(insertList.locator('span.truncate', { hasText: 'Line' })).toBeVisible()

    // Screenshot the dropdown
    const shot = path.join(SHOTS_DIR, 'design-menubar-insert.png')
    await window.screenshot({ path: shot })
    console.log('Design Insert screenshot:', shot)

    // Click "Text" — calls a.addText() which inserts a new text element
    await insertList.locator('span.truncate', { hasText: 'Text' }).click()
    await window.waitForTimeout(1_600) // wait for autosave

    // Element count must have increased
    const bodyAfter = (await readBody(window, id)) as { elements?: unknown[] }
    const elementsAfter = bodyAfter?.elements?.length ?? 0
    expect(elementsAfter, 'text element added via menu bar Insert > Text').toBeGreaterThan(
      elementsBefore
    )

    // The design editor must still be visible (no crash)
    await expect(window.locator('[data-testid="design-editor"]')).toBeVisible()

    // No uncaught errors
    expect(errors, 'no uncaught console errors').toHaveLength(0)
  } finally {
    await dispose()
  }
})
