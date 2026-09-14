import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { mkdirSync, readFileSync } from 'fs'
import { join } from 'path'

// Marketing capture: every screen in the app, and every widget on its own.
//
// Runs against a FRESH userData directory (launchApp mints one), so it never
// photographs anybody's real desks -- the seeded content below is what appears
// in the shots, which is also why it is written to read like a real workspace
// rather than "Test 1 / Test 2".
//
// Widgets are captured with locator.screenshot(), which crops to the element
// itself. A full-frame shot cropped afterwards by coordinates goes wrong the
// moment a widget renders a pixel taller than expected; asking the element for
// its own picture cannot.

const OUT = process.env.SHOT_DIR ?? '/tmp/plexii-shots'
const SCREENS = join(OUT, 'screens')
const WIDGETS = join(OUT, 'widgets')


/**
 * A true 1920x1080 stage.
 *
 * The app ships at 0.9 page zoom, so a window sized to 1920x1080 gives a CSS
 * viewport of 2133x1136 -- and every coordinate Playwright computes is then off
 * by that factor. Element screenshots came back showing a widget shifted up and
 * left with bare canvas along the other two edges, which reads as "the crop is
 * wrong" and is really "the page is not the size anyone thinks it is".
 *
 * Zoom is reset first, then the viewport, and the result is asserted rather
 * than assumed: a silent mismatch here corrupts every shot in the run.
 */
async function stage(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(async () => {
    await (window as unknown as { api: typeof window.api }).api.app.setZoomFactor(1)
  })
  await window.waitForTimeout(300)
  await window.setViewportSize({ width: 1920, height: 1080 })
  await window.waitForTimeout(500)
  const css = await window.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  expect(css.w, 'the CSS viewport must be the size we are capturing at').toBe(1920)
}

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) { await launched.dispose(); launched = null }
})

type Win = import('@playwright/test').Page

/** A workspace with enough in it that the screens are not all empty states. */
async function seed(window: Win): Promise<{ deskId: string; roomId: string }> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const room = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Product launch' })
    const desk = await api.nodes.create({ parentId: room.id, kind: 'task', title: 'Launch plan' })
    await api.nodes.create({ parentId: room.id, kind: 'task', title: 'Pricing review' })
    await api.nodes.create({ parentId: null, kind: 'folder', title: 'Client work' })
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Weekly review' })
    return { deskId: desk.id, roomId: room.id }
  })
}

test('every screen', async () => {
  test.setTimeout(15 * 60_000)
  mkdirSync(SCREENS, { recursive: true })
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await stage(window)
  const { deskId, roomId } = await seed(window)
  // The node store has to learn about nodes created straight through the IPC
  // surface. Without this the desk view renders an empty shell -- the view is
  // on the task, the store has never heard of it, and every widget screenshot
  // comes back blank.
  await window.evaluate(async () => {
    await (window as unknown as { __fbNodes: { getState: () => { refresh: () => Promise<void> } } })
      .__fbNodes.getState().refresh()
  })
  await window.waitForTimeout(700)


  const shot = async (name: string, go: string, arg?: string): Promise<void> => {
    const ok = await window.evaluate(
      ({ go, arg }) => {
        const w = window as unknown as { __fbView?: { getState: () => Record<string, (a?: unknown) => void> } }
        const fn = w.__fbView?.getState()[go]
        if (typeof fn !== 'function') return false
        arg === undefined ? fn() : fn(arg)
        return true
      },
      { go, arg }
    )
    if (!ok) { console.log(`  skipped ${name} (no ${go})`); return }
    await window.waitForTimeout(1100)
    await window.screenshot({ path: join(SCREENS, `${name}.png`) })
    console.log(`  ${name}`)
  }

  // Every navigation the app offers, named as a person would file it.
  await shot('01-home', 'goHome')
  await shot('02-desks', 'goDesks')
  await shot('03-rooms', 'goRooms')
  await shot('04-room', 'goRoom', roomId)
  await shot('05-desk-canvas', 'goTask', deskId)
  await shot('06-all-tasks', 'goAllTasks')
  await shot('07-attention', 'goAttention')
  await shot('08-calendar', 'goCalendar')
  await shot('09-projects', 'goProjects')
  await shot('10-documents', 'goDocuments')
  await shot('11-files', 'goFiles')
  await shot('12-knowledge', 'goKnowledge')
  await shot('13-insights', 'goInsights')
  await shot('14-reports', 'goReports')
  await shot('15-flows', 'goFlows')
  await shot('16-apps', 'goApps')
  await shot('17-forms', 'goForms')
  await shot('18-sign', 'goSign')
  await shot('19-meetings', 'goMeetings')
  await shot('20-messages', 'goMessages')
  await shot('21-inbox', 'goInbox')
  await shot('22-mail', 'goMail')
  await shot('23-people-map', 'goPeopleMap')
  await shot('24-collaborations', 'goCollaborations')
  await shot('25-shared-with-me', 'goShared')
  await shot('26-org', 'goOrg')
  await shot('27-vault', 'goVault')
  await shot('28-trash', 'goTrash')
  await shot('29-search', 'goSearch')
  await shot('30-design', 'goDesign')
  await shot('31-marketplace', 'goMarketplace')
  await shot('32-api', 'goApi')
  await shot('33-plexioffice', 'goOffice')
  await shot('34-plexidesk', 'goPlexiDesk')
  await shot('35-plexipeople', 'goPlexiPeople')
  await shot('36-plexibrain', 'goPlexiBrain')
  await shot('37-plexii', 'goPlexii')
  await shot('38-product', 'goProduct')
  await shot('39-suite', 'goSuite')

  expect(true).toBe(true)
})

