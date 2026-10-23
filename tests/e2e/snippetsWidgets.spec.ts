/**
 * Any content into work widgets and onto a desk, end to end in the real app.
 *
 * SW-1 A PlexiiCells range (a heading row and two rows) saved from Edit › Save
 *      selection as snippet…, then inserted from each widget's own menu
 *      (Advanced › Insert snippet…): into a PAGE work widget it lands as a real
 *      table node holding the values; into a STICKY as a GFM pipe table, which
 *      the sticky draws as a table.
 * SW-2 A PlexiiDraw selection saved as a snippet, then: inserted on the DESK
 *      from the desk's own library it becomes an IMAGE work widget whose
 *      picture is in the file store (fb-file://) and the notice names where to
 *      edit it; into a MARKDOWN work widget it lands as ![alt](fb-file://…)
 *      and shows as a picture; into a STICKY it is refused with the owner's
 *      words, and the sticky is unchanged.
 *
 * SW-3 (below) pastes through the real system clipboard, and saves and
 * restores every pasteboard item around it (_macPasteboard.ts).
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea, chooseCloudAiSource, suppressFeatureSpotlights } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, rectObject, runMenu, seedDrawDoc, v1Body } from './_drawHelpers'
import { readPasteboard, restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'

type W = { id: string; kind: string; content: string; title: string | null }

/** Make a desk holding these widgets, and open it. */
async function deskWith(window: Page, title: string, widgets: Array<{ kind: string; content: string; x: number; y: number; width?: number; height?: number }>): Promise<{ taskId: string; ids: string[] }> {
  const seeded = await window.evaluate(
    async ({ t, ws }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: t })
      const ids: string[] = []
      for (const w of ws) {
        const made = await api.widgets.create({ taskId: task.id, kind: w.kind as never, title: '', content: w.content, x: w.x, y: w.y, width: w.width ?? 360, height: w.height ?? 300 })
        ids.push(made.id)
      }
      return { taskId: task.id, ids }
    },
    { t: title, ws: widgets }
  )
  await window.evaluate(async () => {
    const w = window as unknown as { __fbNodes?: { getState: () => { refresh: () => Promise<void> } } }
    await w.__fbNodes?.getState().refresh()
  })
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, seeded.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  for (const id of seeded.ids) await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 8_000 })
  return seeded
}

/** A point on the bare desk (nothing over it), for a right-click the desk's own menu answers. */
async function bareCanvasPoint(window: Page): Promise<{ x: number; y: number }> {
  return window.evaluate(() => {
    const s = document.querySelector('[data-canvas-surface="true"]') as HTMLElement
    const r = s.getBoundingClientRect()
    for (let fy = 0.85; fy > 0.15; fy -= 0.05) {
      for (let fx = 0.85; fx > 0.15; fx -= 0.05) {
        const x = r.left + r.width * fx
        const y = r.top + r.height * fy
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        if (el && el.dataset.bareCanvas !== undefined) return { x, y }
      }
    }
    throw new Error('no bare desk to right-click')
  })
}

async function widgetsOf(window: Page, taskId: string): Promise<W[]> {
  return window.evaluate(async (tid) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.listByTask(tid)) as unknown as W[]
  }, taskId)
}

async function contentOf(window: Page, taskId: string, id: string): Promise<string> {
  return (await widgetsOf(window, taskId)).find((w) => w.id === id)?.content ?? '__missing__'
}

/** The widget's own menu: header right-click › Advanced › Insert snippet…, then Duplicate on the named row. */
async function insertIntoWidget(window: Page, widgetId: string, snippetName: string): Promise<void> {
  await window.click(`[data-widget-id="${widgetId}"] .widget-handle`, { button: 'right', position: { x: 60, y: 8 } })
  const menu = window.locator('[data-canvas-ctx-menu]')
  await expect(menu).toBeVisible({ timeout: 4_000 })
  await menu.getByText('Advanced', { exact: true }).hover()
  await window.getByText('Insert snippet…', { exact: true }).click()
  await chooseDuplicate(window, snippetName)
}

