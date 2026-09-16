import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Fixes from the Plexii teardown. Each asserts the defect is gone AND that
// what the defect was hiding still works.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('a table widget has ONE title bar, and can still be renamed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Table desk' })
    const t = await api.tables.create({
      taskId: desk.id,
      title: 'Launch Timeline',
      schema: { columns: [{ id: 'c1', type: 'text-short', label: 'Name', config: {} }] }
    })
    await api.tables.createRow({ tableId: t.id, cells: { c1: 'Feature freeze' } })
    await api.widgets.create({
      taskId: desk.id, kind: 'table' as never, title: 'Launch Timeline',
      content: t.id, x: 100, y: 100, width: 520, height: 380
    })
    return { deskId: desk.id, tableId: t.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, ids.deskId)

  const widget = window.locator('[data-widget-kind="table"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })

  // The inner header is gone: the title appears once, not twice.
  const titleOccurrences = await window.evaluate(() => {
    const el = document.querySelector('[data-widget-kind="table"]')
    return (el?.textContent?.match(/Launch Timeline/g) ?? []).length
  })
  expect(titleOccurrences).toBe(1)

  // The row count moved into that one title bar.
  await expect(widget).toContainText('1 row')

  // ...and the Import button no longer occupies a permanent row.
  await expect(widget.getByTestId('table-import-button')).toHaveCount(0)

  // Renaming through the frame still renames the TABLE — the thing the inner
  // input used to be the only way to do.
  // Through the STORE, which is what the header's rename does — a direct IPC
  // write never reaches the component that has to mirror it.
  await window.evaluate(async () => {
    const w = window as unknown as {
      __fbWidgets?: { getState: () => { widgets: Array<{ id: string; kind: string }>; update: (id: string, p: unknown) => Promise<unknown> } }
    }
    const st = w.__fbWidgets?.getState()
    const t = st?.widgets.find((x) => x.kind === 'table')
    if (t) await st?.update(t.id, { title: 'Release Timeline' })
  })
  await window.waitForTimeout(1200)
  const tableTitle = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.tables.get(id))?.title
  }, ids.tableId)
  expect(tableTitle).toBe('Release Timeline')
})

test('sidebar nav icons are one colour, with the accent only on the active row', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForTimeout(1200)

  const tones = await window.evaluate(() => {
    const rows = [...document.querySelectorAll('.fb-nav-item')]
    const classes = rows.map((r) => r.querySelector('span')?.className ?? '')
    // Count DISTINCT per-area hues still applied to nav icons.
    const hues = new Set(
      classes
        .flatMap((c) => c.split(/\s+/))
        .filter((c) => /^text-(indigo|sky|teal|fuchsia|violet|emerald|amber|orange|rose|purple|pink|cyan)-500$/.test(c))
    )
    return { rows: rows.length, hues: [...hues] }
  })

  expect(tones.rows).toBeGreaterThan(0)
  // The defect was twelve hues carrying no meaning. None should remain.
  expect(tones.hues).toEqual([])
})

test('widget controls are hidden at rest, revealed on hover, and still clickable', async () => {
  // The exact thing a previous attempt broke: an earlier hover-reveal used
  // pointer-events: none and made every widget control refuse the click that
  // followed the reveal.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Chrome desk' })
    await api.widgets.create({
      taskId: desk.id, kind: 'sticky' as never, title: '',
      content: 'a note', x: 160, y: 160, width: 260, height: 200
    })
    return desk.id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)

  const widget = window.locator('[data-widget-id]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  const actions = widget.locator('.fb-widget-actions').first()

  // At rest: present in the DOM but not lit.
  const restOpacity = await actions.evaluate((el) => getComputedStyle(el).opacity)
  expect(restOpacity).toBe('0')

  // Hover reveals them.
  await widget.hover()
  await window.waitForTimeout(250)
  const hoverOpacity = await actions.evaluate((el) => getComputedStyle(el).opacity)
  expect(hoverOpacity).toBe('1')

  // And hit-testing was never removed — this is what broke last time.
  const pe = await actions.evaluate((el) => getComputedStyle(el).pointerEvents)
  expect(pe).not.toBe('none')

  // Prove it by actually pressing one. Whatever the first control is, it must
  // receive the click — that is the property that was lost last time.
  const titles = await actions.evaluate((el) =>
    [...el.querySelectorAll('button')].map((b) => b.getAttribute('title') || b.getAttribute('aria-label') || '')
  )
  expect(titles.length).toBeGreaterThan(0)
  const first = actions.locator('button').first()
  await expect(first).toBeEnabled()
  // A click that lands is the whole point; it must not throw on an
  // intercepted / non-hit-testable element.
  await first.click({ timeout: 3000 })
})
