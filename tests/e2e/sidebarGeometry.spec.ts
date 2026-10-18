import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// "Can you centre all of the menu items in their divs, so they arent askew.
// Use the same rule for all of them so they all look the same."
//
// Measured, not eyeballed. Two components render rows into ONE visual list —
// Sidebar's NavRow and AreaAccordion's Row, and NavRow's own comment says as
// much. Before the shared rule they measured 32px and 36px tall with the same
// content, because one carried fb-nav-item (and so the compact-density
// override) and the other did not. A four-pixel step halfway down a menu is
// exactly what "askew" describes.
//
// Rows and tiles are checked separately on purpose. A tile is a column — icon
// above label — so its icon SHOULD sit nearer the top, and asserting a row's
// centring rule on a tile would "fix" it into looking wrong.

let launched: LaunchedApp | null = null
test.afterEach(async () => { await launched?.app.close().catch(() => {}); launched = null })

interface Box {
  label: string
  h: number
  iconDx: number
  labelDx: number
  topGap: number
  botGap: number
  leftGap: number
  rightGap: number
}

async function measure(window: LaunchedApp['window'], selector: string): Promise<Box[]> {
  return window.evaluate((sel) => {
    const side = document.querySelector('[data-testid="desk-sidebar"]')
    if (!side) return []
    return Array.from(side.querySelectorAll(sel)).flatMap((b) => {
      const icon = b.querySelector(':scope > span')
      if (!icon) return []
      const br = b.getBoundingClientRect()
      const ir = icon.getBoundingClientRect()
      if (br.height === 0 || ir.width === 0) return []
      const lab = b.querySelectorAll(':scope > span')[1] as HTMLElement | undefined
      return [{
        label: (b.textContent || '').trim().slice(0, 20),
        h: Math.round(br.height),
        iconDx: Math.round(ir.left - br.left),
        labelDx: lab ? Math.round(lab.getBoundingClientRect().left - br.left) : -1,
        topGap: Math.round(ir.top - br.top),
        botGap: Math.round(br.bottom - ir.bottom),
        leftGap: Math.round(ir.left - br.left),
        rightGap: Math.round(br.right - ir.right)
      }]
    })
  }, selector)
}

const distinct = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b)

test('every side-menu row shares one geometry and is centred in it', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForSelector('[data-testid="desk-sidebar"]', { timeout: 15_000 })
  await window.waitForTimeout(600)

  const rows = await measure(window, '.fb-nav-row')
  for (const r of rows) {
    console.log(`  h=${String(r.h).padStart(3)} iconDx=${String(r.iconDx).padStart(3)} labelDx=${String(r.labelDx).padStart(3)} top/bot=${r.topGap}/${r.botGap}  ${r.label}`)
  }
  console.log(`  heights: ${distinct(rows.map((r) => r.h)).join(', ')}`)

  // Both renderers must be present, or this passes vacuously on one of them.
  expect(rows.length, 'no rows found').toBeGreaterThan(8)

  expect(distinct(rows.map((r) => r.h)), 'rows differ in height').toHaveLength(1)
  expect(distinct(rows.map((r) => r.iconDx)), 'icons start at different offsets').toHaveLength(1)
  expect(distinct(rows.map((r) => r.labelDx)), 'labels start at different offsets').toHaveLength(1)
  for (const r of rows) {
    expect(Math.abs(r.topGap - r.botGap), `"${r.label}" is not centred (${r.topGap} above, ${r.botGap} below)`).toBeLessThanOrEqual(1)
  }
})