async function chooseDuplicate(window: Page, snippetName: string): Promise<void> {
  const library = window.locator('[data-testid="snippet-library"]')
  await expect(library).toBeVisible({ timeout: 5_000 })
  const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: snippetName })
  await expect(row).toBeVisible()
  // A work widget takes a copy: Live is not offered.
  await expect(row.locator('[data-testid="snippet-insert-live"]')).toHaveCount(0)
  await row.locator('[data-testid="snippet-insert-duplicate"]').click()
}

// ── SW-1 ─────────────────────────────────────────────────────────────────────

const cellAt = (window: Page, r: number, c: number) => window.locator(`[data-testid="cell-${r}-${c}"]`)
async function enter(window: Page, r: number, c: number, value: string): Promise<void> {
  await cellAt(window, r, c).click()
  await window.keyboard.type(value)
  await window.keyboard.press('Enter')
}

test('SW-1: a Cells range inserted into a page work widget is a table, into a sticky a pipe table', async () => {
  test.setTimeout(150_000)
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await suppressFeatureSpotlights(window)

    // A1:B3 = Item/Qty, Pens/2, Pads/4, saved from Cells' own Edit menu.
    await switchArea(window, 'office')
    await window.locator('[data-testid="office-app-sheets"]').click()
    await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
    await enter(window, 0, 0, 'Item')
    await enter(window, 1, 0, 'Pens')
    await enter(window, 2, 0, 'Pads')
    await enter(window, 0, 1, 'Qty')
    await enter(window, 1, 1, '2')
    await enter(window, 2, 1, '4')
    await cellAt(window, 0, 0).click()
    await cellAt(window, 2, 1).click({ modifiers: ['Shift'] })
    await window.locator('[data-testid="sheet-menubar-edit"]').click()
    await window.locator('[data-testid="sheet-menubar-edit-list"]').getByRole('button', { name: /^Save selection as snippet/ }).click()
    await expect(window.locator('[data-testid="save-snippet-dialog"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="save-snippet-name"]').fill('Stock')
    await window.locator('[data-testid="save-snippet-confirm"]').click()
    await expect(window.locator('[data-testid="save-snippet-dialog"]')).toBeHidden({ timeout: 5_000 })

    const { taskId, ids } = await deskWith(window, 'Widgets take a range', [
      { kind: 'page', content: '', x: 80, y: 80, width: 460, height: 360 },
      { kind: 'sticky', content: 'Stock check', x: 620, y: 80, width: 320, height: 300 }
    ])
    const [pageId, stickyId] = ids

    // Into the page: a real table node, heading row first.
    await insertIntoWidget(window, pageId, 'Stock')
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })
    await expect(window.locator(`[data-widget-id="${pageId}"] table`)).toBeVisible({ timeout: 5_000 })
    await expect(window.locator(`[data-widget-id="${pageId}"] table`)).toContainText('Pens')
    await expect
      .poll(async () => {
        const raw = await contentOf(window, taskId, pageId)
        try {
          const doc = JSON.parse(raw) as { content: Array<{ type: string; content?: unknown[] }> }
          const table = doc.content.find((n) => n.type === 'table')
          return table ? JSON.stringify(table).match(/"text":"([^"]+)"/g)?.map((m) => m.slice(8, -1)) : null
        } catch {
          return null
        }
      }, { timeout: 8_000 })
      .toEqual(['Item', 'Qty', 'Pens', '2', 'Pads', '4'])

    // Into the sticky: a pipe table after what was there, drawn as a table.
    await insertIntoWidget(window, stickyId, 'Stock')
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })
    await expect
      .poll(() => contentOf(window, taskId, stickyId), { timeout: 8_000 })
      .toBe('Stock check\n| Item | Qty |\n| --- | --- |\n| Pens | 2 |\n| Pads | 4 |')
    await expect(window.locator(`[data-widget-id="${stickyId}"] table`)).toContainText('Pads')

    // Both uses counted: each widget really took it.
    const used = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      return (await api.snippets.list({ kinds: ['sheet'] })).find((s) => s.name === 'Stock')?.usageCount ?? -1
    })
    expect(used).toBe(2)
  } finally {
    await dispose()
  }
})

