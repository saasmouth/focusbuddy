/**
 * E2E tests for CHANGE 1 — PlexiDesign as a desk widget kind (like doc/sheet/
 * slides/map).
 *
 * DWK-1  API-seeded design widget (mirrors ODC-3 in officeDocCanvas.spec.ts):
 *        seed a widget with kind:'design' and empty content on a task, open
 *        the canvas, and confirm OfficeDocWidget provisions a backing
 *        fb_documents row of docType 'design' and mounts DesignEditor
 *        (data-testid="design-editor") without an error boundary.
 *
 * DWK-2  (Since 4.3.32, when the Add-widget palette was removed.) The
 *        PlexiDesign tile under Apps offers "Add Design to this desk"
 *        (data-testid="office-sideapp-design"); choosing it drives the real UI create path (handleClickAdd →
 *        placeWidget, since 'design' is not routed through the office-add
 *        chooser) and confirm a second design widget mounts DesignEditor
 *        without throwing.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, addWidgetToDesk, chooseCloudAiSource } from './_helpers'

test('DWK-1 — API-seeded design widget provisions docType=design and mounts DesignEditor', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    // A fresh profile's AI source is Local since 4.3.39. Choose the cloud
    // source explicitly: it is what these specs assume, and it clears the
    // fixed "local AI missing" notice, which otherwise intercepts clicks on
    // the design toolbar and fails as if Design were broken.
    await chooseCloudAiSource(window)

    const { taskId, widgetId } = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'DWK-1 Task' })
      const widget = await api.widgets.create({
        taskId: task.id,
        kind: 'design' as never,
        title: 'Design Widget',
        content: '',
        x: 80,
        y: 80,
        width: 720,
        height: 540
      })
      return { taskId: task.id, widgetId: widget.id }
    })

    await window.reload()
    await waitForReady(window)
    // A fresh profile's AI source is Local since 4.3.39. Choose the cloud
    // source explicitly: it is what these specs assume, and it clears the
    // fixed "local AI missing" notice, which otherwise intercepts clicks on
    // the design toolbar and fails as if Design were broken.
    await chooseCloudAiSource(window)
    await window.getByRole('button', { name: /DWK-1 Task/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await window.waitForTimeout(300)

    // The DesignEditor must mount inside the widget frame — no error boundary,
    // no stuck "Loading design…" state.
    await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 8_000 })

    // No red error-boundary text should be present in the widget.
    const errorText = window.locator('text=/^Failed to load|^Something went wrong|^Error:/')
    await expect(errorText).toHaveCount(0)

    // The widget's content must have been repointed at a provisioned document.
    const widgets = await window.evaluate(async (tid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.widgets.listByTask(tid)
    }, taskId)

    const designWidget = (
      widgets as Array<{ id: string; kind: string; content?: string }>
    ).find((w) => w.id === widgetId)
    expect(designWidget?.kind, 'widget kind must be design').toBe('design')
    expect(designWidget?.content, 'widget.content must be provisioned to a document id').toBeTruthy()

    // The backing document must exist and be docType='design'.
    const doc = await window.evaluate(async (id: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.documents.get(id)
    }, designWidget!.content as string)

    expect(doc, 'backing document must exist in SQLite').toBeTruthy()
    expect((doc as { docType?: string })?.docType, 'backing document must be docType=design').toBe(
      'design'
    )
  } finally {
    await dispose()
  }
})

test('DWK-2 — the PlexiDesign tile adds a design widget to the desk via the real UI path', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    // A fresh profile's AI source is Local since 4.3.39. Choose the cloud
    // source explicitly: it is what these specs assume, and it clears the
    // fixed "local AI missing" notice, which otherwise intercepts clicks on
    // the design toolbar and fails as if Design were broken.
    await chooseCloudAiSource(window)

    await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.nodes.create({ parentId: null, kind: 'task', title: 'DWK-2 Task' })
    })
    await window.reload()
    await waitForReady(window)
    // A fresh profile's AI source is Local since 4.3.39. Choose the cloud
    // source explicitly: it is what these specs assume, and it clears the
    // fixed "local AI missing" notice, which otherwise intercepts clicks on
    // the design toolbar and fails as if Design were broken.
    await chooseCloudAiSource(window)
    await window.getByRole('button', { name: /DWK-2 Task/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await window.waitForTimeout(300)

    // The Add-widget palette this drove was removed in 4.3.32. Design is what
    // the PlexiDesign app IS on a desk, so it is added from that app's tile
    // under Apps: right-click → "Add Design to this desk" — which drives the
    // same canvas add path (handleClickAdd → placeWidget; design is not routed
    // through the office-add chooser, unlike doc/sheet/slides).
    const designTile = window.locator('[data-testid="office-sideapp-design"]').first()
    await expect(designTile).toBeVisible({ timeout: 4_000 })
    await addWidgetToDesk(window, 'design')

    // A DesignEditor must mount on the canvas without throwing.
    await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 8_000 })

    const widgets = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const tasks = await api.nodes.list()
      const t = (tasks as Array<{ id: string; title?: string }>).find((n) => n.title === 'DWK-2 Task')
      if (!t) return []
      return api.widgets.listByTask(t.id)
    })
    const designWidget = (widgets as Array<{ kind: string; content?: string }>).find(
      (w) => w.kind === 'design'
    )
    expect(designWidget, 'a design widget must exist after clicking the palette entry').toBeTruthy()
  } finally {
    await dispose()
  }
})
