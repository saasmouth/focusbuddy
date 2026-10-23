import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  launchApp,
  waitForReady,
  openNewDesk,
  suppressFeatureSpotlights,
  chooseCloudAiSource,
  grantCapability,
  type LaunchedApp
} from './_helpers'

// Every side-menu row wears an owner icon (4.3.41, the 22 Oct 2026 delivery).
//
// The owner's set now covers the menu's places, Focus filters, section heads,
// People and PlexiiBrain rows and the Bring-in actions, as well as the apps,
// tools, work widgets and connected apps it already covered. This opens every
// section in all four areas (a desk open in PlexiiDesk, then Apps, People and
// PlexiiBrain), walks every visible button in the menu panel and classifies
// its icon:
//
//   owner  an owner asset ([data-plexii-icon]; a 'glyph' mask counts)
//   old    a Material Symbol or an inline svg glyph
//   none   no icon at all
//
// It FAILS if any row other than the declared chrome (collapse, expand,
// minimise, close, Upgrade, the "+" that connects an app) or a row declared
// below as having no icon in the set is not an owner icon. So a row that loses
// its icon, or a new row added without one, is caught here and not by eye.
//
// A second test per theme does the same for the COLLAPSED RAIL (the menu at
// icon width), which the expanded walk never reaches. The workspace switcher
// is covered by the first test (it opens the switcher's menu before auditing);
// since c581655d it holds workspaces and Manage organisation, not the areas.
//
// 23 Oct 2026 the owner's gradient revision replaced the 22 Oct line icons
// (which largely duplicated the app's own glyphs) with distinct symbols on
// tiles. The rows now carry tiles in places sized for glyphs, so both tests
// also check that every tile fits: the Apps-section tile edge in menu rows, one
// edge across the rail, nothing clipped or spilling.
// tests/unit/plexiiIconSameArt.test.ts guards against a delivery that is the
// app's own glyph redrawn; this spec proves what is drawn, and that it fits.
//
// PLEXII_ICON_AUDIT_ONLY=1 records without asserting (for auditing an older
// build), and PLEXII_ICON_AUDIT_OUT=<file> writes the table as JSON. Light and
// dark screenshots of the expanded menu, per area, go to SHOTS.

const SHOTS = process.env.PLEXII_ICON_SHOTS ?? '/private/tmp/claude-501/icons-missing-shots'
const AUDIT_ONLY = process.env.PLEXII_ICON_AUDIT_ONLY === '1'
const AUDIT_OUT = process.env.PLEXII_ICON_AUDIT_OUT

type Area = 'desk' | 'office' | 'people' | 'brain'

interface AuditRow {
  area: Area
  id: string
  icon: 'owner' | 'old' | 'none'
  owner: string | null
  glyphs: string[]
}

/**
 * Generic chrome: rows whose icon is a control, not a thing. Matched by testid,
 * or by title for the two controls that have none (the Rooms sub-list toggle).
 */
const CHROME: RegExp[] = [
  /^nav-section-(desk|apps|widgets|connected|people|brain)$/, // collapse / expand a section
  /^sidebar-attention-toggle$/, // show / hide the Focus filters
  /^(Expand|Collapse)$/, // the Rooms sub-list toggle
  /^sidemenu-other-widgets-toggle$/, // expand / collapse Other work widgets
  /^menu-minimize$/, // minimise the menu
  /^workspace-switcher-trigger$/, // carries the Organisation tool icon, but is a picker
  /^upgrade-card-dismiss$/, // close
  /^Upgrade Now$/, // the Upgrade card's button (text only)
  /^nav-add-connected-app$/ // the "+" beside Connected apps
]

/** Rows the owner's set has no icon for yet. Each says why; the guard holds them to this list. */
const KNOWN_NO_ICON: Record<string, string> = {
  'sidemenu-widgets-bring-synced': 'Bring a synced work widget: not in the 22 Oct 2026 delivery (request sections 1-11)'
}

const isChrome = (id: string): boolean => CHROME.some((re) => re.test(id))

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

/** The menu panel that holds the accordion, whichever shell drew it. */
const PANEL = 'aside:has([data-testid="area-accordion"])'