// ── SW-2 ─────────────────────────────────────────────────────────────────────

test('SW-2: a drawing goes on the desk as an image widget and into markdown as a picture; a sticky refuses it', async () => {
  test.setTimeout(150_000)
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await suppressFeatureSpotlights(window)
    await keepNoticesOutOfTheWay(window)

    const drawId = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90), rectObject('b', 300, 140, 60, 40, { fill: { type: 'solid', color: '#ff6600' } })]), 'Logo art')
    await openDocument(window, drawId)
    await runMenu(window, 'edit', 'Select all')
    await runMenu(window, 'edit', 'Save selection as snippet')
    await expect(window.locator('[data-testid="save-snippet-dialog"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="save-snippet-name"]').fill('Boxes')
    await window.locator('[data-testid="save-snippet-confirm"]').click()
    await expect(window.locator('[data-testid="save-snippet-dialog"]')).toBeHidden({ timeout: 5_000 })

    const { taskId, ids } = await deskWith(window, 'Pictures go places', [
      { kind: 'markdown', content: 'Our logo:', x: 80, y: 80, width: 420, height: 360 },
      { kind: 'sticky', content: 'Remember the logo', x: 560, y: 80, width: 300, height: 260 }
    ])
    const [mdId, stickyId] = ids

    // The desk: right-click bare canvas › Add object › From a saved snippet…
    const pt = await bareCanvasPoint(window)
    await window.mouse.click(pt.x, pt.y, { button: 'right' })
    const menu = window.locator('[data-canvas-ctx-menu]').first()
    await expect(menu).toBeVisible({ timeout: 4_000 })
    await menu.getByText('Add object', { exact: true }).hover()
    await window.getByText('From a saved snippet…', { exact: true }).click()
    await chooseDuplicate(window, 'Boxes')
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 8_000 })
    await expect(window.locator('[data-testid="notice-toast"]')).toContainText('It becomes a picture: edit it in PlexiiDraw.', { timeout: 8_000 })
    let image: W | undefined
    await expect
      .poll(async () => {
        image = (await widgetsOf(window, taskId)).find((w) => w.kind === 'image')
        return image?.content ?? ''
      }, { timeout: 10_000 })
      .toMatch(/^fb-file:\/\/[\w-]+$/)
    expect(image!.title).toBe('Boxes')
    // The stored picture is the drawing's SVG, and it really draws.
    const img = window.locator(`[data-widget-id="${image!.id}"] img`)
    await expect(img).toBeVisible({ timeout: 8_000 })
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 8_000 }).toBeGreaterThan(0)

    // Into markdown: ![alt](fb-file://…), shown as a picture.
    await insertIntoWidget(window, mdId, 'Boxes')
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 8_000 })
    await expect
      .poll(() => contentOf(window, taskId, mdId), { timeout: 10_000 })
      .toMatch(/^Our logo:\n\n!\[Picture from PlexiiDraw\]\(fb-file:\/\/[\w-]+\)$/)
    const mdImg = window.locator(`[data-widget-id="${mdId}"] [data-testid="widget-image"] img`)
    await expect(mdImg).toBeVisible({ timeout: 8_000 })
    await expect.poll(() => mdImg.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 8_000 }).toBeGreaterThan(0)

    // Into a sticky: refused with the owner's words; the sticky is untouched.
    await insertIntoWidget(window, stickyId, 'Boxes')
    await expect(window.locator('[data-testid="snippet-library-error"]')).toHaveText('Stickies hold text. Insert it on the desk to add it as an image.', { timeout: 5_000 })
    await window.locator('[data-testid="snippet-library-close"]').click()
    expect(await contentOf(window, taskId, stickyId)).toBe('Remember the logo')
  } finally {
    await dispose()
  }
})

// ── SW-3: paste, through the real system clipboard ───────────────────────────

