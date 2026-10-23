import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { MENU } from '../../src/shared/menus/lexicon'

// "Can you make widgets available render and edit in other all office apps."
//
// The embed used to be 242 lines of read-only re-implementation that resolved
// DESK widgets only. Two things had to become true: a work widget FILE (which
// has no desk — docs/widget-files.md) must resolve, and what renders must be
// the real component so it can be typed into.
//
// The third thing is a guard, not a feature: `remove` on a `wf:` id trashes
// the FILE and every desk instance of it. An embed inside a document must not
// be able to do that by accident.

let launched: LaunchedApp | null = null
test.afterEach(async () => { await launched?.app.close().catch(() => {}); launched = null })

test('a work widget file resolves and renders in an embed, and edits write to the file', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const made = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const file = await api.widgetFiles.create({ kind: 'sticky', content: 'before' } as never, {} as never)
    return { id: (file as { id: string }).id }
  })
  expect(made.id).toBeTruthy()

  // The embed resolves by the pane id, exactly as a document node would.
  const resolved = await window.evaluate(async (fileId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const f = await api.widgetFiles.get(fileId)
    return { found: !!f, kind: f?.kind ?? null, content: f?.content ?? null }
  }, made.id)
  expect(resolved.found, 'the file did not resolve').toBe(true)
  expect(resolved.kind).toBe('sticky')

  // An edit routed through the pane id must reach the FILE, which is what
  // makes the embed editable rather than a copy.
  await window.evaluate(async (fileId) => {
    const w = (window as unknown as {
      __fbWidgets?: { getState: () => { update: (id: string, p: { content: string }) => Promise<unknown> } }
    }).__fbWidgets
    await w?.getState().update(`wf:${fileId}`, { content: 'after' })
  }, made.id)
  await window.waitForTimeout(600)

  const after = await window.evaluate(async (fileId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgetFiles.get(fileId))?.content ?? null
  }, made.id)
  expect(after, 'the edit did not reach the file').toBe('after')
})