test('every item box has the same right edge, chevron or not', async () => {
  // The numbers above were already green when the screenshot showed Attention
  // and Rooms stopping a third of an inch short of their neighbours: their
  // chevron sat OUTSIDE the box. Row geometry agreed; the boxes did not. This
  // measures the thing the eye was actually complaining about.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForSelector('[data-testid="desk-sidebar"]', { timeout: 15_000 })
  await window.waitForTimeout(600)

  const edges = await window.evaluate(() => {
    const side = document.querySelector('[data-testid="desk-sidebar"]')
    if (!side) return []
    // ROWS ONLY. Tiles live in a two-column grid, so they correctly have two
    // right edges — sweeping them in here made this assertion fail on a
    // layout that is right, which is the same over-broad mistake as asserting
    // a row's centring rule on a column.
    //
    // A sub-menu row is indented on purpose, so it is not expected to share
    // the LEFT edge — but it must share the right one.
    return Array.from(side.querySelectorAll('.fb-nav-row, .fb-nav-group'))
      .filter((el) => !el.closest('.fb-nav-group') || el.classList.contains('fb-nav-group'))
      .filter((el) => el.getBoundingClientRect().height > 0)
      .map((el) => ({
        label: (el.textContent || '').trim().slice(0, 18),
        right: Math.round(el.getBoundingClientRect().right)
      }))
  })
  for (const e of edges) console.log(`  right=${e.right}  ${e.label}`)
  const rights = [...new Set(edges.map((e) => e.right))].sort((a, b) => a - b)
  console.log(`  distinct right edges: ${rights.join(', ')}`)
  expect(edges.length).toBeGreaterThan(5)
  expect(rights, `items end at different x: ${rights.join(', ')}`).toHaveLength(1)
})

test('tiles share one geometry too, and a note never makes one taller', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForSelector('[data-testid="desk-sidebar"]', { timeout: 15_000 })
  await window.waitForTimeout(600)

  const tiles = await measure(window, '.fb-nav-item:not(.fb-nav-row)')
  console.log(`  ${tiles.length} tiles, heights: ${distinct(tiles.map((t) => t.h)).join(', ')}`)
  expect(tiles.length, 'no tiles found').toBeGreaterThan(3)
  // A tile carrying a second line ("which account this is") must not stand
  // taller than its neighbours — that is the grid going ragged.
  expect(distinct(tiles.map((t) => t.h)), 'tiles differ in height').toHaveLength(1)
  // CENTRED, not identically offset. Tiles are not all the same width — a
  // work-widget tile is wider than an app tile — so each one centring its own
  // icon produces a different distance from the tile's left edge. Asserting
  // one shared offset failed on seven tiles that were all correctly centred,
  // which is the same over-broad mistake as measuring a column with a row's
  // rule. What matters is that the gaps either side match.
  for (const t of tiles) {
    expect(Math.abs(t.leftGap - t.rightGap), `"${t.label}" icon is not centred (${t.leftGap} left, ${t.rightGap} right)`).toBeLessThanOrEqual(1)
  }
})

test('the treatment is one rule, applied to every item', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForSelector('[data-testid="desk-sidebar"]', { timeout: 15_000 })
  await window.waitForTimeout(400)

  const styles = await window.evaluate(() => {
    const side = document.querySelector('[data-testid="desk-sidebar"]')
    if (!side) return []
    // The item that DRAWS the treatment. A row nested in a group deliberately
    // does not — the group draws it once for both — so including those would
    // assert against the design rather than against a defect.
    return Array.from(side.querySelectorAll('.fb-nav-item'))
      .filter((el) => !(el.closest('.fb-nav-group') && !el.classList.contains('fb-nav-group')))
      .slice(0, 40)
      .map((el) => {
      const cs = getComputedStyle(el)
      return {
        border: cs.borderTopWidth + ' ' + cs.borderTopColor,
        shadow: cs.boxShadow.slice(0, 60),
        sheen: cs.backgroundImage.slice(0, 30)
      }
    })
  })
  expect(styles.length).toBeGreaterThan(8)
  // One rule means one computed treatment: every item agrees.
  expect(new Set(styles.map((s) => s.border)).size, 'items have different borders').toBe(1)
  expect(new Set(styles.map((s) => s.shadow)).size, 'items have different inner shadows').toBe(1)
  // And it is actually drawn, not an empty rule that passes by agreeing on nothing.
  // Width is asserted as "greater than zero", not "1px": on a retina display
  // Chromium reports the USED width, which snaps to one physical pixel —
  // 0.5555px at this ratio. That is the true hairline the kit asks for, and a
  // literal 1px assertion fails on the very displays it is meant to look right
  // on. (It cost a red test to learn; the note is here so it costs nobody else.)
  expect(parseFloat(styles[0].border), 'no border drawn').toBeGreaterThan(0)
  expect(styles[0].shadow, 'no inner shadow drawn').toContain('inset')
  expect(styles[0].sheen, 'no shading drawn').toContain('gradient')
})