/**
 * SW-3 Copy two shapes in PlexiiDraw (⌘C, Draw's own copy onto the system
 *      clipboard), then Edit › Paste (the menu item ⌘V runs) with nothing
 *      focused on a desk: an image work widget appears holding the drawing's
 *      picture from the file store, and the notice says where to edit it.
 *      Then with the cursor in a page work widget, Edit › Paste lands the
 *      same picture in the page as an image node.
 *
 * The person's clipboard is saved before and restored after, every item and
 * type (tests/e2e/_macPasteboard.ts).
 */
test.describe('SW-3 paste from the system clipboard', () => {
  let saved: SavedPasteboard | null = null
  test.beforeAll(() => {
    if (process.platform === 'darwin') saved = savePasteboard()
  })
  test.afterAll(() => {
    if (saved) restorePasteboard(saved)
  })

  test('SW-3: a Draw copy pasted on the desk is an image widget, and into a page an image', async () => {
    test.skip(process.platform !== 'darwin', 'reads and restores the macOS pasteboard')
    test.setTimeout(150_000)
    const launched = await launchApp()
    const { window, app, dispose } = launched
    /** Edit › Paste, exactly the menu item ⌘V runs (main/index.ts editAction). */
    const menuPaste = async (): Promise<void> => {
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const edit = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Edit')
        const item = edit?.submenu?.items.find((i) => i.label === 'Paste')
        if (!item) throw new Error('no Edit › Paste')
        const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())
        item.click(undefined, win, win?.webContents)
      })
    }
    try {
      await waitForReady(window)
      await chooseCloudAiSource(window)
      await suppressFeatureSpotlights(window)
      await keepNoticesOutOfTheWay(window)

      const drawId = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90), rectObject('b', 300, 140, 60, 40)]), 'Copy me')
      await openDocument(window, drawId)
      await runMenu(window, 'edit', 'Select all')
      await window.locator('[data-testid="draw-stage"]').hover()
      await window.keyboard.press('Meta+c')
      await expect.poll(() => readPasteboard().types.join(' '), { timeout: 8_000 }).toMatch(/png|svg/)

      const { taskId, ids } = await deskWith(window, 'Paste lands here', [{ kind: 'page', content: '', x: 80, y: 80, width: 460, height: 360 }])
      const [pageId] = ids

      // Nothing focused: the paste is the desk's.
      await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await menuPaste()
      let image: W | undefined
      await expect
        .poll(async () => {
          image = (await widgetsOf(window, taskId)).find((w) => w.kind === 'image')
          return image?.content ?? ''
        }, { timeout: 10_000 })
        .toMatch(/^fb-file:\/\/[\w-]+$/)
      await expect(window.locator('[data-testid="notice-toast"]')).toContainText('It becomes a picture: edit it in PlexiiDraw.', { timeout: 8_000 })
      const img = window.locator(`[data-widget-id="${image!.id}"] img`)
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 8_000 }).toBeGreaterThan(0)
      // Only one widget was made: the page widget did not also take it.
      expect((await widgetsOf(window, taskId)).length).toBe(2)

      // With the cursor in the page: the picture lands in the page.
      await window.locator(`[data-widget-id="${pageId}"] .ProseMirror`).click()
      await menuPaste()
      await expect
        .poll(async () => {
          const raw = await contentOf(window, taskId, pageId)
          try {
            const doc = JSON.parse(raw) as { content: Array<{ type: string; attrs?: { src?: string } }> }
            return doc.content.find((n) => n.type === 'image')?.attrs?.src ?? ''
          } catch {
            return ''
          }
        }, { timeout: 10_000 })
        .toMatch(/^fb-file:\/\/[\w-]+$/)
      await expect(window.locator(`[data-widget-id="${pageId}"] [data-testid="widget-image"] img`)).toBeVisible({ timeout: 8_000 })
      // Still one image widget on the desk: the page took this paste.
      expect((await widgetsOf(window, taskId)).filter((w) => w.kind === 'image').length).toBe(1)
    } finally {
      await dispose()
    }
  })
})