async function expandEverything(window: Page): Promise<void> {
  // Sections, then the nested lists inside them. Each click can reveal more.
  for (let pass = 0; pass < 3; pass++) {
    const clicked = await window.evaluate((panelSel) => {
      const panel = document.querySelector(panelSel)
      if (!panel) return 0
      const want = Array.from(
        panel.querySelectorAll<HTMLButtonElement>(
          [
            'button[data-testid^="nav-section-"][aria-expanded="false"]',
            'button[data-testid="sidebar-attention-toggle"][aria-expanded="false"]',
            'button[data-testid="sidemenu-other-widgets-toggle"][aria-expanded="false"]',
            'button[title="Expand"]'
          ].join(', ')
        )
      ).filter((b) => b.getClientRects().length > 0)
      for (const b of want) b.click()
      return want.length
    }, PANEL)
    if (!clicked) break
    await window.waitForTimeout(250)
  }
}

/** The workspace switcher's menu holds Manage organisation. */
async function openWorkspaceMenu(window: Page): Promise<void> {
  const menu = window.locator(`${PANEL} [data-testid="workspace-switcher-menu"]`)
  if (!(await menu.isVisible().catch(() => false))) {
    await window.locator(`${PANEL} [data-testid="workspace-switcher-trigger"]`).first().click()
    await expect(menu).toBeVisible({ timeout: 5_000 })
  }
}

async function audit(window: Page, area: Area, container: string = PANEL): Promise<AuditRow[]> {
  return window.evaluate(
    ([panelSel, a]) => {
      const panel = document.querySelector(panelSel)
      if (!panel) return []
      return Array.from(panel.querySelectorAll<HTMLButtonElement>('button'))
        .filter((b) => b.getClientRects().length > 0)
        .map((b) => {
          const owner = b.querySelector<HTMLElement>('[data-plexii-icon]')
          const material = Array.from(b.querySelectorAll('.material-symbols-outlined')).map((s) => (s.textContent ?? '').trim())
          const svgs = Array.from(b.querySelectorAll('svg')).filter((s) => !s.closest('[data-plexii-icon]')).map(() => 'svg')
          const id =
            b.dataset.testid ||
            b.getAttribute('title') ||
            b.getAttribute('aria-label') ||
            (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48)
          return {
            area: a as 'desk' | 'office' | 'people' | 'brain',
            id,
            icon: (owner ? 'owner' : material.length || svgs.length ? 'old' : 'none') as 'owner' | 'old' | 'none',
            owner: owner ? `${owner.dataset.plexiiIcon}${owner.dataset.plexiiStyle === 'glyph' ? ' (glyph)' : ''}` : null,
            glyphs: [...material, ...svgs]
          }
        })
    },
    [container, area] as const
  )
}

/** Every owner icon in the panel actually loads (img decoded, glyph mask file fetchable). */
async function brokenOwnerIcons(window: Page, container: string = PANEL): Promise<string[]> {
  await window.waitForFunction(
    (sel) => Array.from(document.querySelectorAll<HTMLImageElement>(`${sel} img[data-plexii-icon]`)).every((i) => i.complete),
    container,
    { timeout: 10_000 }
  )
  return window.evaluate(async (sel) => {
    const broken: string[] = []
    for (const i of Array.from(document.querySelectorAll<HTMLImageElement>(`${sel} img[data-plexii-icon]`))) {
      if (!(i.naturalWidth > 0)) broken.push(`${i.dataset.plexiiIcon} ${i.currentSrc}`)
    }
    for (const g of Array.from(document.querySelectorAll<HTMLElement>(`${sel} [data-plexii-style="glyph"]`))) {
      const url = g.dataset.plexiiSrc ?? ''
      const ok = await new Promise<boolean>((res) => {
        const im = new Image()
        im.onload = () => res(im.naturalWidth > 0)
        im.onerror = () => res(false)
        im.src = url
      })
      if (!ok) broken.push(`${g.dataset.plexiiIcon} ${url}`)
    }
    return broken
  }, container)
}