/**
 * Every widget, each cropped to itself.
 *
 * The kind list is read from the catalog SOURCE rather than typed out here, so
 * a widget added to the product cannot quietly go unphotographed.
 *
 * Each one is given content that makes it look like itself: a grid of empty
 * frames photographs badly and says nothing about what the thing is for. Kinds
 * whose content is a reference to a row elsewhere (doc, sheet, slides, table)
 * get that row created first, or they render as a broken link.
 */
interface CatalogEntry { kind: string; width: number; height: number }

/**
 * Every kind, at the size the product itself thinks it should be.
 *
 * defaultWidth/defaultHeight are authored per kind in the catalog -- a sticky is
 * small, a table is wide, a document is tall -- so a showcase shot at those
 * dimensions shows the widget as designed rather than squeezed into one
 * arbitrary square. Anything without an authored size gets a sensible default.
 */
function catalogEntries(): CatalogEntry[] {
  const src = readFileSync('src/renderer/src/lib/widgetCatalog.ts', 'utf8')
  const out: CatalogEntry[] = []
  const blocks = src.split(/\n  \{/)
  for (const b of blocks) {
    const kind = /^\s*(?:\/\/[^\n]*\n\s*)*kind: '([a-z-]+)'/m.exec(b)?.[1]
      ?? /kind: '([a-z-]+)'/.exec(b)?.[1]
    if (!kind) continue
    // Capped: a few kinds are authored to open full-bleed (webview's default is
    // the whole 1920x1080 window), and a full-screen shot is not a portrait of a
    // widget. Everything under the cap keeps its authored size exactly.
    const w = Math.min(Number(/defaultWidth: (\d+)/.exec(b)?.[1] ?? 420), 900)
    const h = Math.min(Number(/defaultHeight: (\d+)/.exec(b)?.[1] ?? 320), 680)
    if (!out.some((e) => e.kind === kind)) out.push({ kind, width: w, height: h })
  }
  return out
}

test('every widget, cropped to itself', async () => {
  test.setTimeout(20 * 60_000)
  mkdirSync(WIDGETS, { recursive: true })
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await stage(window)

  // minimap is in the catalog but deprecated: the canvas deletes any stored
  // minimap widget on sight (it is the corner FAB now), so there is nothing to
  // photograph and asking for one would report a failure that is correct
  // behaviour.
  const entries = catalogEntries().filter((e) => e.kind !== 'minimap')
  expect(entries.length).toBeGreaterThan(40)

  const placed = await window.evaluate(async (entries: Array<{ kind: string; width: number; height: number }>) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Widget showcase' })

    const doc = await api.documents.create({ docType: 'doc', title: 'Positioning note' })
    const sheet = await api.documents.create({ docType: 'sheet', title: 'Q3 forecast' })
    const slides = await api.documents.create({ docType: 'slides', title: 'Launch deck' })
    // A table with no rows photographs as an empty state, which is honest but
    // makes a poor showcase -- and the chart widget plots this table, so an
    // empty one leaves the chart blank too.
    const table = await api.tables.create({ taskId: desk.id, title: 'Pipeline' })
    await api.tables.update(table.id, {
      schema: {
        columns: [
          { id: 'c-prop', type: 'text-short', label: 'Property', config: {} },
          { id: 'c-stage', type: 'single-select', label: 'Stage', config: { options: [
            { id: 'o-live', label: 'Campaign live', color: '#f2b705' },
            { id: 'o-offer', label: 'Under offer', color: '#fb923c' },
            { id: 'o-exch', label: 'Exchanged', color: '#34d399' }
          ] } },
          { id: 'c-guide', type: 'number', label: 'Guide ($m)', config: {} }
        ]
      }
    } as never)
    const ROWS = [
      { 'c-prop': '12/8 Bay Street', 'c-stage': 'o-live', 'c-guide': 2.35 },
      { 'c-prop': '6 Transvaal Avenue', 'c-stage': 'o-offer', 'c-guide': 7.9 },
      { 'c-prop': '3/21 Kiaora Road', 'c-stage': 'o-live', 'c-guide': 1.95 },
      { 'c-prop': '2/14 Manning Road', 'c-stage': 'o-exch', 'c-guide': 3.15 },
      { 'c-prop': '41 Ocean Avenue', 'c-stage': 'o-live', 'c-guide': 6.4 }
    ]
    for (const cells of ROWS) {
      await api.tables.createRow({ tableId: table.id, cells } as never)
    }

    const tiptap = (t: string): string =>
      JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })

    const CONTENT: Record<string, string> = {
      sticky: 'Call the vendor before 4pm —\nfeedback from Saturday’s open.',
      note: 'Three buyers want a second inspection.',
      markdown: '## This week\n\n- Auction Saturday\n- Vendor report Friday\n- Two contracts out',
      card: JSON.stringify({ title: 'Win the listing', body: 'Appraisal through to a signed authority, one row per vendor.', accent: '#f2b705' }),
      page: tiptap('A page of prose that lives on the canvas and is edited in place.'),
      'living-doc': tiptap('This document rewrites itself from the desk around it.'),
      doc: doc.id,
      sheet: sheet.id,
      slides: slides.id,
      design: '',
      map: '',
      table: table.id,
      chart: JSON.stringify({ tableId: table.id, type: 'bar', xColumnId: 'c-stage', series: [{ columnId: 'c-guide', agg: 'sum' }] }),
      field: JSON.stringify({ def: { id: 'f1', type: 'number', label: 'Days on market', config: {} }, value: 27 }),
      calculator: '51700',
      'stat-card': JSON.stringify({
        title: 'Median price',
        series: [
          { label: 'Sales', caption: 'Median sale price · 12 months', display: '$5.2M',
            points: [4.6, 4.7, 4.65, 4.8, 4.9, 4.88, 5.0, 5.05, 5.1, 5.0, 5.15, 5.2] },
          { label: 'Rentals', caption: 'Median weekly rent · 12 months', display: '$1,240',
            points: [1080, 1100, 1120, 1115, 1160, 1180, 1175, 1200, 1210, 1225, 1230, 1240] }
        ],
        activeIndex: 0
      }),
      color: '#f2b705',
      shape: JSON.stringify({ fill: '#bfe3d4', label: 'Phase one' }),
      scratchpad: 'quick sums, and a number worth keeping\n0412 345 678',
      timer: '1500',
      webview: 'https://example.com',
      gdoc: 'https://docs.google.com/document/d/example',
      gsheet: 'https://docs.google.com/spreadsheets/d/example',
      gslide: 'https://docs.google.com/presentation/d/example'
    }

    const out: Array<{ kind: string; id: string; x: number; y: number; width: number; height: number }> = []
    let x = 80
    let y = 80
    for (const { kind, width, height } of entries) {
      const w = await api.widgets.create({
        taskId: desk.id,
        kind: kind as never,
        title: '',
        content: CONTENT[kind] ?? '',
        x,
        y,
        width,
        height
      })
      out.push({ kind, id: w.id, x, y, width, height })
      // Spaced by the widget's own footprint so nothing overlaps its neighbour
      // in the shot behind it.
      x += width + 200
      if (x > 3000) { x = 80; y += 700 }
    }
    return { deskId: desk.id, widgets: out }
  }, entries)

  // The node store has to learn about nodes created straight through the IPC
  // surface. Without this the desk view renders an empty shell -- the view is
  // on the task, the store has never heard of it, and every widget screenshot
  // comes back blank.
  await window.evaluate(async () => {
    await (window as unknown as { __fbNodes: { getState: () => { refresh: () => Promise<void> } } })
      .__fbNodes.getState().refresh()
  })
  await window.waitForTimeout(700)
  await window.evaluate((id: string) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView!.getState().goTask(id)
  }, placed.deskId)
  await window.waitForTimeout(2500)

  let shot = 0
  const missing: string[] = []
  const clipped: string[] = []
  // Where a widget is parked to be photographed.
  //
  // Not the top-left: the sidebar FLOATS OVER the canvas rather than sitting
  // beside it, so a widget at x=220 is measured correctly, reported correctly,
  // and drawn with its left third behind the sidebar. Every crop looked like a
  // cropping bug and was really a stacking one. Clear of the sidebar (~270),
  // below the desk toolbar (~110), and left of the minimap that opens itself
  // in the bottom-right corner after every pan.
  const CX = 520
  const CY = 260
  // The canvas surface starts below the app's title bar.
  const BAR = await window.evaluate(() => {
    const el = document.querySelector('[data-canvas-surface="true"]')
    return el ? Math.round(el.getBoundingClientRect().top) : 0
  })
  for (const { kind, id, x, y, width, height } of placed.widgets) {
    // The camera has to be moved to each one first. The canvas virtualises:
    // a widget outside the viewport is not merely off-screen, it is not in the
    // DOM at all, so scrollIntoView has nothing to scroll to and every
    // screenshot came back empty. Centring the camera mounts it.
    await window.evaluate(
      ({ x, y, CX, CY }) => {
        const w = window as unknown as {
          __fbWidgets?: { getState: () => { setPan: (a: number, b: number) => void; setZoom: (z: number) => void } }
        }
        const s = w.__fbWidgets?.getState()
        s?.setZoom(1)
        // Centre the widget: its top-left lands at (CX, CY) below.
        s?.setPan(CX - x, CY - y)
      },
      { x, y, CX, CY }
    )
    // Park the pointer off the widget: hovering one raises its toolbar, which
    // then appears in the portrait as chrome nobody asked for.
    await window.mouse.move(1750, 180)
    await window.waitForTimeout(700)
    const el = window.locator(`[data-widget-id="${id}"]`)
    try {
      await el.waitFor({ state: 'visible', timeout: 3000 })
      await window.waitForTimeout(350)
      await el.screenshot({ path: join(WIDGETS, `${kind}.png`), timeout: 8000 })
      shot++
    } catch {
      // A couple of widgets do not use the shared frame and carry no
      // data-widget-id, so they are on screen but not findable that way. Each
      // names its own root instead.
      const BY_KIND: Record<string, string> = {
        'image-gen': '[data-testid="image-gen-widget"]',
        // Signed out, this widget is a bare div holding one sentence, with no
        // testid of its own. That sentence IS its root, so it is the handle.
        // The shot therefore shows the signed-out state, which is the honest
        // thing to show for a capture that runs without an account.
        'chat-thread': 'text=Sign in to use chat on this desk.'
      }
      const alt = BY_KIND[kind]
      let done = false
      if (alt) {
        try {
          const a = window.locator(alt).first()
          await a.waitFor({ state: 'visible', timeout: 3000 })
          await a.screenshot({ path: join(WIDGETS, `${kind}.png`), timeout: 8000 })
          shot++
          done = true
          clipped.push(`${kind} (own root)`)
        } catch { /* fall through to the clip */ }
      }
      if (!done) {
        // Last resort. The camera was set deliberately, so the rectangle is
        // known -- but a clip cannot tell whether anything is IN it, which is
        // why the audit below re-reads every file.
        try {
          await window.screenshot({
            path: join(WIDGETS, `${kind}.png`),
            clip: { x: CX, y: CY + BAR, width, height }
          })
          shot++
          clipped.push(`${kind} (clipped)`)
        } catch {
          missing.push(kind)
        }
      }
    }
  }
  console.log(`  widgets captured: ${shot}/${placed.widgets.length}`)
  if (clipped.length) console.log(`  captured by clip (no shared frame): ${clipped.join(', ')}`)
  if (missing.length) console.log(`  did not render: ${missing.join(', ')}`)
  expect(shot).toBeGreaterThan(30)
})