test('the embed offers no control that could trash the file', async () => {
  // THE HAZARD, from docs/widget-files.md and stores/widgets.ts: `remove` on a
  // `wf:` id trashes the FILE and every desk instance of it. A stray close
  // button inside a document would therefore destroy an object that also
  // lives in Files and on other desks.
  //
  // This used to be pinned only in the SOURCE, by asserting renderWidget never
  // mentions WidgetFrame. That proxy was wrong from the start: renderWidget
  // draws each kind's own component, and those frame themselves (StickyWidget
  // renders WidgetFrame), so a sticky in a document embed has always carried
  // the desk title bar and its "Remove work widget" ×. 5d1d3beb then framed
  // the four body-only kinds inside renderWidget on purpose, which is what
  // turned the proxy red. The guard is now on the thing that matters: the
  // embed body tells the frame the host owns removal, and in the running app
  // an embedded work widget file shows its frame and no remove tool at all.
  const { readFileSync } = await import('node:fs')
  const body = readFileSync('src/renderer/src/components/documents/embed/EmbeddedWidgetBody.tsx', 'utf8')
  const embed = readFileSync('src/renderer/src/components/documents/embed/WidgetEmbed.tsx', 'utf8')
  expect(body, 'the embed renders the desk frame itself').not.toContain('WidgetFrame')
  expect(embed, 'the embed renders the desk frame').not.toContain('WidgetFrame')
  for (const src of [body, embed]) {
    expect(src, 'the embed can call widget removal').not.toMatch(/\.remove\(|confirmTrash|trashWidgetFile/)
  }
  expect(body, 'the embed body must tell the frame it may not remove').toContain(
    '<WidgetRemovableContext.Provider value={false}>'
  )

  // And in the running app, through the real Insert path.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { fileId, docId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const file = await api.widgetFiles.create({ kind: 'sticky', content: 'do not trash me' } as never, {} as never)
    const doc = await api.documents.create({ docType: 'doc', title: 'Embed guard doc' } as never)
    return { fileId: (file as { id: string }).id, docId: doc.id }
  })
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
    w.__fbView?.getState().goDocument(id)
  }, docId)
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="doc-menu-insert"]').click()
  // From the lexicon, not spelled out: the label gained a trailing ellipsis in
  // ef1fba83 (SPEC §9.2's Insert tail), and the literal here did not follow,
  // which is the whole of why this test went red. See widgetEmbed.spec.ts.
  await window
    .locator('[data-testid="doc-menu-insert-list"]')
    .getByText(MENU.workWidgetFromDesk.label, { exact: true })
    .click()
  await expect(window.locator('[data-testid="widget-picker"]')).toBeVisible({ timeout: 3_000 })
  await window.locator(`[data-testid="widget-picker-item-wf:${fileId}"]`).click()
  await expect(window.locator('[data-testid="widget-picker"]')).toHaveCount(0, { timeout: 3_000 })

  const embedded = window.locator('[data-testid="widget-embed"]')
  await expect(embedded).toBeVisible({ timeout: 5_000 })
  await expect(embedded).toContainText('do not trash me')
  // Not vacuous: the frame, with its header and tools, really is in the embed.
  const header = embedded.locator('[data-widget-header]')
  await expect(header).toHaveCount(1)
  await header.hover()
  await expect(header.locator('.fb-widget-actions')).toHaveCount(1)
  // No remove on the header…
  await expect(embedded.locator('[data-testid="widget-remove"]')).toHaveCount(0)
  await expect(embedded.getByRole('button', { name: 'Remove work widget' })).toHaveCount(0)
  // …nor behind "…", when the header folded tools into it.
  const more = header.locator(`[data-testid="widget-overflow-wf:${fileId}"]`)
  if ((await more.count()) > 0) {
    await more.click()
    const menu = window.getByRole('menu', { name: 'More work widget actions' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Remove work widget' })).toHaveCount(0)
    await window.keyboard.press('Escape')
  }
  // And the file is intact.
  const file = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const f = await api.widgetFiles.get(id)
    return { exists: !!f, trashed: !!f?.trashed }
  }, fileId)
  expect(file).toEqual({ exists: true, trashed: false })
})

test('no office surface can trash the file behind an embedded widget', async () => {
  // Asked by d1 before shipping, and worth pinning rather than answering
  // once: `remove` on a `wf:` id trashes the FILE and every copy of it on
  // every desk. Six editors now host embeds, each with its own delete — a
  // sheet's ×, a draw object, a slide or design element, a document node.
  // Every one of those must remove the PLACEMENT and leave the file alone.
  //
  // Source-level on purpose. A DOM probe only covers whichever surface
  // happens to be open, and the risk here is a future editor wiring its
  // delete to the widget store, which no runtime test would see until it
  // had already destroyed someone's work.
  const { readFileSync, readdirSync } = await import('node:fs')
  const dir = 'src/renderer/src/components/documents'
  const files: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${d}/${e.name}`)
      else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) files.push(`${d}/${e.name}`)
    }
  }
  walk(dir)
  expect(files.length, 'found no editor sources to check').toBeGreaterThan(10)

  const offenders: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    if (/useWidgetStore\.getState\(\)\.remove\(/.test(src)) offenders.push(`${f}: calls widget store remove`)
    if (/deleteWidgetAction|confirmTrashWidgetFile/.test(src)) offenders.push(`${f}: calls a widget trash helper`)
  }
  expect(offenders, `an office editor can trash a work widget file:\n${offenders.join('\n')}`).toEqual([])

  // And the sheet's × specifically removes only its own placement.
  const sheet = readFileSync(`${dir}/SheetEditor.tsx`, 'utf8')
  expect(sheet, "the sheet's remove should filter its own widgets list").toContain(
    "widgets: (t.widgets ?? []).filter((w) => w.id !== pl.id)"
  )
})