/**
 * Do the tiles in menu rows fit? Row tiles (an <img> asset inside a nav row,
 * not the Apps grid) must equal the Apps-section tile edge, be square, decode,
 * and lie inside their row button and every clipping ancestor up to the panel.
 */
async function tileFit(window: Page, containers: string): Promise<{ appTile: number; rowTiles: number; offenders: string[] }> {
  return window.evaluate((sel) => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(sel))
    const app = document.querySelector<HTMLElement>('[data-testid^="office-sideapp-"] img[data-plexii-icon]')
    const appTile = app ? Math.round(app.getBoundingClientRect().width) : 0
    const offenders: string[] = []
    const seen = new Set<Element>()
    let rowTiles = 0
    for (const root of roots)
      for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('button.fb-nav-row img[data-plexii-icon], .fb-nav-row img[data-plexii-icon]'))) {
        if (seen.has(img) || img.getClientRects().length === 0) continue
        seen.add(img)
        rowTiles++
        const r = img.getBoundingClientRect()
        const id = img.dataset.plexiiIcon
        if (Math.round(r.width) !== appTile || Math.round(r.height) !== appTile) offenders.push(`${id}: ${r.width}x${r.height}`)
        if (!(img.naturalWidth > 0)) offenders.push(`${id}: not decoded`)
        const row = img.closest('button') ?? img.parentElement!
        const b = row.getBoundingClientRect()
        if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) offenders.push(`${id}: spills its row`)
        for (let el = img.parentElement; el && el !== root.parentElement; el = el.parentElement) {
          const cs = getComputedStyle(el)
          if (!/(hidden|clip|auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY)) continue
          const c = el.getBoundingClientRect()
          // A scroller clips only what is scrolled out of view; a row inside it must be wholly within its box horizontally.
          if (r.left < c.left - 0.5 || r.right > c.right + 0.5) offenders.push(`${id}: clipped by ${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`)
        }
      }
    return { appTile, rowTiles, offenders }
  }, containers)
}

/** The panel scrolls; shoot it top to bottom, one file per screenful. */
async function shootPanel(window: Page, name: string): Promise<void> {
  const geom = await window.evaluate((sel) => {
    const panel = document.querySelector<HTMLElement>(sel)
    if (!panel) return null
    let scroller: HTMLElement | null = panel
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    const s = scroller ?? panel
    s.scrollTop = 0
    const r = panel.getBoundingClientRect()
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: Math.min(r.height, window.innerHeight - r.top), scrollH: s.scrollHeight, clientH: s.clientHeight }
  }, PANEL)
  if (!geom) return
  const pages = Math.max(1, Math.ceil(geom.scrollH / Math.max(1, geom.clientH - 40)))
  for (let p = 0; p < pages; p++) {
    await window.evaluate(
      ([sel, top]) => {
        let s: HTMLElement | null = document.querySelector<HTMLElement>(sel as string)
        while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement
        if (s) s.scrollTop = top as number
      },
      [PANEL, p * (geom.clientH - 40)] as const
    )
    await window.waitForTimeout(150)
    await window.screenshot({ path: `${SHOTS}/${name}-${p + 1}.png`, clip: { x: geom.x, y: geom.y, width: geom.width, height: geom.height } })
  }
}

async function enterArea(window: Page, area: Area, theme: string): Promise<void> {
  if (area === 'desk') {
    await openNewDesk(window, `Icon guard ${theme}`)
  } else {
    const kind = area === 'office' ? 'office' : area === 'people' ? 'plexipeople' : 'plexibrain'
    const head = window.locator(`${PANEL} [data-testid="switch-${kind}"]`).first()
    await expect(head).toBeVisible({ timeout: 10_000 })
    expect(await head.getAttribute('data-locked'), `${kind} is entitled`).not.toBe('true')
    await head.click()
    const shell = area === 'office' ? 'office-sidebar' : 'segment-sidebar'
    await expect(window.locator(`[data-testid="${shell}"]`)).toBeVisible({ timeout: 10_000 })
  }
  await window.waitForTimeout(400)
}

for (const theme of ['light', 'dark'] as const) {
  test(`every side-menu row wears an owner icon in all four areas (${theme})`, async () => {
    test.setTimeout(240_000)
    mkdirSync(SHOTS, { recursive: true })
    launched = await launchApp({ extraArgs: ['--force-device-scale-factor=2'] })
    const { window } = launched
    await waitForReady(window)
    // Tall enough that most of the expanded menu is on screen per shot.
    await window.setViewportSize({ width: 1440, height: 1400 })
    await window.evaluate((m) => localStorage.setItem('fb.theme.mode', m), theme)
    await suppressFeatureSpotlights(window)
    // A connected app, so that section has a tile and not only its empty state.
    await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.connectedApps.create({ title: 'Slack', url: 'https://app.slack.com' })
    })
    await window.reload()
    await waitForReady(window)
    await chooseCloudAiSource(window)
    for (const cap of ['product_office', 'product_people', 'product_brain']) await grantCapability(window, cap)
    expect(await window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark')

    const rows: AuditRow[] = []
    for (const area of ['desk', 'office', 'people', 'brain'] as const) {
      await enterArea(window, area, theme)
      await expandEverything(window)
      await shootPanel(window, `${theme}-side-menu-${area}`)
      await openWorkspaceMenu(window)
      rows.push(...(await audit(window, area)))
      expect(await brokenOwnerIcons(window), `${area}: owner icons that did not load`).toEqual([])
      await window.keyboard.press('Escape')
    }

    const count = (pred: (r: AuditRow) => boolean): number => rows.filter(pred).length
    const summary = {
      theme,
      rows: rows.length,
      owner: count((r) => r.icon === 'owner'),
      ownerGlyph: count((r) => r.icon === 'owner' && !!r.owner?.endsWith('(glyph)')),
      old: count((r) => r.icon === 'old'),
      none: count((r) => r.icon === 'none'),
      nonOwnerChrome: count((r) => r.icon !== 'owner' && isChrome(r.id)),
      nonOwnerKnown: count((r) => r.icon !== 'owner' && !isChrome(r.id) && r.id in KNOWN_NO_ICON),
      nonOwnerOther: count((r) => r.icon !== 'owner' && !isChrome(r.id) && !(r.id in KNOWN_NO_ICON))
    }
    const table = rows.map((r) => `${r.area.padEnd(7)} ${r.icon.padEnd(6)} ${r.id.padEnd(46)} ${r.owner ?? r.glyphs.join(',')}`)
    console.log(`Side-menu icon audit (${theme}): ${JSON.stringify(summary)}\n${table.join('\n')}`)
    if (AUDIT_OUT) writeFileSync(AUDIT_OUT.replace(/(\.json)?$/, `-${theme}.json`), JSON.stringify({ summary, rows }, null, 2))
    if (AUDIT_ONLY) return

    const offenders = rows
      .filter((r) => r.icon !== 'owner' && !isChrome(r.id) && !(r.id in KNOWN_NO_ICON))
      .map((r) => `${r.area}: ${r.id} (${r.icon}: ${r.glyphs.join(',') || 'no icon'})`)
    expect(offenders, 'side-menu rows without an owner icon').toEqual([])
    // The rows the 22 Oct delivery covers, by name, so a rename that drops the
    // testid cannot quietly pass the generic check above.
    const has = (id: string, icon: string): boolean => rows.some((r) => r.id === id && r.owner?.startsWith(icon))
    for (const [id, icon] of [
      ['nav-plexidesk-home', 'place:home'],
      ['nav-desk-attention', 'place:focus'],
      ['nav-desk-rooms', 'place:rooms'],
      ['nav-desk-desks', 'place:desks'],
      ['nav-desk-shared', 'tool:shared'],
      ['nav-desk-trash', 'place:trash'],
      ['sidebar-attention-open', 'place:focus-open'],
      ['sidebar-attention-due-today', 'place:focus-due-today'],
      ['sidebar-attention-overdue', 'place:focus-overdue'],
      ['sidebar-attention-in-progress', 'place:focus-in-progress'],
      ['sidebar-attention-waiting', 'place:focus-waiting'],
      ['sidebar-attention-closed-7d', 'place:focus-closed-7d'],
      ['switch-office', 'place:section-apps'],
      ['switch-widgets', 'place:section-widgets'],
      ['switch-connected-apps', 'place:section-connected-apps'],
      ['switch-plexipeople', 'place:section-people'],
      ['nav-plexipeople-home', 'place:people-home'],
      ['nav-plexipeople-directory', 'place:people-directory'],
      ['nav-plexibrain-home', 'place:brain-home'],
      ['nav-plexibrain-ask', 'place:brain-ask'],
      ['nav-plexibrain-map', 'place:brain-map'],
      ['nav-plexibrain-decisions', 'place:brain-decisions'],
      ['nav-plexibrain-assemble', 'place:brain-assemble'],
      ['nav-plexibrain-agents', 'place:brain-agents'],
      ['nav-plexibrain-ops', 'place:brain-ops'],
      ['nav-plexibrain-connect', 'place:brain-connect'],
      ['nav-plexibrain-api', 'place:brain-api'],
      ['nav-plexibrain-insights', 'place:brain-insights'],
      ['sidemenu-widgets-import-widget-file', 'place:import-widget-file'],
      ['sidemenu-widgets-import-file', 'place:import-file'],
      ['workspace-manage-org', 'place:manage-organisation']
    ] as const) {
      expect(has(id, icon), `${id} wears ${icon}`).toBe(true)
    }
    // The desk sidebar's own rows have no testid: Home, Focus, Rooms, All desks, Trash.
    for (const [label, icon] of [
      ['Home', 'place:home'],
      ['Focus', 'place:focus'],
      ['Rooms', 'place:rooms'],
      ['All desks', 'place:all-desks'],
      ['Shared', 'tool:shared'],
      ['Trash', 'place:trash']
    ] as const) {
      expect(rows.some((r) => r.area === 'desk' && r.id === label && r.owner?.startsWith(icon)), `desk sidebar ${label} wears ${icon}`).toBe(true)
    }
    // "+ New desk" in the desk sidebar header wears the owner's New desk tile (23 Oct revision).
    const newDesk = window.locator('[data-testid="desk-sidebar"] img[data-plexii-icon="place:new-desk"]')
    await window.locator('[data-testid="switch-plexidesk"]').first().click()
    await openNewDesk(window, `Icon guard ${theme} 2`)
    await expect(newDesk).toHaveCount(1)
    await expect
      .poll(() => newDesk.evaluate((el) => `${(el as HTMLImageElement).naturalWidth > 0 ? 'decoded' : 'pending'} ${Math.round(el.getBoundingClientRect().width)}px`), { timeout: 5_000 })
      .toBe('decoded 14px')
    // The 23 Oct revision made the place icons gradient TILES in rows sized for
    // glyphs. Every tile in a menu row takes the Apps section's tile size and
    // sits wholly inside its row: no clipping, nothing spilling.
    const fit = await tileFit(window, '[data-testid="desk-sidebar"], [data-testid="area-accordion"]')
    expect(fit.appTile, 'an Apps-section tile to compare with').toBeGreaterThan(0)
    expect(fit.rowTiles, 'place tiles in menu rows').toBeGreaterThan(10)
    expect(fit.offenders, `menu row tiles that do not fit (${fit.appTile}px Apps tiles)`).toEqual([])
    // Line glyphs that remain (older Tools icons, e.g. Shared) keep the per-theme violet.
    const glyph = await window.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="area-accordion"] [data-plexii-style="glyph"]')
      return el ? getComputedStyle(el).backgroundColor : null
    })
    if (glyph !== null) expect(glyph).toBe(theme === 'dark' ? 'rgb(196, 181, 253)' : 'rgb(124, 58, 237)')
  })
}

// The collapsed rail is the same menu at icon width, and it is where the owner
// looks for these places with no label to help: Office / People / PlexiiBrain,
// then Home, Focus, Rooms, Desks, Shared Desks, Trash, then the work widgets.
// The expanded-menu test above never collapses the menu, so a rail row could
// lose its owner icon (or never get one) with that test green.
const RAIL = '[data-testid="desk-sidebar-collapsed"]'
const RAIL_CHROME: RegExp[] = [
  /^Expand menu$/, // the rail's own expand control
  /^rail-other-widgets-toggle$/, // the widgets overflow toggle ("...")
  /^Add app$/ // the dashed "+" under an opened Connected Apps group
]

for (const theme of ['light', 'dark'] as const) {
  test(`every collapsed-rail row wears an owner icon (${theme})`, async () => {
    test.setTimeout(120_000)
    mkdirSync(SHOTS, { recursive: true })
    launched = await launchApp({ extraArgs: ['--force-device-scale-factor=2'] })
    const { window } = launched
    await waitForReady(window)
    await window.setViewportSize({ width: 1440, height: 1400 })
    await window.evaluate((m) => {
      localStorage.setItem('fb.theme.mode', m)
      localStorage.setItem('fb.sidebar.minimized', '1')
    }, theme)
    await suppressFeatureSpotlights(window)
    await window.reload()
    await waitForReady(window)
    await chooseCloudAiSource(window)
    for (const cap of ['product_office', 'product_people', 'product_brain']) await grantCapability(window, cap)
    await window.evaluate(() => (window as unknown as { __fbView: { getState: () => { goHome: () => void } } }).__fbView.getState().goHome())
    const rail = window.locator(RAIL)
    await expect(rail).toBeVisible({ timeout: 10_000 })
    await window.waitForTimeout(400)
    const box = await rail.boundingBox()
    if (box) await window.screenshot({ path: `${SHOTS}/${theme}-collapsed-rail.png`, clip: { x: 0, y: 0, width: box.x + box.width + 16, height: Math.min(1400, box.y + box.height + 16) } })

    const rows = await audit(window, 'desk', RAIL)
    console.log(`Collapsed-rail icon audit (${theme}):\n${rows.map((r) => `${r.icon.padEnd(6)} ${r.id.padEnd(30)} ${r.owner ?? r.glyphs.join(',')}`).join('\n')}`)
    expect(await brokenOwnerIcons(window, RAIL), 'rail: owner icons that did not load').toEqual([])
    if (AUDIT_ONLY) return

    const offenders = rows
      .filter((r) => r.icon !== 'owner' && !RAIL_CHROME.some((re) => re.test(r.id)))
      .map((r) => `${r.id} (${r.icon}: ${r.glyphs.join(',') || 'no icon'})`)
    expect(offenders, 'collapsed-rail rows without an owner icon').toEqual([])
    for (const [title, icon] of [
      ['Office', 'place:office-area'],
      ['People', 'place:people-area'],
      ['PlexiiBrain', 'app:plexibrain'],
      ['Home', 'place:home'],
      ['Focus', 'place:focus'],
      ['Rooms', 'place:rooms'],
      ['Desks', 'place:desks'],
      ['Shared Desks', 'tool:shared'],
      ['Trash', 'place:trash'],
      ['Connected Apps', 'place:section-connected-apps']
    ] as const) {
      expect(rows.some((r) => r.id === title && r.owner?.startsWith(icon)), `rail ${title} wears ${icon}`).toBe(true)
    }
    // At least the main work widgets are on the rail, each wearing its kind's tile.
    expect(rows.filter((r) => r.owner?.startsWith('widget:')).length, 'rail work widgets').toBeGreaterThan(3)
    // Rail tiles (the place tiles of the 23 Oct revision and the work widgets)
    // share one edge and sit inside their 32px buttons.
    const railFit = await window.evaluate((sel) => {
      const out: string[] = []
      const sizes = new Set<number>()
      for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(`${sel} button img[data-plexii-icon]`))) {
        const r = img.getBoundingClientRect()
        const b = img.closest('button')!.getBoundingClientRect()
        sizes.add(Math.round(r.width))
        if (Math.round(r.width) !== Math.round(r.height)) out.push(`${img.dataset.plexiiIcon}: not square`)
        if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) out.push(`${img.dataset.plexiiIcon}: spills its button`)
      }
      return { out, sizes: [...sizes] }
    }, RAIL)
    expect(railFit.out, 'rail tiles that do not fit').toEqual([])
    expect(railFit.sizes, 'one tile edge across the rail').toHaveLength(1)
  })
}
